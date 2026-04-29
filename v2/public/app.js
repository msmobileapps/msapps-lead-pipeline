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
    // BUG-LP-003 fix: if a different user is currently signed in, sign them
    // out before issuing a new link. Otherwise the existing session sticks
    // and the user can end up logged in as the wrong identity after the link.
    if (auth.currentUser && auth.currentUser.email && auth.currentUser.email.toLowerCase() !== email) {
      await signOut(auth);
    }
    await sendSignInLinkToEmail(auth, email, ACTION_CODE_SETTINGS);
    // Belt-and-suspenders persistence: localStorage + sessionStorage + cookie.
    // Email-link clicks sometimes land in a different storage context (auth
    // handler redirect, different browser profile). Multiple stores raise the
    // chance the email is recovered without prompting.
    try {
      window.localStorage.setItem('emailForSignIn', email);
      window.sessionStorage.setItem('emailForSignIn', email);
      document.cookie = 'emailForSignIn=' + encodeURIComponent(email) +
        '; max-age=900; path=/; SameSite=Lax';
    } catch {}
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

  // BUG-LP-003 fix: if a previous user is still signed in (e.g. earlier
  // successful sign-in as michal@msapps.mobi), sign them out first so the
  // email-link flow can install the new identity cleanly.
  if (auth.currentUser) {
    try { await signOut(auth); } catch {}
  }

  // Try every persistence we wrote on send (localStorage + sessionStorage + cookie).
  let email =
    window.localStorage.getItem('emailForSignIn') ||
    window.sessionStorage.getItem('emailForSignIn') ||
    readEmailCookie();

  if (!email) {
    email = window.prompt(
      'אנא הזן/י את כתובת המייל שאליה נשלח הקישור — אותה כתובת שהזנת קודם בדף ההתחברות:'
    );
  }
  if (!email) return;
  email = email.trim().toLowerCase();

  try {
    await signInWithEmailLink(auth, email, window.location.href);
    window.localStorage.removeItem('emailForSignIn');
    window.sessionStorage.removeItem('emailForSignIn');
    document.cookie = 'emailForSignIn=; max-age=0; path=/; SameSite=Lax';
    // Strip the link params from the URL.
    window.history.replaceState({}, '', window.location.pathname);
  } catch (err) {
    setStatus('כשל בהשלמת התחברות: ' + err.message, 'error');
  }
}

