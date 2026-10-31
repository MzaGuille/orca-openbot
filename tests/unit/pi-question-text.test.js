// Pi assistant text on message_end, verified before this helper was written
// (installed @earendil-works/pi-coding-agent, not @mariozechner/pi-coding-agent):
// MessageEndEvent.message is AgentMessage
//   dist/core/extensions/types.d.ts:849-851
// AgentMessage = Message | custom
//   node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:322
// Message includes AssistantMessage
//   node_modules/@earendil-works/pi-ai/dist/types.d.ts:368-370,436
// AssistantMessage.content is (TextContent | ThinkingContent | ToolCall)[]
// and TextContent is { type: "text"; text: string }
//   node_modules/@earendil-works/pi-ai/dist/types.d.ts:252-255
// So message_end carries the assistant text as an array of {type:'text', text}
// parts. The sessionManager fallback (pi/runtime.js:63-68) is not needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trailingQuestion } from '../../pi/question-text.js';
import { createPiEventNormalizer } from '../../pi/events.js';

const assistant = text => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
});

const settled = records => records.find(r => r.source === 'pi-ext' && r.name === 'agent_settled');
const mirror = records => records.find(r => r.source === 'osc' && r.name === 'program_status');

test('trailingQuestion keeps only a short last line that ends in ?', () => {
  assert.equal(trailingQuestion(assistant('¿Seguimos con A o con B?')), '¿Seguimos con A o con B?');
  assert.equal(trailingQuestion(assistant('¿Seguimos? Listo, hecho.')), null);
  assert.equal(trailingQuestion(assistant('Listo.')), null);
  assert.equal(trailingQuestion(assistant('```\n¿Esto cuenta?\n```')), null);
  assert.equal(trailingQuestion(assistant('¿Seguimos?')), '¿Seguimos?');
  assert.equal(trailingQuestion(assistant('¿Seguimos?)\n')), '¿Seguimos?)');
  assert.equal(trailingQuestion(assistant('¿Seguimos?"')), '¿Seguimos?"');
  assert.equal(trailingQuestion(assistant('¿Seguimos?*')), '¿Seguimos?*');
});

test('a trailing question longer than 240 characters is not a question', () => {
  const line = '¿' + 'a'.repeat(240) + '?';
  assert.equal(line.length, 242);
  assert.equal(trailingQuestion(assistant(line)), null);
  const kept = '¿' + 'a'.repeat(238) + '?';
  assert.equal(kept.length, 240);
  assert.equal(trailingQuestion(assistant(kept)), kept);
});

function run(events) {
  const normalize = createPiEventNormalizer();
  let last = [];
  for (const event of events) last = normalize(event);
  return last;
}

test('agent_settled records the pending trailing question on both records', () => {
  const records = run([
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('¿Seguimos con A o con B?') },
    { type: 'agent_settled', aborted: false },
  ]);
  assert.equal(settled(records).question, '¿Seguimos con A o con B?');
  assert.equal(mirror(records).title, '¿Seguimos con A o con B?');
});

test('a question followed by a statement leaves no question field', () => {
  const records = run([
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('¿Seguimos? Listo, hecho.') },
    { type: 'agent_settled', aborted: false },
  ]);
  assert.equal('question' in settled(records), false);
  assert.equal(mirror(records).title, '');
});

test('a statement leaves no question field', () => {
  const records = run([
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('Listo.') },
    { type: 'agent_settled', aborted: false },
  ]);
  assert.equal('question' in settled(records), false);
});

test('a question mark inside a code fence leaves no question field', () => {
  const records = run([
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('```\n¿Esto cuenta?\n```') },
    { type: 'agent_settled', aborted: false },
  ]);
  assert.equal('question' in settled(records), false);
});

test('aborted settlement leaves no question field even when a question is pending', () => {
  const records = run([
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('¿Seguimos con A o con B?') },
    { type: 'agent_settled', aborted: true },
  ]);
  assert.equal('question' in settled(records), false);
});

test('agent_start drops a question captured in an earlier run', () => {
  const records = run([
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('¿Seguimos con A o con B?') },
    { type: 'agent_start' },
    { type: 'message_end', message: assistant('Listo.') },
    { type: 'agent_settled', aborted: false },
  ]);
  assert.equal('question' in settled(records), false);
});
