import { createResource, createMemo, For } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { TextAttributes } from "@opentui/core"
import { useKeyboard } from "@opentui/solid"
import { createStore } from "solid-js/store"
import { Locale } from "@/util/locale"
import { getScrollAcceleration } from "../util/scroll"
import { useTuiConfig } from "../context/tui-config"
import path from "path"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const [store, setStore] = createStore({ selected: 0 })
  dialog.setSize("large")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills({ include: "invalid" })
    return Array.isArray(result.data) ? { skills: result.data, invalid: [] } : (result.data ?? { skills: [], invalid: [] })
  })

  const rows = createMemo(() => {
    const list = skills() ?? { skills: [], invalid: [] }
    const maxWidth = Math.max(
      16,
      ...list.skills.map((s) => s.name.length),
      ...list.invalid.map((s) => path.basename(path.dirname(s.path)).length),
    )
    const groups = Map.groupBy(
      list.skills.toSorted((a, b) => sourceSort(a.location).localeCompare(sourceSort(b.location)) || a.name.localeCompare(b.name)),
      (skill) => sourceRoot(skill.location),
    )

    return [
      ...Array.from(groups).flatMap(([root, group]) =>
        [
          { type: "header" as const, id: root, root, count: group.length },
          ...group.map((skill) => ({
            type: "skill" as const,
            id: skill.name,
            name: skill.name.padEnd(maxWidth),
            rawName: skill.name,
            description: skill.description?.replace(/\s+/g, " ").trim() ?? "No description",
          })),
        ],
      ),
      ...(list.invalid.length > 0
        ? [
            { type: "error-header" as const, id: "errors", count: list.invalid.length },
            ...list.invalid.map((skill) => ({
              type: "error" as const,
              id: skill.path,
              name: path.basename(path.dirname(skill.path)).padEnd(maxWidth),
              reason: skill.reason,
              message: skill.message,
              location: compactLocation(skill.path),
            })),
          ]
        : []),
    ]
  })

  const selectable = createMemo(() => rows().filter((row) => row.type === "skill" || row.type === "error"))
  const height = createMemo(() =>
    Math.min(
      18,
      rows().reduce((total, row) => total + (row.type === "error" ? 2 : 1), 0),
    ),
  )

  function move(offset: number) {
    if (selectable().length === 0) return
    const next = store.selected + offset
    setStore("selected", next < 0 ? selectable().length - 1 : next >= selectable().length ? 0 : next)
  }

  function select() {
    const row = selectable()[store.selected]
    if (!row || row.type !== "skill") return
    props.onSelect(row.rawName)
    dialog.clear()
  }

  useKeyboard((evt) => {
    if (evt.name === "up") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
      return
    }
    if (evt.name === "down") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      select()
    }
  })

  const title = createMemo(() => {
    const list = skills() ?? { skills: [], invalid: [] }
    return list.invalid.length > 0 ? `Skills (${list.skills.length})  ${list.invalid.length} skipped` : `Skills (${list.skills.length})`
  })

  return (
    <box border={true} borderColor={theme.accent} paddingTop={1} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between" paddingLeft={3} paddingRight={3}>
        <text fg={theme.accent} attributes={TextAttributes.BOLD}>{title()}</text>
        <text>
          <span style={{ fg: theme.textMuted }}>(</span>
          <span style={{ fg: theme.accent }}>enter</span>
          <span style={{ fg: theme.textMuted }}>) invoke  Escape to close</span>
        </text>
      </box>
      <scrollbox
        height={height()}
        paddingLeft={2}
        paddingRight={2}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={scrollAcceleration()}
      >
        <For each={rows()}>
          {(row) => {
            if (row.type === "header") return <SourceRow root={row.root} count={row.count} />
            if (row.type === "error-header") return <ErrorHeader count={row.count} />
            const selected = createMemo(() => selectable()[store.selected]?.id === row.id)
            if (row.type === "error") {
              return (
                <box
                  flexDirection="column"
                  paddingLeft={selected() ? 2 : 3}
                  paddingRight={2}
                  backgroundColor={selected() ? theme.backgroundElement : undefined}
                  onMouseUp={() => setStore("selected", selectable().findIndex((item) => item.id === row.id))}
                >
                  <text>
                    <span style={{ fg: theme.error }}>! </span>
                    <span style={{ fg: selected() ? theme.text : theme.accent, attributes: selected() ? TextAttributes.BOLD : undefined }}>
                      {row.name}
                    </span>
                    <span style={{ fg: theme.textMuted }}> {row.reason}: </span>
                    <span style={{ fg: theme.text }}>{Locale.truncate(row.message, 46)}</span>
                  </text>
                  <text fg={theme.textMuted}>   {Locale.truncateLeft(row.location, 66)}</text>
                </box>
              )
            }
            return (
              <box
                flexDirection="row"
                paddingLeft={3}
                paddingRight={2}
                backgroundColor={selected() ? theme.backgroundElement : undefined}
                onMouseUp={() => {
                  setStore("selected", selectable().findIndex((item) => item.id === row.id))
                  props.onSelect(row.rawName)
                  dialog.clear()
                }}
              >
                <text flexGrow={1} wrapMode="none">
                  <span style={{ fg: selected() ? theme.selectedListItemText : theme.warning, attributes: TextAttributes.BOLD }}>
                    {row.name}
                  </span>
                  <span style={{ fg: selected() ? theme.text : theme.textMuted }}>
                    {Locale.truncate(row.description, 46)}
                  </span>
                </text>
              </box>
            )
          }}
        </For>
      </scrollbox>
    </box>
  )
}

function compactLocation(location: string) {
  const home = process.env.HOME
  if (!home) return location
  return location.startsWith(home) ? `~${location.slice(home.length)}` : location
}

function sourceSort(location: string) {
  const label = sourceLabel(location)
  const rank = label === "Global" ? 0 : label === "Project" ? 1 : label === "User" ? 2 : label === "Registry" ? 3 : 4
  return `${rank}:${sourceRoot(location)}`
}

function sourceLabel(location: string) {
  return sourceRootLabel(sourceRoot(location))
}

function sourceRootLabel(root: string) {
  const compact = compactLocation(root)
  if (compact.startsWith("~/.agents/") || compact.startsWith("~/.claude/")) return "Global"
  if (compact.includes("/.opencode/cache/skills")) return "Registry"
  if (root.startsWith(process.cwd())) return "Project"
  if (compact.startsWith("~/")) return "User"
  return "Project"
}

function sourceRoot(location: string) {
  return path.dirname(path.dirname(location))
}

function SourceRow(props: { root: string; count: number }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={2}>
      <text>
        <span style={{ fg: theme.accent, attributes: TextAttributes.BOLD }}>{sourceRootLabel(props.root)} </span>
        <span style={{ fg: theme.textMuted }}>{compactLocation(props.root)}/</span>
        <span style={{ fg: theme.textMuted }}> ({props.count})</span>
      </text>
    </box>
  )
}

function ErrorHeader(props: { count: number }) {
  const { theme } = useTheme()
  return (
    <box paddingLeft={2}>
      <text>
        <span style={{ fg: theme.error, attributes: TextAttributes.BOLD }}>Skipped skills with errors </span>
        <span style={{ fg: theme.textMuted }}>({props.count})</span>
      </text>
    </box>
  )
}
