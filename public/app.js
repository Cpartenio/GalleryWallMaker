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

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

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
  snap: localGet('gw.snap') !== 'off',
  layersOpen: localGet('gw.layers') === 'open',
  autoFind: localGet('gw.autofind') !== 'off',  // suggest outlines for frames already on the wall
  rulerOn: localGet('gw.ruler') !== 'off',      // look for the printed ruler sheet to get real sizes
  sheet: undefined,                             // ruler sheet result: object, null (not found) or undefined (not looked)
  scaleSource: null,                            // 'sheet' | 'manual'
  fillMode: localGet('gw.fill') === 'openai' ? 'openai' : 'device', // OpenAI only if the server has a key
};

let view = { s: 1, ox: 0, oy: 0 };
// Zoom on top of the fitted view: screen = fitted * k + (x, y).
let zoom = { k: 1, x: 0, y: 0 };
const TOUCH = matchMedia('(pointer: coarse)').matches;
const COMPACT = matchMedia('(max-width: 700px), (max-height: 560px)');
COMPACT.addEventListener?.('change', () => { updateBar(); resize(); });
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
// Each marked frame is a 4-corner outline [TL, TR, BR, BL]; corners can be dragged into any shape.
function quadBounds(q, pad, W, H) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  const x0 = clamp(Math.floor(Math.min(...xs) - pad), 0, W), y0 = clamp(Math.floor(Math.min(...ys) - pad), 0, H);
  const x1 = clamp(Math.ceil(Math.max(...xs) + pad), 0, W), y1 = clamp(Math.ceil(Math.max(...ys) + pad), 0, H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Signed distance to the outline's edges: > 0 inside, < 0 outside (mitered outside the corners).
function quadDist(q, x, y) {
  let area = 0;
  for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; area += a.x * b.y - b.x * a.y; }
  const sign = area > 0 ? -1 : 1;
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    d = Math.min(d, (sign * ((x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x))) / len);
  }
  return d;
}
function pointInQuad(p, q) {
  let inside = false;
  for (let i = 0, j = 3; i < 4; j = i++) {
    const a = q[i], b = q[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function apiSize(w, h) {
  const r = w / h;
  if (r > 1.2) return [1536, 1024];
  if (r < 0.83) return [1024, 1536];
  return [1024, 1024];
}
async function aiFill(photo, quads, pad) {
  const [aw, ah] = apiSize(photo.width, photo.height);
  const img = mkCanvas(aw, ah);
  img.getContext('2d').drawImage(photo, 0, 0, aw, ah);
  const mask = mkCanvas(aw, ah);
  const mg = mask.getContext('2d');
  mg.fillStyle = '#000';
  mg.fillRect(0, 0, aw, ah);
  // Transparent = area the AI repaints: each outline grown by `pad`.
  mg.globalCompositeOperation = 'destination-out';
  mg.scale(aw / photo.width, ah / photo.height);
  mg.lineJoin = 'miter';
  mg.lineWidth = 2 * pad + 6;
  for (const q of quads) {
    mg.beginPath();
    q.forEach((p, i) => (i ? mg.lineTo(p.x, p.y) : mg.moveTo(p.x, p.y)));
    mg.closePath();
    mg.fill();
    mg.stroke();
  }
  const res = await fetch('api/erase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: img.toDataURL('image/png'), mask: mask.toDataURL('image/png'), size: `${aw}x${ah}`,
      hasSheet: quads.some((q) => q.kind === 'sheet'),
    }),
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
// Paste generated pixels into each outline (grown by pad) only, colour-matched and feathered.
function blendQuads(out, gen, quads, pad, feather, matchColor = true) {
  const W = out.width, H = out.height;
  const og = out.getContext('2d');
  const od = og.getImageData(0, 0, W, H);
  const o = od.data;
  const gd = gen.getContext('2d').getImageData(0, 0, W, H).data;
  const orig = new Uint8ClampedArray(o);
  const ring = Math.max(6, feather);
  for (const q of quads) {
    const bb = quadBounds(q, pad + ring, W, H);
    // Match the generated wall's average colour to the real wall just outside the outline.
    const mo = [0, 0, 0], mg = [0, 0, 0];
    let n = 0;
    for (let y = bb.y; y < bb.y + bb.h; y += 2) {
      for (let x = bb.x; x < bb.x + bb.w; x += 2) {
        const d = quadDist(q, x, y);
        if (d >= -pad || d < -pad - ring) continue;
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) { mo[c] += orig[i + c]; mg[c] += gd[i + c]; }
        n++;
      }
    }
    const delta = n && matchColor ? [0, 1, 2].map((c) => (mo[c] - mg[c]) / n) : [0, 0, 0];
    for (let y = bb.y; y < bb.y + bb.h; y++) {
      for (let x = bb.x; x < bb.x + bb.w; x++) {
        const a = clamp((quadDist(q, x + 0.5, y + 0.5) + pad) / Math.max(1, feather), 0, 1);
        if (a <= 0) continue;
        const i = (y * W + x) * 4;
        for (let c = 0; c < 3; c++) o[i + c] = o[i + c] * (1 - a) + (gd[i + c] + delta[c]) * a;
      }
    }
  }
  og.putImageData(od, 0, 0);
}
// No-AI fallback: smooth Coons-patch fill of each rectangle from the wall just outside it.
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

// The empty wall. With AI, the whole photo is regenerated as a blank wall and used as-is, so the
// lighting and paint run continuously with no patch edges. Without AI, patches are filled locally.
async function makeCleanWall(quads) {
  const photo = S.photo, W = photo.width, H = photo.height;
  if (!quads.length) return copyCanvas(photo);
  if (S.ai && S.fillMode === 'openai') {
    busy('Regenerating an empty wall with OpenAI…\nthis can take up to a minute');
    try {
      return await aiFill(photo, quads, Math.round(Math.max(W, H) * 0.012));
    } catch (e) {
      console.error(e);
      toast(`OpenAI erase failed (${e.message}). Used the on-device fill instead.`, 6000);
    }
  }
  // Free, on-device: the inpainting model runs in this browser; nothing is uploaded.
  busy('Erasing frames on your device…');
  await nextFrame();
  const { canvas, usedModel } = await onDeviceFill(photo, quads, Math.round(Math.max(W, H) * 0.02), (f) => {
    busy(`Downloading the eraser (first time only)… ${Math.round(f * 100)}%`);
  });
  if (!usedModel) toast("The AI eraser couldn't load on this device, so a simpler smooth fill was used.", 6000);
  return canvas;
}

async function redoWall() {
  const quads = S.boxes.filter((q) => quadSize(q).w > 2 && quadSize(q).h > 2);
  S.clean = await makeCleanWall(quads);
  busy('');
  draw();
  save();
}

async function eraseFrames() {
  const photo = S.photo;
  const quads = S.boxes.filter((q) => quadSize(q).w > 2 && quadSize(q).h > 2);
  S.clean = await makeCleanWall(quads);
  // Cut each frame out and square it up; it keeps its true size and spot on the wall.
  S.pieces = quads.filter((q) => q.kind !== 'sheet').map((q, i) => {
    const { w, h } = quadSize(q);
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
    const img = extractQuad(photo, q);
    return { id: nextId++, name: `Frame ${i + 1}`, img, x: cx - w / 2, y: cy - h / 2, w, h, original: true, locked: true, hidden: false };
  }).filter((p) => p.img);
  S.piece = null;
  busy('');
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
        photo: urlOf(S.photo), clean: urlOf(S.clean), pxPerInch: S.pxPerInch, scaleSource: S.scaleSource,
        boxes: S.boxes.map((q) => ({ pts: q.map((p) => ({ x: p.x, y: p.y })), kind: q.kind || null })),
        pieces: S.pieces.map((p) => ({ url: urlOf(p.img), name: p.name, x: p.x, y: p.y, w: p.w, h: p.h, original: p.original, locked: p.locked, hidden: !!p.hidden })),
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
    S.scaleSource = p.scaleSource || (S.pxPerInch ? 'manual' : null);
    S.pieces = [];
    for (const q of p.pieces) {
      S.pieces.push({
        id: nextId++, name: q.name || (q.original ? 'Frame' : 'Added'), img: await imageToCanvas(q.url, 1e9),
        x: q.x, y: q.y, w: q.w, h: q.h, original: q.original, locked: q.locked, hidden: !!q.hidden,
      });
    }
    S.boxes = (p.boxes || []).map((b) => Object.assign(b.pts, b.kind ? { kind: b.kind } : {}));
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
  const m = r.width < 700 || r.height < 500 ? 10 : 28;
  const s = Math.min((r.width - 2 * m) / img.width, (r.height - 2 * m) / img.height);
  const ox = (r.width - img.width * s) / 2, oy = (r.height - img.height * s) / 2;
  view = { s: s * zoom.k, ox: ox * zoom.k + zoom.x, oy: oy * zoom.k + zoom.y };
}
// Zoom by factor f keeping screen point (mx, my) fixed.
function zoomAt(f, mx, my) {
  const k = clamp(zoom.k * f, 1, 8);
  f = k / zoom.k;
  zoom = { k, x: mx - (mx - zoom.x) * f, y: my - (my - zoom.y) * f };
  if (k === 1) zoom = { k: 1, x: 0, y: 0 };
  updateZoomUI();
  draw();
}
function resetZoom() { zoom = { k: 1, x: 0, y: 0 }; updateZoomUI(); }
function updateZoomUI() {
  const el = $('#zoom');
  el.hidden = !['straighten', 'mark', 'arrange', 'add'].includes(S.step);
  el.classList.toggle('zoomed', zoom.k > 1.001);
}
function stageCenter() { const r = stage.getBoundingClientRect(); return [r.width / 2, r.height / 2]; }
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
    let frameNo = 0;
    S.boxes.forEach((q, i) => {
      const sel = i === S.sel, sheet = q.kind === 'sheet';
      const color = sel ? '#2563eb' : sheet ? '#7c3aed' : '#ea580c';
      ctx.beginPath();
      q.forEach((p, k) => { const a = toScreen(p); k ? ctx.lineTo(a.x, a.y) : ctx.moveTo(a.x, a.y); });
      ctx.closePath();
      ctx.fillStyle = sel ? 'rgba(37,99,235,0.18)' : sheet ? 'rgba(124,58,237,0.16)' : 'rgba(234,88,12,0.18)';
      ctx.fill();
      ctx.lineWidth = sel ? 3 : 2.5;
      ctx.strokeStyle = color;
      if (q.suggested) ctx.setLineDash([8, 6]); // dashed = suggested, not yet touched
      ctx.stroke();
      ctx.setLineDash([]);
      const a = toScreen({ x: Math.min(q[0].x, q[3].x), y: Math.min(q[0].y, q[1].y) });
      label(sheet ? 'Ruler sheet' : String(++frameNo), a.x + 4, a.y + 4, color);
    });
    if (S.sel >= 0) S.boxes[S.sel].forEach((p) => handle(p));
    if (loupe) drawLoupe(img, loupe);
    return;
  }

  if (S.step === 'arrange') {
    drawImageFit(img);
    if (S.before) return;
    for (const p of S.pieces) {
      if (p.hidden) continue;
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
      // Selected outline: each corner moves on its own, so it can follow any shape.
      const q = S.boxes[S.sel];
      const c = hitHandle(q, e);
      if (c >= 0) { q.suggested = false; drag = { type: 'quad', q, i: c, dx: q[c].x - p.x, dy: q[c].y - p.y }; loupe = q[c]; return; }
    }
    for (let i = S.boxes.length - 1; i >= 0; i--) {
      if (pointInQuad(p, S.boxes[i])) {
        S.sel = i;
        drag = { type: 'moveBox', start: p, orig: S.boxes[i].map((c) => ({ ...c })) };
        updateBar();
        return;
      }
    }
    S.boxes.push(rectPts(p.x, p.y, 0, 0));
    S.sel = S.boxes.length - 1;
    drag = { type: 'newBox', fixed: p, isNew: true };
    updateBar();
  } else if (S.step === 'arrange' && !S.before) {
    const sp = S.piece;
    if (sp && !sp.locked && hitHandle([{ x: sp.x + sp.w, y: sp.y + sp.h }], e) === 0) {
      drag = { type: 'resize', piece: sp };
      return;
    }
    for (let i = S.pieces.length - 1; i >= 0; i--) {
      const pc = S.pieces[i];
      if (!pc.hidden && inside(p, pc)) { S.piece = pc; drag = { type: 'movePiece', piece: pc, start: p, ox: pc.x, oy: pc.y }; updateBar(); return; }
    }
    S.piece = null;
    updateBar();
  }
}

