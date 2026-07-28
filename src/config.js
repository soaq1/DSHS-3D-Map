// 예약 시스템 설정. 도면과 무관한 값이라 파서(plan.config.json)가 아니라 여기 둔다.
// 자세한 배경은 docs/예약-시스템-명세.md 참고.

/** 구글 앱스크립트 웹앱 주소.
 *
 *  비워두면 예약 화면은 열리되 "아직 연결되지 않았습니다" 를 띄우고 신청 버튼이
 *  잠긴다. 거짓으로 접수된 것처럼 보이는 것보다 낫다.
 *
 *  채우는 법은 tools/apps-script/README.md 에 있다. 배포하면
 *  https://script.google.com/macros/s/AKfy…/exec 꼴의 주소가 나온다. */
export const RESERVATION_ENDPOINT = "https://script.google.com/macros/s/AKfycbw07KQWyFRGsKrnLES4HBFecxLpi04DewOvAwqHujT_XnydEzoIfjPAHNpXxHvo313AMA/exec";

/** 교시 시간표.
 *
 *  ★ 저장은 언제나 절대 시각으로 한다. 교시는 화면에 예쁘게 보여주는 라벨일 뿐
 *    겹침 판정에는 쓰지 않는다. 교시로 저장하면 "5교시" 예약과 "14:00~15:00"
 *    예약이 겹치는지 알 수 없다.
 *
 *  bookable: false 는 목록에는 두되 고를 수 없게 한다. */
export const PERIODS = [
  { key: "1", label: "1교시", start: "08:20", end: "09:10" },
  { key: "2", label: "2교시", start: "09:20", end: "10:10" },
  { key: "3", label: "3교시", start: "10:20", end: "11:10" },
  { key: "4", label: "4교시", start: "11:20", end: "12:10" },
  { key: "lunch", label: "점심", start: "12:10", end: "13:20" },
  { key: "5", label: "5교시", start: "13:20", end: "14:10" },
  { key: "6", label: "6교시", start: "14:20", end: "15:10" },
  // 20분뿐이라 예약 단위로 쓰기엔 짧다
  { key: "hr", label: "종례", start: "15:10", end: "15:30", bookable: false },
  { key: "7", label: "7교시", start: "15:30", end: "16:20" },
  // 일반 학급 시간표에는 없다. 방과후로 표시만 다르게 한다
  { key: "8", label: "8교시", start: "16:30", end: "17:20", after: true },
  { key: "9", label: "9교시", start: "17:30", end: "18:20", after: true },
];

/** 오늘부터 며칠 뒤까지 신청할 수 있나 */
export const BOOK_AHEAD_DAYS = 21;
