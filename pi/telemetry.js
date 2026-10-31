// Local accounting adapted from Pi 1.1.0:
// @earendil-works/pi-coding-agent/dist/core/cache-stats.js.
// No private host imports. S36 deliberately excludes model switches, unlike Pi UI.
const nonnegative = value => Number.isFinite(value) && value >= 0;
const identity = value => typeof value === 'string' && value.trim().length > 0;
const reset = entry => entry?.type === 'compaction' || entry?.type === 'branch_summary';
const prompt = usage => usage.input + usage.cacheRead + usage.cacheWrite;
function validTokens(usage) {
  return usage && ['input', 'cacheRead', 'cacheWrite'].every(key => nonnegative(usage[key]))
    && nonnegative(prompt(usage));
}
function validMessage(message) {
  return message?.role === 'assistant' && identity(message.provider) && identity(message.model)
    && nonnegative(message.timestamp) && validTokens(message.usage)
    && ['input', 'cacheRead', 'cacheWrite'].every(key => nonnegative(message.usage.cost?.[key]))
    && nonnegative(message.usage.cost.input + message.usage.cost.cacheWrite);
}
const modelKey = value => JSON.stringify([value.provider, value.model]);

/** Estimate overlap paid again, not actual billing. Entries must precede message. */
export function detectCacheMiss(entries, message, models = { getModel: () => undefined }) {
  if (!Array.isArray(entries) || !validMessage(message)
      || ['error', 'aborted'].includes(message.stopReason)) return undefined;
  let previous;
  for (const entry of entries) {
    if (reset(entry)) {
      previous = undefined;
    } else if (entry?.type === 'usage' && entry.kind === 'cache_warm') {
      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      if (validTokens(entry.usage) && prompt(entry.usage) > 0 && nonnegative(timestamp)
          && identity(entry.provider) && identity(entry.model)) {
        previous = { promptTokens: prompt(entry.usage), modelKey: modelKey(entry),
          timestamp, reportedCache: true };
      }
    } else if (entry?.type === 'message' && validMessage(entry.message)) {
      const m = entry.message;
      if (prompt(m.usage) > 0) {
        previous = { promptTokens: prompt(m.usage), modelKey: modelKey(m), timestamp: m.timestamp,
          reportedCache: previous?.reportedCache === true || m.usage.cacheRead + m.usage.cacheWrite > 0 };
      }
    }
  }
  const usage = message.usage;
  const promptTokens = prompt(usage);
  if (!previous || previous.modelKey !== modelKey(message) || promptTokens <= 0
      || (usage.cacheRead + usage.cacheWrite === 0 && !previous.reportedCache)) return undefined;
  const missedTokens = Math.min(previous.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= 1024) return undefined;
  const paidTokens = usage.input + usage.cacheWrite;
  const paidRate = paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const fallback = usage.cacheRead > 0 ? 0 : models?.getModel?.(message.provider, message.model)?.cost?.cacheRead ?? 0;
  if (!nonnegative(fallback)) return undefined;
  const readRate = usage.cacheRead > 0 ? usage.cost.cacheRead / usage.cacheRead : fallback / 1e6;
  const missedCost = missedTokens * Math.max(0, paidRate - readRate);
  if (!nonnegative(missedCost)) return undefined;
  return { missedTokens, missedCost, idleMs: Math.max(0, message.timestamp - previous.timestamp), modelChanged: false };
}

/** Pure proposals: caller must append JSONL successfully before invoking commit.
 * Process turns serially; superseded proposals cannot overwrite newer commits.
 * Unknown API context usage does not rearm thresholds. No screen scraping.
 */
export function createPiTelemetry({ infoPercent = 50, warnPercent = 80, models } = {}) {
  if (!(Number.isFinite(infoPercent) && infoPercent > 0 && infoPercent <= 100
      && Number.isFinite(warnPercent) && warnPercent > 0 && warnPercent <= 100
      && infoPercent < warnPercent)) {
    infoPercent = 50; warnPercent = 80;
  }
  let state = { sessionId: undefined, seen: new Set(), percent: null, lastEntryId: undefined };
  let revision = 0;
  const empty = () => ({ records: [], commit() {} });
  return {
    // Loading an existing session establishes context, but never emits or commits
    // an undelivered proposal. Historic message IDs are already consumed.
    seedContext({ sessionId, entries, contextUsage } = {}) {
      if (!identity(sessionId) || !Array.isArray(entries) || state.sessionId === sessionId) return;
      state = { sessionId, seen: new Set(entries.filter(entry => identity(entry?.id)).map(entry => entry.id)),
        percent: nonnegative(contextUsage?.percent) ? contextUsage.percent : null, lastEntryId: entries.at(-1)?.id };
      revision++;
    },
    prepareTurn({ sessionId, entryId, entries, contextUsage } = {}) {
      if (!identity(sessionId) || !identity(entryId) || !Array.isArray(entries)) return empty();
      const index = entries.findIndex(entry => entry?.id === entryId);
      const current = entries[index];
      if (index < 0 || current.type !== 'message' || !validMessage(current.message)) return empty();
      const sameSession = state.sessionId === sessionId;
      if (sameSession && state.seen.has(entryId)) return empty();
      const before = entries.slice(0, index);
      const lastIndex = sameSession ? before.findIndex(entry => entry?.id === state.lastEntryId) : -1;
      const hasReset = before.slice(lastIndex + 1).some(reset);
      const previousPercent = sameSession && !hasReset ? state.percent : null;
      const percent = nonnegative(contextUsage?.percent) ? contextUsage.percent : null;
      const message = current.message;
      const base = { estimated: true, model: message.model, provider: message.provider, context_percent: percent };
      const records = [];
      const miss = detectCacheMiss(before, message, models);
      if (miss && Number.isSafeInteger(miss.missedTokens) && !(miss.missedTokens < 20000 && miss.missedCost < .10)) {
        records.push({ source: 'pi-ext', name: 'cache_miss', entry_id: entryId,
          telemetry: { ...base, rebilled_tokens: miss.missedTokens, rebilled_cost_usd: miss.missedCost },
          msg: `Estimated cache miss: ${miss.missedTokens} tokens re-billed (~$${miss.missedCost.toFixed(4)} incremental USD).` });
      }
      const crossed = threshold => percent !== null && percent >= threshold
        && (previousPercent === null || previousPercent < threshold);
      const level = crossed(warnPercent) ? 'warn' : crossed(infoPercent) ? 'info' : undefined;
      if (level) {
        const threshold = level === 'warn' ? warnPercent : infoPercent;
        records.push({ source: 'pi-ext', name: 'context', entry_id: entryId,
          telemetry: { ...base, level, threshold },
          msg: `Estimated context usage: ${percent}% (${level}, threshold ${threshold}%).${level === 'warn' ? ' Consider /compact.' : ''}` });
      }
      const preparedRevision = revision;
      let committed = false;
      return { records, commit() {
        if (committed || preparedRevision !== revision) return;
        committed = true;
        const seen = new Set(sameSession ? state.seen : []);
        seen.add(entryId);
        state = { sessionId, seen, percent: percent ?? previousPercent, lastEntryId: entryId };
        revision++;
      } };
    },
  };
}
