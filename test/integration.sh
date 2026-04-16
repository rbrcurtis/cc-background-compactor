#!/bin/bash
set -e

# Integration test for cc-background-compactor
# - Builds synthetic JSONL with 20 user/assistant pairs where the last assistant
#   message has usage tokens above threshold (≥ 140k of 200k)
# - Runs the stop hook handler (triggers summarizer)
# - Waits for summary file
# - Runs the stop hook handler again (applies summary)
# - Validates compact_boundary present in JSONL

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SID="test-$(date +%s)-$$"
TRANSCRIPT=$(mktemp /tmp/cc-compact-test-transcript-XXXXXX.jsonl)
LOG=/tmp/cc-compact-bg.log
SUMMARY_FILE="/tmp/cc-compact-summary-${SID}.json"
LOCK_FILE="/tmp/cc-compact-lock-${SID}"

cleanup() {
  rm -f "$TRANSCRIPT" "$SUMMARY_FILE" "$LOCK_FILE" "$CACHE_DIR/model-windows.json.bak"
  if [ -f "$CACHE_DIR/model-windows.json.bak" ]; then
    mv "$CACHE_DIR/model-windows.json.bak" "$CACHE_DIR/model-windows.json"
  fi
}
trap cleanup EXIT

CACHE_DIR="$HOME/.config/cc-background-compactor"
mkdir -p "$CACHE_DIR"
if [ -f "$CACHE_DIR/model-windows.json" ]; then
  cp "$CACHE_DIR/model-windows.json" "$CACHE_DIR/model-windows.json.bak"
fi
echo '{"claude-sonnet-4-6": {"window": 200000, "probedAt": 0}}' > "$CACHE_DIR/model-windows.json"

export CC_BACKGROUND_COMPACTOR_CONFIG=$(mktemp /tmp/cc-test-config-XXXXXX.json)
echo '{"enabled":true,"threshold":0.7,"modelOverride":null,"contextWindow":null,"maxExcerptChars":120000,"ratio":0.5}' > "$CC_BACKGROUND_COMPACTOR_CONFIG"

echo "==> session id: $SID"
echo "==> transcript: $TRANSCRIPT"

python3 - <<PY
import json, uuid, datetime
path = "$TRANSCRIPT"
now = datetime.datetime.utcnow().isoformat() + "Z"
sid = "$SID"
prev = None
with open(path, "w") as f:
  for i in range(20):
    u = str(uuid.uuid4())
    user_msg = {
      "parentUuid": prev,
      "isSidechain": False,
      "type": "user",
      "message": {"role": "user", "content": f"User question {i} about feature X: " + ("lorem ipsum " * 40)},
      "uuid": u,
      "timestamp": now,
      "sessionId": sid,
      "version": "2.1.108",
    }
    f.write(json.dumps(user_msg) + "\n")
    prev = u
    u2 = str(uuid.uuid4())
    is_last = (i == 19)
    usage = {"input_tokens": 145000 if is_last else 1000, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": 300}
    asst_msg = {
      "parentUuid": prev,
      "isSidechain": False,
      "type": "assistant",
      "message": {"role": "assistant", "model": "claude-sonnet-4-6", "content": [{"type": "text", "text": f"Answer {i}: " + ("detailed step " * 20)}], "usage": usage},
      "uuid": u2,
      "timestamp": now,
      "sessionId": sid,
      "version": "2.1.108",
    }
    f.write(json.dumps(asst_msg) + "\n")
    prev = u2
PY

echo "==> $(wc -l <"$TRANSCRIPT") lines in transcript"

echo "==> firing stop hook (should trigger summarize at ~72.5%)"
truncate -s 0 "$LOG" || true
echo '{"session_id":"'"$SID"'","transcript_path":"'"$TRANSCRIPT"'","cwd":"/tmp","stop_hook_active":false}' | node "$ROOT/dist/compact.js"

echo "==> waiting for background summarizer (max 120s)"
for i in $(seq 1 120); do
  if [ -f "$SUMMARY_FILE" ]; then
    echo "==> summary ready after ${i}s"
    break
  fi
  sleep 1
done

if [ ! -f "$SUMMARY_FILE" ]; then
  echo "FAIL: summary not produced in 120s"
  echo "--- bg log ---"
  cat "$LOG" || true
  exit 1
fi

echo "==> summary preview:"
python3 -c "import json;d=json.load(open('$SUMMARY_FILE'));print('  lastOldLineIdx:',d['lastOldLineIdx']);print('  chars:',d['summaryChars']);print('  covered:',d['messagesCovered'],'/',d['messagesBefore']);print('  prep ms:',d['prepareDurationMs'])"

LINES_BEFORE=$(wc -l <"$TRANSCRIPT")
echo "==> firing stop hook (should apply summary)"
echo '{"session_id":"'"$SID"'","transcript_path":"'"$TRANSCRIPT"'","cwd":"/tmp","stop_hook_active":false}' | node "$ROOT/dist/compact.js"

LINES_AFTER=$(wc -l <"$TRANSCRIPT")
echo "==> lines: $LINES_BEFORE → $LINES_AFTER"

if ! grep -q '"compact_boundary"' "$TRANSCRIPT"; then
  echo "FAIL: compact_boundary not found in JSONL"
  exit 1
fi
echo "==> compact_boundary present"

if [ -f "$SUMMARY_FILE" ]; then
  echo "FAIL: summary file should have been deleted after apply"
  exit 1
fi

echo ""
echo "PASS"
