// Consume complete append-only Pi JSONL records under a per-pane cursor lock.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { detectAll } from '../core/detect.js';
import { loadConfig, validateConfig, redactionFor } from '../core/config.js';
import { defaultStateDir, readJson, writeJson, withLock } from '../core/fsutil.js';
import { CliError, EXIT, invalid } from '../control/errors.js';
import { piRecordPath } from './pi-path.js';
import { isPiTelemetry, validateTelemetryRecord } from './telemetry.js';
import { evaluateSignals, silentCommandFailure } from './attention/evaluate.js';
import { sanitizeAttentionRecord } from './sanitize.js';
import { consentQuestion } from './consent.js';
import { buildPayload, validatePayload } from './payload.js';
import { checkAndRecord, DEBOUNCE_MS, debounceAt } from './debounce.js';
import { enqueue } from './queue.js';
import { piMenuOutsideTurn } from './pi-bridge.js';
import { enqueueStalled } from './stalled.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// removed: Herdr hook, watcher and pane tracking (plan-orca-openbot §3). Only the detached
// flush spawn is kept (inlined from hook.js defaultSpawnFlusher), or queued events never leave.
const BIN = fileURLToPath(new URL('../bin/orca-openbot.js', import.meta.url));
function defaultSpawnFlusher(env) {
  const child = spawn(process.execPath, [BIN, 'flush'], { detached: true, stdio: 'ignore', env });
  child.on('error', () => {});
  child.unref();
}

// The pane is synthesized from the record being ingested.
const orcaStatus = r => r.name === 'agent_settled' ? 'idle'
  : r.name === 'ui_prompt_start' || r.source === 'osc' && r.status === 'blocked' ? 'blocked' : 'working';
const orcaPane = (paneId, r) => ({ pane_id: paneId, workspace_id: 'orca', agent: 'pi',
  cwd: typeof r?.cwd === 'string' ? r.cwd : null, agent_status: orcaStatus(r || {}), protected: false, revision: 0 });
const EMPTY = () => ({ ok: true, processed: 0, queued: 0 });
export function runIngest({ paneId, env = process.env, now = Date.now(), spawnFlusher = defaultSpawnFlusher } = {}) {
  if (!paneId) throw invalid('--pane is required');
  const result = consume({ paneId, env, now, spawnFlusher });
  // A silent turn appends no Pi record, so the stalled check runs after every ingest, with or without new records.
  const stalled = checkStalled({ paneId, env, now });
  if (stalled) spawnFlusher(env);
  return stalled ? { ...result, queued: result.queued + stalled } : result;
}

function checkStalled({ paneId, env, now }) {
  const cfg = loadConfig({ env });
  if (validateConfig(cfg).length) return 0;
  return enqueueStalled({ paneId, env, dir: defaultStateDir(env), cfg, redaction: redactionFor(cfg), now });
}

