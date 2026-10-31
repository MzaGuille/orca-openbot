// Pi bridge hygiene shared by doctor: which live-pane bridges have gone quiet.
// removed: livePaneIds / cleanBridges / agentPaneIds / pruneFinishedBridges, which asked Herdr
// which panes exist (plan-orca-openbot §3); a bridge's own heartbeat is the only liveness evidence.
import { envVar } from '../core/env.js';

export const BRIDGE_STALE_MS = 600000;

// OPENBOT_ORCA_BRIDGE_STALE_MS: a bare positive integer in milliseconds; anything else falls back.
export function bridgeStaleMs(env = process.env) {
  const raw = envVar(env, 'OPENBOT_ORCA_BRIDGE_STALE_MS');
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return BRIDGE_STALE_MS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : BRIDGE_STALE_MS;
}

// A bridge whose process is up but whose heartbeat is older than the threshold
// (or unreadable). A closed or dead session is not stale, it is finished.
export function bridgeIsStale(b, staleMs) {
  if (b.state !== 'alive' && b.state !== 'stale') return false;
  return b.heartbeat_age_s === null || b.heartbeat_age_s * 1000 > staleMs;
}

export const QUIET_MINUTES = 60;

// OPENBOT_ORCA_QUIET_MINUTES: a positive whole number of minutes; anything else falls back to 60.
export function quietMs(env = process.env) {
  const raw = envVar(env, 'OPENBOT_ORCA_QUIET_MINUTES');
  const minutes = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : 0;
  return (Number.isSafeInteger(minutes) && minutes > 0 ? minutes : QUIET_MINUTES) * 60000;
}

// Panes whose heartbeat is alive and whose newest enqueued event (events-full.jsonl lines) is older
// than the window, or missing. A future-dated event counts as recent.
export function quietPanes({ bridge, lines, now, windowMs }) {
  const last = new Map();
  for (const line of lines) {
    let payload;
    try { payload = JSON.parse(line); } catch { continue; }
    const at = Date.parse(payload?.ts);
    if (typeof payload?.pane_id !== 'string' || !Number.isFinite(at)) continue;
    if (!last.has(payload.pane_id) || at > last.get(payload.pane_id)) last.set(payload.pane_id, at);
  }
  return bridge.filter((b) => b.state === 'alive').flatMap((b) => {
    const at = last.get(b.pane) ?? null;
    return at !== null && now - at < windowMs ? []
      : [{ pane: b.pane, last_event_age_s: at === null ? null : Math.max(0, Math.floor((now - at) / 1000)) }];
  });
}
