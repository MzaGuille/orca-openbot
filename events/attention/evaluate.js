import { SIGNALS, IGNORED } from './signals.js';

const matches = (record, fields) => Object.entries(fields).every(([key, expected]) => {
  const value = key.split('.').reduce((item, part) => item?.[part], record);
  return expected instanceof RegExp ? expected.test(String(value ?? ''))
    : Array.isArray(expected) ? expected.includes(value) : value === expected;
});

// Match the complete runtime result, never a word inside command output.
export function silentCommandFailure(msg) {
  const text = String(msg || '').trim();
  return !text || /^Command timed out after \d+(?:\.\d+)?(?:e[+-]?\d+)? seconds$/.test(text)
    || /^\(no output\)\r?\n\r?\nCommand exited with code [1-9]\d*$/.test(text);
}

// Named records only become unknown if their name itself is unregistered.
// Known lifecycle events with no attention condition (e.g. successful tools) are silent.
export function evaluateSignals(record = {}) {
  // Tool-level no-match/timeout results belong to Pi's running turn, not an
  // agent failure. Do not latch them into the eventual agent_settled error.
  if (record.source === 'pi-ext' && record.name === 'tool_execution_end' && record.toolName === 'bash' && record.isError === true
    && silentCommandFailure(record.msg)) return null;
  const candidates = SIGNALS.filter(s => s.source === record.source && matches(record, s.match));
  const entry = candidates.sort((a, b) => b.priority - a.priority)[0];
  const errorLines = typeof record.msg === 'string' ? record.msg.split(/\r?\n/).filter(Boolean) : [];
  for (const candidate of candidates.filter(signal => signal.attention_kind === 'error')) {
    for (const [field, pattern] of Object.entries(candidate.match)) {
      if (pattern instanceof RegExp) errorLines.push(...String(record[field] ?? '').split(/\r?\n/).filter(line => pattern.test(line)));
    }
  }
  if (entry) return {
    id: entry.id, attentionKind: entry.attention_kind,
    ...(entry.veto_done ? { vetoDone: true } : {}),
    ...(entry.summary ? { summary: entry.summary } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    ...(entry.attention_kind === 'error' ? { errors: [...new Set(errorLines)] } : {}),
    state: ['unknown', 'stalled', 'cache_miss', 'context'].includes(entry.attention_kind) ? 'blocked' : entry.attention_kind,
  };
  if (!record.name || IGNORED.some(s => matches(record, s))
    || SIGNALS.some(s => s.source === record.source && matches(record, { name: s.match.name }))) return null;
  return { id: null, attentionKind: 'unknown', state: 'blocked', signal: record.name };
}
// removed: workSignal, a screen heuristic for the watcher (plan-orca-openbot §3).
