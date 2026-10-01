# Standing publish authority: commit, push and merge within limits the user set once

Parent: `autonomous-swarm` (F4).

## Why

Agents are reluctant to commit, push and merge, and the cause is layered, not one rule:

1. Model prompts: `default.txt`/`trinity.txt` ("NEVER commit … unless the user explicitly
   asks"), `beast.txt`, and `kimi.txt` ("ask for confirmation each time, even if the user
   has confirmed in earlier conversations", which defeats any durable grant by wording).
2. Queue gates: implement/commit briefs say never push; `QueueDenyRules` denies
   `git push/tag/remote`, `gh pr merge`, `gh api`, deploy and ssh, and credentials are
   stripped from the shell. The driver pushes the branch itself; nothing merges.
3. The operator's way-of-working file: publishing needs "explicit instruction for that
   action"; "do the work" is not it.
4. Claude Code's built-in commit guidance.

The rules guard something real: this fork is public and its `dev` was force-rewritten once.
But "explicit instruction per action" with no way to give one in advance means the
swarm's last mile (merge-back) always stops for the human. The operator wants to grant it
once, per repo, bounded.

## What Changes

1. **`publish-policy`** — a per-repo, schema-validated, fail-closed file that is the
   durable explicit instruction: which branches may be committed to and pushed, to which
   remotes, what may be merged into which branch, by whom, and under which evidence
   (gates green, recorded review verdict for the head SHA, CI green).
2. **A non-overridable never-list**: force-push, history rewrite, visibility change,
   tags/releases, other remotes, credential/remote config changes, deploy.
3. **One source, three renderings**: a prompt section that replaces "never commit unless
   asked" with the scoped grant (and removes `kimi`'s ask-every-time clause when a policy is
   active); derived permission rules (allow the granted shapes, keep the never-list denied,
   keep credential stripping for sessions without a grant); and a Claude Code instruction
   fragment from `skein policy instructions`.
4. **Visibility assertion**: the policy records the repo's visibility and is checked
   against the forge at load. Mismatch disables every publishing grant. A public repo also
   enforces the public-repo content scan (no private IPs, home paths, hostnames) before
   push.
5. **Integrator path**: with a policy that allows it, a member (the integrator role in
   `crew-loop` Phase 4.4) merges an approved, green change into the allowed branch. Merge is
   a driver action like today's push, so the boundary stays in code.

## Non-goals

- No default-on. Without a policy file everything behaves as today.
- No change to `QueueDenyRules` for sessions without a grant; the 35-shape adversarial
  suite must keep passing unchanged for them.
- No auto-merge without a recorded review verdict (`review-on-done`) when the policy
  requires one.

## Impact

`loop/spec-queue/authority.ts` (policy-derived ruleset), `loop/spec-queue/brief.ts`,
`session/prompt/*.txt` (policy section injection), `permission/`, new `policy/publish.ts`,
`cli/cmd` (`policy` subcommand), docs, tests including observed-red controls.
