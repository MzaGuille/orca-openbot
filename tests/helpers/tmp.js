import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

export function makeTmp(t, prefix = 'hgb-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

export function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}
