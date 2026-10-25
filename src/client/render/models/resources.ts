// Natural resource geometries (vertex colored, for InstancedMesh with vertexColors material).
import * as THREE from 'three';
import type { Biome } from '../../../shared/rules';
import { Geo, P, box, cyl, cone, sph, ico, dode, octa, rng, setJitterSeed } from './common';

const PI = Math.PI;

function deciduous(b: Geo, r: () => number, variant: number, leaf: number, trunkC = 0x6b4526, scale = 1): void {
  const th = (0.55 + variant * 0.08) * scale;
  b.add(cyl(0.06 * scale, 0.09 * scale, th, 6), trunkC, { p: [0, th / 2, 0] });
  // branch stubs
  b.line([0, th * 0.7, 0], [0.18 * scale, th + 0.1, 0.05], 0.035 * scale, trunkC, 5);
  b.line([0, th * 0.75, 0], [-0.15 * scale, th + 0.12, -0.06], 0.03 * scale, trunkC, 5);
  const blobs = 3 + (variant % 2);
  b.add(ico(0.36 * scale, 0), leaf, { p: [0, th + 0.32 * scale, 0], r: [r(), r(), r()], j: 0.08 });
  for (let i = 0; i < blobs; i++) {
    const a = (i / blobs) * PI * 2 + r();
    const d = 0.2 * scale;
    b.add(ico((0.22 + r() * 0.08) * scale, 0), leaf, {
      p: [Math.cos(a) * d, th + (0.18 + r() * 0.3) * scale, Math.sin(a) * d],
      r: [r(), r(), r()],
      j: 0.14,
    });
  }
  b.add(ico(0.2 * scale, 0), leaf, { p: [0.03, th + 0.62 * scale, -0.02], r: [r(), r(), r()], j: 0.1 });
}

function pine(b: Geo, r: () => number, variant: number, snow: boolean, scale = 1): void {
  const green = snow ? 0x2f5a3a : 0x2e6a32;
  const th = 0.25 * scale;
  b.add(cyl(0.05 * scale, 0.07 * scale, th + 0.1, 6), 0x5a3a20, { p: [0, (th + 0.1) / 2, 0] });
  const tiers = 3 + (variant % 2);
  let y = th;
  let rad = (0.42 - variant * 0.02) * scale;
  for (let i = 0; i < tiers; i++) {
    const hh = (0.5 - i * 0.04) * scale;
    const rot = r() * PI;
    b.add(cone(rad, hh, 7), green, { p: [0, y + hh / 2, 0], r: [0, rot, 0], j: 0.08 });
    if (snow) {
      b.add(cone(rad * 0.62, hh * 0.45, 7), P.white, { p: [0, y + hh * 0.79, 0], r: [0, rot, 0] });
      b.add(cone(rad * 1.01, 0.04, 7), 0xe8eef2, { p: [0, y + 0.03, 0], r: [0, rot, 0] });
    }
    y += hh * 0.6;
    rad *= 0.74;
  }
  if (snow) b.add(cone(0.06 * scale, 0.12 * scale, 6), P.white, { p: [0, y + 0.18 * scale, 0] });
}

function palm(b: Geo, r: () => number, variant: number): void {
  const segs = 6;
  const lean = 0.25 + variant * 0.1;
  const dir = r() * PI * 2;
  let prev: [number, number, number] = [0, 0, 0];
  const total = 1.45 + variant * 0.12;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const off = lean * t * t;
    const p: [number, number, number] = [Math.cos(dir) * off, total * t, Math.sin(dir) * off];
    b.line(prev, p, 0.05 - t * 0.015, i % 2 ? 0x8a6a42 : 0x9c7a4c, 6, 0.055 - (t - 1 / segs) * 0.015);
    prev = p;
  }
  const top = prev;
  const fronds = 7;
  for (let i = 0; i < fronds; i++) {
    const a = (i / fronds) * PI * 2 + r() * 0.3;
    const len = 0.55 + r() * 0.1;
    const mid: [number, number, number] = [top[0] + Math.cos(a) * len * 0.5, top[1] + 0.1, top[2] + Math.sin(a) * len * 0.5];
    const end: [number, number, number] = [top[0] + Math.cos(a) * len, top[1] - 0.22, top[2] + Math.sin(a) * len];
    // frond = two flattened boxes
    const g1 = new THREE.Vector3(...mid).sub(new THREE.Vector3(...top));
    const g2 = new THREE.Vector3(...end).sub(new THREE.Vector3(...mid));
    const seg = (from: [number, number, number], v: THREE.Vector3, w: number, c: number) => {
      const center = new THREE.Vector3(...from).addScaledVector(v, 0.5);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), v.clone().normalize());
      const m = new THREE.Matrix4().compose(center, q, new THREE.Vector3(1, 1, 1));
      b.addMatrix(box(v.length(), 0.02, w), c, m, 0.1);
    };
    seg(top, g1, 0.17, 0x4f9a34);
    seg(mid, g2, 0.13, 0x3f8a2c);
  }
  // coconuts
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * PI * 2;
    b.add(sph(0.045, 5, 4), 0x6a4a22, { p: [top[0] + Math.cos(a) * 0.06, top[1] - 0.05, top[2] + Math.sin(a) * 0.06] });
  }
}

