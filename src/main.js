import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import roomsData from "../data/rooms.json";

import {
  TYPE_STYLE,
  buildPalette,
  buildTypeColors,
  roomColor,
  createRoomMaterial,
  createEdges,
} from "./materials.js";
import { createBackdrop, createGround, createReflection } from "./environment.js";
import { createComposer, BLOOM, QUALITY } from "./postfx.js";
import {
  isReservable,
  openReservation,
  openStatus,
  setRooms,
} from "./reservation.js";

// index.html 의 가드에게 "모듈이 실제로 실행됐다" 고 알린다.
window.__appBooted = true;

// ---------------------------------------------------------------- 상수
const SCALE = 0.02; // 1cm -> 0.02 단위 (1m = 2단위)
const WALL_HEIGHT = roomsData.meta.wallHeight ?? 250; // cm
const TOP_Y = WALL_HEIGHT * SCALE; // 방 하나의 높이 (지오메트리 로컬)
const FLOOR_HEIGHT_CM = roomsData.meta.floorHeight ?? 400;
const FLOOR_HEIGHT = FLOOR_HEIGHT_CM * SCALE;

const FLOORS = roomsData.meta.floors ?? [1];
const BASE_FLOOR = Math.min(...FLOORS);
const PALETTE = buildPalette(roomsData.meta);
// 홀처럼 동 색을 덮어쓰는 종류. 없으면 빈 객체라 동 색이 그대로 쓰인다.
const TYPE_COLORS = buildTypeColors(roomsData.meta);
// 종류별 압출 높이(cm). 홀은 30cm 로 눕힌다. 없는 종류는 벽 높이를 쓴다.
const TYPE_HEIGHTS = roomsData.meta.typeHeights ?? {};

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
/** 약한 기기인가. 폰이거나 코어가 적으면 낮춘다.
 *  이 그림은 삼각형이 6천 개뿐이라 형상은 안 무겁고, 비용은 전부 '반투명한 면을
 *  몇 번 겹쳐 칠하느냐'(오버드로)와 블룸에서 나온다. 둘 다 화면 픽셀 수에
 *  정비례하므로 해상도를 낮추는 게 가장 확실한 처방이다. */
const LOW_END =
  window.matchMedia("(max-width: 720px), (pointer: coarse)").matches ||
  (navigator.hardwareConcurrency || 8) <= 4;

renderer.setPixelRatio(Math.min(window.devicePixelRatio, LOW_END ? 1.25 : 2));
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
// 위로는 바로 위(평면도)까지, 아래로는 수평선까지. 바닥 밑으로 내려가면 방이
// FrontSide 라 거의 안 보여서 화면이 망가진 것처럼 느껴진다.
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI / 2 - 0.02;

// 바뀐 게 없으면 그리지 않는다.
//
// 예전에는 아무 일이 없어도 초당 180번씩 다시 그렸다. 이 그림은 반투명한 면
// 445개를 겹쳐 칠하고 블룸까지 돌리므로 한 장이 싸지 않은데, 가만히 보고만 있어도
// 그 값을 계속 치르고 있었다. 폰에서는 그게 곧 발열과 배터리이고, 발열이 오면
// 기기가 스스로 속도를 낮춰(스로틀링) 정작 움직일 때 더 끊긴다.
//
// 지금은 카메라·애니메이션·필터·선택이 바뀔 때만 그린다. 가만히 두면 0장이다.
let renderPending = true;
const requestRender = () => {
  renderPending = true;
};

// 사용자가 궤도를 돌리거나 줌하면 컨트롤이 알려준다
controls.addEventListener("change", requestRender);


// ---------------------------------------------------------------- 방 생성
const roomGroup = new THREE.Group();
scene.add(roomGroup);

/** 오목 다각형까지 그대로 살리기 위해 Shape + ExtrudeGeometry 를 쓴다.
 *  BoxGeometry / bounding box 를 쓰면 L자·U자 복도가 다른 방을 뚫는다. */
function buildGeometry(polygon, height = WALL_HEIGHT) {
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
    depth: height,
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

// ---------------------------------------------------------------- 수직 기둥
// 계단실·엘리베이터(rooms.json 의 shaft)는 층마다 뜬 상자가 아니라 1층부터
// 꼭대기까지 이어진 육면체 하나로 보여야 한다. 층 격리를 유지해야 하므로
// 층별 메시는 그대로 두고, 이어 붙여서 하나처럼 보이게 만든다.
//   1) 맨 위층을 뺀 나머지는 벽 높이(250) 가 아니라 층고(400) 로 압출해
//      위층 바닥에 닿게 한다 — 이게 없으면 층마다 150cm 씩 떠 있다
//   2) 이음매의 가로 테두리를 지운다 (createEdges 의 rings)
//   3) 밝기 그라데이션을 기둥 전체 기준으로 계산한다 (uHOffset)
const SHAFT_MERGE_TOLERANCE = 500; // cm. 같은 기둥으로 볼 중심 간 거리

const center2d = (polygon) => {
  const xs = polygon.map((p) => p[0]);
  const zs = polygon.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2,
          (Math.min(...zs) + Math.max(...zs)) / 2];
};

