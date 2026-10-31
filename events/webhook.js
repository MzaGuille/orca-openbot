// POST to the OpenBot webhook. Errors never include the URL or the secret.
import { DEFAULT_TIMEOUT_MS } from '../core/config.js';
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, readJson, writeJson, tryCreateLock, removeLockIf } from '../core/fsutil.js';
import { sign, SignError, DELIVERY_ID_RE } from '../core/sign.js';

export function immediateRetries(stateDir) {
  const count = readJson(join(stateDir, 'webhook-retries.json'), {}).count;
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function recordRetry(stateDir, err) {
  if (!stateDir) return;
  try {
    ensurePrivateDir(stateDir);
    const lock = join(stateDir, 'webhook-retries.lock');
    const token = tryCreateLock(lock);
    if (token === null) return;
    try {
      writeJson(join(stateDir, 'webhook-retries.json'), { count: immediateRetries(stateDir) + 1 });
      const file = join(stateDir, 'webhook-retry.log');
      try { if (statSync(file).size > 256 * 1024) renameSync(file, file + '.1'); } catch {}
      const code = err?.cause?.code || err?.code;
      appendFileSync(file, (RESET_CODES.has(code) ? code : 'ECONNRESET') + '\n', { mode: 0o600 });
    } finally {
      removeLockIf(lock, token);
    }
  } catch { /* Observability must not prevent delivery. */ }
}

export const USER_AGENT = 'orca-openbot/0.1.0';

// Chunk long deadlines so Node's timer range cannot silently shorten them.
function deadline(timeoutMs) {
  const controller = new AbortController();
  const started = performance.now();
  let timer;
  const schedule = () => {
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining <= 0) controller.abort(new DOMException('timeout', 'TimeoutError'));
    else {
      timer = setTimeout(schedule, Math.min(remaining, 2147483647));
      timer.unref();
    }
  };
  schedule();
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

// A pooled keep-alive socket the server already closed fails at once; one fresh attempt usually succeeds.
const RESET_CODES = new Set(['ECONNRESET', 'UND_ERR_SOCKET']);
function isReset(err) {
  const code = err?.cause?.code || err?.code;
  return RESET_CODES.has(code) || /socket hang up/i.test(String(err?.cause?.message || err?.message || ''));
}

// OpenBot rejects bodies over 64 KiB; the plugin keeps its own margin (D4).
export const LIMIT = 49152;
const LINE_BYTES = 1024;
const QUESTION_BYTES = 8192;
const OPTION_BYTES = 256;
const SUMMARY_BYTES = 120;
const MIN_LAST_LINES = 5;

const size = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

// Longest prefix within maxBytes UTF-8 bytes that never splits a code point.
export function cutBytes(text, maxBytes) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > maxBytes) break;
    used += n;
    out += ch;
  }
  return out;
}

function capQuestion(q) {
  if (!q || typeof q !== 'object' || size(q) <= QUESTION_BYTES) return q;
  const room = QUESTION_BYTES - size({ ...q, text: '' });
  // JSON escaping can inflate the text: shrink until the serialized question fits.
  let text = cutBytes(q.text, Math.max(0, room));
  while (text && size({ ...q, text }) > QUESTION_BYTES) text = cutBytes(text, Buffer.byteLength(text, 'utf8') - 64);
  const out = { ...q, text: text || '' };
  if (size(out) <= QUESTION_BYTES || !Array.isArray(out.options)) return out;
  return { ...out, options: out.options.map((o) => cutBytes(o, OPTION_BYTES)) };
}

// Deterministic trim steps, in D4 order. Each step returns a new payload.
const STEPS = [
  (d) => (Array.isArray(d.last_lines) && d.last_lines.length > MIN_LAST_LINES ? { ...d, last_lines: d.last_lines.slice(1) } : null),
  (d) => ({ ...d,
    ...(Array.isArray(d.last_lines) ? { last_lines: d.last_lines.map((l) => cutBytes(l, LINE_BYTES)) } : {}),
    ...(Array.isArray(d.errors) ? { errors: d.errors.map((l) => cutBytes(l, LINE_BYTES)) } : {}) }),
  (d) => (Array.isArray(d.errors) && d.errors.length ? { ...d, errors: [] } : null),
  (d) => ('telemetry' in d ? (({ telemetry, ...rest }) => rest)(d) : null),
  (d) => (d.question ? { ...d, question: capQuestion(d.question) } : null),
  (d) => (typeof d.summary === 'string' ? { ...d, summary: cutBytes(d.summary, SUMMARY_BYTES) } : null),
];