function snap(pc) {
  S.guides = [];
  if (!S.snap) return;
  const th = 10 / view.s;
  const wall = S.clean;
  const xs = [], ys = [];
  for (const o of S.pieces) {
    if (o === pc || o.hidden) continue;
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
  } else if (drag.type === 'newBox') {
    const f = drag.fixed;
    const x = clamp(p.x, 0, W), y = clamp(p.y, 0, H);
    S.boxes[S.sel] = rectPts(Math.min(x, f.x), Math.min(y, f.y), Math.abs(x - f.x), Math.abs(y - f.y));
    loupe = { x, y };
  } else if (drag.type === 'moveBox') {
    const o = drag.orig;
    const xs = o.map((c) => c.x), ys = o.map((c) => c.y);
    const dx = clamp(p.x - drag.start.x, -Math.min(...xs), W - Math.max(...xs));
    const dy = clamp(p.y - drag.start.y, -Math.min(...ys), H - Math.max(...ys));
    const q = S.boxes[S.sel];
    if (dx || dy) q.suggested = false;
    o.forEach((c, k) => { q[k].x = c.x + dx; q[k].y = c.y + dy; });
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
    const { w, h } = quadSize(S.boxes[S.sel]);
    if (w * view.s < 12 || h * view.s < 12) S.boxes.splice(S.sel, 1);
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
    // Two fingers: pinch-resize the selected added picture if the pinch is on it, otherwise zoom/pan.
    const pc = S.piece;
    if (drag?.isNew) { S.boxes.splice(S.sel, 1); S.sel = -1; }
    drag = null; loupe = null;
    const [a, b] = [...pointers.values()];
    const r = stage.getBoundingClientRect();
    const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const midImg = { x: (mid.x - view.ox) / view.s, y: (mid.y - view.oy) / view.s };
    if (S.step === 'arrange' && pc && !pc.locked && inside(midImg, pc)) {
      pinch = { pc, d0: dist(a, b), w0: pc.w, h0: pc.h, cx: pc.x + pc.w / 2, cy: pc.y + pc.h / 2 };
    } else {
      pinch = { view: true, d0: dist(a, b), k0: zoom.k, x0: zoom.x, y0: zoom.y, m0: mid };
    }
    draw();
    return;
  }
  if (pointers.size === 1) { onDown(e); draw(); }
});
stage.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch?.view && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const r = stage.getBoundingClientRect();
    const m = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
    const k = clamp(pinch.k0 * (dist(a, b) / pinch.d0), 1, 8);
    // Keep the photo point that was under the fingers under them.
    const u = { x: (pinch.m0.x - pinch.x0) / pinch.k0, y: (pinch.m0.y - pinch.y0) / pinch.k0 };
    zoom = k <= 1.001 ? { k: 1, x: 0, y: 0 } : { k, x: m.x - u.x * k, y: m.y - u.y * k };
    updateZoomUI();
    draw();
    return;
  }
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
  if (pinch) { if (pointers.size === 0) { if (!pinch.view) save(); pinch = null; updateBar(); draw(); } return; }
  if (pointers.size === 0) onUp(e);
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
// Desktop: Ctrl/⌘ + scroll (or trackpad pinch) zooms, plain scroll pans.
stage.addEventListener('wheel', (e) => {
  if (S.step === 'start') return;
  e.preventDefault();
  const r = stage.getBoundingClientRect();
  const unit = e.deltaMode === 1 ? 16 : 1;
  if (e.ctrlKey || e.metaKey) {
    // Trackpad pinches send small deltas, mouse wheels big ones: cap each step so a notch is ~1.6×.
    zoomAt(Math.exp(-clamp(e.deltaY * unit, -50, 50) * 0.01), e.clientX - r.left, e.clientY - r.top);
  } else if (zoom.k > 1) {
    zoom.x -= e.deltaX * unit; zoom.y -= e.deltaY * unit;
    draw();
  }
}, { passive: false });
document.querySelectorAll('#zoom button').forEach((b) => {
  b.onclick = () => {
    if (b.dataset.z === 'fit') { resetZoom(); draw(); } else zoomAt(b.dataset.z === 'in' ? 1.5 : 1 / 1.5, ...stageCenter());
  };
});
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || !$('#busy').hidden) return;
  if (e.key === 'Escape') {
    S.sel = -1; S.piece = null; updateBar(); draw();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.step === 'mark' && S.sel >= 0) {
    e.preventDefault(); S.boxes.splice(S.sel, 1); S.sel = -1; updateBar(); draw();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && S.step === 'arrange' && S.piece) {
    e.preventDefault(); setHidden(S.piece, true);
  } else if (e.key.startsWith('Arrow') && S.step === 'arrange' && S.piece) {
    e.preventDefault();
    const d = (e.shiftKey ? 10 : 1) / view.s;
    const p = S.piece;
    if (e.key === 'ArrowLeft') p.x -= d; if (e.key === 'ArrowRight') p.x += d;
    if (e.key === 'ArrowUp') p.y -= d; if (e.key === 'ArrowDown') p.y += d;
    save(); draw();
  } else if ((e.key === '+' || e.key === '=') && S.step !== 'start') {
    zoomAt(1.5, ...stageCenter());
  } else if (e.key === '-' && S.step !== 'start') {
    zoomAt(1 / 1.5, ...stageCenter());
  } else if (e.key === '0' && S.step !== 'start') {
    resetZoom(); draw();
  }
});
// Mouse cursor hints.
stage.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || drag) return;
  const p = toImg(e);
  let c = 'default';
  if (S.step === 'straighten' || S.step === 'add') {
    if (hitHandle(S.step === 'add' ? S.add.quad : S.quad, e) >= 0) c = 'grab';
  } else if (S.step === 'mark') {
    if (S.sel >= 0 && hitHandle(S.boxes[S.sel], e) >= 0) c = 'grab';
    else c = S.boxes.some((q) => pointInQuad(p, q)) ? 'move' : 'crosshair';
  } else if (S.step === 'arrange' && !S.before) {
    const sp = S.piece;
    if (sp && !sp.locked && hitHandle([{ x: sp.x + sp.w, y: sp.y + sp.h }], e) === 0) c = 'nwse-resize';
    else if (S.pieces.some((x) => !x.hidden && inside(p, x))) c = 'move';
  }
  stage.style.cursor = c;
});
// iOS: stop the page from rubber-banding / zooming.
document.addEventListener('touchmove', (e) => { if (e.target === stage) e.preventDefault(); }, { passive: false });
document.addEventListener('gesturestart', (e) => e.preventDefault());

