import type { Workspace } from "@opencode-ai/sdk/v2"
import { useDialog } from "@tui/ui/dialog"
import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { useSync } from "@tui/context/sync"
import { useProject } from "@tui/context/project"
import { createMemo, createSignal, onMount } from "solid-js"
import { errorMessage } from "@/util/error"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { WorkspaceLabel } from "./workspace-label"

type Adaptor = {
  type: string
  name: string
  description: string
}

export type WorkspaceSelection =
  | {
      type: "none"
    }
  | {
      type: "new"
      workspaceType: string
      workspaceName: string
    }
  | {
      type: "existing"
      workspaceID: string
      workspaceType: string
      workspaceName: string
    }

type WorkspaceSelectValue = WorkspaceSelection | { type: "existing-list" } | { type: "loading" }
type ExistingWorkspaceSelectValue = { workspace: Workspace }

export async function restoreWorkspaceSession(input: {
  dialog: ReturnType<typeof useDialog>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  project: ReturnType<typeof useProject>
  toast: ReturnType<typeof useToast>
  workspaceID: string
  sessionID: string
  done?: () => void
}) {
  const result = await input.sdk.client.experimental.workspace
    .sessionRestore({ id: input.workspaceID, sessionID: input.sessionID })
    .catch(() => undefined)
  if (!result?.data) {
    input.toast.show({
      message: `Failed to restore session: ${errorMessage(result?.error ?? "no response")}`,
      variant: "error",
    })
    return
  }

  input.project.workspace.set(input.workspaceID)

  await input.sync.bootstrap({ fatal: false }).catch(() => undefined)

  await Promise.all([input.project.workspace.sync(), input.sync.session.sync(input.sessionID)])

  input.toast.show({
    message: "Session restored into the new workspace",
    variant: "success",
  })
  input.done?.()
  if (input.done) return
  input.dialog.clear()
}

function DialogWorkspaceTypeSelect(props: { onSelect: (adaptor: Adaptor) => Promise<void> | void }) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [adaptors, setAdaptors] = createSignal<Adaptor[]>()

  onMount(() => {
    dialog.setSize("medium")
    void (async () => {
      const dir = sync.path.directory || sdk.directory
      const url = new URL("/experimental/workspace/adaptor", sdk.url)
      if (dir) url.searchParams.set("directory", dir)
      const res = await sdk
        .fetch(url)
        .then((x) => x.json() as Promise<Adaptor[]>)
        .catch(() => undefined)
      if (!res) {
        toast.show({
          message: "Failed to load workspace adaptors",
          variant: "error",
        })
        return
      }
      setAdaptors(res)
    })()
  })

  const options = createMemo(() => {
    const list = adaptors()
    if (!list) {
      return [
        {
          title: "Loading workspaces...",
          value: undefined,
          description: "Fetching available workspace adaptors",
        },
      ]
    }
    return list.map((item) => ({
      title: item.name,
      value: item,
      description: item.description,
    }))
  })

  return (
    <DialogSelect
      title="New Workspace"
      skipFilter={true}
      renderFilter={false}
      options={options()}
      onSelect={async (option) => {
        if (!option.value) return
        void props.onSelect(option.value)
      }}
    />
  )
}

