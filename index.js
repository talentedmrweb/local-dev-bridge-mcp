#!/usr/bin/env node
// local-dev-bridge-mcp v3 — Herdr agent/pane control + the UAT work queue.
//
// File and shell work is NOT done here any more: use the native device bridge
// (connected folders) in Desktop/Cowork, or Claude Code's own Bash/Read/Edit.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { detectUnsent } from './lib/unsent.js';
import { checkSubmit, checkPickerScreen, mapKeys, KEY_MAP, MAX_KEYS } from './lib/guards.js';

const VERSION = '3.1.0';

// ──────────────────────────────────────────────
// Config — UAT_DIR is the only setting.
// ──────────────────────────────────────────────

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const UAT_DIR = path.resolve(expandHome(process.env.UAT_DIR || path.join(os.homedir(), 'Projects', 'uat-queue')));
const QUEUE_DIRS = ['pending', 'in-progress', 'results', 'archive'];

// Fixed allow-list of Homebrew prefixes (Apple Silicon, Intel). No PATH lookup, no shell.
const HERDR_CANDIDATES = ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr'];
const HERDR_BIN = HERDR_CANDIDATES.find((p) => existsSync(p)) || HERDR_CANDIDATES[0];
const HERDR_DEFAULT_TIMEOUT_MS = 30_000;

const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const RESULT_STATUSES = ['passed', 'failed', 'blocked', 'skipped'];
const STEP_STATUSES = ['passed', 'failed', 'skipped'];
const STEP_ACTIONS = [
  'navigate', 'click', 'type', 'select', 'scroll', 'wait',
  'assert_visible', 'assert_text', 'assert_url', 'screenshot', 'custom',
];
const AGENT_STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
const READ_SOURCES = ['visible', 'recent', 'recent-unwrapped'];
const EMOJI = { passed: '✅', failed: '❌', blocked: '🚫', skipped: '⏭️' };

// ──────────────────────────────────────────────
// Structured errors — never a stack trace to the caller.
// ──────────────────────────────────────────────

class BridgeError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details) => {
  throw new BridgeError(code, message, details);
};

function errorResult(err) {
  let body;
  if (err instanceof BridgeError) {
    body = { error: { code: err.code, message: err.message, ...(err.details !== undefined && { details: err.details }) } };
  } else {
    console.error('[local-dev-bridge] internal error:', err);
    body = { error: { code: 'internal_error', message: 'Unexpected internal error (details on bridge stderr).' } };
  }
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });

// ──────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────

const TEST_ID_RE = /^[a-z0-9-]{1,100}$/;

function assertTestId(id) {
  if (typeof id !== 'string' || !TEST_ID_RE.test(id)) {
    fail('invalid_test_id', 'test_id must match [a-z0-9-]{1,100} (no slashes, dots, or absolute paths).', { test_id: id });
  }
  return id;
}

function assertString(v, field, { required = false, max = 10_000 } = {}) {
  if (v === undefined || v === null) {
    if (required) fail('invalid_argument', `${field} is required.`, { field });
    return undefined;
  }
  if (typeof v !== 'string') fail('invalid_argument', `${field} must be a string.`, { field });
  if (required && v.trim() === '') fail('invalid_argument', `${field} must not be empty.`, { field });
  if (v.length > max) fail('invalid_argument', `${field} exceeds ${max} characters.`, { field });
  return v;
}

function assertEnum(v, field, allowed, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) fail('invalid_argument', `${field} is required.`, { field, allowed });
    return undefined;
  }
  if (!allowed.includes(v)) fail('invalid_argument', `${field} must be one of: ${allowed.join(', ')}.`, { field, value: v, allowed });
  return v;
}

// Path-like data we store (screenshot_path): relative, no traversal.
function assertRelativeNoEscape(v, field) {
  if (v === undefined || v === null) return undefined;
  assertString(v, field, { max: 1000 });
  const norm = v.replace(/\\/g, '/');
  if (path.isAbsolute(v) || /^[A-Za-z]:/.test(v) || norm.startsWith('~') || norm.split('/').includes('..')) {
    fail('path_not_allowed', `${field} must be a relative path inside the UAT queue (no absolute paths, ~, or ..).`, { field, value: v });
  }
  return v;
}

// ──────────────────────────────────────────────
// UAT path confinement + atomic file ops
// ──────────────────────────────────────────────

function uatPath(dir, file) {
  if (!QUEUE_DIRS.includes(dir)) fail('internal_error', 'Bad queue directory.');
  const p = path.resolve(UAT_DIR, dir, file);
  if (!p.startsWith(UAT_DIR + path.sep)) fail('path_not_allowed', 'Resolved path escapes UAT_DIR.', { file });
  return p;
}

