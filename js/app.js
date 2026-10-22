import * as M from './model.js';
import * as G from './geo.js';
import * as C from './clubs.js';
import * as CR from './courses.js';
import { Dem, demUrl } from './dem.js';
import * as S from './store.js';
import { hdrContours } from './contour.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// ---------- 状態 ----------
let settings = { ...M.DEFAULT_SETTINGS, ...S.load('settings', {}) };
let profile = S.load('profile', null);   // { score, unit, distMode, clubs: {id: {carry(m, 標準大気)}}, tendency: {all, driver} }
let shots = S.load('shots', []);         // 実データ（ラウンド記録・CSV）
let models = {};
const courses = await CR.loadCourses();
const ui = S.load('ui', {});
let course = courses.find((c) => c.id === ui.courseId) || courses[0];

const state = {
  hole: ui.hole ?? '',
  ball: ui.ball || course.center,
  aimBase: ui.aim || G.destination(course.center, 0, 130),
  dirOffset: 0,
  club: ui.club || null,
  tapMode: 'aim',
  wind: ui.wind || { speed: 0, fromRel: 0 },
  editing: null,      // ホール登録中 { hole, step, tee }
  recording: false,   // 結果記録の待ち受け中
  recClub: null,
  autoClub: false,
  showDots: ui.showDots ?? true,
  showRings: ui.showRings ?? true,
  gpsAcc: null,             // 直近のGPS測位 { center, radius }
  comp: ui.comp ?? false,   // 競技モード
  air: 1,
  lastBearing: 0,
};

const fmtD = (m) => (settings.unit === 'yd' ? `${Math.round(m / M.YD)}y` : `${Math.round(m)}m`);
const fmtN = (m) => (settings.unit === 'yd' ? Math.round(m / M.YD) : Math.round(m));
const toUnit = (v) => (settings.unit === 'yd' ? v * M.YD : v);   // 入力値 → m
const lbl = C.clubLabel;
const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

function rebuildModels() {
  if (!profile) return;
  models = M.buildClubModels(profile, shots, settings);
  if (!models[state.club]) state.club = models['7I'] ? '7I' : Object.keys(models)[0];
}
rebuildModels();

function aimPoint() {
  const b = G.bearing(state.ball, state.aimBase) + rad(state.dirOffset);
  return G.destination(state.ball, b, G.distance(state.ball, state.aimBase));
}
function resetDir() {
  state.dirOffset = 0;
  $('#dir').value = 0;
  $('#dirOut').textContent = '0°';
}
function bakeAim() {
  state.aimBase = aimPoint();
  resetDir();
}

let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => S.save('ui', {
    courseId: course.id, hole: state.hole, ball: state.ball, aim: aimPoint(), club: state.club,
    wind: state.wind, showDots: state.showDots, showRings: state.showRings, comp: state.comp,
  }), 400);
}

function toast(msg, { action, onAction, ms = 3000 } = {}) {
  $('#toastText').textContent = msg;
  const b = $('#toastAction');
  b.hidden = !action;
  b.textContent = action || '';
  b.onclick = () => { $('#toast').hidden = true; onAction?.(); };
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast').hidden = true; }, ms);
}
function banner(text, onCancel) {
  $('#bannerText').textContent = text;
  $('#banner').hidden = !text;
  $('#bannerCancel').onclick = () => { $('#banner').hidden = true; onCancel?.(); };
}

// ---------- 地図 ----------
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      photo: {
        // tileSize 128 で1段細かいタイルを読ませる（高DPIスマホ向け）。この写真は z18 が上限
        type: 'raster', tileSize: 128, maxzoom: 18,
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'],
      },
    },
    layers: [{ id: 'photo', type: 'raster', source: 'photo' }],
  },
  center: state.ball, zoom: 16.5, minZoom: 5, maxZoom: 20,
  pitchWithRotate: false, touchPitch: false, attributionControl: { compact: true },
});

const dem = new Dem(() => scheduleRecompute());

const mk = (cls) => Object.assign(document.createElement('div'), { className: cls });
const ballMk = new maplibregl.Marker({ element: mk('mk-ball'), draggable: true }).setLngLat(state.ball).addTo(map);
const aimMk = new maplibregl.Marker({ element: mk('mk-aim'), draggable: true }).setLngLat(aimPoint()).addTo(map);
const distEl = mk('mk-dist');
const distMk = new maplibregl.Marker({ element: distEl, anchor: 'bottom', offset: [0, -22] }).setLngLat(aimPoint()).addTo(map);

ballMk.on('dragstart', bakeAim);
ballMk.on('drag', () => { state.ball = ballMk.getLngLat().toArray(); clearGps(); scheduleRecompute(); });
ballMk.on('dragend', persist);
aimMk.on('drag', () => { state.aimBase = aimMk.getLngLat().toArray(); resetDir(); scheduleRecompute(); });
aimMk.on('dragend', persist);

