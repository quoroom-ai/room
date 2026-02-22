#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$REPO_DIR/logs"
MARKER="# quoroom-social-rotate"
SCHEDULE="${SOCIAL_ROTATE_CRON:-0 9 * * *}"
VARIANTS_DIR="${SOCIAL_ROTATE_VARIANTS_DIR:-src/ui/public/social-variants-upgraded}"

mkdir -p "$LOG_DIR"

CRON_CMD="mkdir -p '$LOG_DIR' && cd '$REPO_DIR' && npm run social:rotate -- --dir '$VARIANTS_DIR' >> '$LOG_DIR/social-rotate.log' 2>&1 $MARKER"

CURRENT_CRON="$(crontab -l 2>/dev/null || true)"
FILTERED_CRON="$(printf "%s\n" "$CURRENT_CRON" | sed "/quoroom-social-rotate/d")"

{
  if [ -n "$FILTERED_CRON" ]; then
    printf "%s\n" "$FILTERED_CRON"
  fi
  printf "%s %s\n" "$SCHEDULE" "$CRON_CMD"
} | crontab -

echo "Installed cron entry:"
crontab -l | sed -n "/quoroom-social-rotate/p"
echo "Logs: $LOG_DIR/social-rotate.log"