async function ensureUatDirs() {
  for (const dir of QUEUE_DIRS) await fs.mkdir(path.join(UAT_DIR, dir), { recursive: true });
}

async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

// Refuses symlinks so a planted link cannot pull data from outside UAT_DIR.
async function readJson(p) {
  const st = await fs.lstat(p);
  if (!st.isFile()) fail('path_not_allowed', 'Queue entry is not a regular file.', { file: path.basename(p) });
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    fail('corrupt_queue_file', `Queue file is not valid JSON: ${path.basename(p)}`);
  }
}

async function writeAtomic(p, data) {
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, { encoding: 'utf-8', flag: 'wx' });
  await fs.rename(tmp, p);
}
const writeJsonAtomic = (p, obj) => writeAtomic(p, JSON.stringify(obj, null, 2));

const unlinkQuiet = (p) => fs.unlink(p).catch(() => {});
const moveQuiet = (from, to) => fs.rename(from, to).catch(() => {});

// *.json entries of a queue dir; unreadable/corrupt files are reported, never fatal.
async function listQueue(dir) {
  const d = path.join(UAT_DIR, dir);
  const names = (await fs.readdir(d)).filter((f) => f.endsWith('.json') && TEST_ID_RE.test(f.slice(0, -5)));
  const items = [];
  const skipped = [];
  for (const f of names) {
    try {
      items.push(await readJson(path.join(d, f)));
    } catch {
      skipped.push(f);
    }
  }
  return { items, skipped };
}

const skippedNote = (skipped) => (skipped.length ? `\n\n⚠️ Skipped ${skipped.length} unreadable file(s): ${skipped.join(', ')}` : '');

// ──────────────────────────────────────────────
// Herdr — argv only, no shell, fixed subcommand allow-list.
// ──────────────────────────────────────────────

const HERDR_ALLOWED = new Set(['agent list', 'pane read', 'pane send-text', 'pane run', 'agent wait', 'pane send-keys']);

// Text the bridge typed via herdr_agent_send, per target: { text, at }. In memory only, so a restart forgets it
// (fail closed: herdr_pane_submit then refuses).
const sentByBridge = new Map();
const TARGET_RE = /^[A-Za-z0-9][A-Za-z0-9_:.\-]{0,127}$/;

function assertTarget(t) {
  if (typeof t !== 'string' || !TARGET_RE.test(t)) {
    fail('invalid_target', 'target must be a pane id, terminal id, or agent name ([A-Za-z0-9_:.-], not starting with "-").', { target: t });
  }
  return t;
}

function herdr(args, { timeoutMs = HERDR_DEFAULT_TIMEOUT_MS } = {}) {
  const sub = args.slice(0, 2).join(' ');
  if (!HERDR_ALLOWED.has(sub)) fail('herdr_not_allowed', `herdr subcommand not allowed: ${sub}`);
  return new Promise((resolve, reject) => {
    execFile(HERDR_BIN, args, { shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = undefined;
      }
      if (err) {
        if (err.code === 'ENOENT') return reject(new BridgeError('herdr_unavailable', `herdr not found at ${HERDR_BIN}.`));
        if (err.killed) return reject(new BridgeError('herdr_timeout', `herdr ${sub} timed out after ${timeoutMs} ms.`));
        const output = parsed?.error ?? String(stderr || stdout || '').trim().slice(0, 2000);
        return reject(new BridgeError('herdr_failed', `herdr ${sub} exited ${err.code}.`, { output }));
      }
      if (parsed?.error) return reject(new BridgeError('herdr_failed', `herdr ${sub} returned an error.`, { output: parsed.error }));
      resolve({ raw: String(stdout), json: parsed });
    });
  });
}

// House rule: never type over operator text that is sitting un-sent in a pane.
function readText(json, raw) {
  const t = json?.result?.read?.text;
  if (typeof t === 'string') return t;
  return json === undefined ? raw : undefined;
}

async function guardUnsent(target) {
  // `pane read` works on any pane (shell or agent); herdr 0.9.x prints plain text, older builds a JSON envelope.
  const { json, raw } = await herdr(['pane', 'read', target, '--source', 'visible', '--format', 'ansi']);
  const screen = readText(json, raw);
  if (typeof screen !== 'string') fail('herdr_failed', 'Could not read the target pane to check its input line.', { target });
  const d = detectUnsent(screen);
  if (d.state === 'unsent') {
    fail('unsent_operator_text', `Refused: the input line in ${target} already holds un-sent text. Not typing over it.`, {
      target,
      unsent_text: d.text,
      pane_kind: d.kind,
    });
  }
  return d;
}

const suggestionNote = (d) => (d.state === 'suggestion' ? ` (pane showed only Claude Code's dim prompt suggestion "${d.text}")` : '');

