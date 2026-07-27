import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import roomsData from "../data/rooms.json";

import {
  TYPE_STYLE,
  buildPalette,
  roomColor,
  createRoomMaterial,
  createEdges,
} from "./materials.js";
import { createBackdrop, createGround, createReflection } from "./environment.js";
import { createComposer, BLOOM } from "./postfx.js";

// index.html 의 가드에게 "모듈이 실제로 실행됐다" 고 알린다.
window.__appBooted = true;

// ---------------------------------------------------------------- 상수
const SCALE = 0.02; // 1cm -> 0.02 단위 (1m = 2단위)
const WALL_HEIGHT = roomsData.meta.wallHeight ?? 250; // cm
const TOP_Y = WALL_HEIGHT * SCALE; // 방 하나의 높이 (지오메트리 로컬)
const FLOOR_HEIGHT = (roomsData.meta.floorHeight ?? 400) * SCALE;

const FLOORS = roomsData.meta.floors ?? [1];
const BASE_FLOOR = Math.min(...FLOORS);
const PALETTE = buildPalette(roomsData.meta);

/** 층 번호 -> 그 층을 놓을 높이 */
const floorY = (floor) => (floor - BASE_FLOOR) * FLOOR_HEIGHT;
const FOG_COLOR = 0x061020; // 배경막 수평선 톤과 맞춘다

// FogExp2 는 카메라와의 "절대 거리" 로 계산되므로 씬 스케일에 맞춰야 한다.
// 고정값 0.008 은 이 모델(카메라 거리 약 237단위)에서 화면을 새까맣게 만든다.
// 그래서 밀도를 직접 쓰지 않고 "카메라 거리에서 이만큼 남는다" 로부터 역산한다.
const FOG_VISIBILITY_AT_CAMERA = 0.88;

const DIM_OTHERS = 0.28; // 방을 선택했을 때 나머지를 누르는 정도
const REVEAL_SECONDS = 0.8;

// ---------------------------------------------------------------- 기본 씬
const canvas = document.getElementById("scene");

// WebGL 이 없거나 하드웨어 가속이 꺼져 있으면 여기서 예외가 난다.
// 그냥 두면 검은 화면만 남아 원인을 알 수 없으므로 화면에 이유를 띄운다.
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
} catch (err) {
  window.showFallback(
    "3D를 표시할 수 없습니다.",
    "브라우저에서 WebGL을 사용할 수 없습니다. Chrome 설정 → 시스템 → " +
      "&ldquo;하드웨어 가속 사용&rdquo;을 켜고 브라우저를 다시 시작해 주세요.",
    String(err)
  );
  throw err;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// 톤매핑이 있어야 겹친 면들이 만든 1.0 초과 값이 흰색으로 딱 잘리지 않고
// 부드럽게 눌린다. 끄면 방이 겹쳐 보이는 곳마다 눈이 아플 만큼 타버린다.
// ACES 는 네온을 심하게 탈색시켜서, 하이라이트만 말아주고 채도는 덜 건드리는
// Cineon 을 쓰고 노출로 밝기를 되돌린다.
renderer.toneMapping = THREE.CineonToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, 0); // 밀도는 모델 크기를 안 뒤 정한다

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  4000
);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enableZoom = true; // 휠 줌
controls.enablePan = true; // 우클릭 팬
controls.screenSpacePanning = true;
// 테스트 단계라 각도 제한 없이 자유 회전 (바닥 아래까지)
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI;

// ---------------------------------------------------------------- 방 생성
const roomGroup = new THREE.Group();
scene.add(roomGroup);

/** 오목 다각형까지 그대로 살리기 위해 Shape + ExtrudeGeometry 를 쓴다.
 *  BoxGeometry / bounding box 를 쓰면 L자·U자 복도가 다른 방을 뚫는다. */
