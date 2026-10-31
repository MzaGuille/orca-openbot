// Neutral templates: a hint never chooses a consent answer or a menu option.
function paneArgument(value) {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9_.:-]+$/.test(text)) return text;
  return '"' + text.replace(/[\\"$`]/g, '\\$&') + '"';
}
// removed: --index/--option/--enter replies (plan-orca-openbot §2): send is bridge-only, text only.
export function nextHints({ paneId, attentionKind }) {
  const pane = paneArgument(paneId);
  const send = 'orca-openbot send --pane ' + pane;
  return {
    // removed: `orca-openbot read` (plan-orca-openbot §2); the read hint is orca-ide.
    read: 'orca-ide worktree ps --json',
    reply: attentionKind === 'question' ? send + ' --text "<answer>"' : null,
  };
}
