#!/usr/bin/env bash
# v2 staging deploy — Firebase Hosting + Cloud Functions for opsagent-prod.
#
# Prerequisite (one-time, ~30 sec): `firebase login` (browser-interactive).
# After that, this script is fully non-interactive.
#
# Usage:
#   cd v2
#   ./scripts/deploy-staging.sh
#
# What it does:
#   1. Checks firebase CLI is authenticated (fails fast if not).
#   2. Confirms the active project is opsagent-prod.
#   3. Ensures functions/node_modules is installed.
#   4. Patches v2/public/app.js with the real Firebase Web SDK config
#      pulled live from the Firebase project (no hand-editing).
#   5. Runs `firebase deploy --only hosting,functions,firestore:rules,firestore:indexes`.
#   6. Smoke-tests /api/health on the deployed URL.

set -euo pipefail

cd "$(dirname "$0")/.."
PROJECT="opsagent-prod"

# Resolve firebase CLI: env override → PATH → ~/npm-global/bin → /opt/homebrew/bin
if [ -n "${FB:-}" ]; then
  :
elif command -v firebase >/dev/null 2>&1; then
  FB="$(command -v firebase)"
elif [ -x "$HOME/npm-global/bin/firebase" ]; then
  FB="$HOME/npm-global/bin/firebase"
elif [ -x "/opt/homebrew/bin/firebase" ]; then
  FB="/opt/homebrew/bin/firebase"
else
  echo "✖ firebase CLI not found. Install with: npm install -g firebase-tools"
  exit 1
fi

echo "▶ deploy-staging.sh — project=$PROJECT — using $FB"

# ─── Auth check ───────────────────────────────────────────────────────────
if ! "$FB" login:list 2>&1 | grep -qE "@(msapps\.mobi|gmail\.com|opsagents\.agency)"; then
  echo "✖ firebase CLI is not authenticated."
  echo "   Run once on this machine:    firebase login"
  echo "   Then re-run:                  ./scripts/deploy-staging.sh"
  exit 1
fi

# ─── Project sanity ───────────────────────────────────────────────────────
"$FB" use "$PROJECT"

# ─── Functions deps ───────────────────────────────────────────────────────
if [ ! -d functions/node_modules ]; then
  echo "▶ installing functions deps"
  (cd functions && npm install)
fi

# ─── Patch web SDK config from live project ───────────────────────────────
WEB_APP_ID="$( "$FB" apps:list WEB --json 2>/dev/null | python3 -c "import sys,json
data=json.load(sys.stdin)
apps=data.get('result',[]) if isinstance(data,dict) else data
print(apps[0]['appId'] if apps else '')" )"

if [ -z "$WEB_APP_ID" ]; then
  echo "▶ no web app yet — creating one"
  "$FB" apps:create WEB "MSApps Lead Pipeline (web)" || true
  WEB_APP_ID="$( "$FB" apps:list WEB --json | python3 -c "import sys,json
data=json.load(sys.stdin)
apps=data.get('result',[]) if isinstance(data,dict) else data
print(apps[0]['appId'])" )"
fi

CONFIG_JSON="$( "$FB" apps:sdkconfig WEB "$WEB_APP_ID" --json )"
echo "▶ web app id: $WEB_APP_ID"

python3 - <<PY
import json, pathlib, re
data = json.loads('''$CONFIG_JSON''')
sdk = data.get('result', data).get('sdkConfig', {})
app = pathlib.Path('public/app.js')
src = app.read_text()
keys = ['apiKey','authDomain','projectId','storageBucket','appId','messagingSenderId']
for k in keys:
  if k in sdk:
    src = re.sub(rf"({k}:\s*)'[^']*'", lambda m: m.group(1)+repr(sdk[k]), src, count=1)
app.write_text(src)
print('  patched public/app.js with live SDK config')
PY

# ─── Deploy ───────────────────────────────────────────────────────────────
echo "▶ firebase deploy"
"$FB" deploy --only hosting,functions,firestore:rules,firestore:indexes --project "$PROJECT"

# ─── Smoke test ───────────────────────────────────────────────────────────
HOSTING_URL="https://${PROJECT}.web.app"
echo "▶ smoke test → $HOSTING_URL/api/health"
curl -sS -m 30 "$HOSTING_URL/api/health" | python3 -m json.tool || true

echo "✓ deploy complete: $HOSTING_URL"
