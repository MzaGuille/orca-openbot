// status, test-event and doctor. Output never contains the key or the URL path.
import { writeFileSync, unlinkSync, statSync, readFileSync, readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { hostname as osHostname } from 'node:os';
import { detectAll, pluginVersion } from '../core/detect.js';
import { loadConfig, validateConfig, publicView, redactUrl, SECRET_KEY, SECRET_RE } from '../core/config.js';
import { isRouted, resolveTarget, routesView, routeSecretKey } from '../core/routes.js';
import { defaultStateDir, ensurePrivateDir } from '../core/fsutil.js';
import { readBridge, bridgeLiveness, bridgePanePath, pidAlive, heartbeatAgeSeconds } from '../events/pi-bridge.js';
const MAX_FILE_BYTES = 1024 * 1024;
// events-full.jsonl rotates at 10 MiB; read a whole file so a busy pane cannot push another pane's last event out of view.
const FULL_LOG_READ_BYTES = 11 * 1024 * 1024;
import { existsSync } from 'node:fs';
import { buildPayload, validatePayload, NOTIFY_STATES } from '../events/payload.js';
import { postJson, immediateRetries } from '../events/webhook.js';
import { queueStats } from '../events/queue.js';
import { CliError, EXIT, invalid } from './errors.js';
import { sign, DELIVERY_ID_RE } from '../core/sign.js';
import { listOrderProblems, cleanupOrders } from './orders.js';
import { bridgeStaleMs, bridgeIsStale, quietMs, quietPanes } from './bridges.js';

export const VERSION = pluginVersion();
// removed: Herdr plugin link status (plan-orca-openbot §3).

const SHA_RE = /^[0-9a-f]{40}$/;
// removed: installed-commit and Pi settings.json extension probes, process-extension drift
// checks (plan-orca-openbot §3); the live extension is read from each pane's bridge.

function recentEvents(stateDir) {
  try {
    return readFileSync(join(stateDir, 'events.log'), 'utf8').trim().split('\n').filter((l) => / queued /.test(l)).slice(-5);
  } catch {
    return [];
  }
}

export function status({ env = process.env } = {}) {
  const stateDir = defaultStateDir(env);
  const cfg = loadConfig({ env });
  return {
    ok: true,
    version: VERSION,
    config: publicView(cfg),
    config_errors: validateConfig(cfg),
    detect: detectAll(),
    state_dir: stateDir,
    queue: queueStats(stateDir),
    recent_events: recentEvents(stateDir),
  };
}

function testPayload(state, cfg, det, workspace = null, eventId = null) {
  return buildPayload({
    ...(eventId ? { eventId } : {}),
    host: det.host,
    machineLabel: cfg.machineLabel || det.host.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 32) || 'machine',
    os: det.os,
    pluginVersion: det.plugin_version,
    workspaceId: 'test',
    workspaceName: workspace ?? 'orca-openbot test',
    paneId: 'test:p0',
    agent: 'orca-openbot-test',
    state,
    summary: state === 'done' || state === 'error' ? 'Test event from orca-openbot' : null,
    question: state === 'question' ? { text: 'Test question from orca-openbot?', options: ['Yes', 'No'] } : null,
    lastLines: ['orca-openbot test event (' + state + ')'],
  });
}

export async function testEvent({ env = process.env, state = 'done', workspace = null, eventId = null } = {}) {
  if (!NOTIFY_STATES.includes(state)) throw invalid('--state must be one of ' + NOTIFY_STATES.join(', '));
  // A fixed id replays the same delivery (OpenBot answers 200 to a duplicate).
  if (eventId !== null && (typeof eventId !== 'string' || !DELIVERY_ID_RE.test(eventId) || !UUID_RE.test(eventId))) throw invalid('--event-id must be a lowercase UUID');
  if (workspace !== null && (typeof workspace !== 'string' || !workspace.trim())) throw invalid('--workspace must be a non-empty name');
  const cfg = loadConfig({ env });
  const errors = validateConfig(cfg);
  if (errors.length) throw new CliError(EXIT.unconfigured, 'unconfigured', 'webhook is not configured', { errors });
  const det = detectAll();
  const payload = testPayload(state, cfg, det, workspace, eventId);
  const bad = validatePayload(payload);
  if (bad.length) throw new CliError(EXIT.failed, 'invalid_payload', bad.join('; '));
  // Same routing as real events (#103); without OPENBOT_ORCA_ROUTES this is the single webhook.
  const target = resolveTarget(cfg, payload.workspace_name);
  if (!target) throw new CliError(EXIT.unconfigured, 'unconfigured', 'no route matches the workspace and OPENBOT_ORCA_WEBHOOK_URL is not set', { workspace: payload.workspace_name });
  const route = target.route === null ? {} : { route: target.route };
  const r = await postJson({ url: target.url, type: 'orca.test', secret: target.secret, body: payload, timeoutMs: cfg.timeoutMs, stateDir: defaultStateDir(env) });
  const timing = { elapsedMs: r.elapsedMs, timeoutMs: r.timeoutMs };
  const machine = machineMetadata(payload);
  const body = { ok: r.ok, event_id: payload.event_id, state, webhook: redactUrl(target.url), ...route, status: r.status, ...timing, ...machine };
  if (!r.ok) throw new CliError(EXIT.failed, 'webhook_error', r.error, { event_id: payload.event_id, webhook: redactUrl(target.url), ...route, status: r.status, error: r.error, ...timing, ...machine });
  return body;
}