/** 이름이 같고 평면상 거의 같은 자리에 있는 shaft 방들을 기둥 하나로 묶는다.
 *  이름만으로 묶으면 나중에 동마다 '엘리베이터' 가 생겼을 때 서로 다른 기둥이
 *  하나로 합쳐진다. 좌표를 격자로 반올림해 묶으면 경계에 걸린 기둥이 갈라진다. */
const shaftColumns = new Map(); // room.id -> { bottom, top }
{
  const groups = [];
  for (const room of roomsData.rooms) {
    if (!room.shaft) continue;
    const [cx, cz] = center2d(room.polygon);
    const hit = groups.find(
      (g) =>
        g.name === room.name &&
        Math.hypot(g.cx - cx, g.cz - cz) < SHAFT_MERGE_TOLERANCE
    );
    if (hit) hit.rooms.push(room);
    else groups.push({ name: room.name, cx, cz, rooms: [room] });
  }
  for (const g of groups) {
    const floors = g.rooms.map((r) => r.floor);
    const topFloor = Math.max(...floors);
    // 중간 층 방을 아직 안 그린 기둥이 있다(2층 계단실5). 그 자리는 비워두는 게
    // 맞으므로 '위아래로 이어붙일지' 는 span 이 아니라 실제 층 유무로 판단한다.
    const span = {
      bottom: Math.min(...floors),
      top: topFloor,
      floors: new Set(floors),
      // 꼭대기 칸이 지붕 위로 내민 계단실이면 기둥이 층고만큼 더 길다.
      // 밝기 그라데이션 기준을 그만큼 늘려야 위쪽이 하얗게 타지 않는다.
      roofTop: g.rooms.some((r) => r.floor === topFloor && r.roofTop),
    };
    for (const r of g.rooms) shaftColumns.set(r.id, span);
  }
}

for (const room of roomsData.rooms) {
  const style = TYPE_STYLE[room.type] ?? TYPE_STYLE.normal;
  const color = roomColor(room, PALETTE, TYPE_COLORS);

  const column = shaftColumns.get(room.id);
  const joinUp = !!column && column.floors.has(room.floor + 1);
  const joinDown = !!column && column.floors.has(room.floor - 1);
  // 지붕 위로 내민 계단실 꼭대기(파서의 roofShafts). 위에 칸은 없지만 높이는
  // 층고만큼 써서 지붕 밖으로 살짝 나오게 한다.
  const roofTop = room.roofTop === true;
  // 홀처럼 눕혀 깔 종류는 높이를 설정에서 받는다 (cm, 없으면 undefined).
  const flat = TYPE_HEIGHTS[room.type];
  // 위층 칸이 있을 때만 층고까지 늘린다. 맨 위 칸을 늘리면 기둥이 다른 방보다
  // 툭 튀어나오고, 중간이 비어 있으면 허공에 뚜껑 없는 상자가 남는다.
  // 기둥과 납작한 방은 겹치지 않는다 — 계단실은 circulation, 홀은 hall 이다.
  const height = joinUp || roofTop ? FLOOR_HEIGHT_CM : flat ?? WALL_HEIGHT;
  const geometry = buildGeometry(room.polygon, height);

  const material = createRoomMaterial(color, style.opacity);
  // 그라데이션 기준 높이. 자기 높이를 줘야 한다 — 30cm 슬래브에 250cm 기준을
  // 쓰면 밝기가 아래쪽 구간에만 걸려 시커멓게 깔린다.
  material.uniforms.uHeight.value = column
    ? (column.top - column.bottom) * FLOOR_HEIGHT +
      (column.roofTop ? FLOOR_HEIGHT : TOP_Y)
    : height * SCALE;
  material.uniforms.uHOffset.value = column
    ? (room.floor - column.bottom) * FLOOR_HEIGHT
    : 0;

  const mesh = new THREE.Mesh(geometry, material);

  const edges = createEdges(geometry, color, style, {
    // 납작한 방(홀)의 아랫 테두리는 남긴다. 30cm 간격이라 선이 겹쳐 보일까 봐
    // 지워봤더니, 바닥에 닿는 선이 없어져 판이 어디서 끝나는지 안 읽혔다.
    // 위아래 두 선이 다 있어야 두께가 있는 판으로 보인다.
    dropBottom: joinDown,
    dropTop: joinUp,
  });
  mesh.add(edges);
  lineMaterials.push(edges.material);

  mesh.userData = {
    room,
    edges,
    baseColor: color,
    baseLineOpacity: style.lineOpacity,
    baseLineWidth: style.lineWidth,
    height, // 이름표를 매스 한가운데 놓는 데 쓴다 (방마다 다르다)
  };

  // 계단실·엘리베이터는 층 그룹에 넣지 않는다. 층 그룹에 넣으면 층을 하나만 켤 때
  // 그 층 칸만 남아 기둥이 토막 난다. 층이 잘려도 1층부터 꼭대기까지 관통해 있어야
  // 건물의 뼈대가 읽힌다. 대신 층 높이를 메시가 직접 진다.
  if (room.shaft) {
    mesh.position.y = floorY(room.floor);
    roomGroup.add(mesh);
  } else {
    (floorGroups.get(room.floor) ?? roomGroup).add(mesh);
  }
  roomMeshes.push(mesh);
}

