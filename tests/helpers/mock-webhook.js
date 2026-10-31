// Local HTTP webhook mock. Tests must never reach a real webhook.
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

const DELIVERY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
export const SIGNATURE_WINDOW_S = 300;

// Verifies a request the way OpenBot does (contract §1.2): HMAC-SHA256 keyed with the
// whole secret string over "<ts>.<delivery-id>." + the raw received bytes, ±300 s window.
export function verifySignature({ headers, raw }, secret, nowS = Math.floor(Date.now() / 1000)) {
  const ts = headers['x-openbot-timestamp'];
  const id = headers['x-openbot-delivery-id'];
  const sig = headers['x-openbot-signature'];
  if (typeof ts !== 'string' || !/^\d+$/.test(ts) || typeof id !== 'string' || !DELIVERY_ID_RE.test(id)) return false;
  if (typeof sig !== 'string' || !/^sha256=[0-9a-fA-F]{64}$/.test(sig)) return false;
  if (Math.abs(nowS - Number(ts)) > SIGNATURE_WINDOW_S) return false;
  const expected = createHmac('sha256', secret).update(ts + '.' + id + '.').update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(sig.slice(7), 'hex'));
}

// `secret` (string or function): when set, a request whose signature does not verify gets 401
// and does not consume a queued response. `nowS` is the mock's clock in Unix seconds.
export async function startMockWebhook(t, responses = [], { secret = null, nowS = () => Math.floor(Date.now() / 1000) } = {}) {
  const requests = [];
  const queue = [...responses];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = raw.toString('utf8');
      // envelope: the whole OpenBot body {type, occurredAt, data}; json: its data (the plugin payload).
      let envelope = null;
      try { envelope = JSON.parse(body); } catch { envelope = null; }
      const json = envelope && typeof envelope === 'object' && 'type' in envelope && 'data' in envelope ? envelope.data : envelope;
      const key = typeof secret === 'function' ? secret() : secret;
      const verified = key ? verifySignature({ headers: req.headers, raw }, key, nowS()) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body, envelope, json, verified });
      const next = verified === false ? 401 : queue.length ? queue.shift() : 200;
      if (next === 'reset') return req.socket.destroy(); // server drops the connection mid-request
      if (next === 'hang') return; // never answer: exercises client timeouts
      // Connection: close: no pooled socket outlives a reply, so the server's 5 s idle close
      // cannot race a reused socket (ECONNRESET on Windows, #75).
      res.writeHead(next, { 'content-type': 'application/json', connection: 'close' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/hook/secret-path';
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }));
  return { url, requests };
}

export function assertLoopback(url) {
  const host = new URL(url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('tests must only use a loopback webhook: ' + url);
}