function scrub(b: Geo, r: () => number, variant: number): void {
  const trunk = 0x6a5038;
  b.line([0, 0, 0], [0.08, 0.3, 0.02], 0.05, trunk, 5, 0.065);
  b.line([0.08, 0.3, 0.02], [-0.05, 0.55, -0.03], 0.04, trunk, 5, 0.05);
  b.line([0.08, 0.3, 0.02], [0.25, 0.48, 0.05], 0.03, trunk, 5, 0.04);
  const leaf = variant === 1 ? 0x7a8a3a : 0x6a7e34;
  const spots: [number, number, number, number][] = [[-0.05, 0.6, -0.03, 0.22], [0.26, 0.52, 0.05, 0.17], [0.08, 0.66, 0.12, 0.15]];
  if (variant === 2) spots.push([-0.2, 0.45, 0.1, 0.14]);
  for (const [x, y, z, s] of spots) b.add(ico(s, 0), leaf, { p: [x, y, z], s: [1.2, 0.6, 1.2], r: [0, r() * 3, 0], j: 0.12 });
  // dry grass tuft at base
  for (let i = 0; i < 4; i++) {
    const a = r() * PI * 2;
    b.add(cone(0.03, 0.14, 4), 0xb0a050, { p: [Math.cos(a) * 0.15, 0.07, Math.sin(a) * 0.15], r: [r() * 0.4, 0, r() * 0.4] });
  }
}

export function createTreeGeometry(biome: Biome, variant: number): THREE.BufferGeometry {
  const v = ((Math.floor(variant) % 3) + 3) % 3;
  const r = rng(biome.length * 31 + v * 7 + 1);
  setJitterSeed(biome.length * 13 + v);
  const b = new Geo();
  switch (biome) {
    case 'TemperateGrasslands':
      deciduous(b, r, v, [0x4f9a34, 0x5aa83a, 0x478f30][v], 0x6b4526, 1.15);
      break;
    case 'DesertOasis':
      palm(b, r, v);
      break;
    case 'SnowyHighlands':
      pine(b, r, v, true, 1.05);
      break;
    case 'DenseWoodland':
      if (v === 1) pine(b, r, 0, false, 1.15);
      else deciduous(b, r, v, v === 0 ? 0x2f6e28 : 0x3c7a2a, 0x5a3a20, 1.15);
      break;
    case 'RockySteppe':
      scrub(b, r, v);
      break;
  }
  return b.build();
}

export function createTreeStumpGeometry(): THREE.BufferGeometry {
  const b = new Geo();
  b.add(cyl(0.1, 0.13, 0.14, 7), 0x6b4526, { p: [0, 0.07, 0] });
  b.add(cyl(0.085, 0.085, 0.01, 7), 0xcfa86a, { p: [0, 0.145, 0] });
  b.line([0.05, 0.02, 0.05], [0.2, 0.0, 0.14], 0.03, 0x5a3a20, 4);
  b.line([-0.06, 0.02, -0.02], [-0.2, 0.0, -0.08], 0.025, 0x5a3a20, 4);
  for (let i = 0; i < 4; i++) b.box(0.05, 0.015, 0.03, 0xcfa86a, { p: [Math.cos(i * 1.7) * 0.25, 0.01, Math.sin(i * 1.7) * 0.25], r: [0, i, 0] });
  return b.build();
}

export function createGoldMineGeometry(): THREE.BufferGeometry {
  const r = rng(99);
  setJitterSeed(5);
  const b = new Geo();
  const rocks: [number, number, number, number][] = [[0, 0.16, 0, 0.3], [0.24, 0.1, 0.12, 0.2], [-0.22, 0.1, 0.15, 0.2], [0.05, 0.08, -0.25, 0.2], [-0.15, 0.06, -0.15, 0.15]];
  for (const [x, y, z, s] of rocks) b.add(dode(s), 0x7a746a, { p: [x, y, z], r: [r() * 3, r() * 3, r() * 3], s: [1, 0.8, 1], j: 0.1 });
  const nug: [number, number, number, number][] = [[0.05, 0.36, 0.08, 0.09], [-0.12, 0.28, 0.14, 0.07], [0.2, 0.23, 0.2, 0.07], [0.12, 0.3, -0.12, 0.06], [-0.25, 0.18, 0.26, 0.06], [0.3, 0.12, 0.28, 0.05], [-0.05, 0.2, 0.3, 0.06], [-0.2, 0.25, -0.05, 0.06], [0.0, 0.43, -0.03, 0.06]];
  for (const [x, y, z, s] of nug) b.add(octa(s), r() > 0.5 ? P.gold : 0xffe25a, { p: [x, y, z], r: [r(), r(), r()] });
  return b.build();
}

