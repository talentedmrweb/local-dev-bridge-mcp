#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { glob } from 'glob';
import os from 'os';
import crypto from 'crypto';

const execAsync = promisify(exec);

// Get the base directory for projects (configurable via environment variable)
const PROJECTS_DIR = process.env.PROJECTS_DIR || path.join(os.homedir(), 'Desktop', 'Projects');

// UAT queue directory (configurable, defaults to inside projects dir)
const UAT_DIR = process.env.UAT_DIR || path.join(PROJECTS_DIR, 'uat-queue');

class LocalDevBridgeServer {
  constructor() {
    this.server = new Server(
      {
        name: 'local-dev-bridge-mcp',
        version: '2.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        // ──────────────────────────────────────────────
        // Original filesystem & dev tools
        // ──────────────────────────────────────────────
        {
          name: 'read_file',
          description: 'Read the contents of a file from the local file system. Use this to view existing code files.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file (relative to projects directory or absolute)',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Create or overwrite a file with new content. Use this to create new files or completely replace existing ones.',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file (relative to projects directory or absolute)',
              },
              content: {
                type: 'string',
                description: 'Content to write to the file',
              },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'edit_file',
          description: 'Edit a file by replacing specific text. The old_text must match exactly (including whitespace).',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to the file',
              },
              old_text: {
                type: 'string',
                description: 'Text to find and replace (must match exactly)',
              },
              new_text: {
                type: 'string',
                description: 'Text to replace it with',
              },
            },
            required: ['path', 'old_text', 'new_text'],
          },
        },
        {
          name: 'list_directory',
          description: 'List files and directories in a given path',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Path to directory (relative to projects directory or absolute)',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'run_command',
          description: 'Execute a shell command in the projects directory. Use for running npm install, git commands, tests, etc.',
          inputSchema: {
            type: 'object',
            properties: {
              command: {
                type: 'string',
                description: 'Shell command to execute',
              },
              cwd: {
                type: 'string',
                description: 'Working directory (relative to projects directory or absolute)',
              },
            },
            required: ['command'],
          },
        },
        {
          name: 'search_files',
          description: 'Search for text within files in a directory (recursive)',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Text to search for',
              },
              path: {
                type: 'string',
                description: 'Directory to search in (defaults to projects directory)',
              },
              file_pattern: {
                type: 'string',
                description: "File pattern to match (e.g., '*.js', '*.py')",
              },
            },
            required: ['query'],
          },
        },

        // ──────────────────────────────────────────────
        // UAT Queue tools
        // ──────────────────────────────────────────────
        {
          name: 'uat_queue_test',
          description:
            'Queue a new UAT test for browser execution. Writes a structured test file to the pending queue. Returns the test ID. Use this from Claude Code to create tests that Claude in Chrome will execute.',
          inputSchema: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Short human-readable test name (e.g. "Login flow happy path")',
              },
              url: {
                type: 'string',
                description: 'Starting URL for the test',
              },
              steps: {
                type: 'array',
                description: 'Ordered list of test steps',
                items: {
                  type: 'object',
                  properties: {
                    action: {
                      type: 'string',
                      description:
                        'What to do: navigate, click, type, select, scroll, wait, assert_visible, assert_text, assert_url, screenshot, custom',
                    },
                    target: {
                      type: 'string',
                      description:
                        'CSS selector, text content, URL, or natural-language description of the element',
                    },
                    value: {
                      type: 'string',
                      description: 'Value to type, option to select, expected text, or additional context',
                    },
                    description: {
                      type: 'string',
                      description: 'Human-readable description of what this step does and why',
                    },
                  },
                  required: ['action', 'description'],
                },
              },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Optional tags for filtering (e.g. ["smoke", "auth", "regression"])',
              },
              priority: {
                type: 'string',
                enum: ['critical', 'high', 'medium', 'low'],
                description: 'Test priority (default: medium)',
              },
              context: {
                type: 'string',
                description:
                  'Free-form context for the test executor — what feature this tests, what just changed in the code, what to watch out for, etc.',
              },
            },
            required: ['name', 'url', 'steps'],
          },
        },
        {
          name: 'uat_get_pending',
          description:
            'List all pending UAT tests waiting to be executed. Use this from the browser-side session to see what needs testing.',
          inputSchema: {
            type: 'object',
            properties: {
              tag: {
                type: 'string',
                description: 'Filter by tag (optional)',
              },
              priority: {
                type: 'string',
                enum: ['critical', 'high', 'medium', 'low'],
                description: 'Filter by priority (optional)',
              },
            },
          },
        },
        {
          name: 'uat_get_test',
          description: 'Read the full details of a specific UAT test by its ID.',
          inputSchema: {
            type: 'object',
            properties: {
              test_id: {
                type: 'string',
                description: 'The test ID (filename without extension)',
              },
            },
            required: ['test_id'],
          },
        },
        {
          name: 'uat_claim_test',
          description:
            'Claim a pending test for execution. Moves it from pending/ to in-progress/ so other sessions don\'t double-run it. Returns the full test object.',
          inputSchema: {
            type: 'object',
            properties: {
              test_id: {
                type: 'string',
                description: 'The test ID to claim',
              },
            },
            required: ['test_id'],
          },
        },
        {
          name: 'uat_complete_test',
          description:
            'Mark a test as completed with results. Moves it from in-progress/ to results/ and writes the outcome. Use this after executing a test in the browser.',
          inputSchema: {
            type: 'object',
            properties: {
              test_id: {
                type: 'string',
                description: 'The test ID to complete',
              },
              status: {
                type: 'string',
                enum: ['passed', 'failed', 'blocked', 'skipped'],
                description: 'Overall test result',
              },
              step_results: {
                type: 'array',
                description: 'Per-step results',
                items: {
                  type: 'object',
                  properties: {
                    step_index: { type: 'number', description: '0-based step index' },
                    status: {
                      type: 'string',
                      enum: ['passed', 'failed', 'skipped'],
                    },
                    actual: {
                      type: 'string',
                      description: 'What actually happened',
                    },
                    screenshot_path: {
                      type: 'string',
                      description: 'Path to screenshot if one was taken',
                    },
                    notes: {
                      type: 'string',
                      description: 'Any observations or issues',
                    },
                  },
                  required: ['step_index', 'status'],
                },
              },
              summary: {
                type: 'string',
                description: 'Overall summary of the test run — what happened, what failed, recommendations',
              },
              environment: {
                type: 'object',
                description: 'Browser/environment info captured during the run',
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
          description:
            'Get test results. Use this from Claude Code to check how tests went after the browser session ran them.',
          inputSchema: {
            type: 'object',
            properties: {
              test_id: {
                type: 'string',
                description: 'Specific test ID to get results for (optional — omit to list all results)',
              },
              status: {
                type: 'string',
                enum: ['passed', 'failed', 'blocked', 'skipped'],
                description: 'Filter results by status (optional)',
              },
              since: {
                type: 'string',
                description: 'ISO date string — only return results after this time (optional)',
              },
            },
          },
        },
        {
          name: 'uat_reset_test',
          description:
            'Move a test back to pending (e.g. if it was claimed but never completed, or if you want to re-run it).',
          inputSchema: {
            type: 'object',
            properties: {
              test_id: {
                type: 'string',
                description: 'The test ID to reset',
              },
            },
            required: ['test_id'],
          },
        },
        {
          name: 'uat_dashboard',
          description:
            'Get a summary dashboard of the UAT queue — counts of pending, in-progress, and completed tests broken down by status and priority.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // Original tools
          case 'read_file':
            return await this.readFile(args.path);
          case 'write_file':
            return await this.writeFile(args.path, args.content);
          case 'edit_file':
            return await this.editFile(args.path, args.old_text, args.new_text);
          case 'list_directory':
            return await this.listDirectory(args.path);
          case 'run_command':
            return await this.runCommand(args.command, args.cwd);
          case 'search_files':
            return await this.searchFiles(args.query, args.path, args.file_pattern);

          // UAT tools
          case 'uat_queue_test':
            return await this.uatQueueTest(args);
          case 'uat_get_pending':
            return await this.uatGetPending(args.tag, args.priority);
          case 'uat_get_test':
            return await this.uatGetTest(args.test_id);
          case 'uat_claim_test':
            return await this.uatClaimTest(args.test_id);
          case 'uat_complete_test':
            return await this.uatCompleteTest(args);
          case 'uat_get_results':
            return await this.uatGetResults(args.test_id, args.status, args.since);
          case 'uat_reset_test':
            return await this.uatResetTest(args.test_id);
          case 'uat_dashboard':
            return await this.uatDashboard();

          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            };
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    });
  }

  // ──────────────────────────────────────────────
  // Path helpers
  // ──────────────────────────────────────────────

  resolvePath(inputPath) {
    if (!inputPath || inputPath === '.') return PROJECTS_DIR;
    if (path.isAbsolute(inputPath)) return inputPath;
    return path.join(PROJECTS_DIR, inputPath);
  }

  async ensureUatDirs() {
    const dirs = ['pending', 'in-progress', 'results', 'archive'];
    for (const dir of dirs) {
      await fs.mkdir(path.join(UAT_DIR, dir), { recursive: true });
    }
  }

  generateTestId(name) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .substring(0, 40);
    const hash = crypto.randomBytes(4).toString('hex');
    return `${slug}-${hash}`;
  }

  // ──────────────────────────────────────────────
  // Original filesystem tools (unchanged)
  // ──────────────────────────────────────────────

  async readFile(filePath) {
    const resolvedPath = this.resolvePath(filePath);
    const content = await fs.readFile(resolvedPath, 'utf-8');
    return { content: [{ type: 'text', text: content }] };
  }

  async writeFile(filePath, content) {
    const resolvedPath = this.resolvePath(filePath);
    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { content: [{ type: 'text', text: `File written successfully: ${resolvedPath}` }] };
  }

  async editFile(filePath, oldText, newText) {
    const resolvedPath = this.resolvePath(filePath);
    let content = await fs.readFile(resolvedPath, 'utf-8');
    if (!content.includes(oldText)) {
      throw new Error(`Text not found in file: ${oldText.substring(0, 50)}...`);
    }
    content = content.replace(oldText, newText);
    await fs.writeFile(resolvedPath, content, 'utf-8');
    return { content: [{ type: 'text', text: `File edited successfully: ${resolvedPath}` }] };
  }

  async listDirectory(dirPath) {
    const resolvedPath = this.resolvePath(dirPath);
    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const items = entries.map((entry) => {
      const icon = entry.isDirectory() ? '📁' : '📄';
      return `${icon} ${entry.name}`;
    });
    return {
      content: [{ type: 'text', text: `Contents of ${resolvedPath}:\n\n${items.join('\n')}` }],
    };
  }

  async runCommand(command, cwd) {
    const resolvedCwd = cwd ? this.resolvePath(cwd) : PROJECTS_DIR;
    const { stdout, stderr } = await execAsync(command, { cwd: resolvedCwd });
    let output = '';
    if (stdout) output += `Output:\n${stdout}\n`;
    if (stderr) output += `Errors:\n${stderr}\n`;
    return {
      content: [{ type: 'text', text: output || 'Command executed successfully (no output)' }],
    };
  }

  async searchFiles(query, searchPath, filePattern = '*') {
    const resolvedPath = this.resolvePath(searchPath || '.');
    const pattern = path.join(resolvedPath, '**', filePattern);
    const files = await glob(pattern, {
      ignore: ['**/node_modules/**', '**/.git/**'],
      nodir: true,
    });
    const results = [];
    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const lines = content.split('\n');
        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push(`${file}:${index + 1}:${line.trim()}`);
          }
        });
      } catch (error) {
        // Skip files that can't be read
      }
    }
    const output =
      results.length > 0
        ? `Search results for "${query}" in ${resolvedPath}:\n\n${results.slice(0, 100).join('\n')}`
        : `No results found for "${query}" in ${resolvedPath}`;
    return { content: [{ type: 'text', text: output }] };
  }

  // ──────────────────────────────────────────────
  // UAT Queue tools
  // ──────────────────────────────────────────────

  async uatQueueTest({ name, url, steps, tags, priority, context }) {
    await this.ensureUatDirs();

    const testId = this.generateTestId(name);
    const test = {
      id: testId,
      name,
      url,
      steps,
      tags: tags || [],
      priority: priority || 'medium',
      context: context || '',
      created_at: new Date().toISOString(),
      created_by: 'claude-code',
      status: 'pending',
    };

    const filePath = path.join(UAT_DIR, 'pending', `${testId}.json`);
    await fs.writeFile(filePath, JSON.stringify(test, null, 2), 'utf-8');

    // Also write a human-readable markdown version alongside the JSON
    const md = this.testToMarkdown(test);
    const mdPath = path.join(UAT_DIR, 'pending', `${testId}.md`);
    await fs.writeFile(mdPath, md, 'utf-8');

    return {
      content: [
        {
          type: 'text',
          text: `✅ Test queued successfully!\n\nTest ID: ${testId}\nName: ${name}\nPriority: ${test.priority}\nSteps: ${steps.length}\nLocation: ${filePath}\n\nThe test is now in the pending queue and can be picked up by a browser session using uat_claim_test.`,
        },
      ],
    };
  }

  async uatGetPending(tag, priority) {
    await this.ensureUatDirs();
    const pendingDir = path.join(UAT_DIR, 'pending');
    const files = await fs.readdir(pendingDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const tests = [];
    for (const file of jsonFiles) {
      const content = await fs.readFile(path.join(pendingDir, file), 'utf-8');
      const test = JSON.parse(content);

      if (tag && !test.tags.includes(tag)) continue;
      if (priority && test.priority !== priority) continue;

      tests.push(test);
    }

    // Sort: critical first, then by creation time
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    tests.sort((a, b) => {
      const pDiff = (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
      if (pDiff !== 0) return pDiff;
      return new Date(a.created_at) - new Date(b.created_at);
    });

    if (tests.length === 0) {
      return {
        content: [{ type: 'text', text: 'No pending tests in the queue.' }],
      };
    }

    const summary = tests
      .map(
        (t, i) =>
          `${i + 1}. [${t.priority.toUpperCase()}] ${t.name}\n   ID: ${t.id}\n   URL: ${t.url}\n   Steps: ${t.steps.length} | Tags: ${t.tags.join(', ') || 'none'}\n   Queued: ${t.created_at}`
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `📋 Pending UAT Tests (${tests.length}):\n\n${summary}\n\nUse uat_claim_test with a test ID to begin execution.`,
        },
      ],
    };
  }

  async uatGetTest(testId) {
    await this.ensureUatDirs();

    // Search across all directories
    const dirs = ['pending', 'in-progress', 'results', 'archive'];
    for (const dir of dirs) {
      const filePath = path.join(UAT_DIR, dir, `${testId}.json`);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const test = JSON.parse(content);
        return {
          content: [
            {
              type: 'text',
              text: `Test found in ${dir}/:\n\n${JSON.stringify(test, null, 2)}`,
            },
          ],
        };
      } catch {
        // Not in this directory, keep looking
      }
    }

    throw new Error(`Test not found: ${testId}`);
  }

  async uatClaimTest(testId) {
    await this.ensureUatDirs();

    const pendingPath = path.join(UAT_DIR, 'pending', `${testId}.json`);
    const pendingMdPath = path.join(UAT_DIR, 'pending', `${testId}.md`);
    const inProgressPath = path.join(UAT_DIR, 'in-progress', `${testId}.json`);
    const inProgressMdPath = path.join(UAT_DIR, 'in-progress', `${testId}.md`);

    let content;
    try {
      content = await fs.readFile(pendingPath, 'utf-8');
    } catch {
      throw new Error(
        `Test ${testId} not found in pending queue. It may have already been claimed or does not exist.`
      );
    }

    const test = JSON.parse(content);
    test.status = 'in-progress';
    test.claimed_at = new Date().toISOString();
    test.claimed_by = 'claude-chrome';

    // Move JSON
    await fs.writeFile(inProgressPath, JSON.stringify(test, null, 2), 'utf-8');
    await fs.unlink(pendingPath);

    // Move markdown if it exists
    try {
      const mdContent = await fs.readFile(pendingMdPath, 'utf-8');
      await fs.writeFile(inProgressMdPath, mdContent, 'utf-8');
      await fs.unlink(pendingMdPath);
    } catch {
      // No markdown file, that's fine
    }

    return {
      content: [
        {
          type: 'text',
          text: `🔄 Test claimed: ${test.name}\n\nURL: ${test.url}\nSteps: ${test.steps.length}\nPriority: ${test.priority}\n\n--- EXECUTION INSTRUCTIONS ---\n\n${this.stepsToInstructions(test)}\n\nWhen finished, use uat_complete_test to record results.`,
        },
      ],
    };
  }

  async uatCompleteTest({ test_id, status, step_results, summary, environment }) {
    await this.ensureUatDirs();

    const inProgressPath = path.join(UAT_DIR, 'in-progress', `${test_id}.json`);
    const inProgressMdPath = path.join(UAT_DIR, 'in-progress', `${test_id}.md`);
    const resultPath = path.join(UAT_DIR, 'results', `${test_id}.json`);
    const resultMdPath = path.join(UAT_DIR, 'results', `${test_id}.md`);

    let content;
    try {
      content = await fs.readFile(inProgressPath, 'utf-8');
    } catch {
      throw new Error(`Test ${test_id} not found in in-progress queue.`);
    }

    const test = JSON.parse(content);
    const result = {
      ...test,
      status: 'completed',
      result: status,
      completed_at: new Date().toISOString(),
      step_results: step_results || [],
      summary,
      environment: environment || {},
      duration_seconds: test.claimed_at
        ? Math.round((Date.now() - new Date(test.claimed_at).getTime()) / 1000)
        : null,
    };

    // Write result JSON
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2), 'utf-8');

    // Write result markdown
    const md = this.resultToMarkdown(result);
    await fs.writeFile(resultMdPath, md, 'utf-8');

    // Clean up in-progress
    await fs.unlink(inProgressPath);
    try {
      await fs.unlink(inProgressMdPath);
    } catch {
      // No markdown, fine
    }

    const emoji = { passed: '✅', failed: '❌', blocked: '🚫', skipped: '⏭️' }[status] || '❓';

    return {
      content: [
        {
          type: 'text',
          text: `${emoji} Test completed: ${test.name}\n\nResult: ${status.toUpperCase()}\nDuration: ${result.duration_seconds}s\nSummary: ${summary}\n\nFull results saved to: ${resultPath}`,
        },
      ],
    };
  }

  async uatGetResults(testId, status, since) {
    await this.ensureUatDirs();

    // Single test lookup
    if (testId) {
      const filePath = path.join(UAT_DIR, 'results', `${testId}.json`);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const result = JSON.parse(content);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch {
        throw new Error(`No results found for test: ${testId}`);
      }
    }

    // List all results
    const resultsDir = path.join(UAT_DIR, 'results');
    const files = await fs.readdir(resultsDir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const results = [];
    for (const file of jsonFiles) {
      const content = await fs.readFile(path.join(resultsDir, file), 'utf-8');
      const result = JSON.parse(content);

      if (status && result.result !== status) continue;
      if (since && new Date(result.completed_at) < new Date(since)) continue;

      results.push(result);
    }

    results.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: 'No test results found matching the criteria.' }],
      };
    }

    const emoji = { passed: '✅', failed: '❌', blocked: '🚫', skipped: '⏭️' };
    const summary = results
      .map(
        (r) =>
          `${emoji[r.result] || '❓'} ${r.name}\n   ID: ${r.id} | Result: ${r.result.toUpperCase()}\n   Completed: ${r.completed_at}\n   Summary: ${r.summary}`
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `📊 Test Results (${results.length}):\n\n${summary}`,
        },
      ],
    };
  }

  async uatResetTest(testId) {
    await this.ensureUatDirs();

    // Check in-progress first, then results
    const sources = ['in-progress', 'results'];
    for (const dir of sources) {
      const jsonPath = path.join(UAT_DIR, dir, `${testId}.json`);
      const mdPath = path.join(UAT_DIR, dir, `${testId}.md`);
      try {
        const content = await fs.readFile(jsonPath, 'utf-8');
        const test = JSON.parse(content);

        // Strip execution data, reset to pending
        delete test.claimed_at;
        delete test.claimed_by;
        delete test.completed_at;
        delete test.result;
        delete test.step_results;
        delete test.summary;
        delete test.environment;
        delete test.duration_seconds;
        test.status = 'pending';
        test.reset_at = new Date().toISOString();

        const pendingPath = path.join(UAT_DIR, 'pending', `${testId}.json`);
        await fs.writeFile(pendingPath, JSON.stringify(test, null, 2), 'utf-8');

        // Regenerate markdown
        const md = this.testToMarkdown(test);
        await fs.writeFile(path.join(UAT_DIR, 'pending', `${testId}.md`), md, 'utf-8');

        // Clean up source
        await fs.unlink(jsonPath);
        try {
          await fs.unlink(mdPath);
        } catch {
          // fine
        }

        return {
          content: [
            {
              type: 'text',
              text: `♻️ Test reset to pending: ${test.name}\n\nMoved from ${dir}/ back to pending/.`,
            },
          ],
        };
      } catch {
        // Not in this dir
      }
    }

    throw new Error(`Test ${testId} not found in in-progress or results.`);
  }

  async uatDashboard() {
    await this.ensureUatDirs();

    const counts = { pending: 0, 'in-progress': 0, results: { passed: 0, failed: 0, blocked: 0, skipped: 0 } };
    const priorities = { pending: { critical: 0, high: 0, medium: 0, low: 0 } };

    // Count pending
    const pendingFiles = (await fs.readdir(path.join(UAT_DIR, 'pending'))).filter((f) =>
      f.endsWith('.json')
    );
    counts.pending = pendingFiles.length;
    for (const file of pendingFiles) {
      const content = await fs.readFile(path.join(UAT_DIR, 'pending', file), 'utf-8');
      const test = JSON.parse(content);
      priorities.pending[test.priority || 'medium']++;
    }

    // Count in-progress
    const inProgressFiles = (await fs.readdir(path.join(UAT_DIR, 'in-progress'))).filter((f) =>
      f.endsWith('.json')
    );
    counts['in-progress'] = inProgressFiles.length;

    // Count results
    const resultFiles = (await fs.readdir(path.join(UAT_DIR, 'results'))).filter((f) =>
      f.endsWith('.json')
    );
    for (const file of resultFiles) {
      const content = await fs.readFile(path.join(UAT_DIR, 'results', file), 'utf-8');
      const result = JSON.parse(content);
      if (counts.results[result.result] !== undefined) {
        counts.results[result.result]++;
      }
    }

    const totalResults = Object.values(counts.results).reduce((a, b) => a + b, 0);
    const passRate = totalResults > 0 ? ((counts.results.passed / totalResults) * 100).toFixed(1) : 'N/A';

    const dashboard = `
╔══════════════════════════════════════════╗
║           UAT QUEUE DASHBOARD            ║
╠══════════════════════════════════════════╣
║                                          ║
║  📋 Pending:      ${String(counts.pending).padStart(4)}                  ║
║     Critical: ${String(priorities.pending.critical).padStart(3)}  High: ${String(priorities.pending.high).padStart(3)}           ║
║     Medium:   ${String(priorities.pending.medium).padStart(3)}  Low:  ${String(priorities.pending.low).padStart(3)}           ║
║                                          ║
║  🔄 In Progress:  ${String(counts['in-progress']).padStart(4)}                  ║
║                                          ║
║  📊 Completed:    ${String(totalResults).padStart(4)}                  ║
║     ✅ Passed:  ${String(counts.results.passed).padStart(3)}                    ║
║     ❌ Failed:  ${String(counts.results.failed).padStart(3)}                    ║
║     🚫 Blocked: ${String(counts.results.blocked).padStart(3)}                    ║
║     ⏭️  Skipped: ${String(counts.results.skipped).padStart(3)}                    ║
║                                          ║
║  Pass Rate: ${passRate}%                       ║
║                                          ║
╚══════════════════════════════════════════╝
`.trim();

    return {
      content: [{ type: 'text', text: dashboard }],
    };
  }

  // ──────────────────────────────────────────────
  // Markdown generators
  // ──────────────────────────────────────────────

  testToMarkdown(test) {
    const lines = [
      `# UAT Test: ${test.name}`,
      '',
      `**ID:** ${test.id}`,
      `**Priority:** ${test.priority}`,
      `**Tags:** ${test.tags.join(', ') || 'none'}`,
      `**URL:** ${test.url}`,
      `**Created:** ${test.created_at}`,
      '',
    ];

    if (test.context) {
      lines.push('## Context', '', test.context, '');
    }

    lines.push('## Test Steps', '');
    test.steps.forEach((step, i) => {
      lines.push(`### Step ${i + 1}: ${step.description}`);
      lines.push('');
      lines.push(`- **Action:** ${step.action}`);
      if (step.target) lines.push(`- **Target:** ${step.target}`);
      if (step.value) lines.push(`- **Value:** ${step.value}`);
      lines.push('');
    });

    return lines.join('\n');
  }

  resultToMarkdown(result) {
    const emoji = { passed: '✅', failed: '❌', blocked: '🚫', skipped: '⏭️' };
    const lines = [
      `# UAT Result: ${result.name}`,
      '',
      `**Result:** ${emoji[result.result] || '❓'} ${result.result.toUpperCase()}`,
      `**ID:** ${result.id}`,
      `**Duration:** ${result.duration_seconds}s`,
      `**Completed:** ${result.completed_at}`,
      '',
      '## Summary',
      '',
      result.summary,
      '',
    ];

    if (result.step_results && result.step_results.length > 0) {
      lines.push('## Step Results', '');
      result.step_results.forEach((sr) => {
        const stepDef = result.steps[sr.step_index];
        const stepName = stepDef ? stepDef.description : `Step ${sr.step_index + 1}`;
        lines.push(
          `### ${emoji[sr.status] || '❓'} ${stepName}`
        );
        lines.push('');
        if (sr.actual) lines.push(`- **Actual:** ${sr.actual}`);
        if (sr.notes) lines.push(`- **Notes:** ${sr.notes}`);
        if (sr.screenshot_path) lines.push(`- **Screenshot:** ${sr.screenshot_path}`);
        lines.push('');
      });
    }

    if (result.environment && Object.keys(result.environment).length > 0) {
      lines.push('## Environment', '');
      for (const [key, val] of Object.entries(result.environment)) {
        lines.push(`- **${key}:** ${val}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  stepsToInstructions(test) {
    const lines = [`Navigate to: ${test.url}`, ''];
    test.steps.forEach((step, i) => {
      lines.push(`Step ${i + 1}: ${step.description}`);
      lines.push(`  Action: ${step.action}`);
      if (step.target) lines.push(`  Target: ${step.target}`);
      if (step.value) lines.push(`  Value/Expected: ${step.value}`);
      lines.push('');
    });
    if (test.context) {
      lines.push(`Context: ${test.context}`);
    }
    return lines.join('\n');
  }

  // ──────────────────────────────────────────────
  // Server lifecycle
  // ──────────────────────────────────────────────

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Local Dev Bridge MCP Server v2.0.0 running on stdio');
    console.error(`Projects dir: ${PROJECTS_DIR}`);
    console.error(`UAT queue dir: ${UAT_DIR}`);
  }
}

const server = new LocalDevBridgeServer();
server.run().catch(console.error);
