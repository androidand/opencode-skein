## MODIFIED Requirements

### Requirement: queue resolution reads tasks from the correct branch
`resolveQueue` SHALL read each change's `tasks.md` from the change's own branch
(`loop/<change-slug>`) when that branch exists, rather than from the currently
checked-out working tree. When the change's branch does not exist (first
iteration), it SHALL fall back to reading from the working tree.

#### Scenario: loop switches between two changes on different branches
- **WHEN** change A is on branch `loop/a` (all tasks checked) and change B is on
  branch `loop/b` (one task unchecked), and the working tree is currently on
  `loop/a`
- **THEN** `resolveQueue` reports change B as eligible with its one unchecked task,
  not change A as having unchecked tasks from the working tree's stale state

#### Scenario: first iteration of a new change
- **WHEN** a change has no `loop/<slug>` branch yet and its tasks.md exists only
  in the working tree
- **THEN** `resolveQueue` reads tasks.md from the working tree (fallback)

#### Scenario: brief embeds the correct tasks.md
- **WHEN** `buildBrief` is called for a change whose branch differs from the
  current checkout
- **THEN** the embedded `## tasks.md` section reflects the change's branch content,
  not the working tree's content

### Requirement: brief's next-unchecked-task matches the queue cursor
The `Next unchecked task:` line in the brief SHALL be derived from the same
branch-aware task read that `resolveQueue` uses, so the cursor and the brief
never disagree.

#### Scenario: cursor and brief agree after a branch switch
- **WHEN** the loop has just switched from change A's branch to change B's branch
- **THEN** the brief's "Next unchecked task" is the first unchecked task from
  change B's tasks.md, matching what `cursor()` returned
