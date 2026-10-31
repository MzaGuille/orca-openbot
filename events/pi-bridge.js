// Pi bridge contract (#11, schema_version 1): state paths and a pure reader shared with `doctor`.
import { readFileSync } from 'node:fs';
import { defaultStateDir } from '../core/fsutil.js';
import { piBridgePath } from './pi-path.js';

export const SCHEMA_VERSION = 1;
const KNOWN = new Set(['session_start', 'heartbeat', 'session_shutdown', 'tool_end', 'done', 'retrying',
  'turn_start', 'tool_start', 'compact_failed']);

/** Complete known records, in last-occurrence order. Retry updates group by streak_id;
 * legacy records fall back to event_id. Unknown versions/fields are tolerated. */
export function readBridgeEvents(text) {
  const records = new Map();
  const input = String(text);
  const complete = input.slice(0, input.lastIndexOf('\n') + 1);
  for (const raw of complete.split('\n')) {
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (!event || typeof event !== 'object' || !KNOWN.has(event.type)) continue;
    const streak = event.type === 'retrying' ? event.detail?.streak_id : null;
    const key = typeof streak === 'string' && streak ? 'streak:' + streak
      : typeof event.event_id === 'string' && event.event_id ? 'event:' + event.event_id : Symbol();
    records.delete(key);
    records.set(key, event);
  }
  return [...records.values()];
}

// The plugin state dir (OPENBOT_ORCA_STATE_DIR contract), so writer and doctor resolve one path.
export function bridgeStateDir(env = process.env) {
  return defaultStateDir(env);
}

// Next to the Pi attention records, in its own `.bridge.jsonl` file.
export function bridgePanePath(env, paneId) {
  return piBridgePath(env, paneId);
}

/** Last session_start, last heartbeat and whether that session shut down normally
 * (a heartbeat or shutdown counts only when its session_id and pid match the last start).
 * Feed rotated content first (`<file>.1` + `<file>`). */
export function readBridge(text) {
  let start = null, heartbeat = null, shutdown = null;
  for (const event of readBridgeEvents(text)) {
    if (event.type === 'session_start') { start = event; heartbeat = null; shutdown = null; }
    else if (!['heartbeat', 'session_shutdown'].includes(event.type)) continue;
    // Missing identities are unknown, not two equal undefined values.
    else if (!start || typeof start.detail?.session_id !== 'string' || !start.detail.session_id
      || !Number.isSafeInteger(start.detail?.pid) || start.detail.pid <= 0
      || event.detail?.session_id !== start.detail.session_id
      || event.detail?.pid !== start.detail?.pid) continue;
    else if (event.type === 'heartbeat') heartbeat = event;
    else shutdown = event;
  }
  return { start, heartbeat, closed: Boolean(shutdown) };
}

export function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export const STALE_SECONDS = 600;

/** Whole seconds since the last heartbeat (or session_start); null when the ts is missing,
 * unparseable or in the future. */
export function heartbeatAgeSeconds(summary, now = Date.now()) {
  const ts = (summary.heartbeat ?? summary.start)?.ts;
  const at = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now) return null;
  return Math.floor((now - at) / 1000);
}

/** none | closed | dead | stale | alive. A live pid is alive only with a heartbeat younger than
 * 600 s; an older or unknown (future/invalid ts) age is stale, since the pid may be reused. */
export function bridgeLiveness(summary, isAlive = pidAlive, now = Date.now()) {
  if (!summary.start) return 'none';
  if (summary.closed) return 'closed';
  if (!isAlive(summary.heartbeat?.detail?.pid ?? summary.start.detail?.pid)) return 'dead';
  const age = heartbeatAgeSeconds(summary, now);
  return age !== null && age < STALE_SECONDS ? 'alive' : 'stale';
}

const TURN_EVENTS = new Set(['turn_start', 'tool_start', 'tool_end', 'retrying']);

/** Pi turn state from bridge text, as of `at` (epoch ms; default: everything). `open` is true
 * from a turn/tool event until the next `done`; false in a fresh session and after a `done`; null
 * while unknown (no session_start in the bridge). `doneId` is the event_id of the last
 * `done`: one settled Pi turn. */
export function readBridgeTurn(text, at = Infinity) {
  let open = null, doneId = null, doneQuestion = null, session = null;
  for (const event of readBridgeEvents(text)) {
    const ts = Date.parse(event.ts);
    if (Number.isFinite(ts) && ts > at) continue;
    if (event.type === 'session_start') {
      // Rotation re-writes the same session_start; only another session resets.
      const id = event.detail?.session_id + ':' + event.detail?.pid;
      if (id !== session) { open = false; doneId = null; doneQuestion = null; }
      session = id;
    } else if (event.type === 'done') {
      open = false;
      doneId = typeof event.event_id === 'string' && event.event_id ? event.event_id : null;
      // Optional since schema 1: older done records carry no question and read as null.
      doneQuestion = typeof event.detail?.question === 'string' && event.detail.question ? event.detail.question : null;
    } else if (TURN_EVENTS.has(event.type)) open = true;
  }
  return { open, doneId, doneQuestion };
}

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

/** `readBridgeTurn` over a pane's rotated + current bridge files (unknown without a bridge). */
export function paneBridgeTurn(env, paneId, at) {
  const file = bridgePanePath(env, paneId);
  return readBridgeTurn(readText(file + '.1') + readText(file), Number.isFinite(at) ? at : Infinity);
}

/** A Pi menu shown while no turn is running (new session, or the bridge saw the turn settle)
 * is a user command's picker such as /gentle:profiles, never a question from the agent. */
export const piMenuOutsideTurn = (env, paneId, at) => paneBridgeTurn(env, paneId, at).open === false;