// ---------- steps & toolbar ----------
const ZOOM_TIP = TOUCH ? ' Pinch to zoom.' : ' Ctrl/⌘ + scroll to zoom.';
const HINTS = {
  start: '',
  straighten: 'Photo taken at an angle? Drag the 4 dots onto the corners of a big frame, then Straighten. Otherwise, Skip.' + ZOOM_TIP,
  mark: 'Box each frame on the wall; dashed boxes are suggestions. Tap a box, then drag its corners to fit.' + ZOOM_TIP,
  arrange: 'Drag pictures to move them. Resize added pictures with the corner dot' + (TOUCH ? ' or a pinch.' : '.') + ZOOM_TIP,
  add: "Drag the 4 dots onto the picture's corners. This also fixes any slant." + ZOOM_TIP,
};

function go(step) {
  S.step = step;
  S.before = false;
  resetZoom();
  $('#start').hidden = step !== 'start';
  const order = ['start', 'straighten', 'mark', 'arrange'];
  const cur = order.indexOf(step === 'add' ? 'arrange' : step);
  document.querySelectorAll('#steps li').forEach((li, i) => {
    li.classList.toggle('on', i === cur);
    li.classList.toggle('done', i < cur);
  });
  updateBar();
  resize();
  showTip(COMPACT.matches && step !== 'start');
}

