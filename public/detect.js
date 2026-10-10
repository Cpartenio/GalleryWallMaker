'use strict';
// Computer-vision helpers: find the printed ruler sheet (scale) and suggest frame outlines.
// Uses homography(), applyH(), rectPts(), dist(), clamp(), mkCanvas() from app.js.

// Ruler sheet layout in inches on a portrait US Letter page (must match scripts/make-ruler-pdf.js).
const RULER = { id: 7, dict: 'ARUCO_MIP_36h12', x: 0.75, y: 0.75, side: 7, pw: 8.5, ph: 11 };

function lumaOf(img) {
  const { data, width, height } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return g;
}

// ---------- ruler sheet ----------
// Returns { pxPerInch, printScale, edgesFound, quad } or null if the sheet isn't in the photo.
function findRulerSheet(photo) {
  if (!window.AR) return null;
  const W = photo.width, H = photo.height;
  const img = photo.getContext('2d').getImageData(0, 0, W, H);
  const detector = new AR.Detector({ dictionaryName: RULER.dict });
  const marker = detector.detect(img).find((m) => m.id === RULER.id);
  if (!marker) return null;
  const c = marker.corners.map((p) => ({ x: p.x, y: p.y }));
  // Map the sheet's own inch coordinates (as designed) onto the photo.
  const Hm = homography(rectPts(RULER.x, RULER.y, RULER.side, RULER.side), c);
  if (!Hm) return null;
  const sidePx = (dist(c[0], c[1]) + dist(c[1], c[2]) + dist(c[2], c[3]) + dist(c[3], c[0])) / 4;

  // Printers set to "fit to page" shrink everything slightly (centred). The paper itself is
  // always 8.5 × 11 in, so look for its edges to measure the real print scale.
  const g = lumaOf(img);
  const cx = RULER.pw / 2, cy = RULER.ph / 2;
  const luma = (p) => {
    const x = Math.round(p.x), y = Math.round(p.y);
    if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) return null;
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += g[(y + dy) * W + x + dx];
    return s / 9;
  };
  const scoreAt = (s) => {
    const x0 = cx - cx / s, x1 = cx + cx / s, y0 = cy - cy / s, y1 = cy + cy / s;
    const d = 0.12; // inches either side of the edge
    const edges = [
      [(t) => ({ x: x0 + (x1 - x0) * t, y: y0 }), { x: 0, y: d }],
      [(t) => ({ x: x0 + (x1 - x0) * t, y: y1 }), { x: 0, y: -d }],
      [(t) => ({ x: x0, y: y0 + (y1 - y0) * t }), { x: d, y: 0 }],
      [(t) => ({ x: x1, y: y0 + (y1 - y0) * t }), { x: -d, y: 0 }],
    ];
    const meds = [];
    for (const [at, inward] of edges) {
      const diffs = [];
      for (let k = 1; k < 40; k++) {
        const p = at(k / 40);
        const a = luma(applyH(Hm, p.x + inward.x, p.y + inward.y));
        const b = luma(applyH(Hm, p.x - inward.x, p.y - inward.y));
        if (a != null && b != null) diffs.push(Math.abs(a - b));
      }
      if (diffs.length > 10) meds.push(diffs.sort((u, v) => u - v)[diffs.length >> 1]);
    }
    return meds.length >= 3 ? meds.reduce((u, v) => u + v, 0) / meds.length : 0;
  };
  const scores = [];
  for (let s = 0.86; s <= 1.04; s += 0.0025) scores.push({ s, v: scoreAt(s) });
  const best = scores.reduce((a, b) => (b.v > a.v ? b : a));
  const median = scores.map((x) => x.v).sort((u, v) => u - v)[scores.length >> 1];
  const edgesFound = best.v >= 6 && best.v >= 1.8 * median;
  const printScale = edgesFound ? best.s : 1;

  const s = printScale;
  const quad = rectPts(cx - cx / s, cy - cy / s, (2 * cx) / s, (2 * cy) / s).map((p) => {
    const q = applyH(Hm, p.x, p.y);
    return { x: clamp(q.x, 0, W), y: clamp(q.y, 0, H) };
  });
  return { pxPerInch: sidePx / (RULER.side * s), printScale, edgesFound, quad };
}

