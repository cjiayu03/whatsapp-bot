const express = require('express');
const axios = require('axios');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

/* =========================
   MEMORY STORE (simple DB)
========================= */
let messages = [];
let incidents = [];

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

  res.sendStatus(403);
});

/* =========================
   RECEIVE WHATSAPP MESSAGES
========================= */
app.post('/', (req, res) => {
  console.log("🔥 WEBHOOK HIT");

  const timestamp = new Date()
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  if (message) {
    messages.unshift({
      time: timestamp,
      from: message.from,
      text: message.text?.body || "[non-text]"
    });

    messages = messages.slice(0, 100);
  }

  res.sendStatus(200);
});

/* =========================
   CREATE INCIDENT
========================= */
app.post('/incident', async (req, res) => {
  const { title, description, severity } = req.body;

  if (!title) return res.redirect('/dashboard');

  const incident = {
    id: Date.now(),
    title,
    description,
    severity: severity || "low",
    status: "OPEN",
    time: new Date().toISOString()
  };

  incidents.unshift(incident);

  // WhatsApp alert
  await sendWhatsAppMessage(
    `🚨 NEW INCIDENT\n\n` +
    `Title: ${title}\n` +
    `Severity: ${incident.severity.toUpperCase()}\n\n` +
    `${description || ""}`
  );

  res.redirect('/dashboard');
});

/* =========================
   UPDATE INCIDENT STATUS
========================= */
app.post('/incident/update', (req, res) => {
  const { id, status } = req.body;

  const inc = incidents.find(i => i.id == id);
  if (inc) inc.status = status;

  res.redirect('/dashboard');
});

/* =========================
   SEND MANUAL UPDATE
========================= */
app.post('/send-update', async (req, res) => {
  const message = req.body.message;

  if (!message) return res.redirect('/dashboard');

  await sendWhatsAppMessage(`📢 UPDATE\n\n${message}`);

  res.redirect('/dashboard');
});

/* =========================
   DASHBOARD UI
========================= */
app.get('/dashboard', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Incident Dashboard</title>
  <style>
    body { margin:0; font-family:Arial; background:#0f172a; color:white; }
    .header { padding:20px; background:#111827; }
    .container { max-width:1000px; margin:auto; padding:20px; }

    .card {
      background:#111827;
      padding:15px;
      border-radius:12px;
      margin-bottom:15px;
    }

    textarea, input, select {
      width:100%;
      padding:10px;
      margin-top:10px;
      border-radius:8px;
      border:none;
    }

    button {
      margin-top:10px;
      padding:10px 15px;
      border:none;
      border-radius:8px;
      background:#22c55e;
      color:white;
      cursor:pointer;
    }

    .row { display:flex; gap:10px; }
    .badge { padding:4px 8px; border-radius:6px; font-size:12px; }
  </style>
</head>

<body>

<div class="header">
  <h2>🚨 Incident Management Dashboard</h2>
</div>

<div class="container">

  <!-- INCIDENT FORM -->
  <div class="card">
    <h3>Create Incident</h3>

    <form method="POST" action="/incident">

      <input name="title" placeholder="Incident title" required />

      <textarea name="description" placeholder="Description"></textarea>

      <select name="severity">
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="critical">Critical</option>
      </select>

      <button>Create Incident</button>
    </form>
  </div>

  <!-- INCIDENT LIST -->
  <h3>Active Incidents</h3>

  ${incidents.map(i => `
    <div class="card">

      <div class="row" style="justify-content:space-between;">
        <b>${i.title}</b>

        <span class="badge"
          style="background:${
            i.severity === 'critical' ? '#dc2626' :
            i.severity === 'medium' ? '#f59e0b' : '#22c55e'
          }">
          ${i.severity.toUpperCase()}
        </span>
      </div>

      <p>${i.description || ""}</p>

      <p>Status: <b>${i.status}</b></p>

      <form method="POST" action="/incident/update">
        <input type="hidden" name="id" value="${i.id}" />

        <button name="status" value="INVESTIGATING">Investigating</button>
        <button name="status" value="RESOLVED">Resolve</button>
      </form>

    </div>
  `).join('')}

  <!-- WHATSAPP UPDATE -->
  <div class="card">
    <h3>Send WhatsApp Update</h3>

    <form method="POST" action="/send-update">
      <textarea name="message" placeholder="Type update..."></textarea>
      <button>Send</button>
    </form>
  </div>

  <!-- INCOMING MESSAGES -->
  <h3>Incoming WhatsApp Logs</h3>

  ${messages.map(m => `
    <div class="card">
      <b>${m.from}</b>
      <p>${m.text}</p>
      <small>${m.time}</small>
    </div>
  `).join('')}

</div>

</body>
</html>
  `);
});

/* =========================
   START SERVER
========================= */
app.listen(port, () => {
  console.log("Server running on port", port);
});
