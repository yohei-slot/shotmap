// 着弾シミュレーション（DOM非依存）
// 内部単位はメートル。ショットはすべて「標準大気（海抜0m・15℃）・平地」でのキャリー/左右ブレに揃えて保持する。
// 座標はボール位置を原点とするローカル平面（x=東, y=北）。
import { YD, normalizeClub, carryRatio, descentAngle } from './clubs.js';
import { clubPrior, samplePrior } from './prior.js';

export { YD };

export const DEFAULT_SETTINGS = {
  unit: 'yd',
  samples: 2000,
  priorStrength: 10,   // 自己申告の推定を「何球分の実データ」とみなすか
  halfLifeDays: 90,    // 実データの直近重視（日数で重み半分。0=無効）
  windHead: 0.014,     // 向かい風 1m/s あたりのキャリー減少率
  windTail: 0.010,     // 追い風 1m/s あたりのキャリー増加率
  windCross: 0.012,    // 横風 1m/s・キャリー1m あたりの横流れ(m)
  altitudePct: 4,      // 標高差1000mあたりのキャリー増加率(%)（約1.2%/1000ft）
  courseTemp: 20,      // ラウンド中の気温(℃)
  csvElev: 50,         // CSV取込データの練習場標高(m)
  csvTemp: 20,         // CSV取込データの練習時気温(℃)
};

// ---- 空気密度（標高・気温） ----
const SCALE_HEIGHT = 8434;
export function airDensityRatio(elev, temp) {
  return Math.exp(-elev / SCALE_HEIGHT) * (288.15 / (273.15 + temp));
}
// 標準大気と比べたキャリー倍率（空気が薄いほど飛ぶ）。「1000mで altitudePct %」から逆算し気温にも適用
export function airCarryFactor(elev, temp, settings) {
  const k = settings.altitudePct / 100 / (1 - Math.exp(-1000 / SCALE_HEIGHT));
  return 1 + k * (1 - airDensityRatio(elev ?? 0, temp ?? 15));
}

// ---- 風 ----
// fromRel: 風が吹いてくる方向（打球方向基準）。0=正面から, 90=右から, 180=背中から
export function windComponents(wind) {
  const r = (wind.fromRel * Math.PI) / 180;
  return { along: -Math.cos(r) * wind.speed, cross: -Math.sin(r) * wind.speed };
}
const windCarry = (c, along, s) => c * (1 + (along >= 0 ? s.windTail : s.windHead) * along);

// ---- CSV（玄人向け） ----
function splitLine(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (ch === delim && !q) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
function parseSide(v) {
  const s = String(v ?? '').trim();
  const num = parseFloat(s.replace(/[^\d.\-]/g, ''));
  if (!isFinite(num)) return 0;
  if (/[LＬ左]/i.test(s)) return -Math.abs(num);
  if (/[RＲ右]/i.test(s)) return Math.abs(num);
  return num;
}
// 列: club, carry, offline(右+), landing(任意), date(任意)。ヘッダ名で自動判別
export function parseShotsCsv(text, { unit = 'yd', bag, elev, temp, settings }) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { shots: [], skipped: 0 };
  const delim = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const head = splitLine(lines[0], delim);
  const find = (re) => head.findIndex((h) => re.test(h));
  let idx = {
    club: find(/club|クラブ|番手/i), carry: find(/carry|キャリー/i),
    side: find(/offline|side|lateral|deviation|左右|ブレ|横/i),
    landing: find(/landing|落下|着地/i), date: find(/date|日付/i),
  };
  let start = 1;
  if (idx.club < 0 || idx.carry < 0) {
    idx = { club: 0, carry: 1, side: 2, landing: 3, date: -1 };
    start = isFinite(parseFloat(head[1])) ? 0 : 1;
  }
  const k = unit === 'm' ? 1 : YD;
  const air = airCarryFactor(elev, temp, settings);
  const shots = [];
  let skipped = 0;
  for (let i = start; i < lines.length; i++) {
    const c = splitLine(lines[i], delim);
    const club = normalizeClub(c[idx.club], bag);
    const carry = parseFloat(c[idx.carry]);
    if (!club || !isFinite(carry) || carry <= 0) { skipped++; continue; }
    const landing = idx.landing >= 0 ? parseFloat(c[idx.landing]) : NaN;
    const at = idx.date >= 0 ? Date.parse(c[idx.date]) : NaN;
    shots.push({
      club, src: 'csv',
      carry: (carry * k) / air,
      side: (parseSide(idx.side >= 0 ? c[idx.side] : 0) * k) / air,
      landing: isFinite(landing) && landing > 10 && landing < 80 ? landing : null,
      at: isFinite(at) ? at : Date.now(),
    });
  }
  return { shots, skipped };
}

// ---- ラウンド中の記録 → 標準化したショット ----
// along/side: 打球方向基準で、止まった位置まで(m)。高低差・空気を除いて「平地・標準大気のキャリー」に戻す
export function shotFromRound({ club, along, side, dh, elev, temp, settings }) {
  const ratio = carryRatio(club);
  const tan = Math.tan((descentAngle(club) * Math.PI) / 180);
  const air = airCarryFactor(elev, temp, settings);
  const carryOnCourse = along * ratio;
  const carryFlat = carryOnCourse + (dh ?? 0) / tan;   // 打ち上げで手前に落ちた分を戻す
  return { club, src: 'round', carry: carryFlat / air, side: side / air, landing: null, at: Date.now() };
}

