#!/usr/bin/env node
// Unit tests for herdr_pane_clear_agent_text guards + the agent-send ledger (v3.3.0).
// Screens are real Claude Code captures from herdr 0.9.5. No herdr or MCP needed.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectUnsent } from '../lib/unsent.js';
import { checkAgentText, clearProgress, clearProgressSent, visibleIsTailOf, agentPrefix, agentNames, DEFAULT_AGENT_NAMES, checkSubmit, inputSnapshot } from '../lib/guards.js';
import { RULE_RE } from '../lib/unsent.js';
import { recordLedger, readLedger, findSend, textHash, ledgerPath, LEDGER_MAX_AGE_MS } from '../lib/ledger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', `claude-${n}.ansi`), 'utf8');
let pass = 0;
let failCount = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : failCount++;
  console.log(`${ok ? '✅' : '🔴'} ${label}${extra ? ' — ' + extra : ''}`);
};

const T = 'wH:p2';
const noLedger = () => null;
const run = (screen, action = 'clear', ledgerMatch = noLedger, target = T) => checkAgentText(screen, { action, target, ledgerMatch, names: DEFAULT_AGENT_NAMES });

// ── prefix provenance ──
const note = run(fx('agent-note'));
check('"pN <Role>:" note → clear allowed via prefix', note.ok && note.provenance.via === 'prefix', note.reason || note.provenance?.prefix);
const arrow = run(fx('agent-arrow'));
check('"<Agent> →" note → clear allowed via prefix', arrow.ok && arrow.provenance.prefix === 'Tooling →', arrow.reason || arrow.provenance?.prefix);
const noteSubmit = run(fx('agent-note'), 'submit');
check('prefix only → submit REFUSED (submit_needs_ledger)', noteSubmit.code === 'submit_needs_ledger', noteSubmit.reason);

// ── operator text ──
const op = run(fx('operator-text'));
check("operator's own text → REFUSED not_agent_text", op.code === 'not_agent_text', op.reason);
const opSubmit = run(fx('operator-text'), 'submit');
check("operator's own text → submit REFUSED", opSubmit.code === 'not_agent_text');
const typed = run(fx('typed'));
check('older operator fixture (typed) → REFUSED', typed.code === 'not_agent_text', typed.reason);

// ── ledger provenance ──
const opText = detectUnsent(fx('operator-text')).text;
const ledgerFor = (txt, target = T) => (h) => (h === textHash(txt) ? { at: 'x', from: 'STEWARD', kind: 'send', target } : null);
const led = run(fx('operator-text'), 'clear', ledgerFor(opText));
check('no prefix but ledger match → clear allowed via ledger', led.ok && led.provenance.via === 'ledger', led.reason);
const ledSub = run(fx('operator-text'), 'submit', ledgerFor(opText));
check('ledger match → submit allowed', ledSub.ok);
const ledOther = run(fx('operator-text'), 'clear', ledgerFor(opText + ' and one more word'));
check('ledger has different text (operator edited) → REFUSED', ledOther.code === 'not_agent_text');

// ── prompts: never ──
for (const [n, label] of [['perm', 'Bash permission prompt'], ['trust', 'folder-trust prompt'], ['picker', 'AskUserQuestion picker']]) {
  const r = run(fx(n), 'clear', () => ({ at: 'x', kind: 'send' }));
  const want = n === 'picker' ? 'prompt_showing' : 'approval_prompt';
  check(`${label} (even with a ledger match) → REFUSED ${want}`, r.code === want, r.reason);
}
const empty = run(fx('idle-suggestion'), 'clear', () => ({ at: 'x', kind: 'send' }));
check('idle input (dim suggestion only) → nothing_to_clear', empty.code === 'nothing_to_clear', empty.code);
const shell = run('mr@host ~ % p5 Benchmark/Data: hi there\n');
check('shell pane → REFUSED not_claude_pane', shell.code === 'not_claude_pane', shell.reason);

// ── prefix rules ──
const P = (s) => agentPrefix(s, DEFAULT_AGENT_NAMES);
check('prefix: "p5 Benchmark/Data: …"', P('p5 Benchmark/Data: proposed x') === 'p5 Benchmark/Data:');
check('prefix: "STEWARD → Tooling: …"', P('STEWARD → Tooling: do x') === 'STEWARD →');
check('prefix: "QA -> Platform: …"', P('QA -> Platform: repro') === 'QA ->');
check('no prefix: plain sentence', P('please look at p5 Benchmark/Data: later') === null);
check('no prefix: unknown name with arrow', P('Bob → Platform: do x') === null);
check('no prefix: lowercase "steward →"', P('steward → do x') === null);
check('no prefix: "p5:" with no role', P('p5: do x') === null);
check('no prefix: arrow with nothing after', P('STEWARD →') === null);
check('LDB_AGENT_NAMES override', agentNames({ LDB_AGENT_NAMES: 'Alpha, Beta' }).join('|') === 'Alpha|Beta' && agentPrefix('Beta → x', ['Alpha', 'Beta']) === 'Beta →');