// ---------- frame suggestions ----------
// Frames on a wall are closed, roughly rectangular islands of detail on a smooth background:
// edge map → close small gaps → fill enclosed areas → keep solid, rectangle-like blobs.
function detectFrames(photo, ignore = []) {
  const W0 = photo.width, H0 = photo.height;
  const k = Math.min(1, 640 / Math.max(W0, H0));
  const w = Math.round(W0 * k), h = Math.round(H0 * k), n = w * h;
  const small = mkCanvas(w, h);
  const sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(photo, 0, 0, w, h);
  const rgba = sg.getImageData(0, 0, w, h).data;

  // Colour gradient magnitude (max over channels) — light frames on a light wall still differ in hue.
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let m = 0;
      for (let c = 0; c < 3; c++) {
        const at = (dx, dy) => rgba[((y + dy) * w + x + dx) * 4 + c];
        const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - at(-1, -1) - 2 * at(-1, 0) - at(-1, 1);
        const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - at(-1, -1) - 2 * at(0, -1) - at(1, -1);
        m = Math.max(m, Math.abs(gx) + Math.abs(gy));
      }
      mag[y * w + x] = m;
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const thr = Math.max(40, sorted[Math.floor(n * 0.5)] * 4);

  let edge = new Uint8Array(n);
  for (let i = 0; i < n; i++) edge[i] = mag[i] > thr ? 1 : 0;
  // Close gaps of a few pixels (dilate by r).
  const r = 1;
  const dil = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) dil[yy * w + xx] = 1;
      }
    }
  }
  edge = dil;

  // Fill enclosed holes: flood the background from the image border; anything not reached is solid.
  const outside = new Uint8Array(n);
  const stack = [];
  const push = (i) => { if (!edge[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }

  const solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) solid[i] = outside[i] ? 0 : 1;
  // Shrink the solid areas so thin lines (wall corners, lamp stems) touching a frame break off,
  // then grow each blob back. A second, stronger pass splits frames hung right next to other things.
  const found = [];
  for (const e of [4, 8]) {
    for (const quad of blobsAt(e)) {
      const a = quadSize(quad), area = a.w * a.h;
      const dup = found.some((o) => {
        const ox = Math.min(o[2].x, quad[2].x) - Math.max(o[0].x, quad[0].x);
        const oy = Math.min(o[2].y, quad[2].y) - Math.max(o[0].y, quad[0].y);
        return ox > 0 && oy > 0 && (ox * oy) / Math.min(area, quadSize(o).w * quadSize(o).h) > 0.5;
      });
      if (!dup) found.push(quad);
    }
  }
  const out = refineSides(photo, found);

  function blobsAt(e) {
    const erode1d = (src, horizontal) => {
      const dst = new Uint8Array(n);
      const len = horizontal ? w : h, lines = horizontal ? h : w;
      const idx = (line, t) => (horizontal ? line * w + t : t * w + line);
      const pre = new Int32Array(len + 1);
      for (let l = 0; l < lines; l++) {
        for (let t = 0; t < len; t++) pre[t + 1] = pre[t] + src[idx(l, t)];
        for (let t = e; t < len - e; t++) if (pre[t + e + 1] - pre[t - e] === 2 * e + 1) dst[idx(l, t)] = 1;
      }
      return dst;
    };
    const core = erode1d(erode1d(solid, true), false);

    const label = new Int32Array(n).fill(-1);
    const quads = [];
    let nb = 0;
    for (let i0 = 0; i0 < n; i0++) {
      if (!core[i0] || label[i0] >= 0) continue;
      const b = { x0: w, y0: h, x1: 0, y1: 0, count: 0, detail: 0 };
      label[i0] = nb++;
      stack.push(i0);
      while (stack.length) {
        const i = stack.pop(), x = i % w, y = (i / w) | 0;
        b.count++;
        if (mag[i] > thr) b.detail++;
        if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
          if (j >= 0 && j < n && core[j] && label[j] < 0) { label[j] = label[i0]; stack.push(j); }
        }
      }
      const cw = b.x1 - b.x0 + 1, ch = b.y1 - b.y0 + 1;
      // Grow back to the original outline.
      b.x0 -= e; b.y0 -= e; b.x1 += e; b.y1 += e;
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      if (b.x0 <= 2 || b.y0 <= 2 || b.x1 >= w - 3 || b.y1 >= h - 3) continue; // furniture/doors run off the photo
      if (bw * bh < n * 0.0015 || bw * bh > n * 0.3) continue;
      if (bw / bh > 4 || bh / bw > 4) continue;
      if (b.count / (cw * ch) < 0.82) continue; // must be solid and rectangle-like
      if (b.detail / b.count < 0.2) continue; // plain shapes (lampshades, cushions) aren't artwork
      // Back to full resolution; the gap-closing grew each blob by r pixels.
      const g = r / k;
      const quad = rectPts((b.x0 + 0.5) / k + g, (b.y0 + 0.5) / k + g, bw / k - 2 * g, bh / k - 2 * g);
      const c = { x: (quad[0].x + quad[2].x) / 2, y: (quad[0].y + quad[2].y) / 2 };
      if (!ignore.some((q) => pointInQuad(c, q))) quads.push(quad);
    }
    return quads;
  }
  // Drop blobs nested inside another (e.g. a picture inside its own frame).
  return out.filter((q, i) => !out.some((o, j) => j !== i && pointInQuad(q[0], o) && pointInQuad(q[2], o)));
}

