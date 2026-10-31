import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from '../helpers/tmp.js';
import { registerPiBridge } from '../../pi/bridge.js';
import { bridgePanePath, readBridgeTurn } from '../../events/pi-bridge.js';

const QUESTION = '¿Seguimos con A o con B?';

function setup(t) {
  const dir = makeTmp(t), handlers = {};
  const env = { OPENBOT_ORCA_STATE_DIR: join(dir, 'state'), ORCA_AGENT_SESSION_ID: 's1' };
  registerPiBridge({ on: (name, fn) => { handlers[name] = fn; return () => {}; } },
    { env, pid: 7, now: () => Date.UTC(2026, 9, 30, 12), setInterval: () => ({}), clearInterval: () => {} });
  const text = () => readFileSync(bridgePanePath(env, 'orca:s1'), 'utf8');
  return { handlers, text };
}

const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' });

test('a done record carrying a trailing question yields that doneQuestion', t => {
  const s = setup(t);
  s.handlers.session_start({}, { sessionManager: { getSessionId: () => 's1' } });
  s.handlers.message_end({ message: assistant(QUESTION) });
  s.handlers.agent_settled({ aborted: false });
  const turn = readBridgeTurn(s.text());
  assert.equal(turn.doneQuestion, QUESTION);
  assert.equal(turn.open, false);
});

test('a done record without a question yields a null doneQuestion', t => {
  const s = setup(t);
  s.handlers.session_start({}, { sessionManager: { getSessionId: () => 's1' } });
  s.handlers.message_end({ message: assistant('Listo.') });
  s.handlers.agent_settled({ aborted: false });
  assert.equal(readBridgeTurn(s.text()).doneQuestion, null);
});

test('a malformed bridge record yields null and does not throw', () => {
  assert.equal(readBridgeTurn('not json\n').doneQuestion, null);
  assert.equal(readBridgeTurn('{"type":"done"}\n').doneQuestion, null);
  assert.equal(readBridgeTurn('{"type":"done","detail":{"question":1}}\n').doneQuestion, null);
  assert.doesNotThrow(() => readBridgeTurn('{'));
});

test('an agent_start in the middle of an open turn keeps the captured question', t => {
  const s = setup(t);
  s.handlers.session_start({}, { sessionManager: { getSessionId: () => 's1' } });
  s.handlers.agent_start({});
  s.handlers.message_end({ message: assistant(QUESTION) });
  s.handlers.agent_start({});
  s.handlers.agent_settled({ aborted: false });
  const turn = readBridgeTurn(s.text());
  assert.equal(turn.doneQuestion, QUESTION);
  assert.equal(turn.open, false);
});

test('an agent_start with the turn closed does not inherit an earlier question', t => {
  const s = setup(t);
  s.handlers.session_start({}, { sessionManager: { getSessionId: () => 's1' } });
  s.handlers.message_end({ message: assistant(QUESTION) });
  s.handlers.agent_start({});
  s.handlers.agent_settled({ aborted: false });
  assert.equal(readBridgeTurn(s.text()).doneQuestion, null);
});

test('a new turn after a settled question starts without it', t => {
  const s = setup(t);
  s.handlers.session_start({}, { sessionManager: { getSessionId: () => 's1' } });
  s.handlers.agent_start({});
  s.handlers.message_end({ message: assistant(QUESTION) });
  s.handlers.agent_settled({ aborted: false });
  s.handlers.agent_start({});
  s.handlers.agent_settled({ aborted: false });
  assert.equal(readBridgeTurn(s.text()).doneQuestion, null);
});
