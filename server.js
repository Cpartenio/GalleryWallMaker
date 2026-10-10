// Gallery Wall Maker — tiny zero-dependency server.
// Serves ./public and proxies frame-erasing requests to the OpenAI image edit API
// so the API key never reaches the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { fillRequest } = require('./functions/fill');
const { suggestRequest } = require('./functions/suggest');

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const env = { ...loadEnv(path.join(__dirname, '.env')), ...process.env };
const API_KEY = env.openAIAPIKey || env.OPENAI_API_KEY || '';
const MODEL = env.openAIImageModel || 'gpt-image-1.5';
const FALLBACK_MODEL = 'gpt-image-1';
const QUALITY = env.openAIImageQuality || 'high';
const PORT = Number(env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const APP_PASSWORD = env.appPassword || env.APP_PASSWORD || '';

// The whole photo is regenerated as an empty wall (not just patched holes), so lighting and
// texture stay continuous. The mask only points at what to remove.
function erasePrompt(hasSheet) {
  const what = 'every framed picture, artwork, print, poster and photo hanging on the wall' +
    (hasSheet ? ', and the printed paper sheet taped to the wall' : '');
  return [
    `Recreate this exact photo of the room, but remove ${what}, as if nothing had ever been hung there.`,
    'The transparent areas of the mask show where those items are.',
    'The wall must be one continuous, empty, freshly painted surface: same paint color and texture,',
    'with the room\'s natural lighting (lamp glow, light falloff and soft shadows) flowing smoothly across',
    'where the items were. No outlines, ghost marks, frame shadows, nail holes, patches or color shifts.',
    'Keep everything else identical: same camera position, framing, perspective and lens,',
    'same furniture, lamp, pillows, doors, trim, ceiling and floor, same colors and exposure.',
    'Do not add anything new.',
  ].join(' ');
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.pdf': 'application/pdf',
};

function send(res, code, body, type = 'application/json', cache = 'no-store') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Upload too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Optional site-wide password (HTTP Basic Auth, any username) so a public URL
// can't be used to spend your OpenAI credits.
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || '');
  if (!m) return false;
  const given = Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

const dataUrlToBuffer = (u) => Buffer.from(String(u).split(',')[1] || '', 'base64');

async function openAIEdit(model, image, mask, size, prompt, fidelity) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('image', new Blob([image], { type: 'image/png' }), 'wall.png');
  fd.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
  fd.append('prompt', prompt);
  fd.append('size', size);
  fd.append('quality', QUALITY);
  if (fidelity) fd.append('input_fidelity', 'high'); // keep the room itself as close to the photo as possible
  fd.append('n', '1');
  const r = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: fd,
  });
  const json = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, json };
}

async function handleErase(req, res) {
  if (!API_KEY) return send(res, 503, { error: 'No OpenAI key. Add openAIAPIKey=... to .env' });
  const { image, mask, size, hasSheet } = JSON.parse((await readBody(req)).toString('utf8'));
  const allowed = ['1024x1024', '1536x1024', '1024x1536'];
  const imgBuf = dataUrlToBuffer(image);
  const maskBuf = dataUrlToBuffer(mask);
  const sz = allowed.includes(size) ? size : 'auto';

  const prompt = erasePrompt(!!hasSheet);
  const errMsg = (o) => o.json?.error?.message || '';
  let model = MODEL, fidelity = true;
  let out = await openAIEdit(model, imgBuf, maskBuf, sz, prompt, fidelity);
  // Not every model takes input_fidelity; drop it rather than fail.
  if (!out.ok && /input_fidelity/i.test(errMsg(out))) {
    fidelity = false;
    out = await openAIEdit(model, imgBuf, maskBuf, sz, prompt, fidelity);
  }
  // If the configured model isn't available on this account, fall back once.
  if (!out.ok && model !== FALLBACK_MODEL && /model/i.test(errMsg(out))) {
    console.warn(`Model ${model} failed (${errMsg(out)}); retrying with ${FALLBACK_MODEL}`);
    model = FALLBACK_MODEL;
    out = await openAIEdit(model, imgBuf, maskBuf, sz, prompt, fidelity);
    if (!out.ok && /input_fidelity/i.test(errMsg(out))) out = await openAIEdit(model, imgBuf, maskBuf, sz, prompt, false);
  }
  if (!out.ok) {
    const msg = out.json?.error?.message || `OpenAI error ${out.status}`;
    console.error('OpenAI edit failed:', msg);
    return send(res, 502, { error: msg });
  }
  const b64 = out.json?.data?.[0]?.b64_json;
  if (!b64) return send(res, 502, { error: 'OpenAI returned no image' });
  send(res, 200, { image: `data:image/png;base64,${b64}` });
}

function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    // The AI model and libraries are large and never change in place: let browsers keep them.
    const longCache = /^\/(models|vendor)\//.test(p) ? 'public, max-age=31536000, immutable' : 'no-store';
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', longCache);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (!authorized(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Gallery Wall Maker", charset="UTF-8"' });
      return res.end('Password required');
    }
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ai: !!API_KEY, model: MODEL, fill: true });
    if (req.method === 'POST' && req.url === '/api/suggest') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
      const out = await suggestRequest(body);
      return send(res, out.status, out.body);
    }
    if (req.method === 'POST' && req.url.startsWith('/api/fill')) {
      const u = new URL(req.url, 'http://x');
      const out = await fillRequest({
        query: Object.fromEntries(u.searchParams), body: await readBody(req, 20 * 1024 * 1024),
        ip: req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress,
      });
      return send(res, out.status, out.body, out.type || 'text/plain');
    }
    if (req.method === 'POST' && req.url === '/api/erase') return await handleErase(req, res);
    if (req.method === 'GET') return serveStatic(req, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: e.message || 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nGallery Wall Maker running:`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  On your iPad:      http://${n.address}:${PORT}`);
    }
  }
  if (!APP_PASSWORD) console.log('  Password: none (set appPassword before putting this on the internet)');
  console.log(API_KEY ? `  AI erase: on (${MODEL}, ${QUALITY})\n` : '  AI erase: OFF — add openAIAPIKey to .env (quick fill will be used)\n');
});
