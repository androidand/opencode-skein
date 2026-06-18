import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, For, Show } from "solid-js"

const id = "internal:sidebar-context"

const BAR_WIDTH = 20

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function fmtCtxK(n: number): string {
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}k`
  if (n >= 1000) return `${Math.round(n / 1024)}k`
  return `${n}`
}

function fmtTokensPerSecond(n: number): string {
  return n >= 10 ? Math.round(n).toLocaleString() : n.toFixed(1)
}

type Seg = { chars: number; color: string; filled: boolean }

function Bar(props: { segs: Seg[]; percent?: number | null; theme: any }) {
  const t = props.theme
  return (
    <text>
      <For each={props.segs}>
        {(s) => <span style={{ fg: s.color }}>{(s.filled ? "▓" : "░").repeat(Math.max(0, s.chars))}</span>}
      </For>
      <Show when={props.percent != null}>
        {"  "}
        <span style={{ fg: t.textMuted }}>{props.percent}%</span>
      </Show>
    </text>
  )
}

function emptySegs(t: any): Seg[] {
  return [{ chars: BAR_WIDTH, color: t.textMuted, filled: false }]
}

function tokenSegs(percent: number, t: any): Seg[] {
  const used = Math.max(1, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))
  return [
    { chars: used, color: t.accent, filled: true },
    { chars: BAR_WIDTH - used, color: t.textMuted, filled: false },
  ]
}

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return { tokens: 0, percent: null, ctxWindow: null, tokensPerSecond: null }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const ctx = model?.limit.context ?? 0
    const seconds = last.time.completed ? Math.max(0, (last.time.completed - last.time.created) / 1000) : 0
    const tokensPerSecond = seconds > 0 && last.tokens.output > 0 ? last.tokens.output / seconds : null

    return {
      tokens,
      percent: ctx > 0 ? Math.round((tokens / ctx) * 100) : null,
      ctxWindow: ctx > 0 ? fmtCtxK(ctx) : null,
      tokensPerSecond,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <Bar
        segs={state().percent !== null ? tokenSegs(state().percent!, theme()) : emptySegs(theme())}
        percent={state().percent}
        theme={theme()}
      />
      <Show
        when={state().percent !== null}
        fallback={<text fg={theme().textMuted}>{state().tokens.toLocaleString()} tokens</text>}
      >
        <text fg={theme().textMuted}>
          {state().tokens.toLocaleString()}
          {" / "}
          {state().ctxWindow}
        </text>
      </Show>
      <Show when={state().tokensPerSecond !== null}>
        <text fg={theme().textMuted}>{fmtTokensPerSecond(state().tokensPerSecond!)} t/s</text>
      </Show>
      <text fg={theme().textMuted}>{money.format(cost())} spent</text>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
