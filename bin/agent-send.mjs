#!/usr/bin/env node
// Agent-to-agent send for panes, with a ledger record (v3.3.0).
//
//   node bin/agent-send.mjs --from "p5 Benchmark/Data" <pane> <text...>          # text + Enter (herdr pane run)
//   node bin/agent-send.mjs --from "p5 Benchmark/Data" --no-enter <pane> <text...> # text only (pane send-text)
//
// Refuses if the target's input line already holds un-sent text. Logs a hash of the text (never the
// text) to the agent-send ledger, so STEWARD can later prove a stuck line was agent-written and clear it
// with herdr_pane_clear_agent_text.
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { detectUnsent } from '../lib/unsent.js';
import { recordLedger, textHash } from '../lib/ledger.js';

const HERDR = ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr'].find((p) => existsSync(p));
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,127}$/;

function usage(msg) {
  if (msg) console.error(`agent-send: ${msg}`);
  console.error('usage: agent-send.mjs --from "<pN Role>" [--no-enter] <pane> <text...>');
  process.exit(2);
}

const argv = process.argv.slice(2);
let from = null;
let enter = true;
while (argv[0]?.startsWith('--')) {
  const a = argv.shift();
  if (a === '--from') from = argv.shift();
  else if (a === '--no-enter') enter = false;
  else usage(`unknown option ${a}`);
}
const [target, ...words] = argv;
const text = words.join(' ');
if (!from) usage('--from is required');
if (!target || !TARGET_RE.test(target)) usage('bad pane id');
if (!text.trim()) usage('no text');
if (enter && /[\r\n]/.test(text)) usage('text must be one line');
if (!HERDR) usage('herdr not found');

const read = () => execFileSync(HERDR, ['pane', 'read', target, '--source', 'visible', '--format', 'ansi'], { encoding: 'utf8' });
const before = detectUnsent(read());
if (before.state === 'unsent') {
  console.error(`agent-send: refused, ${target} already has un-sent text in its input line. Not typing over it.`);
  process.exit(3);
}
execFileSync(HERDR, enter ? ['pane', 'run', target, text] : ['pane', 'send-text', target, text], { stdio: 'ignore' });
let shown = null;
try {
  const after = detectUnsent(read());
  if (after.state === 'unsent') shown = textHash(after.text);
} catch {
  /* unreadable: the text hash alone is recorded */
}
const e = recordLedger({ target, text, kind: enter ? 'run' : 'send', via: 'agent-send.mjs', from, hashes: [shown] });
console.log(`sent ${text.length} chars to ${target}${enter ? ' + Enter' : ''}; ledger ${e ? 'recorded' : 'NOT recorded'}`);
