import { getFilename } from "@opencode-ai/core/util/path"
import { type AgentPartInput, type FilePartInput, type Part, type TextPartInput } from "@opencode-ai/sdk/v2/client"
import type { FileSelection } from "@/context/file"
import { encodeFilePath } from "@/context/file/path"
import type { AgentPart, FileAttachmentPart, ImageAttachmentPart, Prompt } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createCommentMetadata, formatCommentNote } from "@/utils/comment-note"

type PromptRequestPart = (TextPartInput | FilePartInput | AgentPartInput) & { id: string }

type ContextFile = {
  key: string
  type: "file"
  path: string
  selection?: FileSelection
  comment?: string
  commentID?: string
  commentOrigin?: "review" | "file"
  preview?: string
}

type BuildRequestPartsInput = {
  prompt: Prompt
  context: ContextFile[]
  images: ImageAttachmentPart[]
  text: string
  messageID: string
  sessionID: string
  sessionDirectory: string
}

const absolute = (directory: string, path: string) => {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

const fileQuery = (selection: FileSelection | undefined) =>
  selection ? `?start=${selection.startLine}&end=${selection.endLine}` : ""

const mention = /(^|[\s([{"'])@(\S+)/g

const referencePath = (value: string) => {
  const match = value.match(/^([^:/\\]+):\/(.*)$/)
  if (!match) return
  if (/^[A-Za-z]$/.test(match[1]!)) return
  return { name: match[1]!, path: match[2] ?? "" }
}

const referenceUrl = (value: string, selection?: FileSelection) => {
  const reference = referencePath(value)
  if (!reference) return
  return `opencode-reference://${encodeURIComponent(reference.name)}/${reference.path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}${fileQuery(selection)}`
}

const parseCommentMentions = (comment: string) => {
  return Array.from(comment.matchAll(mention)).flatMap((match) => {
    const path = (match[2] ?? "").replace(/[.,!?;:)}\]"']+$/, "")
    if (!path) return []
    return [path]
  })
}

const isFileAttachment = (part: Prompt[number]): part is FileAttachmentPart => part.type === "file"
const isAgentAttachment = (part: Prompt[number]): part is AgentPart => part.type === "agent"

const toOptimisticPart = (part: PromptRequestPart, sessionID: string, messageID: string): Part => {
  if (part.type === "text") {
    return {
      id: part.id,
      type: "text",
      text: part.text,
      synthetic: part.synthetic,
      ignored: part.ignored,
      time: part.time,
      metadata: part.metadata,
      sessionID,
      messageID,
    }
  }
  if (part.type === "file") {
    return {
      id: part.id,
      type: "file",
      mime: part.mime,
      filename: part.filename,
      url: part.url,
      source: part.source,
      sessionID,
      messageID,
    }
  }
  return {
    id: part.id,
    type: "agent",
    name: part.name,
    source: part.source,
    sessionID,
    messageID,
  }
}

export function buildRequestParts(input: BuildRequestPartsInput) {
  const requestParts: PromptRequestPart[] = [
    {
      id: Identifier.ascending("part"),
      type: "text",
      text: input.text,
    },
  ]

  const filePart = (file: string, selection?: FileSelection, source?: FileAttachmentPart) => {
    const url = referenceUrl(file, selection)
    const filepath = url ? file : absolute(input.sessionDirectory, file)
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: "text/plain",
      url: url ?? `file://${encodeFilePath(filepath)}${fileQuery(selection)}`,
      filename: getFilename(file),
      ...(source
        ? {
            source: {
              type: "file" as const,
              text: {
                value: source.content,
                start: source.start,
                end: source.end,
              },
              path: filepath,
            },
          }
        : {}),
    } satisfies PromptRequestPart
  }

  const files = input.prompt
    .filter(isFileAttachment)
    .map((attachment) => filePart(attachment.path, attachment.selection, attachment))

  const agents = input.prompt.filter(isAgentAttachment).map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "agent",
      name: attachment.name,
      source: {
        value: attachment.content,
        start: attachment.start,
        end: attachment.end,
      },
    } satisfies PromptRequestPart
  })

  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item) => {
    const path = absolute(input.sessionDirectory, item.path)
    const url = referenceUrl(item.path, item.selection) ?? `file://${encodeFilePath(path)}${fileQuery(item.selection)}`
    const comment = item.comment?.trim()
    if (!comment && used.has(url)) return []
    used.add(url)

    const contextFilePart = filePart(item.path, item.selection)

    if (!comment) return [contextFilePart]

    const mentions = parseCommentMentions(comment).flatMap((path) => {
      const url = referenceUrl(path) ?? `file://${encodeFilePath(absolute(input.sessionDirectory, path))}`
      if (used.has(url)) return []
      used.add(url)
      return [filePart(path)]
    })

    return [
      {
        id: Identifier.ascending("part"),
        type: "text",
        text: formatCommentNote({ path: item.path, selection: item.selection, comment }),
        synthetic: true,
        metadata: createCommentMetadata({
          path: item.path,
          selection: item.selection,
          comment,
          preview: item.preview,
          origin: item.commentOrigin,
        }),
      } satisfies PromptRequestPart,
      contextFilePart,
      ...mentions,
    ]
  })

  const images = input.images.map((attachment) => {
    return {
      id: Identifier.ascending("part"),
      type: "file",
      mime: attachment.mime,
      url: attachment.dataUrl,
      filename: attachment.filename,
    } satisfies PromptRequestPart
  })

  requestParts.push(...files, ...context, ...agents, ...images)

  return {
    requestParts,
    optimisticParts: requestParts.map((part) => toOptimisticPart(part, input.sessionID, input.messageID)),
  }
}
