# Local Dev Bridge MCP v3

A small MCP server that does the two things nothing else on the Mac does:

1. **Herdr control** — list, read, type into, and wait on [Herdr](https://herdr.dev) agent panes on this Mac.
2. **UAT queue** — a file-based work queue where coding sessions author browser tests and browser sessions (Cowork + Claude in Chrome) claim, run, and report them.

It has **no file or shell tools** any more. See [Pairing model](#pairing-model).

## Pairing model

> **Native bridge for files and shell. This bridge for Herdr and UAT.**

| Need | Claude Desktop / Cowork | Claude Code |
|---|---|---|
| Read / write / edit / search files | Native device bridge — **Add folder** (connect `~/Projects` or the one project folder) | Built-in `Read` / `Write` / `Edit` / `Grep` |
| Run shell commands | Native device bridge (`device_bash`, runs in a Linux VM on the granted folders) | Built-in `Bash` (runs on the Mac) |
| Drive Herdr panes | **this bridge** (`herdr_*`) — the native VM cannot reach the Herdr socket | **this bridge** or `herdr` CLI via `Bash` |
| UAT queue | **this bridge** (`uat_*`) | **this bridge** (`uat_*`) |

Why: the v2 file tools ran any command anywhere on the host as the operator, with no approval gate and absolute-path escape. The native bridge's per-folder grant is the right control for raw file/shell work.

## Setup

```bash
git clone https://github.com/talentedmrweb/local-dev-bridge-mcp.git
cd local-dev-bridge-mcp
npm install
```

Requires Node ≥ 18 and, for the Herdr tools, Herdr at `/opt/homebrew/bin/herdr` (Homebrew on Apple Silicon). The UAT tools work without Herdr.

### Configuration

One setting:

| Variable | Default | Description |
|---|---|---|
| `UAT_DIR` | `~/Projects/uat-queue` | Where the UAT queue lives. A leading `~/` is expanded. |

`PROJECTS_DIR` is gone (it only scoped the removed file tools). It is ignored if still set.

### Claude Desktop / Cowork

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/Users/you/Projects/local-dev-bridge-mcp/index.js"],
      "env": {
        "UAT_DIR": "/Users/you/Projects/uat-queue"
      }
    }
  }
}
```

Then, in each Cowork session that needs files, use **Add folder** to connect `~/Projects` (or just the project folder).

### Claude Code

```bash
claude mcp add local-dev-bridge -s user -e UAT_DIR=$HOME/Projects/uat-queue -- node $HOME/Projects/local-dev-bridge-mcp/index.js
```

or in `.mcp.json` / `~/.claude.json`:

```json
{
  "mcpServers": {
    "local-dev-bridge": {
      "command": "node",
      "args": ["/Users/you/Projects/local-dev-bridge-mcp/index.js"],
      "env": { "UAT_DIR": "/Users/you/Projects/uat-queue" }
    }
  }
}
```

Allow-list entries for `.claude/settings.local.json` → `permissions.allow`:

```
mcp__local-dev-bridge__uat_queue_test        mcp__local-dev-bridge__herdr_agent_list
mcp__local-dev-bridge__uat_get_pending       mcp__local-dev-bridge__herdr_agent_read
mcp__local-dev-bridge__uat_get_test          mcp__local-dev-bridge__herdr_agent_send
mcp__local-dev-bridge__uat_claim_test        mcp__local-dev-bridge__herdr_pane_run
mcp__local-dev-bridge__uat_complete_test     mcp__local-dev-bridge__herdr_wait
mcp__local-dev-bridge__uat_get_results
mcp__local-dev-bridge__uat_reset_test
mcp__local-dev-bridge__uat_dashboard
```

**Herdr tools act on the Mac the server runs on.** If the server is launched over SSH on another machine, `herdr_*` sees *that* machine's panes and the UAT tools see *that* machine's queue.

## Tools (13)

### Herdr

| Tool | Runs | Notes |
|---|---|---|
| `herdr_agent_list` | `herdr agent list` | Pane id, status, agent, title, cwd |
| `herdr_agent_read {target, source?, lines?}` | `herdr agent read` | Defaults `--source recent --lines 120`; `lines` 1–2000 |
| `herdr_agent_send {target, text}` | `herdr agent send` | Literal text, **no Enter**. Guarded (below) |
| `herdr_pane_run {target, command}` | `herdr pane run` | Single-line command **+ Enter**. Guarded (below) |
| `herdr_wait {target, status, timeout_ms?}` | `herdr agent wait` | `idle\|working\|blocked\|unknown`; default 30 s, max 600 s. Target must be an agent pane. Most MCP clients time a call out at ~60 s — keep `timeout_ms` under that unless your client allows more |

Implementation: `/opt/homebrew/bin/herdr` is spawned with an argv array — **no shell** — and only the five subcommands above are allowed (no `start`, `attach`, `server`, `config`, …). Targets must match `[A-Za-z0-9][A-Za-z0-9_:.-]*`, so they can never be parsed as flags. 30 s default timeout.

#### The un-sent-line rule

`herdr_agent_send` and `herdr_pane_run` first read the target pane. If its input line already holds text the operator typed but has not sent, the call is **refused** with that text in the error — the bridge never types over it:

```json
{ "error": { "code": "unsent_operator_text",
             "message": "Refused: the input line in w3:p1 already holds un-sent text. Not typing over it.",
             "details": { "target": "w3:p1", "unsent_text": "ship it", "pane_kind": "claude" } } }
