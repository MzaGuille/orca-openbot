// U3.5 orders: the CLI side of the Pi order inbox (docs/events.md "Orders").
import { openSync, readSync, closeSync, statSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { defaultStateDir, ensurePrivateDir, writeFileAtomic } from '../core/fsutil.js';
import { piRecordPath } from '../events/pi-path.js';
import { envVar } from '../core/env.js';

export const ORDER_SCHEMA_VERSION = 1;
export const DEFAULT_ACK_MS = 20000;
const ACK_POLL_MS = 100;
const CANCEL_ATTEMPTS = 5;
export const ORDER_STALE_MS = 60_000;
export const ORDER_KEEP_MS = 24 * 3600 * 1000;

export const orderStateDir = (env) => defaultStateDir(env);
export const ordersRoot = (stateDir) => join(stateDir, 'pi', 'orders');
// Same reversible pane encoding as the pane-<b64>.jsonl files.
export const decodePane = (name) => Buffer.from(name, 'base64url').toString('utf8');
export const encodePane = (paneId) => Buffer.from(paneId).toString('base64url');
export const paneOrderDir = (stateDir, paneId) => join(ordersRoot(stateDir), 'pane-' + encodePane(paneId));
const safeId = (id) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_');

// Never carries a token: only the fields of the contract.
export function writeOrder(stateDir, { paneId, eventId, text, now = Date.now(), ackWindowMs = DEFAULT_ACK_MS, source = 'orca-openbot' }) {
  const dir = ensurePrivateDir(paneOrderDir(stateDir, paneId));
  const file = join(dir, safeId(eventId) + '.json');
  writeFileAtomic(file, JSON.stringify({
    schema_version: ORDER_SCHEMA_VERSION, event_id: eventId, ts: new Date(now).toISOString(), expires_at: new Date(now + ackWindowMs).toISOString(), pane: paneId, text, source,
  }));
  return file;
}

export function ackMs(env) {
  const raw = String(envVar(env, 'OPENBOT_ORCA_ORDER_ACK_MS') ?? '').trim();
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : DEFAULT_ACK_MS;
}

export function recordSize(env, paneId) {
  try { return statSync(piRecordPath(env, paneId)).size; } catch { return 0; }
}

// Complete lines appended after `offset` only; the attention file is append-only.
export function findAck(env, paneId, eventId, offset) {
  let text = '';
  try {
    const file = piRecordPath(env, paneId);
    const size = statSync(file).size;
    const start = offset <= size ? offset : 0;
    const buf = Buffer.alloc(size - start);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  text = text.slice(0, text.lastIndexOf('\n') + 1);
  for (const line of text.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r && (r.name === 'order_ack' || r.type === 'order_ack') && r.order_id === eventId) return { duplicate: r.duplicate === true };
  }
  return null;
}

export function waitForAck(env, paneId, eventId, offset, { timeoutMs, now, sleep }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const ack = findAck(env, paneId, eventId, offset);
    if (ack) return ack;
    if (now() >= deadline) return null;
    sleep(ACK_POLL_MS);
  }
}

// removed: herdrAlreadySent / markHerdrSent, the Herdr-keystroke fallback record (plan-orca-openbot §2).

// Rename .json -> .cancelled. 'cancelled' | 'taken' (ENOENT: the extension claimed it)
// | 'blocked' (EPERM/EBUSY/EACCES after bounded jittered retries).
export function cancelOrder(file, { sleep, random = Math.random, beforeRename = null, rename = renameSync }) {
  const target = file.replace(/\.json$/, '.cancelled');
  for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt += 1) {
    // Tests claim the order here, between the last check and the rename.
    if (typeof beforeRename === 'function') beforeRename(file);
    try {
      rename(file, target);
      return 'cancelled';
    } catch (err) {
      if (err.code === 'ENOENT') return 'taken';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleep(20 + Math.floor(random() * 60) * (attempt + 1));
    }
  }
  return 'blocked';
}

const paneDirs = (stateDir) => {
  try { return readdirSync(ordersRoot(stateDir)).filter((n) => n.startsWith('pane-')); } catch { return []; }
};

// Orders pending or claimed longer than 60 s, and any the extension marked stale
// (claimed at startup without an ack), per pane.
export function listOrderProblems(stateDir, now = Date.now()) {
  const out = [];
  for (const name of paneDirs(stateDir)) {
    const dir = join(ordersRoot(stateDir), name);
    let files = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      const state = f.endsWith('.json') ? 'pending' : f.endsWith('.claimed') ? 'claimed' : f.endsWith('.stale') ? 'stale' : null;
      if (!state) continue;
      let mtime;
      try { mtime = statSync(join(dir, f)).mtimeMs; } catch { continue; }
      const age = now - mtime;
      if (state === 'stale' || age > ORDER_STALE_MS) {
        out.push({ pane: decodePane(name.slice('pane-'.length)), event_id: f.replace(/\.[^.]+$/, ''), state, age_s: Math.max(0, Math.floor(age / 1000)) });
      }
    }
  }
  return out;
}

// done/ entries and *.cancelled files older than 24 h.
export function cleanupOrders(stateDir, now = Date.now()) {
  let removed = 0;
  const drop = (path) => {
    try {
      if (now - statSync(path).mtimeMs <= ORDER_KEEP_MS) return;
      unlinkSync(path);
      removed += 1;
    } catch { /* raced with the extension */ }
  };
  for (const name of paneDirs(stateDir)) {
    const dir = join(ordersRoot(stateDir), name);
    try { for (const f of readdirSync(dir)) if (f.endsWith('.cancelled')) drop(join(dir, f)); } catch { /* gone */ }
    try { for (const f of readdirSync(join(dir, 'done'))) drop(join(dir, 'done', f)); } catch { /* none */ }
  }
  return removed;
}
