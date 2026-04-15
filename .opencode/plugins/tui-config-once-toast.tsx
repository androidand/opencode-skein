import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

let seen = false

const plugin: TuiPluginModule & { id: string } = {
  id: "local.config-once-toast",
  async tui(api) {
    if (seen) return

    const cfg = api.state.config
    if (cfg.plugin !== undefined && !Array.isArray(cfg.plugin)) {
      throw new Error("Invalid config: plugin must be an array")
    }

    const mdl = typeof cfg.model === "string" && cfg.model.trim() ? cfg.model : "default"
    seen = true
    api.ui.toast({
      title: "Config check",
      message: `This is a 1 time toast, validating ur config (model: ${mdl})`,
      variant: "info",
    })
  },
}

export default plugin
