'use strict';

/* ===================== 定数・ユーティリティ ===================== */
const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const MONTH_TTL = 12 * 60 * 60 * 1000;   // 月ごとの作品一覧キャッシュ: 12時間
const RD_TTL = 7 * 24 * 60 * 60 * 1000;  // 作品ごとの地域別公開日キャッシュ: 7日
const MAX_CHIPS = 4;                     // 月表示で1日に表示する件数
const MAX_BAR_LANES = 3;                 // 月表示で1週に表示する上映期間の段数
const DEFAULT_THEATERS = [
  { id: 'th-toho-kinshicho', name: 'TOHOシネマズ錦糸町', short: '錦糸町', color: '#dc2626', url: 'https://hlo.tohotheater.jp/net/schedule/092/TNPI2000J01.do' },
  { id: 'th-gdcs-ikebukuro', name: 'グランドシネマサンシャイン池袋', short: '池袋', color: '#7c3aed', url: 'https://www.cinemasunshine.co.jp/theater/gdcs/' },
  { id: 'th-tjoy-shinagawa', name: 'Tジョイプリンス品川', short: '品川', color: '#0284c7', url: 'https://tjoy.jp/tjoy-prince-shinagawa#schedule-content' },
];
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const REGIONS = { JP: '日本', US: 'アメリカ', KR: '韓国', TW: '台湾', HK: '香港', GB: 'イギリス', FR: 'フランス', DE: 'ドイツ' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const startOfWeek = d => addDays(d, -d.getDay()); // 日曜始まり
const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const fmtDate = s => { const d = parseYmd(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WD[d.getDay()]})`; };
const dowClass = d => (d.getDay() === 0 ? 'sun' : d.getDay() === 6 ? 'sat' : '');
const diffDays = (a, b) => Math.round((b - a) / 86400000);
const fmtShort = s => { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
const isYmd = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const newId = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ===================== 保存領域 (localStorage) ===================== */
const P = 'movie-scheduler.';
const LS = {
  get(k, d) {
    try { const v = localStorage.getItem(P + k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    const s = JSON.stringify(v);
    try { localStorage.setItem(P + k, s); }
    catch { // 容量オーバー時はTMDbキャッシュを捨てて再試行
      clearCaches(false);
      try { localStorage.setItem(P + k, s); } catch (e) { console.warn('保存できませんでした', e); }
    }
  },
  del(k) { localStorage.removeItem(P + k); },
  keys(prefix) { return Object.keys(localStorage).filter(k => k.startsWith(P + prefix)).map(k => k.slice(P.length)); },
};

/* ===================== 状態 ===================== */
const state = {
  view: LS.get('view', 'month'),
  cursor: new Date(),
  settings: Object.assign({ apiKey: '', region: 'JP', maxPages: 5 }, LS.get('settings', {})),
  manual: LS.get('manual', []),
  favs: new Set(LS.get('favs', [])),
  theaters: LS.get('theaters', DEFAULT_THEATERS),
  screenings: LS.get('screenings', []), // { id, theaterId, title, tmdbId, poster, start, end|null, note }
  tmdb: new Map(),      // "JP:2026-11" -> 作品配列
  loading: new Set(),
  failed: new Set(),
  filters: { q: '', fav: false, tmdb: true, manual: true, screen: true, theater: '' },
  error: null,
};
if (!['month', 'week', 'list'].includes(state.view)) state.view = 'month';

const saveManual = () => LS.set('manual', state.manual);
const saveFavs = () => LS.set('favs', [...state.favs]);
const saveTheaters = () => LS.set('theaters', state.theaters);
const saveScreenings = () => LS.set('screenings', state.screenings);

/* ===================== TMDb ===================== */
async function tmdbGet(path, params = {}, retry = 3) {
  const key = state.settings.apiKey.trim();
  const url = new URL(API + path);
  const headers = { accept: 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key; // v4 読み取りアクセストークン
  else url.searchParams.set('api_key', key);                          // v3 APIキー
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers });
  if (res.status === 429 && retry > 0) { await sleep(1200); return tmdbGet(path, params, retry - 1); }
  if (!res.ok) { const e = new Error(`TMDb ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}

// 地域別公開日キャッシュ { tmdbId: { d: 'YYYY-MM-DD' | null, at } }
let rdMem = {};
let rdSaveTimer = null;
function rdCache() {
  const r = state.settings.region;
  return (rdMem[r] ??= LS.get('rd.' + r, {}));
}
function saveRdSoon() {
  clearTimeout(rdSaveTimer);
  const r = state.settings.region;
  rdSaveTimer = setTimeout(() => LS.set('rd.' + r, rdMem[r] || {}), 500);
}

// 指定地域の劇場公開日（通常公開を優先、なければ限定公開）を取得
async function regionalDate(id) {
  const cache = rdCache();
  const hit = cache[id];
  if (hit && Date.now() - hit.at < RD_TTL) return hit.d;
  const data = await tmdbGet(`/movie/${id}/release_dates`);
  const r = (data.results || []).find(x => x.iso_3166_1 === state.settings.region);
  let d = null;
  if (r) {
    const pick = t => r.release_dates.filter(x => x.type === t).map(x => x.release_date.slice(0, 10)).sort()[0];
    d = pick(3) || pick(2) || null;
  }
  cache[id] = { d, at: Date.now() };
  saveRdSoon();
  return d;
}

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { console.warn(e); } } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