function machineMetadata(payload) {
  const { machine_label, host, os, plugin_version } = payload;
  return { machine_label, host, os, plugin_version };
}

const check = (name, status, detail) => ({ name, status, detail });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Contract §1.2 example vector (the body's old herdr.done type is part of the signed bytes, kept as is): proves the local HMAC matches OpenBot without a request.
const VECTOR = {
  secret: 'whsec_dGVzdC1zZWNyZXQtbm90LXJlYWwtMDEyMzQ1Njc4OWFi', // gitleaks:allow (public contract test vector)
  ts: 1761436800,
  id: '3f2b8c1e-0d4a-4b7e-9c11-2a6f5e7d8b90',
  body: '{"type":"herdr.done","occurredAt":"2025-10-26T00:00:00Z","data":{"pane_id":"w1-p2","state":"done"}}',
  signature: 'sha256=187cba04a689cef55b63d5b7dc5b12c77f6cedff1b2b1b221851c79576410d57',
};

// Secret presence/format per configured target (variable names only), then the local signature.
function signingChecks(cfg) {
  const targets = [];
  if (cfg.url || !isRouted(cfg) || cfg.secret) targets.push([SECRET_KEY, cfg.secret]);
  if (isRouted(cfg)) {
    const seen = new Set();
    for (const r of cfg.routes) {
      if (seen.has(r.name) || !(r.url || r.secret)) continue;
      seen.add(r.name);
      targets.push([routeSecretKey(r.name), r.secret]);
    }
  }
  const problems = targets.flatMap(([name, secret]) => (!secret ? [name + ' is not set']
    : !SECRET_RE.test(secret) ? [name + ' is not a valid secret (expected whsec_ followed by 43 base64url characters)'] : []));
  const out = [check('secret', problems.length ? 'fail' : 'ok', problems.length ? problems.join('; ')
    : targets.length + ' signing secret(s) set')];
  let local;
  try { local = sign(VECTOR.secret, VECTOR.ts, VECTOR.id, VECTOR.body).signature === VECTOR.signature; } catch { local = false; }
  out.push(check('signature', local ? 'ok' : 'fail', local ? 'local signature matches the contract vector' : 'local signature does not match the contract vector'));
  return out;
}

function readLines(path, maxBytes) {
  return readBounded(path, maxBytes).split('\n').filter((l) => l.trim());
}

// Last `sent` in events.log (and its rotation) in epoch ms; lines start with an ISO time.
function lastSentAt(stateDir) {
  let last = null;
  for (const file of ['events.log.1', 'events.log']) {
    for (const line of readLines(join(stateDir, file), MAX_FILE_BYTES)) {
      const m = /^(\S+) sent /.exec(line);
      const at = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(at) && (last === null || at > last)) last = at;
    }
  }
  return last;
}

// Offline view of the last rejections in dead.jsonl: a 401 after the last sent is a
// fail (stale secret or clock skew); a 413/too_large after it is a warning.
function deliveryCheck(stateDir) {
  let last401 = null;
  let lastLarge = null;
  for (const line of readLines(join(stateDir, 'dead.jsonl'), MAX_FILE_BYTES)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const at = Number(e?.dead_at);
    if (!Number.isFinite(at)) continue;
    if (e.status === 401 && (last401 === null || at > last401)) last401 = at;
    if ((e.status === 413 || e.last_error === 'too_large') && (lastLarge === null || at > lastLarge)) lastLarge = at;
  }
  const sent = lastSentAt(stateDir);
  const after = (at) => at !== null && (sent === null || at > sent);
  const iso = (at) => new Date(at).toISOString();
  if (after(last401)) return check('delivery', 'fail', 'HTTP 401 at ' + iso(last401) + ' after the last sent event: secreto viejo o reloj corrido (stale secret or clock skew)');
  if (after(lastLarge)) return check('delivery', 'warn', 'event too large for OpenBot (HTTP 413 or too_large) at ' + iso(lastLarge) + ' after the last sent event');
  return check('delivery', 'ok', sent === null ? 'no rejected deliveries' : 'last sent ' + iso(sent));
}




