// ADB phone control core — all logic lives here so it can be tested with plain node.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const MAX_OUT = 64 * 1024 * 1024
const SHOT_DIR = join(tmpdir(), "opencode-adb-phone")

let cachedAdb

function adbCandidates(exe) {
  const env = process.env
  const home = env.HOME || env.USERPROFILE || ""
  const candidates = []
  if (env.ADB_PATH) candidates.push(env.ADB_PATH)
  for (const key of ["ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK"]) {
    if (env[key]) candidates.push(join(env[key], "platform-tools", exe))
  }
  if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", exe))
  if (home) {
    candidates.push(join(home, "Android", "Sdk", "platform-tools", exe))
    candidates.push(join(home, "Library", "Android", "sdk", "platform-tools", exe))
  }
  if (process.platform !== "win32") {
    candidates.push("/usr/local/bin/adb", "/opt/homebrew/bin/adb", "/usr/bin/adb")
  }
  return candidates.filter(Boolean)
}

function resolveAdb() {
  if (cachedAdb) return cachedAdb
  const exe = process.platform === "win32" ? "adb.exe" : "adb"
  for (const candidate of adbCandidates(exe)) {
    try {
      if (existsSync(candidate)) {
        cachedAdb = candidate
        return cachedAdb
      }
    } catch {
      // Unreadable candidate, keep looking.
    }
  }
  // Fall back to whatever `adb` resolves to on PATH.
  cachedAdb = exe
  return cachedAdb
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, { windowsHide: true, signal: options.signal })
    } catch (error) {
      reject(error)
      return
    }
    const out = []
    const err = []
    let size = 0
    child.stdout.on("data", (d) => {
      size += d.length
      if (size <= MAX_OUT) out.push(d)
    })
    child.stderr.on("data", (d) => {
      if (err.length < 400) err.push(d)
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }))
  })
}

async function adbRaw(args, options = {}) {
  const serial = await resolveSerial(options.serial)
  const full = serial ? ["-s", serial, ...args] : args
  return run(resolveAdb(), full, options)
}

async function adbText(args, options = {}) {
  const res = await adbRaw(args, options)
  const text = res.stdout.toString("utf8")
  if (res.code !== 0) {
    const err = res.stderr.toString("utf8").trim()
    const detail = err || text.trim() || `exit ${res.code}`
    throw new Error(`adb ${args.join(" ")} failed: ${detail}`)
  }
  return text
}

async function listDevices() {
  const res = await run(resolveAdb(), ["devices", "-l"])
  if (res.code !== 0) throw new Error("adb not runnable: " + res.stderr.toString("utf8").trim())
  return res.stdout
    .toString("utf8")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/)
      return { serial: parts[0], state: parts[1], detail: parts.slice(2).join(" ") }
    })
}

let pinnedSerial = null
async function resolveSerial(explicit) {
  if (explicit) return explicit
  if (process.env.ADB_SERIAL) return process.env.ADB_SERIAL
  if (pinnedSerial) return pinnedSerial
  const devices = await listDevices()
  const usable = devices.filter((d) => d.state === "device")
  if (usable.length === 1) {
    pinnedSerial = usable[0].serial
    return pinnedSerial
  }
  if (usable.length === 0) {
    const unauthorized = devices.filter((d) => d.state === "unauthorized")
    if (unauthorized.length) {
      throw new Error(
        "Phone is connected but not authorized. Unlock the phone and accept the 'Allow USB debugging' prompt. Serial: " +
          unauthorized.map((d) => d.serial).join(", "),
      )
    }
    throw new Error("No Android device connected over ADB. Check the USB cable and `adb devices`.")
  }
  throw new Error(
    "Multiple devices connected; pass `serial`. Options: " + usable.map((d) => d.serial).join(", "),
  )
}

const sizeCache = new Map()
async function screenSize(serial) {
  if (sizeCache.has(serial)) return sizeCache.get(serial)
  const text = await adbText(["shell", "wm", "size"], { serial })
  const m = /(\d+)x(\d+)/.exec(text)
  const size = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1080, height: 2400 }
  sizeCache.set(serial, size)
  return size
}