const cacheKey = d => `${state.settings.region}:${monthKey(d)}`;

// localStorageのキャッシュがあればメモリへ（同期）
function hydrateMonth(d) {
  const key = cacheKey(d);
  if (state.tmdb.has(key)) return true;
  const c = LS.get('month.' + key);
  if (c && Date.now() - c.at < MONTH_TTL) { state.tmdb.set(key, c.movies); return true; }
  return false;
}

async function fetchMonth(d) {
  const key = cacheKey(d);
  if (!state.settings.apiKey || state.loading.has(key) || state.failed.has(key)) return;
  state.loading.add(key);
  updateStatus();
  try {
    const gte = ymd(startOfMonth(d)), lte = ymd(endOfMonth(d));
    const base = {
      language: 'ja-JP', region: state.settings.region,
      'release_date.gte': gte, 'release_date.lte': lte,
      with_release_type: '2|3', sort_by: 'popularity.desc', include_adult: 'false',
    };
    const first = await tmdbGet('/discover/movie', { ...base, page: 1 });
    const pages = Math.min(first.total_pages || 1, state.settings.maxPages, 500);
    const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, i) => tmdbGet('/discover/movie', { ...base, page: i + 2 })));
    const all = [first, ...rest].flatMap(p => p.results || []);
    const uniq = [...new Map(all.map(m => [m.id, m])).values()];
    const movies = [];
    await pool(uniq, 6, async m => {
      const date = await regionalDate(m.id);
      if (!date || date < gte || date > lte) return;
      movies.push({
        id: 't' + m.id, tmdbId: m.id, source: 'tmdb',
        title: m.title, originalTitle: m.original_title, date,
        poster: m.poster_path, overview: m.overview,
        popularity: m.popularity, vote: m.vote_average,
      });
    });
    state.tmdb.set(key, movies);
    LS.set('month.' + key, { at: Date.now(), movies });
    state.error = null;
  } catch (e) {
    console.error(e);
    state.failed.add(key);
    state.error = e.status === 401
      ? 'TMDb APIキーが正しくないようです。設定を確認してください。'
      : `TMDbからの取得に失敗しました（${esc(e.message)}）。通信状況を確認して「再取得」を押してください。`;
  } finally {
    state.loading.delete(key);
    render();
  }
}

function clearCaches(rerender = true) {
  for (const k of [...LS.keys('month.'), ...LS.keys('rd.')]) LS.del(k);
  state.tmdb.clear();
  state.failed.clear();
  rdMem = {};
  if (rerender) render();
}

/* ===================== 表示範囲・イベント ===================== */
// データ取得の対象範囲（月表示は当月のみ取得。前後月の日はキャッシュがあれば表示）
function dataRange() {
  const c = state.cursor;
  if (state.view === 'week') { const s = startOfWeek(c); return [s, addDays(s, 6)]; }
  return [startOfMonth(c), endOfMonth(c)];
}
function monthsIn([s, e]) {
  const out = [];
  for (let d = startOfMonth(s); d <= e; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) out.push(d);
  return out;
}

function allEvents() {
  const evs = [];
  const f = state.filters;
  if (f.tmdb) for (const [k, list] of state.tmdb) if (k.startsWith(state.settings.region + ':')) evs.push(...list);
  if (f.manual) evs.push(...state.manual);
  const q = f.q.trim().toLowerCase();
  return evs.filter(e =>
    (!f.fav || state.favs.has(e.id)) &&
    (!q || e.title.toLowerCase().includes(q) || (e.originalTitle || '').toLowerCase().includes(q)));
}
function compareEvents(a, b) {
  return (state.favs.has(b.id) - state.favs.has(a.id))
    || ((b.source === 'manual') - (a.source === 'manual'))
    || ((b.popularity || 0) - (a.popularity || 0))
    || a.title.localeCompare(b.title, 'ja');
}
function eventsByDate() {
  const map = new Map();
  for (const e of allEvents()) { if (!map.has(e.date)) map.set(e.date, []); map.get(e.date).push(e); }
  for (const l of map.values()) l.sort(compareEvents);
  return map;
}
function findEvent(id) {
  if (id.startsWith('m')) return state.manual.find(e => e.id === id);
  for (const list of state.tmdb.values()) { const hit = list.find(e => e.id === id); if (hit) return hit; }
  return null;
}

/* ===================== 描画 ===================== */
const colorStyle = e => (e.source === 'manual' && e.color ? ` style="--c:${esc(e.color)}"` : '');
const starMark = e => (state.favs.has(e.id) ? '<span class="star">★</span> ' : '');

function chip(e) {
  return `<button class="chip" data-action="open" data-id="${esc(e.id)}"${colorStyle(e)} title="${esc(e.title)}">${starMark(e)}${esc(e.title)}</button>`;
}
function card(e, { overview = false, size = 'w92' } = {}) {
  const poster = e.poster
    ? `<img class="poster" src="${IMG}${size}${esc(e.poster)}" alt="" loading="lazy">`
    : `<div class="poster">${e.source === 'manual' ? '📝' : '🎞'}</div>`;
  const fav = state.favs.has(e.id);
  const sub = e.originalTitle && e.originalTitle !== e.title ? `<div class="o">${esc(e.originalTitle)}</div>` : '';
  const text = overview ? (e.overview || e.note || '') : '';
  return `<div class="card" data-action="open" data-id="${esc(e.id)}"${colorStyle(e)}>
    ${poster}
    <div class="meta"><div class="t">${esc(e.title)}</div>${sub}${text ? `<div class="ov">${esc(text)}</div>` : ''}</div>
    <button class="star ${fav ? 'on' : ''}" data-action="fav" data-id="${esc(e.id)}" title="お気に入り">${fav ? '★' : '☆'}</button>
  </div>`;
}

