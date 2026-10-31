// U3.5 Pi side of the order inbox (docs/events.md "Orders"): claim, ack, then deliver.
import { appendFileSync, readFileSync, readdirSync, renameSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir } from '../core/fsutil.js';
import { paneOrderDir, orderStateDir } from '../control/orders.js';
import { piRecordPath, envPaneId } from '../events/pi-path.js';

export const ORDER_POLL_MS = 1000;
const CLAIM_ATTEMPTS = 5;
const sleepSync = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

// 'claimed' | 'taken' (ENOENT: someone else won) | 'blocked' (EBUSY/EPERM/EACCES after retries).
export function claimOrder(file, { sleep = sleepSync, random = Math.random, rename = renameSync } = {}) {
  const target = file.replace(/\.json$/, '.claimed');
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    try { rename(file, target); return 'claimed'; } catch (err) {
      if (err.code === 'ENOENT') return 'taken';
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      sleep(20 + Math.floor(random() * 60) * (attempt + 1));
    }
  }
  return 'blocked';
}

const acked = (env, pane, id) => {
  try {
    return readFileSync(piRecordPath(env, pane), 'utf8').split('\n').some(l => {
      try { const r = JSON.parse(l); return r.name === 'order_ack' && r.order_id === id; } catch { return false; }
    });
  } catch { return false; }
};

export function registerPiOrders(pi, { env = process.env, now = Date.now, sleep = sleepSync, random = Math.random, rename = renameSync,
  setInterval: every = setInterval, clearInterval: stop = clearInterval } = {}) {
  const pane = envPaneId(env);
  let timer = null;
  const dir = () => paneOrderDir(orderStateDir(env), pane);
  const move = (from, to) => { try { renameSync(from, to); } catch {} };
  const done = (d, id) => {
    mkdirSync(join(d, 'done'), { recursive: true });
    move(join(d, id + '.claimed'), join(d, 'done', id + '.json'));
  };

  // A claim left without an ack (crash mid-order) is never re-sent: .stale.
  const recover = () => {
    const d = dir();
    let files = [];
    try { files = readdirSync(d); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.claimed')) continue;
      const id = f.slice(0, -8);
      let orderId = id;
      try { orderId = JSON.parse(readFileSync(join(d, f), 'utf8')).event_id ?? id; } catch {}
      if (acked(env, pane, orderId)) done(d, id); else move(join(d, f), join(d, id + '.stale'));
    }
  };

  const handle = (d, id) => {
    const file = join(d, id + '.json');
    const duplicateOnDisk = existsSync(join(d, 'done', id + '.json'));
    if (claimOrder(file, { sleep, random, rename }) !== 'claimed') return;
    const claimed = join(d, id + '.claimed');
    let body;
    try { body = JSON.parse(readFileSync(claimed, 'utf8')); } catch { body = null; }
    const expires = Date.parse(body?.expires_at);
    if (!body || typeof body.text !== 'string' || (Number.isFinite(expires) && now() > expires)) {
      move(claimed, join(d, id + '.stale'));
      return;
    }
    const orderId = body.event_id ?? id;
    // Ack first (received, not executed), then hand the text to Pi.
    try {
      ensurePrivateDir(join(orderStateDir(env), 'pi'));
      appendFileSync(piRecordPath(env, pane), JSON.stringify({ source: 'pi-ext', name: 'order_ack', pane_id: pane, order_id: orderId, duplicate: duplicateOnDisk }) + '\n', { mode: 0o600 });
    } catch { return; }
    if (duplicateOnDisk) { try { unlinkSync(claimed); } catch {} return; }
    try { pi.sendUserMessage(body.text, { deliverAs: 'followUp' }); } catch {}
    done(d, id);
  };

  const poll = () => {
    if (!pane) return;
    try {
      const d = dir();
      for (const f of readdirSync(d)) if (f.endsWith('.json')) handle(d, f.slice(0, -5));
    } catch { /* no inbox yet; Pi must never fail on it */ }
  };
  const clear = () => { if (timer) stop(timer); timer = null; };
  const unsubscribe = [
    pi.on('session_start', () => {
      if (!pane) return;
      clear();
      try { recover(); } catch {}
      poll();
      timer = every(poll, ORDER_POLL_MS);
      timer?.unref?.();
    }),
    pi.on('session_shutdown', clear),
  ];
  return () => { clear(); unsubscribe.forEach(fn => fn()); };
}
