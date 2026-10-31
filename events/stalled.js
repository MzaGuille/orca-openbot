// Stalled turn: a Pi turn is open, the bridge heartbeat still arrives, but no tool_start/tool_end,
// message_end or turn_start was seen for the threshold. A running tool is never a stall.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envVar } from '../core/env.js';
import { readJson, writeJson, withLock } from '../core/fsutil.js';
import { paneBridgeStall } from './pi-bridge.js';
import { piRecordPath } from './pi-path.js';
import { evaluateSignals } from './attention/evaluate.js';
import { buildPayload, validatePayload } from './payload.js';
import { enqueue } from './queue.js';
import { detectAll } from '../core/detect.js';

export const STALLED_MINUTES = 15;

// OPENBOT_ORCA_STALLED_MINUTES: a positive whole number of minutes; anything else falls back to 15.
export function stalledMs(env = process.env) {
  const raw = envVar(env, 'OPENBOT_ORCA_STALLED_MINUTES');
  const minutes = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  return (Number.isSafeInteger(minutes) && minutes > 0 ? minutes : STALLED_MINUTES) * 60000;
}

// The pane's cwd from the last Pi record that carries one (the bridge has none).
function lastCwd(env, paneId) {
  try {
    const lines = readFileSync(piRecordPath(env, paneId), 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const cwd = JSON.parse(lines[i]).cwd; if (typeof cwd === 'string' && cwd) return cwd; } catch {}
    }
  } catch {}
  return null;
}

/** Enqueue one `stalled` payload per stall episode (re-armed by any new activity). Returns 1 or 0. */
export function enqueueStalled({ paneId, env, dir, cfg, redaction, now }) {
  const stall = paneBridgeStall(env, paneId, { now, thresholdMs: stalledMs(env) });
  if (!stall.stalled) return 0;
  const attention = evaluateSignals({ source: 'pi-ext', name: 'stalled' });
  const cwd = lastCwd(env, paneId);
  const minutes = Math.floor(stall.idleMs / 60000);
  const det = detectAll();
  return withLock(join(dir, 'stalled.lock'), () => {
    const file = join(dir, 'stalled.json'), seen = readJson(file, {});
    if (seen[paneId] === stall.key) return 0;
    const payload = buildPayload({ host: det.host, machineLabel: cfg.machineLabel, os: det.os, pluginVersion: det.plugin_version,
      workspaceId: 'orca', workspaceName: (cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || null, paneId, agent: 'pi',
      state: attention.state, attentionKind: attention.attentionKind, signal: 'pi-stalled', cwd,
      project: (cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || null, question: null,
      summary: 'Pi turn open with no tool or message activity for ' + minutes + ' min (heartbeat alive)',
      ...redaction, now: new Date(now) });
    if (validatePayload(payload).length) return 0;
    enqueue(dir, payload, now);
    seen[paneId] = stall.key;
    writeJson(file, seen);
    return 1;
  });
}
