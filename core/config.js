// Webhook configuration: environment first, then a private config.env file.
// Secrets are never logged; use publicView() for anything printed.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { envVar } from './env.js';
import { ROUTES_KEY, parseRoutes, routeUrlKey, routeSecretKey, isRouted, routesView } from './routes.js';

export const SECRET_KEY = 'OPENBOT_ORCA_WEBHOOK_SECRET';
export const SECRET_RE = /^whsec_[A-Za-z0-9_-]{43}$/;
export const SIGNATURE_HEADERS = ['x-openbot-timestamp', 'x-openbot-delivery-id', 'x-openbot-signature'];
export const KEYS = ['OPENBOT_ORCA_WEBHOOK_URL', SECRET_KEY, 'OPENBOT_ORCA_MACHINE_LABEL', 'OPENBOT_ORCA_TIMEOUT_MS'];
const FIELD = {
  OPENBOT_ORCA_WEBHOOK_URL: 'url',
  OPENBOT_ORCA_WEBHOOK_SECRET: 'secret',
  OPENBOT_ORCA_MACHINE_LABEL: 'machineLabel',
  OPENBOT_ORCA_TIMEOUT_MS: 'timeoutMs',
};
export const DEFAULT_TIMEOUT_MS = 30000;
export const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function defaultConfigPath(env = process.env) {
  const forced = envVar(env, 'OPENBOT_ORCA_CONFIG_FILE');
  if (forced) return forced;
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'orca-openbot', 'config.env');
}

// KEY=VALUE lines only. Nothing is executed or expanded.
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

// removed: Windows ACL/SDDL checks (plan-orca-openbot §3)
export function checkFilePermissions(file) {
  try {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) return { ok: false, detail: 'mode ' + mode.toString(8) + ' is readable by others (run chmod 600)' };
    return { ok: true, detail: 'mode ' + mode.toString(8) };
  } catch (err) {
    return { ok: false, detail: err.code || 'stat failed' };
  }
}

export function loadConfig({ env = process.env, checkPerms = checkFilePermissions, readFile = readFileSync } = {}) {
  const file = defaultConfigPath(env);
  let fileValues = {};
  let fileStatus = 'missing';
  let fileDetail = null;
  let text = null;
  try {
    text = readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fileStatus = 'unreadable';
      fileDetail = err.code || 'read failed';
    }
  }
  if (text !== null) {
    const perms = checkPerms(file);
    if (perms.ok) {
      fileValues = parseEnvFile(text);
      fileStatus = 'ok';
    } else {
      fileStatus = 'insecure';
    }
    fileDetail = perms.detail;
  }
  const cfg = { url: null, secret: null, machineLabel: null, timeoutMs: DEFAULT_TIMEOUT_MS, file, fileStatus, fileDetail, sources: {} };
  for (const name of KEYS) {
    const field = FIELD[name];
    const fromEnv = envVar(env, name);
    const fromFile = envVar(fileValues, name);
    if (fromEnv || (field === 'timeoutMs' && fromEnv !== undefined)) {
      cfg[field] = fromEnv;
      cfg.sources[field] = 'env';
    } else if (fromFile || (field === 'timeoutMs' && fromFile !== undefined)) {
      cfg[field] = fromFile;
      cfg.sources[field] = 'file';
    } else {
      cfg.sources[field] = field === 'timeoutMs' ? 'default' : null;
    }
  }
  cfg.timeoutMs = Number(cfg.timeoutMs);
  // Optional prefix routes (#103). Unset: cfg is exactly as before (no new fields).
  const pick = (name) => (envVar(env, name) ? [envVar(env, name), 'env'] : envVar(fileValues, name) ? [envVar(fileValues, name), 'file'] : [null, null]);
  const [routesText, routesSource] = pick(ROUTES_KEY);
  if (routesText !== null) {
    const parsed = parseRoutes(routesText);
    cfg.routes = parsed.routes.map((r) => {
      const [url, urlSource] = pick(routeUrlKey(r.name));
      const [secret, secretSource] = pick(routeSecretKey(r.name));
      return { ...r, url, secret, sources: { url: urlSource, secret: secretSource } };
    });
    cfg.routeErrors = parsed.errors;
    cfg.sources.routes = routesSource;
  }
  return cfg;
}

