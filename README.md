# opencode-adb-phone

**English** | [简体中文](README.zh-CN.md)

An [OpenCode](https://opencode.ai) v2 plugin that lets the agent **see and control a USB-connected
Android phone over `adb`** — labelled UI snapshots, screenshots, tap/swipe/type, app launch and
file transfer.

The agent reads the screen as a numbered tree of interactive elements and acts on element labels
instead of guessing pixel coordinates. No emulator, no root, no test hooks in the app: if a person
can operate the screen, the agent can too.

```
phone_snapshot                 →  [7] Button "WLAN" (221,1110)-(361,1174)
phone_tap label=7              →  taps the element, not a guessed coordinate
phone_snapshot                 →  verify what changed
```

## What you can do with it

- **Hands-off device chores** — "turn off Bluetooth", "connect to the office Wi-Fi", "set a
  10-minute alarm", "put the phone on silent".
- **Inspect a phone you cannot pick up** — foreground app, battery, connectivity and current
  settings, answered straight from the session.
- **Walk through an app** — open a package, navigate by element, type into fields, read back the
  result. Handy for reproducing a bug somebody described in chat.
- **Prepare a device for someone else** — install an APK, drop a file into `Download/`, pre-set a
  few options, then hand the phone over.
- **Smoke-test your own app on real hardware** — a cheap sanity check alongside instrumentation
  tests, never a replacement for them.
- **Driven workflows** — automate a repetitive sequence of taps you would otherwise perform by hand
  while staring at the screen.

## Why not just run `adb` from the shell?

Running `adb` yourself works, but every screen costs you the same work again: dump a 29 KB XML
blob, dig out `bounds`, hand-compute a centre point, escape the text, retry the flaky dump.
Measured on one typical screen: **29,276 bytes of raw `uiautomator` XML → ~2,000 characters of
rendered snapshot**, with only the interactive nodes kept.

| | raw `adb` in a shell | this plugin |
| --- | --- | --- |
| Reading a screen | 29 KB XML, mostly `focusable="false"` noise | ~2 KB, interactive nodes only |
| Tapping | compute coordinates from `bounds`, breaks on scroll | `label=7`, resolved against the latest snapshot |
| Stale UI | you remember to re-dump | 45 s cache, invalidated by every action |
| Binary output | `exec-out` vs `shell` footguns | handled |
| Text input | `%s` spaces, quote escaping, CJK IME composition | handled |
| Permissions | one `shell` grant = any command | a single `phone` action |
| Errors | `error: device unauthorized` | actionable message listing devices |

`phone_shell` is still there for anything the typed tools do not cover, so the plugin is a superset
of the shell approach rather than a replacement.

## Requirements

- Android device with **USB debugging** enabled and the host authorised.
- `adb` reachable — the plugin looks at `ADB_PATH`, then `ANDROID_HOME` / `ANDROID_SDK_ROOT` /
  `ANDROID_SDK`, then the usual SDK locations, then `PATH`.
- OpenCode v2.

## Install

**From a local directory** — copy it into the auto-discovered plugin folder:

```bash
git clone https://github.com/BLxieFox/opencode-adb-phone.git \
  ~/.config/opencode/plugins/adb-phone
```

On Windows that is `%USERPROFILE%\.config\opencode\plugins\adb-phone`.

Then verify it loaded:

```bash
opencode plugin list
# ID         VERSION  SOURCE
# adb-phone  local    C:\Users\you\.config\opencode\plugins\adb-phone
```

No `opencode.jsonc` change is needed for the local-directory install — anything under
`~/.config/opencode/plugins/` is discovered automatically. The plugin has **no runtime
dependencies** and **no build step**; `src/index.ts` is plain input for OpenCode's own loader.

## Tools

All tools live in the `phone` namespace.

| Tool | Description |
| --- | --- |
| `phone_status` | Devices, model, Android version, ABI, screen size/density, battery, foreground app |
| `phone_screenshot` | PNG of the screen, returned as an image plus a saved path |
| `phone_snapshot` | UI hierarchy as a labelled tree, optionally with a screenshot |
| `phone_tap` | Tap by `label`, by visible `text`, or raw `x`/`y`; long press via `duration` |
| `phone_swipe` | Swipe by `direction` + `distance`, or explicit coordinates |
| `phone_type` | Type text; ASCII via `input text`, Unicode via clipboard paste; `clear`, `commit` |
| `phone_key` | Named keys (`back`, `home`, `recents`, `enter`, …) or a raw keycode |
| `phone_open` | Launch an app by package, an activity, or open a URL |
| `phone_apps` | List installed packages, with a filter |
| `phone_wait` | Poll until text appears or a package becomes foreground |
| `phone_shell` | Raw `adb shell` escape hatch |
| `phone_push` / `phone_pull` | File transfer |
| `phone_install` | `adb install -r <apk>` |

## Usage

Just ask in the session:

> "What's on my phone screen right now?"

> "Open Settings and turn off Bluetooth."

> "Type `wifi` into the search box and search."

> "Install D:\builds\app-release.apk on the phone."

The agent is expected to work snapshot-first: read the tree, act on a `label`, then snapshot again
to verify.

### Multiple devices

Exactly one authorised device is auto-selected. To pin one:

```bash
export ADB_SERIAL=4465a0ff   # setx ADB_SERIAL "4465a0ff" on Windows
```

or pass `serial` to any tool.

### Asking before every action

Tools use the permission action `phone`, allowed by default. To be prompted first, add to
`opencode.jsonc`:

```jsonc
{
  "permissions": [{ "action": "phone", "resource": "*", "effect": "ask" }]
}
```

## How it works

- **Snapshot parsing.** `uiautomator dump` is pulled with `exec-out cat`, then parsed by a small
  tag scanner into a tree. Nodes that are clickable, long-clickable, scrollable, checkable,
  editable, or carry text / content-desc get a sequential `[label]`.
- **Label addressing.** `phone_tap` resolves a label against the cached snapshot to the centre of
  its bounds, so coordinates never appear in the agent's plan.
- **Cache.** Snapshots are reused for 45 s and dropped after any mutating action.
- **Text input.** ASCII goes through `input text`; anything else is placed on the device clipboard
  and pasted with `KEYCODE_PASTE`. CJK IMEs can leave text in the composing strip, hence `commit`.
- **Screenshots.** `exec-out screencap -p` (never `shell`, which corrupts binary output on Windows),
  written to the OS temp directory, newest 20 kept.

## Limitations

- Timed-out or idle screens can make `uiautomator dump` fail; the plugin retries once.
- WebViews frequently expose no useful node text — fall back to `phone_screenshot` and coordinates.
- `phone_type` depends on the active IME; a CJK keyboard may need `commit: true`.
- Not a substitute for instrumentation tests on an app you own.

## Development

```bash
npm test   # smoke-tests the tool definitions, no device required
```

Editing files under the plugin directory reloads the plugin automatically.

## License

MIT
