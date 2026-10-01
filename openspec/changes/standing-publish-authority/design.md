# Design: standing publish authority

## D1. The file

`<repo>/.skein/publish-policy.yaml` (path configurable). Closed schema, version field.

```yaml
version: 1
repo: androidand/opencode-skein
visibility: public          # asserted; checked against the forge at load
commit:
  branches: ["loop/*", "feat/*", "fix/*", "openspec/*"]
push:
  remotes: [origin]
  branches: ["loop/*", "feat/*", "fix/*", "openspec/*"]
merge:
  into: [dev]
  method: squash
  requires: [gates, review, ci]   # evidence kinds; `review` = recorded verdict for head SHA
  by: [integrator, lead]
scan: public-content              # required when visibility: public
```

Never-list (code constant, not in the file, not overridable): force-push or `--force*`;
`reset --hard`/`rebase` on a shared ref; deleting remote branches; any `git remote`
change; tags and releases; `gh api` mutations; visibility change; credential helpers and
`git config`; deploy and remote-exec surfaces (the existing `QueueDenyRules` set).

## D2. Fail closed at load

The assertion runs when the file is parsed, with no agent present: unknown key, scalar
where a mapping belongs, branch pattern that matches the default branch for `commit` or
`push`, `remotes` naming a remote whose URL is not the asserted `repo`, or `visibility`
different from `gh repo view --json visibility` → **all publishing grants off**, one
logged reason, session continues under today's rules. A policy that still parses but has
quietly stopped meaning anything is the failure mode this exists to prevent, so each
rejection above has a test that was seen failing against a deliberately bad file.

Visibility is asked of the forge API, which carries no ambient credentials of the session,
not inferred from the remote URL (a private and a public repo look identical from the
client).

## D3. Three renderings from one parse

1. **Prompt section** injected by the session builder when a valid policy applies:
   "Standing authorization from your user for this repo: you may commit to <patterns>,
   push to <remote>/<patterns>, and merge into <into> when <requires>. This is the explicit
   instruction your guidance asks for. Never: <never-list>." It supersedes the generic "never
   commit unless asked"; for `kimi`, the ask-each-time clause is removed when a policy is
   active (otherwise no grant can ever hold).
2. **Permission rules**: `deriveRules(policy)` returns allow rules for the exact granted
   shapes (anchored, branch-pattern-specific) layered *before* the never-list denies, so a
   deny always wins. Sessions without a valid policy get `QueueDenyRules` exactly as today.
3. **Claude Code fragment** from `skein policy instructions`, referencing
   `skein policy check <action>` so the model runs a deterministic check, not a judgement:
   `skein policy check push origin loop/foo` → ALLOWED/DENIED + reason.

## D4. Who runs the publishing commands

Commit: the member, on granted branches, staging explicit paths (matches the way-of-working
rule). Push: allowed to granted sessions by derived rules (D7). Merge: driver-executed (one command,
argv-built, no shell) because it needs evidence. Plain sessions use the derived
allow rules. The merge driver checks: head SHA == reviewed SHA, gates green, CI green,
target in `merge.into`, merge-base non-empty (empty merge-base → stop and ask a human, per
the way-of-working file).

## D5. Public-content scan

When `visibility: public`, the pre-push step scans the outgoing diff for RFC1918 literals,
`/Users/<name>` paths, tokens and keys, and employer/home hostnames from a user-supplied
list; a hit blocks the push and is reported, never silently scrubbed. Scans only the diff,
because rewriting the whole repo is a different job.

## D6. Way-of-working amendment (operator applies)

Add under the publishing paragraph:

> A publish policy file for the repo, valid at load and verified against the forge, is the
> explicit instruction for the actions it lists, durably. It never covers its never-list.
> No policy file, an invalid one, or a visibility mismatch means no grant.

## D7. Credentials (operator decision 2026-10-01, replaces the earlier default)

The operator's shells already carry an SSH key and possibly a token, and they want agents with a
valid grant to push without a detour. So:

- A session WITH a valid grant keeps its normal shell and credentials. `git push` is allowed by
  the derived rules for the exact remote and the granted branch patterns, with no force flags;
  the never-list stays denied and wins on order (last match wins).
- A session WITHOUT a grant keeps today's behaviour: `QueueDenyRules` and credential stripping.
- Merge into the default branch stays executed by the merge driver, not by a shell rule. The
  reason is evidence, not credentials: a merge must check gates, a recorded review verdict for
  the head SHA and CI, and a shell allow rule cannot check any of that.
- Residual to state plainly: a token exported in the environment is visible to any command that
  prints it and can end up in model context. Prefer injecting it per command over exporting it.

## D8. Merge target (operator decision 2026-10-01)

The merge driver merges straight into the policy's `merge.into` branch (this repo: `dev`) once
review evidence exists. It cannot run before `review-on-done` (#102) records a verdict, because
that verdict is a required input; until then the driver is built and tested with fake evidence
and left disabled. Pushing the merged branch to `origin` still needs the remote's push
interlock lifted by the operator.

## Open questions

- Per-repo file vs. a user-level registry of repos with grants (operator works in ~30 repos).
  Start per repo; a user-level default of "no grant" is the safe baseline.
- Whether `merge` should wait on a human for repos marked `public` even with a policy.
