import { statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Redirect console.log to stderr before importing dsh-todo so stdout stays pure JSON-RPC.
console.log = (...args) => console.error(...args)

const defaultRoot = fileURLToPath(new URL('..', import.meta.url))
const dshTodoDir = process.env.DSH_TODO_DIR || defaultRoot
const { apply } = await import(pathToFileURL(join(dshTodoDir, 'index.js')).href)
const { defaultFilePath } = await import(pathToFileURL(join(dshTodoDir, 'lib/store.js')).href)

const todosFile = defaultFilePath()
const disableReminders = process.env.DSH_REMINDERS_DISABLE === '1' || process.env.AGY_MCP_TEST === '1'
const applyConfig = disableReminders ? { reminders: false } : {}

let current = null
let lastMtimeMs = undefined

function getMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return null
  }
}

function disposeInstance(inst) {
  if (!inst) return
  for (const fn of inst.disposers) {
    try {
      fn()
    } catch (err) {
      console.error('apple-reminders dispose error:', err)
    }
  }
}

async function createInstance() {
  const disposers = []
  let definition = null

  const logger = {
    info: (...args) => console.error('[info]', ...args),
    warn: (...args) => console.error('[warn]', ...args),
    error: (...args) => console.error('[error]', ...args),
    debug: (...args) => console.error('[debug]', ...args),
  }

  const recordEffect = (fn) => {
    const cleanup = fn()
    if (typeof cleanup === 'function') disposers.push(cleanup)
  }

  const ctx = {
    logger,
    effect: recordEffect,
    inject(deps, callback) {
      if (!Array.isArray(deps) || !deps.includes('tools')) return
      const toolCtx = {
        logger,
        effect: recordEffect,
        tools: {
          register(def) {
            definition = def
            return () => {}
          },
        },
      }
      callback(toolCtx)
    },
  }

  apply(ctx, applyConfig)
  await new Promise((resolve) => setTimeout(resolve, 30))

  if (!definition) {
    throw new Error('dsh-todo did not register personal_todos tool')
  }

  lastMtimeMs = getMtimeMs(todosFile)
  return { definition, disposers }
}

async function ensureFreshInstance(forceCheckMtime = true) {
  const diskMtime = getMtimeMs(todosFile)
  if (!current || (forceCheckMtime && diskMtime !== lastMtimeMs)) {
    disposeInstance(current)
    current = await createInstance()
  }
  return current
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return

  const hasId = msg.id !== undefined && msg.id !== null
  const method = msg.method

  // Notifications without an id must not receive a response.
  if (!hasId) return

  if (method === 'initialize') {
    const protocolVersion =
      typeof msg.params?.protocolVersion === 'string' && msg.params.protocolVersion !== ''
        ? msg.params.protocolVersion
        : '2024-11-05'
    sendResult(msg.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'apple-reminders', version: '2.2.0' },
    })
    return
  }

  if (method === 'ping') {
    sendResult(msg.id, {})
    return
  }

  if (method === 'tools/list') {
    try {
      const inst = await ensureFreshInstance(false)
      sendResult(msg.id, {
        tools: [
          {
            name: inst.definition.name,
            description: inst.definition.description,
            inputSchema: inst.definition.parameters,
          },
        ],
      })
    } catch (err) {
      sendError(msg.id, -32603, err instanceof Error ? err.message : String(err))
    }
    return
  }

  if (method === 'tools/call') {
    const name = msg.params?.name
    const args = msg.params?.arguments ?? {}
    try {
      const inst = await ensureFreshInstance(true)
      if (name !== inst.definition.name) {
        sendResult(msg.id, {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${String(name)}` }],
        })
        return
      }
      const value = await inst.definition.execute(args)
      lastMtimeMs = getMtimeMs(todosFile)
      const rendered = inst.definition.output?.render?.(args, value)
      const renderedText = Array.isArray(rendered)
        ? rendered.map((part) => part?.text ?? '').filter(Boolean).join('\n')
        : ''
      const jsonBlock = `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
      const text = renderedText ? `${renderedText}\n\n${jsonBlock}` : jsonBlock
      sendResult(msg.id, {
        content: [{ type: 'text', text }],
      })
    } catch (err) {
      sendResult(msg.id, {
        isError: true,
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
      })
    }
    return
  }

  sendError(msg.id, -32601, `Method not found: ${String(method)}`)
}

// Stdio transport supporting both newline-delimited JSON and Content-Length framing.
let buffer = Buffer.alloc(0)
let processing = Promise.resolve()

function enqueueMessage(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.error('apple-reminders invalid JSON:', err)
    return
  }
  processing = processing
    .then(() => handleMessage(parsed))
    .catch((err) => console.error('apple-reminders handleMessage error:', err))
}

function drainBuffer() {
  while (buffer.length > 0) {
    // Trim leading CR/LF
    let start = 0
    while (start < buffer.length && (buffer[start] === 0x0d || buffer[start] === 0x0a)) {
      start += 1
    }
    if (start > 0) buffer = buffer.subarray(start)
    if (buffer.length === 0) break

    const headAscii = buffer.subarray(0, Math.min(buffer.length, 32)).toString('ascii')
    if (/^content-length:/i.test(headAscii)) {
      let sepIdx = buffer.indexOf('\r\n\r\n')
      let sepLen = 4
      if (sepIdx === -1) {
        sepIdx = buffer.indexOf('\n\n')
        sepLen = 2
      }
      if (sepIdx === -1) break
      const header = buffer.subarray(0, sepIdx).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        buffer = buffer.subarray(sepIdx + sepLen)
        continue
      }
      const length = Number(match[1])
      const bodyStart = sepIdx + sepLen
      if (buffer.length < bodyStart + length) break
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      buffer = buffer.subarray(bodyStart + length)
      enqueueMessage(body)
      continue
    }

    const nlIdx = buffer.indexOf(0x0a)
    if (nlIdx === -1) break
    const line = buffer.subarray(0, nlIdx).toString('utf8').trim()
    buffer = buffer.subarray(nlIdx + 1)
    if (line !== '') enqueueMessage(line)
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  drainBuffer()
})

process.stdin.on('end', () => {
  const tail = buffer.toString('utf8').trim()
  if (tail !== '') enqueueMessage(tail)
  processing.finally(() => {
    disposeInstance(current)
    process.exit(0)
  })
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    disposeInstance(current)
    process.exit(0)
  })
}
