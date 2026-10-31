// Delivers queued events with the current config. Used by the detached flusher
// started by ingest and by the `flush` command.
import { loadConfig, validateConfig } from '../core/config.js';
import { isRouted, resolveTarget } from '../core/routes.js';
import { defaultStateDir } from '../core/fsutil.js';
import { flushQueue } from './queue.js';
import { postJson } from './webhook.js';
import { log } from './log.js';

// Routes match the workspace name. Every payload carries it (workspace_name = basename(cwd),
// plan-orca-openbot §2); removed: the Herdr workspace lookup (plan-orca-openbot §2).
// No name: default route or drop.
const workspaceName = (payload) => (typeof payload.workspace_name === 'string' && payload.workspace_name ? payload.workspace_name : null);

export function routedSend(cfg, { stateDir, post = postJson }) {
  return async (payload) => {
    const target = resolveTarget(cfg, workspaceName(payload));
    if (!target) return { ok: true, dropped: true, status: null };
    return post({ url: target.url, secret: target.secret, body: payload, timeoutMs: cfg.timeoutMs, stateDir });
  };
}

export async function runFlush({ env = process.env, ...options } = {}) {
  const stateDir = defaultStateDir(env);
  const cfg = loadConfig({ env });
  const errors = validateConfig(cfg);
  if (errors.length) return { ok: false, reason: 'unconfigured', errors };
  // Config is re-read at every send, so a rotated secret (or route) applies to the next try.
  // A config that became invalid mid-run holds the event instead of signing with a stale secret.
  const result = await flushQueue(stateDir, {
    send: (payload) => {
      const c = loadConfig({ env });
      if (validateConfig(c).length) return { ok: false, status: null, retryable: true, hold: true, error: c.secret ? 'UNCONFIGURED' : 'unsigned' };
      return isRouted(c)
        ? routedSend(c, { stateDir })(payload)
        : postJson({ url: c.url, secret: c.secret, body: payload, timeoutMs: c.timeoutMs, stateDir });
    },
    ...options,
  });
  if (result.dead) log(stateDir, 'dead-lettered ' + result.dead + ' event(s)');
  // removed: watcher spawn after a flush (plan-orca-openbot §3).
  return { ok: true, ...result };
}