/* ----- 上映期間 ----- */
const theaterOf = id => state.theaters.find(t => t.id === id);
const periodText = s => `${fmtShort(s.start)}〜${s.end ? fmtShort(s.end) : '終了未定'}`;

// 期間 [rs, re]（YYYY-MM-DD）に重なる上映期間（絞り込み適用済み）
function visibleScreenings(rs, re) {
  const f = state.filters;
  if (!f.screen) return [];
  const q = f.q.trim().toLowerCase();
  return state.screenings.filter(s => theaterOf(s.theaterId)
    && (!f.theater || s.theaterId === f.theater)
    && s.start <= re && (!s.end || s.end >= rs)
    && (!q || s.title.toLowerCase().includes(q))
    && (!f.fav || (s.tmdbId && state.favs.has('t' + s.tmdbId))))
    .sort((a, b) => a.start.localeCompare(b.start)
      || (b.end || '9999').localeCompare(a.end || '9999')
      || state.theaters.indexOf(theaterOf(a.theaterId)) - state.theaters.indexOf(theaterOf(b.theaterId)));
}

// 1週間分の上映期間を段（レーン）に割り付ける
function layoutBars(weekStart, list, maxLanes = Infinity) {
  const ws = ymd(weekStart), we = ymd(addDays(weekStart, 6));
  const lanes = [], bars = [], hidden = Array(7).fill(0);
  for (const s of list) {
    if (s.start > we || (s.end && s.end < ws)) continue;
    const a = s.start < ws ? 0 : diffDays(weekStart, parseYmd(s.start));
    const b = !s.end || s.end > we ? 6 : diffDays(weekStart, parseYmd(s.end));
    let lane = lanes.findIndex(last => last < a);
    if (lane === -1 && lanes.length < maxLanes) { lane = lanes.length; lanes.push(-1); }
    if (lane === -1) { for (let i = a; i <= b; i++) hidden[i]++; continue; }
    lanes[lane] = b;
    bars.push({ s, a, b, lane, contL: s.start < ws, contR: !s.end || s.end > we });
  }
  return { bars, lanes: lanes.length, hidden };
}

function barHtml(x, row) {
  const t = theaterOf(x.s.theaterId);
  const tip = `${t.name}\n${x.s.title}\n${periodText(x.s)}${x.s.note ? '\n' + x.s.note : ''}`;
  return `<button class="bar${x.contL ? ' cl' : ''}${x.contR ? ' cr' : ''}" data-action="screening" data-id="${esc(x.s.id)}"
    style="grid-column:${x.a + 1} / ${x.b + 2};grid-row:${row};--c:${esc(t.color)}" title="${esc(tip)}">${x.contL ? '◀ ' : ''}<b>${esc(t.short || t.name)}</b> ${esc(x.s.title)}${!x.s.end && !x.contR ? '（終了未定）' : ''}</button>`;
}

// 映画館ごとの上映期間一覧（リスト表示・日別ダイアログ・詳細で使用）
function screeningSummary(list, heading) {
  if (!list.length) return '';
  const groups = state.theaters.map(t => [t, list.filter(s => s.theaterId === t.id)]).filter(([, l]) => l.length);
  return `<section class="scr-summary">${heading ? `<h3>${heading}</h3>` : ''}
    ${groups.map(([t, l]) => `<div class="scr-group" style="--c:${esc(t.color)}">
      <h4>${esc(t.name)}${safeUrl(t.url) ? ` <a href="${esc(t.url)}" target="_blank" rel="noopener">スケジュール ↗</a>` : ''}</h4>
      <ul>${l.map(s => `<li><button class="linkish" data-action="screening" data-id="${esc(s.id)}">${esc(s.title)}</button>
        <span class="period">${periodText(s)}</span>${s.note ? `<span class="note">${esc(s.note)}</span>` : ''}</li>`).join('')}</ul>
    </div>`).join('')}
  </section>`;
}