function parseAttrs(source) {
  const attrs = {}
  const re = /([\w:.-]+)="([^"]*)"/g
  let m
  while ((m = re.exec(source))) attrs[m[1]] = m[2]
  return attrs
}

function parseDump(xml) {
  const root = { tag: "root", attrs: {}, children: [] }
  const stack = [root]
  const re = /<(\/?)([\w:.-]+)((?:"[^"]*"|[^>"])*?)(\/?)>/g
  let m
  while ((m = re.exec(xml))) {
    const closing = m[1] === "/"
    const tag = m[2]
    const attrSource = m[3] || ""
    const selfClosing = m[4] === "/"
    if (closing) {
      if (stack.length > 1) stack.pop()
      continue
    }
    const node = { tag, attrs: parseAttrs(attrSource), children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }
  return root
}

function parseBounds(value) {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value || "")
  if (!m) return null
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] }
}

function isInteresting(node) {
  const a = node.attrs
  const cls = a.class || ""
  if (a.clickable === "true" || a["long-clickable"] === "true") return true
  if (a.scrollable === "true" || a.checkable === "true") return true
  if (a.text && a.text.trim()) return true
  if (a["content-desc"] && a["content-desc"].trim()) return true
  if (/EditText|Button|ImageButton|CheckBox|Switch|RadioButton|Tab/.test(cls)) return true
  return false
}

function shortClass(cls) {
  if (!cls) return "-"
  const parts = cls.split(".")
  return parts[parts.length - 1]
}

const snapshots = new Map()

async function dumpUi(serial) {
  try {
    await adbText(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], { serial })
  } catch (error) {
    // A second attempt fixes the common "could not get idle state" flake.
    await new Promise((r) => setTimeout(r, 400))
    await adbText(["shell", "uiautomator", "dump", "/sdcard/window_dump.xml"], { serial })
  }
  return adbText(["exec-out", "cat", "/sdcard/window_dump.xml"], { serial })
}

function buildSnapshot(xml) {
  const tree = parseDump(xml)
  const hierarchy = tree.children.find((c) => c.tag === "hierarchy") || tree.children[0]
  const rotation = hierarchy && hierarchy.attrs ? hierarchy.attrs.rotation : undefined

  const byLabel = new Map()
  const entries = []
  let counter = 0

  const walk = (node, depth) => {
    if (node.tag === "node") {
      const a = node.attrs
      const bounds = parseBounds(a.bounds)
      if (bounds && isInteresting(node)) {
        counter += 1
        const label = counter
        const entry = {
          label,
          depth,
          bounds,
          text: a.text || "",
          desc: a["content-desc"] || "",
          cls: a.class || "",
          resourceId: a["resource-id"] || "",
          clickable: a.clickable === "true",
          longClickable: a["long-clickable"] === "true",
          scrollable: a.scrollable === "true",
          editable: /EditText/.test(a.class || "") || a["class"] === "android.widget.EditText",
          enabled: a.enabled !== "false",
          checked: a.checked === "true",
          selected: a.selected === "true",
        }
        byLabel.set(label, entry)
        entries.push(entry)
      }
      for (const child of node.children) walk(child, depth + 1)
    } else {
      for (const child of node.children) walk(child, depth)
    }
  }

  if (hierarchy) for (const child of hierarchy.children) walk(child, 0)
  return { rotation, entries, byLabel }
}

function renderSnapshot(snapshot, limit) {
  const lines = []
  for (const e of snapshot.entries.slice(0, limit)) {
    const pad = "  ".repeat(Math.min(e.depth, 8))
    const flags = []
    if (e.editable) flags.push("editable")
    if (e.scrollable) flags.push("scrollable")
    if (e.longClickable) flags.push("long")
    if (e.checked) flags.push("checked")
    if (e.selected) flags.push("selected")
    if (!e.enabled) flags.push("disabled")
    const text = e.text ? JSON.stringify(e.text) : '""'
    const desc = e.desc ? ` desc=${JSON.stringify(e.desc)}` : ""
    const id = e.resourceId ? ` id=${e.resourceId.split("/").pop()}` : ""
    const b = e.bounds
    lines.push(
      `${pad}[${e.label}] ${shortClass(e.cls)} ${text}${desc}${id} (${b.x1},${b.y1})-(${b.x2},${b.y2})${flags.length ? " <" + flags.join(",") + ">" : ""}`,
    )
  }
  return lines.join("\n")
}

