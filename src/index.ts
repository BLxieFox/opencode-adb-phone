import { tools } from "./core.mjs"

export default {
  id: "adb-phone",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.namespace({
        name: "phone",
        description: "Control a USB-connected Android phone through adb: screenshot, UI snapshot, tap, swipe, type, keys, apps.",
      })
      for (const tool of tools) editor.add(tool)
    })
  },
}
