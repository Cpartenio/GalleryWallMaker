'use strict';
// "Ideas": framed art that fits the open space on the wall and goes with the colours already there.
// Sources, best first: Amazon Creators API products (via the server, once the account qualifies),
// hand-picked products in suggestions.json, and always-available "shop this size" Amazon searches.
// Uses S, mkCanvas, el, openSheet, closeSheet, toast, inches, save, updateBar, draw from app.js.

const FRAME_SIZES = [[5, 7], [8, 10], [11, 14], [12, 12], [12, 16], [16, 20], [18, 24], [20, 20], [24, 36]];
const COLOR_NAMES = [
  ['black', [25, 25, 25]], ['charcoal', [60, 62, 66]], ['gray', [128, 128, 128]], ['white', [245, 245, 242]],
  ['cream', [240, 230, 205]], ['beige', [215, 195, 165]], ['tan', [190, 150, 105]], ['brown', [110, 75, 50]],
  ['terracotta', [200, 105, 70]], ['rust', [170, 75, 40]], ['red', [190, 40, 45]], ['blush', [230, 180, 175]],
  ['pink', [225, 120, 160]], ['coral', [245, 125, 100]], ['orange', [235, 140, 40]], ['mustard', [215, 170, 50]],
  ['yellow', [240, 210, 70]], ['olive', [120, 120, 50]], ['sage', [160, 175, 140]], ['green', [60, 140, 75]],
  ['forest green', [35, 80, 50]], ['teal', [40, 125, 125]], ['turquoise', [60, 190, 190]], ['sky blue', [135, 185, 225]],
  ['blue', [45, 95, 175]], ['navy', [30, 45, 85]], ['lavender', [180, 165, 215]], ['purple', [110, 60, 140]],
];

