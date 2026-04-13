import { describe, expect, mock, test } from "bun:test"
import { restoreWorkspaceSession } from "../../../src/cli/cmd/tui/component/dialog-workspace-create"

describe("restoreWorkspaceSession", () => {
  test("refreshes workspace and session data after a successful restore", async () => {
    const sessionRestore = mock(async () => ({ data: { total: 2 } }))
    const syncWorkspace = mock(async () => {})
    const refresh = mock(async () => {})
    const clear = mock(() => {})
    const show = mock(() => {})

    await restoreWorkspaceSession({
      dialog: { clear } as any,
      sdk: {
        client: {
          experimental: {
            workspace: {
              sessionRestore,
            },
          },
        },
      } as any,
      sync: {
        session: {
          refresh,
        },
      } as any,
      project: {
        workspace: {
          sync: syncWorkspace,
        },
      } as any,
      toast: { show } as any,
      workspaceID: "wrk_1",
      sessionID: "ses_1",
    })

    expect(sessionRestore).toHaveBeenCalledWith({ id: "wrk_1", sessionID: "ses_1" })
    expect(syncWorkspace).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledWith({
      message: "Session restored into the new workspace",
      variant: "success",
    })
    expect(clear).toHaveBeenCalledTimes(1)
  })

  test("shows an error and keeps the dialog open when restore fails", async () => {
    const sessionRestore = mock(async () => undefined)
    const syncWorkspace = mock(async () => {})
    const refresh = mock(async () => {})
    const clear = mock(() => {})
    const show = mock(() => {})

    await restoreWorkspaceSession({
      dialog: { clear } as any,
      sdk: {
        client: {
          experimental: {
            workspace: {
              sessionRestore,
            },
          },
        },
      } as any,
      sync: {
        session: {
          refresh,
        },
      } as any,
      project: {
        workspace: {
          sync: syncWorkspace,
        },
      } as any,
      toast: { show } as any,
      workspaceID: "wrk_1",
      sessionID: "ses_1",
    })

    expect(syncWorkspace).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledWith({
      message: "Failed to restore session: no response",
      variant: "error",
    })
  })
})
