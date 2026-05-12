import { Bus } from "@/bus"
import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"

export async function upgrade() {
  await AppRuntime.runPromise(
    Effect.gen(function* () {
      const cfg = yield* Config.Service
      const installation = yield* Installation.Service
      const bus = yield* Bus.Service

      const config = yield* cfg.getGlobal()
      if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
      const method = yield* installation.method()
      const latest = yield* installation.latest(method).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!latest) return

      if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
        yield* bus.publish(Installation.Event.UpdateAvailable, { version: latest })
        return
      }

      if (InstallationVersion === latest) return

      const kind = Installation.getReleaseType(InstallationVersion, latest)

      if (config.autoupdate === "notify" || kind !== "patch") {
        yield* bus.publish(Installation.Event.UpdateAvailable, { version: latest })
        return
      }

      if (method === "unknown") return
      yield* installation.upgrade(method, latest).pipe(
        Effect.flatMap(() => bus.publish(Installation.Event.Updated, { version: latest })),
        Effect.catch(() => Effect.void),
      )
    }),
  )
}
