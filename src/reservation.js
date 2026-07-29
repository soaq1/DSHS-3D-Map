// 방 예약 — 화면과 앱스크립트 연결.
// 3D 쪽과 완전히 분리돼 있다. main.js 는 openReservation(room) 만 부른다.

import { RESERVATION_ENDPOINT, PERIODS, BOOK_AHEAD_DAYS } from "./config.js";

const connected = !!RESERVATION_ENDPOINT;

// ---------------------------------------------------------------- 시각 계산
const toMin = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

const pad = (n) => String(n).padStart(2, "0");
const toHHMM = (min) => pad(Math.floor(min / 60)) + ":" + pad(min % 60);

const ymd = (d) =>
  d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

/** 고른 교시들을 하나의 시각 구간으로 묶는다.
 *  교시 사이에 10분씩 비지만 쪼개지 않는다 — 3·4교시를 잡으면 10:20~12:10 한 칸이다.
 *  두 구간으로 저장하면 겹침 판정만 복잡해지고 얻는 게 없다. */
function periodSpan(keys) {
  const picked = PERIODS.filter((p) => keys.includes(p.key));
  if (!picked.length) return null;
  const start = Math.min(...picked.map((p) => toMin(p.start)));
  const end = Math.max(...picked.map((p) => toMin(p.end)));
  return { start: toHHMM(start), end: toHHMM(end) };
}

/** 겹침 판정. 저장된 것도 신청하는 것도 시각이라 규칙은 이것 하나뿐이다. */
const overlaps = (aStart, aEnd, bStart, bEnd) =>
  toMin(aStart) < toMin(bEnd) && toMin(bStart) < toMin(aEnd);

// ---------------------------------------------------------------- 서버 연결
/** 앱스크립트 웹앱은 POST 앞에 preflight(OPTIONS)가 붙으면 실패한다. OPTIONS 를
 *  처리할 방법이 없기 때문이다. Content-Type 을 text/plain 으로 두면 브라우저가
 *  단순 요청으로 보내 preflight 가 생기지 않는다. 본문은 그대로 JSON 문자열이고
 *  앱스크립트에서 JSON.parse(e.postData.contents) 로 읽는다.
 *  application/json 으로 바꾸면 그 순간 조용히 깨진다. */
async function post(payload) {
  const res = await fetch(RESERVATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("서버 응답 " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "알 수 없는 오류");
  return data;
}

async function getDay(date) {
  const res = await fetch(
    RESERVATION_ENDPOINT + "?action=day&date=" + encodeURIComponent(date)
  );
  if (!res.ok) throw new Error("서버 응답 " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "알 수 없는 오류");
  return data.rooms ?? {};
}

async function getSlots(sourceId, date) {
  const url =
    RESERVATION_ENDPOINT +
    "?action=slots&room=" +
    encodeURIComponent(sourceId) +
    "&date=" +
    encodeURIComponent(date);
  const res = await fetch(url);
  if (!res.ok) throw new Error("서버 응답 " + res.status);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "알 수 없는 오류");
  return data.items ?? [];
}

// ---------------------------------------------------------------- 화면 만들기
let dlg = null;
let els = null;
let current = null; // 지금 예약창을 연 방
let taken = []; // 그 날 이미 승인된 예약
let mode = "period"; // period | time
let picked = new Set(); // 고른 교시 key

