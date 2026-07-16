/* /api/news — TTFC + 츠부라야 이매지네이션 "신착(新着)" 통합 프록시.
   브라우저는 CORS 때문에 두 사이트를 직접 못 읽으므로 서버가 대신 긁어와 JSON으로 반환한다.

   1순위 소스 (실제 신착 목록 — 유빈 지정):
   - TTFC: https://pc.tokusatsu-fc.jp/new  (카드 <a href=".../movies/{id}/..."> + img alt=제목 + 배지 카테고리)
   - IMAG: https://imagination.m-78.jp/list/slider_new  (<a href="/contents/{id}"> + img alt=제목)
   ⚠️ 두 서비스 모두 일본 외 접속 차단(GEO_BLOCKED). vercel.json "regions":["hnd1"](도쿄)로 함수를
      일본 리전에서 실행해 통과시킨다. 그래도 차단되면(클라우드 IP 차단 등) 아래 폴백으로 자동 전환.

   폴백 소스 (공개 뉴스 — 지역 제한 없음):
   - TTFC: tokusatsu-fc.jp 홈 뉴스 하이라이트
   - IMAG: m-78.jp WordPress API 動画配信 카테고리(id 7)

   반환: { updatedAt, items:[{src,id,title,date,url,release,via}] }  캐시 5분(웜 인스턴스). */

let CACHE = null, CACHE_AT = 0;
const TTL = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const HDRS = { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'ja,en;q=0.8' };
const RELEASE_RE = /配信|見放題|最新話|新エピソード|新作|独占|プレミア|レンタル|放送開始|ガイド|公開/;

