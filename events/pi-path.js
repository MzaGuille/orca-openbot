import { join } from 'node:path';
import { defaultStateDir } from '../core/fsutil.js';

// Reversible encoding prevents separators, colons and dot segments in filenames.
const panePath = (env, paneId, suffix) =>
  join(defaultStateDir(env), 'pi', 'pane-' + Buffer.from(paneId).toString('base64url') + suffix);

export function piRecordPath(env, paneId) {
  return panePath(env, paneId, '.jsonl');
}

// #11 bridge events get their own file: ingest consumes piRecordPath by offset, and rotation would shift it.
export function piBridgePath(env, paneId) {
  return panePath(env, paneId, '.bridge.jsonl');
}

// The pane id is synthetic, 'orca:' + the Orca agent session id.
export const ORCA_PREFIX = 'orca:';
export const isOrcaPane = (paneId) => typeof paneId === 'string' && paneId.startsWith(ORCA_PREFIX);
export function envPaneId(env) {
  // removed: HERDR_PANE_ID, Herdr is gone (plan-orca-openbot §2); only the Orca session id gives a pane.
  return env.ORCA_AGENT_SESSION_ID ? ORCA_PREFIX + env.ORCA_AGENT_SESSION_ID : undefined;
}
