import * as THREE from "three";

/** 배경 그라데이션 막.
 *  CSS 배경 + 투명 캔버스로 하면 블룸이 알파를 물고 테두리 아티팩트를 만든다.
 *  씬 안에 큰 구를 넣어 프레임버퍼를 항상 불투명하게 유지한다. */
export function createBackdrop(radius, inner = 0x0a1626, outer = 0x02060c) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: {
        uInner: { value: new THREE.Color(inner) },
        uOuter: { value: new THREE.Color(outer) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uInner;
        uniform vec3 uOuter;
        varying vec3 vDir;
        void main() {
          // 수평선 부근이 가장 밝고 위아래로 갈수록 어두워진다
          float t = smoothstep(0.0, 0.75, abs(vDir.y));
          gl_FragColor = vec4(mix(uInner, uOuter, t), 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
  );
  mesh.renderOrder = -1;
  return mesh;
}

/** 셰이더 바닥. GridHelper 와 달리 fwidth 기반이라 거리와 무관하게
 *  선 두께가 일정하고, 가장자리가 수평선으로 자연스럽게 사라진다. */
export function createGround(size, { grid = 0x2f7f9e, glow = 0x14536e } = {}) {
  const geometry = new THREE.PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uGrid: { value: new THREE.Color(grid) },
      uGlow: { value: new THREE.Color(glow) },
      uMinor: { value: size / 4 }, // 잔 그리드
      uMajor: { value: size / 20 }, // 굵은 그리드
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3  uGrid;
      uniform vec3  uGlow;
      uniform float uMinor;
      uniform float uMajor;
      varying vec2 vUv;

      // 화면 공간 미분으로 두께를 잡아 계단현상 없이 선을 그린다
      float gridLine(vec2 uv, float scale) {
        vec2 c = uv * scale;
        vec2 g = abs(fract(c - 0.5) - 0.5) / fwidth(c);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }

      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float fade = 1.0 - smoothstep(0.15, 1.0, d);

        float g = max(gridLine(vUv, uMinor) * 0.32, gridLine(vUv, uMajor) * 0.85) * fade;
        float glow = pow(max(0.0, 1.0 - d * 1.35), 3.0) * 0.55;

        vec3 col = uGrid * g + uGlow * glow;
        float a = g * 0.85 + glow * 0.6;
        if (a < 0.002) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = -0.02;
  return mesh;
}

/** 바닥 반사. Reflector 는 씬을 한 번 더 렌더하고 자체 셰이더라
 *  안개·색공간이 따로 논다. 매스를 뒤집어 복제하는 쪽이 싸고 재질도 그대로 쓴다. */
export function createReflection(meshes) {
  const group = new THREE.Group();
  group.scale.y = -1;
  group.position.y = -0.03;

  for (const src of meshes) {
    const material = src.material.clone();
    material.uniforms.uReflect.value = 1;
    material.uniforms.uOpacity.value = src.material.uniforms.uOpacity.value * 0.9;

    const mesh = new THREE.Mesh(src.geometry, material);
    mesh.raycast = () => {}; // 반사가 클릭에 잡히면 안 된다
    // 필터가 실물과 반사를 같이 켜고 끌 수 있게 방 정보를 들고 간다
    mesh.userData = { room: src.userData.room };

    // 윤곽선도 같이 뒤집어야 형태가 읽힌다
    const srcEdges = src.userData.edges;
    if (srcEdges) {
      const em = srcEdges.material.clone();
      em.opacity = srcEdges.material.opacity * 0.45;
      const edges = new srcEdges.constructor(srcEdges.geometry, em);
      edges.raycast = () => {};
      mesh.add(edges);
    }

    group.add(mesh);
  }

  return group;
}
