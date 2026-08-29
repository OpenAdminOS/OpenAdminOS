#!/usr/bin/env bash
# Best-effort stage reporting for training.openadminos.com.
#
# Usage: report-stage.sh <stage> [detail] [outcome]
#   stage:   generate|validate|train|quantize|evaluate|review|release
#   detail:  optional free text shown on the live board (server caps at 240)
#   outcome: optional shipped|held|failed
#
# Env (set in the pod template; values live in Vercel/pod env, never in git):
#   TRAINING_RUN_ID       run identity, e.g. r12  (no-op when unset)
#   TRAINING_STATE_TOKEN  bearer token             (no-op when unset)
#   TRAINING_STATE_URL    defaults to the production endpoint
#
# Fire-and-forget by design: this must NEVER fail a training pipeline.
# Short timeouts, all errors swallowed, always exits 0.
[ -n "${TRAINING_STATE_TOKEN:-}" ] || exit 0
[ -n "${TRAINING_RUN_ID:-}" ] || exit 0
[ -n "${1:-}" ] || exit 0

URL="${TRAINING_STATE_URL:-https://training.openadminos.com/api/training/run-state}"
STAGE="$1"
DETAIL="${2:-}"
OUTCOME="${3:-}"

# Minimal JSON string escaping (backslashes and double quotes); details we
# send are single-line by convention.
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

BODY="{\"run\":\"$(esc "$TRAINING_RUN_ID")\",\"stage\":\"$(esc "$STAGE")\""
[ -n "$DETAIL" ] && BODY="$BODY,\"detail\":\"$(esc "$DETAIL")\""
[ -n "$OUTCOME" ] && BODY="$BODY,\"outcome\":\"$(esc "$OUTCOME")\""
BODY="$BODY}"

curl -sS --max-time 5 --retry 2 --retry-delay 1 -o /dev/null \
  -X POST \
  -H "Authorization: Bearer $TRAINING_STATE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$BODY" "$URL" 2>/dev/null || true
exit 0