function consume({ paneId, env, now, spawnFlusher }) {
  const file = piRecordPath(env, paneId), dir = defaultStateDir(env);
  try { readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return EMPTY(); throw error; }
  return withLock(file + '.lock', () => {
    const bytes = readFileSync(file), saved = readJson(file + '.cursor.json', { offset: 0 });
    const offset = Number.isSafeInteger(saved.offset) && saved.offset >= 0 && saved.offset <= bytes.length ? saved.offset : 0;
    const end = bytes.lastIndexOf(10) + 1;
    if (end <= offset) return EMPTY();
    let records;
    try {
      records = bytes.subarray(offset, end).toString('utf8').split('\n').filter(l => l.trim()).map(JSON.parse);
      if (records.some(r => !r || !['pi-ext', 'osc'].includes(r.source) || typeof r.name !== 'string' || !r.name
        || r.pane_id !== paneId || ['isError', 'aborted', 'hadError'].some(k => k in r && typeof r[k] !== 'boolean')
        || isPiTelemetry(r) && validateTelemetryRecord(r).length)) throw new Error();
    } catch { throw invalid('invalid Pi JSONL'); }
    // removed: requirePane / `herdr pane read` (plan-orca-openbot §2); the pane is always synthesized.
    let pane = orcaPane(paneId, records[0]);
    const cfg = loadConfig({ env });
    if (validateConfig(cfg).length) throw new CliError(EXIT.unconfigured, 'unconfigured', 'webhook is not configured');
    const redaction = redactionFor(cfg);
    const clean = value => sanitizeAttentionRecord(value, redaction);
    const trackedId = paneId;
    let queued = 0;
    // removed: panes.json tracking for the watcher (plan-orca-openbot §3), so only this batch feeds since_last_event_s.
    let lastEventAt = null;
    let prev = null;
    const recoveredTool = r => pane.agent_status === 'working' && r?.source === 'pi-ext'
      && r.name === 'tool_execution_end' && r.isError === true
      && silentCommandFailure(r.msg);
    for (const raw of records) {
      pane = orcaPane(paneId, raw);
      const mirroredSelect = raw.source === 'osc' && raw.name === 'program_status' && raw.kind === 'question'
        && prev?.name === 'ui_prompt_start' && prev?.kind === 'select';
      const mirroredConfirm = raw.source === 'osc' && raw.kind === 'permission'
        && prev?.name === 'ui_prompt_start' && prev?.kind === 'confirm';
      // A user Esc abort emits agent_settled{aborted:true}; its osc program_status
      // done mirror carries no aborted flag, so suppress that mirror here (#26).
      const mirroredAbort = raw.source === 'osc' && raw.name === 'program_status' && raw.status === 'done'
        && prev?.name === 'agent_settled' && prev?.aborted === true;
      const mirroredToolRecovery = raw.source === 'osc' && raw.name === 'program_status' && raw.status === 'error'
        && prev?.name === 'tool_execution_end' && prev?.isError === true && (recoveredTool(prev) || !evaluateSignals(prev));
      // The osc mirror of a settled review consent repeats the headline with no options: one event, not two.
      const mirroredConsent = raw.source === 'osc' && raw.name === 'program_status' && raw.kind === 'question'
        && prev?.name === 'agent_settled' && Boolean(consentQuestion(prev.consent));
      prev = raw;
      if (mirroredConsent || mirroredAbort || mirroredToolRecovery || recoveredTool(raw)) continue;
      let attention = evaluateSignals(raw);
      if (!attention) continue;
      // A Pi picker opened after the turn settled (/gentle:profiles) is not a question from the agent.
      // The bridge is read as of this record's own time: ingest runs after the fact.
      if (['question', 'blocked'].includes(attention.attentionKind) && (raw.name === 'ui_prompt_start'
        || raw.source === 'osc' && raw.name === 'program_status') && piMenuOutsideTurn(env, paneId, raw.at)) continue;
      if (attention.attentionKind === 'error' && pane.agent_status === 'working' && !attention.errors?.length) continue;
      const record = clean({ title: typeof raw.title === 'string' ? raw.title : '', msg: typeof raw.msg === 'string' ? raw.msg : '' });
      const metric = isPiTelemetry(raw);
      // removed: screen reading and menu parsing (plan-orca-openbot §3); a question never carries parsed options.
      let question = null;
      const promptKind = raw.kind === 'select' || raw.kind === 'confirm' ? raw.kind : mirroredSelect ? 'select' : mirroredConfirm ? 'confirm' : '';
      if (promptKind === 'select') {
        question = clean({ text: record.title || 'Agent is asking a question', options: [], selected_index: null });
        attention = { ...attention, attentionKind: 'question', state: 'question' };
      } else if (promptKind === 'confirm') {
        // Confirm stays blocked and carries no question.
      } else if (attention.id === 'pi-review-consent' && consentQuestion(raw.consent)) {
        // gentle_review asked for consent: the question carries both ready commands.
        question = clean(consentQuestion(raw.consent));
        attention = { ...attention, signal: 'pi-review-consent' };
      } else if (attention.attentionKind === 'question' && raw.name === 'agent_settled' && typeof raw.question === 'string') {
        // The extension already captured the trailing question.
        question = clean({ text: raw.question, options: [], selected_index: null });
        attention = { ...attention, signal: 'pi-settled-question' };
      } else if (attention.attentionKind === 'question') {
        question = clean({ text: record.title || 'Agent is asking a question', options: [], selected_index: null });
      }
      const menu = question && Array.isArray(question.options) ? { text: question.text, options: question.options } : null;
      const signature = metric ? createHash('sha256').update(JSON.stringify([
        'pi-telemetry', raw.session_id, raw.entry_id, raw.name, raw.telemetry.level ?? null, raw.telemetry.threshold ?? null,
      ])).digest('hex') : attention.state + (menu ? '|' + createHash('sha256').update(JSON.stringify(menu)).digest('hex') : '');
      const det = detectAll();
      const payload = buildPayload({ host: det.host, machineLabel: cfg.machineLabel, os: det.os,
        pluginVersion: det.plugin_version,
        workspaceId: pane.workspace_id || 'unknown',
        workspaceName: (pane.cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || null, paneId, agent: pane.agent || 'pi',
        state: attention.state, attentionKind: attention.attentionKind, signal: attention.signal || null,
        cwd: pane.cwd || raw.cwd || null, project: (pane.cwd || raw.cwd || '').split(/[\\/]/).filter(Boolean).at(-1) || null,
        question, errors: attention.errors || [],
        summary: attention.summary || record.msg || record.title || null,
        ...(metric ? { telemetry: raw.telemetry } : {}),
        ...redaction, now: new Date(now), sinceLastEvent: lastEventAt });
      if (validatePayload(payload).length) throw invalid('invalid Pi attention payload');
      withLock(join(dir, 'debounce.lock'), () => {
        const file = join(dir, 'debounce.json'), store = readJson(file, {});
        for (const [key, value] of Object.entries(store)) {
          const ts = debounceAt(value);
          if (ts === null || now - ts >= DEBOUNCE_MS || ts > now) delete store[key];
        }
        const admitted = checkAndRecord(store, trackedId, signature, now, DEBOUNCE_MS);
        if (admitted) {
          // Only durable queue admission may suppress a later consume attempt.
          enqueue(dir, payload, now); queued++;
          lastEventAt = now;
        }
        // removed: recordQuestion for send --index (plan-orca-openbot §2).
        writeJson(file, store);
      });
    }
    writeJson(file + '.cursor.json', { offset: end });
    if (queued) spawnFlusher(env);
    return { ok: true, processed: records.length, queued };
  });
}
