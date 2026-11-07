# opencode-adb-phone

[English](README.md) | **简体中文**

一个 [OpenCode](https://opencode.ai) v2 插件，让智能体通过 `adb` **看见并操控 USB 连接的 Android 手机** —— 相当于桌面端辅助功能控制器的移动版对应物。

智能体拿到的是一棵带编号的 UI 树、它真正能看的截图，以及点击、滑动、输入、启动 App、读取设备信息的工具。不需要模拟器，不需要被测 App 配合，也不需要 root。

```
phone_snapshot                 →  [7] Button "WLAN" (221,1110)-(361,1174)
phone_tap label=7              →  点击这个元素，而不是猜出来的坐标
phone_snapshot                 →  确认界面变成了什么样
```

## 为什么不直接在终端里跑 `adb`？

直接跑 `adb` 当然能用，但每一屏都要重复同样的工作：导出 29 KB 的 XML，从中扒出 `bounds`，手算中心点，转义文本，再重试一次不稳定的 dump。在一张普通界面上实测：**29,276 字节的原始 `uiautomator` XML → 约 2,000 字符的渲染快照**，而且只保留可交互节点。

| | 终端里直接跑 `adb` | 本插件 |
| --- | --- | --- |
| 读取界面 | 29 KB XML，大半是 `focusable="false"` 之类的噪声 | 约 2 KB，只有可交互节点 |
| 点击 | 从 `bounds` 算坐标，滚动后就失效 | `label=7`，按最新快照解析 |
| 界面已变 | 需要自己记得重新 dump | 45 秒缓存，任何操作后失效 |
| 二进制输出 | `exec-out` 与 `shell` 的坑 | 已处理 |
| 文本输入 | 空格要写 `%s`、引号转义、中文输入法组合态 | 已处理 |
| 权限 | 授予 `shell` 等于允许任意命令 | 只需一个 `phone` 动作 |
| 报错 | `error: device unauthorized` | 可操作的提示，并列出设备 |

`phone_shell` 仍然保留，覆盖所有类型化工具没做的事，所以本插件是终端方案的超集，而不是替代品。

## 环境要求

- Android 设备已开启 **USB 调试**，且本机已获授权。
- `adb` 可被找到 —— 插件依次查找 `ADB_PATH`、`ANDROID_HOME` / `ANDROID_SDK_ROOT` / `ANDROID_SDK`、常见 SDK 安装位置，最后是 `PATH`。
- OpenCode v2。

## 安装

**从本地目录安装** —— 放进自动发现的插件目录：

```bash
git clone https://github.com/BLxieFox/opencode-adb-phone.git \
  ~/.config/opencode/plugins/adb-phone
```

Windows 上对应路径是 `%USERPROFILE%\.config\opencode\plugins\adb-phone`。

**从 npm 安装**（发布之后）：

```bash
opencode plugin add opencode-adb-phone
```

然后确认已加载：

```bash
opencode plugin list
# ID         VERSION  SOURCE
# adb-phone  local    C:\Users\you\.config\opencode\plugins\adb-phone
```

本地目录安装**不需要**修改 `opencode.jsonc` —— `~/.config/opencode/plugins/` 下的一切都会被自动发现。插件**没有运行时依赖**，也**没有构建步骤**；`src/index.ts` 是给 OpenCode 自己的加载器用的源码。

## 工具列表

所有工具都在 `phone` 命名空间下。

| 工具 | 说明 |
| --- | --- |
| `phone_status` | 设备、型号、系统版本、ABI、分辨率/密度、电量、前台应用 |
| `phone_screenshot` | 截屏 PNG，以图片形式返回并附保存路径 |
| `phone_snapshot` | UI 层级树（带编号），可选附带截图 |
| `phone_tap` | 按 `label`、按可见 `text` 或原始 `x`/`y` 点击；`duration` 长按 |
| `phone_swipe` | 按 `direction` + `distance` 滑动，或指定坐标 |
| `phone_type` | 输入文本；ASCII 走 `input text`，非 ASCII 走剪贴板粘贴；支持 `clear`、`commit` |
| `phone_key` | 按键名（`back`、`home`、`recents`、`enter` 等）或原始 keycode |
| `phone_open` | 按包名启动 App、启动指定 Activity，或打开 URL |
| `phone_apps` | 列出已安装应用，支持过滤 |
| `phone_wait` | 轮询等待文字出现，或某包名进入前台 |
| `phone_shell` | 原始 `adb shell` 兜底通道 |
| `phone_push` / `phone_pull` | 文件传输 |
| `phone_install` | `adb install -r <apk>` |

## 用法

在会话里直接提问即可：

> “我手机现在屏幕上是什么？”

> “打开设置，把蓝牙关掉。”

> “在搜索框里输入 `wifi` 并搜索。”

> “把 D:\builds\app-release.apk 装到手机上。”

智能体应当遵循「快照优先」的流程：先读树，按 `label` 操作，再快照复核。

### 多台设备

只有一台已授权设备时会自动选中。要固定某台：

```bash
export ADB_SERIAL=4465a0ff   # Windows 上：setx ADB_SERIAL "4465a0ff"
```

或者给任意工具传 `serial` 参数。

### 每次操作前请求确认

工具使用权限动作 `phone`，默认放行。想被提前询问，在 `opencode.jsonc` 里加：

```jsonc
{
  "permissions": [{ "action": "phone", "resource": "*", "effect": "ask" }]
}
```

## 实现原理

- **快照解析。** 用 `exec-out cat` 取回 `uiautomator dump` 的结果，再由一个小型标签扫描器建成树。凡是可点击、可长按、可滚动、可勾选、可编辑，或带有 text / content-desc 的节点，都会分配一个连续的 `[label]`。
- **按编号寻址。** `phone_tap` 把 label 解析为缓存快照中对应 bounds 的中心点，因此坐标永远不会出现在智能体的计划里。
- **缓存。** 快照复用 45 秒，任何修改性操作后立即丢弃。
- **文本输入。** ASCII 走 `input text`；其余字符写入设备剪贴板后用 `KEYCODE_PASTE` 粘贴。中文输入法可能把文字留在候选栏，所以提供了 `commit`。
- **截图。** 使用 `exec-out screencap -p`（绝不用 `shell`，那会在 Windows 上破坏二进制输出），写入系统临时目录，只保留最新 20 张。

## 已知限制

- 界面处于超时或空闲状态时，`uiautomator dump` 可能失败；插件会重试一次。
- WebView 经常不暴露可用的节点文本 —— 此时退回 `phone_screenshot` 配合坐标。
- `phone_type` 依赖当前输入法；中文键盘可能需要 `commit: true`。
- 不能替代针对自有 App 的自动化测试。

## 开发

```bash
npm test   # 冒烟测试工具定义，不需要设备
```

修改插件目录下的文件会自动重新加载。

## 许可证

MIT
