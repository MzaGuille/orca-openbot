// Neutral templates: a hint never chooses a consent answer or a menu option.
function paneArgument(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_.:-]+$/.test(text)) return text;
  return '"' + text.replace(/[\\"$`]/g, '\\$&') + '"';
}
// removed: --index/--option/--enter replies (plan-orca-openbot §2): send is bridge-only, text only.
// A review consent is answered by running its invocation in a shell, never through the bridge.
export const REVIEW_CONSENT_REPLY = 'Run the chosen invocation (granted or declined) in a shell with '
  + 'GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1 set; orca-openbot send is not enough.';
export function nextHints({ paneId, attentionKind, questionKind = null }) {
  const pane = paneArgument(paneId);
  const send = 'orca-openbot send --pane ' + pane;
  if (attentionKind === 'question' && questionKind === 'review-consent') return { read: 'orca-ide worktree ps --json', reply: REVIEW_CONSENT_REPLY };
  return {
    // removed: `orca-openbot read` (plan-orca-openbot §2); the read hint is orca-ide.
    read: 'orca-ide worktree ps --json',
    reply: attentionKind === 'question' ? send + ' --text "<answer>"' : null,
  };
}
