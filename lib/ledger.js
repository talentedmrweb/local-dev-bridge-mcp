// Agent-send ledger: who typed what into which pane.
//
// Every agent-to-agent send through the bridge (herdr_agent_send, herdr_pane_run) or through
// bin/agent-send.mjs appends one JSON line here. The text itself is NOT stored, only a sha256 of
// its whitespace-squashed form, its length and who sent it. herdr_pane_clear_agent_text uses
// the ledger to prove that a stuck input line was typed by an agent and not by the operator.
//
// File: $LDB_STATE_DIR/agent-sends.jsonl (default ~/.local/state/local-dev-bridge), mode 600.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

export const LEDGER_FILE = 'agent-sends.jsonl';
export const LEDGER_MAX_AGE_MS = 14 * 24 * 60 * 60_000; // a jam can sit unnoticed for days
const TRIM_AT_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 5000;

export const ledgerDir = (env = process.env) =>
  env.LDB_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'local-dev-bridge');
export const ledgerPath = (env = process.env) => path.join(ledgerDir(env), LEDGER_FILE);

// Same normalization the guards use: the screen re-wraps text, so whitespace can't be compared.
export const squash = (s) => String(s ?? '').replace(/[\s ]+/g, '');
export const textHash = (s) => crypto.createHash('sha256').update(squash(s), 'utf8').digest('hex');

/**
 * Append one entry. Never throws: a ledger failure must not block a send, it only means
 * the clear tool will later refuse (fail closed).
 * kind: 'send' (text typed, no Enter) | 'run' (text + Enter) | 'clear' | 'submit'
 * hashes: extra hashes that identify the same text, e.g. what the screen showed right after the send.
 */
export function recordLedger({ target, text, kind, via, from = null, hashes = [], now = Date.now() }, env = process.env) {
  try {
    const dir = ledgerDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, LEDGER_FILE);
    const all = [...new Set([textHash(text), ...hashes.filter(Boolean)])];
    const entry = {
      at: new Date(now).toISOString(),
      epoch: Math.floor(now / 1000),
      target: String(target),
      kind,
      via,
      from: from ? String(from).slice(0, 64) : null,
      len: String(text ?? '').length,
      hashes: all,
    };
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    trimIfLarge(file);
    return entry;
  } catch (err) {
    console.error(`[ledger] could not record: ${err.message}`);
    return null;
  }
}

function trimIfLarge(file) {
  const { size } = fs.statSync(file);
  if (size < TRIM_AT_BYTES) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lines.join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readLedger(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(ledgerPath(env), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

/** Latest send/run into `target` whose text hashes to `hash`, within maxAgeMs. */
export function findSend(entries, target, hash, { now = Date.now(), maxAgeMs = LEDGER_MAX_AGE_MS } = {}) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.target !== target || (e.kind !== 'send' && e.kind !== 'run')) continue;
    if (now - e.epoch * 1000 > maxAgeMs) return null; // append-only, so everything earlier is older
    if (Array.isArray(e.hashes) && e.hashes.includes(hash)) return e;
  }
  return null;
}
