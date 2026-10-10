// Backup eraser: runs the same MI-GAN model as the browser, on the server, for devices that
// can't run it themselves (e.g. iPhones that run out of memory). Shared by server.js and the
// Firebase Cloud Function in index.js.
//
// Request:  POST /api/fill?w=<width>&h=<height>
//           body = RGB bytes, planar (w*h red, then green, then blue), then w*h mask bytes
//           (0 = fill this pixel, 255 = keep). The browser does all image decoding/encoding.
// Response: the filled RGB bytes in the same planar layout (application/octet-stream).
const path = require('node:path');
const fs = require('node:fs');

const MAX_SIDE = 1536;
const RATE = { windowMs: 60 * 60 * 1000, max: 40 }; // per visitor per hour (per server instance)

let sessionPromise = null;
let queue = Promise.resolve();
const hits = new Map();

function modelPath() {
  const candidates = [
    path.join(__dirname, 'migan_pipeline_v2.onnx'),                   // Firebase: copied in at deploy
    path.join(__dirname, '..', 'public', 'models', 'migan_pipeline_v2.onnx'), // local / Render
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function getSession() {
  sessionPromise ||= (async () => {
    const ort = require('onnxruntime-node');
    const p = modelPath();
    if (!p) throw new Error('Model file not found');
    return { ort, session: await ort.InferenceSession.create(p) };
  })();
  sessionPromise.catch(() => { sessionPromise = null; });
  return sessionPromise;
}

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= RATE.max) { hits.set(ip, list); return true; }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10000) hits.clear(); // keep memory bounded
  return false;
}

// Returns { status, body, type }. `body` is the raw request body (Buffer).
async function fillRequest({ query, body, ip }) {
  const w = parseInt(query.w, 10), h = parseInt(query.h, 10);
  if (!(w > 0 && h > 0 && w <= MAX_SIDE && h <= MAX_SIDE)) return { status: 400, body: 'Bad size' };
  const n = w * h;
  if (!body || body.length !== n * 4) return { status: 400, body: 'Bad body length' };
  if (rateLimited(ip || 'unknown')) return { status: 429, body: 'Too many erases, try again later' };

  const run = async () => {
    const { ort, session } = await getSession();
    const image = new Uint8Array(body.buffer, body.byteOffset, n * 3);
    const mask = new Uint8Array(body.buffer, body.byteOffset + n * 3, n);
    const out = await session.run({
      image: new ort.Tensor('uint8', image, [1, 3, h, w]),
      mask: new ort.Tensor('uint8', mask, [1, 1, h, w]),
    });
    return Buffer.from(out.result.data.buffer, out.result.data.byteOffset, out.result.data.byteLength);
  };
  // One at a time per instance: keeps memory predictable on small servers.
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return { status: 200, body: await result, type: 'application/octet-stream' };
}

module.exports = { fillRequest, getSession };