/* ----- 月表示（週ごとの行に、上映期間の帯 → 公開作品の順で配置） ----- */
function renderMonth(byDate) {
  const c = state.cursor, m = c.getMonth(), today = ymd(new Date());
  const start = startOfWeek(startOfMonth(c));
  const scr = visibleScreenings(ymd(start), ymd(addDays(start, 41)));
  let weeks = '';
  for (let w = 0; w < 6; w++) {
    const ws = addDays(start, w * 7);
    const { bars, lanes, hidden } = layoutBars(ws, scr, MAX_BAR_LANES);
    let bg = '', nums = '', evCells = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i), k = ymd(d), evs = byDate.get(k) || [];
      const flags = [d.getMonth() !== m ? 'other' : '', k === today ? 'today' : '', dowClass(d)].join(' ');
      const shown = evs.slice(0, MAX_CHIPS), more = evs.length - shown.length;
      bg += `<div class="cell ${flags}" data-date="${k}" style="grid-column:${i + 1}"></div>`;
      nums += `<div class="dnum ${flags}" data-date="${k}" style="grid-column:${i + 1}"><button data-action="day" data-date="${k}"><b>${d.getDate()}</b></button></div>`;
      evCells += `<div class="cell-evs" data-date="${k}" style="grid-column:${i + 1};grid-row:${lanes + 2}">
        ${hidden[i] ? `<button class="more" data-action="day" data-date="${k}">上映 他${hidden[i]}本</button>` : ''}
        ${shown.map(chip).join('')}
        ${more > 0 ? `<button class="more" data-action="day" data-date="${k}">他 ${more} 件</button>` : ''}
      </div>`;
    }
    weeks += `<div class="wk" style="grid-template-rows:auto${lanes ? ` repeat(${lanes}, 20px)` : ''} 1fr">
      ${bg}${nums}${bars.map(x => barHtml(x, x.lane + 2)).join('')}${evCells}</div>`;
  }
  const head = WD.map((w, i) => `<div class="wd ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('');
  return `<div class="month"><div class="wd-row">${head}</div>${weeks}</div>`;
}

function renderWeek(byDate) {
  const s = startOfWeek(state.cursor), today = ymd(new Date());
  const { bars, lanes } = layoutBars(s, visibleScreenings(ymd(s), ymd(addDays(s, 6))));
  let html = lanes
    ? `<div class="week-bars" style="grid-template-rows:repeat(${lanes}, 22px)">${bars.map(x => barHtml(x, x.lane + 1)).join('')}</div>`
    : '';
  html += '<div class="week">';
  for (let i = 0; i < 7; i++) {
    const d = addDays(s, i), k = ymd(d), evs = byDate.get(k) || [];
    html += `<section class="wcol ${dowClass(d)} ${k === today ? 'today' : ''}">
      <header><span class="d">${d.getMonth() + 1}/${d.getDate()} (${WD[i]})</span>
        <button class="add" data-action="add" data-date="${k}" title="この日に作品を追加">＋</button></header>
      <div class="items">${evs.map(e => card(e, { size: 'w185' })).join('')}</div>
    </section>`;
  }
  return html + '</div>';
}

function renderList(byDate) {
  const [s, e] = dataRange(), sk = ymd(s), ek = ymd(e);
  const dates = [...byDate.keys()].filter(k => k >= sk && k <= ek).sort();
  const summary = screeningSummary(visibleScreenings(sk, ek), 'この月の上映スケジュール');
  if (!dates.length && !summary) return `<div class="empty">この期間に表示できる作品はありません。</div>`;
  return '<div class="list">' + summary + (dates.length ? '<h3 class="list-head">公開予定</h3>' : '') + dates.map(k => `
    <section>
      <h3 class="${dowClass(parseYmd(k))}">${fmtDate(k)}　<small>${byDate.get(k).length}作品</small></h3>
      <div class="items">${byDate.get(k).map(ev => card(ev, { overview: true })).join('')}</div>
    </section>`).join('') + '</div>';
}

function periodLabel() {
  const c = state.cursor;
  if (state.view === 'week') {
    const s = startOfWeek(c), e = addDays(s, 6);
    return `${s.getFullYear()}年${s.getMonth() + 1}月${s.getDate()}日 〜 ${e.getMonth() + 1}月${e.getDate()}日`;
  }
  return `${c.getFullYear()}年${c.getMonth() + 1}月`;
}

function updateStatus() {
  const el = $('#status');
  if (state.loading.size) { el.textContent = 'TMDbから読み込み中…'; return; }
  const [s, e] = dataRange(), sk = ymd(s), ek = ymd(e);
  const n = allEvents().filter(x => x.date >= sk && x.date <= ek).length;
  const sc = visibleScreenings(sk, ek).length;
  el.textContent = `表示期間の公開作品: ${n}件 / 上映期間: ${sc}件`;
}

function updateBanner() {
  const b = $('#banner');
  if (state.error) {
    b.className = 'banner error';
    b.innerHTML = `${state.error}<button data-action="settings">設定を開く</button>`;
    b.hidden = false;
  } else if (!state.settings.apiKey) {
    b.className = 'banner';
    b.innerHTML = 'TMDb APIキーが未設定のため、手動で追加した作品だけを表示しています。キーを登録すると公開予定が自動で表示されます。<button data-action="settings">設定を開く</button>';
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

function render() {
  const months = monthsIn(dataRange());
  const missing = months.filter(d => !hydrateMonth(d));

  $('#period-label').textContent = periodLabel();
  $$('.views button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.filters.theater && !theaterOf(state.filters.theater)) state.filters.theater = '';
  $('#f-theater').innerHTML = '<option value="">すべての映画館</option>'
    + state.theaters.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  $('#f-theater').value = state.filters.theater;
  const byDate = eventsByDate();
  $('#view').innerHTML = state.view === 'week' ? renderWeek(byDate) : state.view === 'list' ? renderList(byDate) : renderMonth(byDate);
  updateStatus();
  updateBanner();
  refreshDialogs();

  for (const d of missing) fetchMonth(d);
}

/* ===================== ダイアログ ===================== */
let detailId = null, dayDate = null;

function renderDetail() {
  const e = findEvent(detailId);
  const body = $('#dlg-detail .dlg-body');
  if (!e) { $('#dlg-detail').close(); return; }
  const fav = state.favs.has(e.id);
  const img = e.poster ? `<img src="${IMG}w342${esc(e.poster)}" alt="">` : '';
  const sub = e.originalTitle && e.originalTitle !== e.title ? `<div class="o">${esc(e.originalTitle)}</div>` : '';
  const vote = e.vote ? `　評価 ${e.vote.toFixed(1)} / 10` : '';
  const text = e.source === 'tmdb' ? (e.overview || 'あらすじは登録されていません。') : (e.note || '');
  const btns = [
    `<button data-action="fav" data-id="${esc(e.id)}">${fav ? '★ お気に入り解除' : '☆ お気に入りに追加'}</button>`,
    e.source === 'tmdb'
      ? `<a href="https://www.themoviedb.org/movie/${e.tmdbId}?language=ja-JP" target="_blank" rel="noopener" class="btnlink">TMDbで見る ↗</a>`
      : `<button data-action="edit" data-id="${esc(e.id)}">編集</button><button class="danger" data-action="delete" data-id="${esc(e.id)}">削除</button>`,
    `<button data-action="add-screening" data-id="${esc(e.id)}">＋ 上映期間を登録</button>`,
  ].join('');
  const scr = state.screenings.filter(s => theaterOf(s.theaterId) && (e.tmdbId ? s.tmdbId === e.tmdbId : s.title === e.title));
  body.innerHTML = `<div class="detail">${img}<div class="info">
    <h3>${esc(e.title)}</h3>${sub}
    <div class="date">${REGIONS[state.settings.region] || state.settings.region}公開: ${fmtDate(e.date)}${e.source === 'manual' ? '（手動追加）' : vote}</div>
    ${text ? `<p>${esc(text)}</p>` : ''}
    ${screeningSummary(scr, '登録済みの上映期間')}
    <div class="btns">${btns}</div>
  </div></div>`;
}
function openDetail(id) {
  detailId = id;
  renderDetail();
  const dlg = $('#dlg-detail');
  if (!dlg.open) dlg.showModal();
}

function renderDay() {
  const evs = eventsByDate().get(dayDate) || [];
  $('#dlg-day .dlg-body').innerHTML = `<h3>${fmtDate(dayDate)}</h3>
    ${screeningSummary(visibleScreenings(dayDate, dayDate), 'この日に上映中')}
    <h3 class="list-head">この日に公開</h3>
    <div class="day-list">${evs.length ? evs.map(e => card(e)).join('') : '<div class="empty">作品はありません。</div>'}</div>
    <div class="dlg-actions">
      <button data-action="add-screening" data-date="${dayDate}">＋ 上映期間を登録</button>
      <button data-action="add" data-date="${dayDate}">＋ この日に作品を追加</button>
    </div>`;
}
function openDay(date) {
  dayDate = date;
  renderDay();
  const dlg = $('#dlg-day');
  if (!dlg.open) dlg.showModal();
}

function refreshDialogs() {
  if ($('#dlg-day').open) renderDay();
  if ($('#dlg-detail').open) renderDetail();
  if ($('#dlg-theaters').open) renderTheaterList();
}

/* ----- 上映期間の登録・編集 ----- */
// カレンダーに読み込み済みの作品タイトル → 作品
function titleIndex() {
  const map = new Map();
  for (const [k, list] of state.tmdb) if (k.startsWith(state.settings.region + ':')) for (const e of list) map.set(e.title, e);
  return map;
}

function updateTheaterLink() {
  const f = $('#form-screening').elements;
  const t = theaterOf(f.theaterId.value);
  const a = $('#theater-link');
  const url = safeUrl(t?.url);
  a.hidden = !url;
  if (url) a.href = url;
}

// s: 既存の上映期間（編集時） / preset: 新規時の初期値 { title, tmdbId, start }
function openScreening(s, preset = {}) {
  if (!state.theaters.length) { alert('先に「🎦 映画館」から映画館を登録してください。'); openTheaters(); return; }
  const form = $('#form-screening');
  form.reset();
  const f = form.elements;
  const src = s || preset;
  f.id.value = s?.id || '';
  f.tmdbId.value = src.tmdbId || '';
  f.title.value = src.title || '';
  form.dataset.origTitle = src.title || '';
  f.theaterId.innerHTML = state.theaters.map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  f.theaterId.value = s?.theaterId || state.filters.theater || state.theaters[0].id;
  f.start.value = src.start || ymd(state.cursor);
  f.end.value = s?.end || '';
  f.note.value = s?.note || '';
  $('#title-options').innerHTML = [...titleIndex().keys()].sort((a, b) => a.localeCompare(b, 'ja'))
    .map(t => `<option value="${esc(t)}">`).join('');
  $('#screening-heading').textContent = s ? '上映期間を編集' : '上映期間を登録';
  $('#btn-delete-screening').hidden = !s;
  updateTheaterLink();
  $('#dlg-screening').showModal();
  if (!f.title.value) f.title.focus();
}

/* ----- 映画館の管理 ----- */
function renderTheaterList() {
  $('#theater-list').innerHTML = state.theaters.length
    ? state.theaters.map(t => {
      const n = state.screenings.filter(s => s.theaterId === t.id).length;
      return `<div class="th-row" style="--c:${esc(t.color)}">
        <span class="sw"></span>
        <div class="th-name"><b>${esc(t.name)}</b> <small>（${esc(t.short || '略称なし')}・上映期間 ${n}件）</small>
          ${safeUrl(t.url) ? `<br><a href="${esc(t.url)}" target="_blank" rel="noopener">上映スケジュール ↗</a>` : ''}</div>
        <button data-action="th-edit" data-id="${esc(t.id)}">編集</button>
        <button class="danger" data-action="th-del" data-id="${esc(t.id)}">削除</button>
      </div>`;
    }).join('')
    : '<div class="empty">映画館が登録されていません。</div>';
}
function fillTheaterForm(t) {
  const form = $('#form-theater');
  form.reset();
  const f = form.elements;
  f.id.value = t?.id || '';
  f.name.value = t?.name || '';
  f.short.value = t?.short || '';
  f.color.value = t?.color || '#0284c7';
  f.url.value = t?.url || '';
  $('#theater-form-heading').textContent = t ? `「${t.name}」を編集` : '映画館を追加';
}
function openTheaters() {
  renderTheaterList();
  fillTheaterForm(null);
  const dlg = $('#dlg-theaters');
  if (!dlg.open) dlg.showModal();
}

function openEdit(e, date) {
  const form = $('#form-edit');
  form.reset();
  const f = form.elements;
  f.id.value = e?.id || '';
  f.title.value = e?.title || '';
  f.date.value = e?.date || date || ymd(state.cursor);
  f.note.value = e?.note || '';
  f.color.value = e?.color || '#e11d48';
  $('#edit-heading').textContent = e ? '作品を編集' : '作品を追加';
  $('#dlg-edit').showModal();
  f.title.focus();
}

function openSettings() {
  const f = $('#form-settings').elements;
  f.apiKey.value = state.settings.apiKey;
  f.region.innerHTML = Object.entries(REGIONS).map(([k, v]) => `<option value="${k}">${v} (${k})</option>`).join('');
  f.region.value = state.settings.region;
  f.maxPages.value = state.settings.maxPages;
  $('#dlg-settings').showModal();
}

/* ===================== 操作 ===================== */
function toggleFav(id) {
  state.favs.has(id) ? state.favs.delete(id) : state.favs.add(id);
  saveFavs();
  render();
}

function move(dir) {
  const c = state.cursor;
  state.cursor = state.view === 'week'
    ? addDays(c, 7 * dir)
    : new Date(c.getFullYear(), c.getMonth() + dir, 1);
  render();
}

function download(text, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// iCal (.ics) 書き出し（表示中の期間・絞り込み条件を反映）
function exportIcs() {
  const [s, e] = dataRange(), sk = ymd(s), ek = ymd(e);
  const evs = allEvents().filter(x => x.date >= sk && x.date <= ek).sort((a, b) => a.date.localeCompare(b.date));
  const scr = visibleScreenings(sk, ek);
  if (!evs.length && !scr.length) { alert('書き出す作品・上映期間がありません。'); return; }
  const icsEsc = t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const enc = new TextEncoder();
  const fold = line => { // 1行75オクテット以内に折り返し
    let out = '', cur = '', bytes = 0;
    for (const ch of line) {
      const b = enc.encode(ch).length;
      if (bytes + b > 73) { out += cur + '\r\n '; cur = ''; bytes = 1; }
      cur += ch; bytes += b;
    }
    return out + cur;
  };
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//movie-scheduler//JA', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:映画公開スケジュール'];
  for (const ev of evs) {
    const d = ev.date.replace(/-/g, ''), n = ymd(addDays(parseYmd(ev.date), 1)).replace(/-/g, '');
    const desc = ev.source === 'tmdb' ? (ev.overview || '') : (ev.note || '');
    lines.push('BEGIN:VEVENT', `UID:${ev.id}-${d}@movie-scheduler`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${n}`, `SUMMARY:${icsEsc('【公開】' + ev.title)}`);
    if (desc) lines.push(`DESCRIPTION:${icsEsc(desc)}`);
    if (ev.tmdbId) lines.push(`URL:https://www.themoviedb.org/movie/${ev.tmdbId}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  // 上映期間は複数日の終日予定として書き出す（終了未定は開始日のみ）
  for (const sc of scr) {
    const t = theaterOf(sc.theaterId);
    const st = sc.start.replace(/-/g, '');
    const en = ymd(addDays(parseYmd(sc.end || sc.start), 1)).replace(/-/g, '');
    const desc = [`${t.name} 上映期間: ${periodText(sc)}`, sc.note].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT', `UID:${sc.id}@movie-scheduler`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${st}`, `DTEND;VALUE=DATE:${en}`,
      `SUMMARY:${icsEsc(`【上映】${t.short || t.name} ${sc.title}${sc.end ? '' : '（終了未定）'}`)}`,
      `LOCATION:${icsEsc(t.name)}`, `DESCRIPTION:${icsEsc(desc)}`);
    if (safeUrl(t.url)) lines.push(`URL:${t.url}`);
    lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const name = state.view === 'week' ? `movies-${sk}.ics` : `movies-${monthKey(s)}.ics`;
  download(lines.map(fold).join('\r\n') + '\r\n', name, 'text/calendar');
}

