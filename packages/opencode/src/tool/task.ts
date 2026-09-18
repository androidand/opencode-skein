import * as Tool from "./tool"
import DESCRIPTION from "./task.txt"
import { ToolJsonSchema } from "./json-schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { BackgroundJob } from "@/background/job"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import { LocalPlacement } from "@/local/placement"
import { Provider } from "@/provider/provider"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "@/config/config"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Database } from "@opencode-ai/core/database/database"
import { SessionStatus } from "@/session/status"
import { Permission } from "@/permission"
import { formatPeerMessage, resolveMessageTargets } from "@/session/peers"
import { fetchClaudeAgentRecords } from "@/agent/presence-claude"
import { sendClaudeMessage } from "@/peer/claude/client"
import { sidecarNameFor } from "@/peer/claude/sidecar-manager"
import {
  awaitTaskReply,
  buildTaskEnvelope,
  cancelTaskReply,
  pickPeer,
  type PeerCandidate,
  type TaskReplyResult,
} from "@/peer/delegate"
import { deliverToOpencodeSession, foreignStatuses } from "@/peer/route"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): Effect.Effect<void>
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<SessionV1.WithParts>
}

const id = "task"
// fork: total-duration backstop for a foreground subagent wait — see the
// acquireUseRelease block below for why. Deliberately well above the
// provider-layer header-timeout default (180s, provider.ts) since a
// legitimate subagent task may make several round trips (multiple tool
// calls, possibly more than one cold model load) before producing a final
// result; this only needs to catch a task that is genuinely stuck, not cap
// normal multi-step work. Reduced from 20min to 10min — with loop detection
// and chunk timeouts in place, 10min is a generous backstop for a stuck agent
// while still allowing legitimate multi-step subagent work to complete.
const SUBAGENT_TASK_TIMEOUT_MS = 10 * 60 * 1000
// fork: the original wording ("Foreground is the default; use background only
// for independent work") reliably produced all-foreground fan-out — the model
// took the stated default and blocked on every subagent in turn, which on a
// multi-host local fleet means one host works while the rest sit idle. Stating
// the preference the other way round ("PREFER background=true") still wasn't
// enough for weaker local models, which just called the tool without setting
// the parameter at all and got the (blocking) default. So background is now
// the actual runtime default (see runInBackground above) — this text just
// needs to tell the model how to opt back into foreground when it genuinely
// needs the result before its next step.
const BACKGROUND_DESCRIPTION = [
  "Tasks run in the background by default: this call returns immediately and you are notified",
  "automatically when it finishes, so you keep working on other things meanwhile.",
  "Launching N independent agents in one message is the normal way to fan out — none of them block you.",
  "Pass background=false only when you genuinely cannot take another step without this agent's result;",
  "that blocks this entire turn until it finishes, so use it sparingly.",
].join(" ")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Continue working on non-overlapping tasks. Do not end your response — keep making progress on other work.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work — avoid working with the same files or topics it is using.",
  "Continue working on non-overlapping tasks. Do not end your response — keep making progress on other work.",
].join("\n")

const BaseParameterFields = {
  description: Schema.String.annotate({ description: "A short (3-5 words) description of the task" }),
  prompt: Schema.String.annotate({ description: "The task for the agent to perform" }),
  subagent_type: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  task_id: Schema.optional(Schema.String).annotate({
    description:
      'Only set this to resume a previous task, using the exact id from that task\'s own result (the `id="..."` on its <task> tag, e.g. "ses_abc123"). Never invent your own label here — an unrecognized value is ignored and a fresh task is started instead. Omit this field entirely for a new task.',
  }),
  command: Schema.optional(Schema.String).annotate({ description: "The command that triggered this task" }),
  provider: Schema.optional(Schema.String).annotate({
    description:
      'Local provider (host) to run this subagent on, e.g. "rocky" or "m3". Use when the user names a host; copy the name exactly. Omit to auto-place on an idle host.',
  }),
}