// 確率範囲の表示スタイル（凡例と同じ色）
const LEVELS = [
  { p: 0.95, color: '#38bdf8', fill: 0.06 },
  { p: 0.8, color: '#f59e0b', fill: 0.12 },
  { p: 0.5, color: '#ef4444', fill: 0.22 },
];
const empty = { type: 'FeatureCollection', features: [] };
map.on('load', () => {
  for (const id of ['rings', 'gps', 'ell', 'dots', 'lines', 'center']) map.addSource(id, { type: 'geojson', data: empty });
  map.addLayer({ id: 'rings', type: 'line', source: 'rings',
    paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'major'], 1.6, 0.7], 'line-opacity': ['case', ['get', 'major'], 0.85, 0.45] } });
  map.addLayer({ id: 'gps-fill', type: 'fill', source: 'gps', paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
  map.addLayer({ id: 'gps-line', type: 'line', source: 'gps', paint: { 'line-color': '#60a5fa', 'line-width': 1.5 } });
  map.addLayer({ id: 'ell-fill', type: 'fill', source: 'ell', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'op'] } });
  map.addLayer({ id: 'dots', type: 'circle', source: 'dots', layout: { visibility: state.showDots ? 'visible' : 'none' },
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 15, 1.2, 19, 3], 'circle-color': '#ffffff', 'circle-opacity': 0.6 } });
  map.addLayer({ id: 'ell-line', type: 'line', source: 'ell', filter: ['!=', ['get', 'p'], 0.95], paint: { 'line-color': ['get', 'color'], 'line-width': 2.5 } });
  map.addLayer({ id: 'ell-line-95', type: 'line', source: 'ell', filter: ['==', ['get', 'p'], 0.95],
    paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'lines', type: 'line', source: 'lines', paint: { 'line-color': '#ffffff', 'line-width': 2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } });
  map.addLayer({ id: 'center', type: 'circle', source: 'center', paint: { 'circle-radius': 5, 'circle-color': '#111827', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  renderHoleMarkers();
  renderRings();
  scheduleRecompute();
});

map.on('click', (e) => {
  const p = e.lngLat.toArray();
  if (state.editing) return handleEditClick(p);
  if (state.recording) return handleRecordClick(p);
  if (state.tapMode === 'ball') {
    bakeAim();
    setBall(p);
  } else {
    state.aimBase = p;
    resetDir();
  }
  scheduleRecompute();
  persist();
});

function sheetHeight() {
  const h = $('#sheet').offsetHeight;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
  return h;
}
new ResizeObserver(sheetHeight).observe($('#sheet'));

// ---------- 計算と描画 ----------
let rafPending = false;
function scheduleRecompute() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; recompute(); });
}

function clearOverlay() {
  for (const id of ['ell', 'dots', 'center']) map.getSource(id)?.setData(empty);
}

function recompute() {
  const aim = aimPoint();
  aimMk.setLngLat(aim);
  distMk.setLngLat(aim);
  const model = models[state.club];
  if (!profile || !model || !map.getSource('ell')) return;

  const origin = state.ball;
  const brg = G.bearing(origin, aim);
  state.lastBearing = brg;
  const aimDist = G.distance(origin, aim);
  const hole = course.holes[state.hole];
  const toGreen = hole ? G.distance(origin, hole.green) : null;
  distEl.textContent = fmtD(aimDist);
  map.getSource('lines').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [origin, aim] } }] });

  // 競技モード: 距離だけを表示（高低差・風の補正、ばらつき予測、番手のおすすめは出さない）
  if (state.comp) {
    clearOverlay();
    $('#info').innerHTML = `
      <div><span class="big">${lbl(state.club)}</span> 平均キャリー <b>${fmtD(model.carryMean)}</b></div>
      <div>狙いまで <b>${fmtD(aimDist)}</b>${toGreen != null ? `・グリーン中心まで <b>${fmtD(toGreen)}</b>` : ''}</div>
      <div class="sub">競技モード: 距離のみ表示（ゴルフ規則4.3）</div>`;
    renderClubs();
    return;
  }

  const h0 = dem.get(origin);
  const elev = h0 == null ? null : (x, y) => dem.get(G.toLngLat(origin, [x, y]));
  state.air = M.airCarryFactor(h0 ?? 0, settings.courseTemp, settings);
  const pts = M.simulate({ model, bearing: brg, wind: state.wind, elev, settings });

  const toLL = (xy) => G.toLngLat(origin, xy);
  const u = [Math.sin(brg), Math.cos(brg)], v = [Math.cos(brg), -Math.sin(brg)];
  const shotFrame = pts.map(([x, y]) => [x * u[0] + y * u[1], x * v[0] + y * v[1]]);
  const fromShot = ([a, s]) => toLL([a * u[0] + s * v[0], a * u[1] + s * v[1]]);
  const cont = hdrContours(shotFrame, [0.5, 0.8, 0.95]);
  map.getSource('ell').setData({ type: 'FeatureCollection', features: LEVELS.flatMap(({ p, color, fill }) =>
    cont[p].map((ring) => ({ type: 'Feature', properties: { p, color, op: fill }, geometry: { type: 'Polygon', coordinates: [ring.map(fromShot)] } }))) });
  const meanXY = pts.reduce((m, [x, y]) => [m[0] + x / pts.length, m[1] + y / pts.length], [0, 0]);
  map.getSource('dots').setData({ type: 'FeatureCollection', features: pts.slice(0, 700).map((xy) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: toLL(xy) } })) });
  map.getSource('center').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: toLL(meanXY) } }] });

  const hAim = dem.get(aim);
  const dh = h0 != null && hAim != null ? hAim - h0 : null;
  const pl = M.playsLike(aimDist, dh ?? 0, state.club, state.wind, state.air, settings);
  state.recClub = M.recommendClub(models, pl);
  if (state.autoClub && dh != null) {
    state.autoClub = false;
    if (state.recClub && state.recClub !== state.club) { state.club = state.recClub; scheduleRecompute(); }
  }
  const sm = M.summarize(pts, brg, 0.8);
  const side = (x) => (Math.abs(x) < 0.5 * M.YD ? '0' : `${x < 0 ? 'L' : 'R'}${fmtN(Math.abs(x))}`);
  const hDisp = dh == null ? '標高取得中' : `${dh >= 0 ? '↑' : '↓'}${Math.abs(dh).toFixed(1)}m`;
  const restToGreen = hole ? G.distance(toLL(meanXY), hole.green) : null;
  const lvl = model.level;
  $('#info').innerHTML = `
    <div><span class="big">${lbl(state.club)}</span>
      平均キャリー <b>${fmtD(model.carryMean * state.air)}</b>
      <span class="badge ${lvl}">${M.LEVEL_LABEL[lvl]}${model.n ? ` ${model.n}球` : ''}</span></div>
    <div>狙い <b>${fmtD(aimDist)}</b>・高低差 <b>${hDisp}</b>${state.wind.speed ? `・風 ${windLabel()}` : ''}
      → 実質 <span class="em">${fmtD(pl)}</span>　おすすめ <span class="em">${state.recClub ? lbl(state.recClub) : '—'}</span></div>
    <div>着弾中心 <b>${fmtD(sm.along)}</b> ${side(sm.side)}${restToGreen != null ? `・グリーンまで残り <b>${fmtD(restToGreen)}</b>` : ''}</div>
    <div class="sub">80%範囲 前後 ${fmtN(sm.alongLo)}–${fmtD(sm.alongHi)}・左右 ${side(sm.sideLo)}〜${side(sm.sideHi)}</div>`;
  renderClubs();
}

