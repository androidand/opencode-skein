import { type ChildProcess as NodeChildProcess } from "child_process"
import launch from "cross-spawn"
import { buffer } from "node:stream/consumers"
import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { errorMessage } from "./error"

export type Stdio = "inherit" | "pipe" | "ignore"
export type Shell = boolean | string

export interface Options {
  cwd?: string
  env?: NodeJS.ProcessEnv | null
  stdin?: Stdio
  stdout?: Stdio
  stderr?: Stdio
  shell?: Shell
  abort?: AbortSignal
  kill?: NodeJS.Signals | number
  timeout?: number
}

export interface RunOptions extends Omit<Options, "stdout" | "stderr"> {
  nothrow?: boolean
}

export interface Result {
  code: number
  stdout: Buffer
  stderr: Buffer
}

export interface TextResult extends Result {
  text: string
}

export class RunFailedError extends Error {
  readonly cmd: string[]
  readonly code: number
  readonly stdout: Buffer
  readonly stderr: Buffer

  constructor(cmd: string[], code: number, stdout: Buffer, stderr: Buffer) {
    const text = stderr.toString().trim()
    super(
      text
        ? `Command failed with code ${code}: ${cmd.join(" ")}\n${text}`
        : `Command failed with code ${code}: ${cmd.join(" ")}`,
    )
    this.name = "ProcessRunFailedError"
    this.cmd = [...cmd]
    this.code = code
    this.stdout = stdout
    this.stderr = stderr
  }
}

export type Child = NodeChildProcess & { exited: Promise<number> }

export function spawn(cmd: string[], opts: Options = {}): Child {
  if (cmd.length === 0) throw new Error("Command is required")
  opts.abort?.throwIfAborted()

  const proc = launch(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    shell: opts.shell,
    env: opts.env === null ? {} : opts.env ? { ...process.env, ...opts.env } : undefined,
    stdio: [opts.stdin ?? "ignore", opts.stdout ?? "ignore", opts.stderr ?? "ignore"],
    windowsHide: process.platform === "win32",
  })

  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const abort = () => {
    if (closed) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    closed = true

    proc.kill(opts.kill ?? "SIGTERM")

    const ms = opts.timeout ?? 5_000
    if (ms <= 0) return
    timer = setTimeout(() => proc.kill("SIGKILL"), ms)
  }

  const exited = new Promise<number>((resolve, reject) => {
    const done = () => {
      opts.abort?.removeEventListener("abort", abort)
      if (timer) clearTimeout(timer)
    }

    proc.once("exit", (code, signal) => {
      done()
      resolve(code ?? (signal ? 1 : 0))
    })

    proc.once("error", (error) => {
      done()
      reject(error)
    })
  })
  void exited.catch(() => undefined)

  if (opts.abort) {
    opts.abort.addEventListener("abort", abort, { once: true })
    if (opts.abort.aborted) abort()
  }

  const child = proc as Child
  child.exited = exited
  return child
}

// Duplicated in `packages/sdk/js/src/process.ts` because the SDK cannot import
// `opencode` without creating a cycle. Keep both copies in sync.
export async function stop(proc: NodeChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return

  if (process.platform !== "win32" || !proc.pid) {
    proc.kill()
    return
  }

  const out = await runPromise(["taskkill", "/pid", String(proc.pid), "/T", "/F"], {
    nothrow: true,
  })

  if (out.code === 0) return
  proc.kill()
}

const mergeEnv = (env: NodeJS.ProcessEnv | null | undefined): { env: Record<string, string>; extendEnv: boolean } => {
  if (env === null) return { env: {}, extendEnv: false }
  if (env === undefined) return { env: {}, extendEnv: true }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v
  }
  return { env: out, extendEnv: true }
}

export const run = Effect.fn("Process.run")(function* (cmd: string[], opts: RunOptions = {}) {
  if (cmd.length === 0) return yield* Effect.die(new Error("Command is required"))
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const { env, extendEnv } = mergeEnv(opts.env)

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const proc = ChildProcess.make(cmd[0], cmd.slice(1), {
        cwd: opts.cwd,
        env,
        extendEnv,
        shell: opts.shell,
        stdin: opts.stdin ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const handle = yield* spawner.spawn(proc)
      const [stdoutBytes, stderrBytes, exitCode] = yield* Effect.all(
        [Stream.mkUint8Array(handle.stdout), Stream.mkUint8Array(handle.stderr), handle.exitCode],
        { concurrency: 3 },
      )
      return {
        code: exitCode as number,
        stdout: Buffer.from(stdoutBytes),
        stderr: Buffer.from(stderrBytes),
      } satisfies Result
    }),
  ).pipe(
    Effect.catch((err) =>
      opts.nothrow
        ? Effect.succeed({
            code: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(errorMessage(err)),
          } satisfies Result)
        : Effect.die(err),
    ),
  )

  if (result.code === 0 || opts.nothrow) return result
  return yield* Effect.die(new RunFailedError(cmd, result.code, result.stdout, result.stderr))
})

export const text = Effect.fn("Process.text")(function* (cmd: string[], opts: RunOptions = {}) {
  const out = yield* run(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  } satisfies TextResult
})

export const lines = Effect.fn("Process.lines")(function* (cmd: string[], opts: RunOptions = {}) {
  const out = yield* text(cmd, opts)
  return out.text.split(/\r?\n/).filter(Boolean)
})

// ---------------------------------------------------------------------------
// Promise-returning facades for legacy non-Effect callers.
//
// The new `run` / `text` / `lines` exports above return Effects. These
// wrappers preserve the original Promise-based shape (failing with
// `RunFailedError` on non-zero exit, etc.) and the legacy AbortSignal /
// timeout semantics by using `spawn(...)` directly.
//
// New code should yield the Effect versions. These wrappers exist only to
// avoid touching the remaining non-Effect call sites in this PR.
// ---------------------------------------------------------------------------

export function runPromise(cmd: string[], opts: RunOptions = {}): Promise<Result> {
  const spawnOpts = {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin,
    shell: opts.shell,
    abort: opts.abort,
    kill: opts.kill,
    timeout: opts.timeout,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
  }

  // Preserve the legacy abort/timeout semantics by using `spawn(...)` directly
  // rather than the Effect path (which lacks AbortSignal hooks today).
  const proc = spawn(cmd, spawnOpts)
  if (!proc.stdout || !proc.stderr) return Promise.reject(new Error("Process output not available"))

  return Promise.all([proc.exited, buffer(proc.stdout), buffer(proc.stderr)])
    .then(([code, stdout, stderr]) => ({
      code,
      stdout,
      stderr,
    }))
    .catch((err: unknown) => {
      if (!opts.nothrow) throw err
      return {
        code: 1,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(errorMessage(err)),
      } satisfies Result
    })
    .then((out) => {
      if (out.code === 0 || opts.nothrow) return out
      throw new RunFailedError(cmd, out.code, out.stdout, out.stderr)
    })
}

export async function textPromise(cmd: string[], opts: RunOptions = {}): Promise<TextResult> {
  const out = await runPromise(cmd, opts)
  return {
    ...out,
    text: out.stdout.toString(),
  }
}

export async function linesPromise(cmd: string[], opts: RunOptions = {}): Promise<string[]> {
  return (await textPromise(cmd, opts)).text.split(/\r?\n/).filter(Boolean)
}

export * as Process from "./process"
