import fs from 'fs';
import os from 'os';
import path from 'path';
import { touchLastCall, stateDir, callerFromParent, callerKind, DESKTOP_PARENT } from '../lib/heartbeat.js';

let pass = 0, failn = 0;
const ok = (c, m) => { if (c) pass++; else { failn++; console.error('FAIL', m); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-hb-'));
const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));

ok(stateDir({ LDB_STATE_DIR: '/x/y' }) === '/x/y', 'env override');
ok(stateDir({}).endsWith(path.join('.local', 'state', 'local-dev-bridge')), 'default dir');

ok(callerFromParent(`${DESKTOP_PARENT} --pgroup -- /usr/local/bin/node /x/index.js\n`) === 'desktop', 'desktop parent');
ok(callerFromParent('claude --dangerously-skip-permissions --model claude-opus-5-5') === 'other', 'claude code pane');
ok(callerFromParent('/Users/x/Library/Application Support/Claude/claude-code/2.1.317/claude.app/Contents/MacOS/claude') === 'other', 'desktop code tab is not the STEWARD path');
ok(callerFromParent('') === 'other', 'empty parent');
ok(callerKind({ LDB_CALLER: 'desktop' }) === 'desktop' && callerKind({ LDB_CALLER: 'other' }) === 'other', 'LDB_CALLER override');

const now = new Date('2026-11-06T16:00:00Z');
ok(touchLastCall('herdr_agent_list', { dir, now, caller: 'desktop' }) === true, 'write ok');
const j = read('last-call.desktop');
ok(j.tool === 'herdr_agent_list' && j.epoch === now.getTime() / 1000 && j.at === now.toISOString(), 'content');
ok(Object.keys(j).sort().join() === 'at,epoch,pid,tool', 'no other fields (never arguments)');
ok((fs.statSync(path.join(dir, 'last-call.desktop')).mode & 0o777) === 0o600, 'mode 600');

touchLastCall('herdr_pane_run', { dir, now: new Date('2026-11-06T17:00:00Z'), caller: 'other' });
ok(read('last-call.desktop').tool === 'herdr_agent_list', 'pane call does not refresh the desktop canary');
ok(read('last-call.other').tool === 'herdr_pane_run', 'pane call lands in .other');
ok(fs.readdirSync(dir).sort().join() === 'last-call.desktop,last-call.other', 'no tmp left behind');

touchLastCall('x'.repeat(200), { dir, now, caller: 'weird' });
ok(read('last-call.other').tool.length === 64, 'tool name capped; unknown caller → other');

fs.writeFileSync(path.join(dir, 'blocker'), '');
ok(touchLastCall('t', { dir: path.join(dir, 'blocker', 'sub'), caller: 'desktop' }) === false, 'failure is swallowed');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`heartbeat: ${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
