import { tools } from "../src/core.mjs"
import assert from "node:assert"

const expected = [
  "status",
  "screenshot",
  "snapshot",
  "tap",
  "swipe",
  "type",
  "key",
  "open",
  "apps",
  "wait",
  "shell",
  "push",
  "pull",
  "install",
]

assert.ok(Array.isArray(tools), "tools must be an array")

const names = tools.map((tool) => tool.name)
for (const name of expected) {
  assert.ok(names.includes(name), `missing tool: ${name}`)
}

for (const tool of tools) {
  assert.equal(typeof tool.name, "string", "tool.name must be a string")
  assert.equal(typeof tool.description, "string", "tool.description must be a string")
  assert.equal(typeof tool.execute, "function", `${tool.name}.execute must be a function`)
  assert.equal(tool.input.type, "object", `${tool.name}.input must be a JSON Schema object`)
  assert.equal(tool.options.namespace, "phone", `${tool.name} must live in the phone namespace`)
}

console.log(`ok — ${tools.length} tools: ${names.join(", ")}`)
