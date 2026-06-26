const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

/* =========================
   MEMORY STORE
========================= */
let reports = [];
let incomingMessages = [];

const VALID_SEVERITIES = ['low', 'medium', 'critical'];
const VALID_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'];

function now() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function severityEmoji(s) {
  return { low: '🟡', medium: '🟠', critical: '🔴' }[s] || '⚪';
}

function statusEmoji(s) {
  return { OPEN: '🆕', IN_PROGRESS: '🔧', RESOLVED: '✅' }[s] || '❓';
}

function formatLocation(r) {
  if (!r.latDeg && !r.locationCode) return 'N/A';
  const latStr = r.latDeg ? `${r.latDeg}°${r.latMin || '00'}'${r.latDir || 'N'}` : '';
  const codeStr = r.locationCode ? `[Code: ${r.locationCode}]` : '';
  return `${latStr} ${codeStr}`.trim();
}

/* =========================
   WHATSAPP SEND FUNCTION
========================= */
async function sendWhatsAppMessage(message) {
  try {
    const response = await axios.post(
      `https://graph.facebook.com/v25.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: process.env.TARGET_PHONE,
        recipient_type: "individual",
        type: "text",
        text: {
          body: message,
          preview_url: false
        }
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
    console.log("WhatsApp sent:", response.data);
  } catch (err) {
    console.error("WhatsApp error:", err.response?.data || err.message);
  }
}

/* =========================
   WEBHOOK VERIFY (Meta)
========================= */
app.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }

  res.redirect('/dashboard');
});

/* =========================
   RECEIVE WHATSAPP MESSAGES
========================= */
app.post('/', (req, res) => {
  console.log("🔥 WEBHOOK HIT");

  const timestamp = now();
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  if (message) {
    incomingMessages.unshift({
      time: timestamp,
      from: message.from,
      text: message.text?.body || "[non-text]"
    });
    incomingMessages = incomingMessages.slice(0, 100);
  }

  res.sendStatus(200);
});

/* =========================
   API: CREATE INCIDENT
========================= */
app.post('/api/report', async (req, res) => {
  const {
    severity = 'low', message, user = 'dashboard', title = '', description = '',
    assignee = '', priority = 'normal', incidentType = 'General', sector = '',
    latDeg = '', latMin = '', latDir = 'N', locationCode = '',
    nature = 'General Outage', reportedBy = 'Dashboard Operator'
  } = req.body;

  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!VALID_SEVERITIES.includes(severity)) return res.status(400).json({ error: `Severity must be: ${VALID_SEVERITIES.join(', ')}` });

  const report = {
    id: Date.now(), user, severity, report: message,
    title: title || message.slice(0, 60), description, assignee,
    priority, status: 'OPEN', source: 'dashboard',
    time: now(), updatedAt: now(), comments: [],
    incidentType, sector: sector || 'Unassigned',
    latDeg, latMin, latDir, locationCode, nature, reportedBy, attachment: ''
  };

  reports.unshift(report);

  const locStr = formatLocation(report) !== 'N/A' ? `\n📍 Location: ${formatLocation(report)}` : '';
  const assigneeStr = assignee ? `\n👤 Assignee: @${assignee}` : '';
  const descStr = description ? `\n\n📋 Description:\n${description}` : '';

  await sendWhatsAppMessage(
    `🚨 NEW INCIDENT [${incidentType.toUpperCase()}]\n\n` +
    `Title: ${report.title}\n` +
    `ID: ${report.id}\n` +
    `Severity: ${severityEmoji(severity)} ${severity.toUpperCase()}\n` +
    `Priority: ${priority.toUpperCase()}\n` +
    `Nature: ${nature}\n` +
    `Sector: ${sector || 'Unassigned'}\n` +
    `Reporter: ${reportedBy}\n` +
    `Status: 🆕 OPEN` +
    locStr + assigneeStr +
    `\n\n💬 Report: ${message}` + descStr
  );

  res.json({ success: true, report });
});

/* =========================
   API: UPDATE INCIDENT FIELDS
========================= */
app.patch('/api/reports/:id', (req, res) => {
  const report = reports.find(r => String(r.id) === String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  ['title','description','assignee','priority','severity','incidentType','sector',
   'latDeg','latMin','latDir','locationCode','nature','reportedBy']
    .forEach(k => { if (req.body[k] !== undefined) report[k] = req.body[k]; });

  report.updatedAt = now();
  res.json({ success: true, report });
});

/* =========================
   API: UPDATE INCIDENT STATUS
========================= */
app.post('/api/reports/:id/status', async (req, res) => {
  const { status, user = 'dashboard' } = req.body;
  if (!VALID_STATUSES.includes(status)) return res.status(400).json({ error: `Status must be: ${VALID_STATUSES.join(', ')}` });

  const report = reports.find(r => String(r.id) === String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const old = report.status;
  report.status = status;
  report.updatedAt = now();

  await sendWhatsAppMessage(
    `${statusEmoji(status)} STATUS UPDATE\n\nIncident ${req.params.id}\n${old} → ${status}\nBy: ${user}`
  );

  res.json({ success: true, report });
});

/* =========================
   API: ADD COMMENT
========================= */
app.post('/api/reports/:id/comment', async (req, res) => {
  const { message, user = 'dashboard' } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const report = reports.find(r => String(r.id) === String(req.params.id));
  if (!report) return res.status(404).json({ error: 'Incident not found' });

  const comment = { id: Date.now(), user, message, time: now() };
  report.comments.push(comment);
  report.updatedAt = now();

  await sendWhatsAppMessage(
    `💬 COMMENT on "${report.title || req.params.id}"\n\n@${user}: ${message}`
  );

  res.json({ success: true, comment });
});

/* =========================
   API: GET ALL REPORTS
========================= */
app.get('/api/reports', (req, res) => res.json(reports));

/* =========================
   API: GET INCOMING MESSAGES
========================= */
app.get('/api/messages', (req, res) => res.json(incomingMessages));

/* =========================
   DASHBOARD HTML
========================= */
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Incident Command Center</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Roboto+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#07090f;
      --surface:#0c1018;
      --surface2:#111722;
      --surface3:#161e2c;
      --border:#1a2538;
      --border2:#223048;
      --text:#dce8f5;
      --muted:#3d5470;
      --muted2:#5a7a9a;
      --accent:#25d366;
      --accent2:#128c4a;
      --accent-blue:#4f8ef7;
      --sev-low-bg:#071a0f;
      --sev-low:#34d399;
      --sev-med-bg:#1a0f00;
      --sev-med:#fb923c;
      --sev-crit-bg:#1a0505;
      --sev-crit:#f87171;
      --st-open-bg:#04122b;
      --st-open:#60a5fa;
      --st-prog-bg:#1a1200;
      --st-prog:#fbbf24;
      --st-res-bg:#071a0f;
      --st-res:#34d399;
    }

    *,*::before,*::after { box-sizing:border-box; margin:0; padding:0; }

    body {
      background:var(--bg);
      font-family:'Inter','Segoe UI',sans-serif;
      color:var(--text);
      min-height:100vh;
      overflow:hidden;
    }

    /* ── HEADER ── */
    .header {
      background:var(--surface);
      border-bottom:1px solid var(--border);
      padding:0 24px;
      height:56px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      position:sticky;
      top:0;
      z-index:10;
    }
    .logo {
      font-family:'Roboto Mono',monospace;
      font-size:13px;
      font-weight:600;
      letter-spacing:.12em;
      text-transform:uppercase;
      display:flex;
      align-items:center;
      gap:10px;
    }
    .logo-icon {
      width:28px;
      height:28px;
      background:linear-gradient(135deg,#25d366,#128c4a);
      border-radius:7px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:14px;
      flex-shrink:0;
    }
    .pulse-dot {
      width:7px;
      height:7px;
      border-radius:50%;
      background:#ef4444;
      animation:pulse 2s infinite;
    }
    @keyframes pulse {
      0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}
      70%{box-shadow:0 0 0 8px rgba(239,68,68,0)}
      100%{box-shadow:0 0 0 0 rgba(239,68,68,0)}
    }
    .header-right { display:flex; align-items:center; gap:14px; }
    .ts { font-family:'Roboto Mono',monospace; font-size:11px; color:var(--muted2); }

    /* ── LAYOUT ── */
    .layout {
      display:flex;
      height:calc(100vh - 57px);
    }

    /* ── LEFT PANEL ── */
    .left-panel {
      width:300px;
      min-width:240px;
      border-right:1px solid var(--border);
      display:flex;
      flex-direction:column;
      overflow:hidden;
    }
    .panel-tools { padding:10px; border-bottom:1px solid var(--border); }
    .search {
      width:100%;
      background:var(--surface2);
      border:1px solid var(--border2);
      border-radius:6px;
      padding:8px 11px;
      color:var(--text);
      font-family:'Inter',sans-serif;
      font-size:13px;
      outline:none;
    }
    .search:focus { border-color:var(--accent); }
    .chips {
      padding:8px 10px;
      border-bottom:1px solid var(--border);
      display:flex;
      gap:4px;
      flex-wrap:wrap;
    }
    .chip {
      padding:3px 9px;
      border-radius:20px;
      font-size:10px;
      font-weight:600;
      cursor:pointer;
      border:1px solid var(--border2);
      color:var(--muted2);
      background:none;
      font-family:'Inter',sans-serif;
      letter-spacing:.04em;
    }
    .chip:hover { border-color:var(--accent); color:var(--accent); }
    .chip.on { background:var(--accent); border-color:var(--accent); color:#000; }

    .inc-list { flex:1; overflow-y:auto; padding:5px; }
    .inc-list::-webkit-scrollbar { width:3px; }
    .inc-list::-webkit-scrollbar-thumb { background:var(--border2); border-radius:2px; }

    /* ── INCIDENT CARD ── */
    .card {
      padding:10px 11px 10px 16px;
      border-radius:7px;
      border:1px solid transparent;
      margin-bottom:3px;
      cursor:pointer;
      position:relative;
    }
    .card:hover { background:var(--surface2); border-color:var(--border2); }
    .card.on { background:var(--surface2); border-color:var(--accent); }
    .sev-bar {
      position:absolute;
      left:5px;
      top:7px;
      bottom:7px;
      width:3px;
      border-radius:2px;
    }
    .sev-bar.low { background:var(--sev-low); }
    .sev-bar.medium { background:var(--sev-med); }
    .sev-bar.critical { background:var(--sev-crit); }
    .card-title {
      font-size:12px;
      font-weight:600;
      margin-bottom:5px;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .card-meta { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }

    /* ── BADGES ── */
    .badge {
      display:inline-flex;
      align-items:center;
      padding:2px 6px;
      border-radius:4px;
      font-size:9px;
      font-weight:700;
      font-family:'Roboto Mono',monospace;
      letter-spacing:.06em;
      text-transform:uppercase;
      white-space:nowrap;
    }
    .b-low    { background:var(--sev-low-bg); color:var(--sev-low); }
    .b-medium { background:var(--sev-med-bg); color:var(--sev-med); }
    .b-critical { background:var(--sev-crit-bg); color:var(--sev-crit); }
    .b-OPEN       { background:var(--st-open-bg); color:var(--st-open); }
    .b-IN_PROGRESS { background:var(--st-prog-bg); color:var(--st-prog); }
    .b-RESOLVED   { background:var(--st-res-bg); color:var(--st-res); }
    .b-src { background:var(--surface3); border:1px solid var(--border2); color:var(--muted2); }
    .b-wa { background:#0a2016; color:#25d366; border:1px solid #0d3d20; }

    /* ── DETAIL PANEL ── */
    .detail-panel {
      flex:1;
      display:flex;
      flex-direction:column;
      overflow:hidden;
    }

    /* Tab navigation for detail panel */
    .detail-tabs {
      display:flex;
      border-bottom:1px solid var(--border);
      background:var(--surface);
      flex-shrink:0;
    }
    .detail-tab {
      padding:12px 18px;
      font-size:11px;
      font-weight:600;
      letter-spacing:.06em;
      text-transform:uppercase;
      color:var(--muted2);
      cursor:pointer;
      border-bottom:2px solid transparent;
      font-family:'Inter',sans-serif;
      background:none;
      border-top:none;
      border-left:none;
      border-right:none;
    }
    .detail-tab.on { color:var(--accent); border-bottom-color:var(--accent); }
    .detail-tab:hover { color:var(--text); }

    .detail-head {
      padding:16px 22px 14px;
      background:var(--surface);
      border-bottom:1px solid var(--border);
      flex-shrink:0;
    }
    .detail-title-row {
      display:flex;
      align-items:flex-start;
      justify-content:space-between;
      gap:12px;
      margin-bottom:10px;
    }
    .detail-title {
      font-family:'Roboto Mono',monospace;
      font-size:15px;
      font-weight:600;
      line-height:1.35;
      flex:1;
    }
    .detail-id {
      font-family:'Roboto Mono',monospace;
      font-size:10px;
      color:var(--muted2);
      flex-shrink:0;
      margin-top:3px;
    }
    .detail-badges { display:flex; gap:5px; flex-wrap:wrap; margin-bottom:12px; }
    .action-row { display:flex; gap:7px; flex-wrap:wrap; }

    /* ── BUTTONS ── */
    .btn {
      display:inline-flex;
      align-items:center;
      gap:5px;
      padding:7px 13px;
      border-radius:6px;
      font-size:11px;
      font-weight:700;
      cursor:pointer;
      border:none;
      font-family:'Inter',sans-serif;
      letter-spacing:.04em;
      text-transform:uppercase;
      white-space:nowrap;
    }
    .btn-primary { background:var(--accent); color:#000; }
    .btn-primary:hover { background:var(--accent2); color:#fff; }
    .btn-ghost { background:var(--surface2); color:var(--text); border:1px solid var(--border2); }
    .btn-ghost:hover { border-color:var(--accent); color:var(--accent); }
    .btn-warn { background:var(--sev-med-bg); color:var(--sev-med); border:1px solid #5a3000; }
    .btn-warn:hover { background:#2a1800; }
    .btn-success { background:var(--sev-low-bg); color:var(--sev-low); border:1px solid #0d4020; }
    .btn-success:hover { background:#0a2d16; }
    .btn-danger { background:var(--sev-crit-bg); color:var(--sev-crit); border:1px solid #5a1010; }
    .btn-danger:hover { background:#2a0808; }

    /* ── FORM FIELD DISPLAY (detail view) ── */
    .dv-scroll {
      flex:1;
      overflow-y:auto;
      padding:24px 28px;
      display:flex;
      flex-direction:column;
      gap:20px;
    }
    .dv-scroll::-webkit-scrollbar { width:3px; }
    .dv-scroll::-webkit-scrollbar-thumb { background:var(--border2); border-radius:2px; }

    .dv-row { display:grid; gap:14px; }
    .dv-row.col2 { grid-template-columns:1fr 1fr; }
    .dv-row.col3 { grid-template-columns:1fr 1fr 1fr; }
    .dv-row.col1 { grid-template-columns:1fr; }

    .dv-field { display:flex; flex-direction:column; gap:5px; }
    .dv-label {
      font-size:9px;
      text-transform:uppercase;
      letter-spacing:.12em;
      color:var(--muted2);
      font-weight:700;
    }
    .dv-label.req::after { content:' *'; color:var(--sev-crit); }

    .dv-val {
      background:var(--surface2);
      border:1px solid var(--border2);
      border-radius:7px;
      padding:10px 14px;
      font-size:13px;
      color:var(--text);
      font-family:'Inter','Segoe UI',sans-serif;
      min-height:40px;
      display:flex;
      align-items:center;
    }
    .dv-val.mono { font-family:'Roboto Mono','Courier New',monospace; font-size:12px; }
    .dv-val.muted { color:var(--muted2); }
    .dv-val.prose { align-items:flex-start; min-height:64px; line-height:1.6; color:#9ab5cf; }

    .dv-input {
      width:100%;
      background:var(--surface2);
      border:1px solid var(--border2);
      border-radius:7px;
      padding:10px 14px;
      font-size:13px;
      color:var(--text);
      font-family:'Inter','Segoe UI',sans-serif;
      min-height:40px;
      outline:none;
      transition:border-color .15s;
    }
    .dv-input:focus { border-color:var(--accent); }
    .dv-input.mono { font-family:'Roboto Mono','Courier New',monospace; font-size:12px; }
    .dv-input option { background:var(--surface2); }

    .dv-section { display:flex; flex-direction:column; gap:14px; }
    .dv-section-head {
      display:flex;
      align-items:center;
      justify-content:space-between;
      border-bottom:1px solid var(--border);
      padding-bottom:10px;
    }
    .dv-section-title {
      font-size:11px;
      font-weight:700;
      letter-spacing:.1em;
      text-transform:uppercase;
      color:var(--text);
      display:flex;
      align-items:center;
      gap:7px;
    }
    .dv-section-title::before {
      content:'';
      width:3px;
      height:14px;
      background:var(--accent);
      border-radius:2px;
      display:block;
    }

    /* ── COMMENTS ── */
    .comment-thread { display:flex; flex-direction:column; gap:8px; }
    .comment-item {
      display:flex;
      gap:10px;
      padding:10px 12px;
      background:var(--surface2);
      border:1px solid var(--border);
      border-radius:8px;
    }
    .av {
      width:28px;
      height:28px;
      border-radius:50%;
      background:var(--st-open-bg);
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:10px;
      font-weight:700;
      flex-shrink:0;
      font-family:'Roboto Mono',monospace;
      color:var(--st-open);
    }
    .c-user { font-size:12px; font-weight:600; color:var(--accent); }
    .c-time { font-size:10px; color:var(--muted2); font-family:'Roboto Mono',monospace; }
    .c-text { font-size:13px; line-height:1.5; color:#9ab5cf; margin-top:3px; }

    .comment-bar {
      display:flex;
      gap:8px;
      padding:12px 20px;
      border-top:1px solid var(--border);
      background:var(--surface);
      flex-shrink:0;
    }
    .comment-input {
      flex:1;
      background:var(--surface2);
      border:1px solid var(--border2);
      border-radius:7px;
      padding:9px 12px;
      color:var(--text);
      font-family:'Inter',sans-serif;
      font-size:13px;
      outline:none;
      resize:none;
      height:38px;
      transition:border-color .15s, height .15s;
    }
    .comment-input:focus { border-color:var(--accent); height:68px; }

    /* ── WA LOG PANEL ── */
    .wa-log-panel {
      flex:1;
      overflow-y:auto;
      padding:20px 24px;
      display:flex;
      flex-direction:column;
      gap:10px;
    }
    .wa-log-panel::-webkit-scrollbar { width:3px; }
    .wa-log-panel::-webkit-scrollbar-thumb { background:var(--border2); border-radius:2px; }
    .wa-msg {
      display:flex;
      gap:10px;
      padding:12px 14px;
      background:var(--surface2);
      border:1px solid var(--border);
      border-radius:8px;
    }
    .wa-from { font-size:12px; font-weight:600; color:var(--accent); font-family:'Roboto Mono',monospace; }
    .wa-text { font-size:13px; color:#9ab5cf; margin-top:3px; line-height:1.5; }
    .wa-time { font-size:10px; color:var(--muted2); font-family:'Roboto Mono',monospace; margin-top:4px; }

    /* ── EMPTY STATE ── */
    .empty {
      flex:1;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      gap:10px;
      color:var(--muted2);
    }
  </style>
</head>
<body>

<div class="header">
  <div class="logo">
    <div class="logo-icon">💬</div>
    Incident&nbsp;Command
    <div class="pulse-dot"></div>
  </div>
  <div class="header-right">
    <span class="ts" id="ts">CONNECTING...</span>
    <button class="btn btn-primary" id="new-btn">+ New Incident</button>
  </div>
</div>

<div class="layout">
  <!-- LEFT: Incident List -->
  <div class="left-panel">
    <div class="panel-tools">
      <input class="search" id="search" placeholder="Search incidents…">
    </div>
    <div class="chips">
      <button class="chip on" data-f="">All</button>
      <button class="chip" data-f="OPEN">Open</button>
      <button class="chip" data-f="IN_PROGRESS">In Progress</button>
      <button class="chip" data-f="RESOLVED">Resolved</button>
      <button class="chip" data-f="critical">Critical</button>
      <button class="chip" data-f="medium">Medium</button>
      <button class="chip" data-f="low">Low</button>
    </div>
    <div class="inc-list" id="inc-list"></div>
  </div>

  <!-- RIGHT: Detail Panel -->
  <div class="detail-panel" id="detail-panel">
    <div class="empty">
      <div style="font-size:40px;opacity:.2;">⌖</div>
      <div style="font-size:14px;font-weight:600;">Select an incident</div>
      <div style="font-size:12px;margin-top:2px;">or create one with + New Incident</div>
    </div>
  </div>
</div>

<script>
(function () {
  var all = [], incomingMsgs = [], activeFilter = '', selectedId = null, activeTab = 'incident';

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function ini(n) {
    return String(n || '?').replace('@','').slice(0,2).toUpperCase();
  }
  function coords(r) {
    if (!r.latDeg) return null;
    return r.latDeg + String.fromCharCode(176) + (r.latMin || '00') + "'" + (r.latDir || 'N');
  }
  function field(label, value, cls, req) {
    var lbl = '<div class="dv-label' + (req ? ' req' : '') + '">' + label + '</div>';
    var v = '<div class="dv-val' + (cls ? ' ' + cls : '') + '">' + esc(value || '—') + '</div>';
    return '<div class="dv-field">' + lbl + v + '</div>';
  }
  function row(cols, content) {
    return '<div class="dv-row col' + cols + '">' + content + '</div>';
  }

  /* ── LOAD DATA ── */
  function load() {
    fetch('/api/reports').then(function(r){ return r.json(); }).then(function(data){
      all = data;
      document.getElementById('ts').textContent = 'UPDATED ' + new Date().toLocaleTimeString();
      renderList();
      if (selectedId) {
        var r = all.find(function(r){ return String(r.id) === String(selectedId); });
        if (r) renderDetail(r);
      }
    }).catch(function(e){ console.error(e); });

    fetch('/api/messages').then(function(r){ return r.json(); }).then(function(data){
      incomingMsgs = data;
      if (activeTab === 'incoming') renderIncomingTab();
    }).catch(function(e){ console.error(e); });
  }

  /* ── FILTER CHIPS ── */
  document.querySelectorAll('.chip').forEach(function(c){
    c.addEventListener('click', function(){
      activeFilter = c.dataset.f;
      document.querySelectorAll('.chip').forEach(function(x){ x.classList.remove('on'); });
      c.classList.add('on');
      renderList();
    });
  });

  document.getElementById('search').addEventListener('input', renderList);

  /* ── RENDER LIST ── */
  function renderList() {
    var q = (document.getElementById('search').value || '').toLowerCase();
    var list = all.filter(function(r){
      if (activeFilter === 'critical' || activeFilter === 'medium' || activeFilter === 'low') {
        if (r.severity !== activeFilter) return false;
      } else if (activeFilter) {
        if (r.status !== activeFilter) return false;
      }
      if (q) {
        var hay = [r.title, r.report, r.user, r.assignee, r.incidentType, r.nature, r.reportedBy, r.sector, r.locationCode].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    var el = document.getElementById('inc-list');
    if (!list.length) {
      el.innerHTML = '<div style="padding:20px;color:var(--muted2);font-size:13px;text-align:center;">No incidents match</div>';
      return;
    }
    el.innerHTML = list.map(function(r){
      var active = String(r.id) === String(selectedId) ? ' on' : '';
      var prefix = r.incidentType ? '[' + esc(r.incidentType) + '] ' : '';
      var t = (r.time || '').slice(5, 16);
      return '<div class="card' + active + '" data-id="' + r.id + '">' +
        '<div class="sev-bar ' + esc(r.severity) + '"></div>' +
        '<div class="card-title">' + prefix + esc(r.title || r.report) + '</div>' +
        '<div class="card-meta">' +
          '<span class="badge b-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
          '<span class="badge b-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
          '<span style="font-size:10px;color:var(--muted2);margin-left:auto;">' + t + '</span>' +
        '</div></div>';
    }).join('');
  }

  /* Event delegation for incident list */
  document.getElementById('inc-list').addEventListener('click', function(e){
    var card = e.target.closest('[data-id]');
    if (!card) return;
    selectedId = card.dataset.id;
    activeTab = 'incident';
    renderList();
    var r = all.find(function(r){ return String(r.id) === String(selectedId); });
    if (r) renderDetail(r);
  });

  /* ── NEW INCIDENT ── */
  document.getElementById('new-btn').addEventListener('click', function(){
    selectedId = null;
    renderList();
    renderNewForm();
  });

  /* ── RENDER DETAIL ── */
  function renderDetail(r) {
    var panel = document.getElementById('detail-panel');
    var assigneeVal = r.assignee ? '@' + r.assignee : 'Unassigned';

    var comments = (r.comments || []).length
      ? r.comments.map(function(c){
          return '<div class="comment-item">' +
            '<div class="av">' + ini(c.user) + '</div>' +
            '<div style="flex:1"><div style="display:flex;gap:8px;align-items:center;">' +
              '<span class="c-user">@' + esc(c.user) + '</span>' +
              '<span class="c-time">' + esc(c.time) + '</span></div>' +
            '<div class="c-text">' + esc(c.message) + '</div></div></div>';
        }).join('')
      : '<div style="color:var(--muted2);font-size:13px;padding:6px 0;">No comments yet.</div>';

    var descHtml = r.description
      ? '<div class="dv-section">' +
          '<div class="dv-section-head"><div class="dv-section-title">Description</div></div>' +
          row(1, field('Details', r.description, 'prose')) +
        '</div>'
      : '';

    panel.innerHTML =
      '<div class="detail-head">' +
        '<div class="detail-title-row">' +
          '<div class="detail-title">[' + esc(r.incidentType || 'General') + '] ' + esc(r.title || r.report) + '</div>' +
          '<div class="detail-id">#' + r.id + '</div>' +
        '</div>' +
        '<div class="detail-badges">' +
          '<span class="badge b-' + esc(r.severity) + '">' + esc(r.severity) + '</span>' +
          '<span class="badge b-' + esc(r.status) + '">' + r.status.replace('_',' ') + '</span>' +
          '<span class="badge b-wa">WhatsApp</span>' +
        '</div>' +
        '<div class="action-row" id="action-row"></div>' +
      '</div>' +
      '<div class="detail-tabs">' +
        '<button class="detail-tab on" data-tab="incident">Incident Details</button>' +
        '<button class="detail-tab" data-tab="incoming">Incoming Messages (' + incomingMsgs.length + ')</button>' +
      '</div>' +
      '<div class="dv-scroll" id="tab-incident">' +
        // Report Info
        '<div class="dv-section">' +
          row(2,
            field('Report Title', r.title || r.report) +
            field('Report Type', r.incidentType || 'General')
          ) +
          row(2,
            field('Report Date & Time', r.time, 'mono') +
            field('Severity', r.severity)
          ) +
          row(2,
            field('Reported By', r.reportedBy || '—', '', true) +
            field('Nature of Incident', r.nature || 'Unspecified', '', true)
          ) +
          row(2,
            field('Sector', r.sector || 'Unassigned') +
            field('Assignee', assigneeVal)
          ) +
          row(2,
            field('Created', r.time, 'mono') +
            field('Last Updated', r.updatedAt || r.time, 'mono')
          ) +
        '</div>' +
        // Location
        '<div class="dv-section">' +
          '<div class="dv-section-head"><div class="dv-section-title">Location</div></div>' +
          '<div class="dv-label" style="margin-bottom:6px;">Latitude</div>' +
          row(3,
            field('Lat Deg', r.latDeg || '—', 'mono') +
            field('Lat Min', r.latMin || '—', 'mono') +
            field('Lat Dir', r.latDir || 'N', 'mono')
          ) +
          row(1, field('Location Code', r.locationCode || '—', '', true)) +
        '</div>' +
        // Short Report
        '<div class="dv-section">' +
          '<div class="dv-section-head"><div class="dv-section-title">Short Report</div></div>' +
          row(1, field('Summary', r.report, 'prose', true)) +
        '</div>' +
        descHtml +
        // Comments
        '<div class="dv-section">' +
          '<div class="dv-section-head"><div class="dv-section-title">Comments (' + (r.comments || []).length + ')</div></div>' +
          '<div class="comment-thread">' + comments + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="comment-bar">' +
        '<textarea class="comment-input" id="c-input" placeholder="Add a comment… (Enter to send)"></textarea>' +
        '<button class="btn btn-primary" id="c-send">Send</button>' +
      '</div>';

    // Build action buttons
    var actionRow = document.getElementById('action-row');
    if (r.status !== 'IN_PROGRESS') {
      var b1 = document.createElement('button');
      b1.className = 'btn btn-warn'; b1.textContent = 'In Progress';
      b1.addEventListener('click', function(){ setStatus(r.id, 'IN_PROGRESS'); });
      actionRow.appendChild(b1);
    }
    if (r.status !== 'RESOLVED') {
      var b2 = document.createElement('button');
      b2.className = 'btn btn-success'; b2.textContent = 'Resolve';
      b2.addEventListener('click', function(){ setStatus(r.id, 'RESOLVED'); });
      actionRow.appendChild(b2);
    }
    if (r.status !== 'OPEN') {
      var b3 = document.createElement('button');
      b3.className = 'btn btn-danger'; b3.textContent = 'Reopen';
      b3.addEventListener('click', function(){ setStatus(r.id, 'OPEN'); });
      actionRow.appendChild(b3);
    }

    document.getElementById('c-send').addEventListener('click', function(){ addComment(r.id); });
    document.getElementById('c-input').addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addComment(r.id); }
    });

    // Tab switching
    panel.querySelectorAll('.detail-tab').forEach(function(tab){
      tab.addEventListener('click', function(){
        panel.querySelectorAll('.detail-tab').forEach(function(t){ t.classList.remove('on'); });
        tab.classList.add('on');
        activeTab = tab.dataset.tab;
        var incTab = document.getElementById('tab-incident');
        var cbar = panel.querySelector('.comment-bar');
        if (activeTab === 'incident') {
          if (incTab) incTab.style.display = 'flex';
          if (cbar) cbar.style.display = 'flex';
          var existingLog = document.getElementById('tab-incoming');
          if (existingLog) existingLog.remove();
        } else {
          if (incTab) incTab.style.display = 'none';
          if (cbar) cbar.style.display = 'none';
          renderIncomingTab(panel);
        }
      });
    });
  }

  /* ── INCOMING MESSAGES TAB ── */
  function renderIncomingTab(panel) {
    panel = panel || document.getElementById('detail-panel');
    var existing = document.getElementById('tab-incoming');
    if (existing) existing.remove();

    var div = document.createElement('div');
    div.id = 'tab-incoming';
    div.className = 'wa-log-panel';

    if (!incomingMsgs.length) {
      div.innerHTML = '<div class="empty" style="padding:40px 0;"><div style="font-size:36px;opacity:.2;">📭</div><div style="font-size:14px;font-weight:600;">No incoming messages</div><div style="font-size:12px;margin-top:4px;">Messages from WhatsApp will appear here</div></div>';
    } else {
      div.innerHTML = incomingMsgs.map(function(m){
        return '<div class="wa-msg">' +
          '<div class="av" style="background:#0a2016;color:#25d366;">📨</div>' +
          '<div style="flex:1">' +
            '<div class="wa-from">+' + esc(m.from) + '</div>' +
            '<div class="wa-text">' + esc(m.text) + '</div>' +
            '<div class="wa-time">' + esc(m.time) + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    var cbar = panel.querySelector('.comment-bar');
    if (cbar) {
      panel.insertBefore(div, cbar);
    } else {
      panel.appendChild(div);
    }
  }

  /* ── ACTIONS ── */
  function setStatus(id, status) {
    fetch('/api/reports/' + id + '/status', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ status: status, user: 'dashboard' })
    }).then(load);
  }

  function addComment(id) {
    var input = document.getElementById('c-input');
    var msg = input.value.trim();
    if (!msg) return;
    fetch('/api/reports/' + id + '/comment', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message: msg, user: 'dashboard' })
    }).then(function(){ input.value = ''; load(); });
  }

  /* ── NEW INCIDENT FORM ── */
  function renderNewForm() {
    var panel = document.getElementById('detail-panel');
    panel.innerHTML =
      '<div class="detail-head">' +
        '<div class="detail-title-row">' +
          '<div class="detail-title">New Incident Report</div>' +
        '</div>' +
        '<div class="detail-badges"><span class="badge b-wa">WhatsApp</span></div>' +
        '<div class="action-row" id="action-row"></div>' +
      '</div>' +
      '<div class="dv-scroll">' +
        // Report Info
        '<div class="dv-section">' +
          '<div class="dv-row col2">' +
            '<div class="dv-field"><div class="dv-label req">Report Title</div><input class="dv-input" id="nf-title" placeholder="Short descriptive title"></div>' +
            '<div class="dv-field"><div class="dv-label">Report Type</div><input class="dv-input" id="nf-type" placeholder="Outage, Cyber, Leak…"></div>' +
          '</div>' +
          '<div class="dv-row col2">' +
            '<div class="dv-field"><div class="dv-label req">Nature of Incident</div><input class="dv-input" id="nf-nature" placeholder="Fiber Cut, Power Drop…"></div>' +
            '<div class="dv-field"><div class="dv-label">Severity</div>' +
              '<select class="dv-input" id="nf-sev"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="critical">Critical</option></select>' +
            '</div>' +
          '</div>' +
          '<div class="dv-row col2">' +
            '<div class="dv-field"><div class="dv-label">Sector</div><input class="dv-input" id="nf-sector" placeholder="Sector 4, Alpha, North-Zone"></div>' +
            '<div class="dv-field"><div class="dv-label">Priority</div>' +
              '<select class="dv-input" id="nf-pri"><option value="low">Low</option><option value="normal" selected>Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select>' +
            '</div>' +
          '</div>' +
          '<div class="dv-row col2">' +
            '<div class="dv-field"><div class="dv-label req">Reported By</div><input class="dv-input" id="nf-reportedby" placeholder="Name / Unit"></div>' +
            '<div class="dv-field"><div class="dv-label">Assignee</div><input class="dv-input" id="nf-assignee" placeholder="@username"></div>' +
          '</div>' +
        '</div>' +
        // Location
        '<div class="dv-section">' +
          '<div class="dv-section-head"><div class="dv-section-title">Location</div></div>' +
          '<div class="dv-label" style="margin-bottom:6px;">Latitude</div>' +
          '<div class="dv-row col3">' +
            '<div class="dv-field"><div class="dv-label">Lat Deg</div><input class="dv-input mono" id="nf-latdeg" type="number" placeholder="°"></div>' +
            '<div class="dv-field"><div class="dv-label">Lat Min</div><input class="dv-input mono" id="nf-latmin" type="number" placeholder="\'"></div>' +
            '<div class="dv-field"><div class="dv-label">Lat Dir</div>' +
              '<select class="dv-input mono" id="nf-latdir"><option value="N">N</option><option value="S">S</option><option value="E">E</option><option value="W">W</option></select>' +
            '</div>' +
          '</div>' +
          '<div class="dv-row col1">' +
            '<div class="dv-field"><div class="dv-label req">Location Code</div><input class="dv-input" id="nf-loccode" placeholder="e.g. ACGP"></div>' +
          '</div>' +
        '</div>' +
        // Report Content
        '<div class="dv-section">' +
          '<div class="dv-section-head"><div class="dv-section-title">Report Content</div></div>' +
          '<div class="dv-row col1">' +
            '<div class="dv-field"><div class="dv-label req">Short Report (sent to WhatsApp)</div><input class="dv-input" id="nf-msg" placeholder="One-line summary"></div>' +
          '</div>' +
          '<div class="dv-row col1">' +
            '<div class="dv-field"><div class="dv-label">Description</div><textarea class="dv-input" id="nf-desc" style="min-height:80px;resize:vertical;" placeholder="What happened? Impact, context…"></textarea></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="comment-bar">' +
        '<button class="btn btn-ghost" id="nf-cancel">Cancel</button>' +
        '<button class="btn btn-primary" id="nf-submit">Create Incident</button>' +
      '</div>';

    document.getElementById('nf-submit').addEventListener('click', submitReport);
    document.getElementById('nf-cancel').addEventListener('click', function(){
      selectedId = null;
      renderList();
      document.getElementById('detail-panel').innerHTML =
        '<div class="empty">' +
          '<div style="font-size:40px;opacity:.2;">⌖</div>' +
          '<div style="font-size:14px;font-weight:600;">Select an incident</div>' +
          '<div style="font-size:12px;margin-top:2px;">or create one with + New Incident</div>' +
        '</div>';
    });
    document.getElementById('nf-title').focus();
  }

  function submitReport() {
    var title = document.getElementById('nf-title').value.trim();
    if (!title) { document.getElementById('nf-title').focus(); return; }
    var body = {
      title: title,
      incidentType: document.getElementById('nf-type').value.trim() || 'General',
      nature: document.getElementById('nf-nature').value.trim() || 'Unspecified',
      severity: document.getElementById('nf-sev').value,
      priority: document.getElementById('nf-pri').value,
      sector: document.getElementById('nf-sector').value.trim(),
      latDeg: document.getElementById('nf-latdeg').value.trim(),
      latMin: document.getElementById('nf-latmin').value.trim(),
      latDir: document.getElementById('nf-latdir').value,
      locationCode: document.getElementById('nf-loccode').value.trim(),
      reportedBy: document.getElementById('nf-reportedby').value.trim() || 'Dashboard Operator',
      assignee: document.getElementById('nf-assignee').value.trim(),
      description: document.getElementById('nf-desc').value.trim(),
      message: document.getElementById('nf-msg').value.trim() || title,
      user: 'dashboard'
    };
    fetch('/api/report', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    }).then(function(res){ return res.json(); }).then(function(data){
      load();
      selectedId = String(data.report.id);
      activeTab = 'incident';
      renderList();
      renderDetail(data.report);
    });
  }

  load();
  setInterval(load, 8000);
})();
</script>

</body>
</html>`;

app.get('/dashboard', (req, res) => res.send(DASHBOARD_HTML));

/* =========================
   START SERVER
========================= */
app.listen(port, () => {
  console.log('Server running on port ' + port);
  console.log('Dashboard: http://localhost:' + port + '/dashboard');
});