function buildGeometry(polygon) {
  // rooms.json 의 polygon 은 [x, z] (cm). Shape 는 XY 평면이다.
  // rotateX(-90°) 는 (x, y, z) -> (x, z, -y) 이므로 shape 의 y 가 world 의 -z 로
  // 간다. world.z 를 json z 와 같게 두려면(= 좌우반전 없음) 여기서 미리
  // -z 를 넣어 상쇄한다. 부호를 한 번만 뒤집으면 도면과 좌우가 뒤바뀐다.
  const pts = polygon.map(([x, z]) => new THREE.Vector2(x, -z));
  // -z 로 뒤집으면 폴리곤 감김 방향도 뒤집힌다. 감김이 제각각이면 압출한
  // 옆면의 법선이 안쪽을 향하는 방이 생겨 FrontSide 로 그릴 때 사라진다.
  // 항상 반시계로 맞춰 법선이 바깥을 보게 한다.
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const shape = new THREE.Shape(pts);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: WALL_HEIGHT,
    bevelEnabled: false,
  });

  // 눕혀서 XZ 평면에 세운다. 압출 방향(+z)이 +y(높이)가 된다.
  // 위의 -z 와 합쳐져 최종 매핑은 world = (json x, 높이, json z).
  geometry.rotateX(-Math.PI / 2);
  geometry.scale(SCALE, SCALE, SCALE);
  geometry.computeVertexNormals(); // 프레넬에 법선이 필요하다

  return geometry;
}

const roomMeshes = [];
const lineMaterials = []; // resize 때 resolution 을 갱신해야 한다
const floorGroups = new Map(); // 층 -> THREE.Group

for (const floor of FLOORS) {
  const g = new THREE.Group();
  g.position.y = floorY(floor);
  roomGroup.add(g);
  floorGroups.set(floor, g);
}

for (const room of roomsData.rooms) {
  const style = TYPE_STYLE[room.type] ?? TYPE_STYLE.normal;
  const color = roomColor(room, PALETTE);
  const geometry = buildGeometry(room.polygon);

  const material = createRoomMaterial(color, style.opacity);
  material.uniforms.uHeight.value = TOP_Y;

  const mesh = new THREE.Mesh(geometry, material);

  const edges = createEdges(geometry, color, style);
  mesh.add(edges);
  lineMaterials.push(edges.material);

  mesh.userData = {
    room,
    edges,
    baseColor: color,
    baseLineOpacity: style.lineOpacity,
    baseLineWidth: style.lineWidth,
  };

  (floorGroups.get(room.floor) ?? roomGroup).add(mesh);
  roomMeshes.push(mesh);
}

// ---------------------------------------------------------------- 필터
// 층 / 동 / 종류 세 가지가 겹쳐서 걸린다. 한 곳에서만 판정해야 어긋나지 않는다.
let activeFloor = null; // null = 전체
const activeBuildings = new Set(
  (roomsData.meta.buildings ?? []).map((b) => b.name)
);
const activeTypes = new Set(Object.keys(TYPE_STYLE));

const isShown = (room) =>
  (activeFloor === null || room.floor === activeFloor) &&
  activeBuildings.has(room.building) &&
  activeTypes.has(room.type);

/** 레이캐스트 대상. 복도를 빼는 이유는 교실을 가리기 때문이고,
 *  숨긴 방을 빼는 이유는 안 보이는 게 클릭을 가로채면 안 되기 때문이다. */
let pickables = [];

function applyFilters() {
  for (const [f, g] of floorGroups) {
    g.visible = activeFloor === null || f === activeFloor;
  }
  for (const m of roomMeshes) {
    m.visible = isShown(m.userData.room);
  }
  // 반사는 맨 아래층이 보일 때만 의미가 있다
  reflection.visible = activeFloor === null || activeFloor === BASE_FLOOR;
  for (const m of reflection.children) {
    m.visible = isShown(m.userData.room);
  }

  pickables = roomMeshes.filter(
    (m) => m.visible && m.userData.room.type !== "circulation"
  );

  // 숨겨진 방이 선택/호버 상태로 남지 않게 한다
  if (selected && !selected.visible) setSelected(null);
  if (hovered && !hovered.visible) setHovered(null);
}

