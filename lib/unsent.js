// Un-sent operator text detection for Herdr panes.
//
// Parses a pane's visible screen (ANSI format from `herdr agent read --format ansi`)
// and reports what sits on the input line:
//   { state: 'empty' }                       nothing typed
//   { state: 'suggestion', text }            Claude Code's dim (SGR 2) ghost-text prompt suggestion — not operator input
//   { state: 'unsent', text }                real typed-but-not-sent text → callers must refuse
// kind: 'claude' (Claude Code input box), 'shell' (shell prompt), or 'unknown'.

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

export const stripAnsi = (s) => s.replace(ANSI_RE, '').replace(/\r/g, '');

const isRule = (s) => /^[─━]{10,}\s*$/.test(stripAnsi(s).trim());

// Printable characters of one ANSI line, each tagged with whether it is rendered dim.
function styledChars(line) {
  const out = [];
  let dim = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const rest = line.slice(i);
      const sgr = rest.match(/^\x1b\[([0-9;]*)m/);
      if (sgr) {
        const params = sgr[1] === '' ? ['0'] : sgr[1].split(';');
        for (const p of params) {
          if (p === '0' || p === '22') dim = false;
          else if (p === '2') dim = true;
        }
        i += sgr[0].length;
        continue;
      }
      ANSI_RE.lastIndex = 0;
      const other = rest.match(new RegExp('^(?:' + ANSI_RE.source + ')'));
      if (other) {
        i += other[0].length;
        continue;
      }
    }
    if (line[i] !== '\r') out.push({ ch: line[i], dim });
    i++;
  }
  return out;
}

const SHELL_PROMPT_RE = /^(?:\S+@\S+[^%$#]*[%$#]|[%$#❯])\s+(\S.*?)\s*$/;

export function detectUnsent(ansiScreen) {
  const lines = ansiScreen.split('\n');

  // 1) Claude Code input box: a "❯" line directly under a horizontal rule, running to the next rule.
  for (let i = lines.length - 1; i > 0; i--) {
    const plain = stripAnsi(lines[i]);
    if (/^\s*❯/.test(plain) && isRule(lines[i - 1])) {
      const chars = [];
      for (let j = i; j < lines.length && !isRule(lines[j]); j++) {
        let cs = styledChars(lines[j]);
        if (j === i) cs = cs.slice(cs.findIndex((c) => c.ch === '❯') + 1);
        else chars.push({ ch: '\n', dim: false });
        chars.push(...cs);
      }
      const visible = chars.filter((c) => !/[\s ]/.test(c.ch));
      const content = chars.map((c) => c.ch).join('').replace(/ /g, ' ').trim();
      if (visible.length === 0) return { kind: 'claude', state: 'empty' };
      if (visible.every((c) => c.dim)) return { kind: 'claude', state: 'suggestion', text: content };
      return { kind: 'claude', state: 'unsent', text: content };
    }
  }

  // 2) Shell: last non-blank line is a prompt followed by text.
  const plainLines = lines.map(stripAnsi).filter((l) => l.trim() !== '');
  const last = (plainLines[plainLines.length - 1] || '').replace(/ /g, ' ');
  const m = last.match(SHELL_PROMPT_RE);
  if (m) return { kind: 'shell', state: 'unsent', text: m[1] };
  return { kind: 'unknown', state: 'empty' };
}
