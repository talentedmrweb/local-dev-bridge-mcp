#!/usr/bin/env bash
# Install the GHOST UAT worker LaunchAgent.
#   ./launchd/install.sh            render + lint only (no changes to launchd)  ← default / dry-run
#   ./launchd/install.sh --load     render into ~/Library/LaunchAgents and bootstrap  ← the "ship"
#   ./launchd/install.sh --unload   bootout + remove the installed plist (rollback)
#   ./launchd/install.sh --status   launchctl print summary + tail of logs
set -euo pipefail
LABEL=com.22ndventures.uat-worker
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/uat-worker"
DOMAIN="gui/$(id -u)"
RENDERED="$(mktemp -d -t uat-worker)/$LABEL.plist"

render() {
  sed -e "s|__HOME__|$HOME|g" -e "s|__REPO__|$REPO|g" -e "s|__NODE__|$NODE|g" \
    "$REPO/launchd/$LABEL.plist" > "$RENDERED"
  plutil -lint "$RENDERED" >/dev/null
  echo "✅ rendered + linted: $RENDERED (node: $NODE)"
}

case "${1:-}" in
  ""|--dry-run)
    render
    [ -d "$REPO/node_modules/@modelcontextprotocol/sdk" ] && echo "✅ deps present" || echo "⚠️  run npm install in $REPO"
    [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && echo "✅ Chrome present" || echo "⚠️  Chrome not found"
    "$NODE" "$REPO/worker/uat-worker.mjs" --dry-run
    echo "ℹ️  dry run only — nothing loaded. Ship with: $0 --load"
    ;;
  --load)
    render
    mkdir -p "$LOGS"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    install -m 644 "$RENDERED" "$DEST"
    launchctl bootstrap "$DOMAIN" "$DEST"
    sleep 2
    launchctl print "$DOMAIN/$LABEL" | grep -E "state|pid" | head -3
    echo "✅ loaded $LABEL — logs: $LOGS"
    ;;
  --unload)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && echo "✅ booted out $LABEL" || echo "ℹ️  $LABEL not loaded"
    rm -f "$DEST" && echo "✅ removed $DEST"
    ;;
  --status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" || echo "ℹ️  $LABEL not loaded"
    tail -n 20 "$LOGS/uat-worker.out.log" 2>/dev/null || true
    ;;
  *) echo "usage: $0 [--dry-run|--load|--unload|--status]"; exit 2 ;;
esac