// ---------------------------------------------------------------- 카메라 배치
const center = new THREE.Vector3();

// 대각선 위 45도에서 내려다본다
const dir = new THREE.Vector3(0.5, Math.SQRT1_2, 0.5).normalize();

/** 실제 방 꼭짓점을 카메라 축에 투영해 딱 맞는 거리를 구한다.
 *  boundingSphere 로 맞추면 이 건물처럼 납작하고 대각선 ㅍ자로 퍼진 모양은
 *  구가 과하게 커져 화면 절반이 빈 공간이 된다. bounding box 꼭짓점도
 *  마찬가지로 모서리가 허공이라 헐거워진다. 그래서 진짜 정점을 쓴다. */
function fitDistance(rooms, target, margin = 1.04) {
  const forward = dir.clone().negate(); // 카메라가 바라보는 방향
  const right = new THREE.Vector3()
    .crossVectors(forward, camera.up)
    .normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();

  const tanY = Math.tan((camera.fov * Math.PI) / 180 / 2);
  const tanX = tanY * camera.aspect;

  let need = 0;
  const v = new THREE.Vector3();

  for (const room of rooms) {
    const base = floorY(room.floor);
    for (const [px, pz] of room.polygon)
      for (const py of [base, base + TOP_Y]) {
        // buildGeometry 와 같은 매핑: world = (json x, 높이, json z)
        v.set(px * SCALE, py, pz * SCALE).sub(target);
        const depth = v.dot(forward);
        // |offset| <= (D + depth) * tan  ->  D >= |offset|/tan - depth
        need = Math.max(
          need,
          Math.abs(v.dot(up)) / tanY - depth,
          Math.abs(v.dot(right)) / tanX - depth
        );
      }
  }
  return need * margin;
}

/** 주어진 방들의 중심 (층 높이 포함) */
function centerOf(rooms) {
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (const room of rooms) {
    const base = floorY(room.floor);
    for (const [px, pz] of room.polygon)
      for (const py of [base, base + TOP_Y])
        box.expandByPoint(v.set(px * SCALE, py, pz * SCALE));
  }
  return box.getCenter(new THREE.Vector3());
}

center.copy(centerOf(roomsData.rooms));
const dist = fitDistance(roomsData.rooms, center);

camera.position.copy(center).addScaledVector(dir, dist);
camera.near = dist / 100;
camera.far = dist * 8;
camera.updateProjectionMatrix();

// 이제 거리를 아니까 안개 밀도를 역산한다: exp(-(d*dist)^2) = 목표 가시성
scene.fog.density = Math.sqrt(-Math.log(FOG_VISIBILITY_AT_CAMERA)) / dist;

controls.target.copy(center);
controls.update();

// ---------------------------------------------------------------- 환경
const bounds = roomsData.meta.bounds;
const spanX = (bounds.x[1] - bounds.x[0]) * SCALE;
const spanZ = (bounds.z[1] - bounds.z[0]) * SCALE;

const backdrop = createBackdrop(dist * 3);
scene.add(backdrop);

const ground = createGround(Math.max(spanX, spanZ) * 3.2);
ground.position.x = center.x;
ground.position.z = center.z;
scene.add(ground);

// 반사는 맨 아래층만. 위층까지 비추면 바닥 아래가 복잡해져 오히려 지저분하다.
const baseFloorMeshes = roomMeshes.filter(
  (m) => m.userData.room.floor === BASE_FLOOR
);
const reflection = createReflection(baseFloorMeshes);
scene.add(reflection);

// ---------------------------------------------------------------- 후처리
const { composer, bloom } = createComposer(renderer, scene, camera);

// ---------------------------------------------------------------- 상호작용
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hovered = null;
let selected = null;

const panel = document.getElementById("panel");
const panelName = document.getElementById("panel-name");
const panelBuilding = document.getElementById("panel-building");
const panelType = document.getElementById("panel-type");

