// OpenBot webhook signature (contract §1.2): HMAC-SHA256 keyed with the whole
// secret string (whsec_ prefix included) over "<ts>.<deliveryId>." + exact body bytes.
import { createHmac } from 'node:crypto';

export const DELIVERY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export class SignError extends Error {
  constructor() {
    super('signing failed');
    this.name = 'SignError';
    this.code = 'SIGN_FAILED';
  }
}

export function sign(secret, ts, deliveryId, bytes) {
  let hex;
  try {
    hex = createHmac('sha256', secret).update(`${ts}.${deliveryId}.`).update(bytes).digest('hex');
  } catch {
    // Never let the crypto error (which may echo the key) escape.
    throw new SignError();
  }
  return { timestamp: String(ts), deliveryId, signature: 'sha256=' + hex };
}
