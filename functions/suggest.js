// Product suggestions from the Amazon Creators API (the successor to PA-API 5).
// Needs an Associates account that qualifies for API access (Amazon currently requires 10
// qualifying sales in the past 30 days) and these environment variables:
//   amazonClientId, amazonClientSecret, amazonPartnerTag   (from Associates Central → Creators API)
//   amazonMarketplace  (default www.amazon.com)
//   amazonTokenUrl     (default https://api.amazon.com/auth/o2/token, the North America endpoint)
// Without them, POST /api/suggest answers 501 and the app shows its "shop this size" ideas only.
const API = 'https://creatorsapi.amazon/catalog/v1/searchItems';
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();
let token = null;

const env = (k) => process.env[k] || '';

async function accessToken() {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const r = await fetch(env('amazonTokenUrl') || 'https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials', client_id: env('amazonClientId'),
      client_secret: env('amazonClientSecret'), scope: 'creatorsapi::default',
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Amazon token error ${r.status}`);
  token = { value: j.access_token, expires: Date.now() + (j.expires_in || 3600) * 1000 };
  return token.value;
}

// Inches from a { displayValue, unit } dimension, or null.
function toInches(d) {
  const v = parseFloat(d?.displayValue ?? d?.value);
  if (!(v > 0)) return null;
  const u = String(d.unit || '').toLowerCase();
  return u.startsWith('cent') || u === 'cm' ? v / 2.54 : u.startsWith('mill') || u === 'mm' ? v / 25.4 : v;
}
// "…Framed Print 16x20 inch…" → [16, 20]
function sizeFromTitle(t) {
  const m = /(\d{1,2}(?:\.\d+)?)\s*(?:"|in(?:ch(?:es)?)?)?\s*[x×X]\s*(\d{1,2}(?:\.\d+)?)\s*(?:"|in|inch|inches)?/.exec(t || '');
  return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
}

function normalize(item) {
  const title = item.itemInfo?.title?.displayValue || '';
  const dims = item.itemInfo?.productInfo?.itemDimensions || {};
  let w = toInches(dims.width), h = toInches(dims.height);
  if (!(w && h)) [w, h] = sizeFromTitle(title) || [null, null];
  const listing = item.offersV2?.listings?.[0];
  return {
    asin: item.asin, title, url: item.detailPageURL,
    image: item.images?.primary?.large?.url || item.images?.primary?.medium?.url || null,
    price: listing?.price?.money?.displayAmount || null,
    w: w ? Math.round(w * 4) / 4 : null, h: h ? Math.round(h * 4) / 4 : null,
  };
}

async function search(keywords) {
  const hit = cache.get(keywords);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.items;
  const marketplace = env('amazonMarketplace') || 'www.amazon.com';
  const r = await fetch(API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', 'x-marketplace': marketplace,
    },
    body: JSON.stringify({
      keywords, searchIndex: 'HomeAndKitchen', itemCount: 10, partnerTag: env('amazonPartnerTag'), marketplace,
      resources: ['images.primary.large', 'itemInfo.title', 'itemInfo.productInfo', 'offersV2.listings.price'],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Amazon search error ${r.status}`);
  const items = (j.searchResult?.items || j.SearchResult?.Items || []).map(normalize).filter((i) => i.url && i.title);
  cache.set(keywords, { t: Date.now(), items });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return items;
}

// body: { colors: ['sage', 'terracotta'], sizes: [[16, 20], [11, 14]] }
async function suggestRequest(body) {
  if (!env('amazonClientId') || !env('amazonClientSecret') || !env('amazonPartnerTag')) {
    return { status: 501, body: { error: 'Amazon API not configured', items: [] } };
  }
  const colors = (Array.isArray(body?.colors) ? body.colors : []).filter((c) => /^[a-z ]{2,20}$/.test(c)).slice(0, 2);
  const sizes = (Array.isArray(body?.sizes) ? body.sizes : []).filter((s) => Array.isArray(s) && s.every((n) => n > 0 && n < 100)).slice(0, 2);
  const queries = (sizes.length ? sizes : [null]).map((s) => ['framed wall art', ...colors, s ? `${s[0]}x${s[1]}` : ''].join(' ').trim());
  try {
    const results = await Promise.all(queries.map(search));
    const seen = new Set(), items = [];
    for (const it of results.flat()) if (!seen.has(it.asin)) { seen.add(it.asin); items.push(it); }
    return { status: 200, body: { items } };
  } catch (e) {
    return { status: 502, body: { error: e.message, items: [] } };
  }
}

module.exports = { suggestRequest, sizeFromTitle, normalize };
