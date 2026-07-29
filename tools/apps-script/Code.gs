/**
 * 서부고 배치도 — 방 예약 접수/조회
 *
 * 구글 스프레드시트에 붙여 쓰는 앱스크립트다. 설치 방법은 옆의 README.md 참고.
 * 설계 배경은 docs/예약-시스템-명세.md.
 *
 * 이 스크립트가 하는 일은 두 가지뿐이다.
 *   - 신청을 시트에 한 줄 추가하고 담당 선생님께 메일을 보낸다
 *   - 승인된 예약을 읽어서 프론트에 알려준다
 * 승인/반려는 스크립트가 아니라 사람이 시트에서 직접 한다. 그게 이 방식의 요점이다.
 */

// ────────────────────────────────────────────────────────────── 설정
/** 신청이 들어오면 알림을 받을 주소. 비우면 메일을 안 보낸다.
 *  ★ 이게 비어 있으면 선생님은 신청이 들어온 걸 모른다. 꼭 채울 것. */
var NOTIFY_EMAIL = "";

/** 예약 장부 시트 이름 */
var SHEET_NAME = "예약";

/** 조회 응답을 몇 초 묶어둘지. 앱스크립트는 호출 한도가 있고 지도 화면은
 *  방을 옮길 때마다 물어본다. */
var CACHE_SEC = 60;

var HEADERS = [
  "신청시각", "예약번호", "sourceId", "방이름", "층", "동",
  "날짜", "시작", "끝", "교시",
  "신청자", "소속", "연락", "사유", "상태", "처리메모",
];

var STATUS = { WAIT: "대기", OK: "승인", NO: "반려", CANCEL: "취소" };

// ────────────────────────────────────────────────────────────── 시트
function sheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 상태 열에 드롭다운을 걸어 손으로 고칠 때 오타가 안 나게 한다.
 *  프론트가 모르는 값이 들어가면 그 예약은 화면에서 조용히 사라진다. */
function 시트준비() {
  var sh = sheet_();
  var col = HEADERS.indexOf("상태") + 1;
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList([STATUS.WAIT, STATUS.OK, STATUS.NO, STATUS.CANCEL], true)
    .setAllowInvalid(false)
    .build();
  sh.getRange(2, col, Math.max(sh.getMaxRows() - 1, 1)).setDataValidation(rule);
  sh.autoResizeColumns(1, HEADERS.length);
  SpreadsheetApp.getUi().alert("준비 끝. 상태 칸에서 대기/승인/반려/취소를 고를 수 있습니다.");
}

function rows_() {
  var sh = sheet_();
  if (sh.getLastRow() < 2) return [];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).getValues();
  return values.map(function (r) {
    var o = {};
    HEADERS.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

// ────────────────────────────────────────────────────────────── 도우미
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** 시트에서 읽은 값이 Date 로 올 때가 있어 문자열로 맞춘다 */
function hhmm_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "HH:mm");
  }
  return String(v || "").trim();
}

function ymd_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(v || "").trim();
}

function toMin_(hhmm) {
  var p = String(hhmm).split(":");
  return Number(p[0]) * 60 + Number(p[1]);
}

/** 겹침 판정. 교시로 신청했든 시간으로 신청했든 저장된 건 언제나 시각이라
 *  규칙은 이것 하나뿐이다. */
function overlap_(aS, aE, bS, bE) {
  return toMin_(aS) < toMin_(bE) && toMin_(bS) < toMin_(aE);
}

