// Local delivery queue: every event is persisted before sending; one flusher
// at a time uses a bounded retry budget per invocation. Retryable failures stay queued.
import { appendFileSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import {
  ensurePrivateDir, withLock, writeFileAtomic, tryCreateLock, readLockToken, removeLockIf, lockAgeMs, lockPid,
} from '../core/fsutil.js';
import { log } from './log.js';
import { appendFullEvent } from './full-log.js';

export const MAX_RETRIES = 3;
export const BACKOFF_MS = [2000, 4000, 8000];
const FLUSHER_STALE_MS = 60000;
const SAFE_REASON = /^(timeout|network error|send failed|no result|unsigned|bad_delivery_id|too_large|[A-Z][A-Z0-9_]{1,31})$/;

function deliveryReason(r) {
  const status = Number(r?.status);
  if (Number.isInteger(status) && status >= 100 && status <= 599) return 'HTTP ' + status;
  const err = String(r?.error || '').trim();
  return SAFE_REASON.test(err) ? err : 'send failed';
}

function logDelivery(dir, id, r) {
  try {
    // dropped: routes are configured, no prefix matched and there is no default (#103).
    const line = r && r.ok && r.dropped
      ? 'dropped ' + id + ' no matching route and no default webhook'
      : r && r.ok
        ? 'sent ' + id + ' HTTP ' + (r.status ?? '')
        : 'failed ' + id + ' ' + deliveryReason(r);
    log(dir, line);
  } catch {
    // logging must not break delivery
  }
}

const files = (dir) => ({
  queue: join(dir, 'queue.jsonl'),
  dead: join(dir, 'dead.jsonl'),
  lock: join(dir, 'queue.lock'),
  flusher: join(dir, 'flusher.lock'),
});

function readLines(file) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const serialize = (entries) => entries.map((e) => JSON.stringify(e) + '\n').join('');

export function enqueue(dir, payload, now = Date.now()) {
  ensurePrivateDir(dir);
  const f = files(dir);
  withLock(f.lock, () => {
    appendFileSync(f.queue, JSON.stringify({ payload, attempts: 0, next_at: now, last_error: null }) + '\n', { mode: 0o600 });
    appendFullEvent(dir, payload);
  });
}

export function queueStats(dir) {
  const f = files(dir);
  return { pending: readLines(f.queue).length, dead: readLines(f.dead).length };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The lock token starts with the flusher's pid. An old lock is only broken when
// that process is gone, and only if it is still the lock that was inspected
// (removeLockIf), so a slow live flusher is never joined by a second one.
function acquireFlusher(file, now) {
  for (let i = 0; i < 2; i += 1) {
    const token = tryCreateLock(file);
    if (token) return token;
    const seen = readLockToken(file);
    const age = lockAgeMs(file, now);
    if (seen === null) continue;
    if (age !== null && age > FLUSHER_STALE_MS && !pidAlive(lockPid(seen)) && removeLockIf(file, seen)) continue;
    return null;
  }
  return null;
}

function touch(file) {
  try {
    utimesSync(file, new Date(), new Date());
  } catch {
    // lock refresh is best effort
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

export async function flushQueue(dir, {
  send,
  now = Date.now,
  sleep = realSleep,
  jitter = () => Math.floor(Math.random() * 250),
  maxRetries = MAX_RETRIES,
  backoff = BACKOFF_MS,
} = {}) {
  ensurePrivateDir(dir);
  const f = files(dir);
  const token = acquireFlusher(f.flusher, Date.now());
  if (token === null) return { skipped: 'flusher already running' };
  let sent = 0;
  let dead = 0;
  let dropped = 0;
  const attemptsThisRun = new Map();
  const exhausted = new Set();
  try {
    for (;;) {
      const entries = withLock(f.lock, () => readLines(f.queue))
        .filter(e => !exhausted.has(e.payload.event_id));
      if (entries.length === 0) break;
      const t = now();
      const due = entries.filter((e) => e.next_at <= t);
      if (due.length === 0) {
        touch(f.flusher);
        await sleep(Math.min(...entries.map((e) => e.next_at)) - t);
        continue;
      }
      const results = new Map();
      for (const entry of due) {
        let r;
        touch(f.flusher);
        try {
          r = await send(entry.payload);
        } catch (err) {
          r = { ok: false, retryable: true, error: err?.name || 'send failed' };
        }
        const id = entry.payload.event_id;
        attemptsThisRun.set(id, (attemptsThisRun.get(id) || 0) + 1);
        results.set(id, r || { ok: false, retryable: true, error: 'no result' });
        logDelivery(dir, id, r);
      }
      withLock(f.lock, () => {
        const keep = [];
        const buried = [];
        for (const entry of readLines(f.queue)) {
          const r = results.get(entry.payload.event_id);
          if (!r) {
            keep.push(entry);
          } else if (r.ok && r.dropped) {
            dropped += 1;
          } else if (r.ok) {
            sent += 1;
          } else {
            entry.attempts += 1;
            entry.last_error = r.error || (r.status ? 'HTTP ' + r.status : 'failed');
            // dead: never deliverable as is (e.g. bad_delivery_id, too_large, 400/401/403/404/413).
            // hold: wait for a later run (e.g. unsigned). 408, 429, 5xx and network errors stay queued.
            if (r.dead === true || (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429)) {
              // status (HTTP code or null) and dead_at (epoch ms) let doctor read the cause offline.
              buried.push({ ...entry, status: Number.isInteger(r.status) ? r.status : null, dead_at: now() });
              dead += 1;
            } else {
              entry.next_at = now() + backoff[Math.min(entry.attempts, backoff.length) - 1] + jitter();
              if (r.hold === true || attemptsThisRun.get(entry.payload.event_id) > maxRetries) exhausted.add(entry.payload.event_id);
              keep.push(entry);
            }
          }
        }
        writeFileAtomic(f.queue, serialize(keep));
        if (buried.length) appendFileSync(f.dead, serialize(buried), { mode: 0o600 });
      });
    }
    return { sent, dead, pending: readLines(f.queue).length, ...(dropped ? { dropped } : {}) };
  } finally {
    removeLockIf(f.flusher, token);
  }
}