// ---------------------------------------------------------------- 이름 묶음
// 같은 층에 이름이 같은 방이 여럿 있다 (1층 홀 3개, 꿈돋움 라운지 2개 …).
// 검색 결과에 똑같은 줄이 여러 개 뜨면 뭐가 뭔지 구분이 안 되므로 한 줄로 합치고,
// 고르면 해당하는 방을 전부 같이 켠다.
//
// 홀은 한 발 더 나간다. 벽으로 나뉘어 그려졌을 뿐 실제로는 이어진 한 공간이라
// 호버와 정보 패널까지 묶음 단위로 본다(= 한 객체). 나머지는 각각 따로 있는
// 방이 이름만 같은 것이므로 객체는 그대로 두고 검색에서만 함께 다룬다.
//
// 동은 키에 넣지 않는다. 1층 홀 3개는 2동·2동·1동에 흩어져 있지만 같은 홀이다.
const nameGroups = new Map(); // "층|이름" -> mesh[]

for (const m of roomMeshes) {
  const { floor, name } = m.userData.room;
  const key = floor + "|" + name;
  const list = nameGroups.get(key);
  if (list) list.push(m);
  else nameGroups.set(key, [m]);
}

for (const meshes of nameGroups.values()) {
  const merged = meshes.length > 1 && meshes[0].userData.room.type === "hall";
  for (const m of meshes) {
    m.userData.group = meshes;
    m.userData.merged = merged;
  }
}

const groupList = [...nameGroups.values()];

/** 클릭·호버가 건드릴 범위. 한 객체로 묶은 홀만 통째로, 나머지는 자기 자신만. */
const pickGroup = (mesh) => (mesh.userData.merged ? mesh.userData.group : [mesh]);

// ---------------------------------------------------------------- 방 이름표
// 층별 뷰에서 방마다 중심에 이름을 띄운다. 씬 안이 아니라 캔버스 위 DOM 이다 —
// 스프라이트로 만들면 후처리 블룸을 그대로 먹어 작은 한글이 번져 뭉갠다. DOM 은
// 후처리 바깥이라 글자가 깨끗하고, 2D 레이어라 시점이 바뀌어도 항상 정면을 본다.
//
// 홀은 뺀다. 이미 바닥판으로 깔려 있고 층마다 하나뿐이라 이름을 띄워도 얻는 게 없다.
const labelsEl = document.getElementById("labels");

// 방의 화면상 폭이 이 값(px)보다 좁으면 이름표를 건너뛴다. 0 이면 전부 표시.
// 띄워 보고 너무 빽빽하면 이 숫자만 올리면 작은 방부터 사라진다.
const LABEL_MIN_PX = 0;

const labels = [];

for (const mesh of roomMeshes) {
  const room = mesh.userData.room;
  if (room.type === "hall" || !room.center) continue;

  const el = document.createElement("div");
  el.textContent = room.name;
  labelsEl.appendChild(el);

  const xs = room.polygon.map((p) => p[0]);
  const zs = room.polygon.map((p) => p[1]);

  labels.push({
    mesh,
    el,
    shown: true, // 첫 프레임에 반드시 한 번 맞춰지도록 반대값으로 시작한다
    lit: true,
    // 기준점은 로컬 좌표로 들고 있는다. 층 그룹 높이와 인트로 애니메이션이 mesh 의
    // matrixWorld 에 이미 반영돼 있어서 localToWorld 한 번이면 끝난다.
    anchor: new THREE.Vector3(
      room.center[0] * SCALE,
      (mesh.userData.height * SCALE) / 2,
      room.center[1] * SCALE
    ),
    // LABEL_MIN_PX 를 켰을 때만 쓰는 값 — 방의 반폭(월드 단위)
    halfSpan:
      (Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) *
        SCALE) /
      2,
  });
}

const labelPos = new THREE.Vector3();
const labelEdge = new THREE.Vector3();
const camRight = new THREE.Vector3();

// ---------------------------------------------------------------- 패널 붙이기
// 방 정보를 화면 구석이 아니라 고른 방 옆에 띄운다. 클릭한 곳에서 답이 나오는 게
// 눈과 손이 덜 움직인다. 방을 클릭해도 카메라가 안 움직이므로(비행은 검색으로
// 고를 때뿐) 패널이 클릭 직후에 미끄러지는 일은 없다.
//
// 방이 화면 밖으로 나가거나 카메라 뒤로 돌아가면 구석으로 되돌린다. 붙어 있으려다
// 잘리거나 사라지면 정보를 못 보는 것이라 더 나쁘다.
let panelPinned = false; // 이름표를 뺄지 판단하는 데도 쓴다
const PANEL_GAP = 18; // 방과 패널 사이 여백(px)
const PANEL_EDGE = 16; // 화면 가장자리에서 최소한 띄울 거리
const panelAnchor = new THREE.Vector3();