// ────────────────────────────────────────────────────────────── 조회
function doGet(e) {
  try {
    var action = (e.parameter.action || "").trim();
    if (action === "slots") return json_(slots_(e.parameter.room, e.parameter.date));
    if (action === "day") return json_(day_(e.parameter.date));
    return json_({ ok: false, error: "알 수 없는 action: " + action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/** 그 방 그 날의 승인된 예약 */
function slots_(room, date) {
  if (!room || !date) return { ok: false, error: "room 과 date 가 필요합니다" };

  var key = "slots:" + room + ":" + date;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var items = rows_()
    .filter(function (r) {
      return String(r["sourceId"]) === room &&
        ymd_(r["날짜"]) === date &&
        String(r["상태"]).trim() === STATUS.OK;
    })
    .map(function (r) {
      return {
        start: hhmm_(r["시작"]),
        end: hhmm_(r["끝"]),
        periods: String(r["교시"] || ""),
        who: String(r["신청자"] || ""),
        why: String(r["사유"] || ""),
      };
    });

  var out = { ok: true, items: items };
  cache.put(key, JSON.stringify(out), CACHE_SEC);
  return out;
}

/** 그 날 전체 방의 승인 현황 (지도에 칠하기용) */
function day_(date) {
  if (!date) return { ok: false, error: "date 가 필요합니다" };

  var key = "day:" + date;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  var byRoom = {};
  rows_().forEach(function (r) {
    if (ymd_(r["날짜"]) !== date) return;
    if (String(r["상태"]).trim() !== STATUS.OK) return;
    var id = String(r["sourceId"]);
    if (!byRoom[id]) byRoom[id] = [];
    byRoom[id].push({
      start: hhmm_(r["시작"]),
      end: hhmm_(r["끝"]),
      // 현황 화면이 누가 왜 쓰는지까지 보여줘야 해서 같이 실어 보낸다
      who: String(r["신청자"] || ""),
      why: String(r["사유"] || ""),
      room: String(r["방이름"] || ""),
    });
  });

  var out = { ok: true, rooms: byRoom };
  cache.put(key, JSON.stringify(out), CACHE_SEC);
  return out;
}

// ────────────────────────────────────────────────────────────── 접수
/**
 * ★ 프론트는 Content-Type 을 text/plain 으로 보낸다.
 *   application/json 으로 보내면 브라우저가 preflight(OPTIONS)를 먼저 던지는데
 *   앱스크립트 웹앱은 OPTIONS 를 처리할 방법이 없어 요청이 통째로 실패한다.
 *   text/plain 은 단순 요청이라 preflight 가 없다. 본문은 그냥 JSON 문자열이다.
 */
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === "request") return json_(request_(body));
    if (body.action === "cancel") return json_(cancel_(body));
    return json_({ ok: false, error: "알 수 없는 action: " + body.action });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function request_(b) {
  if (!b.sourceId || !b.date || !b.who) {
    return { ok: false, error: "sourceId · date · who 가 필요합니다" };
  }

  // 띄엄띄엄 고른 교시는 덩어리마다 예약이 따로 만들어진다. 한 줄에 여러 구간을
  // 담으면 겹침 판정이 구간마다 갈라져 복잡해지기 때문이다.
  // 예전 클라이언트가 보내던 start/end 한 쌍도 그대로 받는다.
  var ranges = b.ranges;
  if (!ranges || !ranges.length) {
    if (!b.start || !b.end) return { ok: false, error: "시간이 없습니다" };
    ranges = [{ start: b.start, end: b.end, periods: b.periods || "" }];
  }

  for (var i = 0; i < ranges.length; i++) {
    if (toMin_(ranges[i].start) >= toMin_(ranges[i].end)) {
      return { ok: false, error: "끝 시각이 시작보다 늦어야 합니다" };
    }
  }

  // 신청이 몰려도 줄 세워 처리한다. 선생님이 시트를 열어둔 동안에도 들어온다.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // 이미 승인된 것과 겹치면 접수하지 않는다. 대기 중인 것과는 겹쳐도 받는다 —
    // 막으면 아무나 대기를 걸어 방을 잠글 수 있다.
    var sameDay = rows_().filter(function (r) {
      return String(r["sourceId"]) === b.sourceId &&
        ymd_(r["날짜"]) === b.date &&
        String(r["상태"]).trim() === STATUS.OK;
    });
    for (var j = 0; j < ranges.length; j++) {
      var rg = ranges[j];
      var hit = sameDay.some(function (r) {
        return overlap_(rg.start, rg.end, hhmm_(r["시작"]), hhmm_(r["끝"]));
      });
      if (hit) {
        return { ok: false, error: rg.start + "~" + rg.end + " 은 이미 예약돼 있습니다" };
      }
    }

    // 한 번의 신청이므로 예약번호는 하나로 묶는다. 취소도 한꺼번에 된다.
    var sh = sheet_();
    var id = newId_(sh);
    var rows = ranges.map(function (rg) {
      return [
        new Date(), id, b.sourceId, b.roomName || "", b.floor || "", b.building || "",
        b.date, rg.start, rg.end, rg.periods || "",
        b.who, b.dept || "", b.contact || "", b.why || "", STATUS.WAIT, "",
      ];
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);

    CacheService.getScriptCache().removeAll([
      "slots:" + b.sourceId + ":" + b.date, "day:" + b.date,
    ]);

    notify_(b, id, ranges);
    return { ok: true, id: id, count: ranges.length };
  } finally {
    lock.releaseLock();
  }
}

/** R-2607-0001 꼴. 행을 지우지 않는다는 전제라 마지막 행 번호로 충분하다. */
function newId_(sh) {
  var stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyMM");
  var n = Math.max(sh.getLastRow(), 1);
  return "R-" + stamp + "-" + ("0000" + n).slice(-4);
}

/** 대기 중인 자기 신청만 취소할 수 있다. 승인된 것은 선생님이 시트에서 바꾼다. */
function cancel_(b) {
  if (!b.id || !b.who) return { ok: false, error: "예약번호와 신청자가 필요합니다" };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_();
    var all = rows_();
    var n = 0;
    // 한 번의 신청이 여러 줄일 수 있다(띄엄띄엄 고른 경우). 같은 예약번호를
    // 전부 취소한다.
    for (var i = 0; i < all.length; i++) {
      var r = all[i];
      if (String(r["예약번호"]) !== b.id) continue;
      if (String(r["신청자"]).trim() !== String(b.who).trim()) {
        return { ok: false, error: "신청자 이름이 다릅니다" };
      }
      if (String(r["상태"]).trim() !== STATUS.WAIT) continue;
      // 행은 절대 지우지 않는다. 기록이 사라지고 예약번호가 겹친다.
      sh.getRange(i + 2, HEADERS.indexOf("상태") + 1).setValue(STATUS.CANCEL);
      CacheService.getScriptCache().removeAll([
        "slots:" + r["sourceId"] + ":" + ymd_(r["날짜"]), "day:" + ymd_(r["날짜"]),
      ]);
      n++;
    }
    if (!n) return { ok: false, error: "취소할 수 있는 예약이 없습니다" };
    return { ok: true, count: n };
  } finally {
    lock.releaseLock();
  }
}

// ────────────────────────────────────────────────────────────── 알림
/** 이게 없으면 시스템이 안 돈다. 승인이 있어야 확정인데 선생님은 시트를 늘
 *  들여다보지 않는다. */
function notify_(b, id, ranges) {
  if (!NOTIFY_EMAIL) return;
  try {
    MailApp.sendEmail({
      to: NOTIFY_EMAIL,
      subject: "[방 예약] " + (b.roomName || b.sourceId) + " " + b.date + " 신청",
      body: [
        "새 예약 신청이 들어왔습니다.",
        "",
        "방      : " + (b.roomName || "") + " (" + (b.building || "") + " " + (b.floor || "") + "층)",
        "날짜    : " + b.date,
        "시간    : " + (ranges || [{ start: b.start, end: b.end }])
          .map(function (r) { return r.start + " ~ " + r.end; }).join(", "),
        "신청자  : " + b.who + " / " + (b.dept || "-") + " / " + (b.contact || "-"),
        "사유    : " + (b.why || "-"),
        "예약번호: " + id,
        "",
        "시트에서 상태를 '승인' 으로 바꾸면 확정됩니다.",
        SpreadsheetApp.getActiveSpreadsheet().getUrl(),
      ].join("\n"),
    });
  } catch (err) {
    // 메일이 실패해도 접수는 살린다. 신청이 사라지는 게 더 나쁘다.
    console.error("알림 메일 실패: " + err);
  }
}

/**
 * 상태를 바꾸면 신청자에게 알려준다. 승인만이 아니라 **되돌리는 경우가 더 중요하다** —
 * "승인됐다" 고 알고 있는 사람에게 취소·반려를 안 알리면 그 시간에 그냥 온다.
 *
 * 연락처가 이메일일 때만 보낸다. 전화번호로 문자를 보내려면 외부 유료 API 와
 * 발신번호 사전등록(법적 의무)이 필요해서 학교 차원의 승인 없이는 못 붙인다.
 *
 * ★ 설치: 편집기 왼쪽 '트리거' → 트리거 추가 → 함수 onStatusEdit,
 *   이벤트 소스 '스프레드시트에서', 이벤트 유형 '수정 시'.
 *   (onEdit 라는 이름의 단순 트리거는 메일을 못 보낸다. 반드시 설치형으로 건다)
 */
function onStatusEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (sh.getName() !== SHEET_NAME) return;

  var col = HEADERS.indexOf("상태") + 1;
  if (e.range.getColumn() !== col || e.range.getRow() < 2) return;

  var status = String(e.range.getValue()).trim();
  if (status === STATUS.WAIT) return; // 대기로 되돌린 건 알릴 것이 없다

  var row = sh.getRange(e.range.getRow(), 1, 1, HEADERS.length).getValues()[0];
  var r = {};
  HEADERS.forEach(function (h, i) { r[h] = row[i]; });

  // 그 방·그 날 조회를 다시 하도록 캐시를 버린다. 안 그러면 최대 60초 동안
  // 화면에는 예전 상태가 남는다.
  CacheService.getScriptCache().removeAll([
    "slots:" + r["sourceId"] + ":" + ymd_(r["날짜"]), "day:" + ymd_(r["날짜"]),
  ]);

  var to = String(r["연락"] || "").trim();
  if (to.indexOf("@") < 0) return; // 이메일이 아니면 보낼 방법이 없다

  var head = { 승인: "예약이 확정됐습니다", 반려: "예약이 반려됐습니다",
               취소: "예약이 취소됐습니다" }[status] || "예약 상태가 바뀌었습니다";
  try {
    MailApp.sendEmail({
      to: to,
      subject: "[방 예약] " + head + " — " + r["방이름"] + " " + ymd_(r["날짜"]),
      body: [
        head + ".",
        "",
        "방      : " + r["방이름"],
        "날짜    : " + ymd_(r["날짜"]),
        "시간    : " + hhmm_(r["시작"]) + " ~ " + hhmm_(r["끝"]),
        "예약번호: " + r["예약번호"],
        r["처리메모"] ? "\n메모: " + r["처리메모"] : "",
      ].join("\n"),
    });
  } catch (err) {
    console.error("상태 변경 알림 실패: " + err);
  }
}

/** 하루 한 번 대기 건수를 알려주는 용도. 시간 기반 트리거로 걸어둔다. */
function 대기알림() {
  if (!NOTIFY_EMAIL) return;
  var wait = rows_().filter(function (r) {
    return String(r["상태"]).trim() === STATUS.WAIT;
  });
  if (!wait.length) return;
  MailApp.sendEmail(
    NOTIFY_EMAIL,
    "[방 예약] 승인 대기 " + wait.length + "건",
    "승인을 기다리는 신청이 " + wait.length + "건 있습니다.\n" +
      SpreadsheetApp.getActiveSpreadsheet().getUrl()
  );
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("방 예약")
    .addItem("시트 준비 (상태 드롭다운)", "시트준비")
    .addItem("대기 건수 메일 보내기", "대기알림")
    .addToUi();
}
