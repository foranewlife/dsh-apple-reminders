/**
 * Verification suite for the Antigravity plugin bundle:
 *   1) Zero machine-specific (/Users/) hardcoded paths
 *   2) Manifests, sidecar config, and vendored React UMD assets
 *   3) MCP server (mcp/server.mjs) end-to-end over stdio
 *   4) Reminders sidecar (sidecars/reminders/main.mjs) with a mock sidecar_sdk
 *
 *   node test/agy-check.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let failures = 0
function check(ok, label) {
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}`)
}

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function checkNoHardcodedPaths() {
  const targets = [
    'plugin.json',
    'mcp_config.json',
    'mcp/server.mjs',
    'skills/apple-reminders/SKILL.md',
  ]
  const sidecarDir = join(ROOT, 'sidecars/reminders')
  const entries = await readdir(sidecarDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile()) {
      targets.push(join('sidecars/reminders', entry.name))
    }
  }

  for (const rel of targets) {
    const abs = join(ROOT, rel)
    const content = await readFile(abs, 'utf8')
    const hasUsersPath = /\/Users\//.test(content)
    check(!hasUsersPath, `no /Users/ hardcoded path in ${rel}`)
  }
}

async function checkManifestsAndVendor() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const plugin = JSON.parse(await readFile(join(ROOT, 'plugin.json'), 'utf8'))
  const mcpCfg = JSON.parse(await readFile(join(ROOT, 'mcp_config.json'), 'utf8'))
  const sidecarCfg = JSON.parse(await readFile(join(ROOT, 'sidecars/reminders/sidecar.json'), 'utf8'))

  check(plugin.name === 'apple-reminders', 'plugin.json name is apple-reminders')
  check(plugin.version === pkg.version, `plugin.json version matches package.json (${pkg.version})`)
  check(typeof plugin.logo === 'string' && (await exists(join(ROOT, plugin.logo))), 'plugin.json logo exists')

  const mcpServer = mcpCfg?.mcpServers?.['apple-reminders']
  check(mcpServer?.command === 'node', 'mcp_config.json command is node')
  check(
    Array.isArray(mcpServer?.args) && mcpServer.args[0] === 'mcp/server.mjs',
    'mcp_config.json args is ["mcp/server.mjs"]',
  )
  check(await exists(join(ROOT, 'mcp/server.mjs')), 'mcp/server.mjs exists')

  check(sidecarCfg.command === 'node', 'sidecar.json command is node')
  check(
    Array.isArray(sidecarCfg.args) && sidecarCfg.args[0] === 'main.mjs',
    'sidecar.json args is ["main.mjs"]',
  )
  check(sidecarCfg.has_web_ui === true, 'sidecar.json has_web_ui is true')
  check(
    sidecarCfg.ui_config?.views?.[0]?.entrypoint === 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
    'sidecar.json entrypoint is SIDECAR_UI_ENTRYPOINT_AUX_PANE',
  )

  check(await exists(join(ROOT, 'sidecars/reminders/vendor/react.min.js')), 'vendor/react.min.js exists')
  check(await exists(join(ROOT, 'sidecars/reminders/vendor/react-dom.min.js')), 'vendor/react-dom.min.js exists')
  check(await exists(join(ROOT, 'sidecars/reminders/vendor/LICENSE')), 'vendor/LICENSE exists')
  check(!(await exists(join(ROOT, 'sidecars/reminders/package.json'))), 'no package.json in sidecars/reminders')
  check(!(await exists(join(ROOT, 'sidecars/reminders/node_modules'))), 'no node_modules in sidecars/reminders')

  return pkg.version
}

function createJsonRpcClient(proc) {
  let buf = ''
  const pending = new Map()
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id)
        pending.delete(msg.id)
        resolve(msg)
      }
    }
  })

  return {
    request(id, method, params = {}) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP request timeout for ${method}`))
        }, 5000)
        pending.set(id, {
          resolve: (msg) => {
            clearTimeout(timer)
            resolve(msg)
          },
        })
        proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params = {}) {
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

async function testMcpServer(expectedVersion, dshHome) {
  const proc = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      DSH_REMINDERS_DISABLE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const rpc = createJsonRpcClient(proc)

    const initRes = await rpc.request(1, 'initialize', { protocolVersion: '2024-11-05' })
    check(initRes.result?.serverInfo?.name === 'apple-reminders', 'MCP initialize serverInfo.name')
    check(initRes.result?.serverInfo?.version === expectedVersion, `MCP initialize version ${expectedVersion}`)

    rpc.notify('notifications/initialized', {})

    const listToolsRes = await rpc.request(2, 'tools/list')
    const toolNames = (listToolsRes.result?.tools || []).map((t) => t.name)
    check(toolNames.includes('personal_todos'), 'MCP tools/list includes personal_todos')

    const addRes = await rpc.request(3, 'tools/call', {
      name: 'personal_todos',
      arguments: { op: 'add', text: 'CI MCP task' },
    })
    check(!addRes.result?.isError, 'MCP tools/call add succeeds')
    const addText = addRes.result?.content?.[0]?.text || ''
    check(addText.includes('CI MCP task'), 'MCP tools/call add returns created task')

    const listRes = await rpc.request(4, 'tools/call', {
      name: 'personal_todos',
      arguments: { op: 'list' },
    })
    check(!listRes.result?.isError, 'MCP tools/call list succeeds')
    const listText = listRes.result?.content?.[0]?.text || ''
    check(listText.includes('CI MCP task'), 'MCP tools/call list includes created task')
  } finally {
    proc.stdin.end()
    await new Promise((resolve) => {
      proc.once('exit', resolve)
      setTimeout(() => {
        proc.kill('SIGTERM')
        resolve()
      }, 1000)
    })
  }
}

async function writeMockSidecarSdk(nodeModulesDir) {
  const sdkDir = join(nodeModulesDir, 'sidecar_sdk')
  await mkdir(sdkDir, { recursive: true })
  await writeFile(
    join(sdkDir, 'package.json'),
    JSON.stringify({ name: 'sidecar_sdk', type: 'module', exports: './index.mjs' }),
  )
  await writeFile(
    join(sdkDir, 'index.mjs'),
    `import http from 'node:http';

export class Response {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status ?? 200;
    this.contentType = init.contentType ?? 'text/plain; charset=utf-8';
    this.headers = init.headers ?? {};
  }
}

export class SidecarApp {
  constructor() {
    this.pages = new Map();
    this.apis = new Map();
    this.server = null;
  }

  page(path, handler) {
    this.pages.set(path, handler);
  }

  api(path, handler, method = 'GET') {
    this.apis.set(\`\${method.toUpperCase()} \${path}\`, handler);
  }

  async run() {
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const key = \`\${(req.method || 'GET').toUpperCase()} \${url.pathname}\`;
        if (req.method === 'GET' && this.pages.has(url.pathname)) {
          const html = await this.pages.get(url.pathname)();
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        const handler = this.apis.get(key);
        if (!handler) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        let data = {};
        if (req.method === 'GET') {
          for (const [k, v] of url.searchParams.entries()) data[k] = v;
        } else {
          const chunks = [];
          for await (const c of req) chunks.push(c);
          const raw = Buffer.concat(chunks).toString('utf8');
          data = raw ? JSON.parse(raw) : {};
        }
        const out = await handler(data);
        if (out instanceof Response) {
          res.writeHead(out.status, { 'Content-Type': out.contentType, ...out.headers });
          res.end(out.body);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const addr = this.server.address();
    process.stdout.write(\`MOCK_SIDECAR_URL=http://127.0.0.1:\${addr.port}\\n\`);
  }

  async close() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
  }
}
`,
  )
}

async function testSidecar(tmpRoot, dshHome) {
  const nodeModulesDir = join(tmpRoot, 'node_modules')
  await writeMockSidecarSdk(nodeModulesDir)

  const proc = spawn(process.execPath, [join(ROOT, 'sidecars/reminders/main.mjs')], {
    cwd: join(ROOT, 'sidecars/reminders'),
    env: {
      ...process.env,
      NODE_PATH: nodeModulesDir,
      DSH_HOME: dshHome,
      AGY_SIDECAR_DISABLE_REMINDERS: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    const baseUrl = await new Promise((resolve, reject) => {
      let out = ''
      let err = ''
      const timer = setTimeout(() => reject(new Error(`Sidecar start timeout. stderr=${err}`)), 5000)
      proc.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8')
        const m = /MOCK_SIDECAR_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(out)
        if (m) {
          clearTimeout(timer)
          resolve(m[1])
        }
      })
      proc.stderr.on('data', (chunk) => {
        err += chunk.toString('utf8')
      })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Sidecar exited early (${code}). stderr=${err}`))
      })
    })

    const htmlRes = await fetch(`${baseUrl}/`)
    const html = await htmlRes.text()
    check(htmlRes.status === 200 && html.includes('<div id="root"></div>'), 'sidecar GET / serves index.html')

    const reactRes = await fetch(`${baseUrl}/vendor/react.js`)
    check(reactRes.status === 200 && (await reactRes.text()).length > 1000, 'sidecar GET /vendor/react.js')

    const reactDomRes = await fetch(`${baseUrl}/vendor/react-dom.js`)
    check(reactDomRes.status === 200 && (await reactDomRes.text()).length > 1000, 'sidecar GET /vendor/react-dom.js')

    const clientRes = await fetch(`${baseUrl}/dsh-client.js`)
    const clientBody = await clientRes.text()
    check(
      clientRes.status === 200 && clientBody.length > 1000 && clientBody.includes('api/dsh-apple-reminders/op'),
      'sidecar GET /dsh-client.js',
    )

    const opRes = await fetch(`${baseUrl}/api/dsh-apple-reminders/op`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'add', text: 'Sidecar task' }),
    })
    const opJson = await opRes.json()
    check(opRes.status === 200 && opJson.ok === true, 'sidecar POST /api/dsh-apple-reminders/op add')

    const pollRes = await fetch(`${baseUrl}/api/dsh-apple-reminders/poll`)
    const pollJson = await pollRes.json()
    check(
      pollRes.status === 200 &&
        typeof pollJson.etag === 'string' &&
        Array.isArray(pollJson.state?.items) &&
        pollJson.state.items.some((it) => it.text === 'Sidecar task'),
      'sidecar GET /api/dsh-apple-reminders/poll returns items & etag',
    )

    const poll304Res = await fetch(`${baseUrl}/api/dsh-apple-reminders/poll?etag=${encodeURIComponent(pollJson.etag)}`)
    const poll304Json = await poll304Res.json()
    check(poll304Res.status === 200 && poll304Json.unchanged === true, 'sidecar poll ETag short-circuits')
  } finally {
    proc.kill('SIGTERM')
    await new Promise((resolve) => {
      proc.once('exit', resolve)
      setTimeout(resolve, 1000)
    })
  }
}

const tmpRoot = await mkdtemp(join(tmpdir(), 'agy-check-'))
const dshHome = join(tmpRoot, 'dsh-home')
await mkdir(dshHome, { recursive: true })

try {
  console.log('Antigravity plugin checks:')
  await checkNoHardcodedPaths()
  const expectedVersion = await checkManifestsAndVendor()
  await testMcpServer(expectedVersion, dshHome)
  await testSidecar(tmpRoot, dshHome)
  assert.equal(failures, 0, `${failures} check(s) failed`)
  console.log('All Antigravity plugin checks passed.')
} finally {
  await rm(tmpRoot, { recursive: true, force: true })
}
