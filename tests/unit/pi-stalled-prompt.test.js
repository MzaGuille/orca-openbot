import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp, put } from '../helpers/tmp.js';
import { writeBridgeLines } from '../helpers/bridge.js';
import { fakeSecret } from '../helpers/secret.js';
import { runIngest } from '../../events/ingest.js';
import { registerPiAttention } from '../../pi/runtime.js';
import { registerPiBridge } from '../../pi/bridge.js';
import { bridgePanePath } from '../../events/pi-bridge.js';
import { piRecordPath } from '../../events/pi-path.js';
import { validatePayload } from '../../events/payload.js';

const SESSION = 'sess-1', PANE = 'orca:' + SESSION, CWD = '/work/orca-demo';
const T0 = Date.UTC(2026, 9, 31, 12), MIN = 60000;

function setup(t) {
  const dir = makeTmp(t), state = join(dir, 'state');
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, OPENBOT_ORCA_STATE_DIR: state,
    OPENBOT_ORCA_CONFIG_FILE: join(dir, 'missing'), OPENBOT_ORCA_WEBHOOK_SECRET: fakeSecret('t'),
    OPENBOT_ORCA_WEBHOOK_URL: 'http://127.0.0.1:9/hook', ORCA_AGENT_SESSION_ID: SESSION };
  delete env.OPENBOT_ORCA_STALLED_MINUTES; delete env.OPENBOT_HERDR_STALLED_MINUTES;
  const queued = () => {
    try { return readFileSync(join(state, 'queue.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).payload); }
    catch { return []; }
  };
  return { dir, state, env, queued, ingest: now => runIngest({ paneId: PANE, env, now, spawnFlusher: () => {} }) };
}

// The real attention and bridge writers on one fake Pi, sharing a clock that ticks 1 ms per read
// (attention registers first, so its record is stamped just before the bridge event).
function livePi(s) {
  const handlers = {};
  let clock = T0;
  const now = () => clock++;
  const pi = { on: (name, fn) => { (handlers[name] ??= []).push(fn); return () => {}; } };
  registerPiAttention(pi, { env: s.env, now, spawnIngest: () => {} });
  registerPiBridge(pi, { env: s.env, now, pid: process.pid, spawnIngest: () => {},
    setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  const ctx = { cwd: CWD, sessionManager: { getSessionId: () => 'session-a' } };
  return { emit: (type, event = {}) => { for (const fn of handlers[type] ?? []) fn({ type, ...event }, ctx); } };
}

const PROMPT = { kind: 'confirm', title: 'Run rm -rf build?' };

test('a) a confirm prompt with the turn open is written to the bridge, comes out blocked and is not discarded', t => {
  const s = setup(t), pi = livePi(s);
  pi.emit('session_start');
  pi.emit('agent_start');
  pi.emit('ui_prompt_start', PROMPT);
  const bridge = readFileSync(bridgePanePath(s.env, PANE), 'utf8').trim().split('\n').map(JSON.parse);
  const written = bridge.find(e => e.type === 'ui_prompt_start');
  assert.equal(written?.detail.kind, 'confirm');
  assert.equal(written?.detail.title, PROMPT.title);
  assert.deepEqual(s.ingest(T0 + 1000), { ok: true, processed: 2, queued: 1 });
  const [payload] = s.queued();
  assert.equal(payload.attention_kind, 'blocked');
  assert.equal(payload.state, 'blocked');
  assert.deepEqual(validatePayload(payload), []);
});

test('b) the same prompt with the turn closed still produces no alert', t => {
  const s = setup(t), pi = livePi(s);
  pi.emit('session_start');
  pi.emit('agent_start');
  pi.emit('agent_settled', { aborted: false });
  s.ingest(T0 + 1000);
  const before = s.queued().length;
  pi.emit('ui_prompt_start', PROMPT);
  pi.emit('ui_prompt_end', PROMPT);
  assert.deepEqual(s.ingest(T0 + 2000), { ok: true, processed: 3, queued: 0 });
  assert.equal(s.queued().length, before);
  assert.deepEqual(s.queued().filter(p => p.attention_kind === 'blocked'), []);
});

test('c) a turn open for 15 min with only heartbeats enqueues stalled; a tool_start in between does not', t => {
  const at = min => new Date(T0 + min * MIN).toISOString();
  // A bridge with a turn opened at minute 0 and a heartbeat every 2 min up to `heartbeatsUntil`.
  const bridge = (s, middle, heartbeatsUntil) => {
    const beats = [];
    for (let m = 2; m <= heartbeatsUntil; m += 2) beats.push({ schema_version: 1, type: 'heartbeat', session_id: 's1', pid: process.pid, ts: at(m) });
    writeBridgeLines(s.state, PANE, [
      { schema_version: 1, type: 'session_start', session_id: 's1', pid: process.pid, ts: at(0) },
      { schema_version: 1, type: 'turn_start', ts: at(0), detail: { turn_index: 0 } },
      ...middle, ...beats,
    ]);
  };
  const tool = (type, minute, id = 'call-1') => ({ schema_version: 1, type, ts: at(minute), detail: { tool_call_id: id, tool_name: 'bash' } });

  // Only heartbeats: stalled at exactly 15 min, once per episode.
  const idle = setup(t);
  put(piRecordPath(idle.env, PANE), JSON.stringify({ source: 'pi-ext', name: 'tool_execution_end', isError: false, pane_id: PANE, cwd: CWD }) + '\n');
  bridge(idle, [], 15);
  assert.equal(idle.ingest(T0 + 15 * MIN).queued, 1);
  const [stalled] = idle.queued();
  assert.equal(stalled.attention_kind, 'stalled');
  assert.equal(stalled.state, 'blocked');
  assert.equal(stalled.pane_id, PANE);
  assert.equal(stalled.workspace_name, 'orca-demo');
  assert.deepEqual(validatePayload(stalled), []);
  assert.equal(idle.ingest(T0 + 17 * MIN).queued, 0);
  assert.equal(idle.queued().length, 1);

  // Not yet 15 min since the last activity.
  const early = setup(t);
  bridge(early, [], 14);
  assert.equal(early.ingest(T0 + 14 * MIN).queued, 0);

  // A finished tool 6 min ago is recent activity.
  const recent = setup(t);
  bridge(recent, [tool('tool_start', 10), tool('tool_end', 10)], 16);
  assert.equal(recent.ingest(T0 + 16 * MIN).queued, 0);

  // A tool_start that is still running is never stalled, however old.
  const running = setup(t);
  bridge(running, [tool('tool_start', 1)], 40);
  assert.equal(running.ingest(T0 + 40 * MIN).queued, 0);
  assert.deepEqual(running.queued(), []);
});
