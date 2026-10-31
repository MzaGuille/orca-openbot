// Reduced prune (plan-orca-openbot §2): only the per-pane bridge state is kept.
// removed: panes.json pruning, `agent list` lookups, pending-alert checks and the opaque pane
// keys, all of them Herdr watcher bookkeeping (plan-orca-openbot §3).
import { readFileSync } from 'node:fs';
import { bridgePanePath, readBridge, bridgeLiveness, pidAlive } from './pi-bridge.js';

const readText = (file) => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };

// none | closed | dead | stale | alive for one pane id.
export function paneBridgeState(env, paneId, isAlive = pidAlive, now = Date.now()) {
  const file = bridgePanePath(env, paneId);
  return bridgeLiveness(readBridge(readText(file + '.1') + readText(file)), isAlive, now);
}