/** 어느 메시에 붙일지. 묶음이면 제일 큰 덩어리에 붙인다 —
 *  1층 홀처럼 조각이 여럿이면 큰 쪽 옆에 있어야 자연스럽다. */
function anchorMesh(meshes) {
  let best = meshes[0];
  for (const m of meshes) {
    if ((m.userData.room.area ?? 0) > (best.userData.room.area ?? 0)) best = m;
  }
  return best;
}

function unpinPanel() {
  panelPinned = false;
  if (!panel.classList.contains("pinned") && !panel.style.left) return;
  panel.classList.remove("pinned");
  // 인라인 위치를 반드시 같이 지운다. 남겨두면 left/top 과 CSS 의 right/bottom 이
  // 네 변 모두 걸려서 패널이 그 사이로 길게 늘어난다.
  panel.style.left = "";
  panel.style.top = "";
}

function updatePanelAnchor() {
  if (panel.hidden || !selected.length) {
    unpinPanel();
    return;
  }

  // 좁은 화면은 패널이 위쪽 고정이다. 떠다니면 손가락에 가리고 화면도 좁다.
  if (window.matchMedia("(max-width: 720px)").matches) {
    unpinPanel();
    return;
  }

  const mesh = anchorMesh(selected);
  const room = mesh.userData.room;
  if (!mesh.visible || !room.center) {
    unpinPanel();
    return;
  }

  // 매스 윗면에 맞춘다. 한가운데로 잡으면 패널이 방에 파묻힌 것처럼 보인다.
  panelAnchor.set(
    room.center[0] * SCALE,
    mesh.userData.height * SCALE,
    room.center[1] * SCALE
  );
  mesh.localToWorld(panelAnchor);
  panelAnchor.project(camera);

  const w = window.innerWidth;
  const h = window.innerHeight;
  const x = (panelAnchor.x * 0.5 + 0.5) * w;
  const y = (-panelAnchor.y * 0.5 + 0.5) * h;

  // 카메라 뒤이거나 화면에서 한참 벗어났으면 구석으로
  const out =
    panelAnchor.z > 1 || x < -w * 0.2 || x > w * 1.2 || y < -h * 0.2 || y > h * 1.2;
  if (out) {
    unpinPanel();
    return;
  }

  const box = panel.getBoundingClientRect();
  // 기본은 오른쪽. 오른쪽이 좁으면 왼쪽으로 넘긴다
  let left = x + PANEL_GAP;
  if (left + box.width > w - PANEL_EDGE) left = x - PANEL_GAP - box.width;
  left = Math.min(Math.max(left, PANEL_EDGE), w - box.width - PANEL_EDGE);

  let top = y - box.height / 2;
  top = Math.min(Math.max(top, PANEL_EDGE), h - box.height - PANEL_EDGE);

  panelPinned = true;
  panel.classList.add("pinned");
  panel.style.left = Math.round(left) + "px";
  panel.style.top = Math.round(top) + "px";
}

function updateLabels() {
  // 전체 뷰는 층이 겹쳐 이름표가 네 겹으로 쌓인다. 층별 뷰에서만 켠다.
  const on = activeFloor !== null;
  if (labelsEl.hidden === on) labelsEl.hidden = !on;
  if (!on) return;

  const w = window.innerWidth;
  const h = window.innerHeight;
  if (LABEL_MIN_PX > 0) camRight.setFromMatrixColumn(camera.matrixWorld, 0);

  for (const l of labels) {
    // mesh.visible 에 층·동·종류 필터가 이미 다 반영돼 있다.
    // 패널이 그 방 옆에 붙어 있으면 이름표는 뺀다 — 바로 옆 카드에 같은 이름이
    // 큰 글씨로 있어서 겹쳐 읽히기만 한다.
    // 기둥은 모든 층에서 보이므로 이름표를 그대로 두면 계단실1 이 네 겹으로 쌓인다.
    // 지금 보고 있는 층의 것만 남긴다.
    let show =
      l.mesh.visible &&
      isShown(l.mesh.userData.room) &&
      !(panelPinned && selectedSet.has(l.mesh));

    if (show) {
      labelPos.copy(l.anchor);
      l.mesh.localToWorld(labelPos);

      if (LABEL_MIN_PX > 0) {
        labelEdge.copy(labelPos).addScaledVector(camRight, l.halfSpan);
        labelEdge.project(camera);
      }
      labelPos.project(camera);

      // z > 1 이면 카메라 뒤다. 투영이 뒤집혀 엉뚱한 자리에 찍힌다.
      show = labelPos.z <= 1;

      if (show && LABEL_MIN_PX > 0) {
        show = Math.abs(labelEdge.x - labelPos.x) * w >= LABEL_MIN_PX;
      }
    }

    // DOM 은 바뀔 때만 건드린다. 매 프레임 display 를 쓰면 레이아웃을 다시 잡는다.
    if (show !== l.shown) {
      l.el.style.display = show ? "" : "none";
      l.shown = show;
    }
    if (!show) continue;

    // 위치는 transform 으로만 옮긴다. left/top 을 쓰면 매 프레임 레이아웃이 돈다.
    l.el.style.transform =
      "translate(-50%,-50%) translate(" +
      ((labelPos.x * 0.5 + 0.5) * w).toFixed(1) +
      "px," +
      ((-labelPos.y * 0.5 + 0.5) * h).toFixed(1) +
      "px)";

    const lit = selectedSet.has(l.mesh);
    if (lit !== l.lit) {
      l.el.classList.toggle("on", lit);
      l.lit = lit;
    }
  }
}

