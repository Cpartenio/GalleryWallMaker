'use strict';
// Gallery Wall Maker — single-canvas iPad-first app.
// Steps: start → straighten (optional keystone fix) → mark frames → arrange (+ add pictures).
// All geometry is stored in image pixels of the current wall image; the view just fits it on screen.

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const ctx = stage.getContext('2d');
const fileInput = $('#file');

const MAX_WALL = 2048;   // longest side of the working wall photo
const MAX_PIECE = 1400;  // longest side of an added picture
const HANDLE = 15;       // handle radius in screen px
const HIT = 32;          // touch hit radius in screen px

const S = {
  step: 'start',
  ai: false,
  raw: null,        // downscaled original photo (canvas)
  photo: null,      // straightened photo (canvas)
  quad: null,       // straighten quad on raw [TL, TR, BR, BL]
  boxes: [],        // frames marked on photo {x,y,w,h}
  sel: -1,          // selected box index
  clean: null,      // wall with frames erased (canvas)
  pieces: [],       // {id, img, x, y, w, h, original, locked}
  piece: null,      // selected piece
  pxPerInch: null,
  before: false,
  add: null,        // {img, quad} while adding a new picture
  guides: [],
};

let view = { s: 1, ox: 0, oy: 0 };
let drag = null;
let loupe = null;
let nextId = 1;

// ---------- small helpers ----------
function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function copyCanvas(src) {
  const c = mkCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not open that image'));
    img.src = src;
  });
}
async function imageToCanvas(src, maxSide) {
  const img = await loadImage(src);
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = mkCanvas(img.naturalWidth * k, img.naturalHeight * k);
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function pickFile() {
  return new Promise((resolve) => {
    fileInput.value = '';
    fileInput.onchange = () => resolve(fileInput.files[0] || null);
    fileInput.click();
  });
}
async function fileToCanvas(file, maxSide) {
  const url = URL.createObjectURL(file);
  try { return await imageToCanvas(url, maxSide); } finally { URL.revokeObjectURL(url); }
}

function busy(text) {
  $('#busyText').textContent = text;
  $('#busy').hidden = !text;
}
let toastTimer;
function toast(text, ms = 3500) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- perspective math ----------
// Homography mapping 4 src points to 4 dst points (8x8 linear solve).
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i], { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1];
}
function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return { x: (H[0] * x + H[1] * y + H[2]) / w, y: (H[3] * x + H[4] * y + H[5]) / w, w };
}
// Render an output canvas where output pixel (x,y) ↦ dst point (ox + x/k, oy + y/k) ↦ src via Hinv.
function warp(src, Hinv, outW, outH, ox = 0, oy = 0, k = 1) {
  const sw = src.width, sh = src.height;
  const sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
  const out = mkCanvas(outW, outH);
  const og = out.getContext('2d');
  const id = og.createImageData(out.width, out.height);
  const o = id.data;
  const [a, b, c, d, e, f, g, h, i] = Hinv;
  let p = 0;
  for (let y = 0; y < out.height; y++) {
    const dy = oy + (y + 0.5) / k;
    for (let x = 0; x < out.width; x++, p += 4) {
      const dx = ox + (x + 0.5) / k;
      const w = g * dx + h * dy + i;
      const sx = clamp((a * dx + b * dy + c) / w - 0.5, 0, sw - 1.001);
      const sy = clamp((d * dx + e * dy + f) / w - 0.5, 0, sh - 1.001);
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * fx;
        const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * fx;
        o[p + ch] = top + (bot - top) * fy;
      }
      o[p + 3] = 255;
    }
  }
  og.putImageData(id, 0, 0);
  return out;
}
function quadSize(q) {
  return {
    w: (dist(q[0], q[1]) + dist(q[3], q[2])) / 2,
    h: (dist(q[0], q[3]) + dist(q[1], q[2])) / 2,
  };
}
function rectPts(x, y, w, h) {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}
function defaultQuad(img, inset) {
  const dx = img.width * inset, dy = img.height * inset;
  return rectPts(dx, dy, img.width - 2 * dx, img.height - 2 * dy);
}

