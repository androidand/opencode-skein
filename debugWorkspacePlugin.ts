import type { Plugin } from "@opencode-ai/plugin"

export const DebugWorkspacePlugin: Plugin = async ({ experimental_workspace }) => {
  experimental_workspace.register("debug", {
    name: "Debug",
    description: "Create a debugging server",
    configure(config) {
      return config
    },
    async create(_config) {},
    async remove(_config) {},
    target(_config) {
      return {
        type: "remote",
        url: "http://localhost:5096/",
      }
    },
  })

  return {}
}

export default DebugWorkspacePlugin