// Simple line icons (24×24, stroked).
const ICONS = {
  back: 'M15 18l-6-6 6-6',
  reset: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  skip: 'M5 5l9 7-9 7zM18 5v14',
  check: 'M20 6L9 17l-5-5',
  next: 'M5 12h14M13 6l6 6-6 6',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z',
  ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  plus: 'M12 5v14M5 12h14',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  magnet: 'M6 3v8a6 6 0 0 0 12 0V3M6 7h4M14 7h4',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  forward: 'M9 9h11v11H9zM4 15V4h11',
  eyeOff: 'M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  compare: 'M12 3v18M4 5h16v14H4z',
  redo: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  save: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  newWall: 'M4 4h16v16H4zM9 12h6M12 9v6',
  close: 'M6 6l12 12M18 6L6 18',
  wand: 'M4 20L15 9M14 3l.9 2.1L17 6l-2.1.9L14 9l-.9-2.1L11 6l2.1-.9z',
};
const icon = (name) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ''}"/></svg>`;

const STEP_TITLES = { straighten: 'Straighten', mark: 'Mark frames', arrange: 'Arrange', add: 'Add picture' };
const STEP_NUM = { straighten: 2, mark: 3, arrange: 4, add: 4 };

// Each screen lists its actions once; the layout decides where they go:
// wide screens get a bottom bar of labelled buttons, phones get Back + the main action in a top bar
// and icon tiles along the bottom (portrait) or down the side (landscape), like mobile photo editors.
function toolbarItems() {
  const items = [];
  const add = (label, short, iconName, fn, opts = {}) => items.push({ label, short, icon: iconName, fn, ...opts });
  if (S.step === 'straighten') {
    add('New photo', 'Back', 'back', () => go('start'), { kind: 'back' });
    add('Reset dots', 'Reset', 'reset', () => { S.quad = defaultQuad(S.raw, 0.2); draw(); });
    add('Skip', 'Skip', 'skip', () => { S.photo = S.raw; S.boxes = []; S.sel = -1; go('mark'); analyzeWall(); });
    add('Straighten', 'Straighten', 'check', async () => {
      busy('Straightening…');
      await nextFrame();
      const out = straightenPhoto(S.raw, S.quad);
      busy('');
      if (!out) return toast('That shape is too extreme to straighten. Try placing the dots again.');
      S.photo = out; S.boxes = []; S.sel = -1;
      go('mark');
      analyzeWall();
    }, { kind: 'primary' });
  } else if (S.step === 'mark') {
    add('Straighten', 'Back', 'back', () => {
      if (S.boxes.length && !confirm('Going back clears your boxes. Continue?')) return;
      go('straighten');
    }, { kind: 'back' });
    add('Auto-find', 'Auto-find', 'sparkle', () => setAutoFind(!S.autoFind), { on: S.autoFind });
    add(!S.rulerOn ? 'Ruler sheet' : S.sheet ? 'Ruler sheet found' : 'Ruler sheet: none', S.sheet && S.rulerOn ? 'Ruler ✓' : 'Ruler',
      'ruler', () => setRuler(!S.rulerOn), { on: S.rulerOn });
    if (S.ai) add(S.fillMode === 'openai' ? 'Eraser: OpenAI' : 'Eraser: on-device', S.fillMode === 'openai' ? 'OpenAI' : 'On-device', 'wand', () => {
      S.fillMode = S.fillMode === 'openai' ? 'device' : 'openai';
      localSet('gw.fill', S.fillMode);
      updateBar();
      toast(S.fillMode === 'openai' ? 'Erasing with OpenAI (uses your API key).' : 'Erasing on this device (free, private).');
    }, { on: S.fillMode === 'openai' });
    if (S.sel >= 0) add('Delete box', 'Delete', 'trash', () => { S.boxes.splice(S.sel, 1); S.sel = -1; updateBar(); draw(); }, { danger: true });
    const n = S.boxes.filter((q) => q.kind !== 'sheet').length;
    const hasSheet = S.boxes.some((q) => q.kind === 'sheet');
    const what = [n ? `${n} frame${n > 1 ? 's' : ''}` : '', hasSheet ? 'sheet' : ''].filter(Boolean).join(' + ');
    add(what ? `Erase ${what}` : 'Wall is empty: Next', what ? 'Erase' : 'Next',
      what ? 'wand' : 'next', () => { S.sel = -1; eraseFrames(); }, { kind: 'primary' });
  } else if (S.step === 'arrange') {
    const p = S.piece;
    if (p) {
      // A picture is selected: its own actions replace the wall-wide ones.
      add('Done', 'Done', 'check', () => { S.piece = null; updateBar(); draw(); }, { kind: 'primary' });
      if (p.original) add(p.locked ? 'Size locked' : 'Resizable', p.locked ? 'Locked' : 'Unlocked', p.locked ? 'lock' : 'unlock',
        () => { p.locked = !p.locked; save(); updateBar(); draw(); }, { on: !p.locked });
      add('Size', 'Size', 'ruler', () => setSize(p));
      add('Forward', 'Forward', 'forward', () => { S.pieces = S.pieces.filter((x) => x !== p).concat(p); save(); updateBar(); draw(); });
      add('Hide', 'Hide', 'eyeOff', () => setHidden(p, true));
      add('Remove', 'Remove', 'trash', () => {
        if (!confirm(`Remove ${p.name || 'this picture'} from the wall? (Hide keeps it in Layers.)`)) return;
        S.pieces = S.pieces.filter((x) => x !== p); S.piece = null; save(); updateBar(); draw();
      }, { danger: true });
    } else {
      add('Add picture', 'Add', 'plus', addPicture, { kind: 'primary' });
      add('Layers', 'Layers', 'layers', () => { S.layersOpen = !S.layersOpen; localSet('gw.layers', S.layersOpen ? 'open' : 'closed'); updateBar(); resize(); }, { on: S.layersOpen });
      add('Snap', 'Snap', 'magnet', () => { S.snap = !S.snap; localSet('gw.snap', S.snap ? 'on' : 'off'); updateBar(); }, { on: S.snap });
      add(S.before ? 'Showing original' : 'Compare', 'Compare', 'compare', () => { S.before = !S.before; S.piece = null; updateBar(); draw(); }, { on: S.before });
      if (S.boxes.length) add('Redo wall', 'Redo wall', 'redo', () => { if (confirm('Regenerate the empty wall? Your arrangement stays as it is.')) redoWall(); });
      add('Save image', 'Save', 'save', exportImage);
      add('Start over', 'New wall', 'newWall', () => { if (confirm('Start over with a new wall photo?')) { db.del('project').catch(() => {}); go('start'); } }, { kind: 'menu' });
    }
  } else if (S.step === 'add') {
    add('Cancel', 'Cancel', 'close', () => { S.add = null; go('arrange'); }, { kind: 'back' });
    add('Reset dots', 'Reset', 'reset', () => { S.add.quad = defaultQuad(S.add.img, 0.08); draw(); });
    add('Add to wall', 'Add', 'check', placeNewPiece, { kind: 'primary' });
  }
  return items;
}

