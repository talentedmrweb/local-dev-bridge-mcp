#!/usr/bin/env node
// uat-worker — headless consumer for the file-based UAT queue (GHOST).
//
// Queue mutations (claim / complete / reset) go ONLY through the local-dev-bridge MCP
// (spawned over stdio), never by moving queue files. Listing pending/ and in-progress/
// is read-only. Browser work runs over CDP against a worker-owned Chrome profile on
// 127.0.0.1 — this Mac's /Applications/Google Chrome.app.
//
// Usage:
//   node worker/uat-worker.mjs                 # daemon (launchd): poll forever
//   node worker/uat-worker.mjs --once          # drain matching tests, then exit
//   node worker/uat-worker.mjs --dry-run       # report what would run; claims nothing
//   --only <id-prefix>     only consider tests whose ID starts with this prefix
//   --loopback-only        only run tests whose URL host is 127.0.0.1 / localhost / ::1
//
// Env: UAT_DIR, UAT_CHROME_PORT (9333), UAT_CHROME_PROFILE (~/.chrome-claude/uat-worker),
//      UAT_CHROME_HEADLESS (1), UAT_POLL_SECONDS (15), UAT_STEP_TIMEOUT_MS (10000),
//      UAT_STUCK_MINUTES (15), UAT_AGENT (off | claude) — executor for `custom` steps.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn, execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expandHome = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

const UAT_DIR = path.resolve(expandHome(process.env.UAT_DIR || '~/Projects/uat-queue'));
const CHROME_BIN = process.env.UAT_CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME_PORT = Number(process.env.UAT_CHROME_PORT || 9333);
const CHROME_PROFILE = path.resolve(expandHome(process.env.UAT_CHROME_PROFILE || '~/.chrome-claude/uat-worker'));
const CHROME_HEADLESS = (process.env.UAT_CHROME_HEADLESS ?? '1') !== '0';
const POLL_MS = Number(process.env.UAT_POLL_SECONDS || 15) * 1000;
const STEP_TIMEOUT_MS = Number(process.env.UAT_STEP_TIMEOUT_MS || 10_000);
const STUCK_MINUTES = Number(process.env.UAT_STUCK_MINUTES || 15);
const AGENT = (process.env.UAT_AGENT || 'off').toLowerCase();
const CLAUDE_BIN = process.env.UAT_CLAUDE_BIN || '/opt/homebrew/bin/claude';
const LOCK_PATH = path.join(UAT_DIR, '.worker.lock');
const STATUS_PATH = path.join(UAT_DIR, '.status.json');
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const ONCE = flag('--once');
const DRY_RUN = flag('--dry-run');
const LOOPBACK_ONLY = flag('--loopback-only') || process.env.UAT_LOOPBACK_ONLY === '1';
const ONLY = opt('--only');

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ──────────────────────────────────────────────
// Singleton lock
// ──────────────────────────────────────────────

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

async function acquireLock() {
  try {
    const pid = Number((await fs.readFile(LOCK_PATH, 'utf-8')).trim());
    if (pid && pid !== process.pid && alive(pid)) return pid;
  } catch {}
  await fs.writeFile(LOCK_PATH, `${process.pid}\n`);
  return null;
}

async function releaseLock() {
  try {
    if (Number((await fs.readFile(LOCK_PATH, 'utf-8')).trim()) === process.pid) await fs.unlink(LOCK_PATH);
  } catch {}
}

// ──────────────────────────────────────────────
// Bridge MCP client (all queue mutations)
// ──────────────────────────────────────────────

let bridge;
async function connectBridge() {
  bridge = new Client({ name: 'uat-worker', version: '1.0.0' });
  await bridge.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'index.js')],
    env: { ...process.env, UAT_DIR },
    stderr: 'ignore',
  }));
}

async function call(tool, args) {
  const r = await bridge.callTool({ name: tool, arguments: args });
  const body = r.content.map((c) => c.text).join('\n');
  if (r.isError) {
    let err;
    try { err = JSON.parse(body).error; } catch { err = { code: 'unknown', message: body }; }
    const e = new Error(`${tool}: ${err.code} — ${err.message}`);
    e.code = err.code;
    throw e;
  }
  return body;
}

// ──────────────────────────────────────────────
// Queue reads (read-only)
// ──────────────────────────────────────────────