function windLabel() {
  const names = { 0: 'アゲ', 45: '右前から', 90: '右から', 135: '右後ろから', 180: 'フォロー', 225: '左後ろから', 270: '左から', 315: '左前から' };
  return `${names[state.wind.fromRel] ?? ''}${state.wind.speed}m/s`;
}

// ---------- 番手 ----------
function renderClubs() {
  const box = $('#clubs');
  const ids = C.sortClubs(Object.keys(models));
  const html = ids.map((c) => `<button class="chip${c === state.club ? ' on' : ''}${!state.comp && c === state.recClub ? ' rec' : ''}" data-c="${c}">
    <b>${lbl(c)}</b><small>${fmtN(models[c].carryMean * (state.comp ? 1 : state.air))}</small><i class="lv ${models[c].level}"></i></button>`).join('');
  if (box.dataset.html !== html) { box.innerHTML = html; box.dataset.html = html; }
}
$('#clubs').addEventListener('click', (e) => {
  const b = e.target.closest('.chip');
  if (!b) return;
  state.club = b.dataset.c;
  state.autoClub = false;
  scheduleRecompute();
  persist();
});

// ---------- 操作パネル ----------
$('#dir').addEventListener('input', (e) => {
  state.dirOffset = parseFloat(e.target.value);
  $('#dirOut').textContent = `${state.dirOffset > 0 ? 'R' : state.dirOffset < 0 ? 'L' : ''}${Math.abs(state.dirOffset)}°`;
  scheduleRecompute();
});
$('#dir').addEventListener('change', persist);
$$('.nudge').forEach((b) => b.addEventListener('click', () => {
  const r = $('#dir');
  r.value = Math.max(+r.min, Math.min(+r.max, parseFloat(r.value) + parseFloat(b.dataset.d)));
  r.dispatchEvent(new Event('input'));
  persist();
}));
$('#tapMode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.tapMode = b.dataset.v;
  $$('#tapMode button').forEach((x) => x.classList.toggle('on', x === b));
});

function renderDotsToggle() {
  $('#btnDots').classList.toggle('on', state.showDots);
  $('#btnDots').textContent = state.showDots ? '点群 表示' : '点群 非表示';
  $('#legendDots').hidden = !state.showDots;
  if (map.getLayer('dots')) map.setLayoutProperty('dots', 'visibility', state.showDots ? 'visible' : 'none');
}
$('#btnDots').addEventListener('click', () => { state.showDots = !state.showDots; renderDotsToggle(); persist(); });

function renderWind() {
  const w = state.wind;
  $('#btnWind').textContent = `${w.speed ? `風 ${windLabel()}` : '風 なし'}・${settings.courseTemp}℃`;
  $('#btnWind').classList.toggle('on', !!w.speed);
  $('#windSpeed').value = w.speed;
  $('#windSpeedOut').textContent = `${w.speed} m/s`;
  $('#courseTemp').value = settings.courseTemp;
  $$('#compass button').forEach((b) => b.classList.toggle('on', b.dataset.a === 'off' ? !w.speed : !!w.speed && +b.dataset.a === w.fromRel));
}
$('#btnWind').addEventListener('click', () => { $('#windPanel').hidden = !$('#windPanel').hidden; });
$('#compass').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.wind = b.dataset.a === 'off' ? { ...state.wind, speed: 0 } : { fromRel: +b.dataset.a, speed: state.wind.speed || 3 };
  renderWind(); scheduleRecompute(); persist();
});
$('#windSpeed').addEventListener('input', (e) => { state.wind = { ...state.wind, speed: parseFloat(e.target.value) }; renderWind(); scheduleRecompute(); persist(); });
$('#courseTemp').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  settings = { ...settings, courseTemp: v };
  S.save('settings', settings);
  renderWind(); scheduleRecompute();
});

// 競技モード
function renderComp() {
  document.body.classList.toggle('comp-mode', state.comp);
  $('#btnComp').classList.toggle('on', state.comp);
  $('#btnComp').textContent = state.comp ? '競技中' : '競技';
}
$('#btnComp').addEventListener('click', () => {
  state.comp = !state.comp;
  renderComp(); scheduleRecompute(); persist();
  toast(state.comp ? '競技モード: 距離のみ表示します' : '競技モードを解除しました');
});

