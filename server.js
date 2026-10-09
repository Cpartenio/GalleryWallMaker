// Gallery Wall Maker — tiny zero-dependency server.
// Serves ./public and proxies frame-erasing requests to the OpenAI image edit API
// so the API key never reaches the browser.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
const QUALITY = env.openAIImageQuality || 'medium';
const PORT = Number(env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');

const PROMPT =
  'Remove every picture frame, artwork and photo inside the transparent masked areas. ' +
  'Fill those areas with the plain, empty painted wall so it looks like nothing was ever hung there. ' +
  'Match the surrounding wall paint color, lighting gradients, shadows and texture exactly. ' +
  'Do not add any new objects, frames, nails, marks or text. Leave everything outside the mask unchanged.';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
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

const dataUrlToBuffer = (u) => Buffer.from(String(u).split(',')[1] || '', 'base64');

async function openAIEdit(model, image, mask, size) {
  const fd = new FormData();
  fd.append('model', model);
  fd.append('image', new Blob([image], { type: 'image/png' }), 'wall.png');
  fd.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
  fd.append('prompt', PROMPT);
  fd.append('size', size);
  fd.append('quality', QUALITY);
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
  const { image, mask, size } = JSON.parse((await readBody(req)).toString('utf8'));
  const allowed = ['1024x1024', '1536x1024', '1024x1536'];
  const imgBuf = dataUrlToBuffer(image);
  const maskBuf = dataUrlToBuffer(mask);
  const sz = allowed.includes(size) ? size : 'auto';

  let out = await openAIEdit(MODEL, imgBuf, maskBuf, sz);
  // If the configured model isn't available on this account, fall back once.
  if (!out.ok && MODEL !== FALLBACK_MODEL && /model/i.test(out.json?.error?.message || '')) {
    console.warn(`Model ${MODEL} failed (${out.json.error.message}); retrying with ${FALLBACK_MODEL}`);
    out = await openAIEdit(FALLBACK_MODEL, imgBuf, maskBuf, sz);
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
    send(res, 200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { ai: !!API_KEY, model: MODEL });
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
  console.log(API_KEY ? `  AI erase: on (${MODEL}, ${QUALITY})\n` : '  AI erase: OFF — add openAIAPIKey to .env (quick fill will be used)\n');
});
