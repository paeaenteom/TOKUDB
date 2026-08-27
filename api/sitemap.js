/* /api/sitemap → /sitemap.xml — 도감 DATA를 그대로 순회해 색인용 주소 목록을 만든다.

   손으로 관리하는 파일이 아니라 배포된 /DB/ 를 읽어 만들기 때문에, 에디터로 작품을
   추가하고 배포하면 사이트맵에 자동으로 실린다.

   싣는 것: 홈 · 도감 루트 · 시리즈(수록작 있는 것만) · 작품(_todo 제외) · 이미지 검색 */

let CACHE = null, CACHE_AT = 0;
const TTL = 5 * 60 * 1000;

function findDataBlock(fullText) {
  const marker = 'const DATA = ';
  const mi = fullText.indexOf(marker);
  if (mi === -1) return null;
  const os = mi + marker.length;
  if (fullText[os] !== '{') return null;
  let depth = 0, i = os, inStr = false, sc = '', ef = false;
  for (; i < fullText.length; i++) {
    const ch = fullText[i];
    if (inStr) {
      if (ef) { ef = false; }
      else if (ch === '\\') { ef = true; }
      else if (ch === sc) { inStr = false; }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; sc = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return fullText.slice(os, i);
}

function proto(host) { return /^localhost|^127\./.test(host) ? 'http' : 'https'; }
/* 프리뷰(*.vercel.app)에서도 사이트맵은 본 도메인 주소를 실어야 색인이 갈리지 않는다 */
function pubBase(host) {
  if (/^localhost|^127\./.test(host)) return 'http://' + host;
  if (/\.vercel\.app$/i.test(host)) return 'https://paeaenteom.com';
  return 'https://' + host;
}
function xesc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function u(base, path) { return base + '/' + path.split('/').filter(Boolean).map(encodeURIComponent).join('/'); }

async function getData(host) {
  const now = Date.now();
  if (CACHE && now - CACHE_AT < TTL) return CACHE;
  const r = await fetch(`${proto(host)}://${host}/DB/`, { headers: { 'user-agent': 'toku-sitemap' } });
  if (!r.ok) throw new Error('DB page ' + r.status);
  const block = findDataBlock(await r.text());
  CACHE = block ? JSON.parse(block) : null;
  CACHE_AT = now;
  return CACHE;
}

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'paeaenteom.com';
  const base = pubBase(host);
  const rows = [
    { loc: base + '/', pri: '1.0', freq: 'weekly' },
    { loc: base + '/DB', pri: '0.9', freq: 'weekly' },
    { loc: base + '/DB/search', pri: '0.6', freq: 'monthly' },
  ];
  try {
    const DATA = await getData(host);
    for (const g of Object.values(DATA || {})) {
      if (!g || !g.series) continue;
      for (const skey of Object.keys(g.series)) {
        const s = g.series[skey];
        const works = [];
        (s.eras || []).forEach((era, eIdx) => (era.works || []).forEach((w, wi) => {
          if (!w._todo) works.push(w.slug || `w${eIdx}-${wi}`);
        }));
        if (!works.length) continue; /* 아직 빈 시리즈는 색인하지 않는다 */
        rows.push({ loc: u(base, 'DB/' + skey), pri: '0.8', freq: 'weekly' });
        for (const slug of works) rows.push({ loc: u(base, 'DB/' + skey + '/' + slug), pri: '0.7', freq: 'monthly' });
      }
    }
  } catch (e) { /* 데이터를 못 읽어도 기본 주소는 낸다 */ }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + rows.map(r => `  <url><loc>${xesc(r.loc)}</loc><changefreq>${r.freq}</changefreq><priority>${r.pri}</priority></url>`).join('\n')
    + '\n</urlset>\n';

  res.statusCode = 200;
  res.setHeader('content-type', 'application/xml; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  res.end(xml);
};