// ---------------------------------------------------------------- 필터
// 층 / 동 / 종류 세 가지가 겹쳐서 걸린다. 한 곳에서만 판정해야 어긋나지 않는다.
let activeFloor = null; // null = 전체
const activeBuildings = new Set(
  (roomsData.meta.buildings ?? []).map((b) => b.name)
);
const activeTypes = new Set(Object.keys(TYPE_STYLE));

/** 층 필터까지 포함한 판정. 카메라를 맞출 때와 이름표에 쓴다. */
const isShown = (room) =>
  (activeFloor === null || room.floor === activeFloor) &&
  activeBuildings.has(room.building) &&
  activeTypes.has(room.type);

/** 화면에 그릴지. 계단실 기둥만 층 필터를 건너뛴다 — 층을 하나만 켜도 기둥은
 *  1층부터 꼭대기까지 그대로 서 있어야 한다. 카메라 맞추기(isShown)에는 이걸
 *  쓰지 않는다. 쓰면 4층만 봐도 기둥 전체가 화면에 들어오려고 뒤로 물러난다. */
const isVisible = (room) =>
  room.shaft
    ? activeBuildings.has(room.building) && activeTypes.has(room.type)
    : isShown(room);

/** 레이캐스트 대상. 복도를 빼는 이유는 교실을 가리기 때문이고,
 *  숨긴 방을 빼는 이유는 안 보이는 게 클릭을 가로채면 안 되기 때문이다. */
let pickables = [];

function applyFilters() {
  for (const [f, g] of floorGroups) {
    g.visible = activeFloor === null || f === activeFloor;
  }
  for (const m of roomMeshes) {
    m.visible = isVisible(m.userData.room);
  }
  // 반사는 맨 아래층이 보일 때만 의미가 있다
  reflection.visible = activeFloor === null || activeFloor === BASE_FLOOR;
  for (const m of reflection.children) {
    m.visible = isShown(m.userData.room);
  }

  pickables = roomMeshes.filter(
    (m) => m.visible && m.userData.room.type !== "circulation"
  );

  // 숨겨진 방이 선택/호버 상태로 남지 않게 한다.
  // 묶음은 일부만 가려질 수 있으므로, 하나라도 보이면 선택을 유지한다.
  if (selected.length && !selected.some((m) => m.visible)) setSelected(null);
  if (hovered.length && !hovered.some((m) => m.visible)) setHovered(null);

  requestRender();
}

// ---------------------------------------------------------------- 카메라 배치
const center = new THREE.Vector3();

// 대각선 위 45도에서 내려다본다
const dir = new THREE.Vector3(0.5, Math.SQRT1_2, 0.5).normalize();

/** 실제 방 꼭짓점을 카메라 축에 투영해 딱 맞는 거리를 구한다.
 *  boundingSphere 로 맞추면 이 건물처럼 납작하고 대각선 ㅍ자로 퍼진 모양은
 *  구가 과하게 커져 화면 절반이 빈 공간이 된다. bounding box 꼭짓점도
 *  마찬가지로 모서리가 허공이라 헐거워진다. 그래서 진짜 정점을 쓴다. */