/* ===================== イベント登録 ===================== */
document.addEventListener('click', ev => {
  const t = ev.target.closest('[data-action]');
  if (!t) return;
  const { action, id, date } = t.dataset;
  if (action !== 'open') ev.stopPropagation();
  switch (action) {
    case 'open': openDetail(id); break;
    case 'fav': toggleFav(id); break;
    case 'day': openDay(date); break;
    case 'add': openEdit(null, date); break;
    case 'edit': openEdit(findEvent(id)); break;
    case 'settings': openSettings(); break;
    case 'screening': { const s = state.screenings.find(x => x.id === id); if (s) openScreening(s); break; }
    case 'add-screening': {
      const e = id && findEvent(id);
      openScreening(null, e ? { title: e.title, tmdbId: e.tmdbId, start: e.date } : { start: date });
      break;
    }
    case 'th-edit': fillTheaterForm(theaterOf(id)); $('#form-theater').elements.name.focus(); break;
    case 'th-del': {
      const th = theaterOf(id);
      const n = state.screenings.filter(s => s.theaterId === id).length;
      if (th && confirm(`「${th.name}」を削除しますか？${n ? `\nこの映画館の上映期間 ${n} 件も削除されます。` : ''}`)) {
        state.theaters = state.theaters.filter(x => x.id !== id);
        state.screenings = state.screenings.filter(s => s.theaterId !== id);
        saveTheaters(); saveScreenings();
        if ($('#form-theater').elements.id.value === id) fillTheaterForm(null);
        render();
      }
      break;
    }
    case 'delete': {
      const e = findEvent(id);
      if (e && confirm(`「${e.title}」を削除しますか？`)) {
        state.manual = state.manual.filter(x => x.id !== id);
        state.favs.delete(id);
        saveManual(); saveFavs();
        $('#dlg-detail').close();
        render();
      }
      break;
    }
  }
});

