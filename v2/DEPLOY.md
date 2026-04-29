# MSApps Lead Pipeline v2 — staging deploy

Target: Firebase Hosting + Cloud Functions for Firebase in GCP project `opsagent-prod`.

## One-time setup (per machine)

```bash
# 1) Make sure firebase CLI is installed
npm install -g firebase-tools

# 2) Authenticate firebase CLI (opens browser; ~30 sec)
firebase login
```

The Firebase CLI keeps its auth in `~/.config/configstore/firebase-tools.json` once
you've logged in, so this is a one-time step per machine.

## Deploy

```bash
cd v2
./scripts/deploy-staging.sh
```

The script:
1. Checks firebase CLI auth — fails fast with instructions if missing.
2. Switches the active project to `opsagent-prod`.
3. Installs `functions/node_modules` if needed.
4. Pulls the live Firebase Web SDK config from the project and patches
   `public/app.js` (no manual key copy-paste).
5. Deploys hosting + functions + firestore rules + firestore indexes.
6. Smoke-tests `/api/health`.

The deployed URL will be `https://opsagent-prod.web.app`.

## What's already in the repo

- `firebase.json` — hosting + functions + firestore config.
- `firestore.rules` — allowlist + per-user owner enforcement.
- `firestore.indexes.json` — composite indexes for leads queries.
- `.firebaserc` — bound to `opsagent-prod`.
- `functions/` — Cloud Functions for Firebase code.
- `public/` — static SPA (auth shell, leads list, lead detail drawer).
- `scripts/deploy-staging.sh` — the script above.

## Allowlist

Only these emails can sign in (enforced at 3 layers — `beforeUserCreated`
trigger, Firestore rules, HTTP middleware):

- michal@msapps.mobi
- bar.kadosh@msapps.mobi
- michal@opsagents.agency

Edit `functions/lib/allowlist.js`, redeploy functions, that's it.

## Smoke tests after deploy

After `deploy-staging.sh` reports success, do this in Chrome on the Mac
(NOT the headless one — needs a real human to check Gmail for the link):

1. Open `https://opsagent-prod.web.app`
2. Enter `michal@opsagents.agency` → "שלח קישור התחברות"
3. Open Gmail, click the email link → should land back on the dashboard
4. Click any lead → drawer opens, no clipping behind the action bar (Card #2)
5. Click "ערוך" → textarea is enabled, type something → save → drawer closes
   and the new update appears in the list (Card #4)
6. Repeat for `bar.kadosh@msapps.mobi` (Card #6 — same code path, different
   ownerEmail scope)

If all green, the 3 cards in Deploy Staging move → Deploy → Done.

## Why staging and prod are the same project

For now `opsagent-prod` is the only Firebase project for this app — staging
and production live in the same project. Once Michal wants stricter
isolation, we'll create a `opsagent-staging` project, point a `staging`
target in `firebase.json` at it, and the script will grow a `--target staging`
flag.
