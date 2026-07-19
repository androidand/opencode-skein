# Coder handoff — todo

Status: RESTARTED after analysis identified root cause of stuck state.

## Root cause of previous failure
The absorb process truncated all task descriptions:
- HTTP-2 ended at "and" (missing: "decide which mappings stay inline vs. shared helper")
- ERR-4 ended at "and" (missing: "Effect.die(...) callsites for expected failures — re-run git grep to build a current inventory")
- RENDER-2 ended at "opaque" (missing: "Error: Name rendering of typed errors")
Plus the proposal had wrong build instructions (`go build` instead of `npm run build`).

## What was fixed
- tasks.md rewritten with complete descriptions sourced from `packages/opencode/specs/effect/todo.md`
- 5 atomic tasks (was 9 vague ones), each with specific file targets and Validation line
- Build commands corrected to `npm run build` (TypeScript/Effect project, not Go)

## Recommended order
Start with `HTTP-2` or `ERR-4` (both P0, low risk). These are independent of each other and of the lower-priority Flag/Global tasks.

## Key files to inspect
- `packages/opencode/src/server/routes/instance/httpapi/middleware/error.ts` — current error middleware (43 lines)
- `packages/core/src/util/error.ts` — NamedError definition
- `packages/opencode/src/server/routes/instance/httpapi/public.ts` — route handlers
- `packages/core/src/flag/flag.ts` — Flag module (for RF-5 and GLOBAL-1)
- `packages/core/src/global.ts` — global path resolution (for GLOBAL-1)

## Current NamedError.create inventory (as of 2026-07-19)
- packages/core/src/util/error.ts: 4
- packages/core/src/v1/config/error.ts: 5
- packages/core/src/v1/session.ts: 7
- packages/opencode/src/ide/index.ts: 2
- packages/opencode/src/mcp/index.ts: 1
- packages/opencode/src/session/message-error.ts: 2

## Graphify was unavailable during previous attempts — no graph context to reference
