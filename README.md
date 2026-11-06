# Local Dev Bridge MCP v3

A small MCP server that does the two things nothing else on the Mac does:

1. **Herdr control** — list, read, type into, submit, answer pickers in, and wait on [Herdr](https://herdr.dev) agent panes on this Mac.
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

**One-shot (macOS):** `./install-commander.sh` runs `npm install --omit=dev`, then registers `local-dev-bridge` in Claude Desktop (absolute `node` path, backs up `claude_desktop_config.json` first) and in Claude Code (user scope). After that, quit and reopen Claude Desktop.

Requires Node ≥ 18 and, for the Herdr tools, Herdr at `/opt/homebrew/bin/herdr` (Apple Silicon) or `/usr/local/bin/herdr` (Intel). The UAT tools work without Herdr.

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

## Tools (15)

### Herdr

| Tool | Runs | Notes |
|---|---|---|
| `herdr_agent_list` | `herdr agent list` | Pane id, status, agent, title, cwd |
| `herdr_agent_read {target, source?, lines?}` | `herdr pane read` | Defaults `--source recent --lines 120`; `lines` 1–2000 |
| `herdr_agent_send {target, text}` | `herdr pane send-text` | Literal text, **no Enter**. Guarded (below) |
| `herdr_pane_run {target, command}` | `herdr pane run` | Single-line command **+ Enter**. Guarded (below) |
| `herdr_pane_submit {target}` | `herdr pane send-keys <t> enter` | Enter only, and **only** to submit text this bridge typed into that pane via `herdr_agent_send` in the last 5 min (below) |
| `herdr_pane_keys {target, keys}` | `herdr pane send-keys` | Answers a Claude Code **AskUserQuestion** picker. Keys: `Enter` `Esc` `Up` `Down` `Tab` `1`–`9`, max 10. Refuses permission/approval/trust prompts (below) |
| `herdr_wait {target, status, timeout_ms?}` | `herdr agent wait --until` | `idle\|working\|blocked\|done\|unknown`; default 30 s, max 600 s. Target must be an agent pane. Most MCP clients time a call out at ~60 s — keep `timeout_ms` under that unless your client allows more |

Implementation: The first of `/opt/homebrew/bin/herdr`, `/usr/local/bin/herdr` that exists is spawned with an argv array — **no shell** — and only six subcommands are allowed (`agent list`, `pane read`, `pane send-text`, `pane run`, `agent wait`, `pane send-keys`) (no `start`, `attach`, `server`, `config`, …). Targets must match `[A-Za-z0-9][A-Za-z0-9_:.-]*`, so they can never be parsed as flags. 30 s default timeout.

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

#### Submit and picker guards (`lib/guards.js`)

- **`herdr_pane_submit`**: the server remembers, in memory, the last text it typed into each pane with `herdr_agent_send`. Enter is pressed only if that record is under 5 minutes old **and** the pane's input line holds exactly that text (whitespace and wrapping ignored). Each refusal has its own code: `not_bridge_text` (no record, or the line differs, e.g. the operator typed or edited it), `submit_window_expired`, `nothing_to_submit` (empty line or dim suggestion only), `approval_prompt`. Records are cleared on submit and by `herdr_pane_run`, and are lost on restart (fail closed). So the operator's own un-sent text can never be submitted.
- **`herdr_pane_keys`**: only the **active prompt block** is judged: the last dialog footer (`Esc to cancel` / `Enter to select|confirm` / `Tab to amend`) plus the 14 non-blank lines above it. Old scrollback doesn't count, so busy panes work. In that block it refuses with `approval_prompt` on the permission footer `Tab to amend`, or on `Do you want to`, `allow`, `permission`, `trust this folder` or `don't ask again` (case-insensitive). It refuses with `no_picker` unless the block carries the AskUserQuestion footer `Enter to select`, so `Enter`/`Esc` can't submit operator text or interrupt a working agent. Any other key: `key_not_allowed`. A picker whose own options mention "allow" is refused too, which is deliberate (fail safe).

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

## Liveness canary (v3.2.0, WO-CMD-8)

Every tool call writes a stamp under `~/.local/state/local-dev-bridge/` (mode 600, atomic rename):
`{"at": ISO time, "epoch": seconds, "tool": "<name>", "pid": n}`. It holds the tool name only, never arguments.
- `last-call.desktop`: written when Claude Desktop launched this bridge (its parent is `Claude.app/Contents/Helpers/disclaimer`). STEWARD's calls take this path.
- `last-call.other`: written for any other client, such as Claude Code panes. A busy pane can't keep the Desktop stamp fresh.

`LDB_STATE_DIR` overrides the directory; `LDB_CALLER=desktop|other` overrides the detection. A write failure is swallowed, so the tool call still runs.

The COMMANDER watchdog (`mini-cluster/scripts/commander-watchdog.sh`) alerts when `last-call.desktop` goes stale.
This catches the 2026-11-05 failure: Desktop reconnected the bridge after a renderer reload but never re-announced
its tools to the cloud session, so every process looked healthy while STEWARD had no bridge.

## UAT worker (headless queue consumer)

`worker/uat-worker.mjs` drains the queue without a human-driven session. It is the GHOST consumer (COMMANDER keeps its interactive `~/Projects/uat-worker` session).

- **Queue access:** listing `pending/` / `in-progress/` is read-only; every claim / complete / reset goes through this MCP server (spawned over stdio). Atomic claims mean it can coexist with other claimers.
- **Browser:** launches (or attaches to) this Mac's Chrome on `127.0.0.1:9333` with its own profile `~/.chrome-claude/uat-worker` (headless by default) and drives it over CDP.
- **Steps:** `navigate`, `click`, `type`, `select`, `scroll`, `wait`, `assert_visible`, `assert_text`, `assert_url`, `screenshot` run deterministically (no LLM). `custom` steps need `UAT_AGENT=claude` (headless `claude -p` limited to chrome-devtools-mcp tools); with `UAT_AGENT=off` (default) they are skipped and the test is marked `blocked`.
- **Ops:** singleton lock `$UAT_DIR/.worker.lock`; writes `$UAT_DIR/.status.json` every tick (same schema as COMMANDER's status pusher); reaps tests stuck in-progress > 15 min back to pending; infra failures (Chrome down) give the test back instead of failing it; 3 in a row → 5 min backoff.
- **Flags:** `--once`, `--dry-run` (claims nothing), `--only <id-prefix>`, `--loopback-only`.

```bash
./launchd/install.sh            # render + lint plist, worker --dry-run (changes nothing)
./launchd/install.sh --load     # install ~/Library/LaunchAgents/com.22ndventures.uat-worker.plist + bootstrap
./launchd/install.sh --status   # state + log tail (~/Library/Logs/uat-worker/)
./launchd/install.sh --unload   # rollback
node test/worker-smoke.mjs      # loopback smoke against the real queue: queue → claim → complete → results
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
node test/guards.mjs                                                        # submit/picker guards vs captured Claude Code screens (test/fixtures)
UAT_DIR=~/Projects/uat-queue node test/regression.mjs <scratch-pane-id>   # full UAT + Herdr pass over MCP stdio
node test/call.mjs uat_dashboard '{}'                                       # one-off tool call
```

`regression.mjs` leaves one `skipped` result (tag `bridge-smoke`) in `results/`. Give it a **scratch** shell pane (e.g. `herdr pane split <pane> --direction down --no-focus`) — it types into it. `herdr_wait` needs an agent pane, so test it against a scratch Claude Code session.

## License

MIT
