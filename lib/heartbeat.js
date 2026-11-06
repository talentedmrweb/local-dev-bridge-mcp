// WO-CMD-8: end-to-end liveness canary. Every tool call stamps a small file that the
// COMMANDER watchdog (mini-cluster scripts/commander-watchdog.sh) reads. If STEWARD's
// calls stop arriving, the file goes stale and the watchdog alerts.
// Content: {"at": ISO time, "epoch": seconds, "tool": name, "pid": n}. Tool name only, never arguments.
import fs from 'fs';
import path from 'path';
import os from 'os';

export function stateDir(env = process.env) {
  return env.LDB_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'local-dev-bridge');
}

// Never throws: a heartbeat failure must not fail the tool call.
export function touchLastCall(tool, { dir = stateDir(), now = new Date() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'last-call');
    const tmp = `${file}.${process.pid}.tmp`;
    const body = JSON.stringify({ at: now.toISOString(), epoch: Math.floor(now.getTime() / 1000), tool: String(tool).slice(0, 64), pid: process.pid });
    fs.writeFileSync(tmp, body + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
