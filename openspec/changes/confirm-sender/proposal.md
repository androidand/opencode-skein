# Confirm the sender of a peer message by calling it back

Parent: `autonomous-swarm`; unblocks `review-on-done` Phase 1b. Found in review of the lead
grant (2026-10-03).

## Why

An inbound peer message names its sender in an envelope attribute (`from`). The receiving
session turns that attribute into a session id (`resolveOpencodeSender`) and `verifyLead` compares
it with the lead grant. The attribute is written by the sender, so any local process that can
reach the target's socket can claim to be the lead. `codec.ts` already says provenance must never
come from these fields; the code does not follow it. Bun exposes no peer credentials on a unix
socket (probed on 1.3.14: `getPeerName`, `getPeerCredentials`, `getPeerCert` are all undefined), so
the transport cannot authenticate the sender.

## What Changes

1. Before a message is attributed to an opencode session, the receiver asks the claimed sender's
   own sidecar "did you send `msg_id` X to me?" and attributes the message only on a yes.
2. A sender keeps a short in-process log of the `msg_id`s it sent and to whom, and answers
   from that log.
3. An unconfirmed claim is delivered as an unattributed message: text is kept, the sender is
   shown as unverified, and no lead authority is granted.

## What this does NOT do

This **bounds** sender identity; it does not make it unforgeable.

- A same-user process that can replace a registry entry or a socket can still answer for it. Against
  a same-user, shell-capable agent nothing short of OS-level separation is unforgeable.
- It covers opencode senders only. A Claude Code session cannot answer the callback, so a Claude Code
  lead remains a claim (matched on pid and address). This must be stated wherever a Claude Code lead
  is described as verified.
- The real controls stay what they were: a human-confirmed grant, scopes, the publish never-list, and
  the rule that a review record is written by a tool from a session id it holds, never from message text.