function build() {
  dlg = document.createElement("dialog");
  dlg.id = "resv";
  dlg.innerHTML = `
    <form method="dialog" id="resv-form">
      <header>
        <div>
          <p id="resv-where"></p>
          <h2 id="resv-room"></h2>
        </div>
        <button id="resv-close" type="button" aria-label="닫기">&times;</button>
      </header>

      <p id="resv-offline" hidden>
        아직 예약 서버에 연결되지 않았습니다.
        <code>src/config.js</code> 의 <code>RESERVATION_ENDPOINT</code> 를 채우면
        신청할 수 있습니다.
      </p>

      <p id="resv-note" hidden></p>

      <label class="resv-row">
        <span>날짜</span>
        <input id="resv-date" type="date" required />
      </label>

      <div class="resv-row">
        <span>방식</span>
        <div class="seg" id="resv-mode">
          <button type="button" data-mode="period" aria-pressed="true">교시별</button>
          <button type="button" data-mode="time" aria-pressed="false">시간별</button>
        </div>
      </div>

      <div id="resv-periods" class="resv-periods"></div>

      <div id="resv-times" class="resv-row" hidden>
        <span>시간</span>
        <div class="resv-times-in">
          <input id="resv-start" type="time" step="600" value="16:30" />
          <em>~</em>
          <input id="resv-end" type="time" step="600" value="17:20" />
        </div>
      </div>

      <p id="resv-span" class="resv-span"></p>

      <label class="resv-row">
        <span>신청자</span>
        <input id="resv-who" type="text" required maxlength="20" placeholder="이름" />
      </label>
      <label class="resv-row">
        <span>소속</span>
        <input id="resv-dept" type="text" maxlength="30" placeholder="학급 · 동아리 · 교과" />
      </label>
      <label class="resv-row">
        <span>연락</span>
        <input id="resv-contact" type="text" maxlength="40" placeholder="확인 받을 수단" />
      </label>
      <label class="resv-row">
        <span>사유</span>
        <input id="resv-why" type="text" maxlength="60" placeholder="예: 학년 스터디" />
      </label>

      <p id="resv-msg" class="resv-msg" hidden></p>

      <footer>
        <span class="resv-note">담당 선생님이 승인해야 확정됩니다</span>
        <button id="resv-submit" type="button">신청하기</button>
      </footer>
    </form>
  `;
  document.body.appendChild(dlg);

  const $ = (id) => dlg.querySelector("#" + id);
  els = {
    where: $("resv-where"),
    room: $("resv-room"),
    offline: $("resv-offline"),
    note: $("resv-note"),
    date: $("resv-date"),
    mode: $("resv-mode"),
    periods: $("resv-periods"),
    times: $("resv-times"),
    start: $("resv-start"),
    end: $("resv-end"),
    span: $("resv-span"),
    who: $("resv-who"),
    dept: $("resv-dept"),
    contact: $("resv-contact"),
    why: $("resv-why"),
    msg: $("resv-msg"),
    submit: $("resv-submit"),
  };

  $("resv-close").addEventListener("click", () => dlg.close());

  els.mode.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    mode = b.dataset.mode;
    for (const x of els.mode.querySelectorAll("button")) {
      x.setAttribute("aria-pressed", String(x.dataset.mode === mode));
    }
    els.periods.hidden = mode !== "period";
    els.times.hidden = mode !== "time";
    refreshSpan();
  });

  els.date.addEventListener("change", loadDay);
  els.start.addEventListener("change", refreshSpan);
  els.end.addEventListener("change", refreshSpan);
  els.submit.addEventListener("click", submit);

  buildPeriodChips();
}

function buildPeriodChips() {
  els.periods.textContent = "";
  for (const p of PERIODS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = p.key;
    b.className = "resv-period" + (p.after ? " after" : "");
    b.innerHTML =
      `<b>${p.label}</b><i>${p.start}~${p.end}</i>` +
      (p.after ? "<u>방과후</u>" : "");
    if (p.bookable === false) {
      b.disabled = true;
      b.title = "예약 단위로 쓰기엔 짧습니다";
    } else {
      b.addEventListener("click", () => {
        if (b.classList.contains("taken")) return;
        pickPeriod(p.key);
      });
    }
    b.setAttribute("aria-pressed", "false");
    els.periods.appendChild(b);
  }
}

// ------------------------------------------------------------- 교시 고르기
/** 범위를 채울 때 지나갈 수 있는 교시인가.
 *
 *  막는 것은 **이미 예약된 교시뿐**이다. 종례처럼 짧아서 단독으로는 못 고르게 해둔
 *  시간도 지나가는 것은 된다 — 6교시와 7교시를 이어 잡으면 그 사이 20분도 당연히
 *  같이 쓰는 것이다. '혼자 고를 수 있나' 와 '지나갈 수 있나' 는 다른 질문이다. */
const passable = (p) =>
  !taken.some((t) => overlaps(p.start, p.end, t.start, t.end));

/** 고른 교시는 반드시 이어져 있어야 한다.
 *
 *  예전에는 아무 교시나 켰다 껐다 할 수 있었는데, 그러면 3교시와 5교시를 고른 순간
 *  구간이 10:20~14:10 이 되어 고르지도 않은 4교시가 딸려 들어갔다. 4교시가 이미
 *  예약돼 있으면 "고르지도 않은 시간이 예약됐다" 는 말이 화면에 뜬다. 무슨 일이
 *  벌어졌는지 알 길이 없다.
 *
 *  그래서 사이를 실제로 채워서 보여준다. 1교시를 켠 채 3교시를 누르면 2교시도 같이
 *  켜진다 — 어차피 그 시간을 잡는 것이니 눈에 보이는 게 맞다. 사이에 예약된 교시가
 *  있어 채울 수 없으면 누른 교시 하나로 새로 시작한다. */
