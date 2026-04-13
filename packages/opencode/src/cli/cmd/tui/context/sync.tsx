import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useProject } from "@tui/context/project"
import { useEvent } from "@tui/context/event"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, createEffect, on } from "solid-js"
import { Log } from "@/util/log"
import { errorData } from "@/util/error"
import { ConsoleState, emptyConsoleState, type ConsoleState as ConsoleStateType } from "@/config/console-state"

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      console_state: ConsoleStateType
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      console_state: emptyConsoleState,
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
    })

    const event = useEvent()
    const project = useProject()
    const sdk = useSDK()
    const log = Log.Default.clone().tag("service", "tui-sync")

    event.subscribe((event) => {
      switch (event.type) {
        case "server.instance.disposed":
          log.info("bootstrap triggered by instance disposal", {
            workspace: project.workspace.current(),
          })
          void bootstrap().catch((error) => {
            log.error("bootstrap after disposal failed", {
              workspace: project.workspace.current(),
              error: errorData(error),
            })
          })
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          const workspace = project.workspace.current()
          sdk.client.lsp.status({ workspace }).then((x) => setStore("lsp", x.data!))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap() {
      const workspace = project.workspace.current()
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      log.info("bootstrap started", { workspace, path: project.instance.path() })

      function track<T>(name: string, promise: Promise<T>) {
        return promise
          .then((value) => {
            log.debug("bootstrap request ok", { name, workspace })
            return value
          })
          .catch((error) => {
            log.error("bootstrap request failed", {
              name,
              workspace,
              error: errorData(error),
            })
            throw error
          })
      }

      const sessionListPromise = sdk.client.session
        .list({ start: start })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      // blocking - include session.list when continuing a session
      const providersPromise = track(
        "config.providers",
        sdk.client.config.providers({ workspace }, { throwOnError: true }),
      )
      const providerListPromise = track(
        "provider.list",
        sdk.client.provider.list({ workspace }, { throwOnError: true }),
      )
      const consoleStatePromise = track(
        "experimental.console.get",
        sdk.client.experimental.console
          .get({ workspace }, { throwOnError: true })
          .then((x) => ConsoleState.parse(x.data))
          .catch((error) => {
            log.warn("console state unavailable", {
              workspace,
              error: errorData(error),
            })
            return emptyConsoleState
          }),
      )
      const agentsPromise = track("app.agents", sdk.client.app.agents({ workspace }, { throwOnError: true }))
      const configPromise = track("config.get", sdk.client.config.get({ workspace }, { throwOnError: true }))
      const projectPromise = track("project.sync", project.sync())
      const sessionSyncPromise = track("session.list", sessionListPromise)
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        projectPromise,
        ...(args.continue ? [sessionSyncPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const consoleStateResponse = consoleStatePromise
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionSyncPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            consoleStateResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const consoleState = responses[2]
            const agents = responses[3]
            const config = responses[4]
            const sessions = responses[5]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("console_state", reconcile(consoleState))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          log.info("bootstrap partial", { workspace })
          // non-blocking
          Promise.all([
            ...(args.continue
              ? []
              : [
                  track("session.list.background", sessionListPromise).then((sessions) =>
                    setStore("session", reconcile(sessions)),
                  ),
                ]),
            track("experimental.console.get.background", consoleStatePromise).then((consoleState) =>
              setStore("console_state", reconcile(consoleState)),
            ),
            track("command.list", sdk.client.command.list({ workspace })).then((x) =>
              setStore("command", reconcile(x.data ?? [])),
            ),
            track("lsp.status", sdk.client.lsp.status({ workspace })).then((x) => setStore("lsp", reconcile(x.data!))),
            track("mcp.status", sdk.client.mcp.status({ workspace })).then((x) => setStore("mcp", reconcile(x.data!))),
            track("experimental.resource.list", sdk.client.experimental.resource.list({ workspace })).then((x) =>
              setStore("mcp_resource", reconcile(x.data ?? {})),
            ),
            track("formatter.status", sdk.client.formatter.status({ workspace })).then((x) =>
              setStore("formatter", reconcile(x.data!)),
            ),
            track("session.status", sdk.client.session.status({ workspace })).then((x) => {
              setStore("session_status", reconcile(x.data!))
            }),
            track("provider.auth", sdk.client.provider.auth({ workspace })).then((x) =>
              setStore("provider_auth", reconcile(x.data ?? {})),
            ),
            track("vcs.get", sdk.client.vcs.get({ workspace })).then((x) => setStore("vcs", reconcile(x.data))),
            track("project.workspace.sync", project.workspace.sync()),
          ])
            .then(() => {
              log.info("bootstrap complete", { workspace })
              setStore("status", "complete")
            })
            .catch((error) => {
              log.error("bootstrap background failed", {
                workspace,
                error: errorData(error),
              })
              throw error
            })
        })
        .catch((error) => {
          log.error("bootstrap failed", {
            workspace,
            error: errorData(error),
          })
          throw error
        })
    }

    const fullSyncedSessions = new Set<string>()
    createEffect(
      on(
        () => project.workspace.current(),
        () => {
          fullSyncedSessions.clear()
          log.info("bootstrap triggered by workspace change", {
            workspace: project.workspace.current(),
          })
          void bootstrap().catch((error) => {
            log.error("bootstrap effect failed", {
              workspace: project.workspace.current(),
              error: errorData(error),
            })
          })
        },
      ),
    )

    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      get path() {
        return project.instance.path()
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        async refresh() {
          const start = Date.now() - 30 * 24 * 60 * 60 * 1000
          const sessions = await sdk.client.session
            .list({ start })
            .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))
          setStore("session", reconcile(sessions))
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const workspace = project.workspace.current()
          const [session, messages, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID, workspace }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 100, workspace }),
            sdk.client.session.todo({ sessionID, workspace }),
            sdk.client.session.diff({ sessionID, workspace }),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              draft.todo[sessionID] = todo.data ?? []
              draft.message[sessionID] = messages.data!.map((x) => x.info)
              for (const message of messages.data!) {
                draft.part[message.info.id] = message.parts
              }
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
