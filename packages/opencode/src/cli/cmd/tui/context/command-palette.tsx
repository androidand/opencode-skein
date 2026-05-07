import { createMemo, type Accessor, type ParentProps } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "@tui/ui/dialog-select"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import {
  formatKeyBindings,
  type OpenTuiKeymap,
  useBindings,
  useKeymapSelector,
  useOpencodeKeymap,
} from "../keymap"
import { useTuiConfig } from "./tui-config"

type SlashEntry = {
  display: string
  description?: string
  aliases?: string[]
  onSelect: () => void
}

const COMMAND_PALETTE_DIALOG = "command.palette.show"
type PaletteCommandEntry = ReturnType<OpenTuiKeymap["getCommandEntries"]>[number]

function isVisiblePaletteCommand(entry: PaletteCommandEntry) {
  return entry.command.hidden !== true && entry.command.name !== COMMAND_PALETTE_DIALOG
}

function isSuggestedPaletteCommand(entry: PaletteCommandEntry) {
  const suggested = entry.command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

export function CommandPaletteProvider(props: ParentProps) {
  const dialog = useDialog()
  useBindings(() => ({
    commands: [
      {
        name: COMMAND_PALETTE_DIALOG,
        title: "Show command palette",
        hidden: true,
        run() {
          dialog.replace(() => <CommandPaletteDialog />)
        },
      },
    ],
  }))

  return <>{props.children}</>
}

function CommandPaletteDialog() {
  const config = useTuiConfig()
  const keymap = useOpencodeKeymap()
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) => {
    const query = {
      namespace: "palette",
    }
    const reachable = keymap
      .getCommandEntries({
        ...query,
        visibility: "reachable",
      })
      .filter(isVisiblePaletteCommand)
    const registeredBindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: reachable.map((entry) => entry.command.name),
    })

    return reachable.map((entry) => ({
      ...entry,
      bindings: registeredBindings.get(entry.command.name) ?? entry.bindings,
    }))
  })
  const options = createMemo(() =>
    entries().map((entry) => ({
      title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
      description: typeof entry.command.desc === "string" ? entry.command.desc : undefined,
      category: typeof entry.command.category === "string" ? entry.command.category : undefined,
      footer: formatKeyBindings(entry.bindings, config),
      value: entry.command.name,
      suggested: isSuggestedPaletteCommand(entry),
      onSelect: (dialog: DialogContext) => {
        dialog.clear()
        keymap.dispatchCommand(entry.command.name)
      },
    })),
  )

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return options()
    return [
      ...options()
        .filter((option) => option.suggested)
        .map((option) => ({
          ...option,
          value: `suggested:${option.value}`,
          category: "Suggested",
        })),
      ...options(),
    ]
  }

  return <DialogSelect ref={(value) => (ref = value)} title="Commands" options={list()} />
}

export function useCommandSlashes(): Accessor<readonly SlashEntry[]> {
  const keymap = useOpencodeKeymap()
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) =>
    keymap
      .getCommandEntries({
        visibility: "reachable",
        namespace: "palette",
      })
      .filter(isVisiblePaletteCommand),
  )

  return createMemo<SlashEntry[]>(() =>
    entries().flatMap((entry) => {
      const slashName = entry.command.slashName
      if (typeof slashName !== "string" || !slashName) return []
      const slashAliases = entry.command.slashAliases
      return {
        display: `/${slashName}`,
        description:
          typeof entry.command.desc === "string"
            ? entry.command.desc
            : typeof entry.command.title === "string"
              ? entry.command.title
              : undefined,
        aliases: Array.isArray(slashAliases)
          ? slashAliases.filter((alias): alias is string => typeof alias === "string").map((alias) => `/${alias}`)
          : undefined,
        onSelect: () => keymap.dispatchCommand(entry.command.name),
      }
    }),
  )
}
