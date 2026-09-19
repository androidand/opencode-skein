import { Config } from "@/config/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "@/installation"
import { InstallationIsRelease, InstallationVersion } from "@opencode-ai/core/installation/version"
import { GlobalBus } from "@/bus/global"

export async function upgrade() {
  // Only a real published release (channel latest/beta/prod) has a
  // meaningful version to compare against "the latest release" in the first
  // place. A local or dev build — including a local build on the stable
  // "dev" channel (see build-local.ts) — was never published, so the
  // comparison is meaningless at best and actively harmful at worst: it can
  // read as needing "a patch" and silently curl-install a real release over
  // a binary someone is deliberately running for its own changes, mid-session
  // (confirmed live 2026-09-19 — replaced a running dev build and corrupted
  // the TUI's rendered screen with the installer's raw progress output).
  // OPENCODE_ALWAYS_NOTIFY_UPDATE is the explicit test hook and overrides
  // this: it forces the toast even on a non-release build, for verifying the
  // notification path without installing anything.
  if (!InstallationIsRelease && !Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) return
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.OPENCODE_DISABLE_AUTOUPDATE) return
  const method = await Installation.method()
  const latest = await Installation.latest(method).catch(() => {})
  if (!latest) return

  if (Flag.OPENCODE_ALWAYS_NOTIFY_UPDATE) {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    GlobalBus.emit("event", {
      directory: "global",
      payload: {
        type: Installation.Event.UpdateAvailable.type,
        properties: { version: latest },
      },
    })
    return
  }

  if (method === "unknown") return
  await Installation.upgrade(method, latest)
    .then(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: latest },
        },
      }),
    )
    .catch(() => {})
}
