#!/usr/bin/env node
// Unit tests for lib/guards.js (WO-CMD-4) against real Claude Code 2.1.318 screens captured from herdr 0.9.5.
// No herdr or MCP needed: node test/guards.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectUnsent } from '../lib/unsent.js';
import { checkSubmit, inputSnapshot, checkPickerScreen, mapKeys, SUBMIT_WINDOW_MS } from '../lib/guards.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(here, 'fixtures', `claude-${n}.ansi`), 'utf8');
let pass = 0;
let failCount = 0;
const check = (label, ok, extra = '') => {
  ok ? pass++ : failCount++;
  console.log(`${ok ? '✅' : '🔴'} ${label}${extra ? ' — ' + extra : ''}`);
};

// ── herdr_pane_keys: picker vs approval prompts ──
const picker = checkPickerScreen(fx('picker'));
check('keys: AskUserQuestion picker is allowed', picker.ok, picker.reason);
const perm = checkPickerScreen(fx('perm'));
check('keys: Bash permission prompt ("Do you want to proceed?") REFUSED', perm.code === 'approval_prompt', perm.reason);
const trust = checkPickerScreen(fx('trust'));
check('keys: folder-trust prompt REFUSED', trust.code === 'approval_prompt', trust.reason);
const idle = checkPickerScreen(fx('typed'));
check('keys: plain input box (no picker) REFUSED', idle.code === 'no_picker', idle.reason);
const permOnPicker = checkPickerScreen(fx('picker') + '\nAllow Bash(rm -rf build)?\n');
check('keys: picker plus "Allow" anywhere on screen REFUSED', permOnPicker.code === 'approval_prompt');
const permWord = checkPickerScreen(fx('picker').replace('Which color', 'Grant permission for which color'));
check('keys: "permission" in the question REFUSED', permWord.code === 'approval_prompt');

// Active-block scoping (STEWARD probe finding on PR #4): only the live prompt is judged.
const oldScroll = Array.from({ length: 30 }, (_, i) => (i === 3 ? '⏺ Earlier: Bash permission granted. Allow list updated; do you want to keep it?' : `  log line ${i}`)).join('\n');
const busyPicker = checkPickerScreen(oldScroll + '\n' + fx('picker'));
check('keys: picker under old "permission"/"allow" scrollback → ALLOWED', busyPicker.ok, busyPicker.reason);
const busyPerm = checkPickerScreen(oldScroll + '\n' + fx('perm'));
check('keys: real permission prompt under scrollback → still REFUSED', busyPerm.code === 'approval_prompt', busyPerm.reason);
const bareYesNo = ['⏺ Running build', '────────────', ' Bash command', '   rm -rf build', ' Proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend'].join('\n');
const yn = checkPickerScreen(bareYesNo);
check('keys: permission prompt "1. Yes / 2. No" + "Tab to amend" (no approval words) → REFUSED', yn.code === 'approval_prompt', yn.reason);
const cookies = checkPickerScreen(fx('picker').replace('Choose green', 'Allow cookies'));
check('keys: picker whose option says "Allow cookies" → REFUSED (fail safe)', cookies.code === 'approval_prompt', cookies.reason);
const permAboveWindow = checkPickerScreen(['Do you want to proceed?', ...Array.from({ length: 20 }, (_, i) => `  output ${i}`), fx('picker')].join('\n'));
check('keys: "Do you want to" far above the live picker → ALLOWED', permAboveWindow.ok, permAboveWindow.reason);
const noFooter = checkPickerScreen(oldScroll);
check('keys: no prompt footer at all → no_picker', noFooter.code === 'no_picker');

check('keys: allow-list maps to herdr names', JSON.stringify(mapKeys(['Down', 'Enter', '3', 'Esc', 'Up', 'Tab', '9']).keys) === '["down","enter","3","esc","up","tab","9"]');
for (const bad of [['y'], ['0'], ['enter'], ['C-c'], ['Enter; rm -rf /'], ['\r'], [1], []]) {
  const m = mapKeys(bad);
  check(`keys: refuse ${JSON.stringify(bad)}`, !m.ok, m.code);
}
check('keys: refuse more than 10 keys', mapKeys(Array(11).fill('Down')).code === 'invalid_argument');
check('keys: refuse non-array', mapKeys('Enter').code === 'invalid_argument');
check('keys: refuse prototype keys', mapKeys(['constructor']).code === 'key_not_allowed' && mapKeys(['__proto__']).code === 'key_not_allowed');

