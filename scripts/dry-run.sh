#!/bin/bash
# Dry run of the real scheduled() uptime probe in a local `wrangler dev` (no deploy, no remote bindings).
# Safe because the local dev session holds no secrets: no SLACK_BOT_TOKEN_ELC and no CONTROL_ROOM_TOKEN, so
# the handler can neither page Slack nor file a run report. The only outside traffic is one GET to the public
# engineeringleaders.io/mcp docs page (the sibling check). Exit 1 if the probe logged a failure or the tick did not return 200.
# Refuses to run when a .dev.vars file exists (it would load secrets).
set -u
cd "$(dirname "$0")/.." || exit 1
[ -f .dev.vars ] && { echo "FAIL .dev.vars present: refusing, it would load secrets"; exit 1; }
PORT=8791
LOG="$(mktemp -t pb-dry-run.XXXXXX)"
STATE="$(mktemp -d -t pb-dry-state.XXXXXX)"
npx wrangler dev --test-scheduled --port "$PORT" --persist-to "$STATE" >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null; pkill -P "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 1 60); do grep -q "Ready on" "$LOG" && break; sleep 1; done
grep -q "Ready on" "$LOG" || { echo "FAIL wrangler dev did not start"; tail -5 "$LOG"; exit 1; }
CODE=$(curl -s -m 90 -o /dev/null -w '%{http_code}' "http://localhost:$PORT/__scheduled?cron=*/15+*+*+*+*")
sleep 2
if [ "$CODE" = "200" ] && ! grep -q "UPTIME_FAIL" "$LOG"; then
  echo "dry-run ok: scheduled tick returned $CODE, no UPTIME_FAIL, no secrets loaded (no Slack, no control-room report possible)"
  exit 0
fi
echo "dry-run FAIL: scheduled tick returned $CODE"; grep -E "UPTIME_FAIL|ERROR" "$LOG" | head -5
exit 1
