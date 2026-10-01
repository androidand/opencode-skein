# Tasks: standing publish authority

## Phase 0: Reproduce

- [ ] 0.1 Against a scratch repo with a throwaway remote, record which layer refuses each of
      commit, push, merge in a plain session and in a queue run (prompt / gate / deny rule /
      way-of-working). Confirms F4.
- [ ] 0.2 Pin the current deny behaviour: the 35-shape authority suite is the regression
      baseline for sessions without a policy.

## Phase 1: Policy parse

- [x] 1.1 `policy/publish.ts` (branch publish-policy-validation, cfc7bc710d, not pushed; 18 pass live / 16 + 2 skipped offline): closed schema, load, never-list constant.
- [x] 1.2 Observed-red tests for each rejection in D2 (unknown key, scalar-for-mapping,
      pattern matching the default branch, remote/repo mismatch, visibility mismatch), each
      run against a deliberately bad file and seen to fail first.
- [x] 1.3 Visibility check via the forge API, with an unreachable-forge case that fails closed.

Findings from Phase 1 (peer session):

- `QueueDenyRules` contains `*publish.ts*`, which denies `git add` on ANY file named publish.ts
  (hit on this very change). Unattended queue runs are affected. Proposal: narrow it to
  `*run*publish.ts*` and `*publish.ts*run*` in both rule sets. DECISION FOR THE OPERATOR: it
  loosens a standing deny, so it is not applied until they say so.
- `git remote get-url` returns the scp form `git@host:owner/name` by default; a parser that only
  handles URLs denies every valid policy. Both forms are tested.
- Rejections are a closed set of named reason tokens (`PublishPolicy.Reason`) with per-repo specifics in a separate `detail` field. An upstream like `origin/feature/x` is refused, not reduced to `feature`.
- The live forge test (PUBLISH_POLICY_LIVE=1) found a bug the injected tests could not: `gh` answers `PUBLIC` in uppercase, the policy says `public`. Fixed by lower-casing at the boundary. Rule for this epic: each security check gets one test against the real dependency, behind a flag.
- Mutation checks must assert that the intended line changed, not only that the file differs.

## Phase 2: Renderings

- [ ] 2.1 Prompt section injection; remove the ask-each-time clause for `kimi` when active.
- [ ] 2.2 `deriveRules(policy)`; test that a deny from the never-list beats any allow for all
      35 existing bypass shapes plus force-push variants.
- [ ] 2.3 `skein policy check|show|instructions` CLI; Claude Code fragment.

## Phase 3: Drivers

- [ ] 3.1 Commit gate: allow granted branches; stage explicit paths only.
- [ ] 3.2 Push driver honours `push.*`; refuses on tracking mismatch (way-of-working: check
      remote and tracking before any push).
- [ ] 3.3 Merge driver per D4, including empty-merge-base stop.
- [ ] 3.4 Public-content scan on the outgoing diff (D5), with a seeded positive case.

## Phase 4: Live

- [ ] 4.1 Scratch fork: member commits, pushes, review passes, integrator merges, no human.
- [ ] 4.2 Negative controls: invalid policy, visibility mismatch, force-push attempt, merge
      with a stale review SHA — each refused.
- [ ] 4.3 Only then author a policy for this repo (private values excluded; this repo is public).