function dec(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCodePoint(+n); } catch (e) { return m; } })
    .trim();
}
function strip(s) { return dec(String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ')).trim(); }

/* ── TTFC 1순위: pc.tokusatsu-fc.jp/new (신착 카드) + 각 작품의 "New" 배지 에피소드 ── */
async function ttfcNew() {
  const r = await fetch('https://pc.tokusatsu-fc.jp/new', { headers: HDRS });
  if (!r.ok) return [];
  const t = await r.text();
  const out = [], seen = new Set(), works = [];
  /* 카드 블록: <a href="https://pc.tokusatsu-fc.jp/movies/{id}/..."> … [배지 img alt="">카테고리</p>] … <img alt="제목"> … </a> */
  const blocks = t.split(/<a [^>]*href="https:\/\/pc\.tokusatsu-fc\.jp\/movies\//).slice(1);
  for (const b of blocks) {
    const idm = b.match(/^(\d+)\//); if (!idm) continue;
    const id = idm[1]; if (seen.has(id)) continue;
    const chunk = b.slice(0, b.indexOf('</a>') === -1 ? 2500 : b.indexOf('</a>'));
    const altm = chunk.match(/alt="([^"]{2,})"/);
    if (!altm) continue;
    seen.add(id);
    const catm = chunk.match(/alt=""[^>]*>\s*([^<]{2,14})\s*<\/p>/);
    const cat = catm ? strip(catm[1]) : '';
    const title = dec(altm[1]);
    works.push({ id, title });
    out.push({ src: 'TTFC', id: 'ttfc-m' + id, title: title + (cat ? ' 〔' + cat + '〕' : ''), date: '', url: 'https://pc.tokusatsu-fc.jp/movies/' + id + '/movie-stories', release: true, via: 'new' });
  }
  /* 신착 작품마다 에피소드 목록(/movies/{id}/movie-stories)을 훑어 "New" 배지 달린
     에피소드를 개별 알림 항목으로 추가 — 예: ゼッツ Case43, ギャバン 第22話.
     배지는 원본 HTML에 <p class="…uppercase">New</p>로 존재(비로그인·서버에서도 보임). */
  const eps = [], sSeen = new Set();
  await Promise.all(works.slice(0, 10).map(async (w) => {
    try {
      const pr = await fetch('https://pc.tokusatsu-fc.jp/movies/' + w.id + '/movie-stories', { headers: HDRS });
      if (!pr.ok) return;
      const p = await pr.text();
      const ebs = p.split(/<a[^>]+href="https:\/\/pc\.tokusatsu-fc\.jp\/movies\/\d+\/movie-stories\//).slice(1);
      for (const b of ebs) {
        const sm = b.match(/^(\d+)"/); if (!sm) continue;
        const sid = sm[1]; if (sSeen.has(sid)) continue; sSeen.add(sid);
        const chunk = b.slice(0, 2200);
        if (!/>\s*New\s*<\/p>/.test(chunk)) continue; /* New 배지 에피소드만 */
        const am = chunk.match(/alt="([^"]{2,})"/); if (!am) continue;
        eps.push({ src: 'TTFC', id: 'ttfc-s' + sid, title: w.title + ' · ' + dec(am[1]), date: '', url: 'https://pc.tokusatsu-fc.jp/movies/' + w.id + '/movie-stories/' + sid, release: true, via: 'new' });
      }
    } catch (e) { /* 개별 작품 실패는 무시 */ }
  }));
  eps.sort((a, b) => parseInt(b.id.slice(6), 10) - parseInt(a.id.slice(6), 10)); /* 최신 등록(id 큰 것) 먼저 */
  return out.slice(0, 12).concat(eps.slice(0, 15));
}

/* ── TTFC 폴백: 공개 홈 뉴스 하이라이트 ── */
async function ttfcNewsFallback() {
  const r = await fetch('https://tokusatsu-fc.jp/', { headers: HDRS });
  if (!r.ok) return [];
  const t = await r.text();
  const out = [], seen = new Set();
  const re = /<img src="files\/news\/(\d+)\/[^"]*"[^>]*>[\s\S]{0,600}?<div class="date">([\s\S]*?)<\/div>[\s\S]{0,300}?<div class="ttl">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(t))) {
    const id = m[1]; if (seen.has(id)) continue; seen.add(id);
    const title = strip(m[3]); if (!title) continue;
    out.push({ src: 'TTFC', id: 'ttfc-' + id, title, date: strip(m[2]), url: 'https://tokusatsu-fc.jp/files/news/' + id + '/', release: RELEASE_RE.test(title), via: 'news' });
  }
  return out.slice(0, 10);
}

/* ── IMAG 1순위: imagination.m-78.jp/list/slider_new?type=1 (신착) ──
   이 페이지는 React SSR — 아이템이 <a> 마크업이 아니라 이스케이프된 JSON 페이로드로 들어있다:
   \"is_series\":false,\"code\":\"Video_00281\",\"name\":\"...\",...\"display_start_datetime\":\"2026/07/11 09:30:00\"
   (도쿄 hnd1에선 지오 통과 확인됨 — 예전 폴백 전환의 원인은 지오가 아니라 이 마크업 차이였음.
    Video_* 코드는 /video/, 그 외(Yomi_* 등)는 /contents/ 상세 경로.) */
async function imagNew() {
  const r = await fetch('https://imagination.m-78.jp/list/slider_new?type=1', { headers: HDRS });
  if (!r.ok) return [];
  const t = await r.text();
  /* 지역 차단 에러 페이지 감지 */
  if (/ご指定のページにアクセスできません|GEO_BLOCKED/.test(t)) return [];
  const out = [], seen = new Set();
  const re = /\\"is_series\\":(?:true|false),\\"code\\":\\"([A-Za-z0-9_]+)\\",\\"name\\":\\"((?:[^"\\]|\\.)*?)\\",\\"content_type\\":\d+[\s\S]{0,200}?\\"display_start_datetime\\":\\"([^"\\]*)\\"/g;
  let m;
  while ((m = re.exec(t))) {
    const code = m[1]; if (seen.has(code)) continue; seen.add(code);
    let name = m[2];
    try { name = JSON.parse('"' + name.replace(/\\\\/g, '\\') + '"'); } catch (e) { name = name.replace(/\\(.)/g, '$1'); }
    const path = (code.indexOf('Video_') === 0 ? '/video/' : '/contents/') + code;
    out.push({ src: 'IMAG', id: 'imag-c-' + code, title: dec(name), date: String(m[3]).slice(0, 10).replace(/\//g, '-'), url: 'https://imagination.m-78.jp' + path, release: true, via: 'new' });
  }
  if (out.length) return out.slice(0, 12);
  /* 페이로드 구조가 바뀌면 렌더 마크업(구버전) 방식도 시도 */
  const re2 = /<a[^>]+href="(\/(?:contents|video)\/[A-Za-z0-9_-]+)"[\s\S]{0,900}?alt="([^"]{2,})"/g;
  while ((m = re2.exec(t))) {
    const path = m[1]; if (seen.has(path)) continue; seen.add(path);
    out.push({ src: 'IMAG', id: 'imag-c-' + path.split('/').pop(), title: dec(m[2]), date: '', url: 'https://imagination.m-78.jp' + path, release: true, via: 'new' });
  }
  return out.slice(0, 12);
}

/* ── IMAG 폴백: m-78 WordPress API 動画配信 카테고리 ── */
async function imagNewsFallback() {
  const r = await fetch('https://m-78.jp/wp-json/wp/v2/posts?categories=7&per_page=12&_fields=id,date,link,title', { headers: { 'user-agent': UA, 'accept': 'application/json' } });
  if (!r.ok) return [];
  const j = await r.json();
  if (!Array.isArray(j)) return [];
  return j.map(p => ({
    src: 'IMAG', id: 'imag-' + p.id, title: strip(p.title && p.title.rendered),
    date: String(p.date || '').slice(0, 10), url: p.link, release: true, via: 'news'
  })).filter(x => x.title).slice(0, 12);
}

async function tryOr(primary, fallback) {
  try { const a = await primary(); if (a && a.length) return a; } catch (e) { /* 차단·구조변경 → 폴백 */ }
  try { return await fallback(); } catch (e) { return []; }
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const now = Date.now();
    if (!CACHE || now - CACHE_AT > TTL) {
      const [ttfc, imag] = await Promise.all([
        tryOr(ttfcNew, ttfcNewsFallback),
        tryOr(imagNew, imagNewsFallback)
      ]);
      CACHE = { updatedAt: now, items: [...ttfc, ...imag] };
      CACHE_AT = now;
    }
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.end(JSON.stringify(CACHE));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String((e && e.message) || e), items: [] }));
  }
};