// 狙い方向を上に（打つ位置〜着弾範囲が収まるように）
$('#btnUp').addEventListener('click', () => {
  const aim = aimPoint();
  const brg = G.bearing(state.ball, aim);
  const far = G.destination(state.ball, brg, G.distance(state.ball, aim) + 30);
  const pts = [state.ball, far, G.destination(aim, brg - Math.PI / 2, 30), G.destination(aim, brg + Math.PI / 2, 30)];
  const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(state.ball, state.ball));
  const cam = map.cameraForBounds(bounds, { bearing: deg(brg), padding: { top: 70, bottom: sheetHeight() + 20, left: 20, right: 20 }, maxZoom: 19 });
  map.easeTo({ ...cam, bearing: deg(brg) });
});

// ---------- GPS ----------
function setBall(p) {
  state.ball = p;
  ballMk.setLngLat(p);
  clearGps();
}
function clearGps() {
  if (!state.gpsAcc) return;
  state.gpsAcc = null;
  map.getSource('gps')?.setData(empty);
}
function circlePolygon(center, r) {
  const ring = Array.from({ length: 49 }, (_, i) => G.destination(center, (i / 48) * 2 * Math.PI, r));
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } };
}
// 最大8秒間測位を続け、誤差の小さい測位ほど重くして平均する（ばらつきは減るが、木や斜面による系統的なズレは残る）
$('#btnGps').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('この端末では位置情報が使えません');
  const fixes = [];
  let done = false;
  let id = null;
  const finish = () => {
    if (done) return;
    done = true;
    if (id != null) navigator.geolocation.clearWatch(id);
    clearTimeout(timer);
    if (!fixes.length) return toast('位置情報を取得できませんでした');
    const use = fixes.slice(-10);
    const ws = use.map((f) => 1 / Math.max(1, f.acc) ** 2);
    const W = ws.reduce((a, b) => a + b, 0);
    const p = [use.reduce((t, f, i) => t + f.p[0] * ws[i], 0) / W, use.reduce((t, f, i) => t + f.p[1] * ws[i], 0) / W];
    const best = Math.min(...use.map((f) => f.acc));
    bakeAim();
    setBall(p);
    state.gpsAcc = { center: p, radius: best };
    map.getSource('gps')?.setData({ type: 'FeatureCollection', features: [circlePolygon(p, best)] });
    map.easeTo({ center: p });
    toast(`現在地を反映（${use.length}回平均・誤差 約${Math.round(best)}m）。青い円の中のどこかにいます`, { ms: 4000 });
    scheduleRecompute(); persist();
  };
  const timer = setTimeout(finish, 8000);
  toast('測位中…（最大8秒）', { ms: 9000 });
  id = navigator.geolocation.watchPosition((pos) => {
    fixes.push({ p: [pos.coords.longitude, pos.coords.latitude], acc: pos.coords.accuracy });
    toast(`測位中… ${fixes.length}回（誤差 約${Math.round(pos.coords.accuracy)}m）`, { ms: 9000 });
    if (fixes.length >= 5 && pos.coords.accuracy <= 5) finish();
  }, (err) => {
    if (fixes.length) return;
    done = true;
    clearTimeout(timer);
    if (id != null) navigator.geolocation.clearWatch(id);
    toast(`位置情報を取得できません（${err.message}）`);
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
});

// ---------- 距離リング（グリーンからの残り距離） ----------
// カートナビや距離杭の表示と照らし合わせて、自分の位置を正確に置くための目盛り（競技モードでも使える距離情報）
const ringOffsetM = () => settings.ringOffsetM || 0;   // エッジ基準ならセンターまでの差を足す
let ringLabels = [];
function renderRings() {
  ringLabels.forEach((m) => m.remove());
  ringLabels = [];
  const src = map.getSource('rings');
  if (!src) return;
  const h = course.holes[state.hole];
  if (!state.showRings || !h) { src.setData(empty); return; }
  const step = settings.unit === 'yd' ? M.YD : 1;   // 表示単位で10刻み
  const brgLabel = G.bearing(h.green, h.tee) + 0.3;   // ティー方向から少しずらして狙い線と重ならないように
  const features = [];
  for (let d = 30; d <= 300; d += 10) {
    const r = d * step + ringOffsetM();
    const major = d % 50 === 0;
    const ring = Array.from({ length: 97 }, (_, i) => G.destination(h.green, (i / 96) * 2 * Math.PI, r));
    features.push({ type: 'Feature', properties: { major }, geometry: { type: 'LineString', coordinates: ring } });
    if (major) ringLabels.push(new maplibregl.Marker({ element: Object.assign(mk('mk-ring'), { textContent: `${d}` }) }).setLngLat(G.destination(h.green, brgLabel, r)).addTo(map));
  }
  src.setData({ type: 'FeatureCollection', features });
}
function renderRingToggle() {
  $('#btnRings').classList.toggle('on', state.showRings);
  $('#btnRings').textContent = state.showRings ? 'リング 表示' : 'リング 非表示';
}
$('#btnRings').addEventListener('click', () => { state.showRings = !state.showRings; renderRingToggle(); renderRings(); persist(); });
// カート・杭の残り距離で打つ位置を補正: いまの位置の「グリーンから見た方向」は保ち、距離だけ合わせる
$('#btnCalib').addEventListener('click', () => {
  const h = course.holes[state.hole];
  if (!h) return toast('ホールを選んでから使ってください');
  const ref = settings.ringOffsetM ? 'エッジ' : 'センター';
  const unit = settings.unit === 'yd' ? 'y' : 'm';
  const k = settings.unit === 'yd' ? M.YD : 1;
  const cur = Math.round(Math.max(0, G.distance(h.green, state.ball) - ringOffsetM()) / k);
  const v = parseFloat(prompt(`カート・距離杭の表示（グリーン${ref}まで、${unit}）`, cur));
  if (!Number.isFinite(v) || v <= 0) return;
  bakeAim();
  setBall(G.destination(h.green, G.bearing(h.green, state.ball), v * k + ringOffsetM()));
  toast(`グリーン${ref}まで ${v}${unit} の位置に補正しました`);
  scheduleRecompute(); persist();
});

