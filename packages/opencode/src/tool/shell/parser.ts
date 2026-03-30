import type { Node } from "web-tree-sitter"
import { lazy } from "@/util/lazy"
import { resolveWasm, resolvePath, unquote, home, expand, type Scan, type Part } from "./util"
import { Instance } from "@/project/instance"
import { Filesystem } from "@/util/filesystem"
import path from "path"
import { ShellArity } from "./arity"
import { Log } from "@/util/log"

const log = Log.create({ service: "shell-parser" })

const CWD = new Set(["cd", "push-location", "set-location"])
const FILES_BASE = new Set(["rm", "cp", "mv", "mkdir", "touch", "chmod", "chown", "cat"])
const FILES_PWSH = new Set([
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])

const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function dynamic(text: string, isPwsh: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (isPwsh) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*\[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const pre = text.match(/^([A-Za-z]+):(.*)$/)
  if (!pre) return text
  if (pre[1].length === 1) return text
  return
}

async function argPath(arg: string, cwd: string, shell: string, isPwsh: boolean) {
  const text = isPwsh ? expand(arg, cwd, shell) : home(unquote(arg))
  const file = text && prefix(text)
  if (!file || dynamic(file, isPwsh)) return
  const next = isPwsh ? provider(file) : file
  if (!next) return
  return resolvePath(next, cwd, shell)
}

function pathArgs(list: Part[], isPwsh: boolean) {
  if (!isPwsh) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

export namespace ShellParser {
  const getParser = lazy(async () => {
    const { Parser } = await import("web-tree-sitter")
    const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
      with: { type: "wasm" },
    })
    const treePath = resolveWasm(treeWasm)
    await Parser.init({
      locateFile() {
        return treePath
      },
    })
    const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
      with: { type: "wasm" },
    })
    const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
      with: { type: "wasm" },
    })
    const { Language } = await import("web-tree-sitter")
    const bashPath = resolveWasm(bashWasm)
    const psPath = resolveWasm(psWasm)
    const bashLanguage = await Language.load(bashPath)
    const psLanguage = await Language.load(psPath)

    const bash = new Parser()
    bash.setLanguage(bashLanguage)

    const ps = new Parser()
    ps.setLanguage(psLanguage)

    return { bash, ps }
  })

  export async function collect(opts: {
    command: string
    cwd: string
    shell: string
    shellType: "bash" | "pwsh" | "powershell"
  }): Promise<Scan> {
    const isPwsh = opts.shellType === "pwsh" || opts.shellType === "powershell"
    const parsers = await getParser()
    const parser = isPwsh ? parsers.ps : parsers.bash

    const tree = parser.parse(opts.command)
    if (!tree) throw new Error("Failed to parse command")
    const root = tree.rootNode

    const scan: Scan = {
      dirs: new Set<string>(),
      patterns: new Set<string>(),
      always: new Set<string>(),
    }

    const filesSet = new Set([...CWD, ...FILES_BASE, ...(isPwsh ? FILES_PWSH : [])])

    for (const node of commands(root)) {
      const commandParts = parts(node)
      const tokens = commandParts.map((item) => item.text)
      const cmd = isPwsh ? tokens[0]?.toLowerCase() : tokens[0]

      if (cmd && filesSet.has(cmd)) {
        for (const arg of pathArgs(commandParts, isPwsh)) {
          const resolved = await argPath(arg, opts.cwd, opts.shell, isPwsh)
          log.info("resolved path", { arg, resolved })
          if (!resolved || Instance.containsPath(resolved)) continue
          const dir = (await Filesystem.isDir(resolved)) ? resolved : path.dirname(resolved)
          scan.dirs.add(dir)
        }
      }

      if (tokens.length && (!cmd || !CWD.has(cmd))) {
        scan.patterns.add(source(node))
        scan.always.add(ShellArity.prefix(tokens, opts.shellType).join(" ") + " *")
      }
    }

    return scan
  }
}
