// Review consent (#5): the gentle_review tool answers "consent_required" with a typed JSON envelope
// (schema gentle-ai.review-integration.consent/v2|v3). It is detected from the tool result, never from
// the model's prose. Pure: no filesystem, configuration or network access.

import { sanitizeAttention } from './sanitize.js';

export const REVIEW_TOOL = 'gentle_review';
export const CONSENT_KIND = 'review-consent';
const ANSWERS = ['granted', 'declined'];
// A start/answer-consent result that is not the envelope means the consent was answered or replaced.
const RESOLVING_OPERATIONS = new Set(['start', 'answer-consent']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;

// The tool serializes {operation, status, outcome, consent: <envelope>, consent_binding} into content[].text
// (gentle-pi extensions/gentle-ai.ts); the bare envelope is accepted too.
function resultBodies(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const bodies = [];
  for (const part of content) {
    if (part?.type !== 'text' || typeof part.text !== 'string') continue;
    try { bodies.push(JSON.parse(part.text)); } catch { /* not JSON */ }
  }
  return bodies;
}

// Only a command shaped like the provider's own, ending in the flag of its own answer, is offered.
// The line is run by a person in a shell, so control characters and any other tail are refused.
function invocationFor(choice, answer) {
  const text = choice?.invocation;
  if (typeof text !== 'string' || /[\x00-\x1f\x7f]/.test(text)) return null;
  if (!text.startsWith('gentle-ai review start ') || !text.endsWith(' --consent ' + answer)) return null;
  // Redaction would leave a broken command (a [REDACTED] hole, maybe an open quote): offer none instead.
  return sanitizeAttention(text) === text ? text : null;
}

function fromEnvelope(envelope) {
  if (!isObject(envelope) || envelope.action !== 'consent_required' || !Array.isArray(envelope.choices)) return null;
  const invocations = ANSWERS.map(answer => {
    const matching = envelope.choices.filter(choice => choice?.answer === answer);
    return matching.length === 1 ? invocationFor(matching[0], answer) : null;
  });
  if (invocations.some(invocation => invocation === null)) return null;
  const { headline, risk_level: riskLevel, changed_files: files, changed_lines: lines } = envelope;
  if (typeof headline !== 'string' || !headline.trim() || typeof riskLevel !== 'string' || !riskLevel || !count(files) || !count(lines)) return null;
  return { headline, risk_level: riskLevel, changed_files: files, changed_lines: lines, invocations };
}

/** The envelope carried by a gentle_review result, as {headline, risk_level, changed_files,
 * changed_lines, invocations: [granted, declined]}; null when absent or not exactly as expected. */
export function consentFromResult(result) {
  for (const body of resultBodies(result)) {
    const consent = fromEnvelope(body) ?? fromEnvelope(body?.consent);
    if (consent) return consent;
  }
  return null;
}

/** pendingConsent after a tool_execution_end. Other tools leave it untouched; a successful
 * gentle_review start/answer-consent without the envelope resolves it. */
export function nextPendingConsent(current, event) {
  if (event?.toolName !== REVIEW_TOOL) return current;
  const consent = consentFromResult(event.result);
  if (consent) return consent;
  const resolved = event.isError !== true && resultBodies(event.result).some(body => RESOLVING_OPERATIONS.has(body?.operation));
  return resolved ? null : current;
}

/** The queue question for a settled record's consent, or null when it is not a complete consent. */
export function consentQuestion(consent) {
  if (!isObject(consent) || typeof consent.headline !== 'string' || !consent.headline) return null;
  const [granted, declined] = Array.isArray(consent.invocations) ? consent.invocations : [];
  if (typeof granted !== 'string' || typeof declined !== 'string') return null;
  return { text: consent.headline, options: ['granted: ' + granted, 'declined: ' + declined], selected_index: null, kind: CONSENT_KIND };
}

export const consentSummary = record => {
  const consent = record?.consent ?? {};
  return consent.headline + ' (revisión, riesgo ' + (consent.risk_level ?? '?') + ', ' + (consent.changed_files ?? '?') + ' archivos)';
};