function openPanel(mesh) {
  const { room } = mesh.userData;
  panelName.textContent = room.name;
  panelBuilding.textContent = room.building;
  panelType.textContent = TYPE_LABEL[room.type] ?? room.type;
  panelBuilding.textContent =
    FLOORS.length > 1 ? `${room.building} · ${room.floor}F` : room.building;
  panel.style.setProperty(
    "--accent",
    "#" + (PALETTE[room.building] ?? new THREE.Color(0x22d3ee)).getHexString()
  );
  panel.hidden = false;
}

function closePanel() {
  panel.hidden = true;
}

/** 윤곽선 모양을 상태(선택/호버/그 외)로부터 한 곳에서 계산한다.
 *  매스를 밝히는 대신 선을 강조하는 이유: 밝아지는 선은 한 번에 하나뿐이라
 *  여러 방이 시점에서 겹쳐도 빛이 누적되지 않는다. */
function refreshEdge(m) {
  const d = m.userData;
  const mat = d.edges.material;

  if (m === selected) {
    mat.color.setHex(0xffffff);
    mat.opacity = 1;
    mat.linewidth = d.baseLineWidth * 1.8;
  } else if (m === hovered) {
    mat.color.setHex(0xeaffff);
    mat.opacity = Math.min(1, d.baseLineOpacity * 1.6);
    mat.linewidth = d.baseLineWidth * 1.3;
  } else {
    mat.color.copy(d.baseColor);
    mat.opacity = d.baseLineOpacity * (selected ? DIM_OTHERS : 1);
    mat.linewidth = d.baseLineWidth;
  }
}

/** 선택 상태. 대비는 선택된 방을 밝히기보다 나머지를 눌러서 만든다.
 *  매스를 밝히면 겹쳐 보이는 곳이 다시 타버리기 때문이다. */
function setSelected(mesh) {
  selected = mesh;

  for (const m of roomMeshes) {
    const isSel = m === mesh;
    m.material.uniforms.uSelected.value = isSel ? 1 : 0;
    m.material.uniforms.uDim.value = !mesh || isSel ? 1 : DIM_OTHERS;
    refreshEdge(m);
  }

  if (mesh) openPanel(mesh);
  else closePanel();
}

document.getElementById("panel-close").addEventListener("click", () => setSelected(null));

// ---------------------------------------------------------------- 카메라 이동
// 클릭·검색으로 방을 고르면 그 방으로 부드럽게 날아간다.
// 시점 방향은 유지한다 — 방향까지 바꾸면 어디를 보고 있었는지 잃어버린다.
let flight = null;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(toTarget, toDistance, seconds = 0.7) {
  const dirNow = camera.position.clone().sub(controls.target);
  const d = toDistance ?? dirNow.length();
  flight = {
    fromTarget: controls.target.clone(),
    toTarget: toTarget.clone(),
    fromPos: camera.position.clone(),
    toPos: toTarget.clone().addScaledVector(dirNow.normalize(), d),
    t: 0,
    dur: seconds,
  };
}

function flyToRoom(mesh) {
  const b = new THREE.Box3().setFromObject(mesh);
  const c = b.getCenter(new THREE.Vector3());
  const r = Math.max(b.getBoundingSphere(new THREE.Sphere()).radius, TOP_Y);
  // 방이 화면의 약 1/3 을 채우도록
  flyTo(c, (r / Math.sin((camera.fov * Math.PI) / 180 / 2)) * 3.0);
}

function flyToAll() {
  const shown = roomsData.rooms.filter(isShown);
  if (!shown.length) return;
  center.copy(centerOf(shown));
  flyTo(center, fitDistance(shown, center));
}

// ---------------------------------------------------------------- 층 선택
function setFloor(floor) {
  activeFloor = floor;
  applyFilters();
  for (const b of floorButtons) {
    b.setAttribute("aria-pressed", String(b.dataset.floor === String(floor)));
  }
  flyToAll();
}

const floorsEl = document.getElementById("floors");
const floorButtons = [];