function updateBar() {
  $('#hint').textContent = HINTS[S.step] || '';
  renderLayers();
  const compact = COMPACT.matches;
  document.body.classList.toggle('compact', compact);
  const bar = $('#bar'), mBack = $('#mBack'), mAction = $('#mAction');
  bar.innerHTML = ''; mBack.innerHTML = ''; mAction.innerHTML = '';
  $('#mTitle').innerHTML = STEP_TITLES[S.step]
    ? `${STEP_TITLES[S.step]}<small>${S.step === 'arrange' && S.piece ? S.piece.name || 'Picture' : `Step ${STEP_NUM[S.step]} of 4`}</small>` : '';
  const make = (it, style) => {
    const b = document.createElement('button');
    b.onclick = it.fn;
    b.title = it.label;
    if (style === 'tile') {
      b.className = 'tile' + (it.on ? ' on' : '') + (it.danger ? ' danger' : '');
      b.innerHTML = `${icon(it.icon)}<span></span>`;
      b.querySelector('span').textContent = it.short;
    } else if (style === 'back') {
      b.className = 'iconbtn';
      b.innerHTML = icon(it.icon);
      b.setAttribute('aria-label', it.label);
    } else {
      b.className = [it.kind === 'primary' ? 'primary' : '', it.on ? 'on' : '', it.danger ? 'danger' : ''].join(' ').trim();
      b.innerHTML = `${icon(it.icon)}<span></span>`;
      b.querySelector('span').textContent = compact ? it.short : it.label;
    }
    return b;
  };
  const items = toolbarItems();
  if (compact) {
    for (const it of items) {
      if (it.kind === 'back') mBack.appendChild(make(it, 'back'));
      else if (it.kind === 'primary') mAction.appendChild(make(it, 'pill'));
      else bar.appendChild(make(it, 'tile'));
    }
  } else {
    const spacer = () => bar.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));
    const back = items.filter((i) => i.kind === 'back'), primary = items.filter((i) => i.kind === 'primary');
    const rest = items.filter((i) => i.kind !== 'back' && i.kind !== 'primary');
    back.forEach((i) => bar.appendChild(make(i, 'button')));
    // Arrange keeps its main action first; elsewhere it sits at the far right.
    if (S.step === 'arrange') primary.forEach((i) => bar.appendChild(make(i, 'button')));
    rest.filter((i) => i.kind !== 'menu').forEach((i) => bar.appendChild(make(i, 'button')));
    spacer();
    rest.filter((i) => i.kind === 'menu').forEach((i) => bar.appendChild(make(i, 'button')));
    if (S.step !== 'arrange') primary.forEach((i) => bar.appendChild(make(i, 'button')));
  }
  // Real-size inputs for a new picture float over the photo on phones, sit in the bar otherwise.
  const chip = $('#sizeChip');
  chip.innerHTML = '';
  chip.hidden = true;
  if (S.step === 'add') {
    const size = document.createElement('label');
    size.className = 'size';
    if (S.pxPerInch) {
      size.innerHTML = '<span>Real size</span> <input id="addW" inputmode="decimal" placeholder="W"> × <input id="addH" inputmode="decimal" placeholder="H"> in';
    } else {
      size.textContent = 'For real sizes, use the ruler sheet or Size on a frame';
      size.classList.add('muted');
    }
    if (compact) { chip.appendChild(size); chip.hidden = false; } else bar.insertBefore(size, bar.querySelector('.primary'));
  }
  requestAnimationFrame(() => { bar.scrollLeft = 0; bar.scrollTop = 0; barOverflow(); });
}

