# Local Dev Bridge MCP v2.0

A shared MCP server that bridges any combination of Claude Code, Claude Desktop (Cowork), and Claude in Chrome. It gives every Claude session access to a shared local filesystem **and** a UAT test queue so development sessions can author browser tests and browser sessions can execute them.

Project-agnostic by design — configure `PROJECTS_DIR` and `UAT_DIR` per-developer and it works with any codebase.

## What It Does

**Filesystem tools** — read, write, edit, search, list, and run commands against a shared project directory. Any Claude session (Code, Desktop, Chrome) can operate on the same files.

**UAT queue** — a file-based task queue that lets a coding session write browser test specs and a browser session execute them. No database, no server, no polling. The queue is just a directory of JSON files.

## Setup

```bash
git clone https://github.com/talentedmrweb/local-dev-bridge-mcp.git
cd local-dev-bridge-mcp
npm install
```

### Configuration

The MCP server takes two environment variables:

| Variable | Default | Description |
|---|---|---|
| `PROJECTS_DIR` | `~/Desktop/Projects` | Base directory for relative file paths |
| `UAT_DIR` | `$PROJECTS_DIR/uat-queue` | Where the UAT queue lives |

Each developer sets these to their own workspace. The MCP itself has no opinion about project structure, team names, or URLs.

### Claude Desktop / Cowork

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/path/to/local-dev-bridge-mcp/index.js"],
      "env": {
        "PROJECTS_DIR": "/Users/you/Projects",
        "UAT_DIR": "/Users/you/Projects/uat-queue"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/path/to/local-dev-bridge-mcp/index.js"],
      "env": {
        "PROJECTS_DIR": "/Users/you/Projects",
        "UAT_DIR": "/Users/you/Projects/uat-queue"
      }
    }
  }
}
```

Both sessions point at the same filesystem and queue directory — that's the entire trick.

### Claude in Chrome

Chrome doesn't connect to the MCP directly. Instead, Cowork (Claude Desktop) acts as the bridge — it has both the MCP for file access and Chrome for browser automation. The workflow is:

```
Claude Code ──writes tests──► MCP ──reads tests──► Cowork ──drives──► Chrome
```

## Tools

### Filesystem Tools

| Tool | Description |
|---|---|
| `read_file` | Read file contents (relative to PROJECTS_DIR or absolute) |
| `write_file` | Create or overwrite a file |
| `edit_file` | Find-and-replace within a file |
| `list_directory` | List directory contents |
| `run_command` | Execute a shell command |
| `search_files` | Recursive text search across files |

### UAT Queue Tools

| Tool | Description |
|---|---|
| `uat_queue_test` | Queue a new test with steps, URL, priority, tags, and context |
| `uat_get_pending` | List pending tests (filterable by tag/priority) |
| `uat_get_test` | Read full test details by ID |
| `uat_claim_test` | Claim a test for execution (moves pending → in-progress) |
| `uat_complete_test` | Record results: pass/fail/blocked/skipped with per-step details |
| `uat_get_results` | Retrieve results (filterable by status/date) |
| `uat_reset_test` | Move a test back to pending for re-execution |
| `uat_dashboard` | Overview of queue counts, priorities, and pass rates |

## UAT Queue

### The Workflow

```
┌──────────────┐         uat-queue/          ┌────────────────────┐
│  Claude Code │                             │  Cowork + Chrome   │
│  (or any     │ ──queue_test──► pending/ ──►│  (or any session   │
│   coding     │                             │   with browser     │
│   session)   │ ◄──get_results── results/ ◄─│   access)          │
└──────────────┘                             └────────────────────┘
```

1. **Coding session** finishes a change and queues a UAT test via `uat_queue_test`
2. **Browser session** calls `uat_get_pending` → `uat_claim_test` → executes in browser → `uat_complete_test`
3. **Coding session** checks results with `uat_get_results` or `uat_dashboard`

This can be driven manually or automated via CLAUDE.md instructions and hooks in each project.

### Test Format

Tests are JSON files with a companion `.md` for human readability:

```json
{
  "id": "login-flow-happy-path-a1b2c3d4",
  "name": "Login flow happy path",
  "url": "https://your-app.example.com/login",
  "priority": "high",
  "tags": ["auth", "smoke"],
  "context": "Just refactored the auth middleware — verify login still works",
  "steps": [
    {
      "action": "type",
      "target": "#email",
      "value": "test@example.com",
      "description": "Enter email address"
    },
    {
      "action": "click",
      "target": "button[type='submit']",
      "description": "Click the login button"
    },
    {
      "action": "assert_url",
      "value": "/dashboard",
      "description": "Verify redirect to dashboard"
    }
  ],
  "created_at": "2026-04-06T12:00:00.000Z",
  "created_by": "claude-code",
  "status": "pending"
}
```

### Supported Actions

| Action | Description |
|---|---|
| `navigate` | Go to a URL |
| `click` | Click an element (CSS selector or description) |
| `type` | Type text into an input |
| `select` | Select a dropdown option |
| `scroll` | Scroll the page or to an element |
| `wait` | Wait for an element or a duration |
| `assert_visible` | Verify an element is visible |
| `assert_text` | Verify text content matches |
| `assert_url` | Verify the current URL |
| `screenshot` | Take a screenshot |
| `custom` | Free-form instruction for the browser agent |

### Queue Directory Structure

```
uat-queue/
├── pending/          # Tests waiting to be run
│   ├── test-id.json
│   └── test-id.md
├── in-progress/      # Tests currently being executed
├── results/          # Completed tests with outcomes
│   ├── test-id.json
│   └── test-id.md
└── archive/          # Old results (manual cleanup)
```

## Integrating With Your Project

The MCP is project-agnostic. To wire it into a specific codebase:

### 1. Add the MCP to `.claude/settings.local.json`

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/path/to/local-dev-bridge-mcp/index.js"],
      "env": {
        "PROJECTS_DIR": "/Users/you/Projects",
        "UAT_DIR": "/Users/you/Projects/uat-queue"
      }
    }
  }
}
```

