/* /summ/이름  또는  /summ/작품/이름  → 캐릭터 데이터 JSON 반환.
   RPG 봇(특촬 소환/가호공명 캐릭터) 등 외부에서 캐릭터의
   이름·폼이름·사진·스킬·변신묘사(변신 아이템·변신음·변신 미디어)를 불러오기 위한 엔드포인트.
   예: /summ/아카레인저 → { name, jp, form, photo, skills, henshin, ... }

   데이터 소스: 배포된 /DB/index.html 안의 `const DATA = {...}` 블록을 그대로 파싱.
   모듈 캐시 5분(TTL) — 에디터로 DB만 재배포하면 자동으로 최신 데이터를 따른다.
   HP·스탯은 공식 수치가 없어 제외한다(요청 사항). */

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

function norm(s) { return String(s || '').normalize('NFC').toLowerCase().replace(/\s+/g, ''); }
function paren(s) {
  const m = String(s || '').match(/^(.+?)\s*[（(](.+?)[）)]\s*$/);
  return m ? { a: m[1].trim(), b: m[2].trim() } : null;
}
/* 상대 이미지 경로를 절대 URL로 (외부 <img>·봇에서 바로 쓰도록) */
function absImg(host, p) {
  if (!p) return null;
  const proto = /^localhost|^127\./.test(host) ? 'http' : 'https';
  if (/^https?:\/\//.test(p)) return p;
  const path = p.startsWith('/') ? p : '/DB/' + p;
  return proto + '://' + host + '/' + path.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
}
function mediaUrl(host, m) {
  if (!m || !m.src) return null;
  if (/^https?:\/\//.test(m.src)) return m.src;
  return absImg(host, m.src);
}
function cleanSkills(arr) {
  return (arr || []).filter(s => s && !s._divider && (s.name || s.desc))
    .map(s => ({ name: s.name || '', jp: s.jp || '', desc: s.desc || '' }));
}
function cleanFuncs(host, arr) {
  return (arr || []).filter(f => f && (f.name || f.sound || f.desc || (f.media && f.media.src)))
    .map(f => ({ name: f.name || '', jp: f.jp || '', sound: f.sound || '', desc: f.desc || '', media: mediaUrl(host, f.media) }));
}

/* DATA → 검색 가능한 캐릭터 레코드 배열. names[]로 매칭, data에 반환용 필드. */
function buildChars(DATA, host) {
  const out = [];
  const push = (rec, names) => { rec._names = names.filter(Boolean).map(norm); if (rec._names.length) out.push(rec); };
  for (const g of Object.values(DATA)) {
    if (!g || !g.series) continue;
    for (const s of Object.values(g.series)) {
      if (!s || !Array.isArray(s.eras)) continue;
      for (const era of s.eras) for (const w of (era.works || [])) {
        const ctx = { work: w.ko || '', series: s.ko || '' };
        (w.members || []).forEach(h => {
          if (!h || h._divider) return;
          const sub = paren(h.sub);        // "아카레인저 (アカレンジャー)" → a=아카레인저 b=アカレンジャー  (사람중심 구조)
          const lbl = paren(h.imgAltLabel); // "기본 (아카레인저)" → a=기본 b=아카레인저
          const rec = {
            kind: h.person ? '인물' : '영웅', ...ctx,
            name: h.name || '', jp: h.jp || '',
            form: lbl ? lbl.a : (h.imgAltLabel || ''),      // 폼 구분 (기본/강화폼 등)
            transformName: sub ? sub.a : '',                // 변신체 이름 (아카레인저)
            role: h.sub || '',
            photo: absImg(host, h.img),
            altPhoto: absImg(host, h.imgAlt),               // 변신체(슈트) 사진
            item: (h.item && h.item !== '—') ? h.item : '', // 변신 아이템
            weapon: (h.weapon && h.weapon !== '—') ? h.weapon : '',
            henshin: mediaUrl(host, h.henshin),             // 변신 미디어(GIF·영상)
            desc: h.desc || '',
            skills: cleanSkills(h.skills),
            funcs: cleanFuncs(host, h.funcs)                // 변신음 등
          };
          // 사람중심 구조: name=본명, sub=변신체(폼). 폼 이름으로도 검색되게 names에 포함.
          push(rec, [h.name, h.jp, sub ? sub.a : null, sub ? sub.b : null, h.sub]);
        });
        (w.forms || []).forEach(f => {
          if (!f || f._divider) return;
          const rec = {
            kind: '폼', ...ctx,
            name: f.name || '', jp: f.jp || '',
            form: f.sub || '',
            role: '',
            photo: absImg(host, f.img),
            item: (f.item && f.item !== '—') ? f.item : '',
            weapon: (f.weapon && f.weapon !== '—') ? f.weapon : '',
            henshin: mediaUrl(host, f.henshin),
            desc: f.desc || '',
            skills: cleanSkills(f.skills),
            funcs: cleanFuncs(host, f.funcs)
          };
          push(rec, [f.name, f.jp]);
        });
        const flat = [['people', '인물'], ['kaiju', '괴수'], ['arsenal', '무장'], ['machines', '장비'], ['orgs', '조직']];
        for (const [k, kind] of flat) (w[k] || []).forEach(it => {
          if (!it || it._divider) return;
          const rec = {
            kind, ...ctx,
            name: it.name || '', jp: it.jp || '',
            form: '', role: it.sub || it.cat || '',
            photo: absImg(host, it.img || it.photo),
            item: '', weapon: '',
            henshin: mediaUrl(host, it.media),
            desc: it.desc || it.sub || '',
            skills: [],
            funcs: cleanFuncs(host, it.funcs)
          };
          push(rec, [it.name, it.jp]);
        });
      }
    }
  }
  return out;
}

async function getChars(host) {
  const now = Date.now();
  if (CACHE && now - CACHE_AT < TTL) return CACHE;
  const proto = /^localhost|^127\./.test(host) ? 'http' : 'https';
  const r = await fetch(`${proto}://${host}/DB/`, { headers: { 'user-agent': 'toku-char-resolver' } });
  const html = await r.text();
  const block = findDataBlock(html);
  if (!block) throw new Error('DATA block not found');
  CACHE = buildChars(JSON.parse(block), host);
  CACHE_AT = now;
  return CACHE;
}

function strip(rec) { const { _names, ...rest } = rec; return rest; }

module.exports = async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  try {
    const p = String((req.query && req.query.p) || '').replace(/\/+$/, '');
    const parts = p.split('/').map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } }).filter(Boolean);
    // /summ/이름  또는  /summ/작품/이름  (작품은 선택적 좁히기)
    let workQ = '', nameQ = '';
    if (parts.length >= 2) { workQ = norm(parts[0]); nameQ = norm(parts[parts.length - 1]); }
    else { nameQ = norm(parts[0]); }
    if (!nameQ) { res.statusCode = 400; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify({ error: 'usage: /summ/이름  또는  /summ/작품/이름' })); return; }

    const chars = await getChars(req.headers.host);
    let hits = chars.filter(e => e._names.some(n => n === nameQ));
    if (!hits.length) hits = chars.filter(e => e._names.some(n => n.includes(nameQ) || nameQ.includes(n)));
    if (workQ) { const w = hits.filter(e => norm(e.work).includes(workQ)); if (w.length) hits = w; }

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'public, s-maxage=300');
    if (!hits.length) {
      res.statusCode = 404;
      res.end(JSON.stringify({ found: false, query: parts.join('/'), hint: '정확한 이름/폼이름으로 다시 시도. 대소문자·띄어쓰기 물시.' }));
      return;
    }
    const main = strip(hits[0]);
    main.found = true;
    // 동명이인/여러 매치가 있으면 후보 목록도 첨부
    if (hits.length > 1) main.others = hits.slice(1, 8).map(e => ({ name: e.name, kind: e.kind, work: e.work, form: e.form }));
    res.statusCode = 200;
    res.end(JSON.stringify(main, null, 2));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'resolver error: ' + e.message }));
  }
};