async function readDir(dir) {
  const out = [];
  let names = [];
  try { names = await fs.readdir(path.join(UAT_DIR, dir)); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fs.readFile(path.join(UAT_DIR, dir, n), 'utf-8'))); } catch {}
  }
  return out;
}

function eligible(test) {
  if (ONLY && !String(test.id).startsWith(ONLY)) return { ok: false, why: 'filtered (--only)' };
  if (LOOPBACK_ONLY) {
    let host;
    try { host = new URL(test.url).hostname; } catch { return { ok: false, why: 'bad url' }; }
    if (!LOOPBACK.has(host)) return { ok: false, why: `non-loopback host ${host} (--loopback-only)` };
  }
  return { ok: true };
}

const byPriorityThenAge = (a, b) =>
  (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2) ||
  String(a.created_at).localeCompare(String(b.created_at));

async function countDir(dir) {
  try { return (await fs.readdir(path.join(UAT_DIR, dir))).filter((n) => n.endsWith('.json')).length; } catch { return 0; }
}

async function writeStatus(extra = {}) {
  const pending = await readDir('pending');
  const inProg = await readDir('in-progress');
  const now = Date.now();
  const oldest = pending.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  const stuck = inProg.filter((t) => t.claimed_at && now - Date.parse(t.claimed_at) > STUCK_MINUTES * 60_000);
  const status = {
    generated_at: new Date().toISOString(),
    host: os.hostname(),
    queue: { pending: pending.length, in_progress: inProg.length, results: await countDir('results'), archive: await countDir('archive') },
    worker: { alive: true, pid: process.pid, lock_path: LOCK_PATH, executor: `cdp${AGENT === 'claude' ? '+claude' : ''}`, chrome_port: CHROME_PORT, ...extra },
    oldest_pending: oldest ? { id: oldest.id, age_seconds: Math.round((now - Date.parse(oldest.created_at)) / 1000), created_at: oldest.created_at } : null,
    stuck_in_progress: {
      count: stuck.length,
      oldest_age_seconds: stuck.length ? Math.round(Math.max(...stuck.map((t) => now - Date.parse(t.claimed_at))) / 1000) : null,
      threshold_minutes: STUCK_MINUTES,
    },
    stale_pending: { count: pending.filter((t) => now - Date.parse(t.created_at) > 24 * 3600_000).length, threshold_hours: 24 },
  };
  const tmp = `${STATUS_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(status, null, 2) + '\n');
  await fs.rename(tmp, STATUS_PATH);
}

// Reaper: in-progress tests claimed longer than STUCK_MINUTES ago go back to pending (via MCP).
async function reapStuck() {
  const now = Date.now();
  for (const t of await readDir('in-progress')) {
    if (!t.claimed_at || now - Date.parse(t.claimed_at) <= STUCK_MINUTES * 60_000) continue;
    if (!eligible(t).ok) continue;
    try { await call('uat_reset_test', { test_id: t.id }); log(`[REAP] ${t.id} — stuck > ${STUCK_MINUTES}m, back to pending`); }
    catch (e) { log(`[REAP-ERR] ${t.id} — ${e.message}`); }
  }
}

// ──────────────────────────────────────────────
// Chrome over CDP
// ──────────────────────────────────────────────

const CDP = `http://127.0.0.1:${CHROME_PORT}`;
let chromeProc = null;

async function chromeVersion() {
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function ensureChrome() {
  const v = await chromeVersion();
  if (v) return v;
  if (chromeProc) return waitForCdp(); // a launch is still warming up — never spawn a second Chrome on the same profile
  await fs.mkdir(CHROME_PROFILE, { recursive: true });
  const args = [
    `--remote-debugging-port=${CHROME_PORT}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${CHROME_PROFILE}`, '--no-first-run', '--no-default-browser-check',
    '--window-size=1280,900',
  ];
  if (CHROME_HEADLESS) args.push('--headless=new');
  log(`[CHROME] launching on 127.0.0.1:${CHROME_PORT} (${CHROME_HEADLESS ? 'headless' : 'headed'}) profile ${CHROME_PROFILE}`);
  chromeProc = spawn(CHROME_BIN, args, { stdio: 'ignore', detached: false });
  const proc = chromeProc;
  proc.on('exit', (c) => { log(`[CHROME] exited (${c})`); if (chromeProc === proc) chromeProc = null; });
  return waitForCdp();
}

// Cold start under launchd can take >10s; wait up to 45s for the debugging port.
async function waitForCdp() {
  for (let i = 0; i < 180; i++) {
    await sleep(250);
    const v = await chromeVersion();
    if (v) return v;
    if (!chromeProc) break;
  }
  throw Object.assign(new Error('Chrome did not expose CDP within 45s'), { code: 'chrome_unreachable' });
}

class Page {
  static async open() {
    const r = await fetch(`${CDP}/json/new?about:blank`, { method: 'PUT' });
    if (!r.ok) throw Object.assign(new Error(`CDP /json/new → ${r.status}`), { code: 'chrome_unreachable' });
    const t = await r.json();
    const p = new Page(t);
    await p.connect();
    return p;
  }
  constructor(target) { this.target = target; this.seq = 0; this.waiters = new Map(); this.listeners = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(Object.assign(new Error('CDP websocket error'), { code: 'chrome_unreachable' }));
      this.ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && this.waiters.has(m.id)) {
          const { res, rej } = this.waiters.get(m.id);
          this.waiters.delete(m.id);
          m.error ? rej(new Error(m.error.message)) : res(m.result);
        } else if (m.method) {
          for (const l of this.listeners) l(m);
        }
      };
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.waiters.set(id, { res, rej });
      setTimeout(() => { if (this.waiters.delete(id)) rej(new Error(`CDP ${method} timed out`)); }, 30_000);
    });
  }
  waitEvent(name, ms) {
    return new Promise((res) => {
      const l = (m) => { if (m.method === name) { done(); res(true); } };
      const t = setTimeout(() => { done(); res(false); }, ms);
      const done = () => { clearTimeout(t); this.listeners = this.listeners.filter((x) => x !== l); };
      this.listeners.push(l);
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  async close() {
    try { this.ws.close(); } catch {}
    try { await fetch(`${CDP}/json/close/${this.target.id}`); } catch {}
  }
}

// In-page element resolver: CSS selector first, then visible text / label / placeholder / name / aria-label.
const FIND_JS = `(target, kind) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  let els = [];
  try { els = [...document.querySelectorAll(target)]; } catch {}
  els = els.filter(vis);
  if (els.length) return els[0];
  const t = String(target).trim().toLowerCase();
  if (kind === 'input') {
    for (const lab of document.querySelectorAll('label')) {
      if (lab.innerText.trim().toLowerCase().includes(t)) {
        const el = lab.control || lab.querySelector('input,textarea,select');
        if (el && vis(el)) return el;
      }
    }
    for (const el of document.querySelectorAll('input,textarea,select,[contenteditable=true]')) {
      const keys = [el.placeholder, el.name, el.id, el.getAttribute('aria-label')].filter(Boolean).map((x) => x.toLowerCase());
      if (vis(el) && keys.some((k) => k.includes(t))) return el;
    }
    return null;
  }
  const pool = kind === 'click'
    ? 'a,button,[role=button],[role=link],[role=tab],[role=menuitem],input[type=submit],input[type=button],summary,label'
    : '*';
  const cands = [...document.querySelectorAll(pool)].filter((el) => vis(el) &&
    ((el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase().includes(t)));
  if (!cands.length && kind === 'click') return null;
  // smallest (most specific) match wins
  cands.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
  return cands[0] || null;
}`;

async function poll(fn, ms = STEP_TIMEOUT_MS) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    last = await fn();
    if (last?.ok || Date.now() > end) return last;
    await sleep(250);
  }
}