export function envelopeType(payload, type = null) {
  return type || 'orca.pane.' + (payload?.attention_kind || payload?.state || 'unknown');
}

// The exact bytes sent and signed: {type, occurredAt, data} under LIMIT bytes, or null
// when even the fully trimmed payload does not fit. The queue keeps the flat payload;
// the same payload always yields the same bytes.
export function encodeBody(body, { type = null } = {}) {
  if (typeof body === 'string') return body;
  const wrap = (data) => ({ type: envelopeType(body, type), ...(typeof body?.ts === 'string' ? { occurredAt: body.ts } : {}), data });
  let bytes = JSON.stringify(wrap(body));
  if (Buffer.byteLength(bytes, 'utf8') <= LIMIT) return bytes;
  let data = { ...body, truncated: true };
  for (const step of STEPS) {
    for (;;) {
      const next = step(data);
      if (next === null) break;
      data = next;
      bytes = JSON.stringify(wrap(data));
      if (Buffer.byteLength(bytes, 'utf8') <= LIMIT) return bytes;
      if (step !== STEPS[0]) break;
    }
  }
  return null;
}

const readSecret = (secret) => (typeof secret === 'function' ? secret() : secret);

// `secret` may be a function: it is read at every attempt, so a rotated secret
// applies to the next try. The delivery id defaults to the payload event_id.
export async function postJson({ url, body, type = null, secret = null, deliveryId = body?.event_id, timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch, stateDir = null, now = Date.now }) {
  const started = performance.now();
  const timing = () => ({ elapsedMs: Math.round(performance.now() - started), timeoutMs });
  const fail = (error, retryable, extra = {}) => ({ ok: false, status: null, retryable, error, ...extra, ...timing() });
  let abort;
  try {
    if (!Number.isFinite(timeoutMs) || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive finite integer');
    }
    if (typeof deliveryId !== 'string' || !DELIVERY_ID_RE.test(deliveryId)) return fail('bad_delivery_id', false, { dead: true });
    if (!readSecret(secret)) return fail('unsigned', true, { hold: true });
    const bytes = encodeBody(body, { type });
    if (bytes === null) return fail('too_large', false, { dead: true });
    abort = deadline(timeoutMs);
    const send = () => {
      const key = readSecret(secret);
      if (!key) throw Object.assign(new Error('unsigned'), { code: 'UNSIGNED' });
      const sig = sign(key, Math.floor(now() / 1000), deliveryId, bytes);
      const headers = {
        'content-type': 'application/json', 'user-agent': USER_AGENT,
        'x-openbot-timestamp': sig.timestamp, 'x-openbot-delivery-id': sig.deliveryId, 'x-openbot-signature': sig.signature,
      };
      return fetchImpl(url, { method: 'POST', headers, body: bytes, signal: abort.signal });
    };
    const res = await send().catch((err) => { if (!isReset(err)) throw err; recordRetry(stateDir, err); return send(); });
    // A failed body cannot erase an already-known HTTP rejection.
    await res.arrayBuffer().catch((err) => { if (res.ok) throw err; });
    if (res.ok) return { ok: true, status: res.status, retryable: false, error: null, ...timing() };
    return { ok: false, status: res.status, retryable: res.status >= 500 || res.status === 429 || res.status === 408, error: 'HTTP ' + res.status, ...timing() };
  } catch (err) {
    if (err?.code === 'UNSIGNED') return fail('unsigned', true, { hold: true });
    if (err instanceof SignError) return fail(err.code, true);
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return fail(timeout ? 'timeout' : (err?.cause?.code || err?.name || 'network error'), true);
  } finally {
    abort?.clear();
  }
}
