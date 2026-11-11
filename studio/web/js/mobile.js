// 휴대폰 화면 판별 — mobile.css 의 휴대폰 구간(760px 이하)과 같은 기준을 JS에서도 쓴다.
// (레이아웃은 CSS가 맡고, JS는 동작이 달라야 하는 곳만: 하단 탭 바·캐릭터 목록→편집 2단계·라이트박스 시트 등)

const PHONE = '(max-width: 760px)';
const TOUCH = '(hover: none) and (pointer: coarse)';

let phoneMq = null;
let touchMq = null;
try {
  phoneMq = window.matchMedia(PHONE);
  touchMq = window.matchMedia(TOUCH);
} catch { /* 아주 오래된 브라우저 */ }

/** 휴대폰 레이아웃(세로 360~430px, 가로 760px 이하)인지 */
export function isPhone() {
  return !!(phoneMq && phoneMq.matches);
}

/** 손가락으로 조작하는 기기(마우스 호버 없음)인지 — 휴대폰·태블릿 */
export function isTouch() {
  return !!(touchMq && touchMq.matches);
}

/** 휴대폰 ↔ 넓은 화면 전환(창 크기·회전)을 알린다 */
export function onPhoneChange(fn) {
  if (!phoneMq) return;
  const cb = () => {
    try {
      fn(phoneMq.matches);
    } catch (e) {
      console.error(e);
    }
  };
  if (phoneMq.addEventListener) phoneMq.addEventListener('change', cb);
  else if (phoneMq.addListener) phoneMq.addListener(cb);
}
