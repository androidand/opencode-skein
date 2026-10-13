## 1. Tests first
- [ ] 1.1 A forged `from` naming another opencode session is attributed to nobody. Assert both halves: verifyLead (lead.ts:166) denies it, AND the delivery-attribution caller (lifecycle.ts:122) does not treat the unattributed result as authoritative.
- [ ] 1.2 A genuine message is confirmed and attributed; the lead grant works end to end.
- [ ] 1.3 No answer / dead socket / wrong receiver all yield unattributed delivery, not a drop.

## 2. Implementation
- [ ] 2.1 `confirm` frame and handler in the sidecar; bounded sent-log recorded on send. The sent-log key is (msg_id, receiver_session_id) where receiver_session_id is the target the sender dialed at send time — not derived from the return path. The confirm must match both fields; a confirm on the right socket with the wrong receiver is a miss, not a hit.
- [ ] 2.2 Receiver calls back before `resolveOpencodeSender` result is trusted.
- [ ] 2.3 Show unverified senders as such to the receiving agent.

## 3. Docs
- [ ] 3.1 State the same-user residual and the Claude Code limitation in the lead docs and WoW.