// ---------- auto-find & ruler sheet ----------
function sheetBox() { return S.boxes.find((q) => q.kind === 'sheet'); }
function runRuler() {
  S.boxes = S.boxes.filter((q) => q.kind !== 'sheet');
  S.sheet = findRulerSheet(S.photo);
  if (S.sheet) {
    const q = S.sheet.quad;
    q.kind = 'sheet';
    S.boxes.unshift(q);
    if (S.scaleSource !== 'manual') { S.pxPerInch = S.sheet.pxPerInch; S.scaleSource = 'sheet'; }
  }
  return S.sheet;
}
function runAutoFind() {
  const sheet = sheetBox();
  const found = detectFrames(S.photo, sheet ? [sheet] : []);
  let added = 0;
  for (const q of found) {
    const c = { x: (q[0].x + q[2].x) / 2, y: (q[0].y + q[2].y) / 2 };
    if (S.boxes.some((o) => pointInQuad(c, o))) continue; // already marked
    q.suggested = true;
    S.boxes.push(q);
    added++;
  }
  return added;
}
// Runs once when a new photo reaches the Mark step.
async function analyzeWall() {
  if (!S.autoFind && !S.rulerOn) return;
  busy(S.rulerOn ? 'Looking for frames and the ruler sheet…' : 'Looking for frames…');
  await nextFrame();
  const msgs = [];
  try {
    if (S.rulerOn) {
      const r = runRuler();
      if (r) msgs.push(`Ruler sheet found: sizes are in real inches${r.edgesFound ? '' : ' (assuming it printed at 100%)'}.`);
    }
    if (S.autoFind) {
      const n = runAutoFind();
      msgs.unshift(n ? `Found ${n} frame${n > 1 ? 's' : ''}. Check the dashed boxes.` : 'No frames found automatically. Drag boxes around them.');
    }
  } catch (e) {
    console.error(e);
  }
  busy('');
  updateBar();
  draw();
  if (msgs.length) toast(msgs.join(' '), 5000);
}
async function setAutoFind(on) {
  S.autoFind = on;
  localSet('gw.autofind', on ? 'on' : 'off');
  if (on) {
    busy('Looking for frames…');
    await nextFrame();
    const n = runAutoFind();
    busy('');
    toast(n ? `Found ${n} frame${n > 1 ? 's' : ''}.` : 'No new frames found.');
  } else {
    S.boxes = S.boxes.filter((q) => !q.suggested); // keeps any you adjusted or drew
  }
  S.sel = -1;
  updateBar();
  draw();
}
async function setRuler(on) {
  S.rulerOn = on;
  localSet('gw.ruler', on ? 'on' : 'off');
  if (on) {
    busy('Looking for the ruler sheet…');
    await nextFrame();
    const r = runRuler();
    busy('');
    toast(r ? 'Ruler sheet found: sizes are in real inches.' : 'No ruler sheet in this photo. Print it from the start screen, tape it up and retake the photo.', 5000);
  } else {
    S.boxes = S.boxes.filter((q) => q.kind !== 'sheet');
    S.sheet = undefined;
    if (S.scaleSource === 'sheet') { S.pxPerInch = null; S.scaleSource = null; }
  }
  S.sel = -1;
  updateBar();
  draw();
}