function pickPeriod(key) {
  const i = PERIODS.findIndex((p) => p.key === key);
  if (i < 0) return;

  if (picked.has(key)) {
    // 가운데를 끄면 남은 것이 끊긴다. 뒤쪽을 같이 걷어 이어진 상태를 지킨다.
    for (const p of PERIODS.slice(i)) picked.delete(p.key);
  } else {
    const idx = [...picked].map((k) => PERIODS.findIndex((p) => p.key === k));
    const run = PERIODS.slice(Math.min(i, ...idx), Math.max(i, ...idx) + 1);
    picked.clear();
    if (run.every(passable)) for (const p of run) picked.add(p.key);
    else picked.add(key);
  }

  for (const b of els.periods.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(picked.has(b.dataset.key)));
  }
  refreshSpan();
}

// ---------------------------------------------------------------- 상태 갱신
/** 지금 고른 것이 어떤 시각 구간인지 */
function currentSpan() {
  if (mode === "period") return periodSpan([...picked]);
  const s = els.start.value;
  const e = els.end.value;
  if (!s || !e) return null;
  if (toMin(s) >= toMin(e)) return null;
  return { start: s, end: e };
}

function refreshSpan() {
  const span = currentSpan();
  if (!span) {
    els.span.textContent =
      mode === "period" ? "교시를 고르세요" : "끝 시각이 시작보다 늦어야 합니다";
    els.span.classList.remove("ok");
  } else {
    const hit = taken.find((t) => overlaps(span.start, span.end, t.start, t.end));
    if (hit) {
      els.span.textContent = `${span.start} ~ ${span.end} — 이미 예약됨 (${hit.who || "다른 사람"})`;
      els.span.classList.remove("ok");
    } else {
      els.span.textContent = `${span.start} ~ ${span.end}`;
      els.span.classList.add("ok");
    }
  }
  els.submit.disabled = !connected || !span;
}

/** 그 날 이미 승인된 예약을 받아 교시 칩에 표시한다 */
async function loadDay() {
  picked.clear();
  for (const b of els.periods.querySelectorAll("button")) {
    b.setAttribute("aria-pressed", "false");
    b.classList.remove("taken");
  }
  taken = [];
  refreshSpan();

  if (!connected || !current || !els.date.value) return;

  // 앱스크립트 응답은 1~3초 걸린다. 그동안 교시를 못 누르게 막는다.
  // 열어두면 이미 예약된 교시를 고를 수 있고, 그러면 신청 버튼까지 눌렀다가
  // 서버가 거절한 뒤에야 알게 된다.
  els.periods.classList.add("loading");
  els.span.textContent = "예약 현황 불러오는 중…";
  els.span.classList.remove("ok");
  els.submit.disabled = true;

  try {
    taken = await getSlots(current.sourceId, els.date.value);
  } catch (err) {
    say("예약 현황을 불러오지 못했습니다 — " + err.message, true);
    return;
  } finally {
    els.periods.classList.remove("loading");
  }

  for (const p of PERIODS) {
    const b = els.periods.querySelector(`[data-key="${p.key}"]`);
    if (!b || b.disabled) continue;
    if (taken.some((t) => overlaps(p.start, p.end, t.start, t.end))) {
      b.classList.add("taken");
      b.title = "이미 예약된 시간입니다";
    } else {
      b.title = "";
    }
  }
  refreshSpan();
}

function say(text, bad) {
  els.msg.textContent = text;
  els.msg.classList.toggle("bad", !!bad);
  els.msg.hidden = !text;
}

// ---------------------------------------------------------------- 신청
async function submit() {
  const span = currentSpan();
  if (!span) return;
  if (!els.who.value.trim()) {
    say("신청자 이름을 적어주세요", true);
    els.who.focus();
    return;
  }

  els.submit.disabled = true;
  say("보내는 중…");

  try {
    const res = await post({
      action: "request",
      // 방은 UUID 로 가리킨다. 이름·층·동은 사람이 알아보라고 같이 남긴다 —
      // 도면에서 방을 다시 그리면 UUID 가 바뀌기 때문이다.
      sourceId: current.sourceId,
      roomName: current.name,
      floor: current.floor,
      building: current.building,
      date: els.date.value,
      start: span.start,
      end: span.end,
      periods: mode === "period" ? [...picked].join(",") : "",
      who: els.who.value.trim(),
      dept: els.dept.value.trim(),
      contact: els.contact.value.trim(),
      why: els.why.value.trim(),
    });
    say(`신청됐습니다. 예약번호 ${res.id} — 승인되면 알려드립니다`);
    els.submit.disabled = true;
  } catch (err) {
    say("신청하지 못했습니다 — " + err.message, true);
    els.submit.disabled = false;
  }
}

