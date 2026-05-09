import { DialogSelect, type DialogSelectOption } from "@tui/ui/dialog-select"
import { createResource, createMemo } from "solid-js"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "@tui/context/sdk"
import path from "path"

export type DialogSkillProps = {
  onSelect: (skill: string) => void
}

export function DialogSkill(props: DialogSkillProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  dialog.setSize("large")

  const [skills] = createResource(async () => {
    const result = await sdk.client.app.skills({ include: "invalid" })
    return Array.isArray(result.data) ? { skills: result.data, invalid: [] } : (result.data ?? { skills: [], invalid: [] })
  })

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const list = skills() ?? { skills: [], invalid: [] }
    const maxWidth = Math.max(
      0,
      ...list.skills.map((s) => s.name.length),
      ...list.invalid.map((s) => path.basename(path.dirname(s.path)).length),
    )
    return [
      ...list.skills.map((skill) => ({
        title: skill.name.padEnd(maxWidth),
        description: skill.description?.replace(/\s+/g, " ").trim(),
        value: skill.name,
        category: "Skills",
        onSelect: () => {
          props.onSelect(skill.name)
          dialog.clear()
        },
      })),
      ...list.invalid.map((skill) => ({
        title: path.basename(path.dirname(skill.path)).padEnd(maxWidth),
        description: `${skill.reason}: ${skill.message}`,
        value: skill.path,
        category: "Invalid skills",
        disabled: true,
      })),
    ]
  })

  return <DialogSelect title="Skills" placeholder="Search skills..." options={options()} />
}
