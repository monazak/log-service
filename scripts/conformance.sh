#!/usr/bin/env bash
#
# Conformance check against every rule stated in the project specification:
# every validation rule, every documented 400, the partial-batch contract, the
# aggregation parameters, and the zero-configuration auth posture.
#
# Run against a service that is already up:
#
#   docker compose up -d
#   scripts/conformance.sh                 # defaults to localhost:8080
#   BASE=localhost:9000 scripts/conformance.sh
#
# Exits non-zero on the first category that fails, so CI can gate on it.
set -uo pipefail

B="${BASE:-localhost:8080}"

# GNU and BSD `date` disagree on relative-time flags, and this runs on both a
# developer's macOS shell and CI's Linux runner.
iso() {
  if date -u -d '+1 minute' >/dev/null 2>&1; then
    date -u -d "+$1 minutes" +%Y-%m-%dT%H:%M:%SZ
  else
    date -u -v"+$1M" +%Y-%m-%dT%H:%M:%SZ
  fi
}
A='authorization: Bearer unrecognised-token'
J='content-type: application/json'
pass=0; fail=0
NOW=$(iso 0)
FUT=$(iso 10)
OK4=$(iso 4)

chk() { # label expected_code actual_code extra_grep body
  local label="$1" exp="$2" got="$3"
  if [ "$exp" = "$got" ]; then printf '  ok   %-52s %s\n' "$label" "$got"; pass=$((pass+1));
  else printf '  FAIL %-52s expected %s got %s\n' "$label" "$exp" "$got"; fail=$((fail+1)); fi
}
code() { curl -s -o /tmp/cb -w '%{http_code}' "$@"; }
body() { cat /tmp/cb; }

echo "== ingestion validation =="
chk "valid single entry -> 200" 200 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"error","service":"s","message":"m","attributes":{"a":"1"}}]}')"
chk "attributes optional -> 200" 200 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"s","message":"m"}]}')"
chk "number+bool attrs -> 200" 200 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"s","message":"m","attributes":{"n":3,"b":true}}]}')"
chk "4 min future accepted -> 200" 200 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$OK4"'","level":"info","service":"s","message":"m"}]}')"
chk "10 min future rejected -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$FUT"'","level":"info","service":"s","message":"m"}]}')"
chk "nested object attr -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"s","message":"m","attributes":{"o":{"x":1}}}]}')"
chk "array attr -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"s","message":"m","attributes":{"a":[1,2]}}]}')"
chk "bad level -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"critical","service":"s","message":"m"}]}')"
chk "empty service -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"","message":"m"}]}')"
chk "empty message -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"s","message":""}]}')"
chk "empty batch -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[]}')"
chk "malformed JSON -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[')"
chk "wrong top-level shape -> 400" 400 "$(code -X POST $B/logs -H "$J" -H "$A" -d '{"entries":[]}')"

echo "== partial batch: 200 + per-entry index & reason =="
c=$(code -X POST $B/logs -H "$J" -H "$A" -d '{"logs":[{"timestamp":"'"$NOW"'","level":"info","service":"s","message":"good"},{"level":"info","service":"s","message":"no ts"}]}')
chk "partial batch -> 200" 200 "$c"
echo "$(body)" | grep -q '"accepted":1' && { echo "  ok   accepted:1"; pass=$((pass+1)); } || { echo "  FAIL accepted"; fail=$((fail+1)); }
echo "$(body)" | grep -q '"index":1' && { echo "  ok   rejected[].index present"; pass=$((pass+1)); } || { echo "  FAIL index"; fail=$((fail+1)); }
echo "$(body)" | grep -q '"reason":"' && { echo "  ok   rejected[].reason present"; pass=$((pass+1)); } || { echo "  FAIL reason"; fail=$((fail+1)); }

echo "== query contract =="
chk "limit default/basic -> 200" 200 "$(code -H "$A" "$B/logs?limit=10")"
chk "limit=1000 max -> 200" 200 "$(code -H "$A" "$B/logs?limit=1000")"
chk "limit=1001 -> 400" 400 "$(code -H "$A" "$B/logs?limit=1001")"
chk "limit=0 -> 400" 400 "$(code -H "$A" "$B/logs?limit=0")"
chk "limit=abc -> 400" 400 "$(code -H "$A" "$B/logs?limit=abc")"
chk "bad level -> 400" 400 "$(code -H "$A" "$B/logs?level=critical")"
chk "bad timestamp -> 400" 400 "$(code -H "$A" "$B/logs?since=notatime")"
chk "until<since -> 400" 400 "$(code -H "$A" "$B/logs?since=2026-08-10T00:00:00Z&until=2026-08-09T00:00:00Z")"
chk "bad cursor -> 400" 400 "$(code -H "$A" "$B/logs?cursor=garbage")"
chk "combined filters -> 200" 200 "$(code -H "$A" "$B/logs?service=s&level=info&since=2026-01-01T00:00:00Z&until=2027-01-01T00:00:00Z&attr.a=1&q=m&limit=5")"

echo "== aggregate contract =="
S=2026-01-01T00:00:00Z; U=2027-01-01T00:00:00Z
for b in 1m 5m 1h 1d; do chk "bucket=$b -> 200" 200 "$(code -H "$A" "$B/logs/aggregate?since=$S&until=$U&bucket=$b")"; done
chk "group_by=service -> 200" 200 "$(code -H "$A" "$B/logs/aggregate?since=$S&until=$U&bucket=1d&group_by=service")"
chk "group_by=level -> 200" 200 "$(code -H "$A" "$B/logs/aggregate?since=$S&until=$U&bucket=1d&group_by=level")"
chk "missing since -> 400" 400 "$(code -H "$A" "$B/logs/aggregate?until=$U&bucket=1d")"
chk "missing until -> 400" 400 "$(code -H "$A" "$B/logs/aggregate?since=$S&bucket=1d")"
chk "missing bucket -> 400" 400 "$(code -H "$A" "$B/logs/aggregate?since=$S&until=$U")"
chk "bad bucket -> 400" 400 "$(code -H "$A" "$B/logs/aggregate?since=$S&until=$U&bucket=7m")"
chk "bad group_by -> 400" 400 "$(code -H "$A" "$B/logs/aggregate?since=$S&until=$U&bucket=1d&group_by=region")"
code -H "$A" "$B/logs/aggregate?since=$S&until=$U&bucket=1d" >/dev/null
body | grep -q '"group":null' && { echo "  ok   group is null without group_by"; pass=$((pass+1)); } || { echo "  FAIL group null"; fail=$((fail+1)); }

echo "== health & auth posture =="
chk "GET /health -> 200" 200 "$(code $B/health)"
chk "health w/ bearer -> 200" 200 "$(code -H "$A" $B/health)"
chk "unrecognised bearer ignored on /logs" 200 "$(code -H "$A" "$B/logs?limit=1")"

echo
echo "passed: $pass   failed: $fail"
[ "$fail" -eq 0 ] || exit 1
