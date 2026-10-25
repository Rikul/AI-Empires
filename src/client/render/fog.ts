// Fog of war applied to every material via a shared uniform: the texture is swapped per
// viewport so each viewport can show omniscient or either side's knowledge.
import * as THREE from 'three';

export const fogUniforms = {
  uFogTex: { value: null as THREE.Texture | null },
  uMapSize: { value: 128 },
};

const patched = new WeakSet<THREE.Material>();

export function applyFog(mat: THREE.Material) {
  if (patched.has(mat)) return;
  patched.add(mat);
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uFogTex = fogUniforms.uFogTex;
    shader.uniforms.uMapSize = fogUniforms.uMapSize;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uMapSize;\nvarying vec2 vFogUV;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vec4 fogWP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          fogWP = instanceMatrix * fogWP;
        #endif
        fogWP = modelMatrix * fogWP;
        vFogUV = fogWP.xz / uMapSize;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uFogTex;\nvarying vec2 vFogUV;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        float fogV = texture2D(uFogTex, vFogUV).r;
        gl_FragColor.rgb *= fogV;`,
      );
  };
  mat.customProgramCacheKey = () => `fog|${mat.type}|${(prev ? prev.toString().length : 0)}`;
  mat.needsUpdate = true;
}

export function applyFogToObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    if (Array.isArray(m)) m.forEach(applyFog);
    else applyFog(m);
  });
}

export class FogTexture {
  data: Uint8Array;
  tex: THREE.DataTexture;
  constructor(public size: number, fill = 255) {
    this.data = new Uint8Array(size * size * 4).fill(fill);
    this.tex = new THREE.DataTexture(this.data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.flipY = false;
    this.tex.needsUpdate = true;
  }
  update(explored: Uint8Array, visible: Uint8Array) {
    const d = this.data;
    for (let i = 0, n = explored.length; i < n; i++) {
      const v = visible[i] ? 255 : explored[i] ? 115 : 0;
      d[i * 4] = v;
    }
    this.tex.needsUpdate = true;
  }
}
