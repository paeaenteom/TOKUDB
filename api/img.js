/* /i/이름/폼/행동 → 실제 이미지 파일로 302 리다이렉트 하는 리졸버.
   외부 사이트(<img src>)에서 한글 주소로 바로 이미지를 부를 수 있게 한다.
   예: /i/아카레인저/기본/전신 → /DB/img/gorenger/hero/AkaRanger.webp

   데이터 소스: 배포된 /DB/index.html 안의 `const DATA = {...}` 블록을 그대로 파싱해
   이미지 매핑을 만들고 모듈 캐시에 5분간 보관한다 — 별도 매니페스트 파일 불필요,
   에디터로 DB만 재배포하면 자동으로 최신 매핑을 따라간다. */

let CACHE = null, CACHE_AT = 0;
const TTL = 5 * 60 * 1000;

/* DB/index.html에서 const DATA = {...} 블록을 중괄호 깊이로 추출 (에디터와 동일 로직) */
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

function norm(s) { return String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ''); }
function paren(s) {
  const m = String(s || '').match(/^(.+?)\s*[（(](.+?)[）)]\s*$/);
  return m ? { a: m[1].trim(), b: m[2].trim() } : null;
}

function buildMap(DATA) {
  const out = [];
  const add = (img, names, forms, actions) => {
    if (!img) return;
    out.push({
      img: String(img),
      names: names.filter(Boolean).map(norm),
      forms: forms.filter(Boolean).map(norm),
      actions: actions.filter(Boolean).map(norm)
    });
  };
  for (const g of Object.values(DATA)) {
    if (!g || !g.series) continue;
    for (const s of Object.values(g.series)) {
      if (!s || !Array.isArray(s.eras)) continue;
      for (const era of s.eras) for (const w of (era.works || [])) {
        if (w.img) add(w.img, [w.ko, w.jp], [], ['배너', '메인', '포스터']);
        for (const h of (w.members || [])) {
          if (!h || h._divider) continue;
          /* 영웅 메인 = 변신 전 인물 사진 */
          if (h.img) add(h.img, [h.name, h.jp], ['변신전', '변신 전', '인물', '본명'], ['전신']);
          /* 변신체(슈트) — 이름은 sub("아카레인저 (アカレンジャー)")에서, 폼 구분은 imgAltLabel("기본 (아카레인저)")에서 */
          if (h.imgAlt) {
            const sub = paren(h.sub), lbl = paren(h.imgAltLabel);
            add(h.imgAlt,
              [sub ? sub.a : null, sub ? sub.b : null, h.sub, h.name, h.jp],
              [lbl ? lbl.a : (h.imgAltLabel || '기본')],
              ['전신']);
          }
          for (const sk of (h.skills || [])) if (sk && sk.media && sk.media.type === 'image' && sk.media.src)
            add(sk.media.src, [sk.name, sk.jp, h.name], [], ['스킬', '필살기']);
          for (const fx of (h.funcs || [])) if (fx && fx.media && fx.media.type === 'image' && fx.media.src)
            add(fx.media.src, [fx.name, fx.jp, h.name], [], ['기능', '기믹']);
        }
        for (const f of (w.forms || [])) {
          if (!f || f._divider) continue;
          if (f.img) add(f.img, [f.name, f.jp], [f.sub || '기본'], ['전신']);
          for (const fx of (f.funcs || [])) if (fx && fx.media && fx.media.type === 'image' && fx.media.src)
            add(fx.media.src, [fx.name, fx.jp, f.name], [], ['기능', '기믹']);
        }
        for (const k of ['kaiju', 'arsenal', 'machines', 'orgs']) for (const it of (w[k] || [])) {
          if (!it || it._divider) continue;
          const img = it.img || it.photo || (it.media && it.media.type === 'image' && it.media.src);
          if (img) add(img, [it.name, it.jp], [], ['전신']);
          for (const fx of (it.funcs || [])) if (fx && fx.media && fx.media.type === 'image' && fx.media.src)
            add(fx.media.src, [fx.name, fx.jp, it.name], [], ['기능', '기믹']);
        }
      }
    }
  }
  /* 에디터 이미지 태그(_imgmeta.tags): 경로 → {name[],form[],action[]} — 있으면 병합 */
  const tags = (DATA._imgmeta && DATA._imgmeta.tags) || {};
  for (const [p, t] of Object.entries(tags)) {
    if (!t) continue;
    add(p, (t.name || []), (t.form || []), (t.action || []));
  }
  return out;
}

async function getMap(host) {
  const now = Date.now();
  if (CACHE && now - CACHE_AT < TTL) return CACHE;
  const proto = /^localhost|^127\./.test(host) ? 'http' : 'https';
  const r = await fetch(`${proto}://${host}/DB/`, { headers: { 'user-agent': 'toku-img-resolver' } });
  const html = await r.text();
  const block = findDataBlock(html);
  if (!block) throw new Error('DATA block not found');
  CACHE = buildMap(JSON.parse(block));
  CACHE_AT = now;
  return CACHE;
}

module.exports = async (req, res) => {
  try {
    const p = String((req.query && req.query.p) || '').replace(/\/+$/, '');
    const parts = p.split('/').map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } }).filter(Boolean);
    const nameQ = norm(parts[0]), formQ = norm(parts[1]), actQ = norm(parts[2]);
    if (!nameQ) { res.statusCode = 400; res.end('usage: /i/이름/폼/행동'); return; }
    const map = await getMap(req.headers.host);
    /* 이름 → 폼 → 행동 순으로 좁히되, 폼·행동은 매칭이 없으면 무시(관대한 폴백) */
    let hits = map.filter(e => e.names.some(n => n === nameQ || n.includes(nameQ) || nameQ.includes(n)));
    if (formQ) { const f = hits.filter(e => e.forms.some(x => x === formQ || x.includes(formQ) || formQ.includes(x))); if (f.length) hits = f; }
    if (actQ) { const a = hits.filter(e => e.actions.some(x => x === actQ || x.includes(actQ) || actQ.includes(x))); if (a.length) hits = a; }
    if (!hits.length) {
      res.statusCode = 404;
      res.setHeader('cache-control', 'public, s-maxage=60');
      res.end('not found: ' + parts.join('/'));
      return;
    }
    let img = hits[0].img;
    if (!/^https?:\/\//.test(img) && !img.startsWith('/')) img = '/DB/' + img;
    const loc = /^https?:\/\//.test(img) ? img : '/' + img.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
    res.statusCode = 302;
    res.setHeader('location', loc);
    res.setHeader('cache-control', 'public, s-maxage=300');
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end('resolver error: ' + e.message);
  }
};