// Straighten the whole photo so the chosen quad becomes a true rectangle.
function straightenPhoto(src, q) {
  const { w, h } = quadSize(q);
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4;
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const rect = rectPts(cx - w / 2, cy - h / 2, w, h);
  const H = homography(q, rect), Hinv = homography(rect, q);
  if (!H || !Hinv) return null;
  const c = rectPts(0, 0, src.width, src.height).map((p) => applyH(H, p.x, p.y));
  if (c.some((p) => p.w <= 0)) return null;
  // Largest axis-aligned rectangle inside the warped photo (keeps no empty corners).
  const left = Math.max(c[0].x, c[3].x), right = Math.min(c[1].x, c[2].x);
  const top = Math.max(c[0].y, c[1].y), bottom = Math.min(c[3].y, c[2].y);
  const cw = right - left, ch = bottom - top;
  if (!(cw > 100 && ch > 100) || cw > src.width * 4 || ch > src.height * 4) return null;
  const k = Math.min(1, MAX_WALL / Math.max(cw, ch));
  return warp(src, Hinv, cw * k, ch * k, left, top, k);
}
// Cut a quad out of an image into a flat rectangle.
function extractQuad(src, q) {
  let { w, h } = quadSize(q);
  const k = Math.min(1, MAX_PIECE / Math.max(w, h));
  w *= k; h *= k;
  const Hinv = homography(rectPts(0, 0, w, h), q);
  if (!Hinv || w < 4 || h < 4) return null;
  return warp(src, Hinv, w, h);
}

