// Shared metric contract: managed CLI installs must not depend on optional pi/.
import { sanitizeAttention } from './sanitize.js';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const nonnegative = value => Number.isFinite(value) && value >= 0;
const plain = value => value !== null && typeof value === 'object'
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const isPiTelemetry = record => record?.source === 'pi-ext' && ['cache_miss', 'context'].includes(record.name);

export function validateTelemetry(value, kind) {
  if (!plain(value) || !['cache_miss', 'context'].includes(kind)) return ['invalid telemetry'];
  const common = ['estimated', 'model', 'provider', 'context_percent'];
  const fields = [...common, ...(kind === 'cache_miss' ? ['rebilled_tokens', 'rebilled_cost_usd'] : ['level', 'threshold'])];
  if (Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))
    || value.estimated !== true || !nonempty(value.model) || !nonempty(value.provider)
    || !(value.context_percent === null || nonnegative(value.context_percent))) return ['invalid telemetry'];
  if (kind === 'cache_miss') {
    if (!Number.isSafeInteger(value.rebilled_tokens) || value.rebilled_tokens <= 0
      || !nonnegative(value.rebilled_cost_usd)) return ['invalid cache telemetry'];
  } else if (!['info', 'warn'].includes(value.level) || !Number.isFinite(value.threshold)
    || value.threshold <= 0 || value.threshold > 100) return ['invalid context telemetry'];
  return [];
}
export function validateTelemetryRecord(record) {
  return !nonempty(record.entry_id) || !nonempty(record.session_id) ? ['invalid telemetry identity']
    : validateTelemetry(record.telemetry, record.name);
}

// Reject malformed input before sanitizing; preserve fixed protocol field names.
export function sanitizeTelemetry(value, kind, options) {
  const errors = validateTelemetry(value, kind);
  if (errors.length) throw new TypeError(errors[0]);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    typeof item === 'string' ? sanitizeAttention(item, options) : item]));
}