if (FLOORS.length > 1) {
  // 위층이 위에 오도록 내림차순
  for (const label of ["전체", ...[...FLOORS].sort((a, b) => b - a)]) {
    const b = document.createElement("button");
    const isAll = label === "전체";
    b.textContent = isAll ? "전체" : label + "F";
    b.dataset.floor = isAll ? "null" : String(label);
    b.type = "button";
    b.addEventListener("click", () => setFloor(isAll ? null : label));
    floorsEl.appendChild(b);
    floorButtons.push(b);
  }
  floorsEl.hidden = false;
}

// ---------------------------------------------------------------- 범례 겸 필터
const TYPE_LABEL = {
  normal: "교실 · 시설",
  service: "화장실",
  circulation: "복도 · 계단",
};

function buildChips(el, items, active, onToggle) {
  const buttons = [];
  for (const it of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = it.key; // 라벨 문자열에서 되읽지 않는다 (개수가 붙어 있다)
    if (it.color) {
      b.style.setProperty("--swatch", "#" + it.color.getHexString());
      const dot = document.createElement("span");
      dot.className = "dot";
      b.appendChild(dot);
    }
    b.appendChild(document.createTextNode(it.label));
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = it.count;
    b.appendChild(n);
    b.setAttribute("aria-pressed", String(active.has(it.key)));
    b.addEventListener("click", () => {
      if (active.has(it.key)) active.delete(it.key);
      else active.add(it.key);
      // 전부 끄면 빈 화면이 되어 조작이 막힌다. 마지막 하나는 못 끄게 한다.
      if (active.size === 0) active.add(it.key);
      b.setAttribute("aria-pressed", String(active.has(it.key)));
      onToggle();
    });
    el.appendChild(b);
    buttons.push(b);
  }
  return buttons;
}

const countBy = (fn, v) => roomsData.rooms.filter((r) => fn(r) === v).length;

buildChips(
  document.getElementById("legend"),
  (roomsData.meta.buildings ?? []).map((b) => ({
    key: b.name,
    label: b.name,
    color: PALETTE[b.name],
    count: countBy((r) => r.building, b.name),
  })),
  activeBuildings,
  () => {
    applyFilters();
    flyToAll();
  }
);

buildChips(
  document.getElementById("types"),
  Object.keys(TYPE_STYLE)
    .map((t) => ({
      key: t,
      label: TYPE_LABEL[t] ?? t,
      count: countBy((r) => r.type, t),
    }))
    .filter((it) => it.count > 0),
  activeTypes,
  () => {
    applyFilters();
    flyToAll();
  }
);

function setHovered(mesh) {
  if (hovered === mesh) return;

  const prev = hovered;
  hovered = mesh;

  if (prev) {
    prev.material.uniforms.uHover.value = 0;
    refreshEdge(prev);
  }
  if (hovered) {
    hovered.material.uniforms.uHover.value = 1;
    refreshEdge(hovered);
  }

  canvas.style.cursor = hovered ? "pointer" : "default";
}

/** 마우스 아래의 방을 찾는다. circulation 은 pickables 에 없으므로 자동 제외.
 *  recursive=false 라 자식인 윤곽선(LineSegments2)도 잡히지 않는다. */
function pick(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(pickables, false);
  return hits.length ? hits[0].object : null;
}

// 궤도 회전 드래그와 클릭을 구분한다.
// 선택은 pointerup 대신 click 에서 한다. 브라우저가 mousedown/up 을 다 본 뒤에
// 내보내는 이벤트라 pointerdown 을 못 받는 상황에서도 안전하고, 드래그 여부는
// dragged 플래그로 따로 판정하므로 회전 후에 잘못 선택되지 않는다.
let downAt = null;
let dragged = false;

canvas.addEventListener("pointermove", (event) => {
  setHovered(pick(event));
  if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 5) {
    dragged = true;
  }
});

canvas.addEventListener("pointerleave", () => setHovered(null));

canvas.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  downAt = { x: event.clientX, y: event.clientY };
  dragged = false;
});

