/**
 * Antigravity Auxiliary Pane UI Sidecar (`sidecar://<plugin-dir>/reminders/`).
 *
 * Hosts `client.js` from the plugin root and bridges it to `index.js`,
 * `~/.dsh/dsh-apple-reminders/todos.json`, and macOS Apple Reminders, while
 * keeping cross-process mtime consistency with DSH and the Antigravity MCP server.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let sdk;
try {
  sdk = await import('sidecar_sdk');
} catch {
  const fromNodePath = process.env.NODE_PATH
    ? join(process.env.NODE_PATH.split(':')[0], 'sidecar_sdk', 'index.mjs')
    : '';
  const alt =
    fromNodePath && existsSync(fromNodePath)
      ? fromNodePath
      : join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs');
  sdk = await import(pathToFileURL(alt).href);
}
const { SidecarApp, Response } = sdk;

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DSH_TODO_DIR = fileURLToPath(new URL('../..', import.meta.url));
const DSH_TODO_DIR =
  typeof process.env.DSH_TODO_DIR === 'string' && process.env.DSH_TODO_DIR.trim() !== ''
    ? process.env.DSH_TODO_DIR.trim()
    : DEFAULT_DSH_TODO_DIR;

const { apply } = await import(pathToFileURL(join(DSH_TODO_DIR, 'index.js')).href);
const { defaultFilePath } = await import(pathToFileURL(join(DSH_TODO_DIR, 'lib', 'store.js')).href);

const reactUmdPath = join(__dirname, 'vendor', 'react.min.js');
const reactDomUmdPath = join(__dirname, 'vendor', 'react-dom.min.js');
const indexHtmlPath = join(__dirname, 'index.html');
const clientJsPath = join(DSH_TODO_DIR, 'client.js');

const remindersDisabled =
  process.env.AGY_SIDECAR_DISABLE_REMINDERS === '1' ||
  process.env.AGY_SIDECAR_DISABLE_REMINDERS === 'true';

function safeMtime(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Instantiate an isolated `dsh-todo` host controller bound to `file`, capturing
 * its registered `/api/dsh-apple-reminders/op` route and effect cleanups so
 * timers can be cleanly disposed whenever an external process edits `todos.json`.
 */
function createController(file) {
  const disposers = [];
  const routes = new Map();
  const tools = new Map();

  const fakeCordisCtx = {
    logger: console,
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') {
        disposers.push(cleanup);
      }
      return () => {};
    },
    inject(_deps, callback) {
      callback(fakeCordisCtx);
      return () => {};
    },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    connection: {
      fetch: {
        register(route) {
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
  };

  apply(fakeCordisCtx, {
    file,
    reminders: !remindersDisabled,
  });

  const opRoute = routes.get('/api/dsh-apple-reminders/op');
  if (!opRoute) {
    throw new Error('dsh-todo failed to register /api/dsh-apple-reminders/op');
  }

  let disposed = false;

  async function forwardOp(bodyObj) {
    const req = new globalThis.Request('http://127.0.0.1/api/dsh-apple-reminders/op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyObj ?? {}),
    });
    const webRes = await opRoute.fetch(req);
    const payload = await webRes.json();
    return {
      status: webRes.status,
      ok: webRes.ok && payload?.ok === true,
      payload,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of disposers.splice(0)) {
      try {
        cleanup();
      } catch {
        // Ignore best-effort cleanup errors.
      }
    }
    routes.clear();
    tools.clear();
  }

  return {
    file,
    forwardOp,
    dispose,
    get disposed() {
      return disposed;
    },
  };
}

const todosFile = defaultFilePath();
let controller = null;
let lastKnownMtimeMs = -1;
let hasInitialSynced = false;
let lastBackgroundSyncAt = 0;
let bgSyncInFlight = false;
let queue = Promise.resolve();

/** Serialize controller reloads + operations through a single promise queue. */
function serialize(task) {
  const next = queue.then(task, task);
  queue = next.then(() => {}, () => {});
  return next;
}

