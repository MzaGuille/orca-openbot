// Pi bridge writer (#11 U1): lifecycle events and a heartbeat, one append per event.
import { appendFileSync, statSync, renameSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { ensurePrivateDir } from '../core/fsutil.js';
import { bridgePanePath, SCHEMA_VERSION } from '../events/pi-bridge.js';
import { sanitizeAttentionRecord } from '../events/sanitize.js';
import { envPaneId } from '../events/pi-path.js';
import { nextPendingConsent } from '../events/consent.js';
import { trailingQuestion } from './question-text.js';
import { spawnIngest as defaultSpawnIngest } from './runtime.js';

export const HEARTBEAT_MS = 2 * 60 * 1000;
export const MAX_LINE_BYTES = 4096;
export const MAX_FILE_BYTES = 1024 * 1024;

const toLine = event => {
  const line = JSON.stringify(event) + '\n';
  return Buffer.byteLength(line) < MAX_LINE_BYTES ? line : JSON.stringify({ ...event, detail: { truncated: true } }) + '\n';
};

/** One append (< 4 KB, atomic with O_APPEND / FILE_APPEND_DATA); rotate to `.1` past the cap.
 * After a rotation this writer re-appends `carry` (its session_start) so readers keep it.
 * Returns false instead of throwing: Pi must never fail or block on the bridge. */
export function appendBridgeEvent(file, event, { maxBytes = MAX_FILE_BYTES, carry = null } = {}) {
  try {
    const line = toLine(event);
    ensurePrivateDir(dirname(file));
    let size = 0;
    try { size = statSync(file).size; } catch {}
    if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
      // A concurrent writer may have rotated already or hold the file (Windows); append anyway.
      try {
        // Carry the latest session_start from shared storage, not the rotating
        // process's local started, so an older overlapping process cannot
        // reinsert a stale session_start after a newer one was moved to .1.
        let carried = carry, heartbeat = null;
        try {
          const raw = readFileSync(file, 'utf8');
          const lines = raw.split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const ev = JSON.parse(lines[i]);
              if (ev && ev.type === 'heartbeat' && !heartbeat) heartbeat = ev;
              if (ev && ev.type === 'session_start') { carried = ev; break; }
            } catch {}
          }
        } catch {}
        renameSync(file, file + '.1');
        if (carried) appendFileSync(file, toLine({ ...carried, event_id: randomUUID() }), { mode: 0o600 });
        // The latest heartbeat would otherwise stay only in .1; re-write it with a fresh identity.
        if (heartbeat && event.type !== 'heartbeat') appendFileSync(file, toLine({ ...heartbeat, event_id: randomUUID() }), { mode: 0o600 });
      } catch {}
    }
    appendFileSync(file, line, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function registerPiBridge(pi, { env = process.env, now = Date.now, pid = process.pid, spawnIngest = defaultSpawnIngest,
  setInterval: every = setInterval, clearInterval: stop = clearInterval } = {}) {
  const pane = envPaneId(env);
  let sessionId = null, timer = null, started = null;
  let runOpen = false, outcome = null, retry = null, stopReason = null, pendingQuestion = null, pendingConsent = null;
  const write = (type, detail = { session_id: sessionId, pid }) => {
    if (!pane) return;
    try {
      const event = { schema_version: SCHEMA_VERSION, event_id: randomUUID(),
        ts: new Date(now()).toISOString(), pane, type, state: 'idle', detail: sanitizeAttentionRecord(detail) };
      const carry = type === 'session_start' ? null : started;
      if (type === 'session_start') started = event;
      appendBridgeEvent(bridgePanePath(env, pane), event, { carry });
    } catch {}
  };
  const clear = () => { if (timer) stop(timer); timer = null; };
  const sessionOf = ctx => { try { return ctx?.sessionManager?.getSessionId?.() ?? sessionId; } catch { return sessionId; } };
  const unsubscribe = [
    pi.on('session_start', (_event, ctx) => {
      if (!pane) return;
      clear();
      sessionId = sessionOf(ctx);
      runOpen = false; outcome = null; retry = null; pendingQuestion = null; pendingConsent = null;
      write('session_start');
      // Ingest only runs when Pi appends a record, so a silent turn is evaluated on the heartbeat (stalled).
      timer = every(() => {
        write('heartbeat');
        if (runOpen) { try { spawnIngest(env, pane); } catch {} }
      }, HEARTBEAT_MS);
      timer?.unref?.();
    }),
    pi.on('session_shutdown', (_event, ctx) => {
      if (!pane) return;
      clear();
      sessionId = sessionOf(ctx);
      runOpen = false; outcome = null; retry = null; pendingQuestion = null; pendingConsent = null;
      write('session_shutdown');
    }),
    pi.on('tool_execution_end', event => {
      pendingConsent = nextPendingConsent(pendingConsent, event);
      write('tool_end', { tool_call_id: event.toolCallId ?? null, tool_name: event.toolName ?? null,
        is_error: event.isError === true, duration_ms: event.durationMs ?? null });
    }),
    pi.on('agent_start', () => {
      // An agent_start inside an open turn must not drop the question already captured.
      if (!runOpen) { pendingQuestion = null; pendingConsent = null; }
      runOpen = true; outcome = null; stopReason = null;
    }),
    pi.on('turn_start', event => {
      write('turn_start', { turn_index: Number.isInteger(event.turnIndex) ? event.turnIndex : null,
        timestamp: Number.isFinite(event.timestamp) ? event.timestamp : null });
    }),
    pi.on('tool_execution_start', event => {
      write('tool_start', { tool_call_id: event.toolCallId ?? null, tool_name: event.toolName ?? null,
        parent_tool_call_id: event.parentToolCallId ?? null });
    }),
    pi.on('ui_prompt_start', event => {
      // turn_open: the prompt appeared inside a running turn, whatever the turn events say yet.
      write('ui_prompt_start', { kind: event.kind ?? null, title: event.title || '', turn_open: runOpen });
    }),
    pi.on('ui_prompt_end', event => {
      write('ui_prompt_end', { kind: event.kind ?? null, title: event.title || '' });
    }),
    pi.on('message_end', event => {
      write('message_end', { role: event.message?.role ?? null,
        stop_reason: typeof event.message?.stopReason === 'string' ? event.message.stopReason : null });
      if (event.message?.role !== 'assistant') return;
      if (typeof event.message.stopReason === 'string') stopReason = event.message.stopReason;
      pendingQuestion = trailingQuestion(event.message);
    }),
    pi.on('session_compact_failed', event => {
      write('compact_failed', { reason: event.reason ?? null, aborted: event.aborted === true, will_retry: event.willRetry === true });
    }),
    pi.on('agent_before_settle', event => {
      if (['completed', 'error', 'aborted'].includes(event.outcome)) outcome = event.outcome;
    }),
    pi.on('agent_settled', event => {
      const settledOutcome = event.aborted === true ? 'aborted' : outcome ?? 'completed';
      write('done', { outcome: settledOutcome, stop_reason: stopReason,
        ...(event.aborted !== true && pendingQuestion ? { question: pendingQuestion } : {}),
        ...(settledOutcome === 'completed' && pendingConsent ? { consent: pendingConsent } : {}) });
      runOpen = false; outcome = null; retry = null; stopReason = null; pendingQuestion = null; pendingConsent = null;
    }),
    pi.on('after_provider_response', event => {
      if (!runOpen) return;
      const status = event.status;
      if (Number.isInteger(status) && status >= 200 && status < 300) { retry = null; return; }
      if (status !== 429 && !(Number.isInteger(status) && status >= 500 && status < 600)) return;
      retry ??= { streakId: randomUUID(), attempt: 0 };
      write('retrying', { status, attempt: ++retry.attempt, streak_id: retry.streakId });
    }),
  ];
  return () => { clear(); unsubscribe.forEach(fn => fn()); };
}
