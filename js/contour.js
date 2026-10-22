// 点群から「確率 p の球が入る最小の領域」（最高密度領域）の輪郭を作る。
// 楕円と違い形を仮定しないので、片寄ったミスや離れたミスの塊も形に出る。
// 座標は打球方向基準（[前方, 右方]）で渡すと格子が分布の向きに揃い精度が良い。

const GRID = 72;

function blur1d(src, dst, w, h, sigma, horizontal) {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) {
        const xx = horizontal ? x + i : x, yy = horizontal ? y : y + i;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        acc += src[yy * w + xx] * k[i + r];
      }
      dst[y * w + x] = acc;
    }
  }
}

// 密度格子を作る（2次元ヒストグラム → ガウシアンぼかし）
function densityGrid(pts) {
  let minA = Infinity, maxA = -Infinity, minS = Infinity, maxS = -Infinity;
  let ma = 0, ms = 0;
  for (const [a, s] of pts) {
    minA = Math.min(minA, a); maxA = Math.max(maxA, a); minS = Math.min(minS, s); maxS = Math.max(maxS, s);
    ma += a; ms += s;
  }
  ma /= pts.length; ms /= pts.length;
  let va = 0, vs = 0;
  for (const [a, s] of pts) { va += (a - ma) ** 2; vs += (s - ms) ** 2; }
  // ぼかし幅: Scott 則（2次元）σ × n^(-1/6)
  const bw = Math.sqrt(Math.min(va, vs) / pts.length) * pts.length ** (-1 / 6);
  const pad = bw * 4;
  minA -= pad; maxA += pad; minS -= pad; maxS += pad;
  const cell = Math.max((maxA - minA) / GRID, (maxS - minS) / GRID, 0.25);
  const w = Math.ceil((maxS - minS) / cell) + 3, h = Math.ceil((maxA - minA) / cell) + 3;
  const g = new Float32Array(w * h);
  const ox = minS - cell, oy = minA - cell;   // 外周1マスは常に0（輪郭が必ず閉じる）
  for (const [a, s] of pts) {
    const fx = (s - ox) / cell, fy = (a - oy) / cell;
    const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
    g[iy * w + ix] += (1 - dx) * (1 - dy);
    g[iy * w + ix + 1] += dx * (1 - dy);
    g[(iy + 1) * w + ix] += (1 - dx) * dy;
    g[(iy + 1) * w + ix + 1] += dx * dy;
  }
  const tmp = new Float32Array(w * h);
  const sigma = Math.max(0.8, bw / cell);
  blur1d(g, tmp, w, h, sigma, true);
  blur1d(tmp, g, w, h, sigma, false);
  for (let x = 0; x < w; x++) { g[x] = 0; g[(h - 1) * w + x] = 0; }
  for (let y = 0; y < h; y++) { g[y * w] = 0; g[y * w + w - 1] = 0; }
  return { g, w, h, ox, oy, cell };
}

function sample(grid, a, s) {
  const { g, w, ox, oy, cell } = grid;
  const fx = (s - ox) / cell, fy = (a - oy) / cell;
  const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
  const at = (x, y) => g[y * w + x];
  return (1 - dy) * ((1 - dx) * at(ix, iy) + dx * at(ix + 1, iy)) + dy * ((1 - dx) * at(ix, iy + 1) + dx * at(ix + 1, iy + 1));
}

// マーチングスクエア。閉じた輪郭（格子座標）の配列を返す
function marching(grid, t) {
  const { g, w, h } = grid;
  const val = (x, y) => g[y * w + x];
  const pt = new Map();   // 辺ID → 座標
  const adj = new Map();  // 辺ID → 接続先の辺ID
  const edgePoint = (id, x0, y0, x1, y1) => {
    if (!pt.has(id)) {
      const v0 = val(x0, y0), v1 = val(x1, y1);
      const f = (t - v0) / (v1 - v0 || 1e-12);
      pt.set(id, [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f]);
    }
    return id;
  };
  const link = (a, b) => {
    (adj.get(a) || adj.set(a, []).get(a)).push(b);
    (adj.get(b) || adj.set(b, []).get(b)).push(a);
  };
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const tl = val(x, y) >= t, tr = val(x + 1, y) >= t, br = val(x + 1, y + 1) >= t, bl = val(x, y + 1) >= t;
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = () => edgePoint(`h${x},${y}`, x, y, x + 1, y);
      const B = () => edgePoint(`h${x},${y + 1}`, x, y + 1, x + 1, y + 1);
      const L = () => edgePoint(`v${x},${y}`, x, y, x, y + 1);
      const R = () => edgePoint(`v${x + 1},${y}`, x + 1, y, x + 1, y + 1);
      const center = (val(x, y) + val(x + 1, y) + val(x + 1, y + 1) + val(x, y + 1)) / 4 >= t;
      switch (code) {
        case 1: case 14: link(L(), B()); break;
        case 2: case 13: link(B(), R()); break;
        case 3: case 12: link(L(), R()); break;
        case 4: case 11: link(T(), R()); break;
        case 6: case 9: link(T(), B()); break;
        case 7: case 8: link(L(), T()); break;
        case 5: if (center) { link(L(), T()); link(B(), R()); } else { link(L(), B()); link(T(), R()); } break;
        case 10: if (center) { link(L(), B()); link(T(), R()); } else { link(L(), T()); link(B(), R()); } break;
      }
    }
  }
  const seen = new Set();
  const rings = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const ring = [];
    let prev = null, cur = start;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      ring.push(pt.get(cur));
      const next = adj.get(cur).find((n) => n !== prev && !seen.has(n));
      prev = cur;
      cur = next;
    }
    if (ring.length >= 3) { ring.push(ring[0]); rings.push(ring); }
  }
  return rings;
}

/**
 * @param pts    [[前方, 右方], ...]
 * @param probs  例 [0.5, 0.8, 0.95]
 * @returns {p: [[ [前方, 右方], ... ], ...]}  確率ごとの輪郭（複数の塊になることもある）
 */
export function hdrContours(pts, probs) {
  const grid = densityGrid(pts);
  const dens = pts.map(([a, s]) => sample(grid, a, s)).sort((x, y) => y - x);
  const out = {};
  for (const p of probs) {
    const t = dens[Math.min(dens.length - 1, Math.floor(p * dens.length))];
    out[p] = marching(grid, t).map((ring) => ring.map(([gx, gy]) => [grid.oy + gy * grid.cell, grid.ox + gx * grid.cell]));
  }
  return out;
}
