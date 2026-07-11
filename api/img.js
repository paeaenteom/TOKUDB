/* /i/이름/폼/행동 → 실제 이미지 파일로 302 리다이렉트 하는 리졸버 — 삼박자 '정확 일치' 버전.

   규칙:
   - /i/A/B/C 세 칸을 순서대로 name / form / action 과 대조한다.
   - 각 칸은 값 중 하나와 '정확히' 일치해야 한다 (부분일치·폴백 없음).
   - 비어 있는 칸은 URL에 x 를 쓴다. 예: /i/흑십자군/무사가면/x
   - 뒤쪽 칸을 생략하면 x 로 간주한다. (/i/아카레인저 = /i/아카레인저/x/x)
   - 세 칸이 모두 맞는 이미지가 없으면 404.
   - WAPON 무기는 /i/무기명/스타일명/x (기본형은 스타일=기본).

   삼박자 결정 방법 (슬롯 병합):
   1) 에디터에서 태깅한 DATA._imgmeta.tags 가 1순위 — 값이 있는 칸은 그대로 쓴다.
   2) 태그가 없거나 칸이 비어 있으면 DB 구조에서 유도한 정식 값으로 채운다:
      · 멤버 인물 사진      → (변신체명, x, x)          예: 아카레인저/x/x → 카이조 츠요시 사진
      · 멤버 슈트 사진      → (변신체명, 폼라벨, 전신)   예: 아카레인저/기본/전신
      · 폼(거대전사 등)     → (폼명, sub|기본, x)
      · 카이주·인물·조직 등 → (badge, 개체명, x)        예: 흑십자군/무사가면/x  (badge 없으면 개체명/x/x)
      · 작품 배너           → (작품명, x, 배너)
      · 스킬/기능 미디어    → (소유자, 스킬명, 스킬|기능)
   덕분에 태그가 덜 된 이미지도 항상 하나의 예측 가능한 정확 주소를 가진다.

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

/* DB 구조에서 이미지별 '정식 삼박자'를 유도 (경로 → {name[],form[],action[]}) */
function buildDerived(DATA) {
  const d = {};
  const put = (img, name, form, action) => {
    if (!img || d[img]) return; /* 먼저 만난 정의가 정식 */
    d[img] = {
      name: (name || []).filter(Boolean),
      form: (form || []).filter(Boolean),
      action: (action || []).filter(Boolean)
    };
  };
  for (const g of Object.values(DATA)) {
    if (!g || !g.series) continue;
    for (const s of Object.values(g.series)) {
      if (!s || !Array.isArray(s.eras)) continue;
      for (const era of s.eras) for (const w of (era.works || [])) {
        if (w.img) put(w.img, [w.ko, w.jp], [], ['배너']);
        for (const h of (w.members || [])) {
          if (!h || h._divider) continue;
          const sub = paren(h.sub), lbl = paren(h.imgAltLabel);
          const heroName = sub ? sub.a : (h.sub || h.name);
          /* 인물(변신 전) 사진 → (변신체명, x, x) */
          if (h.img) put(h.img, [heroName], [], []);
          /* 슈트 사진 → (변신체명, 폼라벨, 전신) */
          if (h.imgAlt) put(h.imgAlt, [heroName], [lbl ? lbl.a : (h.imgAltLabel || '기본')], ['전신']);
          for (const sk of (h.skills || [])) if (sk && sk.media && sk.media.type === 'image' && sk.media.src)
            put(sk.media.src, [heroName], [sk.name, sk.jp], ['스킬']);
          for (const fx of (h.funcs || [])) if (fx && fx.media && fx.media.type === 'image' && fx.media.src)
            put(fx.media.src, [heroName], [fx.name, fx.jp], ['기능']);
        }
        for (const f of (w.forms || [])) {
          if (!f || f._divider) continue;
          if (f.img) put(f.img, [f.name, f.jp], [f.sub || '기본'], []);
          for (const fx of (f.funcs || [])) if (fx && fx.media && fx.media.type === 'image' && fx.media.src)
            put(fx.media.src, [f.name], [fx.name, fx.jp], ['기능']);
        }
        for (const k of ['people', 'kaiju', 'arsenal', 'machines', 'orgs']) for (const it of (w[k] || [])) {
          if (!it || it._divider) continue;
          const img = it.img || it.photo || (it.media && it.media.type === 'image' && it.media.src);
          /* badge(소속)가 있으면 (badge, 개체명, x), 없으면 (개체명, x, x) */
          if (img) {
            if (it.badge) put(img, [it.badge], [it.name, it.jp], []);
            else put(img, [it.name, it.jp], [], []);
          }
          for (const fx of (it.funcs || [])) if (fx && fx.media && fx.media.type === 'image' && fx.media.src)
            put(fx.media.src, [it.name], [fx.name, fx.jp], ['기능']);
        }
      }
    }
  }
  return d;
}