### 2. Add a deploy hook (optional)

Add a PostToolUse hook to `.claude/settings.local.json` that reminds Claude Code to queue tests after deployment:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$CLAUDE_TOOL_INPUT\" | grep -qiE '(deploy|gcloud run|gcloud builds)'; then echo '\\n🧪 DEPLOYMENT DETECTED — Queue UAT tests before closing this session.'; fi"
          }
        ]
      }
    ]
  }
}
```

### 3. Add instructions to CLAUDE.md

Append a section to your project's `CLAUDE.md` telling Claude Code to:
- Check `uat-queue/results/` for previous test outcomes before starting work
- Queue tests to `uat-queue/pending/` after every deployment
- Tell the developer to trigger browser testing in Cowork

Example section:

```markdown
## UAT Queue — Post-Deployment Testing

After every deployment, you MUST:
1. Check `uat-queue/results/` for previous failures
2. Write test JSON files to `uat-queue/pending/` based on what changed
3. Tell the developer: "Tests queued. Open Cowork and say 'run UAT tests'"
```

### 4. Run tests from Cowork

When the developer opens Cowork and says "run UAT tests", Cowork:
1. Reads pending tests via the MCP
2. Claims them (moves to in-progress)
3. Executes each step in Chrome
4. Writes results back to the queue

No scheduled tasks, no polling — the developer triggers it as part of their deploy workflow.

## Supported Combinations

| Coding Session | Testing Session | How It Works |
|---|---|---|
| Claude Code | Cowork + Chrome | Most common. Code writes tests, Cowork drives Chrome. |
| Cowork | Cowork + Chrome | Same session can write and execute tests. |
| Claude Code | Claude Code | Code reads results from a previous Chrome session. |
| Any | Any | The queue is just files. Any session with the MCP can read/write. |

## License

MIT
