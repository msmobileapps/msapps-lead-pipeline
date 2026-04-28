// MSApps Lead Pipeline v2 — frontend.
//   Firebase Auth (email link, passwordless) + Firestore reads via /api/leads.
//
// Firebase config below is the public web app config — safe to commit.
// All sensitive enforcement happens in firestore.rules and Cloud Functions.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth,
  isSignInWithEmailLink,
  sendSignInLinkToEmail,
  signInWithEmailLink,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';

// ── Firebase config — replace with the values from `firebase apps:sdkconfig web`
// after running `firebase init` against opsagent-prod.
const firebaseConfig = {
  apiKey: 'REPLACE_WITH_WEB_API_KEY',
  authDomain: 'opsagent-prod.firebaseapp.com',
  projectId: 'opsagent-prod',
  storageBucket: 'opsagent-prod.appspot.com',
  appId: 'REPLACE_WITH_WEB_APP_ID',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// ── DOM refs
const $ = (id) => document.getElementById(id);
const authShell = $('authShell');
const appShell = $('appShell');
const status = $('authStatus');

// ── Helpers
function setStatus(msg, type = '') {
  status.textContent = msg || '';
  status.className = 'auth-status' + (type ? ' ' + type : '');
}

async function authedFetch(path, opts = {}) {
  const token = await auth.currentUser.getIdToken();
  return fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
      ...(opts.headers || {}),
    },
  });
}

// ── Email-link sign-in flow
const ACTION_CODE_SETTINGS = {
  url: window.location.origin + '/?finish=1',
  handleCodeInApp: true,
};

$('signInForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('emailInput').value.trim().toLowerCase();
  if (!email) return;
  $('sendLinkBtn').disabled = true;
  setStatus('שולח קישור...');
  try {
    await sendSignInLinkToEmail(auth, email, ACTION_CODE_SETTINGS);
    window.localStorage.setItem('emailForSignIn', email);
    setStatus('שלחנו לך קישור התחברות למייל ✉️', 'success');
  } catch (err) {
    setStatus('שגיאה: ' + err.message, 'error');
  } finally {
    $('sendLinkBtn').disabled = false;
  }
});

$('signOutBtn').addEventListener('click', async () => {
  await signOut(auth);
});

// ── Complete email-link sign-in if returning from email
async function maybeCompleteEmailLinkSignIn() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return;
  let email = window.localStorage.getItem('emailForSignIn');
  if (!email) email = window.prompt('הזן את כתובת המייל שאליה נשלח הקישור:');
  if (!email) return;
  try {
    await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem('emailForSignIn');
    // Strip the link params from the URL.
    window.history.replaceState({}, '', window.location.pathname);
  } catch (err) {
    setStatus('כשל בהשלמת התחברות: ' + err.message, 'error');
  }
}

// ── App
async function loadLeads() {
  const r = await authedFetch('/api/leads');
  if (!r.ok) {
    const t = await r.text();
    console.error('leads error', t);
    return;
  }
  const { leads, stats } = await r.json();
  renderStats(stats);
  renderPipeline(stats);
  renderLeads(leads);
}

function renderStats(s) {
  $('statTotal').textContent = s.total;
  $('statActive').textContent = s.active;
  $('statHot').textContent = s.hot;
  $('statStale').textContent = s.stale;
}

function renderPipeline(stats) {
  const bar = $('pipelineBar');
  bar.innerHTML = '';
  const palette = ['#3b82f6','#8b5cf6','#06b6d4','#10b981','#f59e0b','#ef4444','#16a34a','#6b7280'];
  const stages = stats.stages || [];
  const total = stats.total || 1;
  stages.forEach((stage, i) => {
    const count = stats.byStage?.[stage] || 0;
    if (count === 0) return;
    const pct = (count / total) * 100;
    const seg = document.createElement('div');
    seg.className = 'pipeline-segment';
    seg.style.flex = String(pct);
    seg.style.background = palette[i % palette.length];
    seg.title = `${stage}: ${count}`;
    seg.textContent = count;
    bar.appendChild(seg);
  });
}

function renderLeads(leads) {
  const list = $('leadsList');
  list.innerHTML = '';
  if (!leads.length) {
    $('emptyState').style.display = 'block';
    return;
  }
  $('emptyState').style.display = 'none';
  leads.forEach(lead => {
    const card = document.createElement('div');
    card.className = 'lead-card heat-' + (lead.heat || 'normal');
    card.innerHTML = `
      <div class="row1">
        <div class="name">${escapeHtml(lead.name)} <span class="badge">${lead.stage}</span></div>
        <div class="badge" style="background:${lead.heatColor};color:white;">${lead.heatLabel}</div>
      </div>
      <div class="meta">
        ${lead.dateFormatted}
        ${lead.isStale ? ' • <span class="stale">⚠️ לא עודכן ' + lead.daysSinceUpdate + ' ימים</span>' : ''}
        ${lead.contactEmail ? ' • ' + escapeHtml(lead.contactEmail) : ''}
      </div>
    `;
    card.addEventListener('click', () => openLead(lead));
    list.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

function openLead(lead) {
  // Stub — wire to your existing detail panel UX.
  alert(`${lead.name}\n\n${lead.stage} • ${lead.heatLabel}\n\n${lead.rawNotes || '(אין הערות)'}`);
}

$('addFirstBtn')?.addEventListener('click', async () => {
  const name = prompt('שם הליד החדש:');
  if (!name) return;
  await authedFetch('/api/leads', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', payload: { name, stage: 'ליד חדש', heat: 'normal' } }),
  });
  loadLeads();
});

// ── Boot
maybeCompleteEmailLinkSignIn().then(() => {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      authShell.style.display = 'none';
      appShell.classList.add('active');
      $('userEmail').textContent = user.email;
      loadLeads();
    } else {
      authShell.style.display = 'flex';
      appShell.classList.remove('active');
    }
  });
});
