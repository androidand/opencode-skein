import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { isShell } from "../utils"

async function setAutoAccept(page: Parameters<typeof test>[0]["page"], enabled: boolean) {
  const button = page.locator('[data-action="prompt-permissions"]').first()
  await expect(button).toBeVisible()
  const pressed = (await button.getAttribute("aria-pressed")) === "true"
  if (pressed === enabled) return
  await button.click()
  await expect(button).toHaveAttribute("aria-pressed", enabled ? "true" : "false")
}

test("shell mode runs a command in the project directory", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const cmd = process.platform === "win32" ? "dir" : "command ls"

  await withSession(project.sdk, `e2e shell ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)
    await setAutoAccept(page, true)
    await project.shell(cmd)

    await expect
      .poll(
        async () => {
          const list = await project.sdk.session
            .messages({ sessionID: session.id, limit: 50 })
            .then((x) => x.data ?? [])
          const msg = list.findLast(
            (item) => item.info.role === "assistant" && "path" in item.info && item.info.path.cwd === project.directory,
          )
          if (!msg) return

          const part = msg.parts
            .filter(isShell)
            .find((item) => item.state.input?.command === cmd && item.state.status === "completed")

          if (!part || part.state.status !== "completed") return
          const output =
            typeof part.state.metadata?.output === "string" ? part.state.metadata.output : part.state.output
          if (!output.includes("README.md")) return

          return { cwd: project.directory, output }
        },
        { timeout: 90_000 },
      )
      .toEqual(expect.objectContaining({ cwd: project.directory, output: expect.stringContaining("README.md") }))
  })
})
