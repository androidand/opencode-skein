// Fake LSP server that intentionally never responds to `initialize`.
// Used by tests that reproduce hangs in the LSP touchFile flow when an
// LSP server process spawns successfully but the handshake stalls. The
// process also ignores SIGTERM for a short period to surface any teardown
// issues, but exits cleanly on SIGKILL.

let readBuffer = Buffer.alloc(0)

function decodeFrames(buffer) {
  const results = []
  let idx
  while ((idx = buffer.indexOf("\r\n\r\n")) !== -1) {
    const header = buffer.slice(0, idx).toString("utf8")
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    const len = m ? parseInt(m[1], 10) : 0
    const bodyStart = idx + 4
    const bodyEnd = bodyStart + len
    if (buffer.length < bodyEnd) break
    results.push(buffer.slice(bodyStart, bodyEnd).toString("utf8"))
    buffer = buffer.slice(bodyEnd)
  }
  return { messages: results, rest: buffer }
}

process.stdin.on("data", (chunk) => {
  readBuffer = Buffer.concat([readBuffer, chunk])
  const { messages, rest } = decodeFrames(readBuffer)
  readBuffer = rest
  // Swallow everything — including `initialize`. Never reply.
  for (const _ of messages) {
    // no-op
  }
})

// Keep the process alive until parent terminates us or closes stdin.
const keepalive = setInterval(() => {}, 60_000)
process.stdin.on("end", () => {
  clearInterval(keepalive)
  process.exit(0)
})
process.stdin.on("close", () => {
  clearInterval(keepalive)
  process.exit(0)
})