// ------------------------------------------------------------- 예약 현황 보기
// 방을 하나씩 열어야 예약이 보이면 "오늘 어디가 비었나" 를 알 수 없다.
// 그 날 전체를 한 화면에 펼친다. 서버는 이미 action=day 로 다 준다.
let statusDlg = null;
let statusEls = null;

function buildStatus() {
  statusDlg = document.createElement("dialog");
  statusDlg.id = "resv-status";
  statusDlg.innerHTML = `
    <header>
      <div>
        <p class="resv-where">예약 현황</p>
        <h2>승인된 예약</h2>
      </div>
      <button type="button" class="resv-x" aria-label="닫기">&times;</button>
    </header>
    <label class="resv-row">
      <span>날짜</span>
      <input id="resv-status-date" type="date" />
    </label>
    <div id="resv-status-list"></div>
  `;
  document.body.appendChild(statusDlg);
  statusEls = {
    date: statusDlg.querySelector("#resv-status-date"),
    list: statusDlg.querySelector("#resv-status-list"),
  };
  statusDlg.querySelector(".resv-x").addEventListener("click", () =>
    statusDlg.close()
  );
  statusEls.date.addEventListener("change", loadStatus);
}

async function loadStatus() {
  const date = statusEls.date.value;
  statusEls.list.textContent = "";
  if (!connected) {
    statusEls.list.innerHTML =
      '<p class="resv-none">아직 예약 서버에 연결되지 않았습니다.</p>';
    return;
  }
  statusEls.list.innerHTML = '<p class="resv-none">불러오는 중…</p>';

  let rooms;
  try {
    rooms = await getDay(date);
  } catch (err) {
    statusEls.list.innerHTML =
      '<p class="resv-none">불러오지 못했습니다 — ' + err.message + "</p>";
    return;
  }

  // 방 하나가 여러 건일 수 있으므로 펼쳐서 시간순으로 늘어놓는다
  const items = [];
  for (const [sourceId, list] of Object.entries(rooms)) {
    for (const it of list) items.push({ sourceId, ...it });
  }
  items.sort((a, b) => a.start.localeCompare(b.start));

  if (!items.length) {
    statusEls.list.innerHTML =
      '<p class="resv-none">이 날은 승인된 예약이 없습니다.</p>';
    return;
  }

  statusEls.list.textContent = "";
  for (const it of items) {
    // 방 이름은 서버가 보내준 것을 먼저 쓴다. 도면에서 방을 다시 그려
    // sourceId 가 바뀌어도 사람이 어느 방인지는 알아볼 수 있어야 한다.
    const name = it.room || roomNameOf(it.sourceId) || "(알 수 없는 방)";
    const row = document.createElement("div");
    row.className = "resv-status-row";
    row.innerHTML =
      `<b>${it.start} ~ ${it.end}</b><em>${name}</em>` +
      `<i>${[it.who, it.why].filter(Boolean).join(" · ")}</i>`;
    statusEls.list.appendChild(row);
  }
}

/** main.js 가 방 목록을 넘겨준다. 여기서 rooms.json 을 다시 읽지 않는다. */
let roomIndex = new Map();
const roomNameOf = (sourceId) => roomIndex.get(sourceId);

export function setRooms(rooms) {
  for (const r of rooms) if (r.sourceId) roomIndex.set(r.sourceId, r.name);
}

export function openStatus() {
  if (!statusDlg) buildStatus();
  if (!statusEls.date.value) {
    const t = new Date();
    statusEls.date.value = ymd(t);
  }
  loadStatus();
  statusDlg.showModal();
}

// ---------------------------------------------------------------- 밖에서 쓰는 것
/** 이 방을 예약할 수 있나. main.js 가 버튼을 붙일지 정할 때 쓴다. */
export const isReservable = (room) => room.reservable === true;

export function openReservation(room) {
  if (!dlg) build();
  current = room;

  els.where.textContent = `${room.building} · ${room.floor}F`;
  els.room.textContent = room.name;
  els.offline.hidden = connected;
  // 방마다 붙는 이용 규칙 (plan.config.json 의 reservable 안 note).
  // 신청 전에 보여줘야 의미가 있으므로 맨 위에 둔다.
  els.note.textContent = room.note || "";
  els.note.hidden = !room.note;

  const today = new Date();
  const max = new Date(today);
  max.setDate(max.getDate() + BOOK_AHEAD_DAYS);
  els.date.min = ymd(today);
  els.date.max = ymd(max);
  if (!els.date.value || els.date.value < ymd(today)) els.date.value = ymd(today);

  say("");
  els.submit.disabled = !connected;
  loadDay();

  dlg.showModal();
}
