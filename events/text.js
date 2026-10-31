// Terminal text helpers shared by the question parser and the payload builder.
// CSI uses every ECMA-48 parameter byte (0-9 : ; < = > ?) and also the 8-bit \x9b form; OSC may use \x9d/\x9c.
const ANSI_RE = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text) {
  return String(text).replace(ANSI_RE, '');
}

// Splits terminal output into clean lines: no ANSI, no CR, no trailing spaces.
export function cleanLines(text) {
  return stripAnsi(String(text ?? '')).split(/\r?\n/).map((line) => line.replace(/\r/g, '').trimEnd());
}

export function dropTrailingBlank(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(0, end);
}
