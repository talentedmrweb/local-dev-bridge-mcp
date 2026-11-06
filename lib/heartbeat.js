// WO-CMD-8: end-to-end liveness canary. Every tool call stamps a small file that the
// COMMANDER watchdog (mini-cluster scripts/commander-watchdog.sh) reads. If STEWARD's
// calls stop arriving, the file goes stale and the watchdog alerts.
//
// Files: last-call.desktop  when Claude Desktop launched this bridge (parent is
//                           Claude.app/Contents/Helpers/disclaimer): the path STEWARD uses
//        last-call.other    any other client (Claude Code panes), so a busy pane can't
//                           keep the Desktop canary fresh while STEWARD is cut off
// Content: {"at": ISO time, "epoch": seconds, "tool": name, "pid": n}. Tool name only, never arguments.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';

export const DESKTOP_PARENT = '/Applications/Claude.app/Contents/Helpers/disclaimer';

export function stateDir(env = process.env) {
  return env.LDB_STATE_DIR || path.join(os.homedir(), '.local', 'state', 'local-dev-bridge');
}

export function callerFromParent(parentCommand) {
  return String(parentCommand || '').trim().startsWith(DESKTOP_PARENT) ? 'desktop' : 'other';
}

let cachedCaller = null;
export function callerKind(env = process.env) {
  if (env.LDB_CALLER === 'desktop' || env.LDB_CALLER === 'other') return env.LDB_CALLER;
  if (cachedCaller) return cachedCaller;
  try {
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8', timeout: 2000 });
    cachedCaller = callerFromParent(cmd);
  } catch {
    cachedCaller = 'other';
  }
  return cachedCaller;
}

// Never throws: a heartbeat failure must not fail the tool call.
export function touchLastCall(tool, { dir = stateDir(), now = new Date(), caller = callerKind() } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `last-call.${caller === 'desktop' ? 'desktop' : 'other'}`);
    const tmp = `${file}.${process.pid}.tmp`;
    const body = JSON.stringify({ at: now.toISOString(), epoch: Math.floor(now.getTime() / 1000), tool: String(tool).slice(0, 64), pid: process.pid });
    fs.writeFileSync(tmp, body + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}
