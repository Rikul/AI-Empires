// Procedural low-poly building models.
import * as THREE from 'three';
import type { BuildingType } from '../../../shared/rules';
import { BUILDINGS } from '../../../shared/rules';
import {
  Geo, P, MAT, SMOKE_MAT, Team, V3, teamColor, teamShade, box, cyl, cone, sph, ico, dode, octa, prism, pyramid, frustum,
  cached, mesh, rng, setJitterSeed,
} from './common';

export interface BuildingModel {
  root: THREE.Group;
  setConstruction(progress: number, built: boolean): void;
  setFarmFraction(f: number): void;
  animate(time: number): void;
  dispose(): void;
}

const PI = Math.PI;

interface FlagSpec {
  pos: V3;
  w: number;
  h: number;
  rotY?: number;
}
interface BDef {
  main: THREE.BufferGeometry;
  flags: FlagSpec[];
  height: number;
  crops?: THREE.BufferGeometry;
  smoke?: V3;
}

const defCache = new Map<string, BDef>();
const geoCache = new Map<string, THREE.BufferGeometry>();

// ---------------------------------------------------------------------------
// reusable bits
// ---------------------------------------------------------------------------

function pole(b: Geo, x: number, z: number, y0: number, y1: number, r = 0.022, color = P.darkWood): void {
  b.add(cyl(r, r * 1.2, y1 - y0, 5), color, { p: [x, (y0 + y1) / 2, z] });
  b.add(sph(r * 1.6, 5, 4), P.gold, { p: [x, y1 + r, z] });
}
/** vertical hanging banner on a wall face. normal: direction the face points (+Z default) */
function banner(b: Geo, tc: number, p: V3, w: number, hgt: number, rotY = 0): void {
  b.box(w + 0.06, 0.035, 0.035, P.darkWood, { p: [p[0], p[1] + hgt / 2 + 0.02, p[2]], r: [0, rotY, 0] });
  b.box(w, hgt, 0.02, tc, { p, r: [0, rotY, 0] });
  // pointed bottom
  b.add(prism(w, 0.1, 0.02), tc, { p: [p[0], p[1] - hgt / 2, p[2]], r: [PI, rotY, 0], o: 'YXZ' });
  b.box(w * 0.5, w * 0.5, 0.025, P.gold, { p: [p[0], p[1] + hgt * 0.15, p[2]], r: [0, rotY, PI / 4], o: 'YXZ' });
}
/** ring of 4 thin boxes around a rectangle at height y */
function trimRing(b: Geo, w: number, d: number, y: number, color: number, t = 0.06, hgt = 0.06): void {
  b.box(w + t, hgt, t, color, { p: [0, y, d / 2] });
  b.box(w + t, hgt, t, color, { p: [0, y, -d / 2] });
  b.box(t, hgt, d, color, { p: [w / 2, y, 0] });
  b.box(t, hgt, d, color, { p: [-w / 2, y, 0] });
}
function gableRoof(b: Geo, w: number, hgt: number, d: number, y: number, color: number, tc: number, opts: { x?: number; z?: number; rotY?: number } = {}): void {
  const x = opts.x ?? 0, z = opts.z ?? 0, ry = opts.rotY ?? 0;
  const g = new Geo();
  g.add(prism(w, hgt, d), color, { p: [0, 0, 0] });
  // darker layering band halfway up each slope
  const c2 = new THREE.Color(color).multiplyScalar(0.82).getHex();
  const slopeA = Math.atan2(hgt, d / 2);
  g.box(w + 0.02, 0.03, 0.08, c2, { p: [0, hgt * 0.5 + 0.015, d / 4 + 0.01], r: [slopeA, 0, 0] });
  g.box(w + 0.02, 0.03, 0.08, c2, { p: [0, hgt * 0.5 + 0.015, -d / 4 - 0.01], r: [-slopeA, 0, 0] });
  // team eaves + ridge
  const slope = Math.atan2(hgt, d / 2);
  g.box(w + 0.04, 0.05, 0.12, tc, { p: [0, 0.02, d / 2 - 0.04], r: [slope, 0, 0] });
  g.box(w + 0.04, 0.05, 0.12, tc, { p: [0, 0.02, -d / 2 + 0.04], r: [-slope, 0, 0] });
  g.box(w + 0.06, 0.07, 0.1, tc, { p: [0, hgt + 0.01, 0] });
  b.merge(g, { p: [x, y, z], r: [0, ry, 0] });
}
function stoneCourses(b: Geo, w: number, d: number, y0: number, y1: number, color: number, step = 0.18): void {
  for (let y = y0 + step; y < y1 - 0.02; y += step) trimRing(b, w, d, y, color, 0.012, 0.018);
}
function hayBale(b: Geo, p: V3, rotY = 0): void {
  b.box(0.3, 0.18, 0.2, P.straw, { p, r: [0, rotY, 0], j: 0.08 });
  b.box(0.31, 0.02, 0.21, 0xb09040, { p: [p[0], p[1] + 0.04, p[2]], r: [0, rotY, 0] });
  b.box(0.31, 0.02, 0.21, 0xb09040, { p: [p[0], p[1] - 0.04, p[2]], r: [0, rotY, 0] });
}
function crate(b: Geo, p: V3, s = 0.2, rotY = 0): void {
  b.box(s, s, s, P.lightWood, { p, r: [0, rotY, 0], j: 0.1 });
  b.box(s * 1.02, s * 0.15, s * 1.02, P.darkWood, { p: [p[0], p[1] + s * 0.42, p[2]], r: [0, rotY, 0] });
  b.box(s * 1.02, s * 0.15, s * 1.02, P.darkWood, { p: [p[0], p[1] - s * 0.42, p[2]], r: [0, rotY, 0] });
}
function logPile(b: Geo, p: V3, len = 0.6, rotY = 0): void {
  const g = new Geo();
  const rows = [4, 3, 2];
  rows.forEach((n, row) => {
    for (let i = 0; i < n; i++) {
      const x = (i - (n - 1) / 2) * 0.11;
      const y = 0.05 + row * 0.09;
      g.add(cyl(0.05, 0.05, len, 6), P.wood, { p: [x, y, 0], r: [PI / 2, 0, 0], j: 0.12 });
      g.add(cyl(0.04, 0.04, len + 0.01, 6), P.lightWood, { p: [x, y, 0], r: [PI / 2, 0, 0] });
    }
  });
  b.merge(g, { p, r: [0, rotY, 0] });
}
function fenceLine(b: Geo, a: [number, number], c: [number, number], hgt = 0.28, spacing = 0.35, color = P.wood): void {
  const dx = c[0] - a[0], dz = c[1] - a[1];
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.round(len / spacing));
  for (let i = 0; i <= n; i++) {
    const x = a[0] + (dx * i) / n, z = a[1] + (dz * i) / n;
    b.box(0.045, hgt, 0.045, P.darkWood, { p: [x, hgt / 2, z] });
  }
  b.line([a[0], hgt * 0.75, a[1]], [c[0], hgt * 0.75, c[1]], 0.016, color, 4);
  b.line([a[0], hgt * 0.4, a[1]], [c[0], hgt * 0.4, c[1]], 0.016, color, 4);
}
function target(b: Geo, p: V3): void {
  const tilt = -0.25;
  // stand
  b.line([p[0] - 0.18, 0, p[2] - 0.12], [p[0] - 0.1, 0.55, p[2]], 0.02, P.darkWood, 4);
  b.line([p[0] + 0.18, 0, p[2] - 0.12], [p[0] + 0.1, 0.55, p[2]], 0.02, P.darkWood, 4);
  b.line([p[0], 0, p[2] - 0.25], [p[0], 0.5, p[2] - 0.02], 0.02, P.darkWood, 4);
  const rings: [number, number][] = [[0.3, P.straw], [0.26, P.white], [0.2, P.red], [0.13, P.white], [0.065, P.red]];
  rings.forEach(([r, c], i) => {
    b.add(cyl(r, r, 0.05, 14), c, { p: [p[0], 0.5 + i * 0.006 * Math.sin(-tilt), p[2] + 0.02 + i * 0.008], r: [PI / 2 + tilt, 0, 0] });
  });
}