const q = (v) => JSON.stringify(v ?? '');

async function navigate(page, url) {
  const loaded = page.waitEvent('Page.loadEventFired', 30_000);
  const r = await page.send('Page.navigate', { url });
  if (r.errorText) return { ok: false, actual: `navigation error: ${r.errorText}` };
  await loaded;
  return { ok: true, actual: `loaded ${await page.eval('location.href')}` };
}

async function runStep(page, step, i, ctx) {
  const { action, target, value } = step;
  switch (action) {
    case 'navigate': {
      let url = value || target || ctx.test.url;
      try { url = new URL(url, await page.eval('location.href')).href; } catch {}
      if (LOOPBACK_ONLY && !LOOPBACK.has(new URL(url).hostname)) return { ok: false, actual: `refused non-loopback navigation to ${url} (--loopback-only)` };
      return navigate(page, url);
    }
    case 'click':
    case 'type':
    case 'select':
    case 'assert_visible': {
      const kind = action === 'click' ? 'click' : action === 'assert_visible' ? 'any' : 'input';
      const js = `(() => { const find = ${FIND_JS}; const el = find(${q(target)}, ${q(kind)}); if (!el) return { ok: false };
        el.scrollIntoView({ block: 'center' });
        const act = ${q(action)}, val = ${q(value)};
        if (act === 'click') el.click();
        if (act === 'type') { el.focus(); const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set; if (el.isContentEditable) el.innerText = val; else if (set) set.call(el, val); else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        if (act === 'select') { const o = [...el.options].find((o) => o.value === val || o.text.trim() === val); if (!o) return { ok: false, why: 'option not found: ' + val };
          el.value = o.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 120) }; })()`;
      const r = await poll(() => page.eval(js));
      if (!r?.ok) return { ok: false, actual: r?.why || `element not found within ${STEP_TIMEOUT_MS}ms: ${target}` };
      if (action === 'click') await sleep(300); // let handlers / navigations settle
      return { ok: true, actual: `${action} on <${r.tag}> "${r.text}"` };
    }
    case 'scroll': {
      const js = target
        ? `(() => { const el = (${FIND_JS})(${q(target)}, 'any'); if (!el) return { ok: false }; el.scrollIntoView({ block: 'center' }); return { ok: true }; })()`
        : `(() => { window.scrollBy(0, ${Number(value) || 600}); return { ok: true }; })()`;
      const r = await poll(() => page.eval(js));
      return r?.ok ? { ok: true, actual: target ? `scrolled to ${target}` : `scrolled ${Number(value) || 600}px` } : { ok: false, actual: `scroll target not found: ${target}` };
    }
    case 'wait': {
      if (target) {
        const r = await poll(() => page.eval(`(() => ({ ok: !!(${FIND_JS})(${q(target)}, 'any') }))()`), Number(value) || STEP_TIMEOUT_MS);
        return r?.ok ? { ok: true, actual: `found ${target}` } : { ok: false, actual: `timed out waiting for ${target}` };
      }
      const n = Number(value) || 1000;
      const ms = n < 100 ? n * 1000 : n; // small numbers are seconds
      await sleep(Math.min(ms, 60_000));
      return { ok: true, actual: `waited ${Math.min(ms, 60_000)}ms` };
    }
    case 'assert_text': {
      const expected = value ?? target;
      const js = value !== undefined && target
        ? `(() => { const el = (${FIND_JS})(${q(target)}, 'any'); const t = el ? (el.innerText || el.value || '') : null; return { ok: t !== null && t.includes(${q(expected)}), t: t === null ? null : t.slice(0, 200) }; })()`
        : `(() => { const t = document.body.innerText; return { ok: t.includes(${q(expected)}), t: t.slice(0, 200) }; })()`;
      const r = await poll(() => page.eval(js));
      return r?.ok ? { ok: true, actual: `found text "${expected}"` } : { ok: false, actual: r?.t === null ? `element not found: ${target}` : `text "${expected}" not found; saw "${r?.t}"` };
    }
    case 'assert_url': {
      const expected = value ?? target;
      const r = await poll(async () => { const u = await page.eval('location.href'); return { ok: u.includes(expected), u }; });
      return r.ok ? { ok: true, actual: `url ${r.u}` } : { ok: false, actual: `url "${r.u}" does not contain "${expected}"` };
    }
    case 'screenshot': {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      const rel = path.join('results', 'screenshots', ctx.test.id, `step-${i}.png`);
      await fs.mkdir(path.dirname(path.join(UAT_DIR, rel)), { recursive: true });
      await fs.writeFile(path.join(UAT_DIR, rel), Buffer.from(data, 'base64'));
      return { ok: true, actual: `screenshot saved`, screenshot_path: rel };
    }
    case 'custom':
      return runCustom(page, step, ctx);
    default:
      return { ok: false, actual: `unknown action ${action}` };
  }
}