export function createStoneMineGeometry(): THREE.BufferGeometry {
  const r = rng(77);
  setJitterSeed(9);
  const b = new Geo();
  const blocks: [number, number, number, number][] = [[0, 0.13, 0, 0.26], [0.25, 0.09, 0.12, 0.18], [-0.24, 0.09, 0.1, 0.2], [0.08, 0.08, -0.24, 0.18], [-0.15, 0.07, -0.2, 0.15], [0.05, 0.31, 0.02, 0.17], [0.2, 0.06, 0.32, 0.12], [-0.18, 0.06, 0.32, 0.11]];
  for (const [x, y, z, s] of blocks) {
    b.add(box(s, s * 0.8, s * 0.9), [0xc8c6be, 0xb5b2a8, 0xd8d5cc][Math.floor(r() * 3)], { p: [x, y, z], r: [(r() - 0.5) * 0.4, r() * 3, (r() - 0.5) * 0.4], j: 0.06 });
  }
  return b.build();
}

export function createBerryBushGeometry(): THREE.BufferGeometry {
  const r = rng(55);
  setJitterSeed(11);
  const b = new Geo();
  const blobs: [number, number, number, number][] = [[0, 0.22, 0, 0.26], [0.18, 0.16, 0.1, 0.18], [-0.17, 0.15, 0.08, 0.18], [0.04, 0.15, -0.18, 0.18], [-0.08, 0.3, -0.05, 0.16]];
  for (const [x, y, z, s] of blobs) b.add(ico(s, 0), 0x3e7e2e, { p: [x, y, z], r: [r(), r(), r()], j: 0.12 });
  for (let i = 0; i < 16; i++) {
    const a = r() * PI * 2;
    const el = r() * 1.2;
    const rad = 0.27;
    const p: [number, number, number] = [Math.cos(a) * Math.cos(el) * rad, 0.2 + Math.sin(el) * rad * 0.8, Math.sin(a) * Math.cos(el) * rad];
    b.add(sph(0.04, 5, 4), r() > 0.4 ? 0xd0202a : 0x7a2a8a, { p });
  }
  return b.build();
}

export function createMeatGeometry(): THREE.BufferGeometry {
  setJitterSeed(13);
  const b = new Geo();
  const coat = 0x9a6638;
  // carcass lying on its side
  b.add(sph(0.15, 8, 6), coat, { p: [0, 0.09, 0], s: [1.6, 0.62, 0.95], r: [0, 0.3, 0] });
  b.add(sph(0.1, 7, 5), 0xd8c09a, { p: [0.02, 0.06, 0.07], s: [1.6, 0.5, 0.8], r: [0, 0.3, 0] });
  // head and neck
  b.box(0.1, 0.08, 0.16, coat, { p: [0.27, 0.05, 0.13], r: [0, 0.9, 0] });
  b.box(0.05, 0.04, 0.05, 0x2a1a10, { p: [0.34, 0.05, 0.2], r: [0, 0.9, 0] });
  // legs splayed on the ground
  for (const [x, z, a] of [[-0.14, 0.08, 0.2], [-0.08, 0.12, -0.1], [0.1, 0.12, 0.3], [0.15, 0.06, 0.5]] as [number, number, number][]) {
    b.line([x, 0.05, z], [x + Math.sin(a) * 0.22, 0.025, z + Math.cos(a) * 0.22], 0.02, 0x7a5030, 4);
  }
  // butchered: exposed meat with ribs
  b.add(sph(0.08, 7, 5), 0xc23c3c, { p: [-0.03, 0.15, -0.03], s: [1.5, 0.5, 1], r: [0, 0.3, 0] });
  for (let i = 0; i < 4; i++) {
    const x = -0.1 + i * 0.05;
    b.line([x, 0.14, -0.08 + i * 0.015], [x + 0.01, 0.2, -0.01 + i * 0.015], 0.01, P.white, 4);
  }
  // meat chunks beside it
  b.add(sph(0.055, 6, 4), 0xc84848, { p: [-0.28, 0.035, 0.18], s: [1.2, 0.6, 1] });
  b.add(sph(0.05, 6, 4), 0xd05858, { p: [-0.22, 0.03, -0.22], s: [1.3, 0.6, 1] });
  b.line([-0.3, 0.03, 0.12], [-0.24, 0.03, 0.26], 0.012, P.white, 4);
  return b.build();
}