function fitDistance(rooms, target, viewDir = dir, margin = 1.04) {
  margin = margin ?? 1.04;
  const forward = viewDir.clone().normalize().negate(); // 카메라가 바라보는 방향
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

// 줌 한계. 기준은 '전체가 딱 들어오는 거리' 인 dist 다.
// 밖으로는 그 1.6배까지만 — 더 빼면 건물이 안개 속 점이 되고 되돌아오기 어렵다.
// 안쪽은 넉넉히 열어둔다. flyToRoom 이 제일 작은 방(엘리베이터 8.5㎡)에 다가갈 때
// 쓰는 거리보다 작아야 한다. 안 그러면 검색으로 방을 고를 때마다 컨트롤이
// 카메라를 도로 밀어내 화면이 튄다.
controls.minDistance = dist * 0.04;
controls.maxDistance = dist * 1.6;

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
const { composer, bloom, bloomScale } = createComposer(
  renderer,
  scene,
  camera,
  LOW_END ? QUALITY.low : QUALITY.full
);

// ---------------------------------------------------------------- 상호작용
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
// 묶음 때문에 둘 다 배열이다. 빈 배열 = 아무것도 아님.
let hovered = [];
let selected = [];
let hoveredSet = new Set();
let selectedSet = new Set();

const panel = document.getElementById("panel");
const panelName = document.getElementById("panel-name");
const panelBuilding = document.getElementById("panel-building");
const panelType = document.getElementById("panel-type");
const panelParts = document.getElementById("panel-parts");
const panelBook = document.getElementById("panel-book");

// 예약 화면이 sourceId 로 방 이름을 찾을 수 있게 목록을 넘겨준다
setRooms(roomsData.rooms);
document.getElementById("open-status").addEventListener("click", openStatus);

// 예약창은 지금 패널에 떠 있는 방을 그대로 받는다
panelBook.addEventListener("click", () => {
  if (selected.length) openReservation(selected[0].userData.room);
});

/** 묶음의 동 표기. 여러 동에 걸친 홀은 어느 한 동으로 적을 수 없다. */
function buildingLabel(meshes) {
  const names = [...new Set(meshes.map((m) => m.userData.room.building))];
  return names.length === 1 ? names[0] : names.join(" · ");
}

function openPanel(meshes) {
  const { room } = meshes[0].userData;
  const area = meshes.reduce((sum, m) => sum + (m.userData.room.area ?? 0), 0);

  panelName.textContent = room.name;
  panelType.textContent = TYPE_LABEL[room.type] ?? room.type;
  panelBuilding.textContent =
    FLOORS.length > 1
      ? `${buildingLabel(meshes)} · ${room.floor}F`
      : buildingLabel(meshes);
  // 여러 덩어리를 함께 켰다는 사실과 합계 면적을 같이 보여준다.
  panelParts.textContent =
    meshes.length > 1
      ? `${meshes.length}곳 · ${Math.round(area)}㎡`
      : `${Math.round(area)}㎡`;
  panel.style.setProperty(
    "--accent",
    "#" + (PALETTE[room.building] ?? new THREE.Color(0x22d3ee)).getHexString()
  );
  // 예약을 받는 방에만 버튼이 뜬다 (rooms.json 의 reservable, 원천은 plan.config.json)
  panelBook.hidden = !isReservable(room);
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

  if (selectedSet.has(m)) {
    mat.color.setHex(0xffffff);
    mat.opacity = 1;
    mat.linewidth = d.baseLineWidth * 1.8;
  } else if (hoveredSet.has(m)) {
    mat.color.setHex(0xeaffff);
    mat.opacity = Math.min(1, d.baseLineOpacity * 1.6);
    mat.linewidth = d.baseLineWidth * 1.3;
  } else {
    mat.color.copy(d.baseColor);
    mat.opacity = d.baseLineOpacity * (selected.length ? DIM_OTHERS : 1);
    mat.linewidth = d.baseLineWidth;
  }
}

/** 선택 상태. 대비는 선택된 방을 밝히기보다 나머지를 눌러서 만든다.
 *  매스를 밝히면 겹쳐 보이는 곳이 다시 타버리기 때문이다.
 *  묶음이면 여러 개가 한꺼번에 켜진다. */
function setSelected(meshes) {
  selected = meshes ?? [];
  selectedSet = new Set(selected);

  for (const m of roomMeshes) {
    const isSel = selectedSet.has(m);
    m.material.uniforms.uSelected.value = isSel ? 1 : 0;
    m.material.uniforms.uDim.value =
      selected.length === 0 || isSel ? 1 : DIM_OTHERS;
    refreshEdge(m);
  }

  if (selected.length) openPanel(selected);
  else closePanel();

  requestRender();
}

document.getElementById("panel-close").addEventListener("click", () => setSelected(null));

// ---------------------------------------------------------------- 카메라 이동
// 클릭·검색으로 방을 고르면 그 방으로 부드럽게 날아간다.
// 시점 방향은 유지한다 — 방향까지 바꾸면 어디를 보고 있었는지 잃어버린다.
let flight = null;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function flyTo(toTarget, toDistance, { seconds = 0.7, direction = null } = {}) {
  const dirNow = camera.position.clone().sub(controls.target);
  const d = toDistance ?? dirNow.length();
  // direction 을 준 경우(시점 프리셋)에만 방향을 바꾼다.
  const unit = (direction ?? dirNow).clone().normalize();
  flight = {
    fromTarget: controls.target.clone(),
    toTarget: toTarget.clone(),
    fromPos: camera.position.clone(),
    toPos: toTarget.clone().addScaledVector(unit, d),
    t: 0,
    dur: seconds,
  };
}

/** 묶음이면 전부 화면에 들어오게 잡는다. 하나만 잡으면 "둘 다 켰는데 한쪽만
 *  보이는" 상태가 되어 동시에 켠 의미가 없다. */
function flyToRoom(meshes) {
  const b = new THREE.Box3();
  for (const m of meshes) b.expandByObject(m);
  const c = b.getCenter(new THREE.Vector3());
  const r = Math.max(b.getBoundingSphere(new THREE.Sphere()).radius, TOP_Y);
  // 방이 화면의 약 1/3 을 채우도록
  flyTo(c, (r / Math.sin((camera.fov * Math.PI) / 180 / 2)) * 3.0);
}

function flyToAll() {
  const shown = roomsData.rooms.filter(isShown);
  if (!shown.length) return;
  center.copy(centerOf(shown));
  flyTo(center, fitDistance(shown, center, camera.position.clone().sub(controls.target)));
}

// ---------------------------------------------------------------- 시점 프리셋
// 방향만 정해두면 거리는 그때 보이는 방들에 맞춰 다시 잰다. 층을 하나만 켜둔
// 상태에서 눌러도 그 층에 딱 맞게 잡힌다.
//   평면: 정확히 수직으로 두면 방위각이 정의되지 않아 컨트롤이 튄다. 5도쯤 눕히되
//         기우는 방향을 z 축에 맞춘다. 대각선으로 눕히면 건물이 비스듬히 놓여
//         평면도가 아니라 그냥 위에서 본 3D 처럼 보인다.
//   정면: 동이 z 축을 따라 앞뒤로 놓여 있어 완전히 수평으로 보면 앞 동이 나머지를
//         가린다. 15도쯤 올려 앞 동 너머가 보이게 하고, 여백을 조금 더 줘서
//         원근이 덜 과장되게 한다. 그래야 층이 쌓인 게 읽힌다.
const VIEWPOINTS = [
  { label: "기본", title: "기본 시점 (대각선 위 45°)", dir: dir.clone() },
  { label: "평면", title: "평면 — 바로 위에서", dir: new THREE.Vector3(0, 1, 0.08) },
  {
    label: "정면",
    title: "정면 — 층이 쌓인 게 보이게",
    dir: new THREE.Vector3(0, 0.28, -1),
    margin: 1.2,
  },
];

const viewsEl = document.getElementById("views");

for (const vp of VIEWPOINTS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = vp.label;
  b.title = vp.title;
  b.addEventListener("click", () => {
    const shown = roomsData.rooms.filter(isShown);
    if (!shown.length) return;
    center.copy(centerOf(shown));
    flyTo(center, fitDistance(shown, center, vp.dir, vp.margin), {
      direction: vp.dir,
    });
  });
  viewsEl.appendChild(b);
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
  // 가로로 늘어놓으므로 왼쪽부터 낮은 층 순이다 (세로 바일 때는 반대였다)
  for (const label of ["전체", ...[...FLOORS].sort((a, b) => a - b)]) {
    const b = document.createElement("button");
    const isAll = label === "전체";
    b.textContent = isAll ? "전체" : label + "F";
    b.dataset.floor = isAll ? "null" : String(label);
    b.type = "button";
    b.addEventListener("click", () => setFloor(isAll ? null : label));
    floorsEl.appendChild(b);
    floorButtons.push(b);
  }
  // 구역 제목까지 같이 드러낸다. 버튼만 켜면 '층' 이라는 제목이 홀로 남는다.
  document.getElementById("sec-floors").hidden = false;
}

// ---------------------------------------------------------------- 패널 접기
// 좁은 화면에서는 지도부터 보여준다. 넓은 화면에서는 펼친 채로 시작한다.
const uiEl = document.getElementById("ui");
const uiToggle = document.getElementById("ui-toggle");

function setUiOpen(open) {
  uiEl.classList.toggle("closed", !open);
  uiToggle.setAttribute("aria-expanded", String(open));
  uiToggle.setAttribute("aria-label", open ? "조작 패널 접기" : "조작 패널 펼치기");
}

uiToggle.addEventListener("click", () =>
  setUiOpen(uiEl.classList.contains("closed"))
);

setUiOpen(!window.matchMedia("(max-width: 720px)").matches);

// ---------------------------------------------------------------- 범례 겸 필터
const TYPE_LABEL = {
  normal: "교실 · 시설",
  service: "화장실",
  circulation: "계단 · 엘리베이터",
  hall: "홀",
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

function setHovered(meshes) {
  const next = meshes ?? [];
  // 같은 묶음 안에서 움직일 때 매번 다시 칠하지 않는다
  if (next.length === hovered.length && next.every((m) => hoveredSet.has(m))) {
    return;
  }

  const prev = hovered;
  hovered = next;
  hoveredSet = new Set(next);

  for (const m of prev) {
    m.material.uniforms.uHover.value = 0;
    refreshEdge(m);
  }
  for (const m of hovered) {
    m.material.uniforms.uHover.value = 1;
    refreshEdge(m);
  }

  canvas.style.cursor = hovered.length ? "pointer" : "default";
  requestRender();
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
  const m = pick(event);
  setHovered(m ? pickGroup(m) : null);
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

  const m = pick(event);
  setSelected(m ? pickGroup(m) : null); // 빈 곳이면 선택 해제 + 패널 닫힘
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

// ---------------------------------------------------------------- 검색
const searchEl = document.getElementById("search");
const resultsEl = document.getElementById("search-results");
const clearEl = document.getElementById("search-clear");
let cursor = -1; // 키보드로 고른 항목

/** 검색은 방이 아니라 묶음 단위다. 같은 층에 이름이 같은 방이 3개 있어도
 *  결과는 한 줄이고, 고르면 3개가 한꺼번에 켜진다. */
function matchRooms(q) {
  const s = q.trim().toLowerCase();
  if (!s) return [];
  return groupList
    .filter((g) => g[0].userData.room.name.toLowerCase().includes(s))
    .sort((a, b) => {
      const an = a[0].userData.room.name.toLowerCase();
      const bn = b[0].userData.room.name.toLowerCase();
      // 앞에서부터 일치하는 것을 먼저
      return (an.startsWith(s) ? 0 : 1) - (bn.startsWith(s) ? 0 : 1) ||
        a[0].userData.room.floor - b[0].userData.room.floor ||
        an.localeCompare(bn);
    })
    .slice(0, 40);
}

function chooseRoom(meshes) {
  // 필터에 가려 안 보이는 방을 골랐으면 보이도록 필터를 풀어준다.
  // 안 그러면 "검색은 되는데 아무 일도 안 일어나는" 상태가 된다.
  // 묶음은 동이 갈릴 수 있으므로(1층 홀) 구성원 전부를 풀어줘야 한다.
  if (!meshes.every((m) => isShown(m.userData.room))) {
    for (const m of meshes) {
      activeBuildings.add(m.userData.room.building);
      activeTypes.add(m.userData.room.type);
    }
    const floor = meshes[0].userData.room.floor;
    if (activeFloor !== null && activeFloor !== floor) setFloorSilently(null);
    applyFilters();
    syncChips();
  }
  setSelected(meshes);
  flyToRoom(meshes);
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
  list.forEach((meshes) => {
    const room = meshes[0].userData.room;
    const b = document.createElement("button");
    b.type = "button";
    b.appendChild(document.createTextNode(room.name));
    const w = document.createElement("span");
    w.className = "where";
    const where =
      FLOORS.length > 1
        ? `${buildingLabel(meshes)} · ${room.floor}F`
        : buildingLabel(meshes);
    // 이름이 같은 방이 여럿이면 몇 곳인지 알려준다 (한 줄로 합쳤기 때문)
    w.textContent = meshes.length > 1 ? `${where} · ${meshes.length}곳` : where;
    b.appendChild(w);
    b.addEventListener("click", () => {
      chooseRoom(meshes);
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
  const dpr = Math.min(window.devicePixelRatio, LOW_END ? 1.25 : 2);

  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h);

  composer.setPixelRatio(dpr);
  composer.setSize(w, h);
  // 블룸은 낮은 해상도로 흐린다. 여기서 배율을 안 곱하면 리사이즈 한 번에
  // 원래 해상도로 돌아가 버린다.
  bloom.setSize(w * bloomScale, h * bloomScale);

  // 이걸 빠뜨리면 창 크기를 바꾼 뒤 선 두께가 틀어진다
  for (const m of lineMaterials) m.resolution.set(w, h);
  requestRender();
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

  // 진행 중인 애니메이션이 있으면 계속 그려야 한다
  let animating = false;

  // 인트로: 매스가 아래에서 올라오며 페이드인
  if (revealT < 1) {
    animating = true;
    revealT = Math.min(1, revealT + dt / REVEAL_SECONDS);
    const e = 1 - Math.pow(1 - revealT, 3); // easeOutCubic
    roomGroup.position.y = (1 - e) * -TOP_Y * 2.5;
    reflection.position.y = -0.03 - (1 - e) * -TOP_Y * 2.5;
    for (const m of roomMeshes) m.material.uniforms.uReveal.value = e;
    for (const m of reflection.children) m.material.uniforms.uReveal.value = e;
  }

  // 카메라 비행. 사용자가 직접 궤도를 돌리면 즉시 양보한다.
  if (flight) {
    animating = true;
    flight.t = Math.min(1, flight.t + dt / flight.dur);
    const e = easeInOut(flight.t);
    controls.target.lerpVectors(flight.fromTarget, flight.toTarget, e);
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    if (flight.t >= 1) flight = null;
  }

  // 감쇠가 남아 있으면 update() 가 true 를 준다. 손을 떼도 부드럽게 멈추도록
  // 이 호출 자체는 매 프레임 해야 한다 — 비싼 건 그리기지 이 계산이 아니다.
  const moving = controls.update();

  if (!renderPending && !moving && !animating) return;
  renderPending = false;

  composer.render();

  // 렌더 뒤에 부른다. 카메라·오브젝트 행렬이 최신이라 따로 갱신할 필요가 없다.
  updateLabels();
  updatePanelAnchor();
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