function secretErrors(name, secret) {
  if (!secret) return [name + ' is not set'];
  if (!SECRET_RE.test(secret)) return [name + ' is not a valid secret (expected whsec_ followed by 43 base64url characters)'];
  return [];
}

function urlErrors(name, url) {
  let u = null;
  try {
    u = new URL(url);
  } catch {
    return [name + ' is not a valid URL'];
  }
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))) {
    return [name + ' must use https (http is only allowed for localhost)'];
  }
  return [];
}

export function validateConfig(cfg) {
  const errors = [];
  if (!Number.isFinite(cfg.timeoutMs) || !Number.isInteger(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
    errors.push('OPENBOT_ORCA_TIMEOUT_MS must be a positive finite integer');
  }
  // With routes the default URL is optional: unmatched events are then dropped.
  if (!cfg.url) {
    if (!isRouted(cfg)) errors.push('OPENBOT_ORCA_WEBHOOK_URL is not set');
  } else {
    errors.push(...urlErrors('OPENBOT_ORCA_WEBHOOK_URL', cfg.url));
    errors.push(...secretErrors(SECRET_KEY, cfg.secret));
  }
  if (!cfg.url && cfg.secret && !SECRET_RE.test(cfg.secret)) errors.push(...secretErrors(SECRET_KEY, cfg.secret));
  if (isRouted(cfg)) {
    errors.push(...(cfg.routeErrors || []));
    const seen = new Set();
    for (const r of cfg.routes) {
      if (seen.has(r.name)) continue;
      seen.add(r.name);
      if (!r.url) errors.push(routeUrlKey(r.name) + ' is not set');
      else errors.push(...urlErrors(routeUrlKey(r.name), r.url));
      if (r.url || r.secret) errors.push(...secretErrors(routeSecretKey(r.name), r.secret));
    }
  }
  if (cfg.machineLabel && !LABEL_RE.test(cfg.machineLabel)) {
    errors.push('OPENBOT_ORCA_MACHINE_LABEL must match [A-Za-z0-9][A-Za-z0-9._-]{0,31}');
  }
  return errors;
}

export function redactUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol + '//' + u.host;
  } catch {
    return 'invalid';
  }
}

export function publicView(cfg) {
  return {
    config_file: cfg.file,
    config_file_status: cfg.fileStatus,
    webhook_url: redactUrl(cfg.url),
    webhook_secret: cfg.secret ? 'set' : 'unset',
    machine_label: cfg.machineLabel,
    timeout_ms: cfg.timeoutMs,
    sources: cfg.sources,
    ...(isRouted(cfg) ? { routes: routesView(cfg) } : {}),
  };
}

// One redaction set for every path that sanitizes or persists text: the URLs and
// secrets of the default webhook and of every route, the secret variable names
// and the signature header names. Pattern rules (any whsec_, any
// OPENBOT_ORCA_WEBHOOK_SECRET* assignment) live in sanitize.js.
export function redactionFor(cfg) {
  const routes = isRouted(cfg) ? cfg.routes : [];
  const secrets = [cfg.url, cfg.secret, ...routes.flatMap((r) => [r.url, r.secret])].filter(Boolean);
  const names = [SECRET_KEY, ...routes.map((r) => routeSecretKey(r.name)), ...SIGNATURE_HEADERS];
  return { secrets: [...new Set(secrets)], sensitiveNames: [...new Set(names)] };
}

export function isLoopbackUrl(url) {
  try {
    return LOOPBACK.has(new URL(url).hostname);
  } catch {
    return false;
  }
}