// スマホ: 月表示のマスをタップ → その日の一覧（PCはダブルクリックで追加）
const isNarrow = () => matchMedia('(max-width: 760px)').matches;
$('#view').addEventListener('click', ev => {
  if (!isNarrow() || ev.target.closest('[data-action]')) return;
  const cell = ev.target.closest('.month [data-date]');
  if (cell) openDay(cell.dataset.date);
});
// 作品詳細・日別一覧は、外側（暗い部分）をタップしても閉じる
for (const dlg of $$('dialog.viewer')) {
  dlg.addEventListener('click', e => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dlg.close();
  });
}
$('#btn-filters').onclick = e => {
  const open = $('.toolbar').classList.toggle('open');
  e.currentTarget.setAttribute('aria-expanded', open);
  e.currentTarget.textContent = open ? '絞り込み ▴' : '絞り込み ▾';
};

// 月表示のマスをダブルクリック → その日に追加
$('#view').addEventListener('dblclick', ev => {
  if (isNarrow()) return;
  if (ev.target.closest('[data-action]')) return;
  const cell = ev.target.closest('.month [data-date]');
  if (cell) openEdit(null, cell.dataset.date);
});

$('#btn-prev').onclick = () => move(-1);
$('#btn-next').onclick = () => move(1);
$('#btn-today').onclick = () => { state.cursor = new Date(); render(); };
$$('.views button').forEach(b => b.onclick = () => { state.view = b.dataset.view; LS.set('view', state.view); render(); });
$('#btn-add').onclick = () => openEdit(null);
$('#btn-add-screening').onclick = () => openScreening(null);
$('#btn-theaters').onclick = openTheaters;
$('#btn-ics').onclick = exportIcs;
$('#btn-settings').onclick = openSettings;
$('#btn-reload').onclick = () => {
  for (const d of monthsIn(dataRange())) {
    const key = cacheKey(d);
    state.tmdb.delete(key); state.failed.delete(key); LS.del('month.' + key);
  }
  state.error = null;
  render();
};

