# MSApps Lead Pipeline — v2 (Firebase + Firestore + Email Auth)

**Replaces** the v1 Netlify + Google-Calendar-as-DB stack with a real product:

- **Auth:** Firebase Auth, email-link (passwordless). Allowlist-enforced.
- **DB:**   Firestore in GCP project `opsagent-prod`.
- **Hosting:** Firebase Hosting (single SPA, served from `/public`).
- **API:**   Cloud Functions for Firebase v2 (Node 20, ESM).
- **AI:**   Gemma local on Cloud Run (zero-key default per global rules).

Multi-tenant: one deployment, three users. Firestore docs scoped by `ownerEmail`.
Each user signs in with their email and only sees their own pipeline.

| User | Sees |
|------|------|
| `michal@msapps.mobi`     | Her own pipeline (migrated from current GCal) |
| `bar.kadosh@msapps.mobi` | Empty pipeline, ready to populate |
| `michal@opsagents.agency`| Empty pipeline, ready to populate |

---

## File layout

```
.
├── firebase.json              # Hosting + Functions + Firestore wiring
├── .firebaserc                # default project = opsagent-prod
├── firestore.rules            # owner-scoped, allowlisted-only access
├── firestore.indexes.json     # composite indexes for ownerEmail+date
├── public/
│   ├── index.html             # auth screen + dashboard shell
│   └── app.js                 # Firebase SDK + UI logic
├── functions/
│   ├── package.json           # firebase-admin + firebase-functions
│   ├── index.js               # /api/health, /api/leads, /api/briefing, /api/ai-chat,
│   │                          # beforeUserCreated allowlist gate, scheduledBriefing
│   └── lib/
│       ├── allowlist.js       # the 3 emails — edit + redeploy to add users
│       ├── auth.js            # ID-token verification + allowlist check
│       └── lead-mapper.js     # Firestore doc → API shape, sort, stats
└── migrate/
    ├── gcal-to-firestore.js   # one-shot import from Michal's GCal
    └── seed-allowlist.js      # populate allowlist collection
```

---

## First-time deploy

Pre-reqs on the Mac (per Michal's CLAUDE.md):

```bash
npm i -g firebase-tools          # gcloud is already there
firebase login                   # one-time
```

1. **Initialize Firebase against the existing GCP project**
   ```bash
   cd msapps-leads-v2
   firebase use --add opsagent-prod
   firebase apps:create web "MSApps Lead Pipeline"
   firebase apps:sdkconfig web > /tmp/sdkconfig.json
   ```
   Copy the `apiKey` and `appId` values into `public/app.js` → `firebaseConfig`.

2. **Enable required APIs** (one-time, in the GCP console or via `gcloud`):
   - Firestore API
   - Identity Platform API (for Firebase Auth)
   - Cloud Functions, Cloud Run, Cloud Build, Artifact Registry, Eventarc, Pub/Sub
   ```bash
   gcloud services enable \
     firestore.googleapis.com identitytoolkit.googleapis.com \
     cloudfunctions.googleapis.com cloudbuild.googleapis.com \
     artifactregistry.googleapis.com eventarc.googleapis.com pubsub.googleapis.com \
     --project=opsagent-prod
   ```

3. **Create a Firestore database** (Native mode, region `nam5` or `us-central1`):
   ```bash
   gcloud firestore databases create --location=nam5 --project=opsagent-prod
   ```

4. **Enable email-link sign-in**
   Firebase Console → Authentication → Sign-in method → enable "Email link (passwordless)".

5. **Install function deps + deploy everything**
   ```bash
   cd functions && npm install && cd ..
   firebase deploy
   ```

6. **Seed the allowlist + migrate Michal's leads** (only this step needs the
   GCP service account):
   ```bash
   gcloud iam service-accounts create migrate-leads --project=opsagent-prod
   gcloud projects add-iam-policy-binding opsagent-prod \
     --member="serviceAccount:migrate-leads@opsagent-prod.iam.gserviceaccount.com" \
     --role="roles/datastore.user"
   gcloud iam service-accounts keys create ./service-account.json \
     --iam-account=migrate-leads@opsagent-prod.iam.gserviceaccount.com
   cp .env.example .env   # then fill GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN
   node migrate/seed-allowlist.js
   MIGRATE_OWNER_EMAIL=michal@msapps.mobi node migrate/gcal-to-firestore.js
   ```

   The other two users (bar, michal@opsagents) start empty — they create leads
   directly in the app.

7. **Verify**
   ```bash
   curl https://opsagent-prod.web.app/api/health
   ```
   Open `https://opsagent-prod.web.app`, sign in with one of the three emails,
   confirm the leads load.

---

## Adding a new allowlisted user

1. Add the email to `functions/lib/allowlist.js`.
2. `cd functions && npm run deploy` (re-deploys functions only — fast).
3. Optional: `node migrate/seed-allowlist.js` to drop a corresponding doc into
   the `allowlist` collection.

---

## Why this replaces v1

| | v1 (broken) | v2 |
|---|---|---|
| Auth | None — anyone with the URL | Firebase Auth email link, allowlist-gated |
| DB | Google Calendar (refresh token expires every 7 days in test mode) | Firestore — no token rot |
| Multi-user | One Calendar, one user | One project, N users, scoped by `ownerEmail` |
| Hosting | Netlify | Firebase Hosting (per Michal's "all on Firebase" rule) |
| AI | Groq → Gemini → HF cascade with paid keys | Gemma local on Cloud Run (zero-key default) |
| Schedule | `briefing-scheduled` Netlify cron | `scheduledBriefing` Cloud Scheduler |

---

## Local dev

```bash
firebase emulators:start
# auth on  http://localhost:9099
# fs on    http://localhost:8080
# fns on   http://localhost:5001
# host on  http://localhost:5000
```

The Hosting emulator proxies `/api/*` to the local Functions emulator
automatically thanks to the rewrites in `firebase.json`.
