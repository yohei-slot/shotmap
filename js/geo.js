// 緯度経度 ⇔ ローカル平面(m) の簡易変換（数百m規模なので正距円筒近似で十分）
const R = 6378137;

export function toLocal(origin, lngLat) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [
    ((lngLat[0] - origin[0]) * Math.PI / 180) * R * k,
    ((lngLat[1] - origin[1]) * Math.PI / 180) * R,
  ];
}

export function toLngLat(origin, xy) {
  const k = Math.cos((origin[1] * Math.PI) / 180);
  return [
    origin[0] + (xy[0] / (R * k)) * 180 / Math.PI,
    origin[1] + (xy[1] / R) * 180 / Math.PI,
  ];
}

export function distance(a, b) {
  const [x, y] = toLocal(a, b);
  return Math.hypot(x, y);
}

// a→b の方位（北から時計回り, rad）
export function bearing(a, b) {
  const [x, y] = toLocal(a, b);
  return Math.atan2(x, y);
}

export function destination(origin, brg, dist) {
  return toLngLat(origin, [Math.sin(brg) * dist, Math.cos(brg) * dist]);
}

// Webメルカトルのタイル座標（小数）
export function tileXY(lngLat, z) {
  const n = 2 ** z;
  const lat = (lngLat[1] * Math.PI) / 180;
  return [
    ((lngLat[0] + 180) / 360) * n,
    ((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n,
  ];
}

export function tilesInBbox(bbox, z) {
  const [w, s, e, n] = bbox;
  const [x0, y0] = tileXY([w, n], z).map(Math.floor);
  const [x1, y1] = tileXY([e, s], z).map(Math.floor);
  const out = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
  return out;
}
