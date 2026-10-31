// Issue #5: a gentle_review consent envelope settles as a question carrying the ready command.
// The fixture is the real envelope (schema gentle-ai.review-integration.consent/v3, contract v2).
// gentle-pi puts it inside the tool result as {operation, status, outcome, consent, consent_binding}
// (extensions/gentle-ai.ts: `consent: error.consent.raw`), serialized in content[0].text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from '../helpers/tmp.js';
import { startMockWebhook } from '../helpers/mock-webhook.js';
import { fakeSecret } from '../helpers/secret.js';
import { createPiEventNormalizer } from '../../pi/events.js';
import { registerPiAttention } from '../../pi/runtime.js';
import { registerPiBridge } from '../../pi/bridge.js';
import { evaluateSignals } from '../../events/attention/evaluate.js';
import { runIngest } from '../../events/ingest.js';
import { runFlush } from '../../events/flush.js';
import { piRecordPath } from '../../events/pi-path.js';
import { bridgePanePath } from '../../events/pi-bridge.js';
import { buildPayload, validatePayload } from '../../events/payload.js';
import { nextHints } from '../../events/hints.js';

const ENVELOPE = JSON.parse(readFileSync(new URL('../fixtures/review-consent-v3.json', import.meta.url), 'utf8'));
const [GRANTED, DECLINED] = ENVELOPE.choices.map(c => c.invocation);
const HEADLINE = ENVELOPE.headline;
const SUMMARY = HEADLINE + ' (revisión, riesgo high, 12 archivos)';
const CONSENT = { headline: HEADLINE, risk_level: 'high', changed_files: 12, changed_lines: 347, invocations: [GRANTED, DECLINED] };

const wrapped = (envelope = ENVELOPE) => ({ content: [{ type: 'text', text: JSON.stringify({
  operation: 'start', status: 'blocked', outcome: 'native-review-consent-required', consent: envelope, consent_binding: 'b-1' }) }] });
const bare = (envelope = ENVELOPE) => ({ content: [{ type: 'text', text: JSON.stringify(envelope) }] });
const reviewEnd = (result, extra = {}) => ({ type: 'tool_execution_end', toolName: 'gentle_review', isError: false, result, ...extra });
const text = body => ({ content: [{ type: 'text', text: JSON.stringify(body) }] });
const assistant = t => ({ role: 'assistant', content: [{ type: 'text', text: t }], stopReason: 'stop' });

function run(events) {
  const normalize = createPiEventNormalizer();
  let last = [];
  for (const event of events) last = normalize(event);
  return last;
}
const settled = records => records.find(r => r.source === 'pi-ext' && r.name === 'agent_settled');
const mirror = records => records.find(r => r.source === 'osc' && r.name === 'program_status');
const turn = (...middle) => [{ type: 'agent_start' }, ...middle,
  { type: 'message_end', message: assistant('Review needs your consent.') }, { type: 'agent_settled', aborted: false }];

test('fixture sanity: the real envelope has the fields the parser reads', () => {
  assert.equal(ENVELOPE.schema, 'gentle-ai.review-integration.consent/v3');
  assert.equal(ENVELOPE.action, 'consent_required');
  assert.deepEqual(ENVELOPE.choices.map(c => c.answer), ['granted', 'declined']);
  assert.ok(GRANTED.endsWith('--consent granted') && DECLINED.endsWith('--consent declined'));
});

// ---- Task 1: pendingConsent from tool_execution_end of gentle_review ----

test('1) gentle_review result with the wrapped envelope loads pendingConsent', () => {
  assert.deepEqual(settled(run(turn(reviewEnd(wrapped())))).consent, CONSENT);
});

test('1) a bare envelope in the result text loads it too', () => {
  assert.deepEqual(settled(run(turn(reviewEnd(bare())))).consent, CONSENT);
});

test('1) invocations are ordered [granted, declined] by answer, whatever the choices order', () => {
  const swapped = { ...ENVELOPE, choices: [...ENVELOPE.choices].reverse() };
  assert.deepEqual(settled(run(turn(reviewEnd(wrapped(swapped))))).consent.invocations, [GRANTED, DECLINED]);
});

test('1) another tool, even with the same text, leaves pendingConsent untouched', () => {
  for (const toolName of ['bash', 'read', 'gentle_review_capture']) {
    const records = run(turn({ type: 'tool_execution_end', toolName, isError: false, result: wrapped() }));
    assert.equal('consent' in settled(records), false, toolName);
  }
});

