// 自己申告（平均スコア・飛距離・曲がり傾向）から作る「推定のばらつき」
//
// ⚠️ 下の数値は仮の初期値。公開されている統計の傾向を参考にした目安で、
//    リリース前に実データ（ラウンド記録の集計など）で校正すること。
import { clubType } from './clubs.js';

// 平均スコア → 番手共通のばらつき（キャリーに対する割合）と大ミス率
//   lat:  左右ブレの標準偏差 / キャリー（ミドルアイアン基準）
//   dist: 前後ブレの標準偏差 / キャリー
//   mis:  大ミス（トップ・ダフリ・大きな曲がり）の発生率
const SKILL_ANCHORS = [
  [72, { lat: 0.045, dist: 0.035, mis: 0.02 }],
  [80, { lat: 0.060, dist: 0.045, mis: 0.04 }],
  [90, { lat: 0.075, dist: 0.055, mis: 0.07 }],
  [100, { lat: 0.090, dist: 0.065, mis: 0.10 }],
  [110, { lat: 0.105, dist: 0.080, mis: 0.14 }],
  [120, { lat: 0.120, dist: 0.095, mis: 0.18 }],
];

// 番手の種類ごとの倍率（長いクラブほど曲がる・ミスしやすい、ウェッジは距離感がぶれやすい）
const TYPE_FACTOR = {
  driver: { lat: 1.35, dist: 0.9, mis: 1.1 },
  wood: { lat: 1.25, dist: 1.0, mis: 1.25 },
  utility: { lat: 1.15, dist: 1.0, mis: 1.15 },
  longIron: { lat: 1.1, dist: 1.05, mis: 1.2 },
  midIron: { lat: 1.0, dist: 1.0, mis: 1.0 },
  shortIron: { lat: 0.95, dist: 1.05, mis: 0.85 },
  wedge: { lat: 0.9, dist: 1.25, mis: 0.7 },
};

export function skillParams(score) {
  const s = Math.max(SKILL_ANCHORS[0][0], Math.min(SKILL_ANCHORS.at(-1)[0], score));
  for (let i = 0; i < SKILL_ANCHORS.length - 1; i++) {
    const [s0, p0] = SKILL_ANCHORS[i], [s1, p1] = SKILL_ANCHORS[i + 1];
    if (s <= s1) {
      const t = (s - s0) / (s1 - s0);
      return { lat: p0.lat + (p1.lat - p0.lat) * t, dist: p0.dist + (p1.dist - p0.dist) * t, mis: p0.mis + (p1.mis - p0.mis) * t };
    }
  }
  return SKILL_ANCHORS.at(-1)[1];
}

// 番手ごとの推定パラメータ
export function clubPrior(club, profile) {
  const k = skillParams(profile.score);
  const f = TYPE_FACTOR[clubType(club)];
  const carry = profile.clubs[club]?.carry ?? 0;
  const tendency = club === '1W' && profile.tendency.driver ? profile.tendency.driver : profile.tendency.all;
  const sign = tendency === 'L' ? -1 : tendency === 'R' ? 1 : 0;
  const latSd = k.lat * f.lat * carry;
  return {
    carry,
    latSd,
    distSd: k.dist * f.dist * carry,
    misRate: Math.min(0.35, k.mis * f.mis),
    bias: sign * 0.8 * latSd,              // 傾向側に平均をずらす
    misSideP: sign === 0 ? 0.5 : sign > 0 ? 0.75 : 0.25,   // 大ミスが右に出る確率
  };
}

// 推定分布から1球サンプリング（標準大気・平地でのキャリー/左右, m）
export function samplePrior(p, rand, normalPair) {
  if (rand() < p.misRate) {
    // 大ミス: 大きく距離が落ちる＋どちらかに大きく曲がる（傾向側が多い）
    const side = rand() < p.misSideP ? 1 : -1;
    return { carry: p.carry * (0.55 + 0.3 * rand()), side: side * p.carry * (0.08 + 0.17 * rand()) };
  }
  const [z1, z2] = normalPair(rand);
  return { carry: p.carry + p.distSd * z1, side: p.bias + p.latSd * z2 };
}
