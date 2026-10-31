// Answers an Orca pane: free text through an acknowledged order to the Pi extension.
// removed: send --option/--index/--enter/--interrupt, the Herdr keystroke fallback, claimEvent,
// paste files and questions.json (plan-orca-openbot §2/§3): send is bridge-only.
import { CliError, EXIT, invalid } from './errors.js';
import { isOrcaPane } from '../events/pi-path.js';
import { paneBridgeStatus } from './diagnostics.js';
import { orderStateDir, writeOrder, ackMs, recordSize, waitForAck, cancelOrder, cleanupOrders } from './orders.js';

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sendToPane({ paneId, text = null, eventId = null, env = process.env, sleep = defaultSleep, now = Date.now, beforeCancel = null, orderRename = undefined }) {
  if (text === null) throw invalid('send needs --text');
  const needs = 'orca pane needs the Pi extension';
  if (!isOrcaPane(paneId)) throw invalid('--pane must be orca:<ORCA_AGENT_SESSION_ID>');
  if (!eventId) throw invalid(needs + ': --event-id is required with --text');
  if (!paneBridgeStatus(env, paneId).bridge) throw invalid(needs);
  const delivered = deliverOrder({ stateDir: orderStateDir(env), paneId, eventId, text, env, sleep, now, beforeCancel, orderRename });
  if (!delivered) throw invalid(needs + ': order not acknowledged');
  return delivered;
}

// Bridge order: ack -> delivered. No ack -> cancel by rename; only a successful
// cancel returns null (the caller reports "not acknowledged"). ENOENT means the
// extension claimed it: wait for its ack.
function deliverOrder({ stateDir, paneId, eventId, text, env, sleep, now, beforeCancel, orderRename }) {
  cleanupOrders(stateDir, now());
  const offset = recordSize(env, paneId);
  const timeoutMs = ackMs(env);
  const file = writeOrder(stateDir, { paneId, eventId, text, now: now(), ackWindowMs: timeoutMs });
  const done = (ack) => ({ ok: true, action: 'text', pane_id: paneId, delivered: 'bridge', duplicate: ack.duplicate });
  const ack = waitForAck(env, paneId, eventId, offset, { timeoutMs, now, sleep });
  if (ack) return done(ack);
  const outcome = cancelOrder(file, { sleep, beforeRename: beforeCancel, rename: orderRename });
  if (outcome === 'cancelled') return null;
  // 'blocked' (cancel kept failing) is as unsafe as 'taken': the extension may still
  // claim the file. The expired order is marked stale by it.
  const unacked = () => new CliError(EXIT.failed, 'order_unacked', 'order ' + eventId + ' was not acknowledged and could not be cancelled', { code: 'order_unacked', event_id: eventId });
  if (outcome === 'blocked') throw unacked();
  const late = waitForAck(env, paneId, eventId, offset, { timeoutMs, now, sleep });
  if (late) return done(late);
  throw new CliError(EXIT.failed, 'order_unacked', 'order ' + eventId + ' was claimed but not acknowledged', { code: 'order_unacked', event_id: eventId });
}