// ---------- 結果の記録（ラウンド中の1タップ） ----------
$('#btnRecord').addEventListener('click', () => {
  if (state.recording) return stopRecording();
  state.recording = true;
  $('#btnRecord').classList.add('on');
  banner(`${lbl(state.club)} の結果: ボールが止まった位置をタップ`, stopRecording);
});
function stopRecording() {
  state.recording = false;
  $('#btnRecord').classList.remove('on');
  $('#banner').hidden = true;
}
function handleRecordClick(p) {
  const origin = state.ball;
  const brg = G.bearing(origin, aimPoint());   // 狙った方向を基準に左右を測る
  const [x, y] = G.toLocal(origin, p);
  const along = x * Math.sin(brg) + y * Math.cos(brg);
  const side = x * Math.cos(brg) - y * Math.sin(brg);
  stopRecording();
  if (along < 5) return toast('打った位置より前をタップしてください');
  const h0 = dem.get(origin), h1 = dem.get(p);
  const shot = M.shotFromRound({ club: state.club, along, side, dh: h0 != null && h1 != null ? h1 - h0 : 0, elev: h0 ?? 0, temp: settings.courseTemp, settings });
  shots.push(shot);
  S.save('shots', shots);
  rebuildModels();
  // 次の1打は止まった位置から
  const prevBall = state.ball;
  setBall(p);
  scheduleRecompute(); persist();
  const sideTxt = Math.abs(side) < 0.5 * M.YD ? '' : ` ${side < 0 ? 'L' : 'R'}${fmtN(Math.abs(side))}`;
  toast(`${lbl(shot.club)} を記録: ${fmtD(along)}${sideTxt}（${models[shot.club].n}球目）`, {
    action: '取り消す', ms: 6000,
    onAction: () => {
      shots = shots.filter((s) => s !== shot);
      S.save('shots', shots);
      rebuildModels();
      setBall(prevBall);
      scheduleRecompute(); persist();
    },
  });
}

// ---------- コース・ホール ----------
function renderCourse() {
  $('#btnCourse').textContent = course.name.replace('（サンプル）', '');
  const opts = ['<option value="">フリー</option>'];
  for (let i = 1; i <= course.holeCount; i++) {
    const inf = course.info?.[i];
    opts.push(`<option value="${i}">${i}番${inf ? ` P${inf.par} ${inf.yd}y` : ''}${course.holes[i] ? '' : '（未登録）'}</option>`);
  }
  $('#hole').innerHTML = opts.join('');
  $('#hole').value = state.hole;
}

let holeMarkers = [];
function renderHoleMarkers() {
  holeMarkers.forEach((m) => m.remove());
  holeMarkers = [];
  for (const [no, h] of Object.entries(course.holes)) {
    holeMarkers.push(new maplibregl.Marker({ element: Object.assign(mk('mk-hole'), { textContent: no }) }).setLngLat(h.green).addTo(map));
    holeMarkers.push(new maplibregl.Marker({ element: mk('mk-tee') }).setLngLat(h.tee).addTo(map));
  }
}

function selectCourse(c) {
  course = c;
  state.hole = '';
  setBall(c.center);
  state.aimBase = G.destination(c.center, 0, 130);
  resetDir();
  renderCourse(); renderHoleMarkers(); renderRings();
  map.jumpTo({ center: c.center, zoom: 16, bearing: 0 });
  scheduleRecompute(); persist();
}

function goHole(no) {
  const h = course.holes[no];
  if (!h) return;
  const brg = G.bearing(h.tee, h.green);
  const len = G.distance(h.tee, h.green);
  setBall(h.tee);
  renderRings();
  const longest = Math.max(...Object.values(models).map((m) => m.carryMean));
  state.aimBase = len <= longest * 1.05 ? h.green : G.destination(h.tee, brg, longest);
  resetDir();
  state.club = M.recommendClub(models, G.distance(h.tee, state.aimBase)) || state.club;
  state.autoClub = true;   // 標高が取れたら高低差込みで選び直す
  const bounds = new maplibregl.LngLatBounds(h.tee, h.tee).extend(h.green);
  const cam = map.cameraForBounds(bounds, { bearing: deg(brg), padding: { top: 70, bottom: sheetHeight() + 20, left: 40, right: 40 }, maxZoom: 18.5 });
  map.easeTo({ ...cam, bearing: deg(brg), duration: 600 });
  scheduleRecompute(); persist();
}

function startEdit(no) {
  state.editing = { hole: no, step: 'tee' };
  banner(`${no}番: ティーの位置をタップ`, () => { state.editing = null; });
}
function handleEditClick(p) {
  const ed = state.editing;
  if (ed.step === 'tee') {
    ed.tee = p;
    ed.step = 'green';
    banner(`${ed.hole}番: グリーン中心をタップ`, () => { state.editing = null; });
    return;
  }
  course.holes[ed.hole] = { tee: ed.tee, green: p };
  CR.saveHoles(courses, course);
  state.editing = null;
  $('#banner').hidden = true;
  renderCourse(); renderHoleMarkers();
  toast(`${ed.hole}番を登録（${fmtD(G.distance(course.holes[ed.hole].tee, p))}）`);
  goHole(ed.hole);
}
$('#hole').addEventListener('change', (e) => {
  state.hole = e.target.value;
  state.editing = null;
  $('#banner').hidden = true;
  renderRings();
  if (!state.hole) return persist();
  if (course.holes[state.hole]) goHole(state.hole);
  else startEdit(state.hole);
});
$('#btnHoleEdit').addEventListener('click', () => (state.hole ? startEdit(state.hole) : toast('先にホールを選んでください')));