canvas.addEventListener("click", (event) => {
  const wasDrag = dragged;
  downAt = null;
  dragged = false;
  if (wasDrag) return; // 회전 드래그 끝의 click 은 선택으로 치지 않는다

  setSelected(pick(event)); // 빈 곳이면 null -> 선택 해제 + 패널 닫힘
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

// ---------------------------------------------------------------- 검색
const searchEl = document.getElementById("search");
const resultsEl = document.getElementById("search-results");
const clearEl = document.getElementById("search-clear");
let cursor = -1; // 키보드로 고른 항목

function matchRooms(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return roomMeshes
    .filter((m) => m.userData.room.name.toLowerCase().includes(s))
    .sort((a, b) => {
      const an = a.userData.room.name.toLowerCase();
      const bn = b.userData.room.name.toLowerCase();
      // 앞에서부터 일치하는 것을 먼저
      return (an.startsWith(s) ? 0 : 1) - (bn.startsWith(s) ? 0 : 1) ||
        a.userData.room.floor - b.userData.room.floor ||
        an.localeCompare(bn);
    })
    .slice(0, 40);
}

function chooseRoom(mesh) {
  const room = mesh.userData.room;
  // 필터에 가려 안 보이는 방을 골랐으면 보이도록 필터를 풀어준다.
  // 안 그러면 "검색은 되는데 아무 일도 안 일어나는" 상태가 된다.
  if (!isShown(room)) {
    activeBuildings.add(room.building);
    activeTypes.add(room.type);
    if (activeFloor !== null && activeFloor !== room.floor) setFloorSilently(null);
    applyFilters();
    syncChips();
  }
  setSelected(mesh);
  flyToRoom(mesh);
}

function setFloorSilently(floor) {
  activeFloor = floor;
  for (const b of floorButtons) {
    b.setAttribute("aria-pressed", String(b.dataset.floor === String(floor)));
  }
}

function syncChips() {
  for (const b of document.querySelectorAll("#legend button")) {
    b.setAttribute("aria-pressed", String(activeBuildings.has(b.dataset.key)));
  }
  for (const b of document.querySelectorAll("#types button")) {
    b.setAttribute("aria-pressed", String(activeTypes.has(b.dataset.key)));
  }
}

function renderResults(list) {
  resultsEl.textContent = "";
  cursor = -1;
  if (!list.length) {
    const d = document.createElement("div");
    d.className = "none";
    d.textContent = "일치하는 방이 없습니다";
    resultsEl.appendChild(d);
    resultsEl.hidden = false;
    return;
  }
  list.forEach((mesh) => {
    const room = mesh.userData.room;
    const b = document.createElement("button");
    b.type = "button";
    b.appendChild(document.createTextNode(room.name));
    const w = document.createElement("span");
    w.className = "where";
    w.textContent =
      FLOORS.length > 1 ? `${room.building} · ${room.floor}F` : room.building;
    b.appendChild(w);
    b.addEventListener("click", () => {
      chooseRoom(mesh);
      resultsEl.hidden = true;
    });
    resultsEl.appendChild(b);
  });
  resultsEl.hidden = false;
}

let matches = [];

searchEl.addEventListener("input", () => {
  clearEl.hidden = !searchEl.value;
  matches = matchRooms(searchEl.value);
  if (!searchEl.value.trim()) resultsEl.hidden = true;
  else renderResults(matches);
});

searchEl.addEventListener("keydown", (e) => {
  const items = [...resultsEl.querySelectorAll("button")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    cursor = (cursor + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle("active", i === cursor));
    items[cursor].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") {
    e.preventDefault();
    const pick = cursor >= 0 ? matches[cursor] : matches[0];
    if (pick) {
      chooseRoom(pick);
      resultsEl.hidden = true;
      searchEl.blur();
    }
  } else if (e.key === "Escape") {
    resultsEl.hidden = true;
    searchEl.blur();
  }
});

clearEl.addEventListener("click", () => {
  searchEl.value = "";
  clearEl.hidden = true;
  resultsEl.hidden = true;
  searchEl.focus();
});

document.addEventListener("pointerdown", (e) => {
  if (!e.target.closest("#search-wrap")) resultsEl.hidden = true;
});

// ---------------------------------------------------------------- 리사이즈
window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);

  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  bloom.setSize(w, h);

  // 이걸 빠뜨리면 창 크기를 바꾼 뒤 선 두께가 틀어진다
  for (const m of lineMaterials) m.resolution.set(w, h);
});