// ── clear loop progress ──
const orig = 'p5 Role: line one that wraps\n  line two';
check('progress: line shrinks from the end → continue', clearProgress(orig, orig, { state: 'unsent', text: 'p5 Role: line one that wraps' }).ok === true);
check('progress: empty → done', clearProgress(orig, 'p5 Role:', { state: 'empty' }).done === true);
check('progress: suggestion only → done', clearProgress(orig, 'p5 Role:', { state: 'suggestion', text: 'Try x' }).done === true);
check('progress: someone typed new text → STOP clear_diverged', clearProgress(orig, orig, { state: 'unsent', text: 'p5 Role: line one that wraps EXTRA' }).code === 'clear_diverged');
check('progress: no change → STOP clear_stalled', clearProgress(orig, orig, { state: 'unsent', text: orig }).code === 'clear_stalled');

// ── ledger file ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-ledger-'));
const env = { LDB_STATE_DIR: dir };
const now = Date.now();
recordLedger({ target: T, text: 'STEWARD → Platform: hello   world', kind: 'send', via: 'test', from: 'STEWARD', hashes: ['extrahash'], now: now - 1000 }, env);
recordLedger({ target: 'wH:p3', text: 'other pane', kind: 'run', via: 'test', now }, env);
const entries = readLedger(env);
const raw = fs.readFileSync(ledgerPath(env), 'utf8');
check('ledger: two entries appended', entries.length === 2);
check('ledger: text is NOT stored, only hashes', !raw.includes('hello') && !raw.includes('other pane'));
check('ledger: file mode 600', (fs.statSync(ledgerPath(env)).mode & 0o777) === 0o600);
check('ledger: whitespace-insensitive hash match', !!findSend(entries, T, textHash('STEWARD → Platform:\n  hello world'), { now }));
check('ledger: extra (screen) hash matches', !!findSend(entries, T, 'extrahash', { now }));
check('ledger: same text, other pane → no match', !findSend(entries, 'wH:p3', textHash('STEWARD → Platform: hello world'), { now }));
check('ledger: older than 14 days → no match', !findSend(entries, T, 'extrahash', { now: now + LEDGER_MAX_AGE_MS + 5000 }));
recordLedger({ target: T, text: 'STEWARD → Platform: hello world', kind: 'clear', via: 'test', now }, env);
check('ledger: clear/submit entries never count as sends', findSend(readLedger(env), T, textHash('STEWARD → Platform: hello world'), { now })?.kind === 'send');
fs.appendFileSync(ledgerPath(env), '{torn line\n');
check('ledger: torn line skipped', readLedger(env).length === 3);
check('ledger: unwritable dir → returns null, never throws', recordLedger({ target: T, text: 'x', kind: 'send', via: 't' }, { LDB_STATE_DIR: '/dev/null/nope' }) === null);
fs.rmSync(dir, { recursive: true, force: true });

// ── existing submit guard unchanged ──
const s = checkSubmit(detectUnsent(fx('agent-note')), null);
check('herdr_pane_submit still refuses prefix-only agent text (unchanged)', s.code === 'not_bridge_text');