// ──────────────────────────────────────────────
// Tool definitions
// ──────────────────────────────────────────────

const testIdProp = { test_id: { type: 'string', description: 'Test ID ([a-z0-9-])' } };

const TOOLS = [
  // ── UAT queue ────────────────────────────────
  {
    name: 'uat_queue_test',
    description: 'Queue a new UAT test for browser execution. Writes a structured test file to the pending queue and returns the test ID.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human-readable test name (e.g. "Login flow happy path")' },
        url: { type: 'string', description: 'Starting URL (http:// or https://)' },
        steps: {
          type: 'array',
          description: 'Ordered list of test steps',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: STEP_ACTIONS, description: 'What to do' },
              target: { type: 'string', description: 'CSS selector, text, URL, or natural-language element description' },
              value: { type: 'string', description: 'Value to type, option to select, expected text, or extra context' },
              description: { type: 'string', description: 'What this step does and why' },
            },
            required: ['action', 'description'],
          },
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (e.g. ["smoke", "auth"])' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Test priority (default: medium)' },
        context: { type: 'string', description: 'Free-form context for the executor' },
      },
      required: ['name', 'url', 'steps'],
    },
  },
  {
    name: 'uat_get_pending',
    description: 'List pending UAT tests waiting to be executed, critical first.',
    inputSchema: {
      type: 'object',
      properties: {
        tag: { type: 'string', description: 'Filter by tag (optional)' },
        priority: { type: 'string', enum: PRIORITIES, description: 'Filter by priority (optional)' },
      },
    },
  },
  {
    name: 'uat_get_test',
    description: 'Read the full details of a UAT test by ID (searches pending, in-progress, results, archive).',
    inputSchema: { type: 'object', properties: testIdProp, required: ['test_id'] },
  },
  {
    name: 'uat_claim_test',
    description: 'Atomically claim a pending test (pending/ → in-progress/). A second claimer gets an "already_claimed" error. Returns execution instructions.',
    inputSchema: { type: 'object', properties: testIdProp, required: ['test_id'] },
  },
  {
    name: 'uat_complete_test',
    description: 'Record results for a claimed test (in-progress/ → results/).',
    inputSchema: {
      type: 'object',
      properties: {
        ...testIdProp,
        status: { type: 'string', enum: RESULT_STATUSES, description: 'Overall result' },
        step_results: {
          type: 'array',
          description: 'Per-step results',
          items: {
            type: 'object',
            properties: {
              step_index: { type: 'number', description: '0-based step index' },
              status: { type: 'string', enum: STEP_STATUSES },
              actual: { type: 'string', description: 'What actually happened' },
              screenshot_path: { type: 'string', description: 'Relative path (inside the UAT queue) to a screenshot, if any' },
              notes: { type: 'string', description: 'Observations or issues' },
            },
            required: ['step_index', 'status'],
          },
        },
        summary: { type: 'string', description: 'Overall summary of the run' },
        environment: {
          type: 'object',
          description: 'Browser/environment info',
          properties: {
            browser: { type: 'string' },
            viewport: { type: 'string' },
            url: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
      required: ['test_id', 'status', 'summary'],
    },
  },
  {
    name: 'uat_get_results',
    description: 'Get UAT results — one test by ID, or a filtered list.',
    inputSchema: {
      type: 'object',
      properties: {
        test_id: { type: 'string', description: 'Specific test ID (optional)' },
        status: { type: 'string', enum: RESULT_STATUSES, description: 'Filter by result (optional)' },
        since: { type: 'string', description: 'ISO date — only results completed at/after this (optional)' },
      },
    },
  },
  {
    name: 'uat_reset_test',
    description: 'Move a test from in-progress/ or results/ back to pending/ for a re-run.',
    inputSchema: { type: 'object', properties: testIdProp, required: ['test_id'] },
  },
  {
    name: 'uat_dashboard',
    description: 'Summary of the UAT queue: pending by priority, in-progress, and completed by result.',
    inputSchema: { type: 'object', properties: {} },
  },

  // ── Herdr ────────────────────────────────────
  {
    name: 'herdr_agent_list',
    description: 'List Herdr agents/panes on this Mac (herdr agent list).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'herdr_agent_read',
    description: "Read a Herdr pane's screen/scrollback (herdr pane read). Defaults: source=recent, lines=120.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Pane id (e.g. "wM:p1"), terminal id, or agent name' },
        source: { type: 'string', enum: READ_SOURCES, description: 'visible | recent | recent-unwrapped (default recent)' },
        lines: { type: 'number', description: 'Lines to read, 1–2000 (default 120)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'herdr_agent_send',
    description: "Type literal text into a Herdr agent's input (herdr pane send-text) — no Enter. Refuses if the input line already holds un-sent operator text.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Pane id, terminal id, or agent name' },
        text: { type: 'string', description: 'Literal text to type' },
      },
      required: ['target', 'text'],
    },
  },
  {
    name: 'herdr_pane_run',
    description: 'Run a command in a Herdr pane (herdr pane run: text + Enter). Refuses if the input line already holds un-sent operator text.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Pane id (e.g. "wN:p2")' },
        command: { type: 'string', description: 'Single-line command; Enter is pressed after it' },
      },
      required: ['target', 'command'],
    },
  },
  {
    name: 'herdr_pane_submit',
    description:
      "Press Enter in a Herdr pane, only to submit text the bridge itself typed there via herdr_agent_send in the last 5 minutes. Refuses if the input line holds anything else (e.g. the operator's own un-sent text) or a permission prompt is showing.",
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Pane id (e.g. "wN:p1")' } },
      required: ['target'],
    },
  },
  {
    name: 'herdr_pane_keys',
    description:
      'Send navigation keys to answer a Claude Code AskUserQuestion picker ("Enter to select"). Allowed keys: Enter, Esc, Up, Down, Tab, 1-9. Refuses on tool-permission, approval or trust prompts, and when no picker is visible.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Pane id (e.g. "wN:p1")' },
        keys: { type: 'array', items: { type: 'string', enum: Object.keys(KEY_MAP) }, minItems: 1, maxItems: MAX_KEYS, description: 'Keys in order, e.g. ["2"] or ["Down","Enter"]' },
      },
      required: ['target', 'keys'],
    },
  },
  {
    name: 'herdr_wait',
    description: 'Wait until a Herdr agent reaches a status (herdr agent wait).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Pane id, terminal id, or agent name' },
        status: { type: 'string', enum: AGENT_STATUSES, description: 'Status to wait for' },
        timeout_ms: { type: 'number', description: 'Max wait in ms, 1000–600000 (default 30000)' },
      },
      required: ['target', 'status'],
    },
  },
];

