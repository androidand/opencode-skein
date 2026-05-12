import { vfsPlugin } from "../plugin"
Bun.plugin(vfsPlugin)

/**
 * Starts the mock opencode server inside bun:test so coverage instrumentation works.
 *
 * Usage:
 *   bun test --coverage --coverage-reporter=lcov --timeout 0 src/provider/sdk/mock/runner/serve.test.ts
 *
 * The server runs until the process is killed (Ctrl-C).
 * Coverage data is flushed on exit.
 */

import { test } from "bun:test"
import { Log } from "../../../../util/log"
import { Server } from "../../../../server/server"
import { Global } from "../../../../global"
import { Filesystem } from "../../../../util/filesystem"
import { JsonMigration } from "../../../../storage/json-migration"
import { Database } from "../../../../storage/db"
import path from "path"

const PORT = 4096;

test("serve", async () => {
  process.env.AGENT = "1"
  process.env.OPENCODE = "1"
  process.env.OPENCODE_PID = String(process.pid)

  await Log.init({ print: false, dev: true, level: "DEBUG" })

  const marker = path.join(Global.Path.data, "opencode.db")
  if (!(await Filesystem.exists(marker))) {
    console.log("Running one-time database migration...")
    await JsonMigration.run(Database.Client().$client, {
      progress: (event) => {
        const pct = Math.floor((event.current / event.total) * 100)
        if (event.current === event.total || pct % 25 === 0) {
          console.log(`  migration: ${pct}%`)
        }
      },
    })
    console.log("Migration complete.")
  }

  const server = Server.listen({ port: PORT, hostname: "127.0.0.1" })
  console.log(`opencode server listening on http://${server.hostname}:${server.port}`)

  // keep alive until killed
  await new Promise(() => {})
  await server.stop()
})