// ---------------------------------------------------------------------------
// building definitions
// ---------------------------------------------------------------------------
function buildDef(type: BuildingType, team: Team): BDef {
  const tc = teamColor(team);
  const tDark = teamShade(team, 0.75);
  const b = new Geo();
  const flags: FlagSpec[] = [];
  let height = 1;
  let crops: THREE.BufferGeometry | undefined;
  let smoke: V3 | undefined;
  setJitterSeed(type.length * 97 + 13);

  switch (type) {
    case 'TownCenter': {
      height = 2.45;
      // raised platform with steps
      b.box(2.66, 0.22, 2.5, P.stone, { p: [0, 0.11, -0.05] });
      b.box(2.7, 0.05, 2.54, P.stoneDark, { p: [0, 0.02, -0.05] });
      b.box(1.0, 0.11, 0.18, P.stoneLight, { p: [0, 0.055, 1.28] });
      b.box(1.0, 0.06, 0.12, P.stoneLight, { p: [0, 0.16, 1.24] });
      // main hall
      b.box(2.0, 0.78, 1.6, P.plaster, { p: [0, 0.61, -0.2] });
      b.box(2.04, 0.14, 1.64, P.stoneDark, { p: [0, 0.29, -0.2] });
      b.box(0.36, 0.5, 0.05, P.darkWood, { p: [0, 0.47, 0.61] }); // door
      for (const x of [-0.65, 0.65]) b.box(0.18, 0.18, 0.04, 0x3a2a1a, { p: [x, 0.7, 0.61] });
      // portico columns + architrave
      for (const x of [-0.85, -0.3, 0.3, 0.85]) {
        b.add(cyl(0.065, 0.075, 0.76, 7), P.white, { p: [x, 0.6, 0.98] });
        b.box(0.17, 0.05, 0.17, P.stoneLight, { p: [x, 0.25, 0.98] });
        b.box(0.17, 0.05, 0.17, P.stoneLight, { p: [x, 0.99, 0.98] });
      }
      b.box(2.1, 0.12, 0.5, P.stoneLight, { p: [0, 1.06, 0.8] });
      b.box(2.12, 0.05, 0.52, tc, { p: [0, 1.0, 0.8] });
      // main roof (truncated hip)
      b.add(frustum(2.45, 2.1, 0.5, 0.42), 0x8a5a34, { p: [0, 1.0, -0.12] });
      trimRing(b, 2.45, 2.1, 1.02, tc, 0.08, 0.08);
      // upper storey
      b.box(1.0, 0.6, 0.9, P.plaster, { p: [0, 1.6, -0.2] });
      b.box(1.04, 0.08, 0.94, P.stoneDark, { p: [0, 1.34, -0.2] });
      for (const x of [-0.25, 0.25]) b.box(0.14, 0.2, 0.04, 0x3a2a1a, { p: [x, 1.6, 0.26] });
      trimRing(b, 1.0, 0.9, 1.9, tc, 0.07, 0.08);
      b.add(pyramid(1.3, 0.55, 1.2), 0x7a4c2a, { p: [0, 1.92, -0.2] });
      pole(b, 0, -0.2, 2.35, 3.1, 0.025);
      flags.push({ pos: [0, 3.03, -0.2], w: 0.55, h: 0.32 });
      // front banners on hall
      banner(b, tc, [-0.98, 0.74, 0.61], 0.2, 0.42);
      banner(b, tc, [0.98, 0.74, 0.61], 0.2, 0.42);
      // side banners
      banner(b, tc, [1.015, 0.7, -0.2], 0.24, 0.45, PI / 2);
      banner(b, tc, [-1.015, 0.7, -0.2], 0.24, 0.45, -PI / 2);
      // corner pennant poles
      for (const [x, z] of [[-1.25, -1.2], [1.25, -1.2], [-1.25, 1.1], [1.25, 1.1]] as [number, number][]) {
        pole(b, x, z, 0.22, 1.25, 0.018);
        flags.push({ pos: [x, 1.2, z], w: 0.3, h: 0.18 });
      }
      // braziers by stairs
      for (const x of [-0.65, 0.65]) {
        b.add(cyl(0.07, 0.05, 0.12, 6), P.bronze, { p: [x, 0.28, 1.18] });
        b.add(cone(0.05, 0.1, 5), 0xff9a2a, { p: [x, 0.38, 1.18] });
      }
      break;
    }
    case 'House': {
      height = 1.3;
      b.box(1.45, 0.06, 1.55, P.stoneDark, { p: [0, 0.03, 0] });
      b.box(1.05, 0.56, 1.25, 0xe6d6ae, { p: [0, 0.34, 0] });
      b.box(1.08, 0.1, 1.28, P.stone, { p: [0, 0.1, 0] });
      for (const [x, z] of [[-0.52, 0.62], [0.52, 0.62], [-0.52, -0.62], [0.52, -0.62]] as [number, number][]) b.box(0.08, 0.6, 0.08, P.darkWood, { p: [x, 0.33, z] });
      b.box(1.08, 0.06, 1.28, P.darkWood, { p: [0, 0.62, 0] });
      // gable end walls (plaster triangles) + door on the front gable
      b.add(prism(0.03, 0.5, 1.12), 0xe6d6ae, { p: [0, 0.66, 0.705], r: [0, PI / 2, 0] });
      b.add(prism(0.03, 0.5, 1.12), 0xe6d6ae, { p: [0, 0.66, -0.705], r: [0, PI / 2, 0] });
      b.line([-0.52, 0.68, 0.725], [0, 1.15, 0.725], 0.025, P.darkWood, 4);
      b.line([0.52, 0.68, 0.725], [0, 1.15, 0.725], 0.025, P.darkWood, 4);
      b.box(0.28, 0.42, 0.04, P.darkWood, { p: [0, 0.27, 0.635] });
      b.box(0.34, 0.05, 0.06, P.wood, { p: [0, 0.5, 0.64] });
      b.box(0.14, 0.14, 0.04, 0x3a2a1a, { p: [0, 0.82, 0.72] }); // loft window
      b.box(0.04, 0.16, 0.2, 0x3a2a1a, { p: [0.53, 0.4, 0.15] }); // side window
      // awning over door in team color
      b.box(0.5, 0.03, 0.24, tc, { p: [0, 0.56, 0.74], r: [0.4, 0, 0] });
      gableRoof(b, 1.38, 0.62, 1.4, 0.64, P.thatch, tc, { rotY: PI / 2 });
      // chimney
      b.box(0.18, 0.55, 0.18, P.stone, { p: [-0.3, 1.05, -0.3] });
      b.box(0.22, 0.05, 0.22, P.stoneDark, { p: [-0.3, 1.34, -0.3] });
      // woodpile + pot
      logPile(b, [0.7, 0, -0.2], 0.45, 0);
      b.add(cyl(0.08, 0.06, 0.16, 7), 0xa0603a, { p: [-0.45, 0.08, 0.72] });
      break;
    }
    case 'Granary': {
      height = 1.35;
      b.box(1.65, 0.12, 1.65, P.lightWood, { p: [0, 0.06, 0] });
      for (let i = 0; i < 6; i++) b.box(1.66, 0.012, 0.02, P.darkWood, { p: [0, 0.121, -0.7 + i * 0.28] });
      const silos: [number, number, number, number][] = [[-0.32, -0.25, 0.42, 0.78], [0.42, 0.15, 0.32, 0.6]];
      for (const [x, z, r, hgt] of silos) {
        b.add(cyl(r, r * 1.05, hgt, 12), 0xd4b07a, { p: [x, 0.12 + hgt / 2, z] });
        b.add(cyl(r * 1.07, r * 1.07, 0.12, 12), tc, { p: [x, 0.12 + hgt * 0.62, z] });
        b.add(cyl(r * 1.06, r * 1.06, 0.03, 12), P.darkWood, { p: [x, 0.12 + hgt * 0.35, z] });
        b.add(cone(r * 1.22, r * 1.1, 12), P.thatch, { p: [x, 0.12 + hgt + r * 0.55, z] });
        b.add(cone(r * 0.6, r * 0.45, 12), P.thatchDark, { p: [x, 0.12 + hgt + r * 1.0, z] });
        b.box(0.16, 0.24, 0.04, P.darkWood, { p: [x + 0.0, 0.26, z + r * 1.02] });
      }
      pole(b, -0.32, -0.25, 1.3, 1.65, 0.02);
      flags.push({ pos: [-0.32, 1.6, -0.25], w: 0.32, h: 0.2 });
      // grain baskets
      for (const [x, z] of [[-0.45, 0.55], [-0.2, 0.62], [0.3, 0.65]] as [number, number][]) {
        b.add(cyl(0.1, 0.08, 0.14, 8), P.straw, { p: [x, 0.19, z], j: 0.1 });
        b.add(sph(0.085, 7, 4), 0xe8c840, { p: [x, 0.26, z], s: [1, 0.5, 1] });
      }
      b.add(cyl(0.1, 0.08, 0.14, 8), P.straw, { p: [0.68, 0.19, -0.55] });
      break;
    }
    case 'StoragePit': {
      height = 1.0;
      b.box(1.65, 0.04, 1.6, P.soilDark, { p: [0, 0.02, 0] });
      // lean-to shed at the back
      for (const x of [-0.75, 0, 0.75]) {
        b.box(0.07, 0.62, 0.07, P.darkWood, { p: [x, 0.31, -0.72] });
        b.box(0.07, 0.86, 0.07, P.darkWood, { p: [x, 0.43, -0.05] });
      }
      const slope = Math.atan2(0.24, 0.67);
      b.box(1.72, 0.05, 0.86, P.thatch, { p: [0, 0.76, -0.38], r: [-slope, 0, 0] });
      b.box(1.74, 0.07, 0.08, tc, { p: [0, 0.88, 0.03], r: [-slope, 0, 0] });
      b.box(0.08, 0.06, 0.86, tc, { p: [0.86, 0.76, -0.38], r: [-slope, 0, 0] });
      b.box(0.08, 0.06, 0.86, tc, { p: [-0.86, 0.76, -0.38], r: [-slope, 0, 0] });
      b.box(1.6, 0.5, 0.05, P.lightWood, { p: [0, 0.25, -0.75] }); // back planks
      logPile(b, [-0.35, 0.04, -0.4], 0.6, PI / 2);
      logPile(b, [0.35, 0.04, -0.4], 0.6, PI / 2);
      // open yard: crates, stone heap, gold basket
      crate(b, [-0.55, 0.13, 0.25], 0.22, 0.2);
      crate(b, [-0.3, 0.12, 0.45], 0.2, -0.3);
      crate(b, [-0.5, 0.33, 0.28], 0.18, 0.6);
      const r = rng(7);
      for (let i = 0; i < 9; i++) {
        b.add(box(0.15, 0.11, 0.14), P.stoneLight, { p: [0.45 + (r() - 0.5) * 0.4, 0.07 + (i > 5 ? 0.1 : 0), 0.4 + (r() - 0.5) * 0.35], r: [r() * 0.4, r() * 3, r() * 0.4], j: 0.12 });
      }
      b.add(cyl(0.13, 0.11, 0.12, 8), P.straw, { p: [0.05, 0.07, 0.55] });
      for (let i = 0; i < 5; i++) b.add(octa(0.055), P.gold, { p: [0.05 + (r() - 0.5) * 0.14, 0.15, 0.55 + (r() - 0.5) * 0.14], r: [r(), r(), r()] });
      pole(b, -0.78, 0.72, 0.0, 1.3, 0.022);
      flags.push({ pos: [-0.78, 1.25, 0.72], w: 0.34, h: 0.22 });
      break;
    }
    case 'Farm': {
      height = 0.3;
      b.box(2.75, 0.05, 2.75, P.soil, { p: [0, 0.025, 0] });
      const rows = 7;
      for (let i = 0; i < rows; i++) {
        const x = -1.08 + (i * 2.16) / (rows - 1);
        b.box(0.2, 0.035, 2.45, 0x7f5a34, { p: [x, 0.06, 0] });
      }
      fenceLine(b, [-1.35, -1.35], [1.35, -1.35], 0.22, 0.45);
      fenceLine(b, [-1.35, -1.35], [-1.35, 1.35], 0.22, 0.45);
      fenceLine(b, [1.35, -1.35], [1.35, 1.35], 0.22, 0.45);
      fenceLine(b, [-1.35, 1.35], [-0.35, 1.35], 0.22, 0.45);
      fenceLine(b, [0.35, 1.35], [1.35, 1.35], 0.22, 0.45);
      // marker post
      pole(b, 1.32, 1.32, 0, 0.75, 0.025);
      flags.push({ pos: [1.32, 0.72, 1.32], w: 0.3, h: 0.2, rotY: PI });
      // crops (separate, scaled)
      crops = cached(geoCache, 'farm:crops', () => {
        const c = new Geo();
        const r = rng(42);
        for (let i = 0; i < rows; i++) {
          const x = -1.08 + (i * 2.16) / (rows - 1);
          for (let k = 0; k < 10; k++) {
            const z = -1.1 + k * 0.245 + (r() - 0.5) * 0.04;
            const hh = 0.3 + r() * 0.08;
            c.add(cone(0.07, hh, 5), 0x8fae3a, { p: [x + (r() - 0.5) * 0.04, hh / 2, z], j: 0.1 });
            c.add(cone(0.055, 0.14, 5), 0xe2c049, { p: [x + (r() - 0.5) * 0.04, hh + 0.02, z], j: 0.1 });
          }
        }
        return c.build();
      });
      break;
    }
    case 'Barracks': {
      height = 1.45;
      b.box(2.7, 0.04, 2.6, 0x9a8460, { p: [0, 0.02, 0] }); // yard
      // hall
      b.box(2.3, 0.3, 1.15, P.stone, { p: [0, 0.15, -0.55] });
      stoneCourses(b, 2.3, 1.15, 0, 0.3, P.stoneDark, 0.1);
      b.box(2.25, 0.5, 1.1, 0xb48a5a, { p: [0, 0.55, -0.55] });
      for (let i = 0; i < 6; i++) b.box(0.06, 0.5, 1.12, P.darkWood, { p: [-1.1 + i * 0.44, 0.55, -0.55] });
      b.box(2.28, 0.06, 1.13, P.darkWood, { p: [0, 0.8, -0.55] });
      b.box(0.42, 0.55, 0.05, P.darkWood, { p: [0, 0.3, 0.03] }); // door
      b.box(0.5, 0.06, 0.07, P.wood, { p: [0, 0.6, 0.04] });
      gableRoof(b, 2.55, 0.62, 1.42, 0.8, 0x8a6a3c, tc, { z: -0.55 });
      // front porch with cross gable over the door
      b.box(0.06, 0.78, 0.06, P.darkWood, { p: [-0.36, 0.39, 0.32] });
      b.box(0.06, 0.78, 0.06, P.darkWood, { p: [0.36, 0.39, 0.32] });
      gableRoof(b, 0.75, 0.5, 0.95, 0.78, 0x7a5c32, tc, { z: 0.02, rotY: PI / 2 });
      b.add(prism(0.03, 0.46, 0.8), tc, { p: [0, 0.8, 0.36], r: [0, PI / 2, 0] });
      banner(b, tc, [-0.55, 0.5, 0.04], 0.24, 0.5);
      banner(b, tc, [0.55, 0.5, 0.04], 0.24, 0.5);
      pole(b, 1.15, -0.55, 1.0, 1.85, 0.022);
      flags.push({ pos: [1.15, 1.8, -0.55], w: 0.42, h: 0.26 });
      // weapon rack
      b.box(0.04, 0.45, 0.04, P.darkWood, { p: [-1.15, 0.225, 0.55] });
      b.box(0.04, 0.45, 0.04, P.darkWood, { p: [-0.55, 0.225, 0.55] });
      b.box(0.66, 0.04, 0.05, P.darkWood, { p: [-0.85, 0.42, 0.55] });
      for (let i = 0; i < 5; i++) {
        const x = -1.1 + i * 0.12;
        b.line([x, 0, 0.62], [x + 0.02, 0.85, 0.5], 0.012, P.wood, 4);
        b.add(cone(0.024, 0.09, 4), P.iron, { p: [x + 0.022, 0.89, 0.495], r: [-0.14, 0, 0] });
      }
      for (const x of [-1.0, -0.7]) {
        b.add(cyl(0.12, 0.12, 0.03, 10), tc, { p: [x, 0.25, 0.64], r: [PI / 2 - 0.15, 0, 0] });
        b.add(sph(0.03, 5, 4), P.bronze, { p: [x, 0.25, 0.66] });
      }
      // training dummy
      const dx = 0.75, dz = 0.65;
      b.box(0.05, 0.6, 0.05, P.darkWood, { p: [dx, 0.3, dz] });
      b.box(0.45, 0.045, 0.045, P.darkWood, { p: [dx, 0.48, dz] });
      b.add(cyl(0.09, 0.1, 0.25, 7), P.straw, { p: [dx, 0.4, dz] });
      b.add(sph(0.075, 6, 5), P.straw, { p: [dx, 0.63, dz] });
      b.box(0.2, 0.02, 0.02, 0x9e7c3a, { p: [dx, 0.47, dz + 0.09] });
      // shields on wall
      b.add(cyl(0.1, 0.1, 0.03, 10), tDark, { p: [-0.95, 0.55, 0.0], r: [PI / 2, 0, 0] });
      b.add(cyl(0.1, 0.1, 0.03, 10), tDark, { p: [0.95, 0.55, 0.0], r: [PI / 2, 0, 0] });
      break;
    }
    case 'ArcheryRange': {
      height = 1.2;
      b.box(2.7, 0.04, 2.6, 0x9a9a60, { p: [0, 0.02, 0] });
      // back wall
      b.box(2.4, 0.75, 0.16, P.lightWood, { p: [0, 0.375, -1.05] });
      for (let i = 0; i < 9; i++) b.box(0.03, 0.75, 0.17, P.darkWood, { p: [-1.2 + i * 0.3, 0.375, -1.05] });
      // side walls
      b.box(0.14, 0.62, 0.7, P.lightWood, { p: [-1.18, 0.31, -0.75] });
      b.box(0.14, 0.62, 0.7, P.lightWood, { p: [1.18, 0.31, -0.75] });
      // posts
      for (const x of [-1.18, -0.4, 0.4, 1.18]) b.box(0.07, 0.68, 0.07, P.darkWood, { p: [x, 0.34, -0.38] });
      const slope = Math.atan2(0.25, 0.85);
      b.box(2.55, 0.05, 0.95, 0x8a6a3c, { p: [0, 0.8, -0.72], r: [slope, 0, 0] });
      b.box(2.57, 0.08, 0.08, tc, { p: [0, 0.68, -0.27], r: [slope, 0, 0] });
      b.box(2.57, 0.07, 0.08, tc, { p: [0, 0.93, -1.15], r: [slope, 0, 0] });
      // pennant strip along front
      for (let i = 0; i < 8; i++) b.add(cone(0.05, 0.12, 3), i % 2 ? tc : P.white, { p: [-1.1 + i * 0.31, 0.6, -0.28], r: [PI, 0, 0] });
      // targets out front
      target(b, [-0.8, 0, 0.75]);
      target(b, [0.0, 0, 0.95]);
      target(b, [0.8, 0, 0.75]);
      // arrows in target
      b.line([0.03, 0.52, 1.0], [0.08, 0.6, 1.3], 0.008, P.lightWood, 3);
      b.line([-0.82, 0.5, 0.8], [-0.86, 0.54, 1.1], 0.008, P.lightWood, 3);
      // hay bale + bundle of arrows
      hayBale(b, [-0.75, 0.13, -0.6]);
      b.add(cyl(0.05, 0.05, 0.3, 6), P.leather, { p: [0.75, 0.15, -0.65] });
      for (let i = 0; i < 4; i++) b.line([0.72 + i * 0.02, 0.15, -0.65], [0.7 + i * 0.03, 0.42, -0.66], 0.006, P.white, 3);
      pole(b, -1.25, 1.15, 0, 1.25, 0.02);
      flags.push({ pos: [-1.25, 1.2, 1.15], w: 0.36, h: 0.22 });
      break;
    }
    case 'Stable': {
      height = 1.4;
      b.box(2.7, 0.04, 2.6, 0x9e8a5a, { p: [0, 0.02, 0] });
      const bx = -0.45, bz = -0.35;
      b.box(1.65, 0.8, 1.6, 0x9a6a3a, { p: [bx, 0.4, bz] });
      for (let i = 0; i < 7; i++) b.box(1.67, 0.02, 1.62, P.darkWood, { p: [bx, 0.1 + i * 0.11, bz] });
      // big door
      b.box(0.6, 0.6, 0.04, P.darkWood, { p: [bx, 0.3, bz + 0.81] });
      b.line([bx - 0.28, 0.02, bz + 0.835], [bx + 0.28, 0.58, bz + 0.835], 0.018, P.lightWood, 4);
      b.line([bx + 0.28, 0.02, bz + 0.835], [bx - 0.28, 0.58, bz + 0.835], 0.018, P.lightWood, 4);
      // roof: ridge along Z
      gableRoof(b, 1.85, 0.6, 1.8, 0.8, 0x8a6a3c, tc, { x: bx, z: bz, rotY: PI / 2 });
      // gable front
      b.add(prism(0.04, 0.58, 1.66), 0x9a6a3a, { p: [bx, 0.8, bz + 0.79], r: [0, PI / 2, 0] });
      // horse-head sign above door
      const sy = 0.98, sz = bz + 0.84;
      b.box(0.3, 0.26, 0.03, P.lightWood, { p: [bx, sy, sz] });
      b.box(0.08, 0.16, 0.03, 0x5a3a20, { p: [bx - 0.02, sy - 0.02, sz + 0.02], r: [0, 0, 0.35] });
      b.box(0.14, 0.06, 0.03, 0x5a3a20, { p: [bx + 0.04, sy + 0.05, sz + 0.02], r: [0, 0, -0.5] });
      b.box(0.02, 0.05, 0.03, 0x5a3a20, { p: [bx - 0.01, sy + 0.1, sz + 0.02] });
      banner(b, tc, [bx - 0.5, 0.5, bz + 0.83], 0.18, 0.38);
      banner(b, tc, [bx + 0.5, 0.5, bz + 0.83], 0.18, 0.38);
      // paddock
      const px0 = 0.45, px1 = 1.3, pz0 = -1.25, pz1 = 1.25;
      fenceLine(b, [px0, pz0], [px1, pz0], 0.32, 0.4, P.lightWood);
      fenceLine(b, [px1, pz0], [px1, pz1], 0.32, 0.4, P.lightWood);
      fenceLine(b, [px0, pz1], [px1, pz1], 0.32, 0.4, P.lightWood);
      fenceLine(b, [px0, 0.55], [px0, pz1], 0.32, 0.4, P.lightWood);
      // trough
      b.box(0.5, 0.15, 0.18, P.darkWood, { p: [0.9, 0.08, -0.9] });
      b.box(0.44, 0.02, 0.13, 0x4a8ac8, { p: [0.9, 0.155, -0.9] });
      hayBale(b, [0.85, 0.1, 0.2], 0.3);
      hayBale(b, [0.9, 0.1, 0.65], -0.2);
      hayBale(b, [0.88, 0.28, 0.42], 0.1);
      hayBale(b, [-1.0, 0.1, 0.85], 0.1);
      pole(b, bx, bz - 0.7, 1.1, 1.75, 0.02);
      flags.push({ pos: [bx, 1.7, bz - 0.7], w: 0.36, h: 0.22 });
      break;
    }
    case 'Blacksmith': {
      height = 1.3;
      b.box(1.7, 0.04, 1.7, 0x6a6258, { p: [0, 0.02, 0] });
      const wx = -0.1, wz = -0.2;
      b.box(1.35, 0.7, 1.1, P.stoneDark, { p: [wx, 0.35, wz] });
      stoneCourses(b, 1.35, 1.1, 0, 0.7, 0x5a5650, 0.14);
      // forge opening with glow
      b.box(0.42, 0.34, 0.04, 0x2a2420, { p: [wx - 0.2, 0.25, wz + 0.55] });
      b.box(0.3, 0.16, 0.05, 0xff7a1a, { p: [wx - 0.2, 0.16, wz + 0.555] });
      // awning (team)
      b.box(0.75, 0.04, 0.35, tc, { p: [wx - 0.2, 0.6, wz + 0.7], r: [0.3, 0, 0] });
      b.box(0.04, 0.55, 0.04, P.darkWood, { p: [wx - 0.55, 0.28, wz + 0.85] });
      b.box(0.04, 0.55, 0.04, P.darkWood, { p: [wx + 0.15, 0.28, wz + 0.85] });
      // roof
      b.add(pyramid(1.55, 0.35, 1.3), 0x4a4440, { p: [wx, 0.7, wz] });
      trimRing(b, 1.5, 1.25, 0.72, tc, 0.07, 0.07);
      // chimney
      b.box(0.3, 1.0, 0.3, P.stone, { p: [0.38, 0.95, -0.5] });
      b.box(0.36, 0.06, 0.36, P.stoneDark, { p: [0.38, 1.46, -0.5] });
      smoke = [0.38, 1.5, -0.5];
      banner(b, tc, [wx + 0.38, 0.42, wz + 0.56], 0.18, 0.36);
      // anvil on stump
      const ax = 0.5, az = 0.55;
      b.add(cyl(0.1, 0.11, 0.16, 7), P.wood, { p: [ax, 0.08, az] });
      b.box(0.12, 0.08, 0.1, P.darkIron, { p: [ax, 0.2, az] });
      b.box(0.24, 0.07, 0.12, P.darkIron, { p: [ax, 0.27, az] });
      b.add(cone(0.05, 0.1, 4), P.darkIron, { p: [ax + 0.16, 0.27, az], r: [0, 0, -PI / 2] });
      // tools / bars
      b.box(0.04, 0.03, 0.25, P.iron, { p: [ax - 0.25, 0.06, az + 0.1], r: [0, 0.4, 0] });
      b.add(cyl(0.12, 0.1, 0.14, 8), P.darkWood, { p: [-0.55, 0.07, 0.55] }); // quench barrel
      b.add(cyl(0.1, 0.1, 0.01, 8), 0x3a6aa8, { p: [-0.55, 0.14, 0.55] });
      break;
    }
    case 'WatchTower': {
      height = 2.55;
      b.box(0.86, 0.18, 0.86, P.stoneDark, { p: [0, 0.09, 0] });
      b.add(cyl(0.34 * Math.SQRT2 / 1.0 * 0.85, 0.4 * Math.SQRT2 * 0.92, 1.95, 4), P.stone, { p: [0, 0.18 + 0.975, 0], r: [0, PI / 4, 0] });
      // stone course bands
      for (const y of [0.6, 1.1, 1.6]) {
        const w = 0.73 - (y - 0.18) * 0.07;
        trimRing(b, w, w, y, P.stoneDark, 0.02, 0.025);
      }
      // arrow slits
      b.box(0.05, 0.18, 0.02, 0x2a2420, { p: [0, 1.35, 0.3] });
      b.box(0.02, 0.18, 0.05, 0x2a2420, { p: [0.3, 1.0, 0] });
      b.box(0.05, 0.18, 0.02, 0x2a2420, { p: [0, 0.75, 0.33] });
      b.box(0.24, 0.32, 0.03, P.darkWood, { p: [0, 0.34, 0.355] }); // door
      // top platform
      b.box(0.86, 0.1, 0.86, P.stoneLight, { p: [0, 2.17, 0] });
      b.box(0.8, 0.06, 0.8, tc, { p: [0, 2.1, 0] });
      // merlons with team caps
      for (const s of [-1, 1]) {
        for (const k of [-1, 0, 1]) {
          b.box(0.16, 0.16, 0.1, P.stoneLight, { p: [k * 0.33, 2.3, s * 0.38] });
          b.box(0.1, 0.16, 0.16, P.stoneLight, { p: [s * 0.38, 2.3, k * 0.33] });
          b.box(0.17, 0.035, 0.11, tc, { p: [k * 0.33, 2.395, s * 0.38] });
          b.box(0.11, 0.035, 0.17, tc, { p: [s * 0.38, 2.395, k * 0.33] });
        }
      }
      banner(b, tc, [0, 1.78, 0.38], 0.2, 0.42);
      pole(b, 0, 0, 2.2, 2.95, 0.02);
      flags.push({ pos: [0, 2.9, 0], w: 0.36, h: 0.22 });
      break;
    }
    case 'Wall': {
      height = 0.95;
      const w = 0.98;
      b.box(w, 0.76, w, P.stone, { p: [0, 0.38, 0], j: 0.04 });
      stoneCourses(b, w, w, 0, 0.76, P.stoneDark, 0.19);
      // vertical joints
      for (const k of [-0.25, 0.22]) {
        b.box(0.015, 0.19, w + 0.01, P.stoneDark, { p: [k, 0.095 + 0.38, 0] });
        b.box(w + 0.01, 0.19, 0.015, P.stoneDark, { p: [0, 0.095 + 0.19, k] });
      }
      b.box(w + 0.02, 0.06, w + 0.02, P.stoneLight, { p: [0, 0.77, 0] });
      // merlons at corners and mid-edges with team caps
      const m = 0.18;
      for (const x of [-1, 0, 1]) {
        for (const z of [-1, 0, 1]) {
          if (x === 0 && z === 0) continue;
          const px = x * (w / 2 - m / 2), pz = z * (w / 2 - m / 2);
          b.box(m, 0.16, m, P.stoneLight, { p: [px, 0.88, pz] });
          b.box(m + 0.01, 0.04, m + 0.01, tc, { p: [px, 0.98, pz] });
        }
      }
      break;
    }
  }
  return { main: b.build(), flags, height, crops, smoke };
}