const BaseParameters = Schema.Struct(BaseParameterFields)

export const Parameters = Schema.Struct({
  ...BaseParameterFields,
  background: Schema.optional(Schema.Boolean).annotate({
    description:
      "Defaults to true (background). Pass false to block this turn until the agent completes. You will be notified when it completes either way. DO NOT sleep, poll, or proactively check on its progress",
  }),
})

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${input.summary}</summary>`] : []),
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    // Optional: absent in stripped-down environments (tests); placement is
    // simply skipped there.
    const provider = Option.getOrUndefined(yield* Effect.serviceOption(Provider.Service))
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const flags = yield* RuntimeFlags.Service
    const database = yield* Database.Service
    // Optional like `provider`: absent in stripped-down environments, where
    // peer delegation is simply not attempted.
    const sessionStatus = Option.getOrUndefined(yield* Effect.serviceOption(SessionStatus.Service))
    const permission = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))

    const run = Effect.fn("TaskTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const cfg = yield* config.get()
      // fork: background is opt-out, not opt-in, once the experimental flag is
      // on — weak local orchestrators reliably ignore a "prefer background=true"
      // instruction in the tool description and just call the tool with its
      // (blocking) default, which stalls the whole fleet behind one subagent.
      // Making background the *default* means that failure mode requires no
      // model cooperation at all. When the flag is off, `background` never
      // appears in the schema (see jsonSchema below), so params.background is
      // always undefined here and this must fall through to foreground rather
      // than defaulting on and tripping the flag-required error below.
      const runInBackground = flags.experimentalBackgroundSubagents && params.background !== false
      if (params.background === true && !flags.experimentalBackgroundSubagents) {
        return yield* Effect.fail(
          new Error("Background subagents require OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true"),
        )
      }

      const parent = yield* sessions.get(ctx.sessionID)
      let current = parent
      let depth = 0
      while (current.parentID) {
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      if (!ctx.extra?.bypassAgentCheck) {
        yield* ctx.ask({
          permission: id,
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const next = yield* agent.get(params.subagent_type)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`))
      }

      // fork: task_id is meant to be an opaque id this same tool previously
      // returned (see the "<task id=...>" wrapper in renderOutput), but a
      // model — especially a weaker one — will sometimes invent its own
      // human-readable label instead (e.g. "review-changes-1") believing it
      // is naming the task rather than resuming one. SessionID.make() throws
      // a raw schema validation error for anything not shaped like a real
      // session id, which used to escape past the "session not found" catch
      // below (that catch only ever covered sessions.get, not the throwing
      // construction of its argument) and surface as a confusing tool error.
      // Treat an invalid task_id exactly like one that doesn't resolve to a
      // session: fall through to creating a fresh one.
      const session =
        params.task_id && Schema.is(SessionID)(params.task_id)
          ? yield* sessions.get(SessionID.make(params.task_id)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          : undefined
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === id)
          ? []
          : [{ permission: id, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          agent: next.name,
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      // fork: publish the child session id as soon as it exists. The local
      // placement probing below adds `model` to this metadata, but it can take
      // a moment, and callers (the TUI, cancel propagation, and the upstream
      // contract tests) need `sessionId` on the running part immediately —
      // waiting until after placement leaves the part with no metadata at all.
      yield* ctx.metadata({
        title: params.description,
        metadata: {
          parentSessionId: ctx.sessionID,
          sessionId: nextSession.id,
          ...(runInBackground ? { background: true } : {}),
        },
      })

      const msg = yield* MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const variant = msg.info.variant

      const inherited = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      // fork: a subagent inheriting a local provider queues behind its parent
      // on the same (often single-slot) llama.cpp server — worse than useless.
      // Hop to an idle local peer instead. Resumed sessions keep the old
      // behavior so a running task isn't re-placed away from its warm cache.
      // A role that declares where it wants to run makes placement worth
      // attempting even from a cloud parent — see LocalPlacement.pick. The
      // kill-switch and an explicit host argument both still win.
      const rolePlacement = next.placement && next.placement !== "inherit" ? next.placement : undefined
      const outcome =
        !provider || next.model || session || (cfg.experimental?.local_subagent_placement === false && !params.provider)
          ? null
          : yield* provider.list().pipe(
              Effect.flatMap((providers) =>
                Effect.promise(() =>
                  LocalPlacement.pick({
                    parent: inherited,
                    providers,
                    allowedModels: cfg.experimental?.local_subagent_placement_models,
                    promptText: params.prompt,
                    target: params.provider,
                    prefer: rolePlacement,
                  }),
                ),
              ),
            )
      // pick() stays plain so its slot reservation is synchronous; it reports
      // the outcome and the logging happens here, in Effect context.
      if (outcome?.kind === "placed") {
        yield* Effect.logInfo("placed subagent on idle local provider", {
          provider: outcome.placement.providerID,
          model: outcome.placement.modelID,
          parent: inherited.providerID,
          requiredCtx: outcome.requiredCtx,
          probed: outcome.probed,
        })
        // The probe just read the host's current per-slot context; discovery
        // may have seen a different --parallel. Trim to what is true now.
        if (provider && outcome.maxSafeCtx > 0)
          yield* provider.setModelContextLimit(
            outcome.placement.providerID,
            outcome.placement.modelID,
            outcome.maxSafeCtx,
            "keep",
          )
      } else if (outcome?.kind === "none")
        yield* Effect.logInfo("no idle local provider, inheriting parent", {
          parent: inherited.providerID,
          probed: outcome.probed,
        })
      else if (outcome?.kind === "failed")
        yield* Effect.logError("placement failed, inheriting parent", { error: outcome.error })

      const placed = outcome?.kind === "placed" ? outcome : null
      // An explicitly requested host must be honored or refused loudly —
      // silently placing elsewhere (or inheriting) would do the opposite of
      // what the user asked for.
      if (params.provider && !placed && !next.model && !session) {
        const known = provider
          ? Object.values(yield* provider.list())
              .filter((info) => LocalPlacement.baseURLOf(info))
              .map((info) => info.id)
          : []
        return yield* Effect.fail(
          new Error(
            `Requested provider "${params.provider}" is not available for a subagent right now ` +
              `(unknown name, no free slot, or no eligible model). ` +
              (known.length ? `Known local providers: ${known.join(", ")}. ` : "") +
              `Retry later, pick another provider, or omit provider to auto-place.`,
          ),
        )
      }
      // Placement found no idle peer, so we are about to fall back to the
      // parent's own provider. On a single-slot llama.cpp server that queues
      // the subagent behind its parent, which never returns — the session
      // reads as hung. Refuse instead of queueing invisibly.
      //
      // Only checked when placement actually ran and came back empty: an
      // explicit model or a resumed session is a deliberate choice, not a
      // fallback.
      const willInherit = !next.model && !placed
      const placementRan = !!provider && !next.model && !session && cfg.experimental?.local_subagent_placement !== false

      // Every local host is full. Before refusing, offer the task to an idle
      // peer agent that runs on capacity this host does not share — a Claude
      // Code session, or an opencode session on a cloud provider. The peer
      // answers with a marker line (`peer/delegate.ts`) that the inbound paths
      // route back here as the task result.
      let delegated: { peer: PeerCandidate; reply: Promise<TaskReplyResult> } | undefined
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))
      const delegate = Effect.fn("TaskTool.delegate")(function* () {
        if (!sessionStatus || !permission) return undefined
        const [all, statuses, permissions, providers, foreign] = yield* Effect.all([
          sessions.list(),
          sessionStatus.list(),
          permission.list(),
          provider ? provider.list() : Effect.succeed({} as Record<string, Provider.Info>),
          Effect.promise(() => foreignStatuses()),
        ])
        const localProviderIDs = new Set(
          Object.values(providers)
            .filter((info) => LocalPlacement.baseURLOf(info))
            .map((info) => info.id as string),
        )
        const opencodePeers = resolveMessageTargets({
          sessions: all.map((item) => ({
            id: item.id,
            parentID: item.parentID,
            directory: item.directory,
            title: item.title,
            agent: item.agent,
            model: item.model ? { providerID: item.model.providerID, id: item.model.id } : undefined,
            updatedAt: item.time.updated,
          })),
          statuses,
          pendingPermission: new Set(permissions.map((item) => item.sessionID)),
          loops: [],
          callerID: ctx.sessionID,
          foreign,
          now: Date.now(),
        }).map(
          (peer): PeerCandidate => ({
            owner: "opencode-skein",
            id: peer.sessionID,
            name: peer.title,
            status: peer.status,
            provider: peer.provider,
            idleForMs: peer.idleForMs,
          }),
        )
        // A Claude peer can only reply to a session Claude can see — one with
        // a sidecar of its own. A nested subagent has none.
        const replyName = sidecarNameFor(ctx.sessionID)
        const claudePeers =
          replyName && !flags.disableClaudeCodePeerMessaging
            ? (yield* Effect.promise(() =>
                fetchClaudeAgentRecords({ enabled: !flags.disableClaudeCodePeerSource }),
              )).map(
                (record): PeerCandidate => ({
                  owner: "claude-code",
                  id: String(record.pid),
                  name: record.name ?? `pid ${record.pid}`,
                  status: record.status ?? "busy",
                }),
              )
            : []
        const peer = pickPeer({ peers: [...claudePeers, ...opencodePeers], localProviderIDs })
        if (!peer) return undefined

        const isClaude = peer.owner === "claude-code"
        const envelope = buildTaskEnvelope({
          taskID: nextSession.id,
          description: params.description,
          prompt: params.prompt,
          cwd: parent.directory,
          replyTo: isClaude ? replyName! : ctx.sessionID,
          replyTool: isClaude ? "SendMessage" : "send_peer_message",
          deadlineMs: SUBAGENT_TASK_TIMEOUT_MS,
        })
        // Register before sending so a fast reply cannot land first.
        const reply = awaitTaskReply(nextSession.id, SUBAGENT_TASK_TIMEOUT_MS)
        if (isClaude) {
          const sent = yield* Effect.promise(() =>
            sendClaudeMessage({
              targetPid: Number(peer.id),
              fromSessionID: ctx.sessionID,
              fromName: parent.title,
              fromMode: "prompting",
              text: envelope,
            }),
          )
          if (!sent.ok) {
            cancelTaskReply(nextSession.id)
            yield* Effect.logWarning("peer delegation: Claude peer unreachable", { pid: peer.id, reason: sent.reason })
            return undefined
          }
        } else {
          const target = yield* sessions.get(SessionID.make(peer.id)).pipe(Effect.orElseSucceed(() => undefined))
          if (!target) {
            cancelTaskReply(nextSession.id)
            return undefined
          }
          const outcome = yield* deliverToOpencodeSession({
            targetSessionID: target.id,
            fromSessionID: ctx.sessionID,
            fromName: parent.title,
            text: envelope,
            local: () =>
              ops
                .prompt({
                  sessionID: target.id,
                  agent: target.agent ?? ctx.agent,
                  parts: [
                    {
                      type: "text",
                      synthetic: true,
                      text: formatPeerMessage({ sessionID: ctx.sessionID, title: parent.title }, envelope),
                    },
                  ],
                })
                .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true })),
          })
          if (outcome.via === "socket" && !outcome.result.ok) {
            cancelTaskReply(nextSession.id)
            yield* Effect.logWarning("peer delegation: opencode peer unreachable", { peer: peer.id, reason: outcome.result.reason })
            return undefined
          }
        }
        yield* Effect.logInfo("delegated subagent task to idle peer", {
          owner: peer.owner,
          peer: peer.id,
          name: peer.name,
          task: nextSession.id,
        })
        return { peer, reply }
      })
      if (willInherit && placementRan) {
        const capacity = yield* provider
          .list()
          .pipe(
            Effect.flatMap((providers) =>
              Effect.promise(() => LocalPlacement.parentCapacity({ parent: inherited, providers })),
            ),
          )
        // Block inheritance only when the parent is KNOWN busy. A probe failure
        // returns "unknown", and an unreachable probe is not evidence of a full
        // queue: failing closed there turns any transient probe blip — or a
        // provider that simply does not answer /api/fit, like a test mock or a
        // non-llama-skein openai-compatible endpoint — into a hard subagent
        // failure. The hang this guard protects against needs a real single-slot
        // server that is really busy, and "no-slot" is what says so.
        if (capacity === "unknown")
          yield* Effect.logWarning("subagent capacity probe unreachable, inheriting parent anyway", {
            provider: inherited.providerID,
          })
        if (capacity === "no-slot") {
          if (cfg.experimental?.peer_delegation !== false) delegated = yield* delegate()
          if (!delegated)
            return yield* Effect.fail(
              new Error(
                `No capacity for subagent: local provider "${inherited.providerID}" has no free slot, ` +
                  `no idle local host was available, and no idle peer agent could take the task. It serves ` +
                  `one session at a time, so running here would queue behind this session and never return. ` +
                  `Retry when it frees up, or pass an explicit model on a different provider.`,
              ),
            )
        }
      }
      // Only the data half of the placement goes anywhere near metadata —
      // part metadata is structuredClone()d on every update event, and the
      // release() handle is a function (DataCloneError, dead subagent).
      const model = next.model ?? placed?.placement ?? inherited
      const metadata = {
        parentSessionId: ctx.sessionID,
        sessionId: nextSession.id,
        model,
        ...(runInBackground ? { background: true } : {}),
        ...(delegated
          ? { delegatedTo: { owner: delegated.peer.owner, id: delegated.peer.id, name: delegated.peer.name } }
          : {}),
      }

      yield* ctx.metadata({
        title: params.description,
        metadata,
      })

      // Release the local-placement slot reservation (if we hopped to an idle
      // peer) when the subagent finishes, however it finishes — success,
      // error, or interrupt. release() is idempotent and a no-op when we
      // inherited the parent (placed === null).
      const releaseSlot = Effect.sync(() => placed?.release())

      const runTask = Effect.fn("TaskTool.runTask")(function* () {
        if (delegated) {
          const result = yield* Effect.promise(() => delegated.reply).pipe(
            Effect.onInterrupt(() => Effect.sync(() => cancelTaskReply(nextSession.id))),
          )
          if (result.ok) return result.text
          return yield* Effect.fail(
            new Error(
              result.reason === "timeout"
                ? `Peer ${delegated.peer.name} (${delegated.peer.owner}) did not reply within ${SUBAGENT_TASK_TIMEOUT_MS / 1000}s.`
                : "Delegated task cancelled.",
            ),
          )
        }
        const parts = yield* ops.resolvePromptParts(params.prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: nextSession.id,
          model: {
            modelID: model.modelID,
            providerID: model.providerID,
          },
          // A pinned or placed model differs from the parent's — its variant
          // set may not apply there.
          variant: next.model || placed ? undefined : variant,
          agent: next.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const inject = Effect.fn("TaskTool.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(ctx.sessionID)
        yield* ops
          .prompt({
            sessionID: ctx.sessionID,
            agent: currentParent.agent ?? ctx.agent,
            variant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${params.description}`
                      : `Background task failed: ${params.description}`,
                  text,
                }),
              },
            ],
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("TaskTool.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) => {
            if (result.info?.status === "completed") return inject("completed", result.info.output ?? "")
            if (result.info?.status === "error") return inject("error", result.info.error ?? "")
            return Effect.void
          }),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      if (yield* background.extend({ id: nextSession.id, run: runTask().pipe(Effect.ensuring(releaseSlot)) })) {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task updated",
            text: BACKGROUND_UPDATED,
          }),
        }
      }

      const info = yield* background.start({
        id: nextSession.id,
        type: id,
        title: params.description,
        metadata,
        onPromote: Effect.all([
          ctx.metadata({
            title: params.description,
            metadata: { ...metadata, background: true, jobId: nextSession.id },
          }),
          notify(nextSession.id),
        ]),
        run: runTask().pipe(
          Effect.onInterrupt(() => ops.cancel(nextSession.id)),
          Effect.ensuring(releaseSlot),
        ),
      })

      function backgroundResult() {
        return {
          title: params.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: info.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary: "Background task started",
            text: BACKGROUND_STARTED,
          }),
        }
      }

      if (runInBackground) {
        yield* notify(info.id)
        return backgroundResult()
      }

      const runCancel = yield* EffectBridge.make()
      const cancel = ops.cancel(nextSession.id)

      function onAbort() {
        runCancel.fork(cancel)
      }

      return yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          ctx.abort.addEventListener("abort", onAbort)
        }),
        () =>
          Effect.gen(function* () {
            // fork: bound the whole foreground wait. Without this, a subagent
            // stuck on an unresponsive backend (a hung fetch the provider-layer
            // header timeout didn't catch, an infinite tool-call loop, etc.)
            // left the parent session waiting forever with no error and no way
            // to react. On timeout, cancel the subagent session outright
            // (background.cancel — the same interrupt/cleanup path used for
            // explicit user cancellation) rather than merely giving up on it:
            // leaving it running would keep occupying its assigned local model
            // slot indefinitely.
            const waited = yield* Effect.raceFirst(
              background.wait({ id: nextSession.id, timeout: SUBAGENT_TASK_TIMEOUT_MS }),
              background
                .waitForPromotion(nextSession.id)
                .pipe(Effect.map((info) => ({ info, timedOut: false as const }))),
            )
            if (waited.timedOut) {
              yield* background.cancel(nextSession.id)
              return yield* Effect.fail(
                new Error(
                  `Subagent timed out after ${SUBAGENT_TASK_TIMEOUT_MS / 1000}s waiting for a response — the assigned model or host may be unresponsive. The subagent session was cancelled.`,
                ),
              )
            }
            const result = waited.info
            if (result?.metadata?.background === true) return backgroundResult()
            if (result?.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
            if (result?.status === "cancelled") return yield* Effect.fail(new Error("Task cancelled"))
            return {
              title: params.description,
              metadata,
              output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result?.output ?? "" }),
            }
          }),
        (_, exit) =>
          Effect.gen(function* () {
            if (Exit.hasInterrupts(exit))
              yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                ctx.abort.removeEventListener("abort", onAbort)
              }),
            ),
          ),
      )
    })

    // Best-effort fleet visibility: list local providers by name so the model
    // can honor "run this on rocky". Discovery is async, so hosts appearing
    // later are still reachable via the provider parameter by name.
    // Must survive init contexts with no project instance loaded —
    // provider.list() can die there (defect, not typed failure), and a
    // defect at tool-init kills the whole server worker at startup.
    // Effect.exit captures failures and defects alike.
    const listExit = provider ? yield* provider.list().pipe(Effect.exit) : undefined
    const localProviders =
      listExit !== undefined && Exit.isSuccess(listExit)
        ? Object.values(listExit.value)
            .filter((info) => LocalPlacement.baseURLOf(info))
            .map((info) => info.id)
        : []
    const FLEET_DESCRIPTION = localProviders.length
      ? `Local providers available for the provider parameter: ${localProviders.join(", ")}.`
      : undefined

    return {
      description: [
        DESCRIPTION,
        ...(flags.experimentalBackgroundSubagents ? [BACKGROUND_DESCRIPTION] : []),
        ...(FLEET_DESCRIPTION ? [FLEET_DESCRIPTION] : []),
      ].join("\n\n"),
      parameters: Parameters,
      jsonSchema: flags.experimentalBackgroundSubagents ? undefined : ToolJsonSchema.fromSchema(BaseParameters),
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