// コース選択ダイアログ
const courseDlg = $('#courseDlg');
function renderCourseList() {
  $('#courseList').innerHTML = courses.map((c) => `
    <div class="course-item${c.id === course.id ? ' on' : ''}">
      <div class="name">${escapeHtml(c.name)}<small>${Object.keys(c.holes).length}/${c.holeCount}ホール登録</small></div>
      <button data-sel="${c.id}">選ぶ</button>${c.sample ? '' : `<button data-del="${c.id}" aria-label="削除">🗑</button>`}
    </div>`).join('');
}
$('#btnCourse').addEventListener('click', () => { renderCourseList(); courseDlg.showModal(); });
$('#courseList').addEventListener('click', (e) => {
  const sel = e.target.closest('[data-sel]'), del = e.target.closest('[data-del]');
  if (sel) { selectCourse(courses.find((c) => c.id === sel.dataset.sel)); courseDlg.close(); }
  if (del && confirm('このコースを削除しますか？（登録したホール位置も消えます）')) {
    const wasCurrent = del.dataset.del === course.id;
    CR.deleteCourse(courses, del.dataset.del);
    if (wasCurrent) selectCourse(courses[0]);
    renderCourseList();
  }
});
function createCourse(center, fallbackName) {
  const name = $('#newCourseName').value.trim() || fallbackName || '新しいコース';
  const c = CR.addCourse(courses, name, center);
  $('#newCourseName').value = '';
  $('#placeResults').innerHTML = '';
  courseDlg.close();
  selectCourse(c);
  toast(`「${c.name}」を作成しました。ホールを選んで登録してください`, { ms: 5000 });
}
$('#btnPlaceSearch').addEventListener('click', async () => {
  const q = $('#placeQuery').value.trim();
  if (!q) return;
  try {
    const list = await CR.searchPlace(q);
    $('#placeResults').innerHTML = list.length
      ? list.map((r, i) => `<button data-i="${i}">${escapeHtml(r.title)}</button>`).join('')
      : '<p class="hint">見つかりませんでした</p>';
    $('#placeResults').onclick = (e) => {
      const b = e.target.closest('button[data-i]');
      if (b) createCourse(list[+b.dataset.i].center, list[+b.dataset.i].title);
    };
  } catch {
    $('#placeResults').innerHTML = '<p class="hint">検索できませんでした（オフライン？）</p>';
  }
});
$('#btnCourseHere').addEventListener('click', () => {
  navigator.geolocation?.getCurrentPosition(
    (pos) => createCourse([pos.coords.longitude, pos.coords.latitude]),
    () => toast('位置情報を取得できません'), { enableHighAccuracy: true, timeout: 15000 });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 初回設定（オンボーディング） ----------
const ob = $('#onboarding');
const obState = { step: 0, bag: [], carries: {}, distMode: 'carry' };
const OB_STEPS = 5;

function openOnboarding(editing) {
  obState.step = editing ? 1 : 0;
  obState.bag = profile ? C.sortClubs(Object.keys(profile.clubs)) : [...C.DEFAULT_BAG];
  obState.distMode = profile?.distMode || 'carry';
  obState.carries = {};
  if (profile) {
    // 保存はキャリー（m）。入力欄は選んだ単位・モードで表示
    for (const [id, v] of Object.entries(profile.clubs)) obState.carries[id] = v.carry;
    $('#obScore').value = profile.score;
    $('#obUnit').value = settings.unit;
    setSeg('#obTendAll', profile.tendency.all);
    setSeg('#obTendDr', profile.tendency.driver || '');
  }
  $('#obScoreOut').textContent = $('#obScore').value;
  setSeg('#obDistMode', obState.distMode);
  $('#obAgree').checked = !!profile;
  renderObStep();
  ob.showModal();
}
function setSeg(sel, v) { $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
function segVal(sel) { return $(`${sel} button.on`)?.dataset.v ?? ''; }
$$('#onboarding .seg').forEach((seg) => seg.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (seg.id === 'obDistMode') readCarryInputs();
  seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  if (seg.id === 'obDistMode') { obState.distMode = b.dataset.v; renderCarryInputs(); }
}));
$('#obScore').addEventListener('input', (e) => { $('#obScoreOut').textContent = e.target.value; });
$('#obAgree').addEventListener('change', renderObStep);

// 表示値 ⇔ 保存値（キャリー, m）
const unitOb = () => $('#obUnit').value;
const toDisplay = (id, carryM) => {
  const v = obState.distMode === 'total' ? carryM / C.carryRatio(id) : carryM;
  return Math.round(unitOb() === 'yd' ? v / M.YD : v);
};
const fromDisplay = (id, val) => {
  const m = unitOb() === 'yd' ? val * M.YD : val;
  return obState.distMode === 'total' ? m * C.carryRatio(id) : m;
};

function renderBag() {
  $('#obBag').innerHTML = C.ALL_CLUBS.map((id) => `<button data-id="${id}" class="${obState.bag.includes(id) ? 'on' : ''}">${lbl(id)}</button>`).join('');
}
$('#obBag').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const id = b.dataset.id;
  obState.bag = obState.bag.includes(id) ? obState.bag.filter((x) => x !== id) : C.sortClubs([...obState.bag, id]);
  renderBag(); renderObStep();
});
function readCarryInputs() {
  $$('#obCarries input').forEach((el) => {
    const v = parseFloat(el.value);
    if (v > 0) obState.carries[el.dataset.id] = fromDisplay(el.dataset.id, v);
  });
}
function renderCarryInputs() {
  $('#obCarries').innerHTML = obState.bag.map((id) => `<label>${lbl(id)} <input type="number" inputmode="numeric" data-id="${id}" value="${obState.carries[id] ? toDisplay(id, obState.carries[id]) : ''}"></label>`).join('');
  const q7 = obState.carries['7I'], q1 = obState.carries['1W'];
  $('#obQuick7I').value = q7 ? toDisplay('7I', q7) : '';
  $('#obQuick1W').value = q1 ? toDisplay('1W', q1) : '';
}
$('#obFill').addEventListener('click', () => {
  const v7 = parseFloat($('#obQuick7I').value), v1 = parseFloat($('#obQuick1W').value);
  if (!(v7 > 0)) return toast('7番アイアンの距離を入れてください');
  const sug = C.suggestCarries(obState.bag, fromDisplay('7I', v7), v1 > 0 ? fromDisplay('1W', v1) : null);
  obState.carries = { ...obState.carries, ...sug };
  renderCarryInputs(); renderObStep();
});
$('#obCarries').addEventListener('input', () => { readCarryInputs(); renderObStep(); });

