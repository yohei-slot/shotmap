// localStorage の薄いラッパ（プライベートモード等で失敗しても動くように）
const P = 'golfcm.';

export function load(key, fallback) {
  try {
    const v = localStorage.getItem(P + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(P + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(P + key); } catch { /* noop */ }
}