// ── v3.3.1: wrapped / long sends (real Claude Code 2.1.325 captures, scratch panes) ──
{
  // The exact texts the e2e sent (test/fixtures/claude-wrap-*.ansi).
  const filler = (n, tag) => { let s = ''; let i = 0; while (s.length < n) s += `step ${tag}${i++}: check the scratch fixture and note the result. `; return s.slice(0, n).trim(); };
  const WO = (who, n, tag) => `STEWARD → ${who}: ${filler(n - 40, tag)} Test only, reply OK.`;
  // Operator types after the agent's text: edit the LAST "reply OK." (the input box), not scrollback.
  const appendOp = (scr) => { const i = scr.lastIndexOf('reply OK.'); return scr.slice(0, i) + 'reply OK. and also ship it' + scr.slice(i + 9); };
  const ledgerOf = (hashes, target = T) => (h) => (hashes.includes(h) ? { at: 'x', from: 'STEWARD', kind: 'send', target } : null);
  const cases = [
    ['one', WO('QA', 100, 'one'), '1-line'],
    ['thr', WO('QA', 330, 'thr'), '3-line, labeled rule'],
    ['sco', WO('Scout', 370, 'sco'), '4-line, labeled rule (wH:p3 repro)'],
    ['fiv', WO('QA', 560, 'fiv'), '5-line'],
  ];
  for (const [n, sent, label] of cases) {
    const scr = fx(`wrap-${n}`);
    const d = detectUnsent(scr);
    check(`wrap ${label}: detected as unsent Claude input`, d.kind === 'claude' && d.state === 'unsent', `${d.kind}/${d.state}`);
    check(`wrap ${label}: unwrapped text hashes equal to the sent text`, textHash(d.text) === textHash(sent));
    const r = run(scr, 'submit', ledgerOf([textHash(sent)]));
    check(`wrap ${label}: submit allowed via ledger (full-text hash only)`, r.ok && r.provenance.via === 'ledger', r.reason);
    check(`wrap ${label}: "STEWARD →" prefix recognised on the wrapped text`, run(scr).provenance?.prefix === 'STEWARD →');
    const appended = appendOp(scr);
    check(`wrap ${label}: operator appended → submit REFUSED`, run(appended, 'submit', ledgerOf([textHash(sent)])).code === 'submit_needs_ledger');
    check(`wrap ${label}: permission prompt → REFUSED even with ledger`, run(fx('perm'), 'submit', ledgerOf([textHash(sent)])).code === 'approval_prompt');
  }

  // ~1,180 chars (wC:p1 repro): the box shows "[Pasted text #N]" + the last lines; no prefix, no full text.
  const LONG = WO('TCE-APP', 1180, 'tce');
  const ld = detectUnsent(fx('wrap-tce'));
  check('long 1,180: box shows a placeholder + tail, not the full text', ld.state === 'unsent' && /^\[Pasted text #\d+\]/.test(ld.text) && textHash(ld.text) !== textHash(LONG));
  check('long 1,180: v3.3.0 ledger (full-text hash only) → REFUSED not_agent_text (today\'s failure)', run(fx('wrap-tce'), 'clear', ledgerOf([textHash(LONG)])).code === 'not_agent_text');
  const snap = inputSnapshot(ld);
  const withSnap = ledgerOf([textHash(LONG), textHash(snap)]);
  const ls = run(fx('wrap-tce'), 'submit', withSnap);
  check('long 1,180: v3.3.1 ledger (+ settled snapshot hash) → submit allowed', ls.ok && ls.provenance.via === 'ledger', ls.reason);
  check('long 1,180: herdr_pane_submit snapshot record → allowed', checkSubmit(ld, { text: LONG, at: Date.now(), shown: snap }).via === 'snapshot');
  const lApp = appendOp(fx('wrap-tce'));
  check('long 1,180: operator appended → submit REFUSED', run(lApp, 'submit', withSnap).code === 'not_agent_text');

  // sent_text: recovers sends logged before v3.3.1 (no snapshot hash), e.g. the stuck wC:p1 order.
  const old = ledgerOf([textHash(LONG)]);
  const st = checkAgentText(fx('wrap-tce'), { action: 'submit', target: T, ledgerMatch: old, sentText: LONG });
  check('sent_text: ledger send + box shows its end → submit allowed via sent_text', st.ok && st.provenance.via === 'sent_text', st.reason);
  check('sent_text: not a ledger send into this pane → REFUSED', checkAgentText(fx('wrap-tce'), { action: 'clear', target: T, ledgerMatch: noLedger, sentText: LONG }).code === 'sent_text_mismatch');
  check('sent_text: operator appended → REFUSED', checkAgentText(lApp, { action: 'submit', target: T, ledgerMatch: old, sentText: LONG }).code === 'sent_text_mismatch');
  const opT = detectUnsent(fx('operator-text')).text;
  check("sent_text: operator's own text under a ledgered claim → REFUSED", checkAgentText(fx('operator-text'), { action: 'clear', target: T, ledgerMatch: old, sentText: LONG }).code === 'sent_text_mismatch' && !visibleIsTailOf(opT, LONG));
  check('sent_text: permission prompt → REFUSED approval_prompt', checkAgentText(fx('perm'), { action: 'submit', target: T, ledgerMatch: old, sentText: LONG }).code === 'approval_prompt');
  check('sent_text: placeholder only (<20 visible chars) → not a tail match', !visibleIsTailOf('[Pasted text #5]', LONG) && !visibleIsTailOf('[Pasted text #5] reply OK.', LONG));
  check('sent_text clear progress: box scrolls back to earlier lines → continue', clearProgressSent(LONG, 'note the result. Test only, reply OK.', { state: 'unsent', text: 'step tce3: check the scratch fixture' }).ok === true);
  check('sent_text clear progress: foreign text → STOP clear_diverged', clearProgressSent(LONG, 'x', { state: 'unsent', text: 'hold off, my own words' }).code === 'clear_diverged');
  check('sent_text clear progress: unchanged → STOP clear_stalled', clearProgressSent(LONG, 'step tce3: check', { state: 'unsent', text: 'step tce3: check' }).code === 'clear_stalled');

  // labeled input-box rule (Claude Code 2.1.32x "── session:name ─")
  check('rule: plain rule', RULE_RE.test('─'.repeat(40)));
  check('rule: labeled "── scout:scout ─"', RULE_RE.test('─'.repeat(40) + ' scout:scout ─'));
  check('rule: a line of prose is not a rule', !RULE_RE.test('──── note: this is a heading with a long sentence after the dashes that keeps going and going ─'));
}

console.log(`\nclear-agent-text: ${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
