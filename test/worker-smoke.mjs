// Queue smoke test for worker/uat-worker.mjs against the REAL queue (UAT_DIR, default ~/Projects/uat-queue).
// Loopback only: serves a tiny page on 127.0.0.1, queues 3 tests through the bridge MCP
// (pass / fail / custom→blocked), runs the worker --once --loopback-only --only <prefix>,
// then checks queue → claim → complete → results.  Usage: node test/worker-smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'child_process';
import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UAT_DIR = path.resolve((process.env.UAT_DIR || '~/Projects/uat-queue').replace(/^~(?=\/|$)/, os.homedir()));
const RUN = Math.random().toString(16).slice(2, 8);
const PREFIX = `uat-worker-smoke-${RUN}`;
let pass = 0, failN = 0;
const check = (ok, label, extra = '') => { ok ? pass++ : failN++; console.log(`${ok ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`); };

const PAGE = `<!doctype html><title>UAT smoke</title><h1>UAT Smoke</h1>
<label>Name <input id="name"></label><button onclick="document.getElementById('out').innerText='Hello, '+document.getElementById('name').value">Greet</button>
<p id="out"></p><a href="/next">Next page</a>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url.startsWith('/next') ? '<!doctype html><h1>Second page</h1>' : PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const client = new Client({ name: 'worker-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'index.js')], env: { ...process.env, UAT_DIR }, stderr: 'ignore' }));
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError, text: r.content.map((c) => c.text).join('\n') }; };
const queue = async (name, steps) => {
  const r = await call('uat_queue_test', { name: `${PREFIX}-${name}`, url: BASE + '/', priority: 'low', tags: ['uat-worker', 'smoke'], context: 'uat-worker loopback smoke test', steps });
  const id = r.text.match(/Test ID: (\S+)/)?.[1];
  check(!r.err && id, `queued ${name}`, id);
  return id;
};

console.log(`dashboard before:\n${(await call('uat_dashboard', {})).text}\n`);
const ids = {
  pass: await queue('pass', [
    { action: 'assert_visible', target: 'h1', description: 'Heading visible' },
    { action: 'type', target: 'Name', value: 'Ghost', description: 'Type name' },
    { action: 'click', target: 'Greet', description: 'Click Greet' },
    { action: 'assert_text', target: '#out', value: 'Hello, Ghost', description: 'Greeting rendered' },
    { action: 'screenshot', description: 'Evidence' },
    { action: 'click', target: 'Next page', description: 'Follow link' },
    { action: 'assert_url', value: '/next', description: 'On second page' },
    { action: 'assert_text', value: 'Second page', description: 'Second page text' },
  ]),
  fail: await queue('fail', [
    { action: 'assert_text', value: 'This text is not on the page', description: 'Should fail' },
    { action: 'click', target: 'Greet', description: 'Should be skipped' },
  ]),
  custom: await queue('custom', [
    { action: 'assert_visible', target: 'h1', description: 'Heading visible' },
    { action: 'custom', description: 'Confirm the greeting button looks clickable' },
  ]),
};

const worker = await new Promise((resolve) => execFile(process.execPath,
  [path.join(ROOT, 'worker', 'uat-worker.mjs'), '--once', '--loopback-only', '--only', PREFIX],
  { env: { ...process.env, UAT_DIR, UAT_STEP_TIMEOUT_MS: '3000', UAT_AGENT: 'off' }, timeout: 120_000 },
  (err, stdout, stderr) => resolve({ err, out: stdout + stderr })));
console.log(`\n--- worker log ---\n${worker.out.trim()}\n------------------\n`);
check(!worker.err, 'worker --once exited 0', worker.err?.message);

const readRes = async (id) => JSON.parse(await fs.readFile(path.join(UAT_DIR, 'results', `${id}.json`), 'utf-8'));
const gone = async (dir, id) => !(await fs.stat(path.join(UAT_DIR, dir, `${id}.json`)).catch(() => null));
for (const [k, id] of Object.entries(ids)) {
  check(await gone('pending', id) && await gone('in-progress', id), `${k}: left pending/ and in-progress/`);
}
const rp = await readRes(ids.pass);
check(rp.result === 'passed' && rp.step_results.length === 8 && rp.step_results.every((s) => s.status === 'passed'), 'pass: result passed, 8/8 steps passed', rp.summary);
check(!!rp.claimed_at && !!rp.completed_at && rp.status === 'completed', 'pass: claimed_at + completed_at recorded');
const shot = rp.step_results[4]?.screenshot_path;
const st = shot && await fs.stat(path.join(UAT_DIR, shot)).catch(() => null);
check(st && st.size > 1000, 'pass: screenshot written inside queue', shot);
const rf = await readRes(ids.fail);
check(rf.result === 'failed' && rf.step_results[0].status === 'failed' && rf.step_results[1].status === 'skipped', 'fail: result failed, later step skipped', rf.summary);
const rc = await readRes(ids.custom);
check(rc.result === 'blocked' && rc.step_results[1].status === 'skipped', 'custom: result blocked (agent off)', rc.summary);
const gr = await call('uat_get_results', { test_id: ids.pass });
check(!gr.err && gr.text.includes(ids.pass), 'uat_get_results returns pass result via MCP');
const status = JSON.parse(await fs.readFile(path.join(UAT_DIR, '.status.json'), 'utf-8'));
check(status.worker.alive === false && typeof status.queue.pending === 'number', '.status.json written, worker.alive=false after exit');
check(!(await fs.stat(path.join(UAT_DIR, '.worker.lock')).catch(() => null)), 'lock released');

console.log(`\ndashboard after:\n${(await call('uat_dashboard', {})).text}\n`);
await client.close();
server.close();
console.log(`\n${failN ? '❌' : '✅'} worker smoke: ${pass} passed, ${failN} failed (run ${PREFIX})`);
process.exit(failN ? 1 : 0);
