// Pure redaction shared by payload construction and runtime persistence.
import { stripAnsi } from './text.js';

const REDACTED = '[REDACTED]';
// Credential words match anywhere in an identifier: GITHUB_TOKEN, clientSecret, DB_PASSWORD, Cookie.
const WORDS = String.raw`authorization|x-api-key|api[-_]?key|access[-_]?key|private[-_]?key|auth[-_]?token|token|secret|password|passwd|credential|cookie`;
const CREDENTIAL_NAME = new RegExp(WORDS, 'i');
// Quoted values may contain escaped quotes; unquoted values run to the end of the field.
const VALUE = String.raw`(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\n,;}]+)`;
const ASSIGNMENT = new RegExp(String.raw`(?<![A-Za-z0-9_.-])["']?[A-Za-z0-9_.-]*?(?:${WORDS})[A-Za-z0-9_.-]*["']?\s*[=:]\s*${VALUE}`, 'gi');
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi;
const TOKEN = /\b(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gi;

// Any webhook signing secret, configured or not (OpenBot: whsec_ + base64url).
const WHSEC = /whsec_[A-Za-z0-9_-]+/gi;

const clean = (value) => stripAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Only for caller-owned schema records: field names are part of the protocol.
// Arbitrary data (including raw hook events) must still use sanitizeAttention.
export function sanitizeAttentionRecord(record, options = {}) {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, sanitizeAttention(value, options)]));
}

export function sanitizeAttention(value, { secrets = [], sensitiveNames = [] } = {}) {
  const secretValues = secrets.filter((v) => typeof v === 'string' && v).map(clean).filter(Boolean).sort((a, b) => b.length - a.length);
  const names = sensitiveNames.filter((v) => typeof v === 'string' && v).map(clean).filter(Boolean);
  function redact(text) {
    let result = clean(text);
    // Known values first: a pattern rule could otherwise cut a configured secret at , ; or } and leak the rest.
    for (const secret of secretValues) result = result.split(secret).join(REDACTED);
    // Then complete sensitive assignments, before replacing individual names.
    for (const name of names) {
      const assignment = new RegExp(String.raw`["']?${escapeRegex(name)}["']?\s*[=:]\s*${VALUE}`, 'gi');
      result = result.replace(assignment, REDACTED);
    }
    result = result.replace(ASSIGNMENT, REDACTED).replace(WHSEC, REDACTED).replace(URL, REDACTED).replace(TOKEN, REDACTED);
    for (const name of names) result = result.replace(new RegExp(escapeRegex(name), 'gi'), REDACTED);
    return result.replace(/\b(?:authorization|proxy-authorization|x-api-key)\b/gi, REDACTED);
  }
  function visit(input) {
    if (typeof input === 'string') return redact(input);
    if (Array.isArray(input)) return input.map(visit);
    if (input && typeof input === 'object') {
      const entries = Object.entries(input).filter(([key]) => {
        const normalized = clean(key);
        return !CREDENTIAL_NAME.test(normalized) && !names.some((name) => name.toLowerCase() === normalized.toLowerCase());
      });
      return Object.fromEntries(entries.map(([key, item]) => [redact(key), visit(item)]));
    }
    return input;
  }
  return visit(value);
}
