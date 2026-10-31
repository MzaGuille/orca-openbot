import { mkdirSync, readFileSync, readdirSync, renameSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeBridgeLines } from './bridge.js';
import { piRecordPath } from '../../events/pi-path.js';
import { paneOrderDir } from '../../control/orders.js';

export const PANE = 'orca:test';

export function liveBridge(stateDir, pane = PANE) {
  const ts = new Date().toISOString();
  writeBridgeLines(stateDir, pane, [
    { schema_version: 1, type: 'session_start', session_id: 's1', pid: process.pid, ts },
    { schema_version: 1, type: 'heartbeat', session_id: 's1', pid: process.pid, ts },
  ]);
}

export const ordersDir = (stateDir, pane = PANE) => paneOrderDir(stateDir, pane);

// Fake extension: claims by atomic rename, acks into pane-<b64>.jsonl, moves to done/.
export function fakeExtension(stateDir, pane = PANE) {
  const env = { OPENBOT_ORCA_STATE_DIR: stateDir };
  const seen = new Set();
  const delivered = [];
  return {
    delivered,
    claim(id) {
      const dir = ordersDir(stateDir, pane);
      try { renameSync(join(dir, id + '.json'), join(dir, id + '.claimed')); } catch { return false; }
      return true;
    },
    ack(id) {
      const dir = ordersDir(stateDir, pane);
      const duplicate = seen.has(id);
      if (!duplicate) { seen.add(id); delivered.push(id); }
      appendFileSync(piRecordPath(env, pane), JSON.stringify({ source: 'pi-ext', name: 'order_ack', pane_id: pane, order_id: id, duplicate }) + '\n');
      mkdirSync(join(dir, 'done'), { recursive: true });
      try { renameSync(join(dir, id + '.claimed'), join(dir, 'done', id + '.json')); } catch { /* already moved */ }
    },
    // One poll step: claim every pending order; an expired one is renamed .stale
    // without an ack or delivery, any other is acked.
    poll(now = Date.now()) {
      const dir = ordersDir(stateDir, pane);
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -5);
        if (!this.claim(id)) continue;
        let body = {};
        try { body = JSON.parse(readFileSync(join(dir, id + '.claimed'), 'utf8')); } catch { /* unreadable */ }
        const expires = Date.parse(body.expires_at);
        if (Number.isFinite(expires) && now > expires) renameSync(join(dir, id + '.claimed'), join(dir, id + '.stale'));
        else this.ack(id);
      }
    },
  };
}
export const readOrder = (stateDir, id, pane = PANE) => JSON.parse(readFileSync(join(ordersDir(stateDir, pane), id + '.json'), 'utf8'));
