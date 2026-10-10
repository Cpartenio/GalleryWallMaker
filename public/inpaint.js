'use strict';
// Free, on-device wall filling: the MI-GAN inpainting model (ONNX) runs in the browser with
// ONNX Runtime Web (WebGPU when available, otherwise WebAssembly). Nothing leaves the device.
// Uses mkCanvas(), copyCanvas(), clamp() from app.js.

const ORT_VERSION = '1.30.0';
const ORT_SOURCES = [
  `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`,
  'vendor/ort-local/', // optional local copy for offline development (not committed)
];
const MODEL_URL = 'models/migan_pipeline_v2.onnx';
const FILL_SIDE = 1024; // working size for the model: big holes need wall context around them

let ortReady = null;
let sessionReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`Could not load ${src}`)); };
    document.head.appendChild(s);
  });
}

function loadOrt() {
  ortReady ||= (async () => {
    for (const base of ORT_SOURCES) {
      try {
        const url = new URL(base, location.href).href; // the engine resolves its files against this
        await loadScript(`${url}ort.min.js`);
        ort.env.wasm.wasmPaths = url;
        // Threads need cross-origin isolation, which a plain static host doesn't give us.
        ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
        return;
      } catch { /* try the next source */ }
    }
    throw new Error('The AI engine could not be downloaded');
  })();
  ortReady.catch(() => { ortReady = null; });
  return ortReady;
}

// The model file is cached by the browser after the first download (~28 MB).
async function fetchModel(onProgress) {
  const cache = self.caches ? await caches.open('gallery-wall-models').catch(() => null) : null;
  let res = cache && (await cache.match(MODEL_URL));
  if (!res) {
    res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`Model download failed (${res.status})`);
    if (cache) await cache.put(MODEL_URL, res.clone()).catch(() => {});
  }
  const total = +res.headers.get('content-length') || 0;
  if (!res.body || !total || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const buf = new Uint8Array(total);
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.length;
    onProgress(got / total);
  }
  return buf;
}

function loadModel(onProgress) {
  sessionReady ||= (async () => {
    await loadOrt();
    const bytes = await fetchModel(onProgress);
    const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
    try {
      return await ort.InferenceSession.create(bytes, { executionProviders: providers });
    } catch (e) {
      if (providers[0] !== 'webgpu') throw e;
      return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    }
  })();
  sessionReady.catch(() => { sessionReady = null; });
  return sessionReady;
}

// Hole mask at any scale: each outline grown by `pad` (same shape the erase uses).
function holeMask(W, H, quads, pad, k = 1) {
  const c = mkCanvas(W * k, H * k), g = c.getContext('2d');
  g.scale(k, k);
  g.fillStyle = g.strokeStyle = '#000';
  g.lineJoin = 'miter';
  g.lineWidth = 2 * pad;
  for (const q of quads) {
    g.beginPath();
    q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.closePath();
    g.fill();
    g.stroke();
  }
  const a = g.getImageData(0, 0, c.width, c.height).data;
  const m = new Uint8Array(c.width * c.height);
  for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3] > 0 ? 1 : 0; // 1 = hole
  return { m, w: c.width, h: c.height };
}

// Run the model on the whole photo (scaled to FILL_SIDE) with every hole masked at once,
// so it never sees a frame it could copy. Returns a full-size canvas.
async function modelFill(photo, quads, pad, onProgress) {
  const session = await loadModel(onProgress);
  const k = Math.min(1, FILL_SIDE / Math.max(photo.width, photo.height));
  const w = Math.round(photo.width * k), h = Math.round(photo.height * k), n = w * h;
  const small = mkCanvas(w, h), sg = small.getContext('2d');
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(photo, 0, 0, w, h);
  const d = sg.getImageData(0, 0, w, h).data;
  const hole = holeMask(photo.width, photo.height, quads, pad, w / photo.width);
  const img = new Uint8Array(3 * n), mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    img[i] = d[i * 4]; img[n + i] = d[i * 4 + 1]; img[2 * n + i] = d[i * 4 + 2];
    mask[i] = hole.m[i] ? 0 : 255; // MI-GAN: 0 = fill this, 255 = keep
  }
  const out = await session.run({
    image: new ort.Tensor('uint8', img, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', mask, [1, 1, h, w]),
  });
  const o = out.result.data, id = sg.createImageData(w, h);
  for (let i = 0; i < n; i++) {
    id.data[i * 4] = o[i]; id.data[i * 4 + 1] = o[n + i]; id.data[i * 4 + 2] = o[2 * n + i]; id.data[i * 4 + 3] = 255;
  }
  sg.putImageData(id, 0, 0);
  const full = mkCanvas(photo.width, photo.height), fg = full.getContext('2d');
  fg.imageSmoothingQuality = 'high';
  fg.drawImage(small, 0, 0, full.width, full.height);
  return full;
}

