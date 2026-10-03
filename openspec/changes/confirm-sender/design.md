## Decisions

**D1 Callback, not credentials.** No peer-credential primitive exists in the runtime, so identity is
established by asking the claimed sender, who alone holds the answer. A forger cannot make the real
session report a message it never sent.

**D2 Fail to unattributed, never to attributed.** No answer (timeout, dead socket, unknown id) means
the message arrives with the sender unverified. Delivery is never blocked by the check.

**D3 The sender log is in memory and bounded** (recent ids, short TTL). It is not a record to audit
and holds no message text.

**D4 Claude Code senders are out of scope** because they cannot be asked. For them the lead check keeps
matching pid and address, and docs must call that a claim.

**D5 Replay.** A confirmation names the receiver and the `msg_id`; a sender answers yes only for ids it
sent to that receiver, so a confirmed id cannot vouch for a different recipient.
