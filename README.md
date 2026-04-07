# Local Dev Bridge MCP v2.0

An MCP server that bridges Claude Code and Claude in Chrome. It gives any Claude session full local filesystem access **plus** a shared UAT test queue so Claude Code can author browser tests and Claude in Chrome can execute them.

## What's New in v2

The original filesystem tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `run_command`, `search_files`) are all still here. v2 adds a **UAT queue system** — a simple file-based task queue that lets different Claude sessions coordinate browser testing without any external infrastructure.

### The Workflow

```
┌──────────────┐         uat-queue/          ┌────────────────────┐
│  Claude Code │ ──queue_test──► pending/  ──►│  Claude in Chrome  │
│  (writes     │                              │  (or Cowork with   │
│   code)      │ ◄──get_results── results/ ◄──│   Chrome attached) │
└──────────────┘                              └────────────────────┘
```

1. **Claude Code** finishes a code change and queues a UAT test via `uat_queue_test`
2. **Claude in Chrome** (or Cowork) calls `uat_get_pending` → `uat_claim_test` → executes in the browser → `uat_complete_test`
3. **Claude Code** checks results with `uat_get_results` or `uat_dashboard`

## Setup

```bash
cd local-dev-bridge-mcp
npm install
```

### Claude Desktop / Cowork Config

Add to your Claude config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/path/to/local-dev-bridge-mcp/index.js"],
      "env": {
        "PROJECTS_DIR": "/Users/you/Desktop/Projects",
        "UAT_DIR": "/Users/you/Desktop/Projects/uat-queue"
      }
    }
  }
}
```

### Claude Code Config

Same MCP server, same config. Both sessions point at the same filesystem and queue directory — that's the whole trick.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROJECTS_DIR` | `~/Desktop/Projects` | Base directory for file operations |
| `UAT_DIR` | `$PROJECTS_DIR/uat-queue` | Where the UAT queue lives |

## Tools

### Filesystem Tools (Original)

| Tool | Description |
|---|---|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite a file |
| `edit_file` | Find-and-replace within a file |
| `list_directory` | List directory contents |
| `run_command` | Execute a shell command |
| `search_files` | Recursive text search |

### UAT Queue Tools (New in v2)

| Tool | Description |
|---|---|
| `uat_queue_test` | Queue a new test with steps, URL, priority, tags, and context |
| `uat_get_pending` | List pending tests (filterable by tag/priority) |
| `uat_get_test` | Read full test details by ID |
| `uat_claim_test` | Claim a test for execution (moves to in-progress) |
| `uat_complete_test` | Record results: pass/fail/blocked/skipped with per-step details |
| `uat_get_results` | Retrieve results (filterable by status/date) |
| `uat_reset_test` | Move a test back to pending for re-execution |
| `uat_dashboard` | Overview of queue counts, priorities, and pass rates |

## UAT Test Format

Tests are stored as JSON (with a companion `.md` for human readability). Here's the schema:

```json
{
  "id": "login-flow-happy-path-a1b2c3d4",
  "name": "Login flow happy path",
  "url": "http://localhost:3000/login",
  "priority": "high",
  "tags": ["auth", "smoke"],
  "context": "Just refactored the auth middleware — make sure login still works end to end",
  "steps": [
    {
      "action": "type",
      "target": "#email",
      "value": "test@example.com",
      "description": "Enter email address"
    },
    {
      "action": "type",
      "target": "#password",
      "value": "testpassword123",
      "description": "Enter password"
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
    },
    {
      "action": "assert_visible",
      "target": ".welcome-message",
      "description": "Verify welcome message is displayed"
    }
  ]
}
```

### Supported Actions

| Action | Description |
|---|---|
| `navigate` | Go to a URL |
| `click` | Click an element |
| `type` | Type text into an input |
| `select` | Select a dropdown option |
| `scroll` | Scroll the page or to an element |
| `wait` | Wait for an element or a duration |
| `assert_visible` | Verify an element is visible |
| `assert_text` | Verify text content matches |
| `assert_url` | Verify the current URL |
| `screenshot` | Take a screenshot |
| `custom` | Free-form instruction for the browser agent |

## Queue Directory Structure

```
uat-queue/
├── pending/          # Tests waiting to be run
│   ├── test-id.json
│   └── test-id.md
├── in-progress/      # Tests currently being executed
│   ├── test-id.json
│   └── test-id.md
├── results/          # Completed tests with outcomes
│   ├── test-id.json
│   └── test-id.md
└── archive/          # (Manual) old results you want to keep but clear from active view
```

## Tips

- **From Claude Code:** After making code changes, queue tests with `uat_queue_test`. Include `context` explaining what changed so the browser agent knows what to focus on.
- **From Cowork/Chrome:** Call `uat_get_pending` to see the queue, `uat_claim_test` to lock one, then use Chrome tools to execute each step. Call `uat_complete_test` when done.
- **Re-runs:** Use `uat_reset_test` to move a failed test back to pending for another attempt.
- **Filtering:** Use `tags` and `priority` to organize test suites — run just `"smoke"` tests, or only `"critical"` priority items.

## License

MIT
