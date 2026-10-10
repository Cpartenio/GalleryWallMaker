// Firebase Cloud Function for the backup eraser (see fill.js). Deployed with `firebase deploy`;
// Hosting rewrites /api/fill here. Scales to zero, so it only costs money while erasing.
const { onRequest } = require('firebase-functions/v2/https');
const { fillRequest } = require('./fill');

exports.fill = onRequest(
  { region: 'us-central1', memory: '2GiB', cpu: 2, timeoutSeconds: 60, concurrency: 1, maxInstances: 5 },
  async (req, res) => {
    if (req.method !== 'POST') return res.status(405).send('POST only');
    const out = await fillRequest({ query: req.query, body: req.rawBody, ip: req.ip });
    res.status(out.status).type(out.type || 'text/plain').send(out.body);
  },
);
