// Attention kinds a payload may carry.
// removed: inspectAttention, the screen-based classifier (plan-orca-openbot §3: no screen parsing).
export const ATTENTION_KINDS = ['question', 'done', 'error', 'blocked', 'stalled', 'stalled_unanswered', 'waiting_input', 'unknown', 'cache_miss', 'context'];