// `custom` steps are free-form instructions. With UAT_AGENT=claude they go to a headless
// `claude -p` whose only tools are chrome-devtools-mcp attached to this worker's Chrome.
async function runCustom(page, step, ctx) {
  if (AGENT !== 'claude') return { skip: true, actual: 'custom step needs an agent executor (UAT_AGENT=claude); not run' };
  const url = await page.eval('location.href');
  const mcp = { mcpServers: { chrome: { command: '/opt/homebrew/bin/npx', args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', CDP] } } };
  const prompt = [
    'You are a UAT step executor. Chrome is already open; use ONLY the chrome tools.',
    `Select the open page whose URL is ${url} (do not open new tabs). Then perform this test step exactly:`,
    `Step: ${step.description}`, step.target ? `Target: ${step.target}` : '', step.value ? `Expected/Value: ${step.value}` : '',
    ctx.test.context ? `Test context: ${ctx.test.context}` : '',
    'Do not submit payments, send emails, or delete data. End your reply with ONE line of JSON:',
    '{"status":"passed"|"failed","actual":"<what you observed, one sentence>"}',
  ].filter(Boolean).join('\n');
  const out = await new Promise((resolve) => {
    execFile(CLAUDE_BIN, ['-p', prompt, '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config', '--allowedTools', 'mcp__chrome', '--output-format', 'json'],
      { timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024, cwd: os.tmpdir() },
      (err, stdout) => resolve(err ? { err } : { stdout }));
  });
  if (out.err) return { ok: false, actual: `agent executor error: ${String(out.err.message).slice(0, 300)}` };
  let textOut = '';
  try { textOut = JSON.parse(out.stdout).result || ''; } catch { textOut = out.stdout; }
  const m = textOut.match(/\{[^{}]*"status"\s*:\s*"(passed|failed)"[^{}]*\}\s*$/);
  if (!m) return { ok: false, actual: `agent gave no verdict: ${textOut.slice(-300)}` };
  const v = JSON.parse(m[0]);
  return { ok: v.status === 'passed', actual: `agent: ${v.actual || ''}` };
}

async function executeTest(test, version) {
  const page = await Page.open();
  const steps = test.steps || [];
  const results = [];
  let failed = false, skippedCustom = 0;
  try {
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    const nav = await navigate(page, test.url);
    if (!nav.ok) {
      steps.forEach((_, i) => results.push({ step_index: i, status: 'skipped', notes: 'not run — initial navigation failed' }));
      return { status: 'failed', step_results: results, summary: `Initial navigation to ${test.url} failed: ${nav.actual}`, version };
    }
    for (let i = 0; i < steps.length; i++) {
      if (failed) { results.push({ step_index: i, status: 'skipped', notes: 'not run — earlier step failed' }); continue; }
      let r;
      try { r = await runStep(page, steps[i], i, { test }); }
      catch (e) { r = { ok: false, actual: `step error: ${String(e.message).slice(0, 300)}` }; }
      const sr = { step_index: i, status: r.skip ? 'skipped' : r.ok ? 'passed' : 'failed', actual: r.actual };
      if (r.screenshot_path) sr.screenshot_path = r.screenshot_path;
      if (r.skip) skippedCustom++;
      if (!r.ok && !r.skip) failed = true;
      results.push(sr);
    }
    const passed = results.filter((r) => r.status === 'passed').length;
    const firstFail = results.find((r) => r.status === 'failed');
    const status = failed ? 'failed' : skippedCustom ? 'blocked' : 'passed';
    const summary = failed
      ? `Step ${firstFail.step_index + 1} failed: ${firstFail.actual}`
      : skippedCustom
        ? `${passed}/${steps.length} steps passed; ${skippedCustom} custom step(s) not run — enable UAT_AGENT=claude.`
        : `All ${steps.length} steps passed.`;
    return { status, step_results: results, summary, version, finalUrl: await page.eval('location.href').catch(() => '') };
  } finally {
    await page.close();
  }
}

// ──────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────

let stopping = false;
let consecutiveInfra = 0;

async function tick() {
  await reapStuck();
  const pending = (await readDir('pending')).sort(byPriorityThenAge);
  const runnable = pending.filter((t) => eligible(t).ok);
  if (DRY_RUN) {
    const v = await chromeVersion();
    log(`[DRY-RUN] queue ${UAT_DIR}: ${pending.length} pending, ${runnable.length} eligible; chrome 127.0.0.1:${CHROME_PORT} ${v ? 'UP ' + v.Browser : 'DOWN (would launch ' + (CHROME_HEADLESS ? 'headless' : 'headed') + ')'}; agent=${AGENT}`);
    for (const t of pending) { const e = eligible(t); log(`  ${e.ok ? 'WOULD RUN' : 'skip     '} ${t.priority?.padEnd(8)} ${t.id}${e.ok ? '' : ' — ' + e.why}`); }
    return 0;
  }
  let ran = 0;
  for (const t of runnable) {
    if (stopping) break;
    let version;
    try { version = await ensureChrome(); }
    catch (e) { log(`[INFRA] ${e.message}`); consecutiveInfra++; break; }
    try { await call('uat_claim_test', { test_id: t.id }); }
    catch (e) { log(`[CLAIM-SKIP] ${t.id} — ${e.code}`); continue; }
    const started = Date.now();
    let res;
    try {
      res = await executeTest(t, version);
      consecutiveInfra = 0;
    } catch (e) {
      // Infrastructure failure (Chrome died, CDP unreachable): give the test back, don't mark it failed.
      log(`[INFRA] ${t.id} — ${e.message}; resetting to pending`);
      await call('uat_reset_test', { test_id: t.id }).catch((er) => log(`[RESET-ERR] ${t.id} — ${er.message}`));
      consecutiveInfra++;
      break;
    }
    await call('uat_complete_test', {
      test_id: t.id, status: res.status, step_results: res.step_results, summary: res.summary,
      environment: { browser: res.version?.Browser || 'Chrome', viewport: '1280x900', url: res.finalUrl || t.url, timestamp: new Date().toISOString(), worker: `uat-worker@${os.hostname()} pid ${process.pid}` },
    });
    ran++;
    log(`[${res.status.toUpperCase()}] ${t.id} — ${res.step_results.length} steps in ${Math.round((Date.now() - started) / 1000)}s. ${res.summary}`);
  }
  await writeStatus({ last_tick: new Date().toISOString(), consecutive_infra_failures: consecutiveInfra });
  return ran;
}

async function shutdown(code = 0) {
  stopping = true;
  try { await fs.writeFile(STATUS_PATH + '.tmp', JSON.stringify({ ...JSON.parse(await fs.readFile(STATUS_PATH, 'utf-8')), worker: { alive: false, pid: null, lock_path: LOCK_PATH } }, null, 2)); await fs.rename(STATUS_PATH + '.tmp', STATUS_PATH); } catch {}
  await releaseLock();
  try { chromeProc?.kill('SIGTERM'); } catch {}
  try { await bridge?.close(); } catch {}
  process.exit(code);
}

async function main() {
  for (const d of ['pending', 'in-progress', 'results', 'archive']) await fs.mkdir(path.join(UAT_DIR, d), { recursive: true });
  if (!DRY_RUN) {
    const other = await acquireLock();
    if (other) {
      log(`[LOCK] another worker is running (pid ${other}); exiting`);
      if (!ONCE) await sleep(60_000); // keep launchd KeepAlive from hot-looping
      process.exit(0);
    }
    process.on('SIGTERM', () => shutdown(0));
    process.on('SIGINT', () => shutdown(0));
  }
  await connectBridge();
  log(`[BOOT] uat-worker pid ${process.pid} queue ${UAT_DIR} chrome :${CHROME_PORT} agent=${AGENT}${ONCE ? ' once' : ''}${DRY_RUN ? ' dry-run' : ''}${LOOPBACK_ONLY ? ' loopback-only' : ''}${ONLY ? ' only=' + ONLY : ''}`);
  if (DRY_RUN) { await tick(); await bridge.close(); return; }
  for (;;) {
    let ran = 0;
    try { ran = await tick(); } catch (e) { log(`[TICK-ERR] ${e.message}`); consecutiveInfra++; }
    if (ONCE && ran === 0) break;
    if (consecutiveInfra >= 3) {
      log(`[BACKOFF] ${consecutiveInfra} consecutive infrastructure failures — pausing 5m`);
      await sleep(5 * 60_000);
      consecutiveInfra = 0;
    } else if (!ONCE) {
      await sleep(POLL_MS);
    }
  }
  await shutdown(0);
}

main().catch(async (e) => { log(`[FATAL] ${e.stack || e.message}`); await releaseLock(); process.exit(1); });
