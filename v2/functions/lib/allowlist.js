/**
 * Allowlist for the MSApps Lead Pipeline v2.
 *
 * Authoritative list of emails that may sign in and use the dashboard.
 * This is enforced at three layers:
 *   1. Auth onCreate trigger (functions/index.js) — sets the `allowlisted: true`
 *      custom claim on first sign-in. Non-allowlisted users get the account
 *      immediately disabled.
 *   2. Firestore security rules — every read/write requires the claim + email match.
 *   3. Cloud Functions HTTP middleware — rejects unverified or non-allowlisted JWTs.
 *
 * To add a new user: edit this list, push, redeploy functions.
 */
export const ALLOWLIST = [
  'michal@msapps.mobi',
  'bar.kadosh@msapps.mobi',
  'michal@opsagents.agency',
];

export function isAllowlisted(email) {
  if (!email) return false;
  return ALLOWLIST.includes(email.toLowerCase().trim());
}