// ──────────────────────────────────────────────
// UAT handlers
// ──────────────────────────────────────────────

function generateTestId(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40) || 'test';
  return `${slug}-${crypto.randomBytes(4).toString('hex')}`;
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) fail('invalid_steps', 'steps must be a non-empty array.');
  if (steps.length > 200) fail('invalid_steps', 'steps exceeds 200 entries.');
  const errors = [];
  steps.forEach((s, i) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return errors.push({ step_index: i, error: 'step must be an object' });
    if (!STEP_ACTIONS.includes(s.action)) errors.push({ step_index: i, error: `unknown action "${s.action}"`, allowed: STEP_ACTIONS });
    if (typeof s.description !== 'string' || !s.description.trim()) errors.push({ step_index: i, error: 'description is required' });
    for (const k of ['target', 'value']) {
      if (s[k] !== undefined && typeof s[k] !== 'string') errors.push({ step_index: i, error: `${k} must be a string` });
    }
  });
  if (errors.length) fail('invalid_steps', `${errors.length} invalid step(s).`, { errors });
  return steps.map(({ action, target, value, description }) => ({
    action,
    ...(target !== undefined && { target }),
    ...(value !== undefined && { value }),
    description,
  }));
}

async function uatQueueTest(args) {
  const name = assertString(args.name, 'name', { required: true, max: 200 });
  const url = assertString(args.url, 'url', { required: true, max: 2000 });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail('invalid_argument', 'url must be an absolute http:// or https:// URL.', { url });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) fail('invalid_argument', 'url must use http or https.', { url });
  const steps = validateSteps(args.steps);
  let tags = [];
  if (args.tags !== undefined) {
    if (!Array.isArray(args.tags) || !args.tags.every((t) => typeof t === 'string' && t.length <= 100)) {
      fail('invalid_argument', 'tags must be an array of strings.');
    }
    tags = args.tags;
  }
  const priority = assertEnum(args.priority, 'priority', PRIORITIES) || 'medium';
  const context = assertString(args.context, 'context', { max: 20_000 }) || '';

  await ensureUatDirs();
  const id = generateTestId(name);
  const test = { id, name, url, steps, tags, priority, context, created_at: new Date().toISOString(), created_by: 'claude-code', status: 'pending' };
  await fs.writeFile(uatPath('pending', `${id}.json`), JSON.stringify(test, null, 2), { encoding: 'utf-8', flag: 'wx' });
  await fs.writeFile(uatPath('pending', `${id}.md`), testToMarkdown(test), 'utf-8');
  return text(`✅ Test queued\n\nTest ID: ${id}\nName: ${name}\nPriority: ${priority}\nSteps: ${steps.length}\nLocation: pending/${id}.json\n\nClaim it with uat_claim_test.`);
}

