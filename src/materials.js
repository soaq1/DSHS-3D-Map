import * as THREE from "three";
import { LineSegments2 } from "three/examples/jsm/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/examples/jsm/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";

// 동(棟)이 색을, 타입이 처리 강도를 결정한다.
// 색은 rooms.json 의 meta.buildings 에서 읽는다 (원천은 plan.config.json).
// 새 동이 생겨도 이 파일을 고칠 필요가 없다.
const FALLBACK = [0x22d3ee, 0x2dd4a7, 0xa78bfa, 0xf0abfc, 0xfbbf24, 0xf87171];

export function buildPalette(meta) {
  const palette = {};
  (meta.buildings ?? []).forEach((b, i) => {
    palette[b.name] = new THREE.Color(b.color ?? FALLBACK[i % FALLBACK.length]);
  });
  return palette;
}

// 층이 4개 쌓이면 한 시선에 방이 10겹 넘게 겹친다. 한 겹이 진하면 겹친 곳이
// 타버리므로 매스는 옅게 두고 형태는 선으로 읽히게 한다.
export const TYPE_STYLE = {
  normal: { opacity: 0.1, lineOpacity: 0.62, lineWidth: 1.7, lighten: 0 },
  // lighten 을 0.12 만 줘도 블룸이 겹치면 화장실이 흰 상자로 튀어 시선을 뺏는다.
  service: { opacity: 0.11, lineOpacity: 0.66, lineWidth: 1.7, lighten: 0.07 },
  // 복도·계단은 매스를 거의 지우되 선은 남긴다. 선까지 죽이면 세 동을 잇는
  // ㅍ자 구조가 안 읽혀서 건물이 세 덩어리로 끊어져 보인다.
  circulation: { opacity: 0.035, lineOpacity: 0.42, lineWidth: 1.2, lighten: -0.16 },
};

export function roomColor(room, palette) {
  const style = TYPE_STYLE[room.type] ?? TYPE_STYLE.normal;
  const c = (palette[room.building] ?? new THREE.Color(FALLBACK[0])).clone();
  if (style.lighten) c.offsetHSL(0, 0, style.lighten);
  return c;
}

const VERT = /* glsl */ `
  varying float vH;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  #include <common>
  #include <fog_pars_vertex>

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    // ★ 월드 y 가 아니라 지오메트리 로컬 y 를 쓴다. 층을 쌓으면 월드 y 에
    //   층 높이가 더해져 h 가 1 을 넘고, 위층이 전부 평평하게 밝아진다.
    vH = position.y;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - wp.xyz);

    // fog_vertex 청크가 mvPosition 을 참조하므로 이 이름으로 두어야 한다.
    vec4 mvPosition = viewMatrix * wp;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uHeight;
  uniform float uFresnelPower;
  uniform float uHover;     // 0..1
  uniform float uSelected;  // 0..1
  uniform float uDim;       // 다른 방을 눌러 대비를 만드는 전역 계수
  uniform float uReveal;    // 인트로 페이드인
  uniform float uReflect;   // 1 이면 바닥 반사용 (아래로 갈수록 사라짐)

  varying float vH;
  varying vec3 vNormalW;
  varying vec3 vViewDir;

  #include <common>
  #include <fog_pars_fragment>

  void main() {
    // 미러 클론은 y 가 음수라 abs 를 쓴다. 실제 매스는 어차피 양수.
    float h = clamp(abs(vH) / uHeight, 0.0, 1.0);
    float grad = mix(0.32, 1.0, h);           // 위가 밝다

    // 반사는 감쇠 방향이 반대다. 거울면(바닥)에 붙은 쪽이 가장 밝고
    // 멀어질수록 사라진다. 실물과 같은 그라데이션을 쓰면 바닥 쪽이 어두워지고
    // 거기에 거리 감쇠까지 곱해져 알파가 0.03까지 떨어져 아예 안 보인다.
    grad = mix(grad, mix(0.85, 0.12, h), uReflect);

    // 프레넬 — 시선에 스치는 면이 밝아져 유리/홀로그램처럼 보인다
    float fres = pow(1.0 - abs(dot(normalize(vViewDir), normalize(vNormalW))), uFresnelPower);

    // 선택 부스트를 너무 올리면 윗면이 단색으로 타서 방 형태가 안 읽힌다.
    // 대비는 나머지를 누르는 uDim 이 만들어주므로 여기는 절제한다.
    // ★ 더하지 말고 max 를 쓴다. 선택된 방에 다시 호버하면 두 값이 합쳐져
    //   2.5배로 타올라 눈이 아프다.
    float boost = max(uHover * 1.3, uSelected * 1.25);

    float a = uOpacity * grad * (1.0 + boost) + fres * 0.09 * (1.0 + boost);
    a *= uDim * uReveal;
    // grad 가 이미 반사 감쇠를 담당하므로 여기서는 살짝만 더 눌러준다
    a *= mix(1.0, 0.85, uReflect);

    // 색은 1.0 을 넘지 않게 눌러둔다. 넘기면 블룸이 흰색으로 밀어버려
    // 동별 색 구분이 사라진다.
    vec3 col = uColor * (grad + fres * 0.35 + boost * 0.22);
    col = min(col, vec3(1.0));

    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));

    #include <fog_fragment>
  }
`;

/** 방 매스 재질. ShaderMaterial 은 안개를 자동으로 못 받으므로
 *  UniformsLib.fog 를 합치고 fog:true 로 둬야 거리 안개가 살아난다. */
export function createRoomMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign(
      THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      {
        uColor: { value: new THREE.Color(color) },
        uOpacity: { value: opacity },
        uHeight: { value: 1 },
        uFresnelPower: { value: 2.2 },
        uHover: { value: 0 },
        uSelected: { value: 0 },
        uDim: { value: 1 },
        uReveal: { value: 1 },
        uReflect: { value: 0 },
      }
    ),
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    // 반투명 매스가 많이 겹치므로 이게 없으면 그리는 순서에 따라 방이 깜빡인다
    depthWrite: false,
    // ★ DoubleSide 로 두면 방 하나가 앞면+뒷면 2겹을 기여해서, 시점에서
    //   겹쳐 보일 때 빛이 두 배로 누적된다. 바깥에서 보는 용도라 앞면만 그린다.
    //   (감김 방향은 buildGeometry 에서 반시계로 맞춰둔다)
    side: THREE.FrontSide,
    fog: true,
  });
}

/** 두꺼운 네온 윤곽선. LineBasicMaterial 은 GPU 가 1px 로 강제해서
 *  블룸을 먹여도 거의 번지지 않는다. Line2 라야 두께가 나온다. */
export function createEdges(geometry, color, { lineWidth, lineOpacity }) {
  const lsg = new LineSegmentsGeometry().fromEdgesGeometry(
    new THREE.EdgesGeometry(geometry)
  );

  const material = new LineMaterial({
    color: new THREE.Color(color),
    linewidth: lineWidth,
    transparent: true,
    opacity: lineOpacity,
    depthWrite: false,
  });
  // resize 마다 갱신해야 한다. 안 하면 창 크기를 바꾼 뒤 선 두께가 틀어진다.
  material.resolution.set(window.innerWidth, window.innerHeight);

  return new LineSegments2(lsg, material);
}
