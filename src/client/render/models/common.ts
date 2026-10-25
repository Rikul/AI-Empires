// Shared helpers for procedural low-poly models: geometry builder with baked
// vertex colors, shared materials, palette and team colors.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type Team = 0 | 1 | -1;
export type V3 = [number, number, number];

export const TEAM_COLORS: Record<0 | 1, number> = { 0: 0x2f6fe0, 1: 0xd8352a };
const GAIA_COLOR = 0xb9a27a;

export function teamColor(team: Team): number {
  return team === -1 ? GAIA_COLOR : TEAM_COLORS[team];
}
/** darker / lighter shade of the team color for trims */
export function teamShade(team: Team, f: number): number {
  const c = new THREE.Color(teamColor(team));
  if (f < 1) c.multiplyScalar(f);
  else c.lerp(new THREE.Color(0xffffff), f - 1);
  return c.getHex();
}

/** Palette */
export const P = {
  skin: 0xd9a26e,
  skinDark: 0xb07b4c,
  hair: 0x3d2817,
  beige: 0xcdb98e,
  linen: 0xe2d6b4,
  brown: 0x8a6440,
  darkBrown: 0x5a3c22,
  leather: 0x7a4e2c,
  bronze: 0xc4923e,
  iron: 0xa3a9b2,
  darkIron: 0x55595f,
  wood: 0x8b5a2b,
  darkWood: 0x5c3a1c,
  lightWood: 0xb68a52,
  straw: 0xd9c06a,
  thatch: 0xc9a456,
  thatchDark: 0x9e7c3a,
  stone: 0xa8a49a,
  stoneLight: 0xc9c4b6,
  stoneDark: 0x77736b,
  plaster: 0xe0d2ae,
  mud: 0xb88c5c,
  soil: 0x6e4a2a,
  soilDark: 0x553820,
  white: 0xf2efe6,
  black: 0x1e1a16,
  red: 0xc0281e,
  crest: 0xd01f1f,
  gold: 0xffc61a,
  green: 0x4f8a2e,
};