$('#search').oninput = e => { state.filters.q = e.target.value; render(); };
$('#f-fav').onchange = e => { state.filters.fav = e.target.checked; render(); };
$('#f-tmdb').onchange = e => { state.filters.tmdb = e.target.checked; render(); };
$('#f-manual').onchange = e => { state.filters.manual = e.target.checked; render(); };
$('#f-screen').onchange = e => { state.filters.screen = e.target.checked; render(); };
$('#f-theater').onchange = e => { state.filters.theater = e.target.value; render(); };

// 上映期間フォーム
$('#form-screening').elements.theaterId.onchange = updateTheaterLink;
$('#form-screening').elements.end.oninput = $('#form-screening').elements.start.oninput = () => {
  const f = $('#form-screening').elements;
  f.end.setCustomValidity(f.end.value && f.end.value < f.start.value ? '終了日は開始日以降にしてください' : '');
};
$('#form-screening').addEventListener('submit', ev => {
  if (ev.submitter?.value !== 'save') return;
  const form = ev.target, f = form.elements;
  const title = f.title.value.trim();
  if (!title || !f.start.value) { ev.preventDefault(); return; }
  // タイトルがカレンダー上の作品と一致すればTMDbの作品と紐付ける
  const hit = titleIndex().get(title);
  const keepId = title === form.dataset.origTitle && f.tmdbId.value ? Number(f.tmdbId.value) : null;
  const data = {
    theaterId: f.theaterId.value, title,
    tmdbId: hit?.tmdbId || keepId || null,
    start: f.start.value, end: f.end.value || null, note: f.note.value.trim(),
  };
  if (f.id.value) {
    const s = state.screenings.find(x => x.id === f.id.value);
    if (s) Object.assign(s, data);
  } else {
    state.screenings.push({ id: newId('s'), ...data });
  }
  saveScreenings();
  render();
});
$('#btn-delete-screening').onclick = () => {
  const id = $('#form-screening').elements.id.value;
  const s = state.screenings.find(x => x.id === id);
  if (s && confirm(`「${s.title}」の上映期間を削除しますか？`)) {
    state.screenings = state.screenings.filter(x => x.id !== id);
    saveScreenings();
    $('#dlg-screening').close();
    render();
  }
};