async function uatGetPending(args) {
  const tag = assertString(args.tag, 'tag', { max: 100 });
  const priority = assertEnum(args.priority, 'priority', PRIORITIES);
  await ensureUatDirs();
  const { items, skipped } = await listQueue('pending');
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  const tests = items
    .filter((t) => (!tag || (Array.isArray(t.tags) && t.tags.includes(tag))) && (!priority || t.priority === priority))
    .sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2) || new Date(a.created_at) - new Date(b.created_at));
  if (tests.length === 0) return text('No pending tests in the queue.' + skippedNote(skipped));
  const lines = tests.map(
    (t, i) =>
      `${i + 1}. [${String(t.priority || 'medium').toUpperCase()}] ${t.name}\n   ID: ${t.id}\n   URL: ${t.url}\n   Steps: ${(t.steps || []).length} | Tags: ${(t.tags || []).join(', ') || 'none'}\n   Queued: ${t.created_at}`
  );
  return text(`📋 Pending UAT Tests (${tests.length}):\n\n${lines.join('\n\n')}\n\nUse uat_claim_test with a test ID to begin execution.` + skippedNote(skipped));
}

async function uatGetTest(args) {
  const id = assertTestId(args.test_id);
  await ensureUatDirs();
  for (const dir of QUEUE_DIRS) {
    const p = uatPath(dir, `${id}.json`);
    if (await exists(p)) return text(`Test found in ${dir}/:\n\n${JSON.stringify(await readJson(p), null, 2)}`);
  }
  fail('not_found', `Test not found: ${id}`, { test_id: id });
}

async function uatClaimTest(args) {
  const id = assertTestId(args.test_id);
  await ensureUatDirs();
  const from = uatPath('pending', `${id}.json`);
  const to = uatPath('in-progress', `${id}.json`);
  if (await exists(to)) fail('already_claimed', `Test ${id} is already claimed (in-progress).`, { test_id: id });
  // The rename IS the claim: atomic on one filesystem, so exactly one caller wins.
  try {
    await fs.rename(from, to);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (await exists(to)) fail('already_claimed', `Test ${id} was just claimed by another session.`, { test_id: id });
    if (await exists(uatPath('results', `${id}.json`))) fail('already_completed', `Test ${id} is already completed.`, { test_id: id });
    fail('not_found', `Test ${id} is not in the pending queue.`, { test_id: id });
  }
  await moveQuiet(uatPath('pending', `${id}.md`), uatPath('in-progress', `${id}.md`));
  const test = await readJson(to);
  test.status = 'in-progress';
  test.claimed_at = new Date().toISOString();
  test.claimed_by = 'claude-chrome';
  await writeJsonAtomic(to, test);
  return text(
    `🔄 Test claimed: ${test.name}\n\nID: ${id}\nURL: ${test.url}\nSteps: ${(test.steps || []).length}\nPriority: ${test.priority}\n\n--- EXECUTION INSTRUCTIONS ---\n\n${stepsToInstructions(test)}\n\nWhen finished, use uat_complete_test to record results.`
  );
}

function validateStepResults(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) fail('invalid_argument', 'step_results must be an array.');
  return raw.map((sr, i) => {
    if (!sr || typeof sr !== 'object' || Array.isArray(sr)) fail('invalid_argument', `step_results[${i}] must be an object.`);
    if (!Number.isInteger(sr.step_index) || sr.step_index < 0) fail('invalid_argument', `step_results[${i}].step_index must be a non-negative integer.`);
    assertEnum(sr.status, `step_results[${i}].status`, STEP_STATUSES, { required: true });
    assertString(sr.actual, `step_results[${i}].actual`);
    assertString(sr.notes, `step_results[${i}].notes`);
    assertRelativeNoEscape(sr.screenshot_path, `step_results[${i}].screenshot_path`);
    return sr;
  });
}

function validateEnvironment(raw) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_argument', 'environment must be an object.');
  for (const [k, v] of Object.entries(raw)) assertString(v, `environment.${k}`, { max: 2000 });
  return raw;
}

