import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp, put } from '../helpers/tmp.js';
import { startMockWebhook } from '../helpers/mock-webhook.js';
import { runIngest } from '../../events/ingest.js';
import { piRecordPath } from '../../pi/runtime.js';
import { queueStats } from '../../events/queue.js';
import { fakeSecret } from '../helpers/secret.js';

const PANE = 'orca:s1';
const QUESTION = '¿Seguimos con A o con B?';

function setup(t, receiver) {
  const dir = makeTmp(t), state = join(dir, 'state');
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir,
    OPENBOT_ORCA_STATE_DIR: state, OPENBOT_ORCA_CONFIG_FILE: join(dir, 'missing'),
    OPENBOT_ORCA_WEBHOOK_SECRET: fakeSecret('t'), OPENBOT_ORCA_WEBHOOK_URL: receiver.url };
  const file = piRecordPath(env, PANE);
  const record = data => ({ source: 'pi-ext', pane_id: PANE, session_id: 'a', cwd: '/work/demo', ...data });
  return { state, env,
    write: records => put(file, records.map(r => JSON.stringify(record(r))).join('\n') + '\n'),
    ingest: () => runIngest({ paneId: PANE, env, now: 1000, spawnFlusher: () => {} }) };
}

const queued = state => {
  const file = join(state, 'queue.jsonl');
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).payload);
};

test('(a) agent_settled with a question queues one free-text question payload', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([{ name: 'agent_settled', hadError: false, aborted: false, question: QUESTION }]);
  assert.deepEqual(s.ingest(), { ok: true, processed: 1, queued: 1 });
  assert.equal(queueStats(s.state).pending, 1);
  const [payload] = queued(s.state);
  assert.equal(payload.attention_kind, 'question');
  assert.equal(payload.state, 'question');
  assert.deepEqual(payload.question.options, []);
  assert.equal(payload.question.selected_index, null);
  assert.equal(payload.summary, QUESTION);
  assert.equal(payload.signal, 'pi-settled-question');
  assert.match(payload.next_hint.reply, /--text/);
});

test('(b) agent_settled without a question stays one done payload', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([{ name: 'agent_settled', hadError: false, aborted: false }]);
  assert.deepEqual(s.ingest(), { ok: true, processed: 1, queued: 1 });
  const [payload] = queued(s.state);
  assert.equal(payload.attention_kind, 'done');
  assert.equal(payload.state, 'done');
});

test('(c) the osc mirror of the same question dedupes to one payload', async t => {
  const receiver = await startMockWebhook(t), s = setup(t, receiver);
  s.write([
    { name: 'agent_settled', hadError: false, aborted: false, question: QUESTION },
    { source: 'osc', name: 'program_status', status: 'blocked', kind: 'question', title: QUESTION },
  ]);
  const result = s.ingest();
  assert.equal(result.processed, 2);
  assert.equal(result.queued, 1);
  assert.equal(queueStats(s.state).pending, 1);
  const [payload] = queued(s.state);
  assert.equal(payload.attention_kind, 'question');
  assert.equal(payload.signal, 'pi-settled-question');
});

// removed tests: '(1) a bridge done carrying a question makes the hook done a single question…' and
// '(2) a bridge done without a question keeps the hook done as one done' (Herdr hook, plan-orca-openbot §3).
