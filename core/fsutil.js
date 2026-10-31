// Small filesystem helpers: private dirs, atomic writes, JSON files and a cross-process lock.
import {
  mkdirSync, writeFileSync, renameSync, readFileSync, openSync, closeSync, statSync, unlinkSync, chmodSync, writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { selfStartMs } from './owner.js';
import { envVar } from './env.js';

export function defaultStateDir(env = process.env) {
  const forced = envVar(env, 'OPENBOT_ORCA_STATE_DIR');
  if (forced) return forced;
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'orca-openbot');
}

export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// removed: Windows rename retry (plan-orca-openbot §3); a plain rename is enough on Linux.
export function renameWithRetry(from, to, { rename = renameSync } = {}) {
  rename(from, to);
}

export function writeFileAtomic(file, data, mode = 0o600, opts = {}) {
  ensurePrivateDir(dirname(file));
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  writeFileSync(tmp, data, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // chmod is best effort.
  }
  try {
    renameWithRetry(tmp, file, opts);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

// The tracked-pane / realert state store (panes.json). A legacy file has no
// schema_version and is read as-is; a future version writes one so an older
// plugin can refuse to act on a format it does not understand.
export const PANE_STATE_SCHEMA = 1;

// Classify the realert state file without throwing: 'ok' with the pane map,
// 'corrupt' for unreadable/invalid JSON, or 'unknown_schema' for a schema the
// running plugin does not recognize. Bad states resolve to an empty map so the
// watcher starts clean instead of acting on data it cannot trust.
export function paneStoreHealth(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { health: err.code === 'ENOENT' ? 'ok' : 'corrupt', panes: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { health: 'corrupt', panes: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { health: 'corrupt', panes: {} };
  const { schema_version, ...panes } = parsed;
  if (schema_version !== undefined && schema_version !== PANE_STATE_SCHEMA) return { health: 'unknown_schema', panes: {} };
  return { health: 'ok', panes };
}

// The pane map a trusted reader should act on: empty when the file is corrupt
// or carries an unknown schema version.
export function readTrackedPanes(file) {
  return paneStoreHealth(file).panes;
}

export function sleepSync(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- cross-process locks
// A lock is an O_EXCL file holding a unique "pid:random:start" token (start =
// the owner's process start, epoch ms; see core/owner.js). Breaking a
// stale lock or releasing one goes through removeLockIf(), which takes a
// short-lived "<lock>.break" guard and re-checks the token, so a lock that was
// replaced after it was inspected is never deleted.

export function lockToken() {
  return process.pid + ':' + randomBytes(6).toString('hex') + ':' + selfStartMs();
}

// The owner's recorded start, or null for a legacy "pid:random" token.
export function lockStart(token) {
  const m = /^\d+:[^:]*:(\d+)$/.exec(String(token).trim());
  const ms = m ? Number(m[1]) : NaN;
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

export function readLockToken(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function lockPid(token) {
  const pid = Number.parseInt(String(token), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Creates the lock; returns its token, or null when it already exists.
export function tryCreateLock(file) {
  const token = lockToken();
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (err) {
    if (err.code === 'EEXIST') return null;
    throw err;
  }
  try {
    writeSync(fd, token);
  } finally {
    closeSync(fd);
  }
  return token;
}

export function removeLockIf(file, expectedToken, { guardStaleMs = 10000 } = {}) {
  const guard = file + '.break';
  let gfd;
  try {
    gfd = openSync(guard, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // A breaker that died mid-break leaves the guard behind; it only lives for microseconds.
    try {
      if (Date.now() - statSync(guard).mtimeMs > guardStaleMs) unlinkSync(guard);
    } catch {
      // already gone
    }
    return false;
  }
  try {
    if (readLockToken(file) !== expectedToken) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  } finally {
    closeSync(gfd);
    try {
      unlinkSync(guard);
    } catch {
      // already gone
    }
  }
}

export function lockAgeMs(file, now = Date.now()) {
  try {
    return now - statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

// Exclusive lock around a synchronous callback. Stale locks (crashed holders) expire after staleMs.
export function withLock(lockFile, fn, { staleMs = 10000, timeoutMs = 5000, now = Date.now } = {}) {
  ensurePrivateDir(dirname(lockFile));
  const deadline = now() + timeoutMs;
  let token = tryCreateLock(lockFile);
  while (token === null) {
    const seen = readLockToken(lockFile);
    const age = lockAgeMs(lockFile, now());
    if (seen !== null && age !== null && age > staleMs && removeLockIf(lockFile, seen)) {
      token = tryCreateLock(lockFile);
      continue;
    }
    if (now() > deadline) throw new Error('lock timeout: ' + lockFile);
    sleepSync(25);
    token = tryCreateLock(lockFile);
  }
  try {
    return fn();
  } finally {
    removeLockIf(lockFile, token);
  }
}

export function statePath(stateDir, name) {
  return join(stateDir, name);
}