// ---- 番手ごとのモデル（自己申告の推定 ＋ 実データ） ----
const DAY = 86400000;
export function buildClubModels(profile, shots, settings) {
  const models = {};
  for (const club of Object.keys(profile.clubs)) {
    const prior = clubPrior(club, profile);
    const mine = shots.filter((s) => s.club === club);
    const latest = Math.max(0, ...mine.map((s) => s.at || 0));
    const hl = settings.halfLifeDays;
    const w = mine.map((s) => (hl > 0 && latest ? 0.5 ** ((latest - s.at) / (hl * DAY)) : 1));
    const W = w.reduce((a, b) => a + b, 0);
    const nEff = W > 0 ? W ** 2 / w.reduce((a, b) => a + b * b, 0) : 0;
    const n0 = settings.priorStrength;
    const priorWeight = n0 / (n0 + nEff);   // 推定から引く確率
    let acc = 0;
    const cum = w.map((v) => (acc += v / (W || 1)));
    const myMean = W ? mine.reduce((a, s, i) => a + s.carry * w[i], 0) / W : prior.carry;
    // 実データ側の揺らぎ幅: 推定のばらつきの半分を下限にする（少数データで点群が尖りすぎないように）
    const hk = Math.max(nEff, 1) ** (-1 / 6);
    models[club] = {
      club, prior, shots: mine, cum, n: mine.length, nEff, priorWeight,
      carryMean: priorWeight * prior.carry + (1 - priorWeight) * myMean,
      hCarry: Math.max(prior.distSd * hk, prior.distSd * 0.5),
      hSide: Math.max(prior.latSd * hk, prior.latSd * 0.5),
      level: mine.length >= 20 ? 'data' : mine.length >= 5 ? 'learning' : 'estimate',
    };
  }
  return models;
}

export const LEVEL_LABEL = { estimate: '推定', learning: '学習中', data: '実データ' };

// 再現性のある乱数（ドラッグ中に点群がチラつかないように固定シード）
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalPair(rand) {
  const u = Math.max(rand(), 1e-12), v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}
function pickShot(m, r) {
  let lo = 0, hi = m.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m.cum[mid] < r) lo = mid + 1; else hi = mid; }
  return m.shots[lo];
}

/**
 * 着弾シミュレーション
 * 1球ごとに「推定（自己申告）」か「実データ（カーネル密度推定）」のどちらかから引く。
 * 実データが増えるほど推定から引く確率（priorWeight）が下がり、本人の分布に寄っていく。
 * @param elev (x, y) → 標高(m) | null （原点からのローカル座標）
 */
export function simulate({ model, bearing, wind, elev, settings, n }) {
  n = n || settings.samples;
  const rand = mulberry32(12345);
  const u = [Math.sin(bearing), Math.cos(bearing)];
  const v = [Math.cos(bearing), -Math.sin(bearing)];
  const { along, cross } = windComponents(wind);
  const h0 = elev ? elev(0, 0) : null;
  const air = airCarryFactor(h0 ?? 0, settings.courseTemp, settings);
  const tanDefault = Math.tan((descentAngle(model.club) * Math.PI) / 180);
  const pts = new Array(n);
  for (let i = 0; i < n; i++) {
    let c, l, tanD = tanDefault;
    if (!model.shots.length || rand() < model.priorWeight) {
      ({ carry: c, side: l } = samplePrior(model.prior, rand, normalPair));
    } else {
      const s = pickShot(model, rand());
      const [z1, z2] = normalPair(rand);
      c = s.carry + model.hCarry * z1;
      l = s.side + model.hSide * z2;
      if (s.landing != null) tanD = Math.tan((s.landing * Math.PI) / 180);
    }
    c *= air; l *= air;
    const c0 = windCarry(c, along, settings);
    l += settings.windCross * c0 * cross;
    c = c0;
    if (h0 != null) {
      const base = c;
      for (let k = 0; k < 2; k++) {
        const h = elev(u[0] * c + v[0] * l, u[1] * c + v[1] * l);
        if (h == null) break;
        c = Math.max(base * 0.5, base - (h - h0) / tanD);
      }
    }
    pts[i] = [u[0] * c + v[0] * l, u[1] * c + v[1] * l];
  }
  return pts;
}

// 打球方向基準での中心・前後幅・左右幅（p範囲）
export function summarize(pts, bearing, p = 0.8) {
  const u = [Math.sin(bearing), Math.cos(bearing)];
  const v = [Math.cos(bearing), -Math.sin(bearing)];
  const along = pts.map(([x, y]) => x * u[0] + y * u[1]).sort((a, b) => a - b);
  const side = pts.map(([x, y]) => x * v[0] + y * v[1]).sort((a, b) => a - b);
  const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * (arr.length - 1))))];
  const lo = (1 - p) / 2, hi = 1 - lo;
  return { along: q(along, 0.5), side: q(side, 0.5), alongLo: q(along, lo), alongHi: q(along, hi), sideLo: q(side, lo), sideHi: q(side, hi) };
}

// 狙い点までの「実質距離」（高低差・風・空気を、標準大気・平地・無風のキャリーに換算）
export function playsLike(dist, dh, club, wind, air, settings) {
  const tan = Math.tan((descentAngle(club) * Math.PI) / 180);
  const { along } = windComponents(wind);
  const f = 1 + (along >= 0 ? settings.windTail : settings.windHead) * along;
  return (dist + dh / tan) / (f * air);
}

export function recommendClub(models, target) {
  let best = null, err = Infinity;
  for (const m of Object.values(models)) {
    const e = Math.abs(m.carryMean - target);
    if (e < err) { err = e; best = m.club; }
  }
  return err <= Math.max(10, target * 0.12) ? best : null;
}