async function uatCompleteTest(args) {
  const id = assertTestId(args.test_id);
  const status = assertEnum(args.status, 'status', RESULT_STATUSES, { required: true });
  const summary = assertString(args.summary, 'summary', { required: true, max: 20_000 });
  const stepResults = validateStepResults(args.step_results);
  const environment = validateEnvironment(args.environment);

  await ensureUatDirs();
  const src = uatPath('in-progress', `${id}.json`);
  const lock = `${src}.completing`;
  // Atomic hand-off so two completers cannot both write a result.
  try {
    await fs.rename(src, lock);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    if (await exists(uatPath('results', `${id}.json`))) fail('already_completed', `Test ${id} is already completed.`, { test_id: id });
    if (await exists(uatPath('pending', `${id}.json`))) fail('not_claimed', `Test ${id} is pending — claim it first.`, { test_id: id });
    fail('not_found', `Test ${id} is not in the in-progress queue.`, { test_id: id });
  }
  try {
    const test = await readJson(lock);
    const nSteps = (test.steps || []).length;
    const bad = stepResults.filter((sr) => sr.step_index >= nSteps).map((sr) => sr.step_index);
    if (bad.length) fail('invalid_argument', `step_index out of range (test has ${nSteps} steps).`, { step_index: bad });
    const result = {
      ...test,
      status: 'completed',
      result: status,
      completed_at: new Date().toISOString(),
      step_results: stepResults,
      summary,
      environment,
      duration_seconds: test.claimed_at ? Math.round((Date.now() - new Date(test.claimed_at).getTime()) / 1000) : null,
    };
    await writeJsonAtomic(uatPath('results', `${id}.json`), result);
    await writeAtomic(uatPath('results', `${id}.md`), resultToMarkdown(result));
    await unlinkQuiet(lock);
    await unlinkQuiet(uatPath('in-progress', `${id}.md`));
    return text(
      `${EMOJI[status]} Test completed: ${test.name}\n\nResult: ${status.toUpperCase()}\nDuration: ${result.duration_seconds}s\nSummary: ${summary}\n\nSaved to: results/${id}.json`
    );
  } catch (e) {
    await fs.rename(lock, src).catch(() => {}); // put the claim back so the test is not stranded
    throw e;
  }
}

async function uatGetResults(args) {
  const status = assertEnum(args.status, 'status', RESULT_STATUSES);
  const since = assertString(args.since, 'since', { max: 100 });
  if (since && Number.isNaN(new Date(since).getTime())) fail('invalid_argument', 'since must be an ISO date string.', { since });
  await ensureUatDirs();
  if (args.test_id !== undefined) {
    const id = assertTestId(args.test_id);
    const p = uatPath('results', `${id}.json`);
    if (!(await exists(p))) fail('not_found', `No results found for test: ${id}`, { test_id: id });
    return text(JSON.stringify(await readJson(p), null, 2));
  }
  const { items, skipped } = await listQueue('results');
  const results = items
    .filter((r) => (!status || r.result === status) && (!since || new Date(r.completed_at) >= new Date(since)))
    .sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  if (results.length === 0) return text('No test results found matching the criteria.' + skippedNote(skipped));
  const lines = results.map(
    (r) => `${EMOJI[r.result] || '❓'} ${r.name}\n   ID: ${r.id} | Result: ${String(r.result).toUpperCase()}\n   Completed: ${r.completed_at}\n   Summary: ${r.summary}`
  );
  return text(`📊 Test Results (${results.length}):\n\n${lines.join('\n\n')}` + skippedNote(skipped));
}

async function uatResetTest(args) {
  const id = assertTestId(args.test_id);
  await ensureUatDirs();
  const pending = uatPath('pending', `${id}.json`);
  if (await exists(pending)) fail('already_pending', `Test ${id} is already pending.`, { test_id: id });
  for (const dir of ['in-progress', 'results']) {
    const src = uatPath(dir, `${id}.json`);
    const lock = `${src}.resetting`;
    try {
      await fs.rename(src, lock);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    try {
      const test = await readJson(lock);
      for (const k of ['claimed_at', 'claimed_by', 'completed_at', 'result', 'step_results', 'summary', 'environment', 'duration_seconds']) delete test[k];
      test.status = 'pending';
      test.reset_at = new Date().toISOString();
      await writeJsonAtomic(pending, test);
      await writeAtomic(uatPath('pending', `${id}.md`), testToMarkdown(test));
      await unlinkQuiet(lock);
      await unlinkQuiet(uatPath(dir, `${id}.md`));
      return text(`♻️ Test reset to pending: ${test.name}\n\nMoved from ${dir}/ back to pending/.`);
    } catch (e) {
      await fs.rename(lock, src).catch(() => {});
      throw e;
    }
  }
  fail('not_found', `Test ${id} not found in in-progress or results.`, { test_id: id });
}

async function uatDashboard() {
  await ensureUatDirs();
  const [pending, inProgress, results] = await Promise.all(['pending', 'in-progress', 'results'].map(listQueue));
  const pri = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const t of pending.items) pri[PRIORITIES.includes(t.priority) ? t.priority : 'medium']++;
  const res = { passed: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const r of results.items) if (res[r.result] !== undefined) res[r.result]++;
  const total = Object.values(res).reduce((a, b) => a + b, 0);
  const passRate = total > 0 ? `${((res.passed / total) * 100).toFixed(1)}%` : 'N/A';
  const pad = (n) => String(n).padStart(4);
  const dash = [
    'UAT QUEUE DASHBOARD',
    `Queue: ${UAT_DIR}`,
    '',
    `📋 Pending:     ${pad(pending.items.length)}   (critical ${pri.critical} · high ${pri.high} · medium ${pri.medium} · low ${pri.low})`,
    `🔄 In progress: ${pad(inProgress.items.length)}`,
    `📊 Completed:   ${pad(total)}   (✅ ${res.passed} · ❌ ${res.failed} · 🚫 ${res.blocked} · ⏭️ ${res.skipped})`,
    `Pass rate: ${passRate}`,
  ].join('\n');
  return text(dash + skippedNote([...pending.skipped, ...inProgress.skipped, ...results.skipped]));
}

