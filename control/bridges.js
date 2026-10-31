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