// ── herdr_pane_submit: only the bridge's own recent text ──
const typedText = 'hello from steward, a fairly long line of typed text to check how wrapping is handled by the detector when it runs past the edge';
const typed = detectUnsent(fx('typed'));
check('submit: fixture input line is detected as typed (wrapped over 2 lines)', typed.state === 'unsent', JSON.stringify(typed.text));
const now = Date.now();
check('submit: bridge text, 10 s old → allowed', checkSubmit(typed, { text: typedText, at: now - 10_000 }, now).ok);
check('submit: no record (operator typed it) → REFUSED', checkSubmit(typed, undefined, now).code === 'not_bridge_text');
check('submit: different text on the line (operator edited) → REFUSED', checkSubmit(typed, { text: 'hello from steward', at: now }, now).code === 'not_bridge_text');
check('submit: bridge text plus operator suffix → REFUSED', checkSubmit({ state: 'unsent', text: typedText + ' and ship it' }, { text: typedText, at: now }, now).code === 'not_bridge_text');
check('submit: older than 5 min → REFUSED', checkSubmit(typed, { text: typedText, at: now - SUBMIT_WINDOW_MS - 1 }, now).code === 'submit_window_expired');
check('submit: empty input line → REFUSED', checkSubmit({ state: 'empty' }, { text: typedText, at: now }, now).code === 'nothing_to_submit');
check('submit: only a dim suggestion → REFUSED', checkSubmit({ state: 'suggestion', text: typedText }, { text: typedText, at: now }, now).code === 'nothing_to_submit');
check('submit: permission prompt screen has no own text → REFUSED', !checkSubmit(detectUnsent(fx('perm')), { text: typedText, at: now }, now).ok);

// PR #5: long text shows collapsed (real Claude Code 2.1.318 screens).
{
  const LONG = Array.from({ length: 600 }, (_, i) => `word${String(i).padStart(4, '0')}`).join(' ');
  const MED = Array.from({ length: 200 }, (_, i) => `w${String(i).padStart(3, '0')}`).join(' ');
  const ML = Array.from({ length: 40 }, (_, i) => `line ${i}: some handoff text here for testing the wrap`).join('\n');
  for (const [name, txt, label] of [['long-tail', LONG, 'truncated tail'], ['long-placeholder', MED, '[Pasted text #N]'], ['long-multiline', ML, 'multiline placeholders']]) {
    const d = detectUnsent(fx(name));
    const rec = { text: txt, at: now, shown: inputSnapshot(d) };
    check(`long (${label}): screen is unsent and != full text`, d.state === 'unsent' && rec.shown && rec.shown !== txt.replace(/\s+/g, ''));
    check(`long (${label}): unchanged since send → allowed via snapshot`, checkSubmit(d, rec, now).via === 'snapshot');
    check(`long (${label}): no snapshot recorded → REFUSED`, checkSubmit(d, { text: txt, at: now, shown: null }, now).code === 'not_bridge_text');
    check(`long (${label}): operator appended text → REFUSED`, checkSubmit({ state: 'unsent', text: d.text + ' and ship it' }, rec, now).code === 'not_bridge_text');
    check(`long (${label}): older than 5 min → REFUSED`, checkSubmit(d, { ...rec, at: now - SUBMIT_WINDOW_MS - 1 }, now).code === 'submit_window_expired');
  }
  const ph = detectUnsent(fx('long-placeholder'));
  check('long: a different paste ([Pasted text #9]) → REFUSED', checkSubmit({ state: 'unsent', text: '[Pasted text #9]' }, { text: MED, at: now, shown: inputSnapshot(ph) }, now).code === 'not_bridge_text');
  check('long: input cleared since send → REFUSED', checkSubmit({ state: 'empty' }, { text: MED, at: now, shown: inputSnapshot(ph) }, now).code === 'nothing_to_submit');
  check('inputSnapshot: empty/suggestion → null', inputSnapshot({ state: 'empty' }) === null && inputSnapshot({ state: 'suggestion', text: 'x' }) === null);
}

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