export function DialogWorkspaceSelect(props: {
  current?: WorkspaceSelection
  onSelect: (selection: WorkspaceSelection) => Promise<void> | void
}) {
  const dialog = useDialog()
  const project = useProject()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [adaptors, setAdaptors] = createSignal<Adaptor[]>()

  onMount(() => {
    dialog.setSize("medium")
    void (async () => {
      const dir = sync.path.directory || sdk.directory
      const url = new URL("/experimental/workspace/adaptor", sdk.url)
      if (dir) url.searchParams.set("directory", dir)
      const res = await sdk
        .fetch(url)
        .then((x) => x.json() as Promise<Adaptor[]>)
        .catch(() => undefined)
      if (!res) {
        toast.show({
          message: "Failed to load workspace adaptors",
          variant: "error",
        })
        return
      }
      setAdaptors(res)
    })()
  })

  const options = createMemo<DialogSelectOption<WorkspaceSelectValue>[]>(() => {
    const list = adaptors()
    if (!list) {
      return [
        {
          title: "Loading workspaces...",
          value: { type: "loading" as const },
          description: "Fetching available workspace adaptors",
          category: "New workspace",
        },
      ]
    }
    const workspaces = project.workspace.list()
    return [
      ...list.map((adaptor) => ({
        title: adaptor.name,
        value: { type: "new" as const, workspaceType: adaptor.type, workspaceName: adaptor.name },
        description: adaptor.description,
        category: "New workspace",
      })),
      {
        title: "None",
        value: { type: "none" as const },
        description: "Use the local project",
        category: "Choose workspace",
      },
      ...workspaces.slice(0, 3).map((workspace: Workspace) => ({
        title: workspace.name,
        description: `(${workspace.type})`,
        value: {
          type: "existing" as const,
          workspaceID: workspace.id,
          workspaceType: workspace.type,
          workspaceName: workspace.name,
        },
        category: "Choose workspace",
      })),
      {
        title: "View all workspaces",
        value: { type: "existing-list" as const },
        description: "Choose from all workspaces",
        category: "Choose workspace",
      },
    ]
  })

  return (
    <DialogSelect<WorkspaceSelectValue>
      title="Warp"
      skipFilter={true}
      renderFilter={false}
      options={options()}
      current={props.current}
      onSelect={(option) => {
        if (!option.value) return
        if (option.value.type === "none") {
          void props.onSelect(option.value)
          return
        }
        if (option.value.type === "new") {
          void props.onSelect(option.value)
          return
        }
        if (option.value.type === "existing") {
          void props.onSelect(option.value)
          return
        }

        dialog.replace(() => <DialogExistingWorkspaceSelect onSelect={props.onSelect} />)
      }}
    />
  )
}

function DialogExistingWorkspaceSelect(props: { onSelect: (selection: WorkspaceSelection) => Promise<void> | void }) {
  const project = useProject()

  const options = createMemo<DialogSelectOption<ExistingWorkspaceSelectValue>[]>(() =>
    project.workspace
      .list()
      .filter((workspace) => project.workspace.status(workspace.id) === "connected")
      .map((workspace: Workspace) => ({
        title: workspace.name,
        description: `(${workspace.type})`,
        value: { workspace },
      })),
  )

  return (
    <DialogSelect<ExistingWorkspaceSelectValue>
      title="Existing Workspace"
      options={options()}
      onSelect={(option) => {
        void props.onSelect({
          type: "existing",
          workspaceID: option.value.workspace.id,
          workspaceType: option.value.workspace.type,
          workspaceName: option.value.workspace.name,
        })
      }}
    />
  )
}

export function DialogWorkspaceCreate(props: { onSelect: (workspaceID: string) => Promise<void> | void }) {
  const dialog = useDialog()
  const project = useProject()
  const sdk = useSDK()
  const toast = useToast()
  const [creating, setCreating] = createSignal<string>()

  onMount(() => {
    dialog.setSize("medium")
  })

  const options = createMemo(() => {
    const type = creating()
    if (type) {
      return [
        {
          title: `Creating ${type} workspace...`,
          value: "creating" as const,
          description: "This can take a while for remote environments",
        },
      ]
    }
    return []
  })

  const create = async (type: string) => {
    if (creating()) return
    setCreating(type)

    const result = await sdk.client.experimental.workspace.create({ type, branch: null }).catch(() => {
      toast.show({
        message: "Creating workspace failed",
        variant: "error",
      })
      return undefined
    })

    const workspace = result?.data
    if (!workspace) {
      setCreating(undefined)
      toast.show({
        message: `Failed to create workspace: ${errorMessage(result?.error ?? "no response")}`,
        variant: "error",
      })
      return
    }

    await project.workspace.sync()
    await props.onSelect(workspace.id)
    setCreating(undefined)
  }

  return creating() ? (
    <DialogSelect title="Creating Workspace" skipFilter={true} renderFilter={false} options={options()} />
  ) : (
    <DialogWorkspaceTypeSelect
      onSelect={(adaptor) => {
        void create(adaptor.type)
      }}
    />
  )
}