const BRIDGE_TAIL_BYTES = 64 * 1024;
function readBounded(path, maxBytes) {
  try {
    const st = statSync(path);
    const size = st.size;
    if (size === 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, len, start); } finally { closeSync(fd); }
    let text = buf.toString('utf8');
    const nl = text.indexOf('\n');
    if (start > 0 && nl !== -1) text = text.slice(nl + 1);
    return text;
  } catch { return ''; }
}
function readTail(path) { return readBounded(path, BRIDGE_TAIL_BYTES); }

// One pane's bridge health; send's order path asks this same question.
export function paneBridge(pane, main, now = Date.now(), isPidAlive = pidAlive) {
  const rotated = main + '.1';
  let text = readTail(main);
  if (!text.includes('"session_start"')) {
    const full = readBounded(main, MAX_FILE_BYTES);
    if (full.includes('"session_start"')) text = full;
  }
  if (!text.includes('"session_start"') && existsSync(rotated)) text = readTail(rotated) + text;
  const summary = readBridge(text);
  const state = bridgeLiveness(summary, isPidAlive, now);
  const age = heartbeatAgeSeconds(summary, now);
  const pid = summary.heartbeat?.detail?.pid ?? summary.start?.detail?.pid ?? null;
  const sessionId = summary.start?.detail?.session_id ?? null;
  const bridgeOk = state === 'alive' && age !== null && age < 600;
  // The configured checkout (piExt above) is not evidence of what Pi loaded.
  const loaded = summary.start?.detail?.pi_extension;
  const piExtension = {
    version: typeof loaded?.version === 'string' && loaded.version ? loaded.version : 'unknown',
    commit: SHA_RE.test(loaded?.commit || '') ? loaded.commit : 'unknown',
  };
  return { pane, bridge: bridgeOk, state, session_id: sessionId, pid, heartbeat_age_s: age, schema_version: 1, pi_extension: piExtension };
}

export function paneBridgeStatus(env, pane) {
  return paneBridge(pane, bridgePanePath(env, pane));
}

// removed: processExtensionCommit, process-extension drift check (plan-orca-openbot §3).

// Resolved at call time, never cached: a renamed machine shows its new name at once.
const resolvedHost = read => { try { return read() || null; } catch { return null; } };