test('1) a gentle_review result without the envelope loads nothing', () => {
  for (const result of [text({ operation: 'inspect', status: 'ready' }), { content: [{ type: 'text', text: 'not json' }] },
    { content: [] }, {}, undefined, text({ consent: { action: 'granted' } }), text(null), text([1])]) {
    assert.equal('consent' in settled(run(turn(reviewEnd(result)))), false);
  }
});

test('1) a malformed or unsafe envelope loads nothing (no unchecked command is ever offered)', () => {
  const bad = [
    { ...ENVELOPE, choices: [ENVELOPE.choices[0]] },
    { ...ENVELOPE, choices: [ENVELOPE.choices[0], { ...ENVELOPE.choices[1], answer: 'granted' }] },
    { ...ENVELOPE, choices: [ENVELOPE.choices[0], { ...ENVELOPE.choices[1], invocation: 'rm -rf / --consent declined' }] },
    { ...ENVELOPE, choices: [{ ...ENVELOPE.choices[0], invocation: GRANTED + '; rm -rf /' }, ENVELOPE.choices[1]] },
    { ...ENVELOPE, choices: [{ ...ENVELOPE.choices[0], invocation: GRANTED.replace('--consent granted', '--consent declined') }, ENVELOPE.choices[1]] },
    { ...ENVELOPE, headline: '' },
    { ...ENVELOPE, headline: undefined },
    { ...ENVELOPE, changed_files: '12' },
    { ...ENVELOPE, risk_level: undefined },
  ];
  // Redaction would rewrite the command (a credential-looking assignment inside --lenses-reason).
  bad.push({ ...ENVELOPE, choices: [{ ...ENVELOPE.choices[0], invocation: GRANTED.replace("--lenses-reason '", "--lenses-reason 'api_key: abc ") }, ENVELOPE.choices[1]] });
  for (const envelope of bad) assert.equal('consent' in settled(run(turn(reviewEnd(wrapped(envelope))))), false, JSON.stringify(envelope).slice(0, 80));
});

test('1) a later start/answer-consent result that is not an envelope resolves the consent; inspect/status do not', () => {
  const resolved = op => run(turn(reviewEnd(wrapped()), reviewEnd(text({ operation: op, status: 'started', lineageId: 'l-1' }))));
  assert.equal('consent' in settled(resolved('start')), false);
  assert.equal('consent' in settled(resolved('answer-consent')), false);
  assert.deepEqual(settled(resolved('inspect')).consent, CONSENT);
  assert.deepEqual(settled(resolved('status')).consent, CONSENT);
  // An errored gentle_review is a tool error (hadError), so the settlement is an error and carries no consent.
  const errored = settled(run(turn(reviewEnd(wrapped()), reviewEnd(text({ operation: 'start' }), { isError: true }))));
  assert.equal(errored.hadError, true);
  assert.equal('consent' in errored, false);
});

// ---- Task 2: agent_settled carries consent and clears it ----

test('2) tool_execution_end -> message_end -> agent_settled gives the record consent; the mirror carries the headline', () => {
  const records = run(turn(reviewEnd(wrapped())));
  const record = settled(records);
  assert.equal(record.consent.headline, HEADLINE);
  assert.equal(record.consent.invocations.length, 2);
  assert.equal(record.hadError, false);
  assert.equal(record.aborted, false);
  assert.equal(mirror(records).status, 'blocked');
  assert.equal(mirror(records).kind, 'question');
  assert.equal(mirror(records).title, HEADLINE);
});

test('2) consent is cleared once settled: the next turn has none', () => {
  const normalize = createPiEventNormalizer();
  let last;
  for (const event of turn(reviewEnd(wrapped()))) last = normalize(event);
  assert.ok(settled(last).consent);
  for (const event of [{ type: 'agent_start' }, { type: 'message_end', message: assistant('Listo.') }, { type: 'agent_settled', aborted: false }]) last = normalize(event);
  assert.equal('consent' in settled(last), false);
});

test('2) an aborted or errored settlement carries no consent, and drops it', () => {
  const aborted = run([{ type: 'agent_start' }, reviewEnd(wrapped()), { type: 'agent_settled', aborted: true }]);
  assert.equal('consent' in settled(aborted), false);
  const errored = run([{ type: 'agent_start' }, reviewEnd(wrapped()),
    { type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'boom' }] } },
    { type: 'agent_settled', aborted: false }]);
  assert.equal(settled(errored).hadError, true);
  assert.equal('consent' in settled(errored), false);
});

