import { AppRuntime } from "@/effect/app-runtime"
import { ServiceManager } from "@/service"
import { UI } from "../ui"
import type { Argv } from "yargs"
import { cmd } from "./cmd"

function exitWithError(error: unknown): never {
  UI.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

const InstallCommand = cmd({
  command: "install",
  describe: "install opencode as a background service",
  builder: (yargs: Argv) =>
    yargs
      .option("password", {
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_PASSWORD, then OPENCODE_SERVER_PASSWORD, else random)",
      })
      .option("hostname", {
        type: "string",
        describe: "hostname to listen on",
      }),
  handler: async (args: { password?: string; hostname?: string }) => {
    const result = await AppRuntime.runPromise(ServiceManager.Service.use((svc) => svc.install(args))).catch(exitWithError)

    console.log(`Installed OpenCode service on ${result.platform}`)
    console.log(`Target: ${result.target}`)
    console.log(`Hostname: ${result.hostname}`)
    console.log(`Password: ${result.password}`)
  },
})

const PasswordCommand = cmd({
  command: "password",
  describe: "print the installed service password",
  handler: async () => {
    const password = await AppRuntime.runPromise(ServiceManager.Service.use((svc) => svc.password())).catch(exitWithError)

    console.log(password)
  },
})

export const ServiceCommand = cmd({
  command: "service",
  describe: "manage the background opencode service",
  builder: (yargs: Argv) => yargs.command(InstallCommand).command(PasswordCommand).demandCommand(),
  handler: () => {},
})
