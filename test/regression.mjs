// End-to-end regression for the slim bridge over real MCP stdio.
// Usage: node test/regression.mjs [scratch_pane_id]
// Uses UAT_DIR from the environment (default ~/Projects/uat-queue). Herdr checks run only if a scratch pane id is given.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.argv[2];

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'index.js')],
    env: { ...process.env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'regression', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

let pass = 0;
let failCount = 0;
const log = [];
function check(label, ok, detail = '') {
  ok ? pass++ : failCount++;
  const line = `${ok ? '✅' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`;
  log.push(line);
  console.log(line);
}
const body = (r) => r.content?.map((c) => c.text).join('\n') ?? '';
const errCode = (r) => {
  try {
    return JSON.parse(body(r)).error.code;
  } catch {
    return null;
  }
};

const a = await connect();
const b = await connect();
const call = (c, name, args = {}) => c.callTool({ name, arguments: args });

// ── tools/list ──
const { tools } = await a.listTools();
const names = tools.map((t) => t.name).sort();
console.log('tools/list:', names.join(', '));
const want = [
  'herdr_agent_list', 'herdr_agent_read', 'herdr_agent_send', 'herdr_pane_run', 'herdr_wait',
  'uat_claim_test', 'uat_complete_test', 'uat_dashboard', 'uat_get_pending', 'uat_get_results',
  'uat_get_test', 'uat_queue_test', 'uat_reset_test',
].sort();
check('tools/list = exactly 8 uat_* + 5 herdr_*', JSON.stringify(names) === JSON.stringify(want), `${names.length} tools`);
check('no file/shell tools', !names.some((n) => ['read_file', 'write_file', 'edit_file', 'list_directory', 'search_files', 'run_command'].includes(n)));

// ── UAT happy path ──
const dashBefore = body(await call(a, 'uat_dashboard'));
console.log('\n--- dashboard BEFORE ---\n' + dashBefore + '\n');

const q = await call(a, 'uat_queue_test', {
  name: 'bridge smoke',
  url: 'http://example.lab/',
  tags: ['bridge-smoke'],
  priority: 'low',
  context: 'WO-BRIDGE-1 regression — safe to ignore',
  steps: [
    { action: 'navigate', target: 'http://example.lab/', description: 'Open home' },
    { action: 'assert_visible', target: 'body', description: 'Page renders' },
  ],
});
const id = body(q).match(/Test ID: ([a-z0-9-]+)/)?.[1];
check('uat_queue_test (tag bridge-smoke)', !q.isError && !!id, id);

let r = await call(a, 'uat_get_pending', { tag: 'bridge-smoke' });
check('uat_get_pending lists it', body(r).includes(id));

r = await call(a, 'uat_get_test', { test_id: id });
check('uat_get_test finds it in pending/', body(r).startsWith('Test found in pending/'));

// Double claim: two independent server processes race the same ID.
const [c1, c2] = await Promise.all([call(a, 'uat_claim_test', { test_id: id }), call(b, 'uat_claim_test', { test_id: id })]);
const winners = [c1, c2].filter((x) => !x.isError).length;
const loser = [c1, c2].find((x) => x.isError);
check('double claim (concurrent, 2 processes): exactly one wins', winners === 1, `loser code=${loser && errCode(loser)}`);
check('loser gets already_claimed', loser && errCode(loser) === 'already_claimed');
r = await call(b, 'uat_claim_test', { test_id: id });
check('re-claim after win → already_claimed', errCode(r) === 'already_claimed');

r = await call(a, 'uat_complete_test', {
  test_id: id,
  status: 'passed',
  summary: 'Smoke pass (synthetic — no browser run).',
  step_results: [
    { step_index: 0, status: 'passed', actual: 'navigated' },
    { step_index: 1, status: 'passed', actual: 'body visible', screenshot_path: 'screenshots/smoke.png' },
  ],
  environment: { browser: 'n/a (harness)' },
});
check('uat_complete_test (passed, per-step results)', !r.isError, body(r).split('\n')[0]);

r = await call(a, 'uat_complete_test', { test_id: id, status: 'passed', summary: 'again' });
check('double complete → already_completed', errCode(r) === 'already_completed');

r = await call(a, 'uat_get_results', { test_id: id });
const res = JSON.parse(body(r));
check('uat_get_results shows passed + 2 step results', res.result === 'passed' && res.step_results.length === 2);

const dashMid = body(await call(a, 'uat_dashboard'));
console.log('\n--- dashboard AFTER COMPLETE ---\n' + dashMid + '\n');
check('uat_dashboard reflects result', /Completed:\s+\d+/.test(dashMid));

r = await call(a, 'uat_reset_test', { test_id: id });
check('uat_reset_test → pending', !r.isError);
r = await call(a, 'uat_get_pending', { tag: 'bridge-smoke' });
check('uat_get_pending shows it again', body(r).includes(id));

r = await call(a, 'uat_claim_test', { test_id: id });
check('re-claim after reset', !r.isError);
r = await call(a, 'uat_complete_test', { test_id: id, status: 'skipped', summary: 'Cleared after WO-BRIDGE-1 regression.' });
check('complete as skipped to clear', !r.isError);

// ── Failure paths ──
const bad = [
  ['bad test ID (uppercase/space)', 'uat_get_test', { test_id: 'Bad ID!' }, 'invalid_test_id'],
  ['path escape ../', 'uat_claim_test', { test_id: '../../etc/passwd' }, 'invalid_test_id'],
  ['path escape absolute', 'uat_get_test', { test_id: '/etc/passwd' }, 'invalid_test_id'],
  ['path escape in reset', 'uat_reset_test', { test_id: '..' }, 'invalid_test_id'],
  ['path escape in results', 'uat_get_results', { test_id: '../pending/x' }, 'invalid_test_id'],
  ['absolute screenshot_path', 'uat_complete_test', { test_id: id, status: 'passed', summary: 'x', step_results: [{ step_index: 0, status: 'passed', screenshot_path: '/etc/passwd' }] }, 'path_not_allowed'],
  ['../ screenshot_path', 'uat_complete_test', { test_id: id, status: 'passed', summary: 'x', step_results: [{ step_index: 0, status: 'passed', screenshot_path: '../../x.png' }] }, 'path_not_allowed'],
  ['unknown step action', 'uat_queue_test', { name: 'x', url: 'http://a.lab/', steps: [{ action: 'rm -rf', description: 'nope' }] }, 'invalid_steps'],
  ['empty steps', 'uat_queue_test', { name: 'x', url: 'http://a.lab/', steps: [] }, 'invalid_steps'],
  ['non-http url', 'uat_queue_test', { name: 'x', url: 'file:///etc/passwd', steps: [{ action: 'navigate', description: 'd' }] }, 'invalid_argument'],
  ['bad status enum', 'uat_complete_test', { test_id: id, status: 'great', summary: 'x' }, 'invalid_argument'],
  ['removed tool run_command', 'run_command', { command: 'id' }, 'unknown_tool'],
  ['removed tool read_file', 'read_file', { path: '/etc/passwd' }, 'unknown_tool'],
];
for (const [label, tool, args, code] of bad) {
  const x = await call(a, tool, args);
  const txt = body(x);
  check(`refuse: ${label}`, x.isError && errCode(x) === code && !/\n\s+at /.test(txt), `code=${errCode(x)}`);
}

// ── Herdr ──
if (scratch) {
  r = await call(a, 'herdr_agent_list');
  check('herdr_agent_list', !r.isError && body(r).includes('Herdr agents'), body(r).split('\n')[0]);

  r = await call(a, 'herdr_pane_run', { target: scratch, command: 'echo bridge-smoke-run-ok' });
  check('herdr_pane_run (empty prompt)', !r.isError, body(r));

  r = await call(a, 'herdr_wait', { target: scratch, status: 'unknown', timeout_ms: 5000 });
  // A plain shell pane has no agent, so herdr reports agent_not_found; that proves the call path + structured error.
  // Prove the success path separately against a scratch Claude Code pane (see README › Testing).
  check(
    'herdr_wait on shell pane → structured agent_not_found',
    !r.isError || (errCode(r) === 'herdr_failed' && body(r).includes('agent_not_found')),
    r.isError ? 'agent_not_found (expected for a shell pane)' : body(r).split('\n')[0]
  );

  r = await call(a, 'herdr_agent_read', { target: scratch, source: 'recent', lines: 20 });
  check('herdr_agent_read sees the run output', body(r).includes('bridge-smoke-run-ok'));

  r = await call(a, 'herdr_agent_send', { target: scratch, text: 'echo OPERATOR-UNSENT-LINE' });
  check('herdr_agent_send (literal, no Enter)', !r.isError, body(r));

  r = await call(a, 'herdr_pane_run', { target: scratch, command: 'echo SHOULD-NOT-RUN' });
  const u = JSON.parse(body(r));
  check('herdr_pane_run REFUSES over un-sent line', u.error?.code === 'unsent_operator_text', `unsent_text="${u.error?.details?.unsent_text}"`);
  r = await call(a, 'herdr_agent_send', { target: scratch, text: 'more' });
  check('herdr_agent_send REFUSES over un-sent line', errCode(r) === 'unsent_operator_text');

  for (const [label, tool, args, code] of [
    ['herdr target flag injection', 'herdr_agent_read', { target: '--help' }, 'invalid_target'],
    ['herdr target with shell meta', 'herdr_agent_list', {}, null],
    ['herdr_wait bad status', 'herdr_wait', { target: scratch, status: 'done; rm -rf /' }, 'invalid_argument'],
    ['herdr_pane_run multi-line', 'herdr_pane_run', { target: scratch, command: 'a\nb' }, 'invalid_argument'],
  ]) {
    if (!code) continue;
    const x = await call(a, tool, args);
    check(`refuse: ${label}`, errCode(x) === code, `code=${errCode(x)}`);
  }
}

const dashAfter = body(await call(a, 'uat_dashboard'));
console.log('\n--- dashboard AFTER (final) ---\n' + dashAfter + '\n');
console.log(`TEST_ID=${id}`);
console.log(`\n${pass} passed, ${failCount} failed`);
await a.close();
await b.close();
process.exit(failCount ? 1 : 0);