/* 삼박자 매핑 — 태그(_imgmeta.tags)가 1순위, 빈 칸은 구조 유도값으로 채움 */
function buildMap(DATA) {
  const out = [];
  const tags = (DATA._imgmeta && DATA._imgmeta.tags) || {};
  const derived = buildDerived(DATA);
  const seen = new Set();
  const push = (img, t, dv) => {
    const name = (t && (t.name || []).filter(Boolean).length ? t.name.filter(Boolean) : (dv ? dv.name : []));
    const form = (t && (t.form || []).filter(Boolean).length ? t.form.filter(Boolean) : (dv ? dv.form : []));
    const action = (t && (t.action || []).filter(Boolean).length ? t.action.filter(Boolean) : (dv ? dv.action : []));
    out.push({ img: String(img), name: name.map(norm), form: form.map(norm), action: action.map(norm) });
    seen.add(img);
  };
  /* 태그된 이미지 먼저 (충돌 시 태그 우선) */
  for (const [p, t] of Object.entries(tags)) { if (p && t) push(p, t, derived[p]); }
  /* 태그 없는 이미지는 유도 삼박자로 */
  for (const [p, dv] of Object.entries(derived)) { if (!seen.has(p)) push(p, null, dv); }
  return out;
}

/* /WAPON/ 무기고 → 삼박자: 무기명/스타일/x (기본형은 스타일=기본). 경로는 /WAPON/ 기준 절대화 */
function buildWaponMap(DATA) {
  const out = [];
  const abs = (p) => {
    if (!p) return '';
    if (/^https?:\/\//.test(p) || p.startsWith('/')) return p;
    return '/WAPON/' + p;
  };
  for (const w of (DATA.weapons || [])) {
    if (!w || !w.name) continue;
    if (w.img) out.push({
      img: abs(String(w.img)),
      name: [w.name, w.jp].filter(Boolean).map(norm),
      form: [norm('기본')],
      action: []
    });
    for (const s of (w.styles || [])) {
      if (!s || !s.name) continue;
      const im = s.img || w.img;
      if (!im) continue;
      out.push({
        img: abs(String(im)),
        name: [w.name, w.jp].filter(Boolean).map(norm),
        form: [norm(s.name)],
        action: []
      });
    }
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
  let map = buildMap(JSON.parse(block));
  /* WAPON 무기고 병합 — 페이지가 없거나 실패해도 DB 리졸빙은 유지 */
  try {
    const rw = await fetch(`${proto}://${host}/WAPON/`, { headers: { 'user-agent': 'toku-img-resolver' } });
    if (rw.ok) {
      const wblock = findDataBlock(await rw.text());
      if (wblock) map = map.concat(buildWaponMap(JSON.parse(wblock)));
    }
  } catch (e) { /* 무기고 없음 — 무시 */ }
  CACHE = map;
  CACHE_AT = now;
  return CACHE;
}

/* 한 칸 검사: x 는 '그 카테고리가 비어 있어야 함', 그 외에는 정확 일치 필수 */
function slotOk(vals, q) {
  return q === 'x' ? vals.length === 0 : vals.indexOf(q) !== -1;
}

module.exports = async (req, res) => {
  try {
    const p = String((req.query && req.query.p) || '').replace(/\/+$/, '');
    const parts = p.split('/').map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } }).filter(Boolean);
    if (!parts.length || parts.length > 3) {
      res.statusCode = 400;
      res.end('usage: /i/이름/폼/행동 — 없는 칸은 x (예: /i/흑십자군/무사가면/x)');
      return;
    }
    const nameQ = norm(parts[0]);
    const formQ = parts.length > 1 ? norm(parts[1]) : 'x';
    const actQ = parts.length > 2 ? norm(parts[2]) : 'x';
    const map = await getMap(req.headers.host);
    const hits = map.filter(e => slotOk(e.name, nameQ) && slotOk(e.form, formQ) && slotOk(e.action, actQ));
    if (!hits.length) {
      res.statusCode = 404;
      res.setHeader('cache-control', 'public, s-maxage=60');
      res.end('not found: ' + [nameQ, formQ, actQ].join('/') + ' — 형식 /i/이름/폼/행동, 없는 칸은 x, 태그와 정확 일치해야 함');
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