// Seamless blending: measure the colour difference between the real wall and the fill all
// around each hole, spread it smoothly across the hole (a membrane / Laplace solve), and add it
// to the fill. The fill keeps its texture but takes on the wall's exact lighting at every edge.
// With gen = null this is a pure smooth fill of the hole from its surroundings.
function harmonize(photo, gen, quads, pad) {
  const W = photo.width, H = photo.height, S = 4; // solve on a 1/4-size grid; the correction is smooth
  const gw = Math.ceil(W / S), gh = Math.ceil(H / S);
  const hole = holeMask(W, H, quads, pad);
  const P = photo.getContext('2d').getImageData(0, 0, W, H).data;
  const G = gen ? gen.getContext('2d').getImageData(0, 0, W, H).data : null;
  // Grid cells touching a hole are unknown; others hold the average (photo − fill) difference.
  const unknown = new Uint8Array(gw * gh);
  const val = [new Float32Array(gw * gh), new Float32Array(gw * gh), new Float32Array(gw * gh)];
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let any = 0, s0 = 0, s1 = 0, s2 = 0, c = 0;
      for (let y = gy * S; y < Math.min(H, gy * S + S); y++) {
        for (let x = gx * S; x < Math.min(W, gx * S + S); x++) {
          const i = y * W + x;
          if (hole.m[i]) { any = 1; continue; }
          const j = i * 4;
          s0 += P[j] - (G ? G[j] : 0); s1 += P[j + 1] - (G ? G[j + 1] : 0); s2 += P[j + 2] - (G ? G[j + 2] : 0); c++;
        }
      }
      const g = gy * gw + gx;
      if (any) unknown[g] = 1;
      if (c) { val[0][g] = s0 / c; val[1][g] = s1 / c; val[2][g] = s2 / c; }
    }
  }
  // Successive over-relaxation on the unknown cells only.
  const cells = [];
  for (let g = 0; g < unknown.length; g++) if (unknown[g]) cells.push(g);
  if (!cells.length) return gen || copyCanvas(photo);
  // Start each unknown cell from the nearest known cells left/right/up/down (inverse-distance),
  // which is already close to the smooth answer, then polish with over-relaxation.
  const isKnown = (x, y) => x >= 0 && y >= 0 && x < gw && y < gh && !unknown[y * gw + x];
  for (const g of cells) {
    const x = g % gw, y = (g / gw) | 0;
    let wsum = 0;
    const acc = [0, 0, 0];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let d = 1;
      while (d < 4096) {
        const xx = x + dx * d, yy = y + dy * d;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) { d = 0; break; }
        if (isKnown(xx, yy)) break;
        d++;
      }
      if (!d || d >= 4096) continue;
      const k = (y + dy * d) * gw + x + dx * d, wgt = 1 / d;
      for (let c = 0; c < 3; c++) acc[c] += val[c][k] * wgt;
      wsum += wgt;
    }
    for (let c = 0; c < 3; c++) val[c][g] = wsum ? acc[c] / wsum : 0;
  }
  const nbs = cells.map((g) => {
    const x = g % gw, y = (g / gw) | 0, nb = [];
    if (x > 0) nb.push(g - 1); if (x < gw - 1) nb.push(g + 1);
    if (y > 0) nb.push(g - gw); if (y < gh - 1) nb.push(g + gw);
    return nb;
  });
  for (let it = 0; it < 500; it++) {
    for (let ci = 0; ci < cells.length; ci++) {
      const g = cells[ci], nb = nbs[ci];
      for (const ch of val) {
        let s = 0;
        for (const b of nb) s += ch[b];
        ch[g] += 1.9 * (s / nb.length - ch[g]);
      }
    }
  }
  // Apply the smooth correction inside the holes (bilinear from the grid).
  const out = gen ? copyCanvas(gen) : copyCanvas(photo);
  const og = out.getContext('2d'), od = og.getImageData(0, 0, W, H), o = od.data;
  const base = G || P;
  const sample = (ch, x, y) => {
    const fx = clamp(x / S - 0.5, 0, gw - 1), fy = clamp(y / S - 0.5, 0, gh - 1);
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
    const ax = fx - x0, ay = fy - y0;
    return (ch[y0 * gw + x0] * (1 - ax) + ch[y0 * gw + x1] * ax) * (1 - ay) + (ch[y1 * gw + x0] * (1 - ax) + ch[y1 * gw + x1] * ax) * ay;
  };
  const noise = gen ? 0 : 2.5; // a pure smooth fill looks plasticky without a little grain
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!unknown[((y / S) | 0) * gw + ((x / S) | 0)]) continue;
      const j = i * 4, n = noise ? (Math.random() - 0.5) * 2 * noise : 0;
      for (let c = 0; c < 3; c++) o[j + c] = (gen ? base[j + c] : 0) + sample(val[c], x, y) + n;
    }
  }
  og.putImageData(od, 0, 0);
  return out;
}

// Public entry point: returns a full-size canvas of the empty wall.
async function onDeviceFill(photo, quads, pad, onProgress) {
  let gen = null;
  try {
    gen = await modelFill(photo, quads, pad, onProgress);
  } catch (e) {
    console.warn('On-device model unavailable, using smooth fill:', e);
  }
  const filled = harmonize(photo, gen, quads, pad);
  // Paste only the holes back so the rest of the photo stays pixel-exact.
  const out = copyCanvas(photo);
  blendQuads(out, filled, quads, pad, Math.round(pad * 0.5), false); // already colour-matched
  return { canvas: out, usedModel: !!gen };
}
