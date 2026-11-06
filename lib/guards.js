// Guards for herdr_pane_submit and herdr_pane_keys (WO-CMD-4). Pure functions, unit-tested in test/guards.mjs.
import { stripAnsi } from './unsent.js';

export const SUBMIT_WINDOW_MS = 5 * 60_000;

// Bridge key name → herdr 0.9.5 `pane send-keys` key name. Nothing else is ever sent.
export const KEY_MAP = Object.freeze({
  Enter: 'enter',
  Esc: 'esc',
  Up: 'up',
  Down: 'down',
  Tab: 'tab',
  ...Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => [d, d])),
});
export const MAX_KEYS = 10;

const squash = (s) => String(s ?? '').replace(/[\s ]+/g, '');

// May STEWARD press Enter? Only when the input line holds exactly the text the bridge itself
// typed via herdr_agent_send into this target within the window, and nothing else.
/**
 * What the input box showed once the bridge's send settled (`squash`ed), or
 * null if it showed no own text. Claude Code collapses long input into
 * "[Pasted text #N]" placeholders or a truncated tail, so the box rarely shows
 * the full text; this snapshot is what submit compares against.
 */
export function inputSnapshot(detected) {
  return detected && detected.state === 'unsent' ? squash(detected.text) : null;
}

export function checkSubmit(detected, record, now = Date.now()) {
  if (!record) return { ok: false, code: 'not_bridge_text', reason: 'The bridge has not typed anything into this pane (herdr_agent_send) that is still pending.' };
  if (now - record.at > SUBMIT_WINDOW_MS) return { ok: false, code: 'submit_window_expired', reason: 'The text the bridge typed is older than 5 minutes; re-send it first.' };
  if (detected.state !== 'unsent') {
    return { ok: false, code: 'nothing_to_submit', reason: `The input line holds no typed text (state: ${detected.state}).` };
  }
  const onLine = squash(detected.text);
  // Short text: the box shows it whole. Long text: the box shows whatever it
  // rendered right after the bridge's send settled (placeholder or tail);
  // any keystroke since then changes that rendering.
  if (onLine === squash(record.text)) return { ok: true };
  if (record.shown && onLine === record.shown) return { ok: true, via: 'snapshot' };
  return { ok: false, code: 'not_bridge_text', reason: 'The input line differs from what the bridge typed, or from how it showed right after the send (the operator may have edited or typed). Not submitting.' };
}

// Tool-permission / approval / trust prompts. STEWARD must never answer these.
const APPROVAL_RE = /do you want to|\ballow\b|permission|trust this folder|always allow|don't ask again/i;
// Claude Code's permission-prompt footer ("Esc to cancel · Tab to amend"); pickers don't have it.
const PERMISSION_FOOTER_RE = /Tab to amend/;
// Claude Code AskUserQuestion picker footer.
const PICKER_RE = /Enter to select\b/;
// Any dialog footer: marks the bottom of the active prompt block.
const FOOTER_RE = /Esc to cancel|Enter to (?:select|confirm)|Tab to amend/;
export const ACTIVE_BLOCK_LINES = 15;

// The active prompt block: the last dialog footer plus the 14 non-blank lines above it, and anything below it.
// Only this block is judged, so old scrollback ("permission" printed an hour ago) doesn't block a live picker.
export function activePromptBlock(ansiScreen) {
  const nb = stripAnsi(ansiScreen).split('\n').filter((l) => l.trim() !== '');
  let f = -1;
  for (let i = nb.length - 1; i >= 0; i--) if (FOOTER_RE.test(nb[i])) { f = i; break; }
  if (f < 0) return null;
  return nb.slice(Math.max(0, f - (ACTIVE_BLOCK_LINES - 1))).join('\n');
}

export function checkPickerScreen(ansiScreen) {
  const block = activePromptBlock(ansiScreen);
  if (block === null) return { ok: false, code: 'no_picker', reason: 'Refused: no prompt footer is visible in this pane, so there is no picker to answer.' };
  if (PERMISSION_FOOTER_RE.test(block)) return { ok: false, code: 'approval_prompt', reason: 'Refused: the active prompt is a tool-permission prompt ("Tab to amend"). Only the operator answers those.' };
  const hit = block.match(APPROVAL_RE);
  if (hit) return { ok: false, code: 'approval_prompt', reason: `Refused: the active prompt looks like a permission/approval prompt ("${hit[0]}"). Only the operator answers those.` };
  if (!PICKER_RE.test(block)) return { ok: false, code: 'no_picker', reason: 'Refused: the active prompt is not an AskUserQuestion picker ("Enter to select").' };
  return { ok: true };
}

export function mapKeys(keys) {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_KEYS) {
    return { ok: false, code: 'invalid_argument', reason: `keys must be a non-empty array of at most ${MAX_KEYS}.` };
  }
  const out = [];
  for (const k of keys) {
    if (typeof k !== 'string' || !Object.hasOwn(KEY_MAP, k)) {
      return { ok: false, code: 'key_not_allowed', reason: `Key not allowed: ${JSON.stringify(k)}. Allowed: ${Object.keys(KEY_MAP).join(', ')}.` };
    }
    out.push(KEY_MAP[k]);
  }
  return { ok: true, keys: out };
}