test('2) a mid-turn agent_start keeps the consent; a new turn or a new session drops it', () => {
  const mid = run([{ type: 'agent_start' }, reviewEnd(wrapped()), { type: 'agent_start' }, { type: 'agent_settled', aborted: false }]);
  assert.deepEqual(settled(mid).consent, CONSENT);
  const normalize = createPiEventNormalizer();
  normalize({ type: 'agent_start' }); normalize(reviewEnd(wrapped()));
  normalize({ type: 'session_start' });
  normalize({ type: 'agent_start' });
  assert.equal('consent' in settled(normalize({ type: 'agent_settled', aborted: false })), false);
});

test('2) the bridge writes done with consent, like it writes question', t => {
  const dir = makeTmp(t), handlers = {};
  const env = { OPENBOT_ORCA_STATE_DIR: join(dir, 'state'), ORCA_AGENT_SESSION_ID: 's1' };
  registerPiBridge({ on: (name, fn) => { handlers[name] = fn; return () => {}; } },
    { env, pid: 7, now: () => Date.UTC(2026, 9, 31, 12), setInterval: () => ({}), clearInterval: () => {} });
  const done = () => readFileSync(bridgePanePath(env, 'orca:s1'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.type === 'done').at(-1);
  const send = (events) => events.forEach(e => handlers[e.type]?.(e, { sessionManager: { getSessionId: () => 's1' } }));
  send([{ type: 'session_start' }, { type: 'agent_start' }, reviewEnd(wrapped()), { type: 'message_end', message: assistant('Review needs your consent.') },
    { type: 'agent_settled', aborted: false }]);
  assert.deepEqual(done().detail.consent, CONSENT);
  assert.equal('question' in done().detail, false);
  // Cleared: the next turn's done has none.
  send([{ type: 'agent_start' }, { type: 'agent_settled', aborted: false }]);
  assert.equal('consent' in done().detail, false);
  // Aborted, another tool, and a non-envelope gentle_review carry none.
  send([{ type: 'agent_start' }, reviewEnd(wrapped()), { type: 'agent_settled', aborted: true }]);
  assert.equal('consent' in done().detail, false);
  send([{ type: 'agent_start' }, { type: 'tool_execution_end', toolName: 'bash', result: wrapped() }, { type: 'agent_settled', aborted: false }]);
  assert.equal('consent' in done().detail, false);
  send([{ type: 'agent_start' }, reviewEnd(text({ operation: 'inspect' })), { type: 'agent_settled', aborted: false }]);
  assert.equal('consent' in done().detail, false);
});

// ---- Task 3: signal pi-review-consent ----

test('3) a settled record with consent evaluates to pi-review-consent / question with the summary', () => {
  const attention = evaluateSignals(settled(run(turn(reviewEnd(wrapped())))));
  assert.equal(attention.id, 'pi-review-consent');
  assert.equal(attention.attentionKind, 'question');
  assert.equal(attention.state, 'question');
  assert.equal(attention.summary, SUMMARY);
});

test('3) consent outranks a prose question; without consent the old signals are unchanged', () => {
  const base = { source: 'pi-ext', name: 'agent_settled', hadError: false, aborted: false };
  assert.equal(evaluateSignals({ ...base, question: '¿Seguimos?', consent: CONSENT }).id, 'pi-review-consent');
  assert.equal(evaluateSignals({ ...base, question: '¿Seguimos?' }).id, 'pi-settled-question');
  assert.equal(evaluateSignals(base).id, 'pi-settled');
  assert.equal('summary' in evaluateSignals(base), false);
  assert.equal(evaluateSignals({ ...base, hadError: true, consent: CONSENT }).id, 'pi-settled-error');
  assert.equal(evaluateSignals({ ...base, aborted: true, consent: CONSENT }), null);
  // A record whose consent is not an object with a headline is not a consent.
  assert.equal(evaluateSignals({ ...base, consent: 'x' }).id, 'pi-settled');
  assert.equal(evaluateSignals({ ...base, consent: {} }).id, 'pi-settled');
});

// ---- Task 4: payload ----

const PANE = 'orca:sess-1', CWD = '/work/orca-demo';

function pipeline(t, receiver) {
  const dir = makeTmp(t), handlers = {};
  const env = { ...process.env, HOME: dir, XDG_CONFIG_HOME: dir, OPENBOT_ORCA_STATE_DIR: join(dir, 'state'),
    OPENBOT_ORCA_CONFIG_FILE: join(dir, 'missing'), OPENBOT_ORCA_WEBHOOK_SECRET: fakeSecret('t'),
    OPENBOT_ORCA_WEBHOOK_URL: receiver.url, ORCA_AGENT_SESSION_ID: 'sess-1' };
  registerPiAttention({ on: (name, fn) => { handlers[name] = fn; return () => {}; } }, { env, now: () => 1000, spawnIngest: () => {} });
  const ctx = { cwd: CWD, sessionManager: { getSessionId: () => 'session-a' } };
  return { env, send: events => events.forEach(e => handlers[e.type]?.(e, ctx)),
    records: () => readFileSync(piRecordPath(env, PANE), 'utf8').trim().split('\n').map(JSON.parse),
    ingest: () => runIngest({ paneId: PANE, env, now: 1000, spawnFlusher: () => {} }) };
}

test('4) end to end: one orca.pane.question with the review-consent question and the ready commands', async t => {
  const receiver = await startMockWebhook(t), p = pipeline(t, receiver);
  p.send(turn(reviewEnd(wrapped())));
  const records = p.records();
  assert.deepEqual(records.find(r => r.name === 'agent_settled').consent, CONSENT, 'redaction keeps the commands byte for byte');
  // The settled record and its osc mirror are one event, not two.
  assert.equal(p.ingest().queued, 1);
  await runFlush({ env: p.env });
  assert.equal(receiver.requests.length, 1);
  const body = receiver.requests[0].json;
  assert.equal(receiver.requests[0].envelope.type, 'orca.pane.question');
  assert.equal(body.attention_kind, 'question');
  assert.equal(body.state, 'question');
  assert.equal(body.signal, 'pi-review-consent');
  assert.equal(body.summary, SUMMARY);
  assert.equal(body.question.text, HEADLINE);
  assert.equal(body.question.kind, 'review-consent');
  assert.deepEqual(body.question.options, ['granted: ' + GRANTED, 'declined: ' + DECLINED]);
  assert.match(body.next_hint.reply, /GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi\.review-relay\/v1/);
  assert.match(body.next_hint.reply, /shell/);
  assert.match(body.next_hint.reply, /orca-openbot send is not enough/);
  assert.doesNotMatch(body.next_hint.reply, /--text/);
  assert.equal(body.next_hint.read, 'orca-ide worktree ps --json');
  assert.deepEqual(validatePayload(body), []);
});

test('4) previous behavior holds: a prose question and a plain done keep their payloads', async t => {
  const receiver = await startMockWebhook(t), p = pipeline(t, receiver);
  p.send([{ type: 'agent_start' }, { type: 'message_end', message: assistant('¿Seguimos con A o con B?') }, { type: 'agent_settled', aborted: false }]);
  assert.equal(p.ingest().queued, 1);
  await runFlush({ env: p.env });
  const body = receiver.requests[0].json;
  assert.equal(body.attention_kind, 'question');
  assert.deepEqual(body.question, { text: '¿Seguimos con A o con B?', options: [], selected_index: null });
  assert.equal(body.next_hint.reply, 'orca-openbot send --pane ' + PANE + ' --text "<answer>"');
  assert.deepEqual(validatePayload(body), []);
});

test('4) the payload builder and validator treat question.kind strictly', () => {
  const base = { host: 'h', os: 'linux', pluginVersion: '1', workspaceId: 'orca', paneId: PANE, state: 'question',
    attentionKind: 'question', now: new Date(2026, 9, 31, 12) };
  const make = question => buildPayload({ ...base, question });
  const q = { text: HEADLINE, options: ['granted: ' + GRANTED, 'declined: ' + DECLINED], selected_index: null, kind: 'review-consent' };
  assert.deepEqual(validatePayload(make(q)), []);
  assert.equal(make(q).next_hint.reply, nextHints({ paneId: PANE, attentionKind: 'question', questionKind: 'review-consent' }).reply);
  // A review-consent payload with the plain send reply, or a plain question with the shell reply, is invalid.
  assert.match(validatePayload({ ...make(q), next_hint: nextHints({ paneId: PANE, attentionKind: 'question' }) }).join(), /next_hint/);
  const plain = make({ text: 'x?', options: [], selected_index: null });
  assert.match(validatePayload({ ...plain, next_hint: make(q).next_hint }).join(), /next_hint/);
  // Unknown kinds do not pass.
  assert.match(validatePayload({ ...make(q), question: { ...q, kind: 'other' } }).join(), /question kind/);
  assert.equal('kind' in make({ text: 'x?', options: [], selected_index: null, kind: 7 }).question, false);
});