// ──────────────────────────────────────────────
// Herdr handlers
// ──────────────────────────────────────────────

async function herdrAgentList() {
  const { json, raw } = await herdr(['agent', 'list']);
  const agents = json?.result?.agents;
  if (!Array.isArray(agents)) return text(raw);
  const rows = agents.map(
    (a) => `${String(a.pane_id).padEnd(8)} ${String(a.agent_status).padEnd(8)} ${a.agent || '-'}  ${a.terminal_title_stripped || ''}  (${a.cwd})`
  );
  return text(`Herdr agents (${agents.length}):\n\n${rows.join('\n')}`);
}

async function herdrAgentRead(args) {
  const target = assertTarget(args.target);
  const source = assertEnum(args.source, 'source', READ_SOURCES) || 'recent';
  let lines = 120;
  if (args.lines !== undefined) {
    if (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > 2000) fail('invalid_argument', 'lines must be an integer 1–2000.');
    lines = args.lines;
  }
  const { json, raw } = await herdr(['pane', 'read', target, '--source', source, '--lines', String(lines)]);
  return text(readText(json, raw));
}

async function herdrAgentSend(args) {
  const target = assertTarget(args.target);
  const t = assertString(args.text, 'text', { required: true, max: 20_000 });
  const before = await guardUnsent(target);
  // herdr 0.9.x dropped `agent send`; `pane send-text` is the literal, no-Enter equivalent.
  await herdr(['pane', 'send-text', target, t]);
  sentByBridge.set(target, { text: t, at: Date.now() });
  return text(`✉️ Sent ${t.length} chars to ${target} (no Enter)${suggestionNote(before)}.`);
}

async function readScreen(target) {
  const { json, raw } = await herdr(['pane', 'read', target, '--source', 'visible', '--format', 'ansi']);
  const screen = readText(json, raw);
  if (typeof screen !== 'string') fail('herdr_failed', 'Could not read the target pane.', { target });
  return screen;
}

async function herdrPaneSubmit(args) {
  const target = assertTarget(args.target);
  const screen = await readScreen(target);
  const approval = checkPickerScreen(screen);
  if (approval.code === 'approval_prompt') fail(approval.code, approval.reason, { target });
  const v = checkSubmit(detectUnsent(screen), sentByBridge.get(target));
  if (!v.ok) fail(v.code, v.reason, { target });
  await herdr(['pane', 'send-keys', target, 'enter']);
  sentByBridge.delete(target);
  return text(`⏎ Submitted the bridge's own text in ${target}.`);
}

async function herdrPaneKeys(args) {
  const target = assertTarget(args.target);
  const m = mapKeys(args.keys);
  if (!m.ok) fail(m.code, m.reason);
  const v = checkPickerScreen(await readScreen(target));
  if (!v.ok) fail(v.code, v.reason, { target });
  await herdr(['pane', 'send-keys', target, ...m.keys]);
  return text(`⌨️ Sent ${args.keys.join(' ')} to the picker in ${target}.`);
}

async function herdrPaneRun(args) {
  const target = assertTarget(args.target);
  const command = assertString(args.command, 'command', { required: true, max: 20_000 });
  if (/[\r\n]/.test(command)) fail('invalid_argument', 'command must be a single line (Enter is added for you).');
  const before = await guardUnsent(target);
  await herdr(['pane', 'run', target, command]);
  sentByBridge.delete(target);
  return text(`▶️ Ran in ${target}: ${command}${suggestionNote(before)}`);
}

