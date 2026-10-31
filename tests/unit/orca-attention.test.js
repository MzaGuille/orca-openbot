import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { makeTmp, put } from '../helpers/tmp.js';
import { startMockWebhook } from '../helpers/mock-webhook.js';
import { runIngest } from '../../events/ingest.js';
import { runFlush } from '../../events/flush.js';
import { piRecordPath } from '../../events/pi-path.js';
import { registerPiAttention } from '../../pi/runtime.js';
import { registerPiBridge } from '../../pi/bridge.js';
import { registerPiOrders } from '../../pi/orders.js';
import { bridgePanePath } from '../../events/pi-bridge.js';
import { paneOrderDir } from '../../control/orders.js';
import { validatePayload } from '../../events/payload.js';
import { sendToPane } from '../../control/send.js';
import { fakeSecret } from '../helpers/secret.js';

const PANE = 'orca:sess-1', CWD = '/work/orca-demo';

function setup(t, receiver) {
  const dir = makeTmp(t), state = join(dir, 'state'), calls = [];
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, OPENBOT_ORCA_STATE_DIR: state,
    OPENBOT_ORCA_CONFIG_FILE: join(dir, 'missing'), OPENBOT_ORCA_WEBHOOK_SECRET: fakeSecret('t'),
    OPENBOT_ORCA_WEBHOOK_URL: receiver?.url };
  const run = args => { calls.push(args); return { ok: false, stdout: '', stderr: 'no external command may run' }; };
  const file = piRecordPath(env, PANE);
  const record = data => ({ source: 'pi-ext', pane_id: PANE, session_id: 'a', cwd: CWD, ...data });
  return { state, env, calls, run,
    write: records => put(file, records.map(r => JSON.stringify(record(r))).join('\n') + '\n'),
    ingest: () => runIngest({ paneId: PANE, env, now: 1000, spawnFlusher: () => {} }) };
}

test('a) agent_settled becomes one done payload with workspace_name = basename(cwd)', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([{ name: 'agent_settled', hadError: false, aborted: false }]);
  assert.deepEqual(s.ingest(), { ok: true, processed: 1, queued: 1 });
  await runFlush({ env: s.env });
  assert.equal(receiver.requests.length, 1);
  const p = receiver.requests[0].json;
  assert.equal(p.attention_kind, 'done');
  assert.equal(p.pane_id, PANE);
  assert.equal(p.workspace_id, 'orca');
  assert.equal(p.workspace_name, basename(CWD));
  assert.equal(p.cwd, CWD);
  assert.equal(p.agent, 'pi');
  assert.equal(p.next_hint.read, 'orca-ide worktree ps --json');
  assert.deepEqual(validatePayload(p), []);
  assert.deepEqual(s.calls, []);
});

test('b) ui_prompt_start select with a title becomes a question', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([{ name: 'ui_prompt_start', kind: 'select', title: 'Choose next step?' }]);
  assert.equal(s.ingest().queued, 1);
  await runFlush({ env: s.env });
  const p = receiver.requests[0].json;
  assert.equal(p.attention_kind, 'question');
  assert.equal(p.pane_id, PANE);
  assert.match(p.question.text, /Choose next step\?/);
  assert.equal(p.workspace_name, basename(CWD));
  assert.deepEqual(validatePayload(p), []);
  assert.deepEqual(s.calls, []);
});

test('c) agent_settled with a free-text question becomes a question with options []', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([{ name: 'agent_settled', hadError: false, aborted: false, question: '¿Seguimos con A o con B?' }]);
  assert.equal(s.ingest().queued, 1);
  await runFlush({ env: s.env });
  const p = receiver.requests[0].json;
  assert.equal(p.attention_kind, 'question');
  assert.deepEqual(p.question.options, []);
  assert.equal(p.question.text, '¿Seguimos con A o con B?');
  assert.equal(p.next_hint.reply, 'orca-openbot send --pane ' + PANE + ' --text "<answer>"');
  assert.equal(p.next_hint.read, 'orca-ide worktree ps --json');
  assert.deepEqual(validatePayload(p), []);
});

test('d) runIngest runs no external command for an orca pane', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([{ name: 'ui_prompt_start', kind: 'select', title: 'Pick one' },
    { name: 'agent_settled', hadError: false, aborted: false },
    { name: 'agent_settled', hadError: true, aborted: false, msg: 'Worker failed' }]);
  s.ingest();
  assert.deepEqual(s.calls, []);
});

test('e) send to an orca pane without a live bridge fails clearly', t => {
  const s = setup(t, null);
  assert.throws(() => sendToPane({ paneId: 'orca:x', text: 'hola', eventId: 'ev-1', env: s.env, sleep: () => {} }),
    /orca pane needs the Pi extension/);
  assert.deepEqual(s.calls, []);
});

test('1) the extension derives pane orca:<session> from ORCA_AGENT_SESSION_ID', t => {
  const dir = makeTmp(t), handlers = {}, calls = [];
  const env = { OPENBOT_ORCA_STATE_DIR: join(dir, 'state'), ORCA_AGENT_SESSION_ID: 'abc', ORCA_STRUCTURED_SESSION: '1' };
  const pi = { on: (name, fn) => { handlers[name] = fn; return () => {}; } };
  registerPiAttention(pi, { env, now: () => 1234, spawnIngest: (...a) => calls.push(a) });
  const ctx = { cwd: CWD, sessionManager: { getSessionId: () => 'session-a' } };
  handlers.agent_settled({ type: 'agent_settled' }, ctx);
  const records = readFileSync(piRecordPath(env, 'orca:abc'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(records.length > 0 && records.every(r => r.pane_id === 'orca:abc'));
  assert.deepEqual(calls, [[env, 'orca:abc']]);

  const bridgeHandlers = {};
  registerPiBridge({ on: (name, fn) => { bridgeHandlers[name] = fn; return () => {}; } },
    { env, pid: 4242, now: () => 1000, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  bridgeHandlers.session_start({ type: 'session_start' }, { sessionManager: { getSessionId: () => 'session-a' } });
  const bridge = readFileSync(bridgePanePath(env, 'orca:abc'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(bridge.length > 0 && bridge.every(e => e.pane === 'orca:abc'));
});

test('1) orders: the extension polls the inbox of orca:<session> and acks', t => {
  const dir = makeTmp(t), handlers = {}, sent = [];
  const env = { OPENBOT_ORCA_STATE_DIR: join(dir, 'state'), ORCA_AGENT_SESSION_ID: 'abc' };
  registerPiOrders({ on: (name, fn) => { handlers[name] = fn; return () => {}; }, sendUserMessage: (text) => sent.push(text) },
    { env, setInterval: () => ({ unref() {} }), clearInterval: () => {} });
  const orderDir = paneOrderDir(join(dir, 'state'), 'orca:abc');
  put(join(orderDir, 'ev-1.json'), JSON.stringify({ schema_version: 1, event_id: 'ev-1',
    ts: new Date().toISOString(), expires_at: new Date(Date.now() + 60000).toISOString(), pane: 'orca:abc', text: 'hola' }));
  handlers.session_start({ type: 'session_start' }, {});
  assert.deepEqual(sent, ['hola']);
});

// removed test: '1) Herdr still wins when both HERDR_PANE_ID and ORCA_AGENT_SESSION_ID are set' (plan-orca-openbot §2)