```

Detection (`lib/unsent.js`):

- **Claude Code panes** — the `❯` line inside the input box (between the two horizontal rules). Claude Code draws its own *prompt suggestions* (e.g. `Try "fix typecheck errors"`, or a suggested `ship it`) as **dim** ghost text; those are not operator input and do not block. Anything rendered non-dim does.
- **Shell panes** — the last non-blank line is a prompt (`user@host … %`/`$`/`#`, or a bare `$ `/`% `/`❯ `) followed by text.
- Anything else is treated as empty. If refused, ask the operator to send or clear the line; there is no override.

### UAT queue

| Tool | Description |
|---|---|
| `uat_queue_test` | Queue a test (name, http/https URL, steps, tags, priority, context) |
| `uat_get_pending` | List pending tests (filter by tag/priority), critical first |
| `uat_get_test` | Full test by ID from any queue directory |
| `uat_claim_test` | **Atomic** claim (pending → in-progress via `rename`); a second claimer gets `already_claimed` |
| `uat_complete_test` | Record pass/fail/blocked/skipped with per-step results (in-progress → results) |
| `uat_get_results` | One result by ID, or a list filtered by status / `since` |
| `uat_reset_test` | Move a test from in-progress or results back to pending |
| `uat_dashboard` | Counts by state, priority, and result; pass rate |

Hardening in v3:

- **Path confinement** — every file lives under `UAT_DIR`. `test_id` must match `[a-z0-9-]{1,100}`; `../`, `/abs/path`, dots and slashes are refused with `invalid_test_id`. Queue files that are symlinks are refused. `screenshot_path` (stored data) must be relative with no `..`, `~`, or absolute path.
- **Atomic state moves** — claim, complete, and reset each start with a single `rename`, so two sessions cannot both win. Writes go temp file → `rename`.
- **Validated input** — step `action` must be a supported action; enums, types, and `step_index` range are checked.
- **Structured errors, never a stack trace** — every failure is `isError: true` with `{"error": {"code", "message", "details?"}}`. Codes: `invalid_test_id`, `invalid_argument`, `invalid_steps`, `path_not_allowed`, `not_found`, `already_claimed`, `already_completed`, `already_pending`, `not_claimed`, `corrupt_queue_file`, `unsent_operator_text`, `invalid_target`, `herdr_unavailable`, `herdr_failed`, `herdr_timeout`, `unknown_tool`, `internal_error`.

#### Workflow

```
Claude Code ──uat_queue_test──► pending/ ──uat_claim_test──► Cowork + Chrome
     ▲                                                            │
     └──────uat_get_results◄── results/ ◄──uat_complete_test──────┘
```

#### Test format (unchanged from v2)

```json
{
  "id": "login-flow-happy-path-a1b2c3d4",
  "name": "Login flow happy path",
  "url": "http://your-app.lab/login",
  "priority": "high",
  "tags": ["auth", "smoke"],
  "context": "Just refactored the auth middleware — verify login still works",
  "steps": [
    { "action": "type", "target": "#email", "value": "test@example.com", "description": "Enter email" },
    { "action": "click", "target": "button[type='submit']", "description": "Submit" },
    { "action": "assert_url", "value": "/dashboard", "description": "Lands on dashboard" }
  ],
  "created_at": "2026-04-06T12:00:00.000Z",
  "created_by": "claude-code",
  "status": "pending"
}
```

Supported actions: `navigate`, `click`, `type`, `select`, `scroll`, `wait`, `assert_visible`, `assert_text`, `assert_url`, `screenshot`, `custom`.

#### Queue layout (unchanged)

```
uat-queue/
├── pending/       tests waiting to run (id.json + id.md)
├── in-progress/   claimed tests
├── results/       completed tests with outcomes
└── archive/       old results (manual)
```

## Migrating from v2

- **File tools are gone**: `read_file`, `write_file`, `edit_file`, `list_directory`, `search_files`, `run_command`. In Desktop/Cowork, connect a folder with **Add folder** instead; in Claude Code, use the built-in tools.
- **Herdr via `run_command` → dedicated tools**: `herdr agent list|read|send`, `herdr pane run`, `herdr agent wait` map to `herdr_agent_list|read|send`, `herdr_pane_run`, `herdr_wait`. Other Herdr subcommands are not exposed.
- **Config**: drop `PROJECTS_DIR`; keep `UAT_DIR` (its default moved from `$PROJECTS_DIR/uat-queue` to `~/Projects/uat-queue`).
- **Permissions**: remove `mcp__local-dev-bridge__{read_file,write_file,edit_file,list_directory,search_files,run_command}` from allow lists; add the five `mcp__local-dev-bridge__herdr_*`.
- **Errors**: error text is now a JSON object (`error.code`) instead of `Error: <message>`.
- **Rollback**: `git checkout v2.0-pre-slim`, restore `PROJECTS_DIR`, restart the client.

## Testing

```bash
UAT_DIR=~/Projects/uat-queue node test/regression.mjs <scratch-pane-id>   # full UAT + Herdr pass over MCP stdio
node test/call.mjs uat_dashboard '{}'                                       # one-off tool call
```

`regression.mjs` leaves one `skipped` result (tag `bridge-smoke`) in `results/`. Give it a **scratch** shell pane (e.g. `herdr pane split <pane> --direction down --no-focus`) — it types into it. `herdr_wait` needs an agent pane, so test it against a scratch Claude Code session.

## License

MIT
