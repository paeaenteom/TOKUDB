/* /api/probe — IMAGINATION 신착 페이지가 도쿄 리전(hnd1)에서 왜 막히는지 진단용 (임시).
   각 시도의 status·최종URL·본문 표식·아이템 수를 반환한다. 확인 후 삭제 예정. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

/* 실제 Chrome 내비게이션이 보내는 헤더 풀세트 */
const NAV = {
  'user-agent': UA,
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  'cache-control': 'max-age=0'
};
const BASIC = { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'ja,en;q=0.8' };

const ITEM_RE = /<a[^>]+href="(\/contents\/[A-Za-z0-9_-]+)"[\s\S]{0,900}?alt="([^"]{2,})"/g;

async function attempt(name, url, headers, cookie) {
  const r = { name, url };
  try {
    const h = Object.assign({}, headers);
    if (cookie) h['cookie'] = cookie;
    const res = await fetch(url, { headers: h, redirect: 'follow' });
    r.status = res.status;
    r.finalUrl = res.url;
    r.server = res.headers.get('server') || '';
    r.via = res.headers.get('via') || '';
    r.xcache = res.headers.get('x-cache') || '';
    const t = await res.text();
    r.len = t.length;
    r.geoMsg = /ご指定のページにアクセスできません/.test(t);
    r.geoJson = /GEO_BLOCKED/.test(t);
    r.title = (t.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    let m, n = 0; const re = new RegExp(ITEM_RE.source, 'g');
    while ((m = re.exec(t))) n++;
    r.items = n;
    r.head = t.slice(0, 160).replace(/\s+/g, ' ');
  } catch (e) { r.error = String((e && e.message) || e); }
  return r;
}

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const out = [];
  /* A: 현행 news.js와 동일 (기본 헤더, 파라미터 없음) */
  out.push(await attempt('A-basic', 'https://imagination.m-78.jp/list/slider_new', BASIC));
  /* B: 유빈 지정 URL + 기본 헤더 */
  out.push(await attempt('B-type1-basic', 'https://imagination.m-78.jp/list/slider_new?type=1', BASIC));
  /* C: 유빈 지정 URL + 실브라우저 내비게이션 헤더 풀세트 */
  out.push(await attempt('C-type1-nav', 'https://imagination.m-78.jp/list/slider_new?type=1', NAV));
  /* D: 쿠키 워밍업 — 톱 페이지 먼저 → set-cookie 들고 재시도 */
  try {
    const top = await fetch('https://imagination.m-78.jp/', { headers: NAV, redirect: 'follow' });
    const sc = (typeof top.headers.getSetCookie === 'function' ? top.headers.getSetCookie() : [top.headers.get('set-cookie')].filter(Boolean))
      .map(s => String(s).split(';')[0]).join('; ');
    out.push({ name: 'D-top', status: top.status, finalUrl: top.url, cookieLen: sc.length,
      title: ((await top.text()).match(/<title>([^<]*)<\/title>/) || [])[1] || '' });
    const h2 = Object.assign({}, NAV, { 'sec-fetch-site': 'same-origin', 'referer': 'https://imagination.m-78.jp/' });
    out.push(await attempt('D-type1-cookie', 'https://imagination.m-78.jp/list/slider_new?type=1', h2, sc || undefined));
  } catch (e) { out.push({ name: 'D', error: String((e && e.message) || e) }); }
  /* E: API 호스트 지오 판정 (참고용) */
  out.push(await attempt('E-api-host', 'https://api.imagination.m-78.jp/', BASIC));
  res.end(JSON.stringify({ region: process.env.VERCEL_REGION || '?', results: out }, null, 1));
};