// ---------- erasing frames ----------
function expandBox(b, pad, W, H) {
  const x0 = clamp(Math.floor(b.x - pad), 0, W), y0 = clamp(Math.floor(b.y - pad), 0, H);
  const x1 = clamp(Math.ceil(b.x + b.w + pad), 0, W), y1 = clamp(Math.ceil(b.y + b.h + pad), 0, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
function apiSize(w, h) {
  const r = w / h;
  if (r > 1.2) return [1536, 1024];
  if (r < 0.83) return [1024, 1536];
  return [1024, 1024];
}
async function aiFill(photo, regions) {
  const [aw, ah] = apiSize(photo.width, photo.height);
  const kx = aw / photo.width, ky = ah / photo.height;
  const img = mkCanvas(aw, ah);
  img.getContext('2d').drawImage(photo, 0, 0, aw, ah);
  const mask = mkCanvas(aw, ah);
  const mg = mask.getContext('2d');
  mg.fillStyle = '#000';
  mg.fillRect(0, 0, aw, ah);
  for (const r of regions) mg.clearRect(r.x * kx - 2, r.y * ky - 2, r.w * kx + 4, r.h * ky + 4);
  const res = await fetch('api/erase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: img.toDataURL('image/png'), mask: mask.toDataURL('image/png'), size: `${aw}x${ah}` }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.image) throw new Error(json.error || `Server error ${res.status}`);
  const gen = await loadImage(json.image);
  const full = mkCanvas(photo.width, photo.height);
  const g = full.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(gen, 0, 0, full.width, full.height);
  return full;
}
function ringMean(data, W, H, r, t) {
  const sum = [0, 0, 0];
  let n = 0;
  const x0 = Math.max(0, r.x - t), x1 = Math.min(W, r.x + r.w + t);
  const y0 = Math.max(0, r.y - t), y1 = Math.min(H, r.y + r.h + t);
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
      const i = (y * W + x) * 4;
      sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; n++;
    }
  }
  return n ? sum.map((v) => v / n) : null;
}
// Paste AI pixels into the padded regions only, colour-matched and feathered.
function blendRegions(out, gen, regions, feather) {
  const W = out.width, H = out.height;
  const og = out.getContext('2d');
  const od = og.getImageData(0, 0, W, H);
  const o = od.data;
  const gd = gen.getContext('2d').getImageData(0, 0, W, H).data;
  const orig = new Uint8ClampedArray(o);
  for (const r of regions) {
    const mo = ringMean(orig, W, H, r, Math.max(6, feather));
    const mg = ringMean(gd, W, H, r, Math.max(6, feather));
    const delta = mo && mg ? [mo[0] - mg[0], mo[1] - mg[1], mo[2] - mg[2]] : [0, 0, 0];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const edge = Math.min(x - r.x, r.x + r.w - 1 - x, y - r.y, r.y + r.h - 1 - y);
        const a = feather > 0 ? clamp(edge / feather, 0, 1) : 1;
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) o[i + c] = orig[i + c] * (1 - a) + (gd[i + c] + delta[c]) * a;
      }
    }
  }
  og.putImageData(od, 0, 0);
}
// No-AI fallback: smooth Coons-patch fill from the wall just outside each box.
function quickFill(out, regions) {
  const W = out.width, H = out.height;
  const og = out.getContext('2d');
  const od = og.getImageData(0, 0, W, H);
  const o = od.data;
  const px = (x, y) => { const i = (clamp(y, 0, H - 1) * W + clamp(x, 0, W - 1)) * 4; return [o[i], o[i + 1], o[i + 2]]; };
  const strip = (n, at) => {
    const raw = [];
    for (let k = 0; k < n; k++) {
      const s = [0, 0, 0];
      for (let d = 1; d <= 4; d++) { const p = at(k, d); s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
      raw.push(s.map((v) => v / 4));
    }
    const R = 6; // blur along the edge to avoid streaks
    return raw.map((_, k) => {
      const s = [0, 0, 0]; let n2 = 0;
      for (let j = Math.max(0, k - R); j <= Math.min(raw.length - 1, k + R); j++) { s[0] += raw[j][0]; s[1] += raw[j][1]; s[2] += raw[j][2]; n2++; }
      return s.map((v) => v / n2);
    });
  };
  for (const r of regions) {
    const hasT = r.y > 4, hasB = r.y + r.h < H - 4, hasL = r.x > 4, hasR = r.x + r.w < W - 4;
    let T = strip(r.w, (k, d) => px(r.x + k, r.y - d));
    let B = strip(r.w, (k, d) => px(r.x + k, r.y + r.h - 1 + d));
    let L = strip(r.h, (k, d) => px(r.x - d, r.y + k));
    let Rr = strip(r.h, (k, d) => px(r.x + r.w - 1 + d, r.y + k));
    if (!hasT && hasB) T = B; if (!hasB && hasT) B = T;
    if (!hasL && hasR) L = Rr; if (!hasR && hasL) Rr = L;
    const c00 = T[0], c10 = T[r.w - 1], c01 = B[0], c11 = B[r.w - 1];
    for (let y = 0; y < r.h; y++) {
      const v = r.h > 1 ? y / (r.h - 1) : 0;
      for (let x = 0; x < r.w; x++) {
        const u = r.w > 1 ? x / (r.w - 1) : 0;
        const i = ((r.y + y) * W + r.x + x) * 4;
        const noise = (Math.random() - 0.5) * 3;
        for (let c = 0; c < 3; c++) {
          o[i + c] = (1 - v) * T[x][c] + v * B[x][c] + (1 - u) * L[y][c] + u * Rr[y][c]
            - ((1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c] + (1 - u) * v * c01[c] + u * v * c11[c]) + noise;
        }
      }
    }
  }
  og.putImageData(od, 0, 0);
}

async function eraseFrames() {
  const photo = S.photo, W = photo.width, H = photo.height;
  const pad = Math.round(Math.max(W, H) * 0.012);
  const regions = S.boxes.map((b) => expandBox(b, pad, W, H)).filter((r) => r.w > 2 && r.h > 2);
  const out = copyCanvas(photo);
  let usedAI = false;
  if (regions.length && S.ai) {
    busy('Erasing frames with AI…\nthis can take 30–60 seconds');
    try {
      const gen = await aiFill(photo, regions);
      blendRegions(out, gen, regions, Math.round(pad * 0.8));
      usedAI = true;
    } catch (e) {
      console.error(e);
      toast(`AI erase failed (${e.message}). Used quick fill instead.`, 6000);
    }
  }
  if (regions.length && !usedAI) {
    busy('Filling in the wall…');
    await nextFrame();
    quickFill(out, regions);
  }
  S.clean = out;
  S.pieces = S.boxes.map((b) => {
    const r = expandBox(b, 0, W, H);
    const img = mkCanvas(r.w, r.h);
    img.getContext('2d').drawImage(photo, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    return { id: nextId++, img, x: r.x, y: r.y, w: r.w, h: r.h, original: true, locked: true };
  });
  S.piece = null;
  busy('');
  if (!S.ai && regions.length) toast('Quick fill used (no AI key). Add openAIAPIKey to .env for a cleaner wall.', 5000);
  go('arrange');
  save();
}

// ---------- saving (IndexedDB, so a Safari reload doesn't lose work) ----------
const db = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('gallerywall', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const tx = d.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => res(req.result);
      tx.onerror = () => rej(tx.error);
    });
  },
  get(k) { return this.run('readonly', (s) => s.get(k)); },
  set(k, v) { return this.run('readwrite', (s) => s.put(v, k)); },
  del(k) { return this.run('readwrite', (s) => s.delete(k)); },
};
const urlOf = (c) => (c._url ||= c.toDataURL('image/jpeg', 0.92));
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!S.clean) return;
    try {
      await db.set('project', {
        photo: urlOf(S.photo), clean: urlOf(S.clean), pxPerInch: S.pxPerInch,
        pieces: S.pieces.map((p) => ({ url: urlOf(p.img), x: p.x, y: p.y, w: p.w, h: p.h, original: p.original, locked: p.locked })),
      });
    } catch (e) { console.warn('save failed', e); }
  }, 600);
}
async function resume() {
  busy('Loading your wall…');
  try {
    const p = await db.get('project');
    S.photo = await imageToCanvas(p.photo, 1e9);
    S.raw = S.photo;
    S.clean = await imageToCanvas(p.clean, 1e9);
    S.pxPerInch = p.pxPerInch || null;
    S.pieces = [];
    for (const q of p.pieces) {
      S.pieces.push({ id: nextId++, img: await imageToCanvas(q.url, 1e9), x: q.x, y: q.y, w: q.w, h: q.h, original: q.original, locked: q.locked });
    }
    S.boxes = [];
    go('arrange');
  } catch (e) {
    toast('Could not load the saved wall.');
  }
  busy('');
}

