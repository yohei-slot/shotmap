// コースの管理（同梱サンプル＋ユーザーが追加したコース）
import * as S from './store.js';

// 同梱コース（先頭が初回起動時のコース）。sample=true は削除不可で、ホール登録は端末側に上書き保存
const SAMPLE_URLS = ['courses/harmonyhills.json', 'courses/sample-kisokoma.json'];

export async function loadCourses() {
  const samples = (await Promise.all(SAMPLE_URLS.map((u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null)))).filter(Boolean);
  const user = S.load('courses', []);
  // サンプルのホール位置をユーザーが登録し直した分を重ねる
  for (const c of samples) c.holes = { ...c.holes, ...S.load(`holes.${c.id}`, {}) };
  return [...samples, ...user];
}

export function saveHoles(courses, course) {
  if (course.sample) {
    S.save(`holes.${course.id}`, course.holes);
  } else {
    S.save('courses', courses.filter((c) => !c.sample));
  }
}

// 中心から約1km四方をコース範囲（オフライン保存の対象）とする
export function addCourse(courses, name, center) {
  const dLat = 0.009, dLon = 0.009 / Math.cos((center[1] * Math.PI) / 180);
  const course = {
    id: `c${Date.now()}`, name, center, holeCount: 18, holes: {},
    bbox: [center[0] - dLon, center[1] - dLat, center[0] + dLon, center[1] + dLat],
  };
  courses.push(course);
  S.save('courses', courses.filter((c) => !c.sample));
  return course;
}

export function deleteCourse(courses, id) {
  const i = courses.findIndex((c) => c.id === id && !c.sample);
  if (i >= 0) courses.splice(i, 1);
  S.save('courses', courses.filter((c) => !c.sample));
}

// 住所・地名から位置を探す（国土地理院 住所検索）
export async function searchPlace(q) {
  const r = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
  const list = await r.json();
  return list.slice(0, 8).map((x) => ({ title: x.properties.title, center: x.geometry.coordinates }));
}
