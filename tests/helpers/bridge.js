import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bridgePanePath } from '../../events/pi-bridge.js';

export function writeBridgeLines(stateDir, pane, records) {
  const env = { OPENBOT_ORCA_STATE_DIR: stateDir };
  const file = bridgePanePath(env, pane);
  mkdirSync(dirname(file), { recursive: true });
  const normalized = records.map((r) => {
    if (r && r.detail) return r;
    const { session_id, pid, ...rest } = r || {};
    if (session_id !== undefined || pid !== undefined) {
      return { ...rest, detail: { session_id, pid } };
    }
    return r;
  });
  writeFileSync(file, normalized.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
