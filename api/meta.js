/* /api/meta — 도감 딥링크(/DB/시리즈/작품)에 검색·링크 미리보기용 메타를 심어서 돌려준다.

   왜 필요했나: /DB/(.*) 가 통째로 정적 /DB 로 리라이트돼서, 작품이 몇 편이든
   <title>은 언제나 "特撮DEX — …" 하나였다. 검색엔진에는 페이지가 1개짜리 사이트로
   보이고, 카톡·디스코드·트위터에 링크를 붙이면 미리보기가 빈칸으로 떴다.

   동작: 배포된 /DB/ 의 HTML을 그대로 가져와(본문 무손실 → SPA 라우팅·모달 전부 그대로)
   <head> 의 title 만 갈아끼우고 description·og·twitter·canonical·JSON-LD 를 끼워 넣는다.
   DATA 파싱은 api/img.js 와 같은 findDataBlock + JSON.parse, 모듈 캐시 5분.

   ⚠️ 리라이트 소스는 반드시 /DB/(.+) 여야 한다 — (.*) 로 두면 /DB/ 자신도 이 함수로
   들어와서 아래 fetch가 자기 자신을 부르는 무한 루프가 된다.

   어떤 이유로든 실패하면 원본 HTML을 그대로 돌려준다. 메타가 없을 뿐 도감은 정상 동작. */

let CACHE = null, CACHE_AT = 0;
const TTL = 5 * 60 * 1000;
const SITE = '特撮DEX';

/* DB/index.html에서 const DATA = {...} 블록을 중괄호 깊이로 추출 (img.js와 동일 로직) */
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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
/* 설명문은 한 줄로 눌러 담고 자연스러운 지점에서 자른다 */
function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const p = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('· '), cut.lastIndexOf(' '));
  return (p > n * 0.6 ? cut.slice(0, p) : cut).trim() + '…';
}
function proto(host) { return /^localhost|^127\./.test(host) ? 'http' : 'https'; }
/* 공개 주소의 기준 도메인 — 프리뷰(*.vercel.app)에서도 canonical·og:url은 본 도메인을
   가리켜야 같은 문서가 두 주소로 색인되지 않는다. 로컬은 그대로 둔다. */
function pubBase(host) {
  if (/^localhost|^127\./.test(host)) return 'http://' + host;
  if (/\.vercel\.app$/i.test(host)) return 'https://paeaenteom.com';
  return 'https://' + host;
}
/* DATA의 이미지 경로(img/...)를 절대 URL로 — og:image는 상대경로를 못 읽는다 */
function absImg(p, host) {
  if (!p) return '';
  if (/^https?:\/\//.test(p)) return p;
  const rel = String(p).replace(/^\/+/, '');
  const path = (rel.startsWith('DB/') ? '/' + rel : '/DB/' + rel);
  return pubBase(host) + path.split('/').map(encodeURIComponent).join('/').replace(/%2F/g, '/');
}

async function getPage(host) {
  const now = Date.now();
  if (CACHE && now - CACHE_AT < TTL) return CACHE;
  const r = await fetch(`${proto(host)}://${host}/DB/`, { headers: { 'user-agent': 'toku-meta' } });
  if (!r.ok) throw new Error('DB page ' + r.status);
  const html = await r.text();
  const block = findDataBlock(html);
  CACHE = { html, DATA: block ? JSON.parse(block) : null };
  CACHE_AT = now;
  return CACHE;
}

function getSeries(DATA, key) {
  for (const g of Object.values(DATA || {})) if (g && g.series && g.series[key]) return g.series[key];
  return null;
}
/* 앱(DB/index.html)의 workSlug와 같은 규칙 — slug가 없으면 위치 기반 폴백 */
function workSlug(w, eIdx, wi) { return w.slug || `w${eIdx}-${wi}`; }
function findWork(s, slug) {
  for (let e = 0; e < (s.eras || []).length; e++) {
    const works = s.eras[e].works || [];
    for (let i = 0; i < works.length; i++) if (workSlug(works[i], e, i) === slug) return works[i];
  }
  return null;
}

/* 경로 → {title, desc, image, url, jsonld} */
function buildMeta(DATA, p, host) {
  const base = pubBase(host);
  const parts = String(p || '').split('/').filter(Boolean).map(x => {
    try { return decodeURIComponent(x); } catch (e) { return x; }
  });
  const skey = parts[0], wslug = parts[1];
  if (!skey || !DATA) return null;
  const s = getSeries(DATA, skey);
  if (!s) return null;

  if (wslug) {
    const w = findWork(s, wslug);
    if (!w) return null;
    const bits = [w.year, w.format, w.motif].filter(Boolean).join(' · ');
    const title = `${w.ko || w.jp || wslug} — ${SITE}`;
    const desc = clip(w.summary || bits || `${s.ko} 수록 작품`, 160);
    const url = `${base}/DB/${encodeURIComponent(skey)}/${encodeURIComponent(wslug)}`;
    const ld = {
      '@context': 'https://schema.org', '@type': 'TVSeries',
      name: w.ko || wslug, alternateName: w.jp || undefined,
      description: desc, url,
      image: absImg(w.imgBanner || w.img, host) || undefined,
      inLanguage: 'ja', countryOfOrigin: { '@type': 'Country', name: 'Japan' },
      partOfSeries: { '@type': 'CreativeWorkSeries', name: s.ko || s.en, url: `${base}/DB/${encodeURIComponent(skey)}` },
    };
    return { title, desc, image: absImg(w.imgBanner || w.img, host), url, jsonld: ld };
  }

  const cnt = (s.eras || []).reduce((a, e) => a + (e.works || []).filter(w => !w._todo).length, 0);
  const title = `${s.ko || s.en || skey} — ${SITE}`;
  const desc = clip(s.desc || `${s.ko} 아카이브`, 150) + (cnt ? ` (수록 ${cnt}편)` : '');
  const url = `${base}/DB/${encodeURIComponent(skey)}`;
  return {
    title, desc, image: absImg(s.img, host), url,
    jsonld: {
      '@context': 'https://schema.org', '@type': 'CollectionPage',
      name: s.ko || s.en, description: desc, url,
      image: absImg(s.img, host) || undefined,
    },
  };
}

function metaTags(m) {
  const t = [
    `<meta name="description" content="${esc(m.desc)}">`,
    `<link rel="canonical" href="${esc(m.url)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="PAEAENTEOM ${SITE}">`,
    `<meta property="og:locale" content="ko_KR">`,
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.desc)}">`,
    `<meta property="og:url" content="${esc(m.url)}">`,
    `<meta name="twitter:title" content="${esc(m.title)}">`,
    `<meta name="twitter:description" content="${esc(m.desc)}">`,
  ];
  if (m.image) {
    t.push(`<meta property="og:image" content="${esc(m.image)}">`);
    t.push(`<meta name="twitter:image" content="${esc(m.image)}">`);
    t.push(`<meta name="twitter:card" content="summary_large_image">`);
  } else {
    t.push(`<meta name="twitter:card" content="summary">`);
  }
  if (m.jsonld) t.push(`<script type="application/ld+json">${JSON.stringify(m.jsonld).replace(/</g, '\\u003c')}</script>`);
  return t.join('\n');
}