// ---------------------------------------------------------------- 루프
// THREE.Clock 은 deprecated 경고를 낸다. 경과 시간만 필요하므로 직접 잰다.
let lastT = performance.now();
let revealT = 0;

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = Math.min((now - lastT) / 1000, 0.1); // 탭 복귀 시 큰 점프 방지
  lastT = now;

  // 인트로: 매스가 아래에서 올라오며 페이드인
  if (revealT < 1) {
    revealT = Math.min(1, revealT + dt / REVEAL_SECONDS);
    const e = 1 - Math.pow(1 - revealT, 3); // easeOutCubic
    roomGroup.position.y = (1 - e) * -TOP_Y * 2.5;
    reflection.position.y = -0.03 - (1 - e) * -TOP_Y * 2.5;
    for (const m of roomMeshes) m.material.uniforms.uReveal.value = e;
    for (const m of reflection.children) m.material.uniforms.uReveal.value = e;
  }

  // 카메라 비행. 사용자가 직접 궤도를 돌리면 즉시 양보한다.
  if (flight) {
    flight.t = Math.min(1, flight.t + dt / flight.dur);
    const e = easeInOut(flight.t);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    if (flight.t >= 1) flight = null;
  }

  controls.update();
  composer.render();
}

// 드래그·휠로 직접 조작하면 진행 중인 비행을 취소한다
for (const ev of ["pointerdown", "wheel"]) {
  canvas.addEventListener(ev, () => (flight = null), { passive: true });
}

applyFilters();
flyToAll();
animate();

// 콘솔에서 만져볼 수 있게 열어둔다. 예) 평면도처럼 위에서 보기:
//   __dbg.topDown()          블룸 조정: __dbg.setBloom(1.0, 0.5, 0.1)
window.__dbg = {
  THREE,
  scene,
  camera,
  controls,
  roomGroup,
  roomMeshes,
  reflection,
  ground,
  backdrop,
  bloom,
  rooms: roomsData.rooms,
  meta: roomsData.meta,
  floorGroups,
  setFloor,
  center,
  dist,
  setBloom(strength, radius, threshold) {
    if (strength !== undefined) bloom.strength = strength;
    if (radius !== undefined) bloom.radius = radius;
    if (threshold !== undefined) bloom.threshold = threshold;
    return { strength: bloom.strength, radius: bloom.radius, threshold: bloom.threshold };
  },
  setFresnel(power) {
    for (const m of roomMeshes) m.material.uniforms.uFresnelPower.value = power;
  },
  // 평면도처럼 위에서 내려다본다.
  // up=(0,0,-1) 이어야 화면 오른쪽이 +x, 화면 아래가 +z 가 되어 도면과 같다.
  // up=(0,0,1) 로 하면 화면 오른쪽이 -x 가 되어 좌우가 뒤집힌다.
  topDown() {
    camera.up.set(0, 0, -1);
    camera.position.set(center.x, center.y + dist, center.z);
    controls.target.copy(center);
    controls.update();
  },
  reset() {
    camera.up.set(0, 1, 0);
    camera.position.copy(center).addScaledVector(dir, dist);
    controls.target.copy(center);
    controls.update();
  },
};

console.log(
  `[배치도] 방 ${roomsData.rooms.length}개 / ${FLOORS.length}개 층 [${FLOORS.join(", ")}] / ` +
    `동 ${(roomsData.meta.buildings ?? []).map((b) => b.name).join(", ")} / ` +
    `클릭 대상 ${pickables.length}개 (복도·계단 제외) / ` +
    `카메라 거리 ${dist.toFixed(1)}, 안개 ${scene.fog.density.toFixed(5)}, ` +
    `블룸 ${BLOOM.strength}/${BLOOM.radius}/${BLOOM.threshold}`
);
