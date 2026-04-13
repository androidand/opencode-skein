# Workspace Session Delete Notes

## Current state

- Deleting a workspace-backed session now removes the session record correctly.
- The UI still goes stale in some cases because the delete is handled locally and the expected event propagation is incomplete.

## Important behavior discovered

### 1. `DELETE /session/:id` is currently being handled locally

This is because workspace routing was changed so path handling happens earlier, and we now always let `DELETE /session/:id` through the local route path.

That is a little weird semantically, because for workspace-backed sessions the delete action conceptually belongs to the remote workspace session too.

Relevant code:

- `packages/opencode/src/server/router.ts`
- special-case for `DELETE /session/:id`

### 2. Local delete works, but UI does not fully update from events

The delete operation works server-side, but because we do not have an active instance in this local-delete path, we are not publishing the same events the TUI expects for immediate sync/UI updates.

That means:

- delete succeeds
- persistence updates
- but event-driven UI refresh may not happen

## Root issue

We need event publication for local handling of workspace session deletes, but in this code path we may not have an instance context.

So the current system is in an awkward middle state:

- delete is handled locally
- remote session/workspace semantics still matter
- but local event publishing is instance-dependent in places

## Key design question

Where should the "delete last session in workspace -> delete workspace" logic live?

### Option A: handle it remotely

If the remote workspace handles session deletion and also decides whether the workspace should be deleted, then the result can sync back naturally.

Pros:

- cleaner ownership model
- remote workspace remains source of truth for workspace-backed session lifecycle
- sync/event flow stays more consistent

Cons:

- requires remote delete path to be used reliably
- local special-casing in router becomes more suspect

### Option B: handle it locally

If local server deletes the session and then checks whether any sessions remain for that `workspaceID`, local can also delete the workspace.

Pros:

- straightforward to implement
- does not depend on remote behavior

Cons:

- local path now owns workspace lifecycle decisions for remote workspaces
- still has event propagation problems unless we explicitly publish/update correctly

## Current leaning

The workspace cleanup logic probably belongs on the remote side if workspace-backed sessions are supposed to behave as remote-owned state.

Reason:

- if remote handles it, the result can sync back
- avoids local special-case ownership drift

But this depends on whether `DELETE /session/:id` should actually be routed remotely for workspace sessions instead of always being forced local.

## Things to inspect next

1. `packages/opencode/src/server/router.ts`

- Revisit why `DELETE /session/:id` is forced local.
- Decide whether workspace-backed session deletes should proxy to remote instead.

2. `packages/opencode/src/session/index.ts`

- Current local cleanup logic removes workspace if no sessions remain for its `workspaceID`.
- Re-evaluate whether this should stay here or move to remote handling.

3. Event publication path

- Figure out what event(s) the TUI actually needs to update correctly after delete.
- Check whether local delete without instance can still publish enough global/sync events.

4. TUI refresh path

- `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx`
- `packages/opencode/src/cli/cmd/tui/context/sync.tsx`

We added an explicit session-list refresh to work around stale UI, but that is treating the symptom.

## Summary

The real unresolved issue is ownership:

- local currently handles `DELETE /session/:id`
- remote workspace semantics still matter
- event propagation is incomplete when delete is handled without an instance

Next session should start by deciding:

1. Should workspace session delete be handled locally or remotely?
2. Where should "delete workspace if no sessions remain" live?
3. What event must be published so the UI updates without manual refresh?