function readEmailCookie() {
  const m = document.cookie.match(/(?:^|;\s*)emailForSignIn=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
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
  const me = (auth.currentUser?.email || '').toLowerCase();
  leads.forEach(lead => {
    const isSharedWithMe = lead.ownerEmail && lead.ownerEmail.toLowerCase() !== me;
    const card = document.createElement('div');
    card.className = 'lead-card heat-' + (lead.heat || 'normal');
    card.innerHTML = `
      <div class="row1">
        <div class="name">${escapeHtml(lead.name)} <span class="badge">${lead.stage}</span>${isSharedWithMe ? '<span class="shared-badge" title="משותף איתך מאת ' + escapeHtml(lead.ownerEmail) + '">משותף 🤝</span>' : ''}</div>
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

// ── Lead detail drawer (Cards #2 + #4)
//
// Card #2 fix: drawer body has bottom padding so the action row never clips the
// last field, AND the action bar is sticky-bottom inside the drawer (not
// overlaying content) so nothing falls behind the white bar.
//
// Card #4 fix: the "ערוך" (Edit) button reveals an enabled <textarea>, a stage
// + heat picker, and a "next step" input. Saving POSTs an `updateNotes` action
// through /api/leads — which appends to the lead's `updates` array, optionally
// changes stage/heat, and triggers a refresh.
const STAGES_HE = [
  'ליד חדש',
  'נשלחה הצעה',
  'במשא ומתן',
  'מחכה לתשובה',
  'נסגר בהצלחה',
  'לא רלוונטי',
];
const HEAT_LABELS = {
  hot: 'חם',
  warm: 'פושר',
  normal: 'רגיל',
  upsale: 'Upsale',
  cold: 'קר',
};

let activeLead = null;

function openLead(lead) {
  activeLead = lead;
  $('drawerTitle').textContent = lead.name || '(ללא שם)';
  $('drawerStage').textContent = lead.stage || '—';
  $('drawerHeat').textContent = lead.heatLabel || HEAT_LABELS[lead.heat] || '—';
  $('drawerDate').textContent = lead.dateFormatted || '';
  $('drawerNotes').textContent = lead.rawNotes || '(אין הערות)';

  const updatesBox = $('drawerUpdates');
  updatesBox.innerHTML = '';
  const updates = Array.isArray(lead.updates) ? lead.updates : [];
  if (!updates.length) {
    updatesBox.innerHTML = '<div class="drawer-update"><div class="when">—</div>אין עדכונים עדיין.</div>';
  } else {
    updates.slice().reverse().forEach(u => {
      const el = document.createElement('div');
      el.className = 'drawer-update';
      const when = u.at?._seconds
        ? new Date(u.at._seconds * 1000).toLocaleString('he-IL')
        : (u.when || '');
      el.innerHTML = `<div class="when">${escapeHtml(when)}</div>${escapeHtml(u.text || '')}`;
      updatesBox.appendChild(el);
    });
  }

  // Populate stage select.
  const stageSel = $('editStage');
  stageSel.innerHTML = '';
  STAGES_HE.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = s;
    if (s === lead.stage) opt.selected = true;
    stageSel.appendChild(opt);
  });
  $('editHeat').value = lead.heat || 'normal';
  $('updateText').value = '';
  $('nextStep').value = '';

  renderShareSection(lead);

  // Always start in read-only mode.
  setEditMode(false);
  $('drawerOverlay').hidden = false;
  $('drawerOverlay').classList.add('open');
  $('leadDrawer').classList.add('open');
}

// ── Share section (Card #10)
//
// The owner sees a chip list of who the lead is shared with, plus a small
// form to add another allowlisted user. Non-owners see the list (read-only)
// with a note that only the owner can change shares.
const ALLOWLIST_HINT = [
  'michal@msapps.mobi',
  'bar.kadosh@msapps.mobi',
  'michal@opsagents.agency',
  'msmobileapps@gmail.com',
];

function renderShareSection(lead) {
  const me = (auth.currentUser?.email || '').toLowerCase();
  const owner = (lead.ownerEmail || '').toLowerCase();
  const sharedWith = Array.isArray(lead.sharedWith) ? lead.sharedWith : [];
  const isOwner = me === owner;

  const row = $('drawerSharedWith');
  row.innerHTML = '';

  // Owner chip (always shown, read-only)
  if (owner) {
    const ownerChip = document.createElement('span');
    ownerChip.className = 'share-chip is-self';
    ownerChip.textContent = '👤 ' + owner + (isOwner ? ' (את)' : ' (בעלים)');
    row.appendChild(ownerChip);
  }

  // Shared-with chips
  sharedWith.forEach((email) => {
    const chip = document.createElement('span');
    chip.className = 'share-chip';
    chip.appendChild(document.createTextNode('🤝 ' + email));
    if (isOwner) {
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = 'הסר שיתוף';
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', 'הסר שיתוף עם ' + email);
      x.addEventListener('click', () => unshareLead(lead.id, email));
      chip.appendChild(x);
    }
    row.appendChild(chip);
  });

  // Form: only the owner can add shares
  const form = $('drawerShareForm');
  const note = $('shareReadonlyNote');
  if (isOwner) {
    form.hidden = false;
    note.hidden = true;
    const sel = $('shareEmailSelect');
    sel.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— בחר משתמש —';
    sel.appendChild(placeholder);
    const taken = new Set([owner, ...sharedWith.map((e) => e.toLowerCase())]);
    ALLOWLIST_HINT.forEach((email) => {
      if (taken.has(email)) return;
      const opt = document.createElement('option');
      opt.value = email;
      opt.textContent = email;
      sel.appendChild(opt);
    });
  } else {
    form.hidden = true;
    note.hidden = false;
  }
  $('shareError').textContent = '';
}

async function shareLead(leadId, email) {
  if (!email) return;
  $('shareError').textContent = '';
  const btn = $('shareAddBtn');
  btn.disabled = true;
  try {
    const r = await authedFetch('/api/leads', {
      method: 'POST',
      body: JSON.stringify({ action: 'share', leadId, payload: { email } }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    // Update local activeLead state and re-render the section.
    if (activeLead && activeLead.id === leadId) {
      activeLead.sharedWith = [...(activeLead.sharedWith || []), email.toLowerCase()];
      renderShareSection(activeLead);
    }
    await loadLeads();
  } catch (err) {
    $('shareError').textContent = 'שגיאה בשיתוף: ' + err.message;
  } finally {
    btn.disabled = false;
  }
}

async function unshareLead(leadId, email) {
  if (!email) return;
  $('shareError').textContent = '';
  try {
    const r = await authedFetch('/api/leads', {
      method: 'POST',
      body: JSON.stringify({ action: 'unshare', leadId, payload: { email } }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    if (activeLead && activeLead.id === leadId) {
      activeLead.sharedWith = (activeLead.sharedWith || []).filter((e) => e.toLowerCase() !== email.toLowerCase());
      renderShareSection(activeLead);
    }
    await loadLeads();
  } catch (err) {
    $('shareError').textContent = 'שגיאה בביטול שיתוף: ' + err.message;
  }
}

function closeDrawer() {
  $('drawerOverlay').classList.remove('open');
  $('leadDrawer').classList.remove('open');
  setTimeout(() => { $('drawerOverlay').hidden = true; }, 200);
  activeLead = null;
}

function setEditMode(on) {
  $('drawerEditSection').hidden = !on;
  $('drawerEditBtn').hidden = on;
  $('drawerCancelEditBtn').hidden = !on;
  $('drawerSaveBtn').hidden = !on;
  // Card #4: textarea must always be enabled when edit mode is on.
  $('updateText').disabled = !on;
  if (on) setTimeout(() => $('updateText').focus(), 50);
}

async function saveLeadUpdate() {
  if (!activeLead) return;
  const note = $('updateText').value.trim();
  const stage = $('editStage').value;
  const heat = $('editHeat').value;
  const nextStep = $('nextStep').value.trim();
  // Allow saving if anything changed (note OR stage OR heat OR nextStep).
  if (!note && stage === activeLead.stage && heat === activeLead.heat && !nextStep) {
    setEditMode(false);
    return;
  }
  const saveBtn = $('drawerSaveBtn');
  saveBtn.disabled = true;
  const origText = saveBtn.textContent;
  saveBtn.textContent = 'שומר...';
  try {
    const r = await authedFetch('/api/leads', {
      method: 'POST',
      body: JSON.stringify({
        action: 'updateNotes',
        leadId: activeLead.id,
        payload: {
          note: note || undefined,
          stage,
          nextStep: nextStep || undefined,
        },
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    if (heat && heat !== activeLead.heat) {
      await authedFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          action: 'changeHeat',
          leadId: activeLead.id,
          payload: { heat },
        }),
      });
    }
    closeDrawer();
    await loadLeads();
  } catch (err) {
    alert('שגיאה בשמירה: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = origText;
  }
}

// Wire drawer events once.
function initDrawer() {
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'drawerOverlay') closeDrawer();
  });
  $('drawerEditBtn').addEventListener('click', () => setEditMode(true));
  $('drawerCancelEditBtn').addEventListener('click', () => setEditMode(false));
  $('drawerSaveBtn').addEventListener('click', saveLeadUpdate);
  $('drawerShareForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const email = $('shareEmailSelect').value.trim();
    if (!email || !activeLead) return;
    shareLead(activeLead.id, email);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('drawerOverlay').hidden) closeDrawer();
  });
}
initDrawer();

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
