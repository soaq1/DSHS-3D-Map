import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// threshold 를 낮추면 매스까지 번져 형태가 뭉개진다. 밝은 윤곽선만 골라
// 번지게 하는 게 목적이므로 threshold 를 올리고 strength 를 낮춘다.
export const BLOOM = {
  strength: 0.3,
  radius: 0.35,
  threshold: 0.45,
};

/**
 * 블룸 파이프라인. 이게 홀로그램 느낌의 절반이다 —
 * 네온 윤곽선이 번져야 "빛나는" 것처럼 보인다.
 */
/** 약한 기기에서 후처리 비용을 줄이는 값들.
 *  블룸은 화면 전체를 여러 번 흐리게 그리므로 해상도에 비례해 비싸진다.
 *  절반 해상도로 흐리면 비용이 1/4 이 되는데, 어차피 흐린 그림이라 티가 잘 안 난다. */
export const QUALITY = {
  full: { bloomScale: 1, samples: 4 },
  low: { bloomScale: 0.5, samples: 2 },
};

export function createComposer(renderer, scene, camera, q = QUALITY.full) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  // WebGLRenderer({antialias:true}) 의 MSAA 는 화면에 직접 그릴 때만 적용되고
  // 컴포저의 렌더타깃에는 걸리지 않는다. 직접 만들어 넘겨야 계단현상이 안 생긴다.
  // HalfFloat 은 블룸 계조가 뭉개지는 걸 막는다.
  const target = new THREE.WebGLRenderTarget(w, h, {
    samples: q.samples,
    type: THREE.HalfFloatType,
  });

  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  composer.addPass(new RenderPass(scene, camera));

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(w * q.bloomScale, h * q.bloomScale),
    BLOOM.strength,
    BLOOM.radius,
    BLOOM.threshold
  );
  composer.addPass(bloom);

  // OutputPass 는 반드시 마지막. 색공간 변환을 담당하며,
  // 빠뜨리면 화면 전체가 뜨거나 어둡게 나온다.
  composer.addPass(new OutputPass());

  return { composer, bloom, bloomScale: q.bloomScale };
}
