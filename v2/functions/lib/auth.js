/**
 * HTTPS middleware: verifies the Firebase ID token attached to a request and
 * confirms the user is allowlisted. Returns the decoded token, or null after
 * writing a 401/403 response.
 */
import { getAuth } from 'firebase-admin/auth';
import { isAllowlisted } from './allowlist.js';

export async function verifyRequest(req, res) {
  // Permit CORS preflight without auth.
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.status(204).send('');
    return null;
  }

  res.set('Access-Control-Allow-Origin', '*');

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    res.status(401).json({ error: 'Missing Authorization Bearer token' });
    return null;
  }

  let decoded;
  try {
    decoded = await getAuth().verifyIdToken(match[1]);
  } catch (err) {
    res.status(401).json({ error: 'Invalid token', detail: err.message });
    return null;
  }

  if (!decoded.email_verified) {
    res.status(403).json({ error: 'Email not verified' });
    return null;
  }

  if (!isAllowlisted(decoded.email)) {
    res.status(403).json({ error: 'Email not allowlisted', email: decoded.email });
    return null;
  }

  return decoded;
}