// ---------- layers panel ----------
const EYE = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

function thumbOf(p) {
  if (!p.img._thumb) {
    const k = 120 / Math.max(p.img.width, p.img.height);
    const c = mkCanvas(p.img.width * k, p.img.height * k);
    c.getContext('2d').drawImage(p.img, 0, 0, c.width, c.height);
    p.img._thumb = c.toDataURL('image/jpeg', 0.8);
  }
  return p.img._thumb;
}
function setHidden(p, hidden) {
  p.hidden = hidden;
  if (hidden && S.piece === p) S.piece = null;
  save();
  updateBar();
  draw();
}
function renderLayers() {
  const el = $('#layers');
  const open = S.step === 'arrange' && S.layersOpen;
  if (el.hidden === open) { el.hidden = !open; requestAnimationFrame(resize); }
  if (!open) return;
  el.innerHTML = '';
  const hiddenCount = S.pieces.filter((p) => p.hidden).length;
  if (hiddenCount) {
    const all = document.createElement('button');
    all.className = 'showall';
    all.textContent = `Show all (${hiddenCount} hidden)`;
    all.onclick = () => { S.pieces.forEach((p) => (p.hidden = false)); save(); updateBar(); draw(); };
    el.appendChild(all);
  }
  if (!S.pieces.length) {
    el.appendChild(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No pictures yet — tap + Add picture.' }));
  }
  // Top-most picture first, like a layers list.
  for (const p of [...S.pieces].reverse()) {
    const card = document.createElement('div');
    card.className = 'layer' + (p === S.piece ? ' sel' : '') + (p.hidden ? ' off' : '');
    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.innerHTML = `<img alt=""><span></span>`;
    pick.querySelector('img').src = thumbOf(p);
    pick.querySelector('span').textContent = p.name || (p.original ? 'Frame' : 'Added');
    pick.onclick = () => { if (p.hidden) p.hidden = false; S.piece = p; save(); updateBar(); draw(); };
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.innerHTML = p.hidden ? EYE_OFF : EYE;
    eye.setAttribute('aria-label', p.hidden ? 'Show' : 'Hide');
    eye.onclick = () => setHidden(p, !p.hidden);
    card.append(pick, eye);
    el.appendChild(card);
  }
}

// Fade the toolbar's right edge when more buttons are hidden off-screen (phones).
function barOverflow() {
  const bar = $('#bar');
  const last = bar.lastElementChild;
  const more = bar.scrollWidth - bar.clientWidth - bar.scrollLeft > 4 && !last?.classList.contains('primary');
  bar.classList.toggle('more-y', bar.scrollHeight - bar.clientHeight - bar.scrollTop > 4);
  bar.classList.toggle('more', more);
}
$('#bar').addEventListener('scroll', barOverflow, { passive: true });
window.addEventListener('resize', barOverflow);

// ---------- actions ----------
async function startWithSource(getCanvas) {
  busy('Opening photo…');
  try {
    const c = await getCanvas();
    if (!c) return;
    S.raw = c; S.photo = c; S.boxes = []; S.sel = -1; S.pieces = []; S.clean = null; S.pxPerInch = null;
    S.sheet = undefined; S.scaleSource = null;
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
  const inW = parseFloat($('#addW')?.value), inH = parseFloat($('#addH')?.value);
  S.add = null;
  const wall = S.clean;
  let w = wall.width * 0.22, h = (w * img.height) / img.width;
  if (h > wall.height * 0.35) { h = wall.height * 0.35; w = (h * img.width) / img.height; }
  const sized = S.pxPerInch && (inW > 0 || inH > 0);
  if (sized) {
    // Real dimensions typed in: one number keeps the photo's proportions, two set both exactly.
    w = inW > 0 ? inW * S.pxPerInch : (inH * S.pxPerInch * img.width) / img.height;
    h = inH > 0 ? inH * S.pxPerInch : (w * img.height) / img.width;
  }
  const added = S.pieces.filter((x) => !x.original).length + 1;
  const pc = { id: nextId++, name: `Added ${added}`, img, x: (wall.width - w) / 2, y: (wall.height - h) / 2 - wall.height * 0.1, w, h, original: false, locked: false, hidden: false };
  S.pieces.push(pc);
  S.piece = pc;
  go('arrange');
  save();
  toast(sized ? `Added at ${inches(w)} × ${inches(h)}.` : S.pxPerInch ? 'Tap 📏 Size to set its real size.' : 'Drag the corner dot (or pinch) to resize it.');
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
    S.scaleSource = 'manual';
    toast(`Scale set. This frame is ${inches(p.w)} × ${inches(p.h)}.`);
  } else if (p.locked) {
    const v = parseFloat(prompt(`Correct the scale: how wide is this frame in inches? (now ${inches(p.w)})`));
    if (!(v > 0)) return;
    S.pxPerInch = p.w / v;
    S.scaleSource = 'manual';
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
  for (const p of S.pieces.filter((x) => !x.hidden)) {
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
$('#hint').addEventListener('click', () => { $('#hint').classList.toggle('open'); if (!COMPACT.matches) resize(); });
// Phones: tips live behind the ? button and pop up briefly when a step opens.
let tipTimer;
function showTip(on) {
  clearTimeout(tipTimer);
  document.body.classList.toggle('tip', on);
  if (on) tipTimer = setTimeout(() => document.body.classList.remove('tip'), 6000);
}
$('#mHelp').onclick = () => showTip(!document.body.classList.contains('tip'));
stage.addEventListener('pointerdown', () => showTip(false), true);

(async function init() {
  try {
    const r = await fetch('api/status');
    S.ai = !!(await r.json()).ai;
  } catch { S.ai = false; }
  $('#aiStatus').textContent = S.ai && S.fillMode === 'openai'
    ? 'The eraser is set to OpenAI, so photos are sent to OpenAI when you erase.'
    : 'Everything runs on your device. Your photos are never uploaded.';
  try { if (await db.get('project')) $('#resume').hidden = false; } catch { /* private mode */ }
  go('start');
})();
