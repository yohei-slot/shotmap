// クラブの定義（番手ID・表示名・種類・目安値）
// ウェッジはロフト角をIDにする（'52' → 表示 52°）

export const YD = 0.9144;

// 7番アイアンのキャリーを1としたときの目安比率（アマチュア平均的なギャップ）
const IRON_RATIO = { 3: 1.17, 4: 1.13, 5: 1.08, 6: 1.04, 7: 1.0, 8: 0.93, 9: 0.86 };
const WOOD_RATIO = { 1: 1.42, 3: 1.30, 4: 1.26, 5: 1.22, 7: 1.16, 9: 1.11 };
const UT_RATIO = { 2: 1.22, 3: 1.17, 4: 1.12, 5: 1.07, 6: 1.03, 7: 0.99 };

export const ALL_CLUBS = [
  '1W', '3W', '4W', '5W', '7W', '9W',
  '2U', '3U', '4U', '5U', '6U', '7U',
  '3I', '4I', '5I', '6I', '7I', '8I', '9I', 'PW',
  '46', '48', '50', '52', '54', '56', '58', '60',
];

export const DEFAULT_BAG = ['1W', '3W', '5W', '4U', '5I', '6I', '7I', '8I', '9I', 'PW', '50', '56'];

export function clubType(id) {
  if (id === '1W') return 'driver';
  if (id === 'PW') return 'shortIron';
  if (/^\d+W$/.test(id)) return 'wood';
  if (/^\d+U$/.test(id)) return 'utility';
  if (/I$/.test(id)) return parseInt(id, 10) <= 5 ? 'longIron' : parseInt(id, 10) <= 7 ? 'midIron' : 'shortIron';
  return 'wedge';
}

export function clubLabel(id) {
  return /^\d+$/.test(id) ? `${id}°` : id;
}

// 7Iキャリーに対する比率（ドライバーは別入力があればそちらを優先）
export function ratioTo7I(id) {
  const n = parseInt(id, 10);
  if (id === 'PW') return 0.79;
  if (/^\d+W$/.test(id)) return WOOD_RATIO[n] ?? 1.2;
  if (/U$/.test(id)) return UT_RATIO[n] ?? 1.07;
  if (/I$/.test(id)) return IRON_RATIO[n] ?? 1.0;
  return Math.max(0.4, 0.79 - (n - 45) * 0.02);   // ウェッジ: ロフト2°ごとに約4%短く
}

// 7Iとドライバーのキャリーから各番手の目安を作る
export function suggestCarries(bag, carry7I, carry1W) {
  const out = {};
  for (const id of bag) {
    let v = carry7I * ratioTo7I(id);
    // ウッド・UTはドライバー入力があればそれに合わせて補正
    if (carry1W && ['wood', 'utility'].includes(clubType(id))) v = carry7I + (carry1W - carry7I) * ((ratioTo7I(id) - 1) / (ratioTo7I('1W') - 1));
    if (id === '1W' && carry1W) v = carry1W;
    out[id] = v;
  }
  return out;
}

// キャリー÷トータル（ランの目安。トータルで入力された場合の換算と、ラウンド記録の換算に使う）
export function carryRatio(id) {
  return { driver: 0.88, wood: 0.9, utility: 0.92, longIron: 0.93, midIron: 0.94, shortIron: 0.95, wedge: 0.97 }[clubType(id)];
}

// 落下角の目安（度）。高低差をキャリー補正に換算するのに使う
export function descentAngle(id) {
  return { driver: 38, wood: 42, utility: 45, longIron: 46, midIron: 48, shortIron: 50, wedge: 52 }[clubType(id)];
}

export function sortClubs(ids) {
  return [...ids].sort((a, b) => ALL_CLUBS.indexOf(a) - ALL_CLUBS.indexOf(b));
}

// CSV等の番手名をアプリの番手IDに寄せる。ウェッジ名はバッグ内の近いロフトに割り当てる
export function normalizeClub(raw, bag = DEFAULT_BAG) {
  let s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const nearestWedge = (loft) => {
    const wedges = bag.filter((b) => /^\d+$/.test(b)).map(Number);
    if (!wedges.length) return String(loft);
    return String(wedges.reduce((a, b) => (Math.abs(b - loft) < Math.abs(a - loft) ? b : a)));
  };
  const deg = s.match(/^(\d{2})\s*(°|度|DEG)?$/);
  if (deg && +deg[1] >= 40) return deg[1];
  if (/^(DR|DRIVER|ドライバー|1W)$/.test(s)) return '1W';
  if (/(PITCHING|^P$|^PW$|ピッチング)/.test(s)) return 'PW';
  if (/(GAP|^GW$|^AW$|APPROACH|アプローチ)/.test(s)) return nearestWedge(50);
  if (/(SAND|^SW$|サンド)/.test(s)) return nearestWedge(56);
  if (/(LOB|^LW$)/.test(s)) return nearestWedge(60);
  const m = s.match(/(\d+)[\s-]*(?:番)?[\s-]*(W|WOOD|ウッド|U|UT|H|HY|HYBRID|ユーティリティ|I|IRON|アイアン)/);
  if (m) {
    const t = m[2];
    const kind = /^(W|WOOD|ウッド)$/.test(t) ? 'W' : /^(I|IRON|アイアン)$/.test(t) ? 'I' : 'U';
    return m[1] + kind;
  }
  if (/^\d$/.test(s)) return s + 'I';
  return null;
}
