#!/usr/bin/env node
// Unit tests for lib/guards.js (WO-CMD-4) against real Claude Code 2.1.318 screens captured from herdr 0.9.5.
// No herdr or MCP needed: node test/guards.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectUnsent } from '../lib/unsent.js';
import { checkSubmit, checkPickerScreen, mapKeys, SUBMIT_WINDOW_MS } from '../lib/guards.js';

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

console.log(`\n${pass} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
