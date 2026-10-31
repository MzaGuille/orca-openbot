// Environment detection. Every function degrades to "unknown" instead of throwing.
import { readFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';

export function pluginVersion() {
  try {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
    if (typeof version === 'string' && version) return version;
  } catch {}
  return 'unknown';
}

// removed: Windows (plan-orca-openbot §3); the OS is always linux.
export function detectOs() {
  return 'linux';
}

// Snapshot used for every payload. removed: herdr_version lookup (plan-orca-openbot §3).
export function detectAll({ hostname = osHostname } = {}) {
  let host = 'unknown';
  try {
    host = hostname() || 'unknown';
  } catch {
    host = 'unknown';
  }
  return { os: detectOs(), host, plugin_version: pluginVersion() };
}
