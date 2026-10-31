// Convert Pi extension events to small, sanitized registry records.
// No filesystem, configuration or network access in this layer.
import { evaluateSignals } from '../events/attention/evaluate.js';
import { sanitizeAttentionRecord } from '../events/sanitize.js';
import { trailingQuestion } from './question-text.js';

export function createPiEventNormalizer() {
  let hadError = false;
  let errorMessage = '';
  let runOpen = false;
  let pendingQuestion = null;
  return event => {
    if (event.type === 'session_start') {
      hadError = false; errorMessage = ''; runOpen = false; pendingQuestion = null;
      return [];
    }
    if (event.type === 'agent_start') {
      // Automatic follow-up runs belong to the same unsettled operation.
      if (!runOpen) { hadError = false; errorMessage = ''; }
      runOpen = true;
      pendingQuestion = null;
      return [];
    }
    const record = { source: 'pi-ext', name: event.type };
    switch (event.type) {
      case 'ui_prompt_start':
      case 'ui_prompt_end':
        record.kind = event.kind;
        record.title = event.title || '';
        break;
      case 'tool_execution_end':
        if (event.toolName === 'bash') record.toolName = 'bash';
        record.isError = event.isError === true;
        record.msg = record.isError && Array.isArray(event.result?.content)
          ? event.result.content.filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n') : '';
        break;
      case 'message_end':
        record.stopReason = event.message?.role === 'assistant' ? event.message.stopReason : null;
        record.msg = event.message?.role === 'assistant' ? event.message.errorMessage || '' : '';
        if (event.message?.role === 'assistant') pendingQuestion = trailingQuestion(event.message);
        break;
      case 'session_compact_failed':
        record.aborted = event.aborted === true;
        record.msg = record.aborted ? '' : event.errorMessage || 'Compaction failed';
        break;
      case 'agent_settled':
        record.hadError = hadError;
        record.aborted = event.aborted === true;
        record.msg = errorMessage;
        if (hadError === false && event.aborted !== true && pendingQuestion) record.question = pendingQuestion;
        runOpen = false;
        pendingQuestion = null;
        break;
    }
    const attention = evaluateSignals(record);
    if (attention?.attentionKind === 'error') {
      hadError = true;
      errorMessage = record.msg || errorMessage || 'Agent reported an error';
    }
    const clean = sanitizeAttentionRecord(record);
    if (!attention || attention.attentionKind === 'unknown') return [clean];
    // OSC 7501 semantics mirrored as JSON, not a native Pi event subscription.
    const status = ['blocked', 'question'].includes(attention.attentionKind) ? 'blocked' : attention.attentionKind;
    return [clean, sanitizeAttentionRecord({ source: 'osc', name: 'program_status', status,
      ...(status === 'blocked' ? { kind: attention.attentionKind === 'question' ? 'question' : 'permission' } : {}),
      title: record.question || record.title || '', msg: record.msg || '',
    })];
  };
}