function obValid() {
  if (obState.step === 0) return $('#obAgree').checked;
  if (obState.step === 2) return obState.bag.length >= 3;
  if (obState.step === 3) return obState.bag.every((id) => obState.carries[id] > 0);
  return true;
}
function renderObStep() {
  $$('.ob-step').forEach((el) => { el.hidden = +el.dataset.step !== obState.step; });
  if (obState.step === 2) renderBag();
  if (obState.step === 3) renderCarryInputs();
  $('#obBack').hidden = obState.step === 0;
  $('#obNext').textContent = obState.step === OB_STEPS - 1 ? 'はじめる' : '次へ';
  $('#obNext').disabled = !obValid();
  $('#obProgress').textContent = `${obState.step + 1} / ${OB_STEPS}`;
}
$('#obBack').addEventListener('click', () => { if (obState.step === 3) readCarryInputs(); obState.step = Math.max(0, obState.step - 1); renderObStep(); });
$('#obNext').addEventListener('click', () => {
  if (obState.step === 3) readCarryInputs();
  if (!obValid()) return;
  if (obState.step < OB_STEPS - 1) { obState.step++; renderObStep(); return; }
  profile = {
    score: +$('#obScore').value,
    distMode: obState.distMode,
    clubs: Object.fromEntries(obState.bag.map((id) => [id, { carry: obState.carries[id] }])),
    tendency: { all: segVal('#obTendAll') || 'S', driver: segVal('#obTendDr') || '' },   // driver '' = 全体と同じ
    updatedAt: Date.now(),
  };
  settings = { ...settings, unit: $('#obUnit').value };
  S.save('profile', profile);
  S.save('settings', settings);
  rebuildModels();
  ob.close();
  scheduleRecompute();
  toast('準備ができました。番手を選んで狙いをタップしてください', { ms: 5000 });
});
// 初回設定は閉じられないように（Esc対策）
ob.addEventListener('cancel', (e) => { if (!profile) e.preventDefault(); });

// ---------- 設定 ----------
const dlg = $('#settings');
$('#btnSettings').addEventListener('click', () => { fillSettings(); dlg.showModal(); });
$('#btnEditProfile').addEventListener('click', () => { dlg.close(); openOnboarding(true); });

function fillSettings() {
  $('#unit').value = settings.unit;
  $('#csvUnit').value = settings.unit;
  $('#csvElev').value = settings.csvElev;
  $('#csvTemp').value = settings.csvTemp;
  $('#priorStrength').value = settings.priorStrength;
  $('#halfLifeDays').value = settings.halfLifeDays;
  $('#windHead').value = +(settings.windHead * 100).toFixed(2);
  $('#windTail').value = +(settings.windTail * 100).toFixed(2);
  $('#windCross').value = +(settings.windCross * 100).toFixed(2);
  $('#altitudePct').value = settings.altitudePct;
  $('#ringOffset').value = Math.round((settings.ringOffsetM || 0) / (settings.unit === 'yd' ? M.YD : 1));
  renderProfileSummary();
  renderStatTable();
}
function readSettings() {
  const num = (id, d) => { const v = parseFloat($(`#${id}`).value); return Number.isFinite(v) ? v : d; };
  settings = {
    ...settings,
    unit: $('#unit').value,
    csvElev: num('csvElev', 50), csvTemp: num('csvTemp', 20),
    priorStrength: Math.max(1, num('priorStrength', 10)),
    halfLifeDays: Math.max(0, num('halfLifeDays', 90)),
    windHead: num('windHead', 1.4) / 100, windTail: num('windTail', 1.0) / 100, windCross: num('windCross', 1.2) / 100,
    altitudePct: num('altitudePct', 4),
    ringOffsetM: num('ringOffset', 0) * ($('#unit').value === 'yd' ? M.YD : 1),
  };
  S.save('settings', settings);
  rebuildModels();
  renderStatTable(); renderWind(); renderRings(); scheduleRecompute();
}
dlg.querySelectorAll('input[type=number], select:not(#csvUnit)').forEach((el) => el.addEventListener('change', readSettings));