async function snapshotFor(serial, force) {
  const cached = snapshots.get(serial)
  if (!force && cached && Date.now() - cached.at < 45_000) return cached
  const xml = await dumpUi(serial)
  const built = buildSnapshot(xml)
  const record = { at: Date.now(), ...built }
  snapshots.set(serial, record)
  return record
}

function center(bounds) {
  return { x: Math.round((bounds.x1 + bounds.x2) / 2), y: Math.round((bounds.y1 + bounds.y2) / 2) }
}

function findByText(snapshot, needle) {
  const target = needle.toLowerCase()
  const hits = snapshot.entries.filter(
    (e) => e.text.toLowerCase().includes(target) || e.desc.toLowerCase().includes(target),
  )
  if (!hits.length) return null
  hits.sort((a, b) => area(a.bounds) - area(b.bounds))
  return hits[0]
}

function area(b) {
  return Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
}

function shellQuote(text) {
  return "'" + String(text).replace(/'/g, "'\\''") + "'"
}

function toFileUrl(path) {
  let p = path.replace(/\\/g, "/")
  if (!p.startsWith("/")) p = "/" + p
  return "file://" + p
}

function pruneShots(keep = 20) {
  try {
    const files = readdirSync(SHOT_DIR)
      .filter((f) => f.endsWith(".png"))
      .map((f) => ({ f, t: statSync(join(SHOT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const old of files.slice(keep)) {
      try {
        unlinkSync(join(SHOT_DIR, old.f))
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

async function capture(serial, name, signal) {
  mkdirSync(SHOT_DIR, { recursive: true })
  const res = await adbRaw(["exec-out", "screencap", "-p"], { serial, signal })
  if (res.code !== 0) throw new Error("screencap failed: " + res.stderr.toString("utf8").trim())
  const buffer = res.stdout
  if (buffer.length < 1000) throw new Error("screencap returned no image data")
  const file = join(SHOT_DIR, `${name}-${Date.now()}.png`)
  await writeFile(file, buffer)
  pruneShots()
  return { file, bytes: buffer.length }
}

const KEYCODES = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  clear: 28,
  tab: 61,
  space: 62,
  enter: 66,
  delete: 67,
  backspace: 67,
  menu: 82,
  notification: 83,
  search: 84,
  play_pause: 85,
  mute: 91,
  page_up: 92,
  page_down: 93,
  move_home: 122,
  move_end: 123,
  recents: 187,
  app_switch: 187,
  sleep: 223,
  wakeup: 224,
  paste: 279,
}

function keycodeFor(value) {
  const raw = String(value).trim().toLowerCase()
  if (/^\d+$/.test(raw)) return Number(raw)
  return KEYCODES[raw] ?? null
}

const serialParam = {
  type: "string",
  description: "Target device serial. Omit when exactly one phone is connected.",
}

export const tools = [
  {
    name: "status",
    description:
      "Show the connected Android device(s): model, Android version, SDK, ABI, screen size/density, screen on/off, foreground app and battery. Start here to confirm the phone is reachable.",
    input: {
      type: "object",
      properties: { serial: serialParam },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const devices = await listDevices()
      if (!devices.length) {
        return { content: "No Android device detected. Connect the phone over USB and enable USB debugging." }
      }
      const lines = ["Detected devices:"]
      for (const d of devices) lines.push(`  ${d.serial}  ${d.state}  ${d.detail}`.trim())

      let serial
      try {
        serial = await resolveSerial(input.serial)
      } catch (error) {
        return { content: lines.join("\n") + "\n\n" + error.message }
      }

      const getprop = async (name) => (await adbText(["shell", "getprop", name], { serial })).trim()
      const [model, brand, release, sdk, abi] = await Promise.all([
        getprop("ro.product.model"),
        getprop("ro.product.manufacturer"),
        getprop("ro.build.version.release"),
        getprop("ro.build.version.sdk"),
        getprop("ro.product.cpu.abi"),
      ])
      const size = await screenSize(serial)
      const density = (await adbText(["shell", "wm", "density"], { serial })).trim()
      const focus = (await adbText(["shell", "dumpsys", "window"], { serial }))
        .split(/\r?\n/)
        .filter((l) => /mCurrentFocus|mFocusedApp/.test(l))
        .map((l) => l.trim())
        .join("\n")
      const power = (await adbText(["shell", "dumpsys", "power"], { serial }))
        .split(/\r?\n/)
        .filter((l) => /mWakefulness=|mScreenOn|Display Power/.test(l))
        .map((l) => l.trim())
        .slice(0, 3)
        .join("\n")
      const battery = (await adbText(["shell", "dumpsys", "battery"], { serial }))
        .split(/\r?\n/)
        .filter((l) => /level:|status:|temperature:/.test(l))
        .map((l) => l.trim())
        .join("  ")

      lines.push("", `Active device: ${serial}`, `${brand} ${model} — Android ${release} (API ${sdk}) ${abi}`)
      lines.push(`Screen: ${size.width}x${size.height}  ${density}`)
      if (focus) lines.push(`Focus:\n${focus}`)
      if (power) lines.push(`Power:\n${power}`)
      if (battery) lines.push(`Battery: ${battery}`)
      return { content: lines.join("\n") }
    },
  },
  {
    name: "screenshot",
    description:
      "Capture the phone screen as a PNG image and return it. Use this to see what is on screen. Prefer `snapshot` when you need tappable elements with labels.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        label: { type: "string", description: "Optional filename hint, e.g. 'settings'." },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input, context) => {
      const serial = await resolveSerial(input.serial)
      const shot = await capture(serial, (input.label || "screen").replace(/[^\w.-]+/g, "_"), context.signal)
      return {
        content: [
          { type: "file", uri: toFileUrl(shot.file), mime: "image/png", name: "phone-screen.png" },
          {
            type: "text",
            text: `Screenshot captured from ${serial} (${Math.round(shot.bytes / 1024)} KB). Saved: ${shot.file}`,
          },
        ],
        metadata: { serial, file: shot.file },
      }
    },
  },
  {
    name: "snapshot",
    description:
      "Dump the phone UI hierarchy as a labelled tree, like a desktop accessibility snapshot. Each interactive row is prefixed with [label] that you pass to `tap`. Optionally returns a screenshot too. Refresh it after every action that changes the screen.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        screenshot: { type: "boolean", description: "Also return the screen image (default true)." },
        limit: { type: "integer", description: "Max nodes to list (default 120)." },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input, context) => {
      const serial = await resolveSerial(input.serial)
      const snapshot = await snapshotFor(serial, true)
      const limit = input.limit ?? 120
      const header = `Device ${serial} — ${snapshot.entries.length} interactive nodes, rotation ${snapshot.rotation ?? "?"}`
      const body = renderSnapshot(snapshot, limit)
      const truncated = snapshot.entries.length > limit ? `\n… ${snapshot.entries.length - limit} more nodes omitted` : ""
      const text = `${header}\n${body}${truncated}\n\nTap with: phone_tap label=<n>`
      if (input.screenshot === false) return { content: text }
      const shot = await capture(serial, "snapshot", context.signal)
      return {
        content: [
          { type: "file", uri: toFileUrl(shot.file), mime: "image/png", name: "phone-screen.png" },
          { type: "text", text: `${text}\n\nImage: ${shot.file}` },
        ],
        metadata: { serial, nodes: snapshot.entries.length },
      }
    },
  },
  {
    name: "tap",
    description:
      "Tap an element on the phone. Target it with `label` (from the latest snapshot), `text` (matches visible text or content description), or raw `x`/`y`. Long-press with duration >= 500 ms.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        label: { type: "integer", description: "Label number from the latest phone_snapshot." },
        text: { type: "string", description: "Visible text or content-desc to match (case-insensitive, smallest match wins)." },
        x: { type: "integer" },
        y: { type: "integer" },
        duration: { type: "integer", description: "Press duration in ms. Default 80, use >=500 for long press." },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      let point = null
      if (typeof input.x === "number" && typeof input.y === "number") {
        point = { x: input.x, y: input.y }
      } else {
        const snapshot = await snapshotFor(serial, false)
        if (typeof input.label === "number") {
          const entry = snapshot.byLabel.get(input.label)
          if (!entry) throw new Error(`Label ${input.label} is not in the current snapshot. Run phone_snapshot again.`)
          point = center(entry.bounds)
        } else if (input.text) {
          const entry = findByText(snapshot, input.text)
          if (!entry) throw new Error(`No node matching "${input.text}". Run phone_snapshot to see the current UI.`)
          point = center(entry.bounds)
        }
      }
      if (!point) throw new Error("Provide label, text, or x+y.")
      const duration = input.duration ?? 80
      const command =
        duration >= 400
          ? ["shell", "input", "swipe", String(point.x), String(point.y), String(point.x), String(point.y), String(duration)]
          : ["shell", "input", "tap", String(point.x), String(point.y)]
      await adbText(command, { serial })
      snapshots.delete(serial)
      return { content: `Tapped ${point.x},${point.y}${duration >= 400 ? ` (long press ${duration} ms)` : ""} on ${serial}.` }
    },
  },
  {
    name: "swipe",
    description:
      "Swipe/scroll on the phone. Either give explicit x1,y1 -> x2,y2, or a direction (up/down/left/right) with optional distance fraction (0-1, default 0.6) and duration.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        distance: { type: "number", description: "Fraction of screen to travel, default 0.6." },
        duration: { type: "integer", description: "Swipe duration in ms, default 300." },
        x1: { type: "integer" },
        y1: { type: "integer" },
        x2: { type: "integer" },
        y2: { type: "integer" },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const duration = input.duration ?? 300
      let from
      let to
      if ([input.x1, input.y1, input.x2, input.y2].every((v) => typeof v === "number")) {
        from = { x: input.x1, y: input.y1 }
        to = { x: input.x2, y: input.y2 }
      } else if (input.direction) {
        const { width, height } = await screenSize(serial)
        const f = Math.min(Math.max(input.distance ?? 0.6, 0.1), 0.95)
        const cx = Math.round(width / 2)
        const cy = Math.round(height / 2)
        const dx = Math.round((width * f) / 2)
        const dy = Math.round((height * f) / 2)
        if (input.direction === "up") {
          from = { x: cx, y: cy + dy }
          to = { x: cx, y: cy - dy }
        } else if (input.direction === "down") {
          from = { x: cx, y: cy - dy }
          to = { x: cx, y: cy + dy }
        } else if (input.direction === "left") {
          from = { x: cx + dx, y: cy }
          to = { x: cx - dx, y: cy }
        } else {
          from = { x: cx - dx, y: cy }
          to = { x: cx + dx, y: cy }
        }
      } else {
        throw new Error("Provide direction, or all of x1,y1,x2,y2.")
      }
      await adbText(
        ["shell", "input", "swipe", String(from.x), String(from.y), String(to.x), String(to.y), String(duration)],
        { serial },
      )
      snapshots.delete(serial)
      return { content: `Swiped ${from.x},${from.y} -> ${to.x},${to.y} (${duration} ms) on ${serial}.` }
    },
  },
  {
    name: "type",
    description:
      "Type text into the focused input field. ASCII is sent with `input text`; non-ASCII (e.g. Chinese) is put on the device clipboard and pasted. Set clear=true to select-all and delete first. Set commit=true to press Enter afterwards — needed when a CJK IME keeps the text in its composing strip instead of the field.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        text: { type: "string" },
        clear: { type: "boolean", description: "Clear the field before typing." },
        commit: { type: "boolean", description: "Press Enter after typing to commit IME composition / submit." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      if (input.clear) {
        await adbText(["shell", "input", "keycombination", "113", "29"], { serial }).catch(() => {})
        await adbText(["shell", "input", "keyevent", "67"], { serial })
      }
      const ascii = /^[\x20-\x7E\n\t]*$/.test(input.text)
      if (ascii) {
        const escaped = input.text.replace(/ /g, "%s")
        await adbText(["shell", "input", "text", shellQuote(escaped)], { serial })
      } else {
        // Non-ASCII: put the text on the device clipboard and paste it.
        await adbText(["shell", "cmd", "clipboard", "set-text", shellQuote(input.text)], { serial })
        await adbText(["shell", "input", "keyevent", "279"], { serial })
      }
      if (input.commit) await adbText(["shell", "input", "keyevent", "66"], { serial })
      snapshots.delete(serial)
      return {
        content: `Typed ${input.text.length} characters via ${ascii ? "input text" : "clipboard paste"}${input.commit ? " + Enter" : ""}.`,
      }
    },
  },
  {
    name: "key",
    description:
      "Send a hardware key event. Named keys: back, home, recents, enter, delete, tab, space, search, menu, notification, power, wakeup, sleep, volume_up, volume_down, mute, play_pause, page_up, page_down, move_home, move_end, camera, call, endcall, clear, paste. A number is used as a raw Android keycode.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        key: { type: ["string", "integer"], description: "Key name or raw keycode." },
        repeat: { type: "integer", description: "How many times to send it, default 1." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const code = keycodeFor(input.key)
      if (code === null) throw new Error(`Unknown key "${input.key}".`)
      const repeat = Math.min(Math.max(input.repeat ?? 1, 1), 50)
      for (let i = 0; i < repeat; i += 1) {
        await adbText(["shell", "input", "keyevent", String(code)], { serial })
      }
      snapshots.delete(serial)
      return { content: `Sent key ${input.key} (${code})${repeat > 1 ? ` x${repeat}` : ""} to ${serial}.` }
    },
  },
  {
    name: "open",
    description:
      "Open an app or URL on the phone. Give `package` (launch its launcher activity), or `url` (open with the default browser/app), or both `package` and `activity`.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        package: { type: "string", description: "Android package name, e.g. com.android.settings." },
        activity: { type: "string", description: "Optional activity, e.g. .Settings" },
        url: { type: "string" },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      if (input.url) {
        await adbText(
          ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", shellQuote(input.url)],
          { serial },
        )
        snapshots.delete(serial)
        return { content: `Opened URL ${input.url} on ${serial}.` }
      }
      if (!input.package) throw new Error("Provide package or url.")
      if (input.activity) {
        const component = input.activity.startsWith(".") ? input.package + input.activity : input.activity
        await adbText(["shell", "am", "start", "-n", shellQuote(component)], { serial })
        snapshots.delete(serial)
        return { content: `Started ${component} on ${serial}.` }
      }
      await adbText(
        ["shell", "monkey", "-p", input.package, "-c", "android.intent.category.LAUNCHER", "1"],
        { serial },
      )
      snapshots.delete(serial)
      return { content: `Launched ${input.package} on ${serial}.` }
    },
  },
  {
    name: "apps",
    description:
      "List installed Android packages, optionally filtered. Use all=true to include system apps (default lists user-installed apps only).",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        filter: { type: "string", description: "Case-insensitive substring of the package name." },
        all: { type: "boolean", description: "Include system packages." },
        limit: { type: "integer", description: "Default 80." },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const args = ["shell", "pm", "list", "packages"]
      if (!input.all) args.push("-3")
      const text = await adbText(args, { serial })
      let names = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("package:"))
        .map((l) => l.slice("package:".length))
      if (input.filter) names = names.filter((n) => n.toLowerCase().includes(input.filter.toLowerCase()))
      const limit = input.limit ?? 80
      const shown = names.slice(0, limit)
      const suffix = names.length > limit ? `\n… ${names.length - limit} more` : ""
      return {
        content: `${names.length} package(s)${input.all ? " (including system)" : " (user-installed)"}:\n${shown.join("\n")}${suffix}`,
      }
    },
  },
  {
    name: "wait",
    description:
      "Wait until the phone screen shows something. Polls the UI until `text` appears, or `package` becomes the foreground app. Useful after taps and app launches.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        text: { type: "string", description: "Visible text or content-desc to wait for." },
        package: { type: "string", description: "Package that must be in the foreground." },
        timeout: { type: "integer", description: "Timeout in ms, default 15000." },
      },
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input, context) => {
      const serial = await resolveSerial(input.serial)
      if (!input.text && !input.package) throw new Error("Provide text or package.")
      const deadline = Date.now() + (input.timeout ?? 15_000)
      let last = ""
      while (Date.now() < deadline) {
        if (context.signal?.aborted) throw new Error("cancelled")
        try {
          if (input.package) {
            const focus = await adbText(["shell", "dumpsys", "window"], { serial })
            const line = focus.split(/\r?\n/).find((l) => /mCurrentFocus/.test(l)) || ""
            last = line.trim()
            if (line.includes(input.package)) return { content: `Foreground is now ${input.package}.` }
          } else {
            const snapshot = await snapshotFor(serial, true)
            const hit = findByText(snapshot, input.text)
            if (hit) {
              return {
                content: `Found "${input.text}" as label [${hit.label}] at (${center(hit.bounds).x},${center(hit.bounds).y}).`,
              }
            }
            last = `${snapshot.entries.length} nodes, no match`
          }
        } catch (error) {
          last = String(error.message || error)
        }
        await new Promise((r) => setTimeout(r, 700))
      }
      throw new Error(`Timed out after ${input.timeout ?? 15_000} ms waiting for ${input.text || input.package}. Last: ${last}`)
    },
  },
  {
    name: "shell",
    description:
      "Run a raw `adb shell` command on the phone and return its output. Escape hatch for anything the other tools do not cover (dumpsys, settings, getprop, pm, am, cmd).",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        command: { type: "string", description: "Shell command, e.g. 'dumpsys battery' or 'settings get system screen_brightness'." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const text = await adbText(["shell", input.command], { serial })
      const trimmed = text.trim()
      const capped = trimmed.length > 20_000 ? trimmed.slice(0, 20_000) + "\n… truncated" : trimmed
      return { content: capped || "(no output)" }
    },
  },
  {
    name: "push",
    description: "Copy a local file to the phone.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        local: { type: "string", description: "Absolute local path." },
        remote: { type: "string", description: "Destination path on the phone, e.g. /sdcard/Download/a.png" },
      },
      required: ["local", "remote"],
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const text = await adbText(["push", input.local, input.remote], { serial })
      return { content: text.trim() }
    },
  },
  {
    name: "pull",
    description: "Copy a file from the phone to this computer.",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        remote: { type: "string", description: "Path on the phone, e.g. /sdcard/DCIM/Camera/x.jpg" },
        local: { type: "string", description: "Absolute destination path on this computer." },
      },
      required: ["remote", "local"],
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const text = await adbText(["pull", input.remote, input.local], { serial })
      return { content: text.trim() }
    },
  },
  {
    name: "install",
    description: "Install an APK on the phone (uses `adb install -r`).",
    input: {
      type: "object",
      properties: {
        serial: serialParam,
        apk: { type: "string", description: "Absolute local path to the .apk file." },
      },
      required: ["apk"],
      additionalProperties: false,
    },
    options: { namespace: "phone", codemode: true, permission: "phone" },
    execute: async (input) => {
      const serial = await resolveSerial(input.serial)
      const text = await adbText(["install", "-r", input.apk], { serial })
      return { content: text.trim() }
    },
  },
]

export default { tools }
