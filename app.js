const express = require('express');
const axios = require('axios');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 3000;
const verifyToken = process.env.VERIFY_TOKEN;

// store logs/messages
let messages = [];

/* =========================
   SEND WHATSAPP MESSAGE
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

    console.log("Message sent:", response.data);

  } catch (err) {
    console.error(
      err.response?.data || err.message
    );
  }
}

/* =========================
   WEBHOOK VERIFICATION
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
   RECEIVE WHATSAPP WEBHOOK
========================= */
app.post('/', (req, res) => {

  const timestamp = new Date()
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  console.log(`Webhook received ${timestamp}`);

  console.log(JSON.stringify(req.body, null, 2));

  const value =
    req.body?.entry?.[0]?.changes?.[0]?.value;

  const message =
    value?.messages?.[0];

  if (message) {

    const data = {
      time: timestamp,
      from: message.from,
      text: message.text?.body || '[non-text message]'
    };

    messages.unshift(data);

    // keep latest 100 logs
    messages = messages.slice(0, 100);
  }

  res.status(200).end();
});

/* =========================
   DASHBOARD UI
========================= */
app.get('/dashboard', (req, res) => {

  res.send(`
    <!DOCTYPE html>
    <html>

    <head>
      <title>WhatsApp Dashboard</title>

      <style>

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: Arial, sans-serif;
          background: #0f172a;
          color: white;
        }

        .header {
          padding: 20px;
          background: #111827;
          border-bottom: 1px solid #1f2937;
        }

        .title {
          font-size: 28px;
          font-weight: bold;
        }

        .subtitle {
          color: #94a3b8;
          margin-top: 5px;
        }

        .container {
          max-width: 1000px;
          margin: auto;
          padding: 20px;
        }

        .form {
          background: #111827;
          border: 1px solid #1e293b;
          border-radius: 14px;
          padding: 20px;
          margin-bottom: 30px;
        }

        textarea {
          width: 100%;
          height: 120px;
          padding: 14px;
          border-radius: 10px;
          border: none;
          resize: vertical;
          font-size: 15px;
          margin-top: 10px;
        }

        button {
          margin-top: 12px;
          background: #22c55e;
          color: white;
          border: none;
          padding: 12px 20px;
          border-radius: 10px;
          cursor: pointer;
          font-size: 15px;
        }

        button:hover {
          opacity: 0.9;
        }

        .card {
          background: #111827;
          border: 1px solid #1e293b;
          border-radius: 14px;
          padding: 16px;
          margin-bottom: 16px;
        }

        .top {
          display: flex;
          justify-content: space-between;
          margin-bottom: 10px;
        }

        .from {
          color: #4ade80;
          font-weight: bold;
        }

        .time {
          color: #94a3b8;
          font-size: 12px;
        }

        .msg {
          line-height: 1.5;
        }

      </style>
    </head>

    <body>

      <div class="header">
        <div class="title">
          📢 WhatsApp Admin Dashboard
        </div>

        <div class="subtitle">
          Live updates every 2 seconds
        </div>
      </div>

      <div class="container">

        <div class="form">

          <form method="POST" action="/send-update">

            <label>
              Send WhatsApp Update
            </label>

            <textarea
              name="message"
              placeholder="Type latest update..."
            ></textarea>

            <br/>

            <button type="submit">
              Send Update
            </button>

          </form>

        </div>

        <h2>📩 Incoming Logs</h2>

        ${messages.map(m => `
          <div class="card">

            <div class="top">
              <div class="from">
                ${m.from}
              </div>

              <div class="time">
                ${m.time}
              </div>
            </div>

            <div class="msg">
              ${m.text}
            </div>

          </div>
        `).join('')}

      </div>

    </body>

    </html>
  `);
});

/* =========================
   SEND UPDATE ROUTE
========================= */
app.post('/send-update', async (req, res) => {

  const message = req.body.message;

  if (!message) {
    return res.redirect('/dashboard');
  }

  await sendWhatsAppMessage(
    `📢 Latest Update:\n\n${message}`
  );

  res.redirect('/dashboard');
});

/* =========================
   START SERVER
========================= */
app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