function flagGeo(team: Team, w: number, hgt: number): THREE.BufferGeometry {
  return cached(geoCache, `flag:${team}:${w}:${hgt}`, () => {
    const b = new Geo();
    const tc = teamColor(team);
    b.box(w, hgt, 0.015, tc, { p: [w / 2 + 0.02, -hgt / 2, 0] });
    b.box(w * 0.35, hgt * 0.35, 0.02, P.gold, { p: [w * 0.45 + 0.02, -hgt / 2, 0], r: [0, 0, PI / 4] });
    return b.build();
  });
}

function scaffoldGeo(type: BuildingType, height: number): THREE.BufferGeometry {
  return cached(geoCache, `scaffold:${type}`, () => {
    const size = BUILDINGS[type].size;
    const half = size * 0.44;
    const hgt = Math.max(0.6, height * 0.8);
    const b = new Geo();
    const n = Math.max(1, Math.round((half * 2) / 0.7));
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const t = -half + (2 * half * i) / n;
      pts.push([t, -half], [t, half]);
      if (i > 0 && i < n) pts.push([-half, t], [half, t]);
    }
    for (const [x, z] of pts) b.add(cyl(0.022, 0.025, hgt, 4), P.lightWood, { p: [x, hgt / 2, z] });
    const levels = Math.max(1, Math.floor(hgt / 0.45));
    for (let l = 1; l <= levels; l++) {
      const y = (l * hgt) / (levels + 0.3);
      for (const s of [-1, 1]) {
        b.line([-half, y, s * half], [half, y, s * half], 0.016, P.wood, 4);
        b.line([s * half, y, -half], [s * half, y, half], 0.016, P.wood, 4);
      }
      // planks
      b.box(half * 2, 0.02, 0.12, 0xc09a60, { p: [0, y + 0.02, half - 0.05] });
    }
    // diagonal braces
    b.line([-half, 0.02, half], [-half + (2 * half) / n, hgt * 0.6, half], 0.013, P.wood, 4);
    b.line([half, 0.02, -half], [half, hgt * 0.6, -half + (2 * half) / n], 0.013, P.wood, 4);
    return b.build();
  });
}

