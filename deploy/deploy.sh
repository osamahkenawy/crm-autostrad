#!/usr/bin/env bash
# Update the app on the server: back up the database, pull the new code, install, build the web app, restart, check it is healthy.
# Run it as the app user (the one that owns the checkout), from anywhere:
#
#   ./deploy/deploy.sh              latest of the current branch (main)
#   ./deploy/deploy.sh v1.2.0       a tag or a commit (also how you roll back)
#
# Settings (environment):  SERVICE=autostrad-crm        systemd unit to restart
#                          HEALTH_URL=...               default http://127.0.0.1:4000/api/health (API_PORT is honoured)
#                          SKIP_RESTART=1               do everything except the restart (testing, or no systemd)
#                          SKIP_BACKUP=1                skip the database backup (not recommended)
#                          SUDO=sudo                    how to restart the service ("" when running as root)
#                          HEALTH_TRIES=30              seconds to wait for the app to answer after the restart
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${SERVICE:-autostrad-crm}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:${API_PORT:-4000}/api/health}"
SUDO="${SUDO-sudo}"
TARGET="${1:-}"
cd "$APP_DIR"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nSTOPPED: %s\n' "$*" >&2; exit 1; }

[ -d .git ] || die "$APP_DIR is not a git checkout. Clone the repository there first (DEPLOYMENT.md, part 3)."
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "There are local changes to tracked files. Look at 'git status', then commit or discard them. Nothing was changed."

before="$(git rev-parse --short HEAD)"
branch="$(git rev-parse --abbrev-ref HEAD)"

say "Fetching from GitHub"
git fetch --tags --prune origin

if [ -n "$TARGET" ]; then
  say "Switching to $TARGET"
  git checkout --quiet --detach "$TARGET"
else
  [ "$branch" != "HEAD" ] || { git checkout --quiet main; branch=main; } # a previous rollback leaves a detached head: back to main
  say "Pulling $branch (fast-forward only)"
  git pull --ff-only --quiet origin "$branch"
fi
after="$(git rev-parse --short HEAD)"

if [ "$before" = "$after" ] && [ "${FORCE:-0}" != "1" ]; then
  say "Already at $after: nothing to deploy. (FORCE=1 rebuilds and restarts anyway.)"
  exit 0
fi
say "Deploying $before -> $after"
git --no-pager log --oneline --max-count=15 "$before..$after" 2>/dev/null || true

if [ "${SKIP_BACKUP:-0}" != "1" ] && { [ -n "${ARC_DB_PATH:-}" ] || [ -f server/data/autostrad.db ] || grep -qs '^ARC_DB_PATH=' server/.env; }; then
  say "Backing up the database"
  npm --prefix server run --silent backup || die "The backup failed, so the update was not applied to the running app. Fix that (disk space? permissions?), or run with SKIP_BACKUP=1 if you accept the risk. The new code is checked out but not built or restarted: re-run this script."
fi

say "Installing server dependencies"
npm --prefix server ci --omit=dev --no-audit --no-fund
say "Installing web dependencies and building the web app"
npm --prefix web ci --no-audit --no-fund
npm --prefix web run build

if [ "${SKIP_RESTART:-0}" = "1" ]; then
  say "SKIP_RESTART=1: built $after, the running app was not restarted."
  exit 0
fi

say "Restarting $SERVICE"
$SUDO systemctl restart "$SERVICE"

say "Waiting for $HEALTH_URL"
for i in $(seq 1 "${HEALTH_TRIES:-30}"); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
    say "Healthy. Deployed $after (was $before)."
    exit 0
  fi
  sleep 1
done

cat >&2 <<EOF

The app did not answer on $HEALTH_URL within ${HEALTH_TRIES:-30} seconds after the restart.
  See why:   journalctl -u $SERVICE -n 80 --no-pager
  Roll back: ./deploy/deploy.sh $before        (the database backup from just before the update is in server/data/backups)
EOF
exit 1
