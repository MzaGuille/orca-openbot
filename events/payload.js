// Webhook payload contract. See PLAN.md section 5.6.
import { randomUUID } from 'node:crypto';
import { cleanLines, dropTrailingBlank } from './text.js';
import { LABEL_RE } from '../core/config.js';
import { ATTENTION_KINDS } from './attention/core.js';
import { sanitizeAttention, sanitizeAttentionRecord } from './sanitize.js';
import { nextHints } from './hints.js';
import { sanitizeTelemetry, validateTelemetry } from './telemetry.js';

// Moved here from states.js (plan-orca-openbot §3): the only piece of it the payload needs.
export const NOTIFY_STATES = ['blocked', 'question', 'done', 'error'];
export const PAYLOAD_FIELDS = [
  'event_id', 'attention_kind', 'summary', 'errors', 'last_lines', 'next_hint', 'question',
  'machine_label', 'pane_id', 'cwd', 'project', 'workspace_id', 'workspace_name', 'agent', 'state',
  'host', 'os', 'plugin_version', 'ts', 'local_time', 'since_last_event_s',
];
export const MAX_LAST_LINES = 20;
export const MAX_ERRORS = 5;
// truncated: set only by the sender when the body had to be trimmed to fit (D4).
const OPTIONAL_FIELDS = ['signal', 'repeat_count', 'since', 'telemetry', 'local_time', 'since_last_event_s', 'truncated'];
// Fixed fallback summaries: the last screen line is usually a prompt, not a summary.
const ATTENTION_TEXT = {
  question: 'is asking a question', done: 'finished', error: 'reported an error', blocked: 'is blocked', stalled: 'shows no screen change',
  stalled_unanswered: 'is still waiting for an answer',
};
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const pad = (n) => String(n).padStart(2, '0');

// Local time with an explicit offset, e.g. 2026-10-12T17:42:05-03:00 (never "Z").
export function formatTs(date = new Date()) {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
}

export function lastLines(text, n = MAX_LAST_LINES) {
  return dropTrailingBlank(cleanLines(sanitizeAttention(text))).slice(-n);
}

export function buildPayload({
  host, machineLabel = null, os, pluginVersion, workspaceId, workspaceName = null, paneId,
  agent = null, state, attentionKind = state, cwd = null, project = null,
  summary = null, question = null, signal = null, errors = [], lastLines: lines = [],
  repeatCount, since = null, telemetry, now = new Date(), eventId = randomUUID(),
  secrets = [], sensitiveNames = [], timeZone = null, sinceLastEvent = null,
}) {
  const clean = sanitizeAttentionRecord({ host, machineLabel, os, pluginVersion, workspaceId, workspaceName,
    paneId, agent, state, attentionKind, cwd, project, summary, signal, errors, lines, eventId }, { secrets, sensitiveNames });
  // Enum values are protocol constants, not arbitrary text to redact.
  if (NOTIFY_STATES.includes(state)) clean.state = state;
  if (ATTENTION_KINDS.includes(attentionKind)) clean.attentionKind = attentionKind;
  const questionKeys = ['text', 'options', 'selected_index', ...(typeof question?.parse_ok === 'boolean' ? ['parse_ok'] : []), ...(typeof question?.parse_reason === 'string' ? ['parse_reason'] : [])];
  clean.question = question === null ? null : sanitizeAttentionRecord(
    Object.fromEntries(Object.entries(question).filter(([key]) => questionKeys.includes(key))),
    { secrets, sensitiveNames },
  );
  // Only diagnostics supplies a synthetic hostname fallback; real events stay optional.
  const hostLabel = String(clean.host || '').replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'machine';
  const label = LABEL_RE.test(clean.machineLabel ?? '') ? clean.machineLabel : hostLabel;
  const summaryText = clean.summary || clean.question?.text
    || (clean.agent || 'agent') + ' ' + (ATTENTION_TEXT[clean.attentionKind] || 'needs attention');
  const errorLines = [...new Set(clean.errors.filter(line => typeof line === 'string')
    .flatMap(cleanLines).map(line => line.trim()).filter(Boolean))].slice(0, MAX_ERRORS);
  const duplicateErrors = new Set(errorLines);
  // A hand-edited or clock-skewed timestamp must never yield a negative or NaN delta.
  const prevEventMs = sinceLastEvent instanceof Date ? sinceLastEvent.getTime() : sinceLastEvent;
  const hasPrevEvent = typeof prevEventMs === 'number' && Number.isFinite(prevEventMs) && prevEventMs <= now.getTime();
  return {
    event_id: clean.eventId,
    attention_kind: clean.attentionKind,
    summary: String(summaryText).replace(/\s+/g, ' ').trim().slice(0, 240) || ('Attention: ' + clean.attentionKind),
    errors: errorLines,
    last_lines: clean.lines.flatMap(cleanLines).filter(line => !duplicateErrors.has(line.trim())).slice(-MAX_LAST_LINES),
    next_hint: nextHints({ paneId: clean.paneId, attentionKind: clean.attentionKind }),
    question: clean.question,
    ...(telemetry !== undefined ? { telemetry: sanitizeTelemetry(telemetry, attentionKind, { secrets, sensitiveNames }) } : {}),
    ...(clean.signal !== null ? { signal: clean.signal } : {}),
    ...(repeatCount !== undefined ? { repeat_count: repeatCount } : {}),
    ...(since !== null ? { since: formatTs(since instanceof Date ? since : new Date(since)) } : {}),
    machine_label: label,
    pane_id: clean.paneId,
    cwd: clean.cwd,
    project: clean.project,
    workspace_id: clean.workspaceId,
    workspace_name: clean.workspaceName,
    agent: clean.agent,
    state: clean.state,
    // #67: host is the same runtime-resolved label as machine_label (config label, else hostname).
    host: label,
    os: clean.os,
    plugin_version: clean.pluginVersion || 'unknown',
    ts: formatTs(now instanceof Date ? now : new Date(now)),
    local_time: formatLocalTime(now, timeZone),
    ...(hasPrevEvent
      ? { since_last_event_s: Math.max(0, Math.round((now.getTime() - prevEventMs) / 1000)) }
      : { since_last_event_s: null }),
  };
}

