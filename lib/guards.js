// Guards for herdr_pane_submit and herdr_pane_keys (WO-CMD-4). Pure functions, unit-tested in test/guards.mjs.
import { stripAnsi, detectUnsent } from './unsent.js';
import { textHash } from './ledger.js';

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

/**
 * What the input box showed once the bridge's send settled (`squash`ed), or
 * null if it showed no own text. Claude Code collapses long input into
 * "[Pasted text #N]" placeholders or a truncated tail, so the box rarely shows
 * the full text; this snapshot is what submit compares against.
 */
export function inputSnapshot(detected) {
  return detected && detected.state === 'unsent' ? squash(detected.text) : null;
}

// May STEWARD press Enter? Only when the input line holds exactly the text the bridge itself
// typed via herdr_agent_send into this target within the window, or exactly how the box showed it
// right after that send settled (long or wrapped text shows collapsed).
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

// ── herdr_pane_clear_agent_text ──────────────────────────────────────────────
// Agent roles whose "<Agent> →" prefix marks a line as agent-written. Override with
// LDB_AGENT_NAMES="A,B,C". Matching is case-sensitive, at the very start of the input.
export const DEFAULT_AGENT_NAMES = Object.freeze([
  'STEWARD', 'Tooling', 'Content', 'Platform', 'Scout', 'Editorial', 'Editorial desk',
  'Benchmark', 'Benchmark/Data', 'QA', 'T3', 'TCE', 'Watchtower', 'LRN', 'Gemma',
]);
export const agentNames = (env = process.env) =>
  env.LDB_AGENT_NAMES ? env.LDB_AGENT_NAMES.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_AGENT_NAMES;

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// "p5 Benchmark/Data: …": a Herdr pane number plus a role, then a colon.
const PANE_ROLE_RE = /^p\d{1,2} [A-Z][\w/&+.' -]{0,40}:\s/;

/** Which agent-authorship prefix, if any, starts this text. */
export function agentPrefix(text, names = DEFAULT_AGENT_NAMES) {
  const t = String(text ?? '').trimStart();
  const pr = t.match(PANE_ROLE_RE);
  if (pr) return pr[0].trim();
  const arrow = new RegExp(`^(?:${names.map(reEsc).join('|')})\\s*(?:→|->)\\s*\\S`);
  const a = t.match(arrow);
  return a ? a[0].slice(0, -1).trim() : null;
}

/**
 * May STEWARD clear (Ctrl-U) or submit (Enter) the text sitting in a pane's input line?
 * Only if it is provably agent-written:
 *   - ledger: a bridge / agent-send.mjs send into this same pane with the same text hash, or
 *   - prefix: the text starts with "<Agent> →" or "pN <Role>:" (clear only; submit needs the ledger,
 *     because the operator may have added to an agent's line and Enter would send their words on).
 * Never on a dialog (permission, approval, trust or picker prompt), never on a non-Claude pane.
 */
// Claude Code shows a long paste as "[Pasted text #N]" / "[Pasted text #N +K lines]" placeholders.
const PLACEHOLDERS_RE = /^(?:\[Pasted text #\d+(?: \+\d+ lines?)?\]\s*)+/;
export const MIN_VISIBLE_TAIL = 20;

/**
 * Is what the input box shows the end of `sent` (placeholders stripped, whitespace ignored)?
 * Used when the caller passes the text it sent: the box often shows only its last lines.
 */
export function visibleIsTailOf(visible, sent) {
  const v = squash(String(visible ?? '').trim().replace(PLACEHOLDERS_RE, ''));
  return v.length >= MIN_VISIBLE_TAIL && squash(sent).endsWith(v);
}

export function checkAgentText(screen, { action, target, ledgerMatch, names = DEFAULT_AGENT_NAMES, sentText = null }) {
  const block = activePromptBlock(screen);
  if (block !== null) {
    const approval = PERMISSION_FOOTER_RE.test(block) || APPROVAL_RE.test(block);
    return approval
      ? { ok: false, code: 'approval_prompt', reason: 'Refused: a permission/approval/trust prompt is showing. Only the operator answers those.' }
      : { ok: false, code: 'prompt_showing', reason: 'Refused: a picker or dialog is showing, not the input line. Answer it first (herdr_pane_keys).' };
  }
  const d = detectUnsent(screen);
  if (d.kind !== 'claude') return { ok: false, code: 'not_claude_pane', reason: `Refused: ${target} is not showing a Claude Code input box.`, detected: d };
  if (d.state !== 'unsent') return { ok: false, code: 'nothing_to_clear', reason: `The input line holds no typed text (state: ${d.state}).`, detected: d };
  const hash = textHash(d.text);
  const entry = ledgerMatch ? ledgerMatch(hash) : null;
  // sent_text: the caller hands back the exact text it sent. Proven when that text's hash is a ledger
  // send into this pane AND the box shows its end (long sends often show only their last lines).
  if (!entry && sentText != null) {
    const sent = ledgerMatch ? ledgerMatch(textHash(sentText)) : null;
    if (!sent) return { ok: false, code: 'sent_text_mismatch', reason: `Refused: sent_text is not a ledger-recorded send into ${target}.`, detected: d, hash };
    if (!visibleIsTailOf(d.text, sentText)) {
      return { ok: false, code: 'sent_text_mismatch', reason: `Refused: the input line is not the end of sent_text (the operator may have edited it, or fewer than ${MIN_VISIBLE_TAIL} chars are visible).`, detected: d, hash };
    }
    return { ok: true, detected: d, hash, provenance: { via: 'sent_text', at: sent.at, from: sent.from, kind: sent.kind } };
  }
  const prefix = entry ? null : agentPrefix(d.text, names);
  if (!entry && !prefix) {
    return { ok: false, code: 'not_agent_text', reason: 'Refused: no ledger record or agent prefix shows this text was typed by an agent. Treating it as the operator\'s own text.', detected: d, hash };
  }
  if (action === 'submit' && !entry) {
    return { ok: false, code: 'submit_needs_ledger', reason: `Refused: the text has an agent prefix ("${prefix}") but no ledger record, so it may hold the operator's edits. It can be cleared, not submitted.`, detected: d, hash, prefix };
  }
  return { ok: true, detected: d, hash, provenance: entry ? { via: 'ledger', at: entry.at, from: entry.from, kind: entry.kind } : { via: 'prefix', prefix } };
}

/** After one Ctrl-U: did the line only shrink from the end (nobody typed in between)? */
export function clearProgress(original, before, after) {
  if (after.state !== 'unsent') return { done: true };
  const o = squash(original), b = squash(before), a = squash(after.text);
  if (!o.startsWith(a)) return { done: false, ok: false, code: 'clear_diverged', reason: 'The input line changed to text that is not part of the agent text (someone typed). Stopped.' };
  if (a.length >= b.length) return { done: false, ok: false, code: 'clear_stalled', reason: 'Ctrl-U made no progress. Stopped.' };
  return { done: false, ok: true };
}

/** clearProgress for a sent_text match: the box may scroll back through earlier lines as Ctrl-U eats the end. */
export function clearProgressSent(sent, before, after) {
  if (after.state !== 'unsent') return { done: true };
  const a = squash(String(after.text).trim().replace(PLACEHOLDERS_RE, ''));
  if (!squash(sent).includes(a)) return { done: false, ok: false, code: 'clear_diverged', reason: 'The input line changed to text that is not part of sent_text (someone typed). Stopped.' };
  if (squash(after.text) === squash(before)) return { done: false, ok: false, code: 'clear_stalled', reason: 'Ctrl-U made no progress. Stopped.' };
  return { done: false, ok: true };
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
