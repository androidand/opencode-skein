// Outbound-only client: opencode-skein → a real Claude Code peer. There is no
// sidecar yet (see openspec/changes/claude-peer-protocol, Phase 3, deferred),
// so opencode-skein has no inbox socket of its own — a Claude peer cannot
// reply back through this channel. That limitation is stated in the tool
// description, not just here.
import { connect } from "net"
import { buildAuthFrame, buildMessageFrame, encodeFrames, type Priority } from "./codec"
import { readKeyFile, readRegistryEntry, verifyProcessIdentity } from "./registry"

const SUPPORTED_PROTOCOL = 1
/** Whole-operation deadline, not just a connect deadline: a peer may accept the connection and then hold it open indefinitely. */
const SEND_TIMEOUT_MS = 3_000

export type SendClaudeMessageResult =
  | { ok: true }
  | {
      ok: false
      reason: "not-found" | "unreachable" | "protocol-mismatch" | "identity-mismatch" | "no-token"
      detail?: string
    }

export interface SendClaudeMessageInput {
  targetPid: number
  fromSessionID: string
  fromName: string
  fromMode: string
  text: string
  priority?: Priority
}

export async function sendClaudeMessage(input: SendClaudeMessageInput): Promise<SendClaudeMessageResult> {
  const entry = await readRegistryEntry(input.targetPid)
  if (!entry) return { ok: false, reason: "not-found" }

  // Hard-gate on protocol version — a clear refusal naming the observed
  // value, never a best-effort guess at a changed wire format. An entry with
  // no `peerProtocol` at all is an unknown shape and refused the same way:
  // every entry a real install writes carries it.
  if (entry.peerProtocol !== SUPPORTED_PROTOCOL) {
    return {
      ok: false,
      reason: "protocol-mismatch",
      detail: `peer advertises protocol ${entry.peerProtocol ?? "none"}, this client only supports ${SUPPORTED_PROTOCOL}`,
    }
  }

  const key = await readKeyFile(entry)
  if (!key) return { ok: false, reason: "no-token" }

  // Pid identity, both halves of it. `pidDomain` says which pid namespace the
  // recorded pid belongs to: if it is not ours, the `ps` check below would be
  // interrogating an unrelated process, so the pid cannot be validated at all.
  // The `=== process.platform` convention is verified against a real install
  // on darwin only — if this refuses on another platform, re-verify what
  // Claude writes there before loosening it.
  if (key.pidDomain !== process.platform) {
    return {
      ok: false,
      reason: "identity-mismatch",
      detail: `peer records pid domain "${key.pidDomain ?? "none"}", this host is "${process.platform}" — the pid cannot be verified across domains`,
    }
  }
  if (!key.procStart) {
    return { ok: false, reason: "identity-mismatch", detail: "peer key file records no process start time — pid reuse cannot be ruled out" }
  }
  if (!(await verifyProcessIdentity(entry.pid, key.procStart))) {
    return { ok: false, reason: "identity-mismatch", detail: "target pid's live start time no longer matches its key file — likely pid reuse" }
  }

  // A clearly non-connectable placeholder — see module note above. Carries
  // the real sending session id for traceability without claiming a real
  // return address exists.
  const from = `uds:opencode-skein:${input.fromSessionID}`
  const frames = [
    buildAuthFrame(key.peerToken),
    buildMessageFrame({
      from,
      fromName: input.fromName,
      fromMode: input.fromMode,
      text: input.text,
      priority: input.priority,
    }),
  ]

  return new Promise((resolve) => {
    let settled = false
    let flushed = false
    let timer: ReturnType<typeof setTimeout>
    const socket = connect(entry.messagingSocketPath)

    const finish = (result: SendClaudeMessageResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }

    // A peer that accepted the frames and then holds the connection open is
    // exercising the protocol's own reply semantics, not failing — the frames
    // are already in its buffer. Only a deadline reached with nothing flushed
    // is a real failure to deliver.
    timer = setTimeout(
      () =>
        finish(flushed ? { ok: true } : { ok: false, reason: "unreachable", detail: "timed out before the message was sent" }),
      SEND_TIMEOUT_MS,
    )

    socket.once("connect", () => socket.end(encodeFrames(frames), () => (flushed = true)))
    // A close before our frames flushed is a refusal, not a delivery — a peer
    // that rejects the auth token destroys the connection, and reporting that
    // as delivered would hand the model a false confirmation.
    socket.once("close", () =>
      finish(
        flushed
          ? { ok: true }
          : { ok: false, reason: "unreachable", detail: "peer closed the connection before accepting the message" },
      ),
    )
    socket.once("error", (err) => finish({ ok: false, reason: "unreachable", detail: err.message }))
  })
}

export * as ClaudeClient from "./client"