let config = null;
async function ideasConfig() {
  config ||= fetch('config.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return config;
}
function amazonUrl(cfg, keywords) {
  const u = new URL(`https://${cfg.amazonDomain || 'www.amazon.com'}/s`);
  u.searchParams.set('k', keywords);
  if (cfg.amazonTag) u.searchParams.set('tag', cfg.amazonTag);
  return u.href;
}
function withTag(cfg, url) {
  try {
    const u = new URL(url);
    if (cfg.amazonTag && !u.searchParams.get('tag')) u.searchParams.set('tag', cfg.amazonTag);
    return u.href;
  } catch { return url; }
}

// ---------- colour palette of what's on the wall ----------
function nameOf(rgb) {
  let best = null, bd = Infinity;
  for (const [n, c] of COLOR_NAMES) {
    // Weighted RGB distance (cheap stand-in for a perceptual one).
    const d = 2 * (rgb[0] - c[0]) ** 2 + 4 * (rgb[1] - c[1]) ** 2 + 3 * (rgb[2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
function wallPalette() {
  const px = [];
  for (const p of S.pieces) {
    if (p.hidden || p.idea) continue;
    const c = mkCanvas(32, 32), g = c.getContext('2d');
    // Skip the outer 15% (frame + mat) so the artwork's colours dominate.
    const iw = p.img.width, ih = p.img.height;
    g.drawImage(p.img, iw * 0.15, ih * 0.15, iw * 0.7, ih * 0.7, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!px.length) return [];
  // k-means, k = 6, a few rounds.
  let cents = Array.from({ length: 6 }, (_, i) => px[Math.floor((i + 0.5) * px.length / 6)].slice());
  let assign = new Array(px.length).fill(0);
  for (let round = 0; round < 8; round++) {
    const sums = cents.map(() => [0, 0, 0, 0]);
    px.forEach((p, i) => {
      let bi = 0, bd = Infinity;
      cents.forEach((c, k) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = k; } });
      assign[i] = bi;
      const s = sums[bi]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
    });
    cents = sums.map((s, k) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : cents[k]));
  }
  const counts = cents.map((_, k) => assign.filter((a) => a === k).length);
  const sat = (c) => { const mx = Math.max(...c), mn = Math.min(...c); return mx ? (mx - mn) / mx : 0; };
  // Favour colours that are both common and colourful; neutrals still count, just less.
  const ranked = cents.map((c, k) => ({ rgb: c.map(Math.round), score: counts[k] * (0.35 + sat(c)), name: nameOf(c) }))
    .sort((a, b) => b.score - a.score);
  const out = [];
  for (const r of ranked) if (!out.some((o) => o.name === r.name)) out.push(r);
  return out.slice(0, 4);
}

// ---------- open space on the wall ----------
// Largest empty rectangle (in inches) around the arrangement, keeping a gap from every picture.
function openSpace() {
  const ppi = S.pxPerInch, wall = S.clean;
  const vis = S.pieces.filter((p) => !p.hidden && !p.idea);
  let area;
  if (vis.length) {
    const x0 = Math.min(...vis.map((p) => p.x)), y0 = Math.min(...vis.map((p) => p.y));
    const x1 = Math.max(...vis.map((p) => p.x + p.w)), y1 = Math.max(...vis.map((p) => p.y + p.h));
    const mx = Math.max(12 * ppi, (x1 - x0) * 0.2), my = Math.max(10 * ppi, (y1 - y0) * 0.2);
    area = { x: Math.max(0, x0 - mx), y: Math.max(0, y0 - my), w: 0, h: 0 };
    area.w = Math.min(wall.width, x1 + mx) - area.x; area.h = Math.min(wall.height, y1 + my) - area.y;
  } else {
    area = { x: wall.width * 0.2, y: wall.height * 0.15, w: wall.width * 0.6, h: wall.height * 0.45 };
  }
  // Occupancy grid at 1 cell per inch.
  const gw = Math.max(1, Math.floor(area.w / ppi)), gh = Math.max(1, Math.floor(area.h / ppi));
  const gap = 2.5; // inches of breathing room around existing pictures
  const busy = new Uint8Array(gw * gh);
  for (const p of vis) {
    const cx0 = Math.floor((p.x - area.x) / ppi - gap), cy0 = Math.floor((p.y - area.y) / ppi - gap);
    const cx1 = Math.ceil((p.x + p.w - area.x) / ppi + gap), cy1 = Math.ceil((p.y + p.h - area.y) / ppi + gap);
    for (let y = Math.max(0, cy0); y < Math.min(gh, cy1); y++) for (let x = Math.max(0, cx0); x < Math.min(gw, cx1); x++) busy[y * gw + x] = 1;
  }
  // Maximal rectangle via histogram stacks.
  const hist = new Int32Array(gw);
  let best = { w: 0, h: 0, x: 0, y: 0, a: 0 };
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) hist[x] = busy[y * gw + x] ? 0 : hist[x] + 1;
    const stack = [];
    for (let x = 0; x <= gw; x++) {
      const hgt = x < gw ? hist[x] : 0;
      let start = x;
      while (stack.length && stack[stack.length - 1][1] >= hgt) {
        const [sx, sh] = stack.pop();
        // Score by usefulness for a frame, not raw area: a long thin strip is no good. Count only
        // the part within 2:1 of square, so 30×24 beats 83×12.
        const w = x - sx, short = Math.min(w, sh), long = Math.min(Math.max(w, sh), 2 * short);
        const a = short * long;
        if (a > best.a) best = { a, w, h: sh, x: sx, y: y - sh + 1 };
        start = sx;
      }
      stack.push([start, hgt]);
    }
  }
  return { w: best.w, h: best.h, px: { x: area.x + best.x * ppi, y: area.y + best.y * ppi, w: best.w * ppi, h: best.h * ppi } };
}

function fittingSizes(space) {
  const fits = [];
  for (const [a, b] of FRAME_SIZES) {
    for (const [w, h] of a === b ? [[a, b]] : [[a, b], [b, a]]) {
      if (w <= space.w && h <= space.h) fits.push([w, h]);
    }
  }
  // Largest first; keep a spread so there's something bold and something small.
  fits.sort((p, q) => q[0] * q[1] - p[0] * p[1]);
  const pick = [];
  for (const f of fits) if (pick.length < 4 && !pick.some((p) => Math.abs(p[0] * p[1] - f[0] * f[1]) < 30)) pick.push(f);
  return pick;
}

// ---------- preview art: an abstract print in the wall's colours, framed ----------
function mockArt(wIn, hIn, palette, seed = 1) {
  const k = 20; // px per inch for the preview
  const W = Math.round(wIn * k), H = Math.round(hIn * k);
  const c = mkCanvas(W, H), g = c.getContext('2d');
  const frame = Math.max(6, 0.6 * k), mat = Math.max(10, Math.min(W, H) * 0.12);
  g.fillStyle = '#2b2622'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#f7f4ee'; g.fillRect(frame, frame, W - 2 * frame, H - 2 * frame);
  const ax = frame + mat, ay = frame + mat, aw = W - 2 * (frame + mat), ah = H - 2 * (frame + mat);
  const cols = (palette.length ? palette : [{ rgb: [180, 170, 150] }, { rgb: [90, 110, 120] }]).map((p) => `rgb(${p.rgb})`);
  g.fillStyle = '#efe9df'; g.fillRect(ax, ay, aw, ah);
  let r = seed * 9301 + 49297;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  g.save(); g.beginPath(); g.rect(ax, ay, aw, ah); g.clip();
  for (let i = 0; i < 5; i++) {
    g.fillStyle = cols[i % cols.length];
    g.globalAlpha = 0.9;
    if (i % 2) { g.beginPath(); g.arc(ax + rnd() * aw, ay + rnd() * ah, (0.18 + rnd() * 0.3) * Math.min(aw, ah), 0, Math.PI * 2); g.fill(); }
    else g.fillRect(ax + rnd() * aw * 0.6, ay + rnd() * ah * 0.6, aw * (0.25 + rnd() * 0.4), ah * (0.2 + rnd() * 0.4));
  }
  g.restore();
  return c;
}

// Load a product photo into a canvas (only if the image host allows it; otherwise use the mock).
function loadProductImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = mkCanvas(img.naturalWidth, img.naturalHeight);
        c.getContext('2d').drawImage(img, 0, 0);
        c.getContext('2d').getImageData(0, 0, 1, 1); // throws if the canvas got tainted
        resolve(c);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// Put an idea on the wall at its real size, centred in the open space.
async function tryOnWall(idea, space) {
  const ppi = S.pxPerInch;
  let art = idea.image ? await loadProductImage(idea.image) : null;
  if (!art) art = mockArt(idea.w, idea.h, idea.palette || [], idea.seed);
  const w = idea.w * ppi, h = idea.h * ppi;
  const pc = {
    id: nextId++, name: idea.label, img: art, w, h,
    x: space.px.x + (space.px.w - w) / 2, y: space.px.y + (space.px.h - h) / 2,
    original: false, locked: true, hidden: false, idea: true, link: idea.url,
  };
  S.pieces.push(pc);
  S.piece = pc;
  closeSheet();
  save();
  updateBar();
  draw();
  toast(`Placed at ${inches(w)} × ${inches(h)}. Drag it around; "Shop" opens it on Amazon.`, 4500);
}

// ---------- the Ideas sheet ----------
async function openIdeas() {
  if (!S.pxPerInch) {
    openSheet('Art that fits your wall', (body) => {
      body.append(el('p', { className: 'sheet-note', textContent: 'To suggest art that fits, the app needs to know how big things are. Give one picture its real size (or use the ruler sheet), and every suggestion will be sized to your wall.' }));
      body.append(el('div', { className: 'sheet-actions' }, el('button', { textContent: 'Not now', onclick: closeSheet }), el('button', {
        className: 'primary', textContent: 'Set a real size', onclick: () => {
          closeSheet();
          const ref = S.pieces.filter((x) => !x.hidden).sort((a, b) => b.w * b.h - a.w * a.h)[0];
          if (!ref) return toast('Add a picture first, then give it its real size.');
          S.piece = ref; updateBar(); draw(); setSize(ref);
        },
      })));
    });
    return;
  }
  const cfg = await ideasConfig();
  const palette = wallPalette();
  const space = openSpace();
  const sizes = fittingSizes(space);
  const colorWords = palette.slice(0, 2).map((p) => p.name).join(' and ');

  openSheet('Art that fits your wall', (body) => {
    const summary = el('div', { className: 'ideas-summary' });
    summary.append(el('span', { textContent: space.w >= 5 ? `Open space: about ${space.w}″ × ${space.h}″` : 'Not much open space; try hiding a picture in Layers.' }));
    const sw = el('span', { className: 'swatches' });
    for (const p of palette) sw.append(el('i', { title: p.name, style: `background: rgb(${p.rgb})` }));
    if (palette.length) summary.append(sw, el('span', { textContent: palette.map((p) => p.name).join(', ') }));
    body.append(summary);

    const list = el('div', { className: 'ideas' });
    body.append(list);
    const card = (idea) => {
      const thumb = el('div', { className: 'idea-thumb' });
      if (idea.image) thumb.append(el('img', { src: idea.image, alt: '', loading: 'lazy' }));
      else { const m = mockArt(idea.w, idea.h, palette, idea.seed); m.className = 'mock'; thumb.append(m); }
      const meta = el('div', { className: 'idea-meta' },
        el('b', { textContent: idea.title }),
        el('span', { textContent: [`${idea.w} × ${idea.h} in`, idea.price].filter(Boolean).join(' · ') }));
      const actions = el('div', { className: 'idea-actions' },
        el('button', { textContent: 'Try on wall', onclick: () => tryOnWall({ ...idea, palette }, space) }),
        el('a', { className: 'button', href: idea.url, target: '_blank', rel: 'noopener sponsored', textContent: idea.image ? 'View' : 'Shop' }));
      return el('div', { className: 'idea' }, thumb, meta, actions);
    };
    const fits = (it) => it.w && it.h && it.w <= space.w && it.h <= space.h;

    // Always-available searches for each size that fits.
    const searchIdeas = sizes.map(([w, h], i) => ({
      title: `${w}×${h} framed prints${colorWords ? `, ${colorWords}` : ''}`,
      label: `Idea: ${w}×${h}`, w, h, seed: i + 1,
      url: amazonUrl(cfg, `framed wall art ${w}x${h} ${palette.slice(0, 2).map((p) => p.name).join(' ')}`.trim()),
    }));
    if (!sizes.length) list.append(el('p', { className: 'sheet-note', textContent: 'No standard frame size fits the open space. Hide or move a picture to make room.' }));
    searchIdeas.forEach((it) => list.append(card(it)));

    // Products: hand-picked list and (if configured) the Creators API. Shown first when they fit.
    const addProducts = (items) => {
      const good = items.filter(fits).slice(0, 6);
      for (const it of good.reverse()) list.prepend(card({ ...it, url: withTag(cfg, it.url), label: it.title.slice(0, 40) }));
    };
    fetch('suggestions.json').then((r) => (r.ok ? r.json() : [])).then((items) => {
      const colorSet = new Set(palette.map((p) => p.name));
      addProducts(items.map((it) => ({ ...it, score: (it.colors || []).filter((c) => colorSet.has(c)).length }))
        .sort((a, b) => b.score - a.score));
    }).catch(() => {});
    if (sizes.length) {
      fetch('api/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ colors: palette.map((p) => p.name).slice(0, 2), sizes: sizes.slice(0, 2) }),
      }).then((r) => (r.ok ? r.json() : { items: [] })).then((d) => addProducts(d.items || [])).catch(() => {});
    }

    if (cfg.amazonTag) body.append(el('p', { className: 'disclosure', textContent: 'As an Amazon Associate, Gallery Wall Maker earns from qualifying purchases.' }));
  });
}