/* 원본 HTML의 <head>만 손본다 — title 교체 + 기존 메타 제거 후 새 메타 삽입.
   ⚠️ 기존 것을 지우지 않으면 정적 og:title 과 여기서 넣는 og:title 이 한 문서에
   둘 다 남는다. 파서마다 먼저/나중 중 무엇을 채택하는지가 달라서 미리보기가
   작품이 아니라 사이트 기본값으로 뜰 수 있다. 본문(<body>)은 건드리지 않는다. */
function stripMeta(head) {
  return head
    .replace(/[ \t]*<meta\s+name=["']description["'][^>]*>\s*\n?/gi, '')
    .replace(/[ \t]*<link\s+rel=["']canonical["'][^>]*>\s*\n?/gi, '')
    .replace(/[ \t]*<meta\s+property=["']og:[^"']*["'][^>]*>\s*\n?/gi, '')
    .replace(/[ \t]*<meta\s+name=["']twitter:[^"']*["'][^>]*>\s*\n?/gi, '')
    .replace(/[ \t]*<script\s+type=["']application\/ld\+json["']>[\s\S]*?<\/script>\s*\n?/gi, '');
}
function inject(html, m) {
  const hi = html.search(/<\/head>/i);
  const tag = `<title>${esc(m.title)}</title>`;
  if (hi === -1) {
    /* </head>가 없는 문서 — title만 갈아끼우고 끝낸다 */
    return /<title>[\s\S]*?<\/title>/i.test(html)
      ? html.replace(/<title>[\s\S]*?<\/title>/i, tag + '\n' + metaTags(m))
      : html;
  }
  let head = html.slice(0, hi);
  const rest = html.slice(hi);
  head = stripMeta(head);
  head = /<title>[\s\S]*?<\/title>/i.test(head)
    ? head.replace(/<title>[\s\S]*?<\/title>/i, tag)
    : head.replace(/<head([^>]*)>/i, (s) => s + '\n' + tag);
  return head + metaTags(m) + '\n' + rest;
}

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'paeaenteom.com';
  let p = '';
  try {
    const u = new URL(req.url, 'http://x');
    p = u.searchParams.get('p') || '';
  } catch (e) { /* p 없음 = 시리즈/작품 미지정 */ }

  /* 확장자가 붙은 경로(존재하지 않는 이미지·파일 등)는 HTML을 돌려주지 않는다 */
  if (/\.[a-zA-Z0-9]{2,5}$/.test(p)) {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('Not found');
    return;
  }

  try {
    const page = await getPage(host);
    let html = page.html;
    let matched = false;
    try {
      const m = buildMeta(page.DATA, p, host);
      if (m) { html = inject(html, m); matched = true; }
    } catch (e) { /* 메타 생성 실패 — 원본 그대로 */ }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    /* 매칭된 페이지만 오래 캐시 — 없는 주소는 짧게 */
    res.setHeader('cache-control', matched
      ? 'public, s-maxage=300, stale-while-revalidate=86400'
      : 'public, s-maxage=60');
    res.end(html);
  } catch (e) {
    /* 원본조차 못 가져오면 정적 도감으로 넘긴다 — 최소한 사이트는 열린다 */
    res.statusCode = 302;
    res.setHeader('location', '/DB');
    res.end('');
  }
};