// 映画館フォーム
$('#form-theater').addEventListener('submit', ev => {
  ev.preventDefault();
  const f = ev.target.elements;
  const data = { name: f.name.value.trim(), short: f.short.value.trim(), color: f.color.value, url: safeUrl(f.url.value.trim()) };
  if (!data.name) return;
  if (f.id.value) {
    const t = theaterOf(f.id.value);
    if (t) Object.assign(t, data);
  } else {
    state.theaters.push({ id: newId('th'), ...data });
  }
  saveTheaters();
  fillTheaterForm(null);
  render();
});
$('#btn-theater-reset').onclick = () => fillTheaterForm(null);

$('#form-edit').addEventListener('submit', ev => {
  if (ev.submitter?.value !== 'save') return;
  const f = ev.target.elements;
  const data = { title: f.title.value.trim(), date: f.date.value, note: f.note.value.trim(), color: f.color.value };
  if (!data.title || !data.date) { ev.preventDefault(); return; }
  if (f.id.value) {
    const e = state.manual.find(x => x.id === f.id.value);
    if (e) Object.assign(e, data);
  } else {
    state.manual.push({ id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), source: 'manual', ...data });
  }
  saveManual();
  state.cursor = parseYmd(data.date);
  render();
});

$('#form-settings').addEventListener('submit', ev => {
  if (ev.submitter?.value !== 'save') return;
  const f = ev.target.elements;
  const next = {
    apiKey: f.apiKey.value.trim(),
    region: f.region.value,
    maxPages: Math.max(1, Math.min(20, parseInt(f.maxPages.value, 10) || 5)),
  };
  const changed = next.apiKey !== state.settings.apiKey || next.maxPages !== state.settings.maxPages;
  state.settings = next;
  LS.set('settings', next);
  if (changed) { for (const k of LS.keys('month.')) LS.del(k); state.tmdb.clear(); }
  state.failed.clear();
  state.error = null;
  render();
});

$('#btn-clear-cache').onclick = () => { clearCaches(); alert('TMDbのキャッシュを削除しました。'); };
$('#btn-backup').onclick = () => download(
  JSON.stringify({ app: 'movie-scheduler', version: 2, manual: state.manual, favs: [...state.favs], theaters: state.theaters, screenings: state.screenings }, null, 2),
  `movie-scheduler-backup-${ymd(new Date())}.json`, 'application/json');
$('#btn-restore').onclick = () => $('#file-restore').click();
$('#file-restore').onchange = async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.manual)) throw new Error('形式が違います');
    const manual = data.manual.filter(x => x && typeof x.title === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date))
      .map(x => ({ id: String(x.id || 'm' + Math.random().toString(36).slice(2)), source: 'manual', title: x.title, date: x.date, note: String(x.note || ''), color: /^#[0-9a-f]{6}$/i.test(x.color) ? x.color : '#e11d48' }));
    // version 2 以降: 映画館と上映期間
    const hasTheaters = Array.isArray(data.theaters);
    const theaters = hasTheaters ? data.theaters.filter(t => t && t.id && typeof t.name === 'string')
      .map(t => ({ id: String(t.id), name: t.name, short: String(t.short || ''), color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#0284c7', url: safeUrl(t.url) })) : state.theaters;
    const screenings = Array.isArray(data.screenings) ? data.screenings
      .filter(s => s && typeof s.title === 'string' && isYmd(s.start) && (!s.end || isYmd(s.end)) && theaters.some(t => t.id === String(s.theaterId)))
      .map(s => ({ id: String(s.id || newId('s')), theaterId: String(s.theaterId), title: s.title, tmdbId: Number(s.tmdbId) || null, start: s.start, end: s.end || null, note: String(s.note || '') })) : null;
    const msg = `手動追加の作品 ${manual.length} 件・お気に入り`
      + (hasTheaters ? `・映画館 ${theaters.length} 館・上映期間 ${screenings ? screenings.length : 0} 件` : '')
      + 'を読み込み、現在のデータを置き換えます。よろしいですか？';
    if (!confirm(msg)) return;
    state.manual = manual;
    state.favs = new Set((data.favs || []).map(String));
    saveManual(); saveFavs();
    if (hasTheaters) {
      state.theaters = theaters;
      state.screenings = screenings || [];
      saveTheaters(); saveScreenings();
    }
    render();
  } catch (err) {
    alert('バックアップを読み込めませんでした: ' + err.message);
  }
};

document.addEventListener('keydown', e => {
  if ($$('dialog').some(d => d.open) || e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowLeft') move(-1);
  else if (e.key === 'ArrowRight') move(1);
  else if (e.key === 't' || e.key === 'T') { state.cursor = new Date(); render(); }
});

render();

// PWA: Webで公開しているとき（http/https）だけ Service Worker を登録
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service Worker の登録に失敗', e));
}