function foundationGeo(type: BuildingType): THREE.BufferGeometry {
  return cached(geoCache, `foundation:${type}`, () => {
    const size = BUILDINGS[type].size;
    const s = size * 0.94;
    const b = new Geo();
    b.box(s, 0.03, s, 0x8a6a48, { p: [0, 0.015, 0] });
    // corner stakes + string
    for (const x of [-1, 1]) for (const z of [-1, 1]) b.box(0.05, 0.18, 0.05, P.lightWood, { p: [x * s / 2, 0.09, z * s / 2] });
    trimRing(b, s, s, 0.12, P.white, 0.01, 0.01);
    if (type !== 'Farm' && type !== 'Wall') {
      const r = rng(size);
      for (let i = 0; i < size * 2; i++) {
        b.add(box(0.12, 0.08, 0.12), P.stoneLight, { p: [(r() - 0.5) * s * 0.8, 0.06, (r() - 0.5) * s * 0.8], r: [0, r() * 3, 0], j: 0.1 });
      }
    }
    return b.build();
  });
}

let smokeGeo: THREE.BufferGeometry | null = null;

export function createBuildingModel(type: BuildingType, team: Team): BuildingModel {
  const def = cached(defCache, `${type}:${team}`, () => buildDef(type, team));
  const root = new THREE.Group();
  const structure = new THREE.Group();
  root.add(structure);
  const main = mesh(def.main);
  structure.add(main);

  const flagMeshes: THREE.Mesh[] = [];
  for (const f of def.flags) {
    const m = mesh(flagGeo(team, f.w, f.h));
    m.position.set(...f.pos);
    m.rotation.y = f.rotY ?? 0;
    m.userData.baseRot = f.rotY ?? 0;
    structure.add(m);
    flagMeshes.push(m);
  }
  let crops: THREE.Mesh | null = null;
  if (def.crops) {
    crops = mesh(def.crops);
    crops.position.y = 0.06;
    root.add(crops);
  }
  const smokes: THREE.Mesh[] = [];
  if (def.smoke) {
    if (!smokeGeo) smokeGeo = ico(0.1, 0);
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(smokeGeo, SMOKE_MAT);
      s.position.set(...def.smoke);
      root.add(s);
      smokes.push(s);
    }
  }
  const isFarm = type === 'Farm';
  const scaffold = isFarm ? null : mesh(scaffoldGeo(type, def.height));
  if (scaffold) {
    scaffold.visible = false;
    root.add(scaffold);
  }
  const foundation = mesh(foundationGeo(type), MAT, false);
  foundation.visible = false;
  root.add(foundation);

  let built = true;
  let progress = 1;
  let farmFrac = 1;
  const phase = Math.random() * 10;

  const updateCrops = () => {
    if (!crops) return;
    const f = built ? farmFrac : progress;
    crops.visible = f > 0.01;
    crops.scale.set(1, Math.max(0.08, 0.15 + 0.85 * f), 1);
  };

  return {
    root,
    setConstruction(p, isBuilt) {
      progress = Math.min(1, Math.max(0, p));
      built = isBuilt;
      if (isFarm) {
        foundation.visible = !built && progress < 0.05;
        structure.visible = built || progress >= 0.05;
        for (const f of flagMeshes) f.visible = built;
        updateCrops();
        return;
      }
      if (built) {
        structure.scale.y = 1;
        structure.visible = true;
        if (scaffold) scaffold.visible = false;
        foundation.visible = false;
        for (const f of flagMeshes) f.visible = true;
        for (const s of smokes) s.visible = true;
      } else {
        structure.visible = progress > 0.01;
        structure.scale.y = Math.max(0.02, progress);
        if (scaffold) scaffold.visible = true;
        foundation.visible = true;
        for (const f of flagMeshes) f.visible = false;
        for (const s of smokes) s.visible = false;
      }
    },
    setFarmFraction(f) {
      if (!isFarm) return;
      farmFrac = Math.min(1, Math.max(0, f));
      updateCrops();
    },
    animate(time) {
      const t = time + phase;
      for (let i = 0; i < flagMeshes.length; i++) {
        const m = flagMeshes[i];
        m.rotation.y = m.userData.baseRot + 0.35 * Math.sin(t * 2.6 + i * 1.3) + 0.12 * Math.sin(t * 5.1 + i);
      }
      if (smokes.length && def.smoke) {
        for (let i = 0; i < smokes.length; i++) {
          const c = (t * 0.35 + i / smokes.length) % 1;
          const s = smokes[i];
          s.position.set(def.smoke[0] + Math.sin(t + i) * 0.04 + c * 0.15, def.smoke[1] + c * 0.9, def.smoke[2] + c * 0.05);
          s.scale.setScalar(0.6 + c * 1.6);
          s.rotation.set(c * 2, c * 3, 0);
        }
      }
    },
    dispose() {
      root.removeFromParent();
    },
  };
}

// keep tree-shakers from complaining about unused helpers in some builds
void dode;
