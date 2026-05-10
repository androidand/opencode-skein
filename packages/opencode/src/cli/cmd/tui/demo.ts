import type {
  Agent,
  AssistantMessage,
  Config,
  Message,
  Model,
  Part,
  Path,
  Project,
  Provider,
  Session,
} from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { MARKDOWN_PATTERNS, SAMPLE_MARKDOWN, SAMPLE_TABLE } from "../demo-fixtures"

const sessionID = "demo_tui_markdown"
const userMessageID = "demo_tui_user"
const assistantMessageID = "demo_tui_assistant"
const now = Date.now()

const markdown = [
  "# Fullscreen TUI Markdown Demo",
  "",
  "This fake assistant response runs through the fullscreen session timeline without calling an LLM.",
  "Use it to compare spacing, wrapping, code fence boundaries, table behavior, and inline markdown rendering.",
  "",
  "## Baseline",
  "",
  SAMPLE_MARKDOWN,
  "",
  "## Table Baseline",
  "",
  SAMPLE_TABLE,
  "",
  ...Object.entries(MARKDOWN_PATTERNS).flatMap(([name, value]) => ["## " + name, "", value, ""]),
].join("\n")

const model = {
  id: "demo",
  providerID: "demo",
  api: {
    id: "demo",
    url: "https://example.com/demo",
    npm: "demo",
  },
  name: "Demo",
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: true,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    output: 16_000,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
} satisfies Model

const provider = {
  id: "demo",
  name: "Demo",
  source: "custom",
  env: [],
  options: {},
  models: {
    demo: model,
  },
} satisfies Provider

const agent = {
  name: "build",
  description: "Demo agent",
  mode: "primary",
  native: true,
  permission: [],
  model: {
    providerID: "demo",
    modelID: "demo",
  },
  options: {},
} satisfies Agent

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
    },
  })
}

export function createTuiDemo(input: { directory: string }) {
  const paths = {
    home: process.env.HOME ?? input.directory,
    state: input.directory,
    config: input.directory,
    worktree: input.directory,
    directory: input.directory,
  } satisfies Path

  const project = {
    id: "demo_project",
    worktree: input.directory,
    vcs: "git",
    name: "Markdown Demo",
    time: {
      created: now,
      updated: now,
    },
    sandboxes: [],
  } satisfies Project

  const session = {
    id: sessionID,
    slug: "markdown-demo",
    projectID: project.id,
    directory: input.directory,
    title: "Markdown Rendering Demo",
    agent: agent.name,
    model: {
      id: model.id,
      providerID: provider.id,
    },
    version: "demo",
    time: {
      created: now,
      updated: now + 2,
    },
  } satisfies Session

  const user = {
    id: userMessageID,
    sessionID,
    role: "user",
    time: {
      created: now,
    },
    agent: agent.name,
    model: {
      providerID: provider.id,
      modelID: model.id,
    },
  } satisfies Message

  const assistant = {
    id: assistantMessageID,
    sessionID,
    role: "assistant",
    time: {
      created: now + 1,
      completed: now + 2,
    },
    parentID: userMessageID,
    modelID: model.id,
    providerID: provider.id,
    mode: "demo",
    agent: agent.name,
    path: {
      cwd: input.directory,
      root: input.directory,
    },
    cost: 0,
    tokens: {
      input: 120,
      output: 3_200,
      reasoning: 0,
      cache: {
        read: 0,
        write: 0,
      },
    },
  } satisfies AssistantMessage

  const messages = [
    {
      info: user,
      parts: [
        {
          id: "demo_tui_user_text",
          sessionID,
          messageID: userMessageID,
          type: "text",
          text: "Show me the fullscreen TUI markdown rendering stress cases.",
          time: {
            start: now,
            end: now,
          },
        },
      ],
    },
    {
      info: assistant,
      parts: [
        {
          id: "demo_tui_assistant_text",
          sessionID,
          messageID: assistantMessageID,
          type: "text",
          text: markdown,
          time: {
            start: now + 1,
            end: now + 2,
          },
        },
      ],
    },
  ] satisfies Array<{ info: Message; parts: Part[] }>

  const fetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
    const request = new Request(args[0], args[1])
    const url = new URL(request.url)
    const pathname = url.pathname

    if (request.method === "GET" && pathname === "/path") return json(paths)
    if (request.method === "GET" && pathname === "/project/current") return json(project)
    if (request.method === "GET" && pathname === "/config/providers") {
      return json({ providers: [provider], default: { build: "demo/demo" } })
    }
    if (request.method === "GET" && pathname === "/provider") {
      return json({ all: [provider], default: { build: "demo/demo" }, connected: [provider.id] })
    }
    if (request.method === "GET" && pathname === "/experimental/console") {
      return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
    }
    if (request.method === "GET" && pathname === "/agent") return json([agent])
    if (request.method === "GET" && pathname === "/config") {
      return json({ model: "demo/demo", default_agent: agent.name } satisfies Config)
    }
    if (request.method === "GET" && pathname === "/session") return json([session])
    if (request.method === "GET" && pathname === "/command") return json([])
    if (request.method === "GET" && pathname === "/lsp") return json([])
    if (request.method === "GET" && pathname === "/mcp") return json({})
    if (request.method === "GET" && pathname === "/experimental/resource") return json({})
    if (request.method === "GET" && pathname === "/formatter") return json([])
    if (request.method === "GET" && pathname === "/session/status") return json({ [sessionID]: { type: "idle" } })
    if (request.method === "GET" && pathname === "/provider/auth") return json({})
    if (request.method === "GET" && pathname === "/vcs") return json({ branch: "demo", default_branch: "dev" })
    if (request.method === "GET" && pathname === "/experimental/workspace") return json([])
    if (request.method === "GET" && pathname === "/experimental/workspace/status") return json([])
    if (request.method === "GET" && pathname === `/session/${sessionID}`) return json(session)
    if (request.method === "GET" && pathname === `/session/${sessionID}/message`) return json(messages)
    if (request.method === "GET" && pathname === `/session/${sessionID}/todo`) return json([])
    if (request.method === "GET" && pathname === `/session/${sessionID}/diff`) return json([])
    if (request.method === "GET" && pathname === `/session/${sessionID}/children`) return json([])

    return json({ message: `Unhandled demo endpoint: ${request.method} ${pathname}` }, 404)
  }) as typeof globalThis.fetch

  const events = {
    subscribe: async () => () => {},
  } satisfies EventSource

  return {
    sessionID,
    fetch,
    events,
  }
}
