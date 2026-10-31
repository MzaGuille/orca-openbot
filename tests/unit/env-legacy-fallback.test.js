import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeTmp, put } from '../helpers/tmp.js';
import { envVar } from '../../core/env.js';
import { loadConfig, DEFAULT_TIMEOUT_MS } from '../../core/config.js';
import { defaultStateDir } from '../../core/fsutil.js';
import { bridgeStaleMs, BRIDGE_STALE_MS } from '../../control/bridges.js';
import { ackMs, DEFAULT_ACK_MS } from '../../control/orders.js';
import { resolveTarget } from '../../core/routes.js';
import { fakeSecret } from '../helpers/secret.js';

test('envVar: the new name wins, the old one is used when the new is unset, neither gives undefined', () => {
  assert.equal(envVar({ OPENBOT_ORCA_X: 'new', OPENBOT_HERDR_X: 'old' }, 'OPENBOT_ORCA_X'), 'new');
  assert.equal(envVar({ OPENBOT_HERDR_X: 'old' }, 'OPENBOT_ORCA_X'), 'old');
  assert.equal(envVar({}, 'OPENBOT_ORCA_X'), undefined);
  assert.equal(envVar({ OPENBOT_HERDR_X: 'old' }, 'UNRELATED'), undefined);
});

test('config: env values fall back to the old names, the new names win', t => {
  const dir = makeTmp(t), url = 'https://example.com/hook';
  const base = { OPENBOT_ORCA_CONFIG_FILE: join(dir, 'missing') };
  const old = loadConfig({ env: { ...base, OPENBOT_HERDR_WEBHOOK_URL: url, OPENBOT_HERDR_WEBHOOK_SECRET: fakeSecret('o'),
    OPENBOT_HERDR_MACHINE_LABEL: 'viejo', OPENBOT_HERDR_TIMEOUT_MS: '1234' } });
  assert.equal(old.url, url);
  assert.equal(old.secret, fakeSecret('o'));
  assert.equal(old.machineLabel, 'viejo');
  assert.equal(old.timeoutMs, 1234);
  assert.equal(old.sources.url, 'env');
  const both = loadConfig({ env: { ...base, OPENBOT_ORCA_MACHINE_LABEL: 'nuevo', OPENBOT_HERDR_MACHINE_LABEL: 'viejo' } });
  assert.equal(both.machineLabel, 'nuevo');
  const none = loadConfig({ env: base });
  assert.equal(none.url, null);
  assert.equal(none.timeoutMs, DEFAULT_TIMEOUT_MS);
});

test('config.env file and routes accept the old names', t => {
  const dir = makeTmp(t);
  const file = put(join(dir, 'config.env'), [
    'OPENBOT_HERDR_WEBHOOK_URL=https://example.com/default',
    'OPENBOT_HERDR_ROUTES=alan-:ALAN',
    'OPENBOT_HERDR_WEBHOOK_URL_ALAN=https://example.com/alan',
    'OPENBOT_HERDR_WEBHOOK_SECRET_ALAN=' + fakeSecret('a'),
    'OPENBOT_ORCA_MACHINE_LABEL=nuevo', 'OPENBOT_HERDR_MACHINE_LABEL=viejo', ''].join('\n'));
  const cfg = loadConfig({ env: { OPENBOT_ORCA_CONFIG_FILE: file }, checkPerms: () => ({ ok: true, detail: 'test' }) });
  assert.equal(cfg.url, 'https://example.com/default');
  assert.equal(cfg.sources.url, 'file');
  assert.equal(cfg.machineLabel, 'nuevo');
  assert.deepEqual(resolveTarget(cfg, 'alan-obra'), { url: 'https://example.com/alan', secret: fakeSecret('a'), route: 'ALAN' });
});

test('state dir, config file path and numeric settings: old name used when new unset, default otherwise', () => {
  assert.equal(defaultStateDir({ OPENBOT_HERDR_STATE_DIR: '/tmp/old-state' }), '/tmp/old-state');
  assert.equal(defaultStateDir({ OPENBOT_ORCA_STATE_DIR: '/tmp/new', OPENBOT_HERDR_STATE_DIR: '/tmp/old-state' }), '/tmp/new');
  assert.equal(defaultStateDir({ HOME: '/h' }), '/h/.local/state/orca-openbot');
  assert.equal(ackMs({ OPENBOT_HERDR_ORDER_ACK_MS: '777' }), 777);
  assert.equal(ackMs({ OPENBOT_ORCA_ORDER_ACK_MS: '5', OPENBOT_HERDR_ORDER_ACK_MS: '777' }), 5);
  assert.equal(ackMs({}), DEFAULT_ACK_MS);
  assert.equal(bridgeStaleMs({ OPENBOT_HERDR_BRIDGE_STALE_MS: '4000' }), 4000);
  assert.equal(bridgeStaleMs({}), BRIDGE_STALE_MS);
});