// Snap each side of a rough box to the frame's real edge: shadows make boxes too big, and nearby
// lines (an alcove, a door) can stick to them. The real edge is a sharp line where the
// perpendicular sides of the frame start, with plain wall beyond it.
function refineSides(photo, quads) {
  const W = photo.width, H = photo.height;
  const g = lumaOf(photo.getContext('2d').getImageData(0, 0, W, H));
  const L = (x, y) => g[clamp(Math.round(y), 0, H - 1) * W + clamp(Math.round(x), 0, W - 1)];
  // Mean edge strength across a horizontal (y fixed) or vertical (x fixed) segment.
  const rowEdge = (y, xa, xb) => { let s = 0, c = 0; for (let x = xa; x <= xb; x += 2) { s += Math.abs(L(x, y + 1) - L(x, y - 1)); c++; } return c ? s / c : 0; };
  const colEdge = (x, ya, yb) => { let s = 0, c = 0; for (let y = ya; y <= yb; y += 2) { s += Math.abs(L(x + 1, y) - L(x - 1, y)); c++; } return c ? s / c : 0; };
  // Search a side from `out` (outside) to `inn` (inside) and take the outermost strong line.
  const bestLine = (from, to, score) => {
    const vals = [];
    const step = from < to ? 1 : -1;
    for (let v = from; v !== to; v += step) vals.push([v, score(v)]);
    const max = Math.max(...vals.map((x) => x[1]));
    if (max < 6) return null;
    for (let i = 1; i < vals.length - 1; i++) {
      const [v, sc] = vals[i];
      if (sc >= 0.5 * max && sc >= vals[i - 1][1] && sc >= vals[i + 1][1]) return v;
    }
    return null;
  };
  return quads.map((q) => {
    let x0 = q[0].x, y0 = q[0].y, x1 = q[2].x, y1 = q[2].y;
    const bw = x1 - x0, bh = y1 - y0;
    const mx = Math.round(Math.max(8, bw * 0.08)), my = Math.round(Math.max(8, bh * 0.08));
    const midX = [Math.round(x0 + bw * 0.25), Math.round(x1 - bw * 0.25)];
    const midY = [Math.round(y0 + bh * 0.25), Math.round(y1 - bh * 0.25)];
    // 1) Top and bottom from the middle half of the width (away from anything touching the sides).
    const t = bestLine(Math.round(y0) - 4, Math.round(y0) + my, (y) => rowEdge(y, ...midX));
    const b = bestLine(Math.round(y1) + 4, Math.round(y1) - my, (y) => rowEdge(y, ...midX));
    if (t != null) y0 = t; if (b != null) y1 = b;
    // 2) Left and right: where the top and bottom edges of the frame actually begin.
    const runEdge = (x) => (Math.abs(L(x, y0 + 1) - L(x, y0 - 1)) + Math.abs(L(x, y1 + 1) - L(x, y1 - 1))) / 2;
    const sideAt = (from, to) => {
      const step = from < to ? 1 : -1;
      const inner = [];
      for (let x = Math.round((x0 + x1) / 2); x !== to; x -= step) inner.push(runEdge(x)); // toward the side
      const strong = inner.sort((u, v) => u - v)[inner.length >> 1] * 0.4;
      // Walk outward from the inside until the frame's top/bottom edges stop for a few pixels.
      let last = null, gap = 0;
      for (let x = to; x !== from; x -= step) {
        if (runEdge(x) >= strong) { last = x; gap = 0; } else if (++gap > 3) break;
      }
      return last;
    };
    const l = sideAt(Math.round(x0) - 4, Math.round(x0) + mx);
    const r = sideAt(Math.round(x1) + 4, Math.round(x1) - mx);
    const lc = bestLine(Math.round(x0) - 4, Math.round(x0) + mx, (x) => colEdge(x, ...midY));
    const rc = bestLine(Math.round(x1) + 4, Math.round(x1) - mx, (x) => colEdge(x, ...midY));
    // Prefer the corner-based answer; fall back to the strongest vertical line.
    x0 = l ?? lc ?? x0;
    x1 = r ?? rc ?? x1;
    return rectPts(x0, y0, x1 - x0, y1 - y0);
  });
}
