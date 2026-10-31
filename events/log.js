// Delivery log: `log` from dd7e721 events/hook.js (file renamed hook.log -> events.log), the only generic piece kept from it.
import { appendFileSync, statSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const LOG_MAX_BYTES = 256 * 1024;

export function log(stateDir, message) {
  try {
    const file = join(stateDir, 'events.log');
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, file + '.1');
    } catch {
      // no log yet
    }
    appendFileSync(file, new Date().toISOString() + ' ' + message + '\n', { mode: 0o600 });
  } catch {
    // logging must never break delivery
  }
}
