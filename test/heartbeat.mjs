import fs from 'fs';
import os from 'os';
import path from 'path';
import { touchLastCall, stateDir } from '../lib/heartbeat.js';

let pass = 0, failn = 0;
const ok = (c, m) => { if (c) pass++; else { failn++; console.error('FAIL', m); } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ldb-hb-'));

ok(stateDir({ LDB_STATE_DIR: '/x/y' }) === '/x/y', 'env override');
ok(stateDir({}).endsWith(path.join('.local', 'state', 'local-dev-bridge')), 'default dir');

const now = new Date('2026-11-06T16:00:00Z');
ok(touchLastCall('herdr_agent_list', { dir, now }) === true, 'write ok');
const j = JSON.parse(fs.readFileSync(path.join(dir, 'last-call'), 'utf8'));
ok(j.tool === 'herdr_agent_list' && j.epoch === 1793980800 && j.at === now.toISOString(), 'content');
ok(Object.keys(j).sort().join() === 'at,epoch,pid,tool', 'no other fields (never arguments)');
ok((fs.statSync(path.join(dir, 'last-call')).mode & 0o777) === 0o600, 'mode 600');
ok(fs.readdirSync(dir).length === 1, 'no tmp left behind');
ok(touchLastCall('x'.repeat(200), { dir, now }) && JSON.parse(fs.readFileSync(path.join(dir, 'last-call'), 'utf8')).tool.length === 64, 'tool name capped');

// unwritable target: returns false, never throws
fs.writeFileSync(path.join(dir, 'blocker'), '');
ok(touchLastCall('t', { dir: path.join(dir, 'blocker', 'sub') }) === false, 'failure is swallowed');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`heartbeat: ${pass} passed, ${failn} failed`);
process.exit(failn ? 1 : 0);