// ---------- view ----------
function currentImage() {
  if (S.step === 'straighten') return S.raw;
  if (S.step === 'mark') return S.photo;
  if (S.step === 'arrange') return S.before ? S.photo : S.clean;
  if (S.step === 'add') return S.add.img;
  return null;
}
function fitView() {
  const img = currentImage();
  if (!img) return;
  const r = stage.getBoundingClientRect();
  const m = 28;
  const s = Math.min((r.width - 2 * m) / img.width, (r.height - 2 * m) / img.height);
  view = { s, ox: (r.width - img.width * s) / 2, oy: (r.height - img.height * s) / 2 };
}
const toScreen = (p) => ({ x: view.ox + p.x * view.s, y: view.oy + p.y * view.s });
function toImg(e) {
  const r = stage.getBoundingClientRect();
  return { x: (e.clientX - r.left - view.ox) / view.s, y: (e.clientY - r.top - view.oy) / view.s };
}
function resize() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  stage.width = Math.round(r.width * dpr);
  stage.height = Math.round(r.height * dpr);
  draw();
}

// ---------- drawing ----------
function handle(p, color = '#2563eb') {
  const s = toScreen(p);
  ctx.beginPath();
  ctx.arc(s.x, s.y, HANDLE, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 3, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}
function drawImageFit(img) {
  ctx.drawImage(img, view.ox, view.oy, img.width * view.s, img.height * view.s);
}
function drawQuad(q) {
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(37,99,235,0.6)';
  for (let t = 1; t < 4; t++) {
    const a = toScreen(lerp(q[0], q[1], t / 4)), b = toScreen(lerp(q[3], q[2], t / 4));
    const c = toScreen(lerp(q[0], q[3], t / 4)), d = toScreen(lerp(q[1], q[2], t / 4));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.moveTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.stroke();
  }
  ctx.beginPath();
  q.forEach((p, i) => { const s = toScreen(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
  ctx.closePath();
  ctx.fillStyle = 'rgba(37,99,235,0.08)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#2563eb';
  ctx.stroke();
  q.forEach((p) => handle(p));
}
// Magnifier so a finger doesn't hide the corner being placed.
function drawLoupe(img, p) {
  const R = 70, Z = 3;
  const s = toScreen(p);
  const r = stage.getBoundingClientRect();
  let cx = s.x, cy = s.y - 120;
  if (cy - R < 0) cy = s.y + 120;
  cx = clamp(cx, R + 4, r.width - R - 4);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = '#000';
  ctx.fillRect(cx - R, cy - R, 2 * R, 2 * R);
  const k = view.s * Z;
  ctx.drawImage(img, cx - p.x * k, cy - p.y * k, img.width * k, img.height * k);
  ctx.strokeStyle = 'rgba(255,60,60,0.95)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}
function boxCorners(b) { return rectPts(b.x, b.y, b.w, b.h); }
function label(text, x, y, bg = '#2563eb') {
  ctx.font = '600 14px -apple-system, sans-serif';
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, 24, 6) : ctx.rect(x, y, w, 24);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + 7, y + 17);
}
function inches(px) {
  const v = px / S.pxPerInch;
  return `${Math.round(v * 4) / 4}″`.replace('.25″', '¼″').replace('.5″', '½″').replace('.75″', '¾″');
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, stage.width, stage.height);
  const img = currentImage();
  if (!img) return;
  fitView();
  ctx.imageSmoothingQuality = 'high';

  if (S.step === 'straighten' || S.step === 'add') {
    const q = S.step === 'add' ? S.add.quad : S.quad;
    drawImageFit(img);
    drawQuad(q);
    if (loupe) drawLoupe(img, loupe);
    return;
  }

  if (S.step === 'mark') {
    drawImageFit(img);
    S.boxes.forEach((b, i) => {
      const a = toScreen(b), sel = i === S.sel;
      ctx.fillStyle = sel ? 'rgba(37,99,235,0.18)' : 'rgba(234,88,12,0.18)';
      ctx.fillRect(a.x, a.y, b.w * view.s, b.h * view.s);
      ctx.lineWidth = sel ? 3 : 2.5;
      ctx.strokeStyle = sel ? '#2563eb' : '#ea580c';
      ctx.strokeRect(a.x, a.y, b.w * view.s, b.h * view.s);
      label(String(i + 1), a.x + 4, a.y + 4, sel ? '#2563eb' : '#ea580c');
    });
    if (S.sel >= 0) boxCorners(S.boxes[S.sel]).forEach((p) => handle(p));
    if (loupe) drawLoupe(img, loupe);
    return;
  }

  if (S.step === 'arrange') {
    drawImageFit(img);
    if (S.before) return;
    for (const p of S.pieces) {
      const a = toScreen(p);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = 14 * view.s * 2;
      ctx.shadowOffsetY = 5 * view.s * 2;
      ctx.drawImage(p.img, a.x, a.y, p.w * view.s, p.h * view.s);
      ctx.restore();
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#e11d8f';
    ctx.setLineDash([6, 5]);
    for (const g of S.guides) {
      ctx.beginPath();
      if (g.x != null) { const s = toScreen({ x: g.x, y: 0 }); ctx.moveTo(s.x, view.oy); ctx.lineTo(s.x, view.oy + img.height * view.s); }
      else { const s = toScreen({ x: 0, y: g.y }); ctx.moveTo(view.ox, s.y); ctx.lineTo(view.ox + img.width * view.s, s.y); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const p = S.piece;
    if (p) {
      const a = toScreen(p);
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#2563eb';
      ctx.strokeRect(a.x - 2, a.y - 2, p.w * view.s + 4, p.h * view.s + 4);
      const tag = [p.locked ? '🔒 original size' : null, S.pxPerInch ? `${inches(p.w)} × ${inches(p.h)}` : null].filter(Boolean).join('  ·  ');
      if (tag) label(tag, a.x, a.y - 30);
      if (!p.locked) handle({ x: p.x + p.w, y: p.y + p.h });
    }
  }
}

// ---------- pointer handling ----------
const pointers = new Map();
let pinch = null;

function hitHandle(points, e) {
  const r = stage.getBoundingClientRect();
  const m = { x: e.clientX - r.left, y: e.clientY - r.top };
  let best = -1, bd = HIT;
  points.forEach((p, i) => { const d = dist(toScreen(p), m); if (d < bd) { bd = d; best = i; } });
  return best;
}
const inside = (p, b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

function onDown(e) {
  const p = toImg(e);
  if (S.step === 'straighten' || S.step === 'add') {
    const q = S.step === 'add' ? S.add.quad : S.quad;
    const i = hitHandle(q, e);
    if (i >= 0) { drag = { type: 'quad', q, i, dx: q[i].x - p.x, dy: q[i].y - p.y }; loupe = q[i]; }
  } else if (S.step === 'mark') {
    if (S.sel >= 0) {
      const c = hitHandle(boxCorners(S.boxes[S.sel]), e);
      if (c >= 0) {
        const b = S.boxes[S.sel], corners = boxCorners(b);
        drag = { type: 'corner', fixed: corners[(c + 2) % 4] };
        loupe = corners[c];
        return;
      }
    }
    for (let i = S.boxes.length - 1; i >= 0; i--) {
      if (inside(p, S.boxes[i])) { S.sel = i; drag = { type: 'moveBox', start: p, orig: { ...S.boxes[i] } }; updateBar(); return; }
    }
    S.boxes.push({ x: p.x, y: p.y, w: 0, h: 0 });
    S.sel = S.boxes.length - 1;
    drag = { type: 'corner', fixed: p, isNew: true };
    updateBar();
  } else if (S.step === 'arrange' && !S.before) {
    const sp = S.piece;
    if (sp && !sp.locked && hitHandle([{ x: sp.x + sp.w, y: sp.y + sp.h }], e) === 0) {
      drag = { type: 'resize', piece: sp };
      return;
    }
    for (let i = S.pieces.length - 1; i >= 0; i--) {
      const pc = S.pieces[i];
      if (inside(p, pc)) { S.piece = pc; drag = { type: 'movePiece', piece: pc, start: p, ox: pc.x, oy: pc.y }; updateBar(); return; }
    }
    S.piece = null;
    updateBar();
  }
}

function snap(pc) {
  const th = 10 / view.s;
  const wall = S.clean;
  const xs = [], ys = [];
  for (const o of S.pieces) {
    if (o === pc) continue;
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  xs.push(wall.width / 2);
  const best = (vals, edges) => {
    let r = null;
    for (const v of vals) edges.forEach((e, k) => {
      const d = Math.abs(e - v);
      if (d < th && (!r || d < r.d)) r = { d, shift: v - e, at: v };
    });
    return r;
  };
  S.guides = [];
  const bx = best(xs, [pc.x, pc.x + pc.w / 2, pc.x + pc.w]);
  if (bx) { pc.x += bx.shift; S.guides.push({ x: bx.at }); }
  const by = best(ys, [pc.y, pc.y + pc.h / 2, pc.y + pc.h]);
  if (by) { pc.y += by.shift; S.guides.push({ y: by.at }); }
}

function onMove(e) {
  if (!drag) return;
  const p = toImg(e);
  const img = currentImage();
  const W = img.width, H = img.height;
  if (drag.type === 'quad') {
    const pt = drag.q[drag.i];
    pt.x = clamp(p.x + drag.dx, 0, W);
    pt.y = clamp(p.y + drag.dy, 0, H);
    loupe = pt;
  } else if (drag.type === 'corner') {
    const b = S.boxes[S.sel], f = drag.fixed;
    const x = clamp(p.x, 0, W), y = clamp(p.y, 0, H);
    Object.assign(b, { x: Math.min(x, f.x), y: Math.min(y, f.y), w: Math.abs(x - f.x), h: Math.abs(y - f.y) });
    loupe = { x, y };
  } else if (drag.type === 'moveBox') {
    const b = S.boxes[S.sel], o = drag.orig;
    b.x = clamp(o.x + p.x - drag.start.x, 0, W - b.w);
    b.y = clamp(o.y + p.y - drag.start.y, 0, H - b.h);
  } else if (drag.type === 'movePiece') {
    const pc = drag.piece;
    pc.x = clamp(drag.ox + p.x - drag.start.x, -pc.w / 2, W - pc.w / 2);
    pc.y = clamp(drag.oy + p.y - drag.start.y, -pc.h / 2, H - pc.h / 2);
    snap(pc);
  } else if (drag.type === 'resize') {
    const pc = drag.piece, aspect = pc.w / pc.h;
    const w = Math.max(30, p.x - pc.x, (p.y - pc.y) * aspect);
    pc.w = w; pc.h = w / aspect;
  }
  draw();
}

function onUp() {
  if (drag?.isNew) {
    const b = S.boxes[S.sel];
    if (b.w * view.s < 12 || b.h * view.s < 12) S.boxes.splice(S.sel, 1);
    S.sel = -1; // so the next box drawn nearby doesn't grab this one's corner
  }
  if (S.step === 'arrange' && drag) save();
  drag = null;
  loupe = null;
  S.guides = [];
  updateBar();
  draw();
}

stage.addEventListener('pointerdown', (e) => {
  stage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // Two fingers: pinch-resize the selected (unlocked) piece.
    const pc = S.piece;
    if (drag?.isNew) { S.boxes.splice(S.sel, 1); S.sel = -1; }
    drag = null; loupe = null;
    if (S.step === 'arrange' && pc && !pc.locked) {
      const [a, b] = [...pointers.values()];
      pinch = { pc, d0: dist(a, b), w0: pc.w, h0: pc.h, cx: pc.x + pc.w / 2, cy: pc.y + pc.h / 2 };
    }
    draw();
    return;
  }
  if (pointers.size === 1) { onDown(e); draw(); }
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const k = Math.max(0.1, dist(a, b) / pinch.d0);
    const pc = pinch.pc;
    pc.w = Math.max(30, pinch.w0 * k);
    pc.h = pc.w * (pinch.h0 / pinch.w0);
    pc.x = pinch.cx - pc.w / 2;
    pc.y = pinch.cy - pc.h / 2;
    draw();
    return;
  }
  onMove(e);
});
function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pinch) { if (pointers.size === 0) { pinch = null; save(); updateBar(); draw(); } return; }
  if (pointers.size === 0) onUp(e);
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
// iOS: stop the page from rubber-banding / zooming.
document.addEventListener('touchmove', (e) => { if (e.target === stage) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- steps & toolbar ----------
const HINTS = {
  start: '',
  straighten: 'Optional: if the photo is taken at an angle, drag the 4 dots onto the corners of something that should be a rectangle (a big frame works best). Then tap Straighten — or Skip.',
  mark: 'Drag a box around each frame on the wall. Tap a box to adjust or delete it.',
  arrange: 'Drag pictures to move them. Pictures you add can be resized with the corner dot or a pinch.',
  add: 'Drag the 4 dots onto the corners of the picture (this also fixes any slant).',
};

function go(step) {
  S.step = step;
  S.before = false;
  $('#start').hidden = step !== 'start';
  const order = ['start', 'straighten', 'mark', 'arrange'];
  const cur = order.indexOf(step === 'add' ? 'arrange' : step);
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.classList.toggle('on', i === cur);
    li.classList.toggle('done', i < cur);
  });
  updateBar();
  resize();
}

function updateBar() {
  $('#hint').textContent = HINTS[S.step] || '';
  const bar = $('#bar');
  bar.innerHTML = '';
  const btn = (text, fn, cls = '', disabled = false) => {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    b.disabled = disabled;
    b.onclick = fn;
    bar.appendChild(b);
    return b;
  };
  const spacer = () => bar.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));

  if (S.step === 'straighten') {
    btn('← New photo', () => go('start'));
    btn('Reset dots', () => { S.quad = defaultQuad(S.raw, 0.2); draw(); });
    spacer();
    btn('Skip', () => { S.photo = S.raw; S.boxes = []; S.sel = -1; go('mark'); });
    btn('Straighten ✓', async () => {
      busy('Straightening…');
      await nextFrame();
      const out = straightenPhoto(S.raw, S.quad);
      busy('');
      if (!out) return toast('That shape is too extreme to straighten — try placing the dots again.');
      S.photo = out; S.boxes = []; S.sel = -1;
      go('mark');
    }, 'primary');
  } else if (S.step === 'mark') {
    btn('← Straighten', () => {
      if (S.boxes.length && !confirm('Going back clears your boxes. Continue?')) return;
      go('straighten');
    });
    if (S.sel >= 0) btn('Delete box', () => { S.boxes.splice(S.sel, 1); S.sel = -1; updateBar(); draw(); }, 'danger');
    spacer();
    const n = S.boxes.length;
    btn(n ? `Erase ${n} frame${n > 1 ? 's' : ''} ${S.ai ? '✨' : '(quick fill)'}` : 'Wall is empty → Next', () => { S.sel = -1; eraseFrames(); }, 'primary');
  } else if (S.step === 'arrange') {
    const p = S.piece;
    btn('+ Add picture', addPicture, 'primary');
    if (p) {
      if (p.original) btn(p.locked ? '🔒 Size locked' : '🔓 Resizable', () => { p.locked = !p.locked; save(); updateBar(); draw(); });
      btn('📏 Size', () => setSize(p));
      btn('Bring forward', () => { S.pieces = S.pieces.filter((x) => x !== p).concat(p); save(); draw(); });
      btn('Remove', () => { S.pieces = S.pieces.filter((x) => x !== p); S.piece = null; save(); updateBar(); draw(); }, 'danger');
    }
    spacer();
    btn(S.before ? 'Showing original' : 'Compare', () => { S.before = !S.before; S.piece = null; updateBar(); draw(); }, S.before ? 'on' : '');
    btn('Save image', exportImage);
    btn('Start over', () => { if (confirm('Start over with a new wall photo?')) { db.del('project').catch(() => {}); go('start'); } });
  } else if (S.step === 'add') {
    btn('Cancel', () => { S.add = null; go('arrange'); });
    btn('Reset dots', () => { S.add.quad = defaultQuad(S.add.img, 0.08); draw(); });
    spacer();
    btn('Add to wall ✓', placeNewPiece, 'primary');
  }
}

// ---------- actions ----------
async function startWithSource(getCanvas) {
  busy('Opening photo…');
  try {
    const c = await getCanvas();
    if (!c) return;
    S.raw = c; S.photo = c; S.boxes = []; S.sel = -1; S.pieces = []; S.clean = null; S.pxPerInch = null;
    S.quad = defaultQuad(c, 0.2);
    db.del('project').catch(() => {});
    go('straighten');
  } catch (e) {
    toast(e.message);
  } finally {
    busy('');
  }
}

async function addPicture() {
  const f = await pickFile();
  if (!f) return;
  busy('Opening picture…');
  try {
    const img = await fileToCanvas(f, MAX_WALL);
    S.add = { img, quad: defaultQuad(img, 0.08) };
    go('add');
  } catch (e) {
    toast(e.message);
  } finally {
    busy('');
  }
}

async function placeNewPiece() {
  busy('Cutting out picture…');
  await nextFrame();
  const img = extractQuad(S.add.img, S.add.quad);
  busy('');
  if (!img) return toast('Could not cut that out — try placing the dots again.');
  S.add = null;
  const wall = S.clean;
  let w = wall.width * 0.22, h = (w * img.height) / img.width;
  if (h > wall.height * 0.35) { h = wall.height * 0.35; w = (h * img.width) / img.height; }
  const pc = { id: nextId++, img, x: (wall.width - w) / 2, y: (wall.height - h) / 2 - wall.height * 0.1, w, h, original: false, locked: false };
  S.pieces.push(pc);
  S.piece = pc;
  go('arrange');
  save();
  toast(S.pxPerInch ? 'Tap 📏 Size to set its real size.' : 'Drag the corner dot (or pinch) to resize it.');
}

function setSize(p) {
  if (!S.pxPerInch) {
    if (!p.original) {
      const ref = S.pieces.find((x) => x.original);
      return toast(ref ? 'First select one of your original frames and tap 📏 Size to tell me how wide it is.' : 'Sizes need a known frame on the wall to measure against.', 5000);
    }
    const v = parseFloat(prompt('How wide is this frame, in inches? (sets the scale for everything)'));
    if (!(v > 0)) return;
    S.pxPerInch = p.w / v;
    toast(`Scale set. This frame is ${inches(p.w)} × ${inches(p.h)}.`);
  } else if (p.locked) {
    const v = parseFloat(prompt(`Correct the scale: how wide is this frame in inches? (now ${inches(p.w)})`));
    if (!(v > 0)) return;
    S.pxPerInch = p.w / v;
  } else {
    const v = parseFloat(prompt(`Real width of this picture, in inches? (now ${inches(p.w)})`));
    if (!(v > 0)) return;
    const cx = p.x + p.w / 2, cy = p.y + p.h / 2, aspect = p.w / p.h;
    p.w = v * S.pxPerInch; p.h = p.w / aspect;
    p.x = cx - p.w / 2; p.y = cy - p.h / 2;
  }
  save();
  draw();
}

async function exportImage() {
  busy('Preparing image…');
  await nextFrame();
  const wall = S.clean;
  const out = copyCanvas(wall);
  const g = out.getContext('2d');
  const k = Math.max(wall.width, wall.height) / 1000;
  for (const p of S.pieces) {
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 14 * k;
    g.shadowOffsetY = 5 * k;
    g.drawImage(p.img, p.x, p.y, p.w, p.h);
    g.restore();
  }
  const blob = await new Promise((r) => out.toBlob(r, 'image/jpeg', 0.92));
  busy('');
  const file = new File([blob], 'gallery-wall.jpg', { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Gallery wall' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'gallery-wall.jpg';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- init ----------
$('#pickWall').onclick = async () => {
  const f = await pickFile();
  if (f) startWithSource(() => fileToCanvas(f, MAX_WALL));
};
$('#sampleWall').onclick = () => startWithSource(() => imageToCanvas('sample-wall.jpg', MAX_WALL));
$('#resume').onclick = resume;
window.addEventListener('resize', resize);

(async function init() {
  try {
    const r = await fetch('api/status');
    S.ai = !!(await r.json()).ai;
  } catch { S.ai = false; }
  $('#aiStatus').textContent = S.ai
    ? 'AI frame erasing is on.'
    : 'AI erasing is off (no OpenAI key on the server) — a simple wall fill will be used instead.';
  try { if (await db.get('project')) $('#resume').hidden = false; } catch { /* private mode */ }
  go('start');
})();
