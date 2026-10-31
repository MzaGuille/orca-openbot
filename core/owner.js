// Lock ownership by PID plus process start time (#27, #45). PIDs get
// recycled, so a live PID alone does not prove the recorded owner is alive.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// This process's start, as epoch ms. performance.timeOrigin is taken while the
// runtime boots, so it is never earlier than the OS creation time.
export const selfStartMs = () => Math.round(performance.timeOrigin);

// A reused PID belongs to a process created after the recorded owner, which is
// what this slack tolerates: clock rounding and runtime boot time, not reuse.
export const START_SLACK_MS = 2000;

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// OS creation time of pid as epoch ms, or null when it cannot be read.
export function processStartMs(pid, { platform = process.platform, run = spawnSync, readFile = readFileSync } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // removed: win32 start-time lookup (plan-orca-openbot §3)
    if (platform === 'linux') {
      // Field 22 of /proc/<pid>/stat is the start in clock ticks after boot (USER_HZ 100).
      const stat = String(readFile('/proc/' + pid + '/stat', 'utf8'));
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      const btime = Number(/^btime (\d+)$/m.exec(String(readFile('/proc/stat', 'utf8')))?.[1]);
      return Number.isFinite(ticks) && Number.isFinite(btime) ? btime * 1000 + ticks * 10 : null;
    }
  } catch { /* unreadable: unknown */ }
  return null;
}

// True when the recorded owner still runs. A dead PID is gone; a live PID whose
// process was created after the recorded start is a reused PID. An unknown start
// (old lock format or an unreadable process) fails closed to the PID check.
export function ownerAlive(pid, recordedStart, { isAlive = pidAlive, startOf = processStartMs } = {}) {
  if (!isAlive(pid)) return false;
  if (!Number.isSafeInteger(recordedStart) || recordedStart <= 0) return true;
  const actual = startOf(pid);
  return actual === null || actual <= recordedStart + START_SLACK_MS;
}