/** The one material used by every opaque model (colors are baked into vertices). */
export const MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
export const SMOKE_MAT = new THREE.MeshLambertMaterial({
  color: 0x8a8580, transparent: true, opacity: 0.55, depthWrite: false, flatShading: true,
});

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PartOpts {
  p?: V3;
  r?: V3;
  /** euler order, default 'XYZ' */
  o?: THREE.EulerOrder;
  s?: number | V3;
  /** random brightness variation (0..1) applied to the whole part */
  j?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
let jitterRand = rng(1234);

/** Accumulates primitive parts (each with a flat color) and merges them into one geometry. */
export class Geo {
  private parts: THREE.BufferGeometry[] = [];

  addMatrix(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, m: THREE.Matrix4, jitter = 0): this {
    const g = src.index ? src.toNonIndexed() : src.clone();
    src.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    g.applyMatrix4(m);
    _c.set(color);
    if (jitter > 0) {
      const f = 1 + (jitterRand() * 2 - 1) * jitter;
      _c.multiplyScalar(f);
    }
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = _c.r;
      arr[i * 3 + 1] = _c.g;
      arr[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    this.parts.push(g);
    return this;
  }

  add(src: THREE.BufferGeometry, color: THREE.ColorRepresentation, o: PartOpts = {}): this {
    const p = o.p ?? [0, 0, 0];
    const r = o.r ?? [0, 0, 0];
    const s = o.s ?? 1;
    _e.set(r[0], r[1], r[2], o.o ?? 'XYZ');
    _q.setFromEuler(_e);
    _p.set(p[0], p[1], p[2]);
    if (typeof s === 'number') _s.set(s, s, s);
    else _s.set(s[0], s[1], s[2]);
    _m.compose(_p, _q, _s);
    return this.addMatrix(src, color, _m, o.j ?? 0);
  }

  /** box centered at p */
  box(w: number, h: number, d: number, color: THREE.ColorRepresentation, o: PartOpts = {}): this {
    return this.add(new THREE.BoxGeometry(w, h, d), color, o);
  }

  /** cylinder (radius r / rb) of radius between two points */
  line(a: V3, b: V3, r: number, color: THREE.ColorRepresentation, seg = 5, rb?: number): this {
    const va = new THREE.Vector3(...a);
    const vb = new THREE.Vector3(...b);
    const dir = vb.clone().sub(va);
    const len = dir.length();
    dir.normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
    const mid = va.add(vb).multiplyScalar(0.5);
    const m = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    // CylinderGeometry radiusTop is at +Y (towards b)
    return this.addMatrix(new THREE.CylinderGeometry(r, rb ?? r, len, seg), color, m);
  }

  /** append another builder's parts transformed */
  merge(other: Geo, o: PartOpts = {}): this {
    const p = o.p ?? [0, 0, 0];
    const r = o.r ?? [0, 0, 0];
    const s = o.s ?? 1;
    _e.set(r[0], r[1], r[2], o.o ?? 'XYZ');
    _q.setFromEuler(_e);
    _p.set(p[0], p[1], p[2]);
    if (typeof s === 'number') _s.set(s, s, s);
    else _s.set(s[0], s[1], s[2]);
    _m.compose(_p, _q, _s);
    for (const part of other.parts) this.parts.push(part.clone().applyMatrix4(_m));
    return this;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  build(): THREE.BufferGeometry {
    if (this.parts.length === 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
      return g;
    }
    const merged = mergeGeometries(this.parts, false);
    for (const p of this.parts) p.dispose();
    this.parts = [];
    if (!merged) throw new Error('mergeGeometries failed');
    merged.computeBoundingSphere();
    merged.computeBoundingBox();
    return merged;
  }
}

export function setJitterSeed(seed: number): void {
  jitterRand = rng(seed);
}

// ---- primitive factories ----
export const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rt: number, rb: number, h: number, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg);
export const cone = (r: number, h: number, seg = 8) => new THREE.ConeGeometry(r, h, seg);
export const sph = (r: number, ws = 8, hs = 6) => new THREE.SphereGeometry(r, ws, hs);
export const hemi = (r: number, ws = 8, hs = 4) => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI / 2);
export const ico = (r: number, detail = 0) => new THREE.IcosahedronGeometry(r, detail);
export const dode = (r: number) => new THREE.DodecahedronGeometry(r, 0);
export const octa = (r: number) => new THREE.OctahedronGeometry(r, 0);

/** Triangular prism: ridge along X (length w), depth d along Z, height h; base at y=0. */
export function prism(w: number, h: number, d: number): THREE.BufferGeometry {
  const x0 = -w / 2, x1 = w / 2, z0 = -d / 2, z1 = d / 2;
  const v: number[] = [];
  const tri = (a: V3, b: V3, c: V3) => v.push(...a, ...b, ...c);
  const quad = (a: V3, b: V3, c: V3, d2: V3) => { tri(a, b, c); tri(a, c, d2); };
  // ends
  tri([x0, 0, z1], [x0, h, 0], [x0, 0, z0]);
  tri([x1, 0, z0], [x1, h, 0], [x1, 0, z1]);
  // slopes
  quad([x0, 0, z1], [x1, 0, z1], [x1, h, 0], [x0, h, 0]);
  quad([x1, 0, z0], [x0, 0, z0], [x0, h, 0], [x1, h, 0]);
  // bottom
  quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** Square pyramid with base w x d at y=0 and apex at h. */
export function pyramid(w: number, h: number, d: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);
  g.scale(w, h, d);
  return g;
}

/** Truncated square pyramid: base w x d at y=0, top scaled by k, height h. */
export function frustum(w: number, d: number, k: number, h: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(Math.SQRT1_2 * k, Math.SQRT1_2, 1, 4, 1);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);
  g.scale(w, h, d);
  return g;
}

/** Simple cache helper */
export function cached<T>(map: Map<string, T>, key: string, make: () => T): T {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material = MAT, shadow = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}
