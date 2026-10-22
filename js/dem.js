// 国土地理院 標高タイル（PNG）から標高を引く
// 優先順: 1mメッシュ(レーザ) → 5mメッシュ(レーザ) → 10mメッシュ
import { tileXY } from './geo.js';

export const DEM_SOURCES = [
  { id: 'dem1a_png', z: 17, label: '1m（レーザ）' },
  { id: 'dem5a_png', z: 15, label: '5m（レーザ）' },
  { id: 'dem_png', z: 14, label: '10m' },
];

export const demUrl = (src, z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/${src}/${z}/${x}/${y}.png`;

export class Dem {
  constructor(onLoad) {
    this.tiles = new Map();   // key → Float32Array | null(取得失敗) | 'loading'
    this.onLoad = onLoad;
    this.lastSource = null;
  }

  async loadTile(src, z, x, y) {
    const key = `${src}/${z}/${x}/${y}`;
    if (this.tiles.has(key)) return;
    this.tiles.set(key, 'loading');
    try {
      const res = await fetch(demUrl(src, z, x, y));
      if (!res.ok) throw new Error(res.status);
      const bmp = await createImageBitmap(await res.blob());
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      const h = new Float32Array(256 * 256);
      for (let i = 0; i < h.length; i++) {
        const v = d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2];
        h[i] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
      }
      this.tiles.set(key, h);
      this.onLoad?.();
    } catch {
      this.tiles.set(key, null);
    }
  }

  // 同期的に標高を返す。未取得タイルは裏で読み込み、取得後 onLoad が呼ばれる
  get(lngLat) {
    for (const s of DEM_SOURCES) {
      const [fx, fy] = tileXY(lngLat, s.z);
      const tx = Math.floor(fx), ty = Math.floor(fy);
      const key = `${s.id}/${s.z}/${tx}/${ty}`;
      const t = this.tiles.get(key);
      if (t === undefined) { this.loadTile(s.id, s.z, tx, ty); continue; }
      if (!(t instanceof Float32Array)) continue;
      const px = Math.min(254.999, Math.max(0, (fx - tx) * 256 - 0.5));
      const py = Math.min(254.999, Math.max(0, (fy - ty) * 256 - 0.5));
      const ix = Math.floor(px), iy = Math.floor(py), ax = px - ix, ay = py - iy;
      const at = (i, j) => t[(iy + j) * 256 + ix + i];
      const v = (1 - ay) * ((1 - ax) * at(0, 0) + ax * at(1, 0)) + ay * ((1 - ax) * at(0, 1) + ax * at(1, 1));
      if (Number.isFinite(v)) { this.lastSource = s.label; return v; }
      const n = at(Math.round(ax), Math.round(ay));
      if (Number.isFinite(n)) { this.lastSource = s.label; return n; }
    }
    return null;
  }
}
