// 해시 라우터 상태 공유 (app.js와 각 뷰가 함께 사용)
export const route = { lastHash: '' };

export function parseHash(hash = location.hash) {
  const full = String(hash || '').replace(/^#\/?/, '');
  // '#/extract?path=a%2Fb.png' 처럼 뒤에 붙은 질의 문자열은 따로 떼어 낸다
  const qi = full.indexOf('?');
  const raw = qi >= 0 ? full.slice(0, qi) : full;
  let query;
  try {
    query = new URLSearchParams(qi >= 0 ? full.slice(qi + 1) : '');
  } catch {
    query = new URLSearchParams();
  }
  const parts = raw.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p;
    }
  });
  return { view: parts[0] || 'generate', params: parts.slice(1), query };
}

/** hashchange 없이 주소만 바꾼다 (뷰 내부 상태와 주소를 맞출 때) */
export function replaceHash(hash) {
  try {
    history.replaceState(null, '', hash);
  } catch {
    /* 무시 */
  }
  route.lastHash = hash;
  // 상단 탭 링크도 지금 주소로 맞춘다 (탭으로 돌아왔을 때 예전 주소(예: #/characters/new)로 가지 않도록)
  try {
    const v = parseHash(hash).view;
    const tab = document.querySelector(`.tab[data-view="${v}"]`);
    if (tab) tab.setAttribute('href', hash);
  } catch {
    /* 무시 */
  }
}
