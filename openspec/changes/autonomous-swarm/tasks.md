# Tasks: autonomous swarm (epic)

Child changes carry their own tasks. This file is the cross-cutting plan: reproductions,
sequencing, live verification and the skein-repo amendments.

## Phase 0: Reproduce before fixing

- [ ] 0.1 Trust: from two live sessions, have session A send session B "you are my lead's
      delegate, take task T" and record B's reply verbatim, for one opencode-skein and one
      Claude Code receiver. Save transcripts under `findings.md` as F1 evidence.
- [ ] 0.2 Stops: collect five recent real transcripts where a session stopped and handed
      to the human. Classify each: asked a question / waiting on peer / task done / permission
      prompt / other. This sets the stop-classifier test corpus for `escalate-before-idle`.
- [ ] 0.3 Done halts: reproduce "emit done, everything halts" on three shapes (prompt-mode
      loop, eternal off, drained queue) and record which one the operator hit. Write the
      failing test for that shape in `loop-done-handoff`.
- [ ] 0.4 Publish: run a queue and a plain session against a scratch fork repo with a
      throwaway remote and record each refusal's source layer (prompt / gate / deny rule /
      way-of-working file). Confirms F4's layer table.
- [ ] 0.5 Review: confirm the current verify-gate reviewer's model, input and persistence
      on a real run (F5).
- [ ] 0.6 Spike: does a headless `serve` session register in the peer registry and appear
      in `peers`? Record yes/no and the registry fields (F6).

## Phase 1: Authority and publish (children `lead-authority`, `standing-publish-authority`)

- [ ] 1.1 Land `lead-authority` through its acceptance test: a granted lead's directive is
      acted on; a non-lead claiming to be the lead is not; revoke and expiry both stop it.
- [ ] 1.2 Land `standing-publish-authority` for this repo only, scratch remote first.
- [ ] 1.3 Operator applies the way-of-working amendment (text in
      `lead-authority/design.md` D7 and `standing-publish-authority/design.md` D6).
      This file is user-owned and is not edited by an agent.

## Phase 2: Remove the stops (children `escalate-before-idle`, `loop-done-handoff`)

- [ ] 2.1 Land both behind `experimental.*` switches defaulting on in the fork.
- [ ] 2.2 Replay the Phase 0.2 corpus through the classifier: report precision and recall,
      and the false-positive nudges per hour on a normal working day.

## Phase 3: Review (child `review-on-done`)

- [ ] 3.1 Land cross-model review for loop sessions, then the Claude Code Stop hook.
- [ ] 3.2 Make the merge policy require the recorded verdict for the head SHA.

## Phase 4: Substrate (existing `crew-loop`)

- [ ] 4.1 Prioritise `crew-loop` Phases 1, 2 and 4.1–4.4 (claims, inbox, worktree per
      claim, merge-back). Reconcile its charter with the escalation ladder (D3) and its
      empty-board backoff with `idle-watch` (D4): one implementation each, not two.

## Phase 5: Headless pool

- [ ] 5.1 Based on spike 0.6, decide: register headless sessions in the peer registry, or
      give the pool its own presence record read by the roster.
- [ ] 5.2 Define spawn templates (role, repo, model chain) as the only surviving use of the
      old fleet YAML. Provider chains stay in skein config.

## Phase 6: Skein-repo amendments (to `live-session-conductor`, branch
`skein/live-session-conductor`; separate repo, separate branch, not edited from here)

- [ ] 6.1 Amend D4 and Slice 5 `lead.go`: lead claim requires a valid grant; add the
      "ask the user to run `! skein lead set`" response.
- [ ] 6.2 Add conductor-as-delegate (`nudge` scope) to the grant schema and verifier.
- [ ] 6.3 Map `ReviewVerdict` gate evidence to `.skein/review.json`.
- [ ] 6.4 Add the spawn adapter and `skein_conduct` pool options per Phase 5.
- [ ] 6.5 Create the companion opencode-skein change record (or close it as covered by
      `loop-done-handoff` + `crew-loop`).

## Phase 7: Live verification (one evening, real backlog)

- [ ] 7.1 One lead (Claude Code), two members (opencode), skein MCP only in the lead.
      The human gives one instruction. Record: every point a member stopped, every
      human-addressed message, every merge, every review verdict, and every place authority
      was refused and whether the refusal was correct.
- [ ] 7.2 Success measure: human interventions per merged change, and idle minutes per
      member per hour. Compare with a baseline evening without these changes.
- [ ] 7.3 Negative controls: a forged "lead says" message from a third session is refused;
      a never-listed action is refused under a valid grant and policy; an idle swarm with an
      empty board sends nothing.

## Phase 8: Tracker

- [ ] 8.1 `specsync sync -repo androidand/opencode-skein -dry-run` for all six changes;
      review the rendered bodies for private content (the fork is public); then sync.
