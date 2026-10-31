// Pi writes local records; only the plugin subprocess can enqueue network delivery.
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir, ensurePrivateDir } from '../core/fsutil.js';
import { envVar } from '../core/env.js';
import { sanitizeAttentionRecord } from '../events/sanitize.js';
import { createPiEventNormalizer } from './events.js';
import { piRecordPath, envPaneId } from '../events/pi-path.js';
import { SCHEMA_VERSION } from '../events/pi-bridge.js';
import { createPiTelemetry } from './telemetry.js';
import { sanitizeTelemetry } from '../events/telemetry.js';
export { piRecordPath } from '../events/pi-path.js';

const BIN = fileURLToPath(new URL('../bin/orca-openbot.js', import.meta.url));
function spawnIngest(env, paneId) {
  const child = spawn(process.execPath, [BIN, 'ingest', '--pane=' + paneId], { env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
export function registerPiAttention(pi, { env = process.env, now = Date.now, spawnIngest: schedule = spawnIngest } = {}) {
  const normalize = createPiEventNormalizer();
  let sessionId = null;
  let modelRegistry;
  const telemetry = createPiTelemetry({
    infoPercent: Number(envVar(env, 'OPENBOT_ORCA_CONTEXT_INFO_PERCENT') ?? 50),
    warnPercent: Number(envVar(env, 'OPENBOT_ORCA_CONTEXT_WARN_PERCENT') ?? 80),
    models: { getModel: (provider, model) => modelRegistry?.find?.(provider, model) },
  });
  const append = (records, ctx, session) => {
    const paneId = envPaneId(env);
    const sanitized = records.map(record => {
      const result = sanitizeAttentionRecord({
        ...record, schema_version: SCHEMA_VERSION, event_id: randomUUID(),
        pane_id: paneId, session_id: session, cwd: ctx.cwd, at: now(),
      });
      if (record.telemetry) result.telemetry = sanitizeTelemetry(record.telemetry, record.name);
      return result;
    });
    const file = piRecordPath(env, paneId);
    ensurePrivateDir(join(defaultStateDir(env), 'pi'));
    appendFileSync(file, sanitized.map(r => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
  };
  const observe = (event, ctx) => {
    const paneId = envPaneId(env);
    if (!paneId) return;
    try {
      const session = ctx.sessionManager.getSessionId();
      if (session !== sessionId) { normalize({ type: 'session_start' }); sessionId = session; }
      if (event.type === 'session_start') {
        const entries = ctx.sessionManager.getEntries?.();
        if (entries?.length) telemetry.seedContext({ sessionId: session, entries, contextUsage: ctx.getContextUsage?.() });
      }
      const records = normalize(event);
      if (!records.length) return;
      append(records, ctx, session);
      schedule(env, paneId);
    } catch {
      // An unavailable state directory or scheduler must never interrupt Pi.
    }
  };
  const turnEnd = (event, ctx) => {
    const paneId = envPaneId(env);
    if (!paneId) return;
    try {
      const session = ctx.sessionManager.getSessionId();
      const entries = ctx.sessionManager.getEntries?.();
      if (!Array.isArray(entries) || !entries.some(entry => entry?.id === event.messageEntryId)) return;
      modelRegistry = ctx.modelRegistry;
      const proposal = telemetry.prepareTurn({ sessionId: session, entryId: event.messageEntryId,
        entries, contextUsage: ctx.getContextUsage?.() });
      // An empty append also verifies storage before committing a silent turn
      // that rearms thresholds. Scheduling failure cannot undo durable admission.
      append(proposal.records, ctx, session);
      proposal.commit();
      if (proposal.records.length) schedule(env, paneId);
    } catch {
      // Optional/missing APIs, filesystem and scheduler failures never break Pi.
    }
  };
  const unsubscribe = ['session_start', 'agent_start', 'ui_prompt_start', 'ui_prompt_end',
    'tool_execution_end', 'message_end', 'session_compact_failed', 'agent_settled'].map(name => pi.on(name, observe));
  unsubscribe.push(pi.on('turn_end', turnEnd));
  return () => unsubscribe.forEach(fn => fn());
}