async function ensureController() {
  const diskMtime = safeMtime(todosFile);
  if (controller !== null && diskMtime === lastKnownMtimeMs) {
    return controller;
  }
  // Keep the active controller if it is currently mid-AppleScript merge/push.
  if (controller !== null && bgSyncInFlight) {
    return controller;
  }
  if (controller !== null) {
    const probe = await controller.forwardOp({ op: 'list' }).catch(() => null);
    if (probe?.payload?.state?.sync?.status === 'syncing') {
      return controller;
    }
    controller.dispose();
    controller = null;
  }
  const next = createController(todosFile);
  // Ensure `TodoStore.load()` (and any legacy import) completes before serving.
  await next.forwardOp({ op: 'list' });
  controller = next;
  lastKnownMtimeMs = safeMtime(todosFile);
  return controller;
}

function triggerBackgroundSync(ctrl) {
  if (remindersDisabled || bgSyncInFlight || !ctrl || ctrl.disposed) return;
  bgSyncInFlight = true;
  lastBackgroundSyncAt = Date.now();
  ctrl
    .forwardOp({ op: 'sync' })
    .then(() => {
      if (controller === ctrl && !ctrl.disposed) {
        lastKnownMtimeMs = safeMtime(todosFile);
        lastBackgroundSyncAt = Date.now();
      }
    })
    .catch(() => {})
    .finally(() => {
      bgSyncInFlight = false;
    });
}

const app = new SidecarApp();

app.page('/', () => readFileSync(indexHtmlPath, 'utf-8'));

app.api(
  '/vendor/react.js',
  () => new Response(readFileSync(reactUmdPath, 'utf-8'), { contentType: 'application/javascript' }),
  'GET',
);

app.api(
  '/vendor/react-dom.js',
  () => new Response(readFileSync(reactDomUmdPath, 'utf-8'), { contentType: 'application/javascript' }),
  'GET',
);

app.api(
  '/dsh-client.js',
  () =>
    new Response(readFileSync(clientJsPath, 'utf-8'), {
      contentType: 'application/javascript',
      headers: { 'Cache-Control': 'no-store' },
    }),
  'GET',
);

app.api(
  '/api/dsh-apple-reminders/poll',
  (data) =>
    serialize(async () => {
      const ctrl = await ensureController();
      const { payload } = await ctrl.forwardOp({ op: 'list' });
      const state = payload?.state ?? {
        rev: 0,
        items: [],
        trash: [],
        sync: { enabled: !remindersDisabled, status: remindersDisabled ? 'off' : 'idle', lastSyncAt: null },
      };
      const diskMtime = safeMtime(todosFile);

      const shouldSync =
        !remindersDisabled &&
        (!hasInitialSynced || data?.sync === '1' || Date.now() - lastBackgroundSyncAt >= 60_000);
      if (shouldSync) {
        hasInitialSynced = true;
        triggerBackgroundSync(ctrl);
      }

      const etag = `${diskMtime}:${state.rev}:${state.sync?.status}:${state.sync?.lastSyncAt || 0}`;
      if (data?.etag && data.etag === etag) {
        return { unchanged: true, etag };
      }
      return { etag, state };
    }),
  'GET',
);

app.api(
  '/api/dsh-apple-reminders/op',
  (data) =>
    serialize(async () => {
      const ctrl = await ensureController();
      const { status, ok, payload } = await ctrl.forwardOp(data ?? {});
      lastKnownMtimeMs = safeMtime(todosFile);
      if (data?.op === 'sync') {
        hasInitialSynced = true;
        lastBackgroundSyncAt = Date.now();
      }
      if (!ok) {
        return new Response(JSON.stringify(payload), {
          status: status || 400,
          contentType: 'application/json',
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return payload;
    }),
  'POST',
);

const shutdown = () => {
  try {
    controller?.dispose();
  } catch {}
  void app.close().finally(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.run();
