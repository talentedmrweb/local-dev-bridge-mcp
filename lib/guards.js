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
export function checkSubmit(detected, record, now = Date.now()) {
  if (!record) return { ok: false, code: 'not_bridge_text', reason: 'The bridge has not typed anything into this pane (herdr_agent_send) that is still pending.' };
  if (now - record.at > SUBMIT_WINDOW_MS) return { ok: false, code: 'submit_window_expired', reason: 'The text the bridge typed is older than 5 minutes; re-send it first.' };
  if (detected.state !== 'unsent') {
    return { ok: false, code: 'nothing_to_submit', reason: `The input line holds no typed text (state: ${detected.state}).` };
  }
  if (squash(detected.text) !== squash(record.text)) {
    return { ok: false, code: 'not_bridge_text', reason: 'The input line differs from what the bridge typed (the operator may have edited or typed it). Not submitting.' };
  }
  return { ok: true };
}

// Tool-permission / approval / trust prompts. STEWARD must never answer these.
const APPROVAL_RE = /do you want to|\ballow\b|permission|trust this folder|always allow|don't ask again/i;
// Claude Code AskUserQuestion picker footer.
const PICKER_RE = /Enter to select\b/;

export function checkPickerScreen(ansiScreen) {
  const plain = stripAnsi(ansiScreen);
  const hit = plain.match(APPROVAL_RE);
  if (hit) return { ok: false, code: 'approval_prompt', reason: `Refused: the pane shows a permission/approval prompt ("${hit[0]}"). Only the operator answers those.` };
  if (!PICKER_RE.test(plain)) return { ok: false, code: 'no_picker', reason: 'Refused: no AskUserQuestion picker ("Enter to select") is visible in this pane.' };
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
