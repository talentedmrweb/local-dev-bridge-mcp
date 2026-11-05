#!/usr/bin/env bash
# One-shot installer: registers local-dev-bridge in Claude Desktop (and Claude Code if present) on this Mac.
set -euo pipefail
REPO="$(cd "$(dirname "$0")" && pwd)"
UAT_DIR="$HOME/Projects/uat-queue"
CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

NODE="$(command -v node || true)"
[ -z "$NODE" ] && { echo "✗ node not found on PATH — install Node ≥18 (brew install node) and re-run."; exit 1; }
echo "✓ node: $NODE ($("$NODE" -v))"

HERDR=""
for p in /opt/homebrew/bin/herdr /usr/local/bin/herdr; do [ -x "$p" ] && HERDR="$p" && break; done
if [ -n "$HERDR" ]; then echo "✓ herdr: $HERDR"; else echo "⚠ herdr not at /opt/homebrew/bin or /usr/local/bin — UAT tools will work, Herdr tools won't (found: $(command -v herdr || echo none))"; fi

cd "$REPO"
npm install --omit=dev --no-audit --no-fund >/dev/null && echo "✓ npm install"
"$NODE" -e "import('@modelcontextprotocol/sdk/server/index.js').then(()=>console.log('✓ MCP SDK loads'))"
mkdir -p "$UAT_DIR" && echo "✓ UAT dir: $UAT_DIR"

mkdir -p "$(dirname "$CFG")"
[ -f "$CFG" ] && cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)" && echo "✓ backed up existing config"
CFG="$CFG" NODE="$NODE" REPO="$REPO" UAT_DIR="$UAT_DIR" "$NODE" -e '
const fs=require("fs");const p=process.env.CFG;
let c={};try{c=JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){}
c.mcpServers=c.mcpServers||{};
c.mcpServers["local-dev-bridge"]={command:process.env.NODE,args:[process.env.REPO+"/index.js"],env:{UAT_DIR:process.env.UAT_DIR}};
fs.writeFileSync(p,JSON.stringify(c,null,2));console.log("✓ Claude Desktop config updated");'

if command -v claude >/dev/null 2>&1; then
  claude mcp remove local-dev-bridge -s user >/dev/null 2>&1 || true
  claude mcp add local-dev-bridge -s user -e UAT_DIR="$UAT_DIR" -- "$NODE" "$REPO/index.js" && echo "✓ Claude Code (user scope) registered"
fi
echo; echo "Done. Quit Claude Desktop fully (⌘Q) and reopen it, then tell STEWARD 'bridge is up'."
