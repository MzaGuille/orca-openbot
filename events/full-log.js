// events-full.jsonl: every enqueued payload, whole, one JSON line each. Payloads are redacted when
// built (buildPayload with redactionFor(cfg), the same set the webhook path uses), so the line is
// the queued payload as is. events.log stays the short delivery log. Rotates to `.1` by size.
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const FULL_LOG = 'events-full.jsonl';
export const FULL_LOG_MAX_BYTES = 10 * 1024 * 1024;

/** Best effort: a log failure must never stop an event from being queued. */
export function appendFullEvent(stateDir, payload, maxBytes = FULL_LOG_MAX_BYTES) {
  try {
    const file = join(stateDir, FULL_LOG), line = JSON.stringify(payload) + '\n';
    try {
      if (statSync(file).size + Buffer.byteLength(line) > maxBytes) renameSync(file, file + '.1');
    } catch {
      // no log yet
    }
    appendFileSync(file, line, { mode: 0o600 });
  } catch {
    // never break the queue
  }
}