export async function doctor({ env = process.env, json = false, now = Date.now(),
  isPidAlive = pidAlive, hostname = osHostname,
} = {}) {
  const checks = [];

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(check('node', nodeMajor >= 20 ? 'ok' : 'fail', 'node ' + process.versions.node + (nodeMajor >= 20 ? '' : ' (need >= 20)')));
  // removed: Herdr binary, server and plugin checks (plan-orca-openbot §3).

  const cfg = loadConfig({ env });
  const errors = validateConfig(cfg);
  if (errors.length) checks.push(check('config', 'fail', errors.join('; ')));
  else if (!isRouted(cfg)) checks.push(check('config', 'ok', 'webhook ' + redactUrl(cfg.url) + ', secret set' + (cfg.machineLabel ? ', machine_label ' + cfg.machineLabel : '')));
  else checks.push(check('config', 'ok', (cfg.url ? 'default webhook ' + redactUrl(cfg.url) + ', secret set'
    : 'no default webhook (events matching no route are dropped)') + (cfg.machineLabel ? ', machine_label ' + cfg.machineLabel : '')));
  // #103: prefix routes, by variable state only (set|unset), never values.
  const routes = routesView(cfg);
  if (routes) {
    const status = routes.some((r) => r.url === 'unset' || r.secret === 'unset') || cfg.routeErrors.length ? 'fail' : 'ok';
    checks.push(check('routes', status, routes.length
      ? routes.map((r) => r.prefix + ' -> ' + r.route + ' (url ' + r.url + ', secret ' + r.secret + ')').join('; ')
      : 'OPENBOT_ORCA_ROUTES has no valid routes'));
  }

  if (cfg.fileStatus === 'ok') checks.push(check('config_permissions', 'ok', cfg.file + ': ' + cfg.fileDetail));
  else if (cfg.fileStatus === 'missing') checks.push(check('config_permissions', 'ok', 'no config file (' + cfg.file + '); using environment'));
  else checks.push(check('config_permissions', 'fail', cfg.file + ' ' + cfg.fileStatus + ': ' + (cfg.fileDetail || '') + ' (file ignored)'));

  const stateDir = defaultStateDir(env);
  try {
    ensurePrivateDir(stateDir);
    const probe = join(stateDir, '.doctor-probe');
    writeFileSync(probe, 'ok', { mode: 0o600 });
    unlinkSync(probe);
    const mode = statSync(stateDir).mode & 0o777;
    const open = mode & 0o077;
    checks.push(check('state_dir', open ? 'warn' : 'ok', stateDir + (open ? ' is mode ' + mode.toString(8) + ' (chmod 700 recommended)' : ' writable')));
  } catch (err) {
    checks.push(check('state_dir', 'fail', stateDir + ' not writable (' + (err.code || 'error') + ')'));
  }
  // removed: watcher, watchers, panes.json state file and storm checks (plan-orca-openbot §3).

  // D7: doctor never touches the network; test-event is the explicit probe.
  checks.push(...signingChecks(cfg));
  checks.push(deliveryCheck(stateDir));
  checks.push(check('webhook', 'skip', errors.length ? 'skipped: config invalid'
    : 'not contacted: doctor is offline (test-event sends a signed test event)'));
  const webhookImmediateRetries = immediateRetries(stateDir);
  checks.splice(checks.length - 1, 0, check('webhook_retries', 'ok', 'immediate reset retries: ' + webhookImmediateRetries));
  // Extension alive per pane: one entry per bridge file (removed: Herdr live-pane list, plan-orca-openbot §3).
  const bridgeDir = join(stateDir, 'pi');
  let files = [];
  try { files = readdirSync(bridgeDir).filter((f) => f.startsWith('pane-') && f.endsWith('.bridge.jsonl')); } catch { files = []; }
  const bridge = files.map((f) => {
    const pane = Buffer.from(f.slice('pane-'.length, -'.bridge.jsonl'.length), 'base64url').toString('utf8');
    return paneBridge(pane, join(bridgeDir, f), now, isPidAlive);
  }).filter((b) => b.state !== 'closed' && b.state !== 'dead');
  const stale = bridge.filter((b) => bridgeIsStale(b, bridgeStaleMs(env)));
  checks.push(check('pi_extension', stale.length ? 'warn' : 'ok', bridge.length
    ? bridge.length + ' live Pi extension(s): ' + bridge.map((b) => b.pane + ' ' + b.state).join(', ') : 'no live Pi extension'));
  if (stale.length) checks.push(check('bridge_stale', 'warn', 'Pi bridge heartbeat older than ' + Math.round(bridgeStaleMs(env) / 1000) + 's on pane(s): ' + stale.map((b) => b.pane + ' (' + (b.heartbeat_age_s === null ? 'no heartbeat' : b.heartbeat_age_s + 's') + ')').join(', ')));
  // #4: panes with a live heartbeat that enqueued nothing for N minutes (events-full.jsonl is the only per-pane record).
  const quiet = quietPanes({ bridge, now, windowMs: quietMs(env),
    lines: ['events-full.jsonl.1', 'events-full.jsonl'].flatMap((f) => readLines(join(stateDir, f), FULL_LOG_READ_BYTES)) });
  if (quiet.length) checks.push(check('quiet_panes', 'warn', 'live Pi pane(s) with no enqueued event in the last ' + Math.round(quietMs(env) / 60000) + ' min: '
    + quiet.map((q) => q.pane + (q.last_event_age_s === null ? ' (never)' : ' (' + q.last_event_age_s + 's ago)')).join(', ')));
  cleanupOrders(stateDir, now);
  const orders = listOrderProblems(stateDir, now);
  if (orders.length) checks.push(check('orders', 'warn', orders.map((o) => o.pane + ' ' + o.event_id + ' ' + o.state + ' ' + o.age_s + 's').join('; ')));
  return { ok: !checks.some((c) => c.status === 'fail'), checks, bridge, quiet_panes: quiet, orders,
    webhook_immediate_retries: webhookImmediateRetries, plugin_version: VERSION, ...(routes ? { routes } : {}),
    // #90: host is the same runtime-resolved label as machine_label (config label, else hostname), like events.
    host: cfg.machineLabel || resolvedHost(hostname), machine_label: cfg.machineLabel || resolvedHost(hostname), machine_label_source: cfg.machineLabel ? 'config' : 'hostname', state_dir: stateDir, webhook_secret_source: cfg.sources.secret ?? null };
}
