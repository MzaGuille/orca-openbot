// 120 s debounce per (pane, state), shared by every hook process via the state dir.
import { join } from 'node:path';
import { readJson, writeJson, withLock } from '../core/fsutil.js';

export const DEBOUNCE_MS = 120000;

// A record is a timestamp, or { at, event_id } when admission already knows the winner.
// Readers must keep treating a bare number as a timestamp.
export function debounceAt(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.at === 'number') return value.at;
  return null;
}

export function debounceWinnerId(value) {
  return value && typeof value === 'object' && typeof value.event_id === 'string' ? value.event_id : null;
}

function pruneDebounce(store, now, windowMs) {
  for (const [key, value] of Object.entries(store)) {
    const ts = debounceAt(value);
    if (ts === null || now - ts >= windowMs || ts > now) delete store[key];
  }
}

export function checkAndRecord(store, paneId, state, now, windowMs = DEBOUNCE_MS) {
  const key = paneId + '|' + state;
  const last = debounceAt(store[key]);
  if (typeof last === 'number' && now >= last && now - last < windowMs) return false;
  store[key] = now;
  return true;
}

// eventId, when admission already knows the winner, is written in the same
// locked update as the stamp. A later write would release the lock first, and
// ingest in that window would see a number-only record.
export function debounce(stateDir, paneId, state, now = Date.now(), windowMs = DEBOUNCE_MS, eventId = null) {
  return withLock(join(stateDir, 'debounce.lock'), () => {
    const file = join(stateDir, 'debounce.json');
    const store = readJson(file, {});
    pruneDebounce(store, now, windowMs);
    const send = checkAndRecord(store, paneId, state, now, windowMs);
    if (send && typeof eventId === 'string' && eventId) {
      store[paneId + '|' + state] = { at: now, event_id: eventId };
    }
    writeJson(file, store);
    return send;
  });
}

// Carry old per-pane signatures without renewing their suppression window.
export function migratePaneDebounce(stateDir, nativeId, trackedId) {
  if (nativeId === trackedId) return;
  return withLock(join(stateDir, 'debounce.lock'), () => {
    const file = join(stateDir, 'debounce.json'), store = readJson(file, {});
    const prefix = nativeId + '|';
    for (const key of Object.keys(store)) {
      if (!key.startsWith(prefix)) continue;
      const signature = key.slice(prefix.length);
      if (!/^[^|]+(?:\|[a-f0-9]{64})?$/.test(signature)) continue;
      const target = trackedId + '|' + signature, ts = debounceAt(store[key]), targetAt = debounceAt(store[target]);
      if (Number.isFinite(ts) && (!Number.isFinite(targetAt) || ts > targetAt)) store[target] = store[key];
      delete store[key];
    }
    writeJson(file, store);
  });
}