function renderProfileSummary() {
  if (!profile) return;
  const t = { L: '左が多い', S: 'まっすぐ', R: '右が多い' };
  const rounds = shots.filter((s) => s.src === 'round').length, csv = shots.filter((s) => s.src === 'csv').length;
  const dr = profile.tendency.driver ? `（1W ${t[profile.tendency.driver]}）` : '';
  $('#profileSummary').textContent = `平均スコア ${profile.score}・曲がり ${t[profile.tendency.all]}${dr}・記録 ${rounds}球${csv ? `・CSV ${csv}球` : ''}`;
}
function renderStatTable() {
  const u = settings.unit === 'yd' ? 'y' : 'm';
  const rows = C.sortClubs(Object.keys(models)).map((id) => {
    const m = models[id];
    return `<tr><td>${lbl(id)}</td><td>${fmtN(m.prior.carry)}</td><td>${fmtN(m.carryMean)}</td><td>${m.n}</td><td><span class="badge ${m.level}">${M.LEVEL_LABEL[m.level]}</span></td>
      <td>${m.n ? `<button class="mini" data-clear="${id}">記録を消す</button>` : ''}</td></tr>`;
  }).join('');
  $('#statTable').innerHTML = `<thead><tr><th>番手</th><th>入力(${u})</th><th>予測(${u})</th><th>記録</th><th>状態</th><th></th></tr></thead><tbody>${rows}</tbody>`;
}
$('#statTable').addEventListener('click', (e) => {
  const b = e.target.closest('[data-clear]');
  if (!b || !confirm(`${lbl(b.dataset.clear)} の記録をすべて削除しますか？`)) return;
  shots = shots.filter((s) => s.club !== b.dataset.clear);
  S.save('shots', shots);
  rebuildModels(); renderStatTable(); renderProfileSummary(); scheduleRecompute();
});

// CSV取込（上級者向け）
function importCsv(text) {
  const { shots: add, skipped } = M.parseShotsCsv(text, {
    unit: $('#csvUnit').value, bag: Object.keys(profile.clubs), elev: settings.csvElev, temp: settings.csvTemp, settings,
  });
  const inBag = add.filter((s) => profile.clubs[s.club]);
  if (!inBag.length) return toast('バッグの番手に合うショットが見つかりませんでした');
  shots = [...shots, ...inBag];
  S.save('shots', shots);
  rebuildModels(); renderStatTable(); renderProfileSummary(); scheduleRecompute();
  $('#csvText').value = '';
  const clubs = [...new Set(inBag.map((s) => lbl(s.club)))].join('・');
  toast(`${inBag.length}球を取り込みました（${clubs}）${skipped + add.length - inBag.length ? `・対象外 ${skipped + add.length - inBag.length}行` : ''}`, { ms: 5000 });
}
$('#csvFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) importCsv(await f.text());
  e.target.value = '';
});
$('#btnImport').addEventListener('click', () => importCsv($('#csvText').value));

// バックアップ（サーバーを持たないので端末間の移行・機種変更用）
$('#btnExport').addEventListener('click', () => {
  const data = { app: 'shotmap', version: 1, exportedAt: new Date().toISOString(), profile, shots, settings, courses: courses.filter((c) => !c.sample),
    sampleHoles: Object.fromEntries(courses.filter((c) => c.sample).map((c) => [c.id, c.holes])) };
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' })),
    download: `shotmap-backup-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('#backupFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (d.app !== 'shotmap') throw new Error();
    if (!confirm('現在のデータをバックアップの内容で置き換えますか？')) return;
    S.save('profile', d.profile); S.save('shots', d.shots || []); S.save('settings', d.settings || {}); S.save('courses', d.courses || []);
    for (const [id, holes] of Object.entries(d.sampleHoles || {})) S.save(`holes.${id}`, holes);
    location.reload();
  } catch {
    toast('バックアップファイルを読み込めませんでした');
  }
});
$('#btnReset').addEventListener('click', () => {
  if (!confirm('腕前・飛距離・記録・追加したコースをすべて削除します。よろしいですか？')) return;
  for (const k of ['profile', 'shots', 'settings', 'courses', 'ui', ...courses.filter((c) => c.sample).map((c) => `holes.${c.id}`)]) S.remove(k);
  location.reload();
});

// オフライン保存（このコースの航空写真・標高）
$('#btnOffline').addEventListener('click', async () => {
  const st = $('#offlineStatus');
  if (!navigator.serviceWorker?.controller) { st.textContent = 'オフライン機能が有効になっていません（再読み込みしてから再実行）'; return; }
  const [w, s, e, n] = course.bbox;
  const pad = 0.003;
  const bbox = [w - pad, s - pad, e + pad, n + pad];
  const urls = [];
  for (let z = 14; z <= 18; z++) for (const [, x, y] of G.tilesInBbox(bbox, z)) urls.push(`https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`);
  for (const [src, z] of [['dem1a_png', 17], ['dem5a_png', 15], ['dem_png', 14]]) for (const [, x, y] of G.tilesInBbox(bbox, z)) urls.push(demUrl(src, z, x, y));
  let done = 0, failed = 0;
  const queue = [...urls];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try { if (!(await fetch(u)).ok) failed++; } catch { failed++; }
      st.textContent = `保存中… ${++done} / ${urls.length}`;
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  st.textContent = `保存完了: ${urls.length - failed} 枚${failed ? `（${failed}件失敗）` : ''}`;
});

// ---------- 起動 ----------
renderCourse();
renderDotsToggle();
renderRingToggle();
renderWind();
renderComp();
if (!profile) openOnboarding(false);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// 検証用
window.__app = { state, map, models: () => models, profile: () => profile, shots: () => shots, settings: () => settings };
