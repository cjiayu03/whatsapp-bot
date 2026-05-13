const express = require('express');
const app = express();

app.use(express.json());

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// store messages in memory
let messages = [];

/* =========================
   VERIFY WEBHOOK (Meta)
========================= */
app.get('/', (req, res) => {
  const {
    'hub.mode': mode,
    'hub.challenge': challenge,
    'hub.verify_token': token
  } = req.query;

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('WEBHOOK VERIFIED');
    return res.status(200).send(challenge);
  }

  res.status(403).end();
});

/* =========================
   RECEIVE MESSAGES
========================= */
app.post('/', (req, res) => {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

  console.log(`\nWebhook received ${timestamp}\n`);
  console.log(JSON.stringify(req.body, null, 2));

  // extract message safely
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];

  if (message) {
    const data = {
      time: timestamp,
      from: message.from,
      text: message.text?.body || '[non-text message]'
    };

    messages.unshift(data);

    // keep last 100 messages
    messages = messages.slice(0, 100);
  }

  res.status(200).end();
});

/* =========================
   LIVE DASHBOARD
========================= */
app.get('/dashboard', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>WhatsApp Dashboard</title>
        <meta http-equiv="refresh" content="2">
        <style>
          body { font-family: Arial; background:#111; color:#fff; padding:20px; }
          .msg { padding:10px; border-bottom:1px solid #333; }
          .from { color:#4ade80; font-weight:bold; }
          .time { color:#888; font-size:12px; }
        </style>
      </head>
      <body>
        <h2>📩 WhatsApp Live Messages</h2>

        ${messages.map(m => `
          <div class="msg">
            <div class="from">From: ${m.from}</div>
            <div>${m.text}</div>
            <div class="time">${m.time}</div>
          </div>
        `).join('')}

      </body>
    </html>
  `);
});

/* =========================
   START SERVER
========================= */
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