async function herdrWait(args) {
  const target = assertTarget(args.target);
  const status = assertEnum(args.status, 'status', AGENT_STATUSES, { required: true });
  let timeoutMs = HERDR_DEFAULT_TIMEOUT_MS;
  if (args.timeout_ms !== undefined) {
    if (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1000 || args.timeout_ms > 600_000) {
      fail('invalid_argument', 'timeout_ms must be an integer 1000–600000.');
    }
    timeoutMs = args.timeout_ms;
  }
  const { raw } = await herdr(['agent', 'wait', target, '--until', status, '--timeout', String(timeoutMs)], { timeoutMs: timeoutMs + 5000 });
  return text(`⏱️ ${target} reached status "${status}".\n${raw.trim()}`);
}

// ──────────────────────────────────────────────
// Markdown generators
// ──────────────────────────────────────────────

function testToMarkdown(test) {
  const lines = [
    `# UAT Test: ${test.name}`,
    '',
    `**ID:** ${test.id}`,
    `**Priority:** ${test.priority}`,
    `**Tags:** ${(test.tags || []).join(', ') || 'none'}`,
    `**URL:** ${test.url}`,
    `**Created:** ${test.created_at}`,
    '',
  ];
  if (test.context) lines.push('## Context', '', test.context, '');
  lines.push('## Test Steps', '');
  (test.steps || []).forEach((s, i) => {
    lines.push(`### Step ${i + 1}: ${s.description}`, '', `- **Action:** ${s.action}`);
    if (s.target) lines.push(`- **Target:** ${s.target}`);
    if (s.value) lines.push(`- **Value:** ${s.value}`);
    lines.push('');
  });
  return lines.join('\n');
}

function resultToMarkdown(r) {
  const lines = [
    `# UAT Result: ${r.name}`,
    '',
    `**Result:** ${EMOJI[r.result] || '❓'} ${String(r.result).toUpperCase()}`,
    `**ID:** ${r.id}`,
    `**Duration:** ${r.duration_seconds}s`,
    `**Completed:** ${r.completed_at}`,
    '',
    '## Summary',
    '',
    r.summary,
    '',
  ];
  if (r.step_results?.length) {
    lines.push('## Step Results', '');
    for (const sr of r.step_results) {
      const def = (r.steps || [])[sr.step_index];
      lines.push(`### ${EMOJI[sr.status] || '❓'} ${def ? def.description : `Step ${sr.step_index + 1}`}`, '');
      if (sr.actual) lines.push(`- **Actual:** ${sr.actual}`);
      if (sr.notes) lines.push(`- **Notes:** ${sr.notes}`);
      if (sr.screenshot_path) lines.push(`- **Screenshot:** ${sr.screenshot_path}`);
      lines.push('');
    }
  }
  if (r.environment && Object.keys(r.environment).length) {
    lines.push('## Environment', '');
    for (const [k, v] of Object.entries(r.environment)) lines.push(`- **${k}:** ${v}`);
    lines.push('');
  }
  return lines.join('\n');
}

function stepsToInstructions(test) {
  const lines = [`Navigate to: ${test.url}`, ''];
  (test.steps || []).forEach((s, i) => {
    lines.push(`Step ${i + 1}: ${s.description}`, `  Action: ${s.action}`);
    if (s.target) lines.push(`  Target: ${s.target}`);
    if (s.value) lines.push(`  Value/Expected: ${s.value}`);
    lines.push('');
  });
  if (test.context) lines.push(`Context: ${test.context}`);
  return lines.join('\n');
}

// ──────────────────────────────────────────────
// Server
// ──────────────────────────────────────────────

const HANDLERS = {
  uat_queue_test: uatQueueTest,
  uat_get_pending: uatGetPending,
  uat_get_test: uatGetTest,
  uat_claim_test: uatClaimTest,
  uat_complete_test: uatCompleteTest,
  uat_get_results: uatGetResults,
  uat_reset_test: uatResetTest,
  uat_dashboard: uatDashboard,
  herdr_agent_list: herdrAgentList,
  herdr_agent_read: herdrAgentRead,
  herdr_agent_send: herdrAgentSend,
  herdr_pane_run: herdrPaneRun,
  herdr_wait: herdrWait,
  herdr_pane_submit: herdrPaneSubmit,
  herdr_pane_keys: herdrPaneKeys,
};

const server = new Server({ name: 'local-dev-bridge-mcp', version: VERSION }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const handler = HANDLERS[name];
    if (!handler) fail('unknown_tool', `Unknown tool: ${name}`, { available: Object.keys(HANDLERS) });
    return await handler(args && typeof args === 'object' ? args : {});
  } catch (err) {
    return errorResult(err);
  }
});

server.onerror = (error) => console.error('[MCP Error]', error);
process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});

await server.connect(new StdioServerTransport());
console.error(`Local Dev Bridge MCP v${VERSION} on stdio — Herdr + UAT only. UAT queue: ${UAT_DIR}`);