// Local time with minutes and IANA zone label, e.g. "00:27 (Mendoza)".
export function formatLocalTime(date = new Date(), timeZone = null) {
  const tz = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const label = String(tz).split('/').pop();
  // hourCycle 'h23' (not hour12: false): Node 20 ICU can render midnight as
  // "24:MM" with hour12:false; formatToParts keeps HH:MM stable everywhere.
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz,
  }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return part('hour') + ':' + part('minute') + ' (' + label + ')';
}

const isStr = (v) => typeof v === 'string';
const isStrOrNull = (v) => v === null || typeof v === 'string';

export function validatePayload(p) {
  const errors = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['payload must be an object'];
  // New metadata is optional on legacy queued payloads.
  for (const field of PAYLOAD_FIELDS.filter((f) => !['attention_kind', 'cwd', 'project', 'errors', 'next_hint'].includes(f) && !OPTIONAL_FIELDS.includes(f))) {
    if (!(field in p)) errors.push('missing field ' + field);
  }
  for (const key of Object.keys(p)) if (!PAYLOAD_FIELDS.includes(key) && !OPTIONAL_FIELDS.includes(key)) errors.push('unexpected field ' + sanitizeAttention(key));
  if ('event_id' in p && !UUID_RE.test(String(p.event_id))) errors.push('event_id must be a UUID');
  if ('host' in p && (!isStr(p.host) || !p.host)) errors.push('host must be a non-empty string');
  if ('machine_label' in p && !(p.machine_label === null || (isStr(p.machine_label) && LABEL_RE.test(p.machine_label)))) {
    errors.push('machine_label must be null or a short label');
  }
  if ('os' in p && p.os !== 'linux') errors.push('os must be linux');
  for (const f of ['plugin_version', 'workspace_id', 'pane_id']) {
    if (f in p && (!isStr(p[f]) || !p[f])) errors.push(f + ' must be a non-empty string');
  }
  for (const f of ['workspace_name', 'agent', 'summary', 'cwd', 'project', 'signal']) {
    if (f in p && !isStrOrNull(p[f])) errors.push(f + ' must be a string or null');
  }
  if ('state' in p && !NOTIFY_STATES.includes(p.state)) errors.push('state must be one of ' + NOTIFY_STATES.join(', '));
  if ('attention_kind' in p && !ATTENTION_KINDS.includes(p.attention_kind)) errors.push('attention_kind must be a supported attention kind');
  if ('attention_kind' in p && ATTENTION_KINDS.includes(p.attention_kind) && NOTIFY_STATES.includes(p.state)
    && p.state !== (['stalled', 'stalled_unanswered', 'waiting_input', 'unknown', 'cache_miss', 'context'].includes(p.attention_kind) ? 'blocked' : p.attention_kind)) errors.push('attention_kind must match state');
  // Pre-T5 queued summaries were unbounded; admit them without rewriting bytes.
  if ('attention_kind' in p && isStr(p.summary) && (p.summary.length > 240 || /[\r\n]/.test(p.summary))) errors.push('summary must be one line of at most 240 characters');
  if ('question' in p && p.question !== null) {
    const q = p.question;
    const optionsOk = q.options === null || (Array.isArray(q.options) && q.options.every(isStr));
    if (typeof q !== 'object' || !isStr(q.text) || !optionsOk) {
      errors.push('question must be {text, options[]}');
    } else {
      if (p.state !== 'question' && !(p.state === 'blocked' && (p.attention_kind === 'waiting_input' || typeof q.parse_ok === 'boolean'))) errors.push('question is only allowed when state is question');
      if (Object.keys(q).some((key) => !['text', 'options', 'selected_index', 'parse_ok', 'parse_reason'].includes(key))) errors.push('unexpected question field');
      if ('parse_reason' in q && !['no_options', 'encoding', 'unreadable'].includes(q.parse_reason)) errors.push('question parse_reason is not supported');
      if (q.parse_ok === false && !q.parse_reason) errors.push('question parse_reason is required when parse_ok is false');
      if ('parse_ok' in q && typeof q.parse_ok !== 'boolean') errors.push('question parse_ok must be boolean');
      if (q.parse_ok === false && q.options !== null) errors.push('question options must be null when parse_ok is false');
      if (q.parse_ok === true && !Array.isArray(q.options)) errors.push('question options must be a string array when parse_ok is true');
      if (q.selected_index !== undefined && q.selected_index !== null
        && (!Array.isArray(q.options) || !Number.isInteger(q.selected_index) || q.selected_index < 0 || q.selected_index >= q.options.length)) {
        errors.push('question selected_index must be null or an in-range integer');
      }
    }
  }
  if ('last_lines' in p && !(Array.isArray(p.last_lines) && p.last_lines.length <= MAX_LAST_LINES && p.last_lines.every(isStr))) {
    errors.push('last_lines must be at most 20 strings');
  }
  if ('errors' in p) {
    if (!Array.isArray(p.errors) || p.errors.length > MAX_ERRORS || !p.errors.every(line => isStr(line) && !/[\r\n]/.test(line))) {
      errors.push('errors must be at most 5 one-line strings');
    } else if (Array.isArray(p.last_lines) && p.last_lines.some(line => isStr(line) && p.errors.some(error => error.trim() === line.trim()))) {
      errors.push('errors and last_lines must not overlap');
    }
  }
  if ('next_hint' in p) {
    const expected = nextHints({ paneId: p.pane_id, attentionKind: p.attention_kind || p.state });
    if (!p.next_hint || Array.isArray(p.next_hint) || Object.keys(p.next_hint).some(key => !['read', 'reply'].includes(key))
      || !isStr(p.next_hint.read) || !isStrOrNull(p.next_hint.reply) || p.next_hint.read !== expected.read
      || p.next_hint.reply !== expected.reply) {
      errors.push('next_hint must contain supported read/reply templates');
    }
  }
  if ('telemetry' in p && p.telemetry !== undefined) errors.push(...validateTelemetry(p.telemetry, p.attention_kind));
  if ('truncated' in p && p.truncated !== true) errors.push('truncated must be true when present');
  if ('repeat_count' in p && (!Number.isSafeInteger(p.repeat_count) || p.repeat_count < 0)) errors.push('repeat_count must be a non-negative integer');
  if ('since' in p && !TS_RE.test(String(p.since))) errors.push('since must be ISO 8601 with offset');
  if ('local_time' in p && (typeof p.local_time !== 'string' || !p.local_time)) errors.push('local_time must be a non-empty string');
  if ('since_last_event_s' in p && !(p.since_last_event_s === null || (Number.isInteger(p.since_last_event_s) && p.since_last_event_s >= 0))) {
    errors.push('since_last_event_s must be null or a non-negative integer');
  }
  if (!TS_RE.test(String(p.ts ?? ''))) errors.push('ts must be ISO 8601 with offset');
  return errors;
}
