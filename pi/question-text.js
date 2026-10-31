// Pure trailing-question heuristic for one assistant message. No fs, no network.

const FENCE = /^```/;
const QUESTION = /\?["')*]*$/;
const MAX = 240;

function textOf(message) {
  const content = message?.role === 'assistant' ? message.content : null;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

// Last non-empty line outside fenced code blocks. A question only when that
// line ends in ? (a closing paren, quote or * after it is tolerated) and is
// 240 characters or fewer. A question followed by a statement does not count.
export function trailingQuestion(message) {
  let fenced = false;
  let last = '';
  for (const line of textOf(message).split(/\r?\n/)) {
    if (FENCE.test(line.trim())) { fenced = !fenced; continue; }
    if (fenced) continue;
    const trimmed = line.trim();
    if (trimmed) last = trimmed;
  }
  return QUESTION.test(last) && last.length <= MAX ? last : null;
}
