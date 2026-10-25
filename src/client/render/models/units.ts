// Procedural low-poly unit models: humanoids (foot), riders on horses, deer.
import * as THREE from 'three';
import type { UnitType, ResourceType } from '../../../shared/rules';
import { Geo, P, MAT, Team, teamColor, teamShade, box, cyl, cone, sph, hemi, octa, dode, cached, mesh } from './common';

export type AnimState = 'idle' | 'walk' | 'attack' | 'gather' | 'build' | 'dead';
export type GatherKind = 'wood' | 'food' | 'gold' | 'stone' | 'farm' | null;

export interface UnitModel {
  root: THREE.Group;
  animate(state: AnimState, time: number, carrying: ResourceType | null, gather: GatherKind): void;
  dispose(): void;
}

type WeaponStyle = 'swing' | 'thrust' | 'bow' | 'throw' | 'tool';
type LeftStyle = 'shield' | 'bow' | 'free';

const PI = Math.PI;
const HIP_Y = 0.36;
const HIP_X = 0.058;
const HAND: [number, number, number] = [0, -0.255, 0.01];
const h = (dx: number, dy: number, dz: number): [number, number, number] => [HAND[0] + dx, HAND[1] + dy, HAND[2] + dz];

const geoCache = new Map<string, THREE.BufferGeometry>();
const g = (key: string, make: () => THREE.BufferGeometry) => cached(geoCache, key, make);

// ---------------------------------------------------------------------------
// Humanoid parts
// ---------------------------------------------------------------------------

function legGeo(pants: number, boots: number, greave?: number): THREE.BufferGeometry {
  const b = new Geo();
  b.box(0.085, 0.2, 0.1, pants, { p: [0, -0.1, 0] });
  b.box(0.08, 0.13, 0.09, greave ?? pants, { p: [0, -0.24, 0] });
  b.box(0.095, 0.06, 0.135, boots, { p: [0, -0.33, 0.018] });
  return b.build();
}

interface TorsoOpts {
  tunic: number;
  skirt?: number;
  belt?: number;
  w?: number;
  bareArms?: boolean;
}
function torso(b: Geo, o: TorsoOpts): void {
  const w = o.w ?? 0.21;
  b.box(w, 0.25, 0.14, o.tunic, { p: [0, 0.495, 0] });
  b.box(w * 1.12, 0.06, 0.16, o.tunic, { p: [0, 0.6, 0] }); // shoulders
  b.box(w * 1.08, 0.1, 0.16, o.skirt ?? o.tunic, { p: [0, 0.37, 0] });
  if (o.belt !== undefined) b.box(w * 1.06, 0.035, 0.155, o.belt, { p: [0, 0.43, 0] });
  b.add(cyl(0.035, 0.04, 0.05, 6), P.skin, { p: [0, 0.645, 0] });
}
function head(b: Geo, hair: number | null, y = 0.715): void {
  b.add(sph(0.083, 8, 6), P.skin, { p: [0, y, 0.005] });
  b.box(0.025, 0.03, 0.03, P.skinDark, { p: [0, y - 0.01, 0.085] }); // nose
  if (hair !== null) b.add(hemi(0.088, 8, 3), hair, { p: [0, y + 0.005, -0.008], r: [-0.25, 0, 0] });
}
function armGeo(sleeve: number, skin = P.skin, sleeveLen = 0.12): Geo {
  const b = new Geo();
  b.box(0.072, sleeveLen, 0.082, sleeve, { p: [0, -sleeveLen / 2 + 0.01, 0] });
  const rest = 0.23 - sleeveLen;
  if (rest > 0.01) b.box(0.062, rest, 0.07, skin, { p: [0, -sleeveLen - rest / 2 + 0.01, 0] });
  b.add(sph(0.038, 6, 4), skin, { p: HAND });
  return b;
}
function roundShield(b: Geo, color: number, rim: number, r = 0.13): void {
  const p: [number, number, number] = [0.055, -0.15, 0.05];
  b.add(cyl(r, r, 0.025, 10), rim, { p, r: [PI / 2, 0.9, 0], o: 'YXZ' });
  b.add(cyl(r * 0.85, r * 0.85, 0.035, 10), color, { p, r: [PI / 2, 0.9, 0], o: 'YXZ' });
  b.add(sph(0.03, 6, 4), rim, { p: [p[0] + Math.sin(0.9) * 0.02, p[1], p[2] + Math.cos(0.9) * 0.02] });
}
/** upright bow, grip at origin, belly towards +Z */
function bowGeo(): THREE.BufferGeometry {
  return g('w:bow', () => {
    const b = new Geo();
    const pts: [number, number, number][] = [[0, -0.34, -0.12], [0, -0.18, -0.035], [0, 0, 0.0], [0, 0.18, -0.035], [0, 0.34, -0.12]];
    for (let i = 0; i < pts.length - 1; i++) b.line(pts[i], pts[i + 1], 0.022, 0x4a2c14, 5);
    b.box(0.03, 0.06, 0.03, P.leather, {});
    b.line(pts[0], pts[4], 0.005, P.white, 3);
    return b.build();
  });
}
function quiver(b: Geo, x = 0.05): void {
  b.add(cyl(0.035, 0.03, 0.25, 6), P.leather, { p: [x, 0.52, -0.1], r: [0, 0, 0.35] });
  for (let i = 0; i < 3; i++) b.box(0.012, 0.06, 0.03, P.white, { p: [x - 0.045 + i * 0.016, 0.67, -0.1 + (i - 1) * 0.012], r: [0, 0, 0.35] });
}
function cape(b: Geo, color: number, w = 0.22, len = 0.36): void {
  b.box(w, len, 0.03, color, { p: [0, 0.62 - len / 2, -0.09], r: [-0.12, 0, 0] });
}

// weapons in arm-local coordinates
function sword(b: Geo, len = 0.24): void {
  b.line(h(0, -0.01, -0.04), h(0, 0.01, 0.03), 0.014, P.leather, 4);
  b.box(0.07, 0.02, 0.025, P.bronze, { p: h(0, 0.012, 0.035) });
  b.box(0.02, 0.045, len, P.iron, { p: h(0, 0.03, 0.04 + len / 2), r: [-0.15, 0, 0] });
}
/** upright spear, grip at origin */
function spearGeo(len = 1.15): THREE.BufferGeometry {
  return g(`w:spear:${len}`, () => {
    const b = new Geo();
    b.line([0, -0.3, 0], [0, len - 0.3, 0], 0.014, P.wood, 4);
    b.add(cone(0.03, 0.13, 4), P.iron, { p: [0, len - 0.24, 0] });
    b.box(0.035, 0.03, 0.035, P.bronze, { p: [0, -0.3, 0] });
    return b.build();
  });
}
function javelinGeo(): THREE.BufferGeometry {
  return g('w:javelin', () => {
    const b = new Geo();
    javelin(b, [0, -0.2, 0], [0, 0.42, 0]);
    return b.build();
  });
}
function javelin(b: Geo, from: [number, number, number], to: [number, number, number]): void {
  b.line(from, to, 0.01, P.lightWood, 4);
  const d = new THREE.Vector3(...to).sub(new THREE.Vector3(...from)).normalize();
  const tip = new THREE.Vector3(...to).addScaledVector(d, 0.04);
  b.line(to, [tip.x, tip.y, tip.z], 0.0, P.iron, 4, 0.02);
}

interface HumanDef {
  /** separate weapon meshes (child of arm at the hand) kept upright / aimed independently of the arm */
  wR?: THREE.BufferGeometry;
  wL?: THREE.BufferGeometry;
  leg: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  armL: THREE.BufferGeometry;
  armR: THREE.BufferGeometry;
  style: WeaponStyle;
  left: LeftStyle;
  shoulderX: number;
  scale: number;
}

function buildHuman(type: UnitType, team: Team): HumanDef {
  const tc = teamColor(team);
  const tDark = teamShade(team, 0.7);
  const t = new Geo();
  let leg: THREE.BufferGeometry;
  let aL: Geo;
  let aR: Geo;
  let style: WeaponStyle = 'swing';
  let left: LeftStyle = 'free';
  let shoulderX = 0.143;
  let scale = 1;
  let wR: THREE.BufferGeometry | undefined;
  let wL: THREE.BufferGeometry | undefined;

  switch (type) {
    case 'Villager': {
      leg = legGeo(P.brown, P.darkBrown);
      torso(t, { tunic: P.beige, skirt: P.beige, belt: tc });
      // diagonal sash
      t.box(0.075, 0.33, 0.155, tc, { p: [0, 0.5, 0.002], r: [0, 0, 0.62] });
      head(t, P.hair);
      t.add(cone(0.135, 0.085, 10), P.straw, { p: [0, 0.81, 0] });
      t.add(cyl(0.09, 0.092, 0.04, 10), tc, { p: [0, 0.778, 0] });
      aL = armGeo(P.beige);
      aR = armGeo(P.beige);
      style = 'tool';
      break;
    }
    case 'Clubman': {
      leg = legGeo(P.skin, P.leather, P.skin);
      torso(t, { tunic: tc, skirt: P.leather, belt: P.darkBrown, bareArms: true });
      t.box(0.08, 0.3, 0.15, P.leather, { p: [0.03, 0.5, 0.003], r: [0, 0, -0.5] }); // hide strap
      head(t, P.hair);
      t.add(hemi(0.095, 7, 3), P.hair, { p: [0, 0.725, -0.01], s: [1, 0.9, 1.1] });
      aL = armGeo(P.skin, P.skin, 0.03);
      aR = armGeo(P.skin, P.skin, 0.03);
      aR.line(h(0, -0.02, -0.04), h(0, 0.12, 0.34), 0.06, P.wood, 6, 0.024);
      aR.add(sph(0.062, 6, 4), P.darkWood, { p: h(0, 0.12, 0.34) });
      break;
    }
    case 'Swordsman': {
      leg = legGeo(tDark, P.leather, P.bronze);
      torso(t, { tunic: tc, skirt: tc, belt: P.bronze });
      t.box(0.2, 0.15, 0.15, P.bronze, { p: [0, 0.54, 0.002] }); // cuirass
      head(t, null);
      t.add(hemi(0.097, 8, 4), P.bronze, { p: [0, 0.725, 0] });
      t.box(0.2, 0.025, 0.2, P.bronze, { p: [0, 0.72, 0], r: [0, PI / 4, 0] }); // brim
      t.box(0.02, 0.05, 0.12, tc, { p: [0, 0.83, 0] }); // small team plume
      aL = armGeo(tc);
      aR = armGeo(tc);
      roundShield(aL, tc, P.bronze, 0.14);
      sword(aR);
      left = 'shield';
      break;
    }
    case 'Spearman': {
      leg = legGeo(P.brown, P.leather);
      torso(t, { tunic: tc, skirt: tDark, belt: P.leather });
      t.box(0.215, 0.12, 0.15, P.leather, { p: [0, 0.56, 0.003] });
      head(t, null);
      t.add(hemi(0.095, 8, 3), P.leather, { p: [0, 0.72, 0] });
      t.add(cone(0.03, 0.06, 5), P.leather, { p: [0, 0.83, 0] });
      aL = armGeo(tc);
      aR = armGeo(tc);
      roundShield(aL, tc, P.wood, 0.12);
      wR = spearGeo();
      style = 'thrust';
      left = 'shield';
      break;
    }
    case 'Bowman': {
      leg = legGeo(P.brown, P.leather);
      torso(t, { tunic: tc, skirt: tc, belt: P.leather });
      head(t, null);
      t.add(hemi(0.1, 8, 4), 0x6b5434, { p: [0, 0.715, -0.01], s: [1, 1.15, 1] });
      t.box(0.12, 0.12, 0.05, 0x6b5434, { p: [0, 0.65, -0.075] });
      t.add(cone(0.035, 0.1, 5), 0x6b5434, { p: [0, 0.81, -0.07], r: [-0.8, 0, 0] });
      quiver(t);
      aL = armGeo(tc);
      aR = armGeo(tc);
      wL = bowGeo();
      style = 'bow';
      left = 'bow';
      break;
    }
    case 'Skirmisher': {
      leg = legGeo(P.skin, P.leather, P.skin);
      torso(t, { tunic: tc, skirt: P.beige, belt: P.leather });
      head(t, P.hair);
      t.add(cyl(0.088, 0.088, 0.025, 8), tc, { p: [0, 0.74, 0] }); // headband
      // javelin bundle on back
      for (let i = 0; i < 3; i++) javelin(t, [-0.06 + i * 0.03, 0.3, -0.1], [0.04 + i * 0.03, 0.82, -0.12]);
      t.box(0.04, 0.03, 0.04, P.leather, { p: [0.0, 0.52, -0.1] });
      aL = armGeo(tc, P.skin, 0.06);
      aR = armGeo(tc, P.skin, 0.06);
      // small wicker shield
      aL.add(cyl(0.095, 0.095, 0.03, 8), P.straw, { p: [0.05, -0.15, 0.04], r: [PI / 2, 0.9, 0], o: 'YXZ' });
      aL.add(cyl(0.055, 0.055, 0.04, 8), 0xa88a42, { p: [0.05, -0.15, 0.04], r: [PI / 2, 0.9, 0], o: 'YXZ' });
      wR = javelinGeo();
      style = 'throw';
      left = 'shield';
      break;
    }
    case 'Centurion': {
      leg = legGeo(tDark, P.leather, P.bronze);
      shoulderX = 0.165;
      scale = 1.12;
      torso(t, { tunic: tc, skirt: tc, belt: P.bronze, w: 0.25 });
      // lorica segmentata bands
      for (let i = 0; i < 4; i++) t.box(0.262, 0.032, 0.152, i % 2 ? P.darkIron : P.iron, { p: [0, 0.47 + i * 0.038, 0] });
      t.box(0.3, 0.06, 0.17, P.iron, { p: [0, 0.605, 0] }); // pauldrons
      // pteruges
      for (let i = 0; i < 5; i++) t.box(0.04, 0.09, 0.02, P.leather, { p: [-0.1 + i * 0.05, 0.36, 0.085] });
      cape(t, tc, 0.27, 0.42);
      head(t, null);
      t.add(hemi(0.1, 8, 4), P.iron, { p: [0, 0.72, 0] });
      t.box(0.04, 0.07, 0.03, P.iron, { p: [0.085, 0.69, 0.04] });
      t.box(0.04, 0.07, 0.03, P.iron, { p: [-0.085, 0.69, 0.04] });
      t.box(0.17, 0.03, 0.06, P.iron, { p: [0, 0.69, -0.08] });
      // transverse crest (side to side)
      t.box(0.3, 0.09, 0.045, P.crest, { p: [0, 0.85, 0] });
      t.box(0.24, 0.03, 0.05, P.crest, { p: [0, 0.905, 0] });
      aL = armGeo(tc);
      aR = armGeo(tc);
      // big rectangular scutum
      const sp: [number, number, number] = [0.07, -0.14, 0.1];
      aL.box(0.26, 0.4, 0.04, tc, { p: sp, r: [0, 0.55, 0] });
      aL.box(0.28, 0.025, 0.045, P.bronze, { p: [sp[0], sp[1] + 0.19, sp[2]], r: [0, 0.55, 0] });
      aL.box(0.28, 0.025, 0.045, P.bronze, { p: [sp[0], sp[1] - 0.19, sp[2]], r: [0, 0.55, 0] });
      aL.box(0.03, 0.38, 0.048, P.bronze, { p: sp, r: [0, 0.55, 0] });
      aL.add(sph(0.045, 6, 4), P.bronze, { p: [sp[0] + 0.012, sp[1], sp[2] + 0.025] });
      sword(aR, 0.26);
      left = 'shield';
      break;
    }
    default:
      throw new Error('not a foot unit: ' + type);
  }
  return { leg, torso: t.build(), armL: aL.build(), armR: aR.build(), style, left, shoulderX, scale, wR, wL };
}

// villager tools (right arm variants)
type ToolKind = 'none' | 'axe' | 'pick' | 'hammer' | 'hoe' | 'basket';
function villagerArm(team: Team, tool: ToolKind): THREE.BufferGeometry {
  return g(`varm:${team}:${tool}`, () => {
    const a = armGeo(P.beige);
    const handle = (len: number) => a.line(h(0, -0.01, -0.05), h(0, 0.02, len), 0.014, P.lightWood, 4);
    if (tool === 'axe') {
      handle(0.3);
      a.box(0.022, 0.1, 0.06, P.iron, { p: h(0, -0.03, 0.27) });
    } else if (tool === 'pick') {
      handle(0.3);
      a.add(cone(0.022, 0.12, 4), P.darkIron, { p: h(0, 0.08, 0.28) });
      a.add(cone(0.022, 0.12, 4), P.darkIron, { p: h(0, -0.04, 0.28), r: [PI, 0, 0] });
    } else if (tool === 'hammer') {
      handle(0.24);
      a.box(0.05, 0.1, 0.055, P.darkIron, { p: h(0, 0.01, 0.24) });
    } else if (tool === 'hoe') {
      handle(0.36);
      a.box(0.08, 0.08, 0.016, P.iron, { p: h(0, -0.04, 0.35) });
    } else if (tool === 'basket') {
      a.add(cyl(0.07, 0.05, 0.08, 8), P.straw, { p: h(0.0, -0.03, 0.05) });
      a.add(sph(0.03, 5, 4), P.red, { p: h(0.015, 0.02, 0.05) });
      a.add(sph(0.03, 5, 4), 0x7a2a6a, { p: h(-0.02, 0.02, 0.06) });
    }
    return a.build();
  });
}

function carryGeo(kind: ResourceType): THREE.BufferGeometry {
  return g(`carry:${kind}`, () => {
    const b = new Geo();
    if (kind === 'wood') {
      for (let i = 0; i < 3; i++) {
        const y = i < 2 ? 0 : 0.055;
        const x = i < 2 ? (i - 0.5) * 0.06 : 0;
        b.add(cyl(0.032, 0.032, 0.36, 6), P.wood, { p: [x, y, 0], r: [0, 0, PI / 2 + 0.15], j: 0.15 });
        b.add(cyl(0.026, 0.026, 0.362, 6), P.lightWood, { p: [x, y, 0], r: [0, 0, PI / 2 + 0.15] });
      }
      b.box(0.02, 0.13, 0.08, P.leather, { p: [0, 0.02, 0] });
    } else if (kind === 'food') {
      b.add(cyl(0.08, 0.06, 0.12, 8), P.straw, {});
      b.add(sph(0.035, 5, 4), P.red, { p: [0.03, 0.06, 0.01] });
      b.add(sph(0.035, 5, 4), 0x8a2a7a, { p: [-0.03, 0.06, -0.01] });
      b.add(sph(0.035, 5, 4), P.red, { p: [0, 0.07, -0.03] });
    } else if (kind === 'gold') {
      b.add(sph(0.075, 6, 5), 0x8a6a3a, { s: [1, 0.9, 0.8] });
      b.add(octa(0.05), P.gold, { p: [0.02, 0.07, 0.01] });
      b.add(octa(0.04), 0xffe066, { p: [-0.03, 0.06, -0.01] });
    } else {
      b.add(dode(0.08), P.stoneLight, { s: [1.2, 0.8, 1] });
      b.add(box(0.07, 0.05, 0.07), P.stone, { p: [0.02, 0.07, 0], r: [0.2, 0.4, 0] });
    }
    return b.build();
  });
}

// ---------------------------------------------------------------------------
// Riders and horses
// ---------------------------------------------------------------------------
const SEAT_Y = 0.66;

interface HorseOpts {
  coat: number;
  mane: number;
  bulky: boolean;
  cloth?: number;
  clothTrim?: number;
  caparison?: number;
  chanfron?: boolean;
}
function horseGeo(key: string, o: HorseOpts): { body: THREE.BufferGeometry; leg: THREE.BufferGeometry } {
  const w = o.bulky ? 0.24 : 0.19;
  const body = g(`horse:${key}`, () => {
    const b = new Geo();
    const y = 0.52;
    b.box(w, 0.24, 0.56, o.coat, { p: [0, y, 0] });
    b.box(w * 0.96, 0.22, 0.14, o.coat, { p: [0, y + 0.01, 0.27], r: [0.2, 0, 0] }); // chest
    b.box(w * 1.02, 0.24, 0.16, o.coat, { p: [0, y + 0.01, -0.25] }); // rump
    // neck
    b.box(0.11, 0.3, 0.15, o.coat, { p: [0, 0.7, 0.3], r: [0.55, 0, 0] });
    b.box(0.03, 0.3, 0.06, o.mane, { p: [0, 0.73, 0.24], r: [0.55, 0, 0] });
    // head
    b.box(0.1, 0.11, 0.25, o.coat, { p: [0, 0.83, 0.43], r: [0.65, 0, 0] });
    b.box(0.085, 0.08, 0.06, 0x2a2018, { p: [0, 0.76, 0.52], r: [0.65, 0, 0] }); // muzzle
    b.box(0.025, 0.06, 0.025, o.coat, { p: [0.035, 0.94, 0.37] });
    b.box(0.025, 0.06, 0.025, o.coat, { p: [-0.035, 0.94, 0.37] });
    if (o.chanfron) b.box(0.105, 0.06, 0.2, P.iron, { p: [0, 0.865, 0.43], r: [0.65, 0, 0] });
    // tail
    b.box(0.05, 0.3, 0.06, o.mane, { p: [0, 0.46, -0.37], r: [-0.35, 0, 0] });
    // saddle
    b.box(w + 0.02, 0.04, 0.2, P.leather, { p: [0, 0.65, -0.02] });
    if (o.cloth !== undefined) {
      b.box(w + 0.03, 0.2, 0.26, o.cloth, { p: [0, 0.56, -0.02] });
      if (o.clothTrim !== undefined) b.box(w + 0.035, 0.03, 0.27, o.clothTrim, { p: [0, 0.46, -0.02] });
    }
    if (o.caparison !== undefined) {
      b.box(w + 0.04, 0.27, 0.66, o.caparison, { p: [0, 0.52, -0.01] });
      b.box(w + 0.045, 0.035, 0.67, P.gold, { p: [0, 0.39, -0.01] });
      b.box(0.135, 0.16, 0.16, o.caparison, { p: [0, 0.66, 0.29], r: [0.55, 0, 0] });
    }
    return b.build();
  });
  const leg = g(`hleg:${o.coat}:${o.bulky}`, () => {
    const b = new Geo();
    const lw = o.bulky ? 0.07 : 0.055;
    b.box(lw, 0.22, lw + 0.02, o.coat, { p: [0, -0.1, 0] });
    b.box(lw * 0.8, 0.2, lw * 0.85, o.coat, { p: [0, -0.3, 0] });
    b.box(lw * 0.95, 0.04, lw + 0.01, 0x2a2018, { p: [0, -0.42, 0.005] });
    return b.build();
  });
  return { body, leg };
}

/** rider torso with seated legs; origin at saddle seat */
function riderBase(b: Geo, tunic: number, pants: number, boots: number, w = 0.2): void {
  const y0 = -0.36; // offset so humanoid torso builders (hip at 0.36) line up with seat at 0
  for (const s of [-1, 1]) {
    b.box(0.08, 0.08, 0.2, pants, { p: [s * 0.1, 0.03, 0.06] });
    b.box(0.075, 0.2, 0.08, pants, { p: [s * 0.135, -0.06, 0.14] });
    b.box(0.08, 0.06, 0.12, boots, { p: [s * 0.135, -0.17, 0.16] });
  }
  const t = new Geo();
  torso(t, { tunic, skirt: tunic, w });
  b.merge(t, { p: [0, y0, 0] });
}

interface RiderDef {
  wR?: THREE.BufferGeometry;
  wL?: THREE.BufferGeometry;
  horse: { body: THREE.BufferGeometry; leg: THREE.BufferGeometry };
  torso: THREE.BufferGeometry;
  armL: THREE.BufferGeometry;
  armR: THREE.BufferGeometry;
  style: WeaponStyle;
  left: LeftStyle;
  bulky: boolean;
}

function buildRider(type: UnitType, team: Team): RiderDef {
  const tc = teamColor(team);
  const tDark = teamShade(team, 0.7);
  const b = new Geo();
  const H = (geo: Geo, fn: (x: Geo) => void) => { const t = new Geo(); fn(t); geo.merge(t, { p: [0, -0.36, 0] }); };
  let aL: Geo;
  let aR: Geo;
  let style: WeaponStyle = 'swing';
  let left: LeftStyle = 'free';
  let horse;
  let bulky = false;
  let wR: THREE.BufferGeometry | undefined;
  let wL: THREE.BufferGeometry | undefined;
  switch (type) {
    case 'Scout': {
      horse = horseGeo(`scout:${team}`, { coat: 0xcfc6b4, mane: 0x6a5a48, bulky: false, cloth: tc });
      riderBase(b, P.beige, P.brown, P.leather);
      H(b, (t) => {
        cape(t, tc, 0.23, 0.32);
        t.box(0.23, 0.08, 0.16, tc, { p: [0, 0.6, 0] }); // cloak shoulders
        head(t, P.hair);
        t.add(hemi(0.092, 8, 3), P.leather, { p: [0, 0.72, 0] });
      });
      aL = armGeo(P.beige);
      aR = armGeo(P.beige);
      wR = spearGeo(0.9);
      style = 'thrust';
      break;
    }
    case 'HorseArcher': {
      horse = horseGeo(`ha:${team}`, { coat: 0x8a4a26, mane: 0x2a1a10, bulky: false, cloth: tc, clothTrim: P.gold });
      riderBase(b, tc, P.brown, P.leather);
      H(b, (t) => {
        head(t, null);
        t.add(hemi(0.096, 8, 3), 0x8a6a40, { p: [0, 0.72, 0], s: [1, 1.2, 1] });
        t.add(cone(0.03, 0.08, 5), 0x8a6a40, { p: [0, 0.84, 0] });
        quiver(t, -0.05);
      });
      aL = armGeo(tc);
      aR = armGeo(tc);
      wL = bowGeo();
      style = 'bow';
      left = 'bow';
      break;
    }
    case 'Cavalry': {
      bulky = true;
      horse = horseGeo(`cav:${team}`, { coat: 0x4a3a32, mane: 0x1a1410, bulky: true, caparison: tc });
      riderBase(b, tc, tDark, P.darkIron, 0.22);
      H(b, (t) => {
        t.box(0.23, 0.2, 0.16, P.iron, { p: [0, 0.53, 0.002] });
        t.box(0.27, 0.06, 0.17, P.iron, { p: [0, 0.605, 0] });
        head(t, null);
        t.add(hemi(0.1, 8, 4), P.iron, { p: [0, 0.72, 0] });
        t.box(0.16, 0.08, 0.03, P.iron, { p: [0, 0.69, 0.08] }); // visor
        t.add(cone(0.04, 0.16, 6), tc, { p: [0, 0.86, -0.02], r: [-0.4, 0, 0] }); // plume
      });
      aL = armGeo(P.iron);
      aR = armGeo(P.iron);
      roundShield(aL, tc, P.iron, 0.11);
      sword(aR, 0.3);
      left = 'shield';
      break;
    }
    default:
      throw new Error('not a mounted unit: ' + type);
  }
  return { horse, torso: b.build(), armL: aL.build(), armR: aR.build(), style, left, bulky, wR, wL };
}

// ---------------------------------------------------------------------------
// Deer
// ---------------------------------------------------------------------------
function deerGeos() {
  const body = g('deer:body', () => {
    const b = new Geo();
    b.box(0.14, 0.16, 0.42, 0x9a6638, { p: [0, 0.45, 0] });
    b.box(0.12, 0.05, 0.36, 0xd8c09a, { p: [0, 0.365, 0] });
    b.box(0.13, 0.15, 0.1, 0x9a6638, { p: [0, 0.46, 0.19], r: [0.3, 0, 0] });
    b.box(0.05, 0.08, 0.04, P.white, { p: [0, 0.5, -0.22], r: [-0.5, 0, 0] });
    return b.build();
  });
  const neck = g('deer:neck', () => {
    const b = new Geo();
    b.box(0.07, 0.24, 0.08, 0x9a6638, { p: [0, 0.1, 0.03], r: [0.45, 0, 0] });
    b.box(0.08, 0.08, 0.16, 0x9a6638, { p: [0, 0.22, 0.1] });
    b.box(0.05, 0.05, 0.05, 0x2a1a10, { p: [0, 0.215, 0.18] });
    b.box(0.02, 0.05, 0.03, 0x8a5a30, { p: [0.04, 0.27, 0.06], r: [0, 0, -0.6] });
    b.box(0.02, 0.05, 0.03, 0x8a5a30, { p: [-0.04, 0.27, 0.06], r: [0, 0, 0.6] });
    // antlers
    const ac = 0xe0d0b0;
    for (const s of [-1, 1]) {
      b.line([s * 0.025, 0.26, 0.07], [s * 0.08, 0.4, 0.04], 0.009, ac, 4);
      b.line([s * 0.08, 0.4, 0.04], [s * 0.12, 0.47, -0.02], 0.008, ac, 4);
      b.line([s * 0.06, 0.36, 0.05], [s * 0.05, 0.44, 0.1], 0.007, ac, 4);
      b.line([s * 0.1, 0.43, 0.01], [s * 0.15, 0.48, 0.06], 0.007, ac, 4);
    }
    return b.build();
  });
  const leg = g('deer:leg', () => {
    const b = new Geo();
    b.box(0.04, 0.2, 0.05, 0x9a6638, { p: [0, -0.1, 0] });
    b.box(0.03, 0.18, 0.03, 0x7a5030, { p: [0, -0.28, 0] });
    b.box(0.032, 0.03, 0.035, 0x2a1a10, { p: [0, -0.37, 0.005] });
    return b.build();
  });
  return { body, neck, leg };
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------
const ease = (x: number) => x * x * (3 - 2 * x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (x: number) => x - Math.floor(x);

/** overhand swing: returns arm angle */
function swingAngle(c: number, rest = -0.3): number {
  if (c < 0.5) return lerp(rest, -2.7, ease(c / 0.5));
  if (c < 0.68) return lerp(-2.7, -0.15, ease((c - 0.5) / 0.18));
  return lerp(-0.15, rest, ease((c - 0.68) / 0.32));
}

function pivot(geo: THREE.BufferGeometry, x: number, y: number, z: number, parent: THREE.Object3D): THREE.Mesh {
  // a mesh used directly as pivot: geometry is authored relative to the joint
  const m = mesh(geo, MAT);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

interface ArmRig {
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  /** optional weapon meshes, children of the arms at the hand */
  wL: THREE.Mesh | null;
  wR: THREE.Mesh | null;
  shoulderX: number;
  shoulderY: number;
  style: WeaponStyle;
  left: LeftStyle;
}

function leftRest(left: LeftStyle): number {
  return left === 'bow' ? -0.4 : left === 'shield' ? -0.45 : 0;
}

/** sets arm poses for combat/idle; returns body lean (rotation.x) */
function poseArms(r: ArmRig, state: AnimState, t: number, walkS: number, mounted: boolean): number {
  const { armL, armR } = r;
  armL.position.set(r.shoulderX, r.shoulderY, 0);
  armR.position.set(-r.shoulderX, r.shoulderY, 0);
  armL.rotation.set(leftRest(r.left), 0, 0);
  armR.rotation.set(r.style === 'thrust' ? -0.35 : r.style === 'throw' ? -0.25 : -0.3, 0, 0);
  if (mounted && r.left === 'free') armL.rotation.x = -0.6;
  // world pitch of upright weapons (0 = vertical, PI/2 = pointing forward)
  let pitchR = r.style === 'throw' ? -0.15 : 0;
  const pitchL = 0;
  let lean = 0;
  if (state === 'walk' && !mounted) {
    armR.rotation.x += (r.style === 'thrust' || r.style === 'throw' ? 0.2 : 0.5) * -walkS;
    armL.rotation.x += (r.left === 'free' ? 0.5 : 0.15) * walkS;
  } else if (state === 'idle') {
    armR.rotation.x += 0.04 * Math.sin(t * 1.7);
    armL.rotation.x -= 0.04 * Math.sin(t * 1.7);
  } else if (state === 'attack') {
    const c = frac(t * 0.8);
    switch (r.style) {
      case 'swing':
      case 'tool':
        armR.rotation.x = swingAngle(c);
        lean = c > 0.5 && c < 0.8 ? 0.15 : 0;
        break;
      case 'thrust': {
        // spear levelled forward, arm pulls back then jabs
        const k = c < 0.6 ? -ease(c / 0.6) : c < 0.75 ? lerp(-1, 1, ease((c - 0.6) / 0.15)) : lerp(1, 0, ease((c - 0.75) / 0.25));
        armR.rotation.x = -0.9 - 0.45 * k;
        pitchR = PI / 2 + 0.08;
        lean = 0.1 * Math.max(0, k);
        break;
      }
      case 'bow': {
        armL.rotation.x = -PI / 2;
        armL.rotation.z = -0.15;
        const draw = c < 0.75 ? ease(c / 0.75) : lerp(1, 0, (c - 0.75) / 0.25);
        armR.rotation.x = -1.5;
        armR.rotation.z = 0.45;
        armR.position.z = -0.13 * draw;
        break;
      }
      case 'throw': {
        if (c < 0.55) armR.rotation.x = lerp(-0.25, -2.9, ease(c / 0.55));
        else if (c < 0.7) armR.rotation.x = lerp(-2.9, -0.9, ease((c - 0.55) / 0.15));
        else armR.rotation.x = lerp(-0.9, -0.25, ease((c - 0.7) / 0.3));
        pitchR = c < 0.7 ? 1.35 : lerp(1.35, -0.15, ease((c - 0.7) / 0.3));
        lean = c > 0.55 && c < 0.8 ? 0.15 : 0;
        break;
      }
    }
  }
  if (r.wR) r.wR.rotation.set(pitchR - armR.rotation.x, 0, -armR.rotation.z);
  if (r.wL) r.wL.rotation.set(pitchL - armL.rotation.x, 0, -armL.rotation.z);
  return lean;
}

function attachWeapon(arm: THREE.Mesh, geo: THREE.BufferGeometry | undefined): THREE.Mesh | null {
  if (!geo) return null;
  const m = mesh(geo);
  m.position.set(HAND[0], HAND[1], HAND[2] + 0.01);
  arm.add(m);
  return m;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function createHuman(type: UnitType, team: Team): UnitModel {
  const def = cached(humanCache, `${type}:${team}`, () => buildHuman(type, team));
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(def.scale);
  root.add(body);
  const legL = pivot(def.leg, HIP_X, HIP_Y, 0, body);
  const legR = pivot(def.leg, -HIP_X, HIP_Y, 0, body);
  const torsoM = mesh(def.torso);
  body.add(torsoM);
  const armL = pivot(def.armL, def.shoulderX, 0.6, 0, body);
  const armR = pivot(def.armR, -def.shoulderX, 0.6, 0, body);
  const isVillager = type === 'Villager';
  let carryM: THREE.Mesh | null = null;
  let curCarry: ResourceType | null = null;
  let curTool: ToolKind = 'none';
  if (isVillager) {
    carryM = mesh(carryGeo('wood'));
    carryM.visible = false;
    body.add(carryM);
  }
  const rig: ArmRig = {
    armL, armR, wL: attachWeapon(armL, def.wL), wR: attachWeapon(armR, def.wR),
    shoulderX: def.shoulderX, shoulderY: 0.6, style: def.style, left: def.left,
  };
  const phase = Math.random() * 10;

  return {
    root,
    animate(state, time, carrying, gather) {
      const t = time + phase;
      if (!isVillager && (state === 'gather' || state === 'build')) state = 'idle';
      // reset
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      legL.rotation.set(0, 0, 0);
      legR.rotation.set(0, 0, 0);
      legL.position.y = legR.position.y = HIP_Y;

      if (isVillager && carryM) {
        let tool: ToolKind = 'none';
        if (state === 'build') tool = 'hammer';
        else if (state === 'attack') tool = 'axe';
        else if (gather === 'wood') tool = 'axe';
        else if (gather === 'gold' || gather === 'stone') tool = 'pick';
        else if (gather === 'farm') tool = 'hoe';
        else if (gather === 'food') tool = 'basket';
        if (carrying && tool === 'basket') tool = 'none';
        if (tool !== curTool) {
          curTool = tool;
          armR.geometry = villagerArm(team, tool);
        }
        if (carrying !== curCarry) {
          curCarry = carrying;
          if (carrying) carryM.geometry = carryGeo(carrying);
          carryM.visible = carrying !== null;
          if (carrying === 'wood') carryM.position.set(0, 0.6, -0.12);
          else if (carrying === 'food') carryM.position.set(0, 0.5, -0.14);
          else carryM.position.set(0, 0.5, -0.13);
        }
      }

      if (state === 'dead') {
        body.rotation.set(0, 0, PI / 2);
        body.position.set(0, 0.08 * def.scale, 0);
        armL.rotation.set(-0.3, 0, 0.4);
        armR.rotation.set(0.3, 0, -0.2);
        armL.position.set(def.shoulderX, 0.6, 0);
        armR.position.set(-def.shoulderX, 0.6, 0);
        legL.rotation.x = 0.2;
        legR.rotation.x = -0.15;
        return;
      }

      const ws = state === 'walk' ? Math.sin(t * 9) : 0;
      if (state === 'walk') {
        legL.rotation.x = 0.6 * ws;
        legR.rotation.x = -0.6 * ws;
        body.position.y = Math.abs(Math.cos(t * 9)) * 0.022;
      }
      const lean = poseArms(rig, state, t, ws, false);
      body.rotation.x = lean;

      if (state === 'gather' || state === 'build') {
        if (isVillager && gather === 'food' && state === 'gather') {
          body.rotation.x = 0.45;
          legL.rotation.x = legR.rotation.x = -0.35;
          armR.rotation.x = -1.0 + 0.3 * Math.sin(t * 5);
          armL.rotation.x = -1.0 + 0.3 * Math.sin(t * 5 + PI);
        } else {
          const speed = state === 'build' ? 1.6 : 1.1;
          const c = frac(t * speed);
          armR.rotation.x = swingAngle(c, -0.5);
          armL.rotation.x = Math.min(-0.3, armR.rotation.x * 0.8);
          armL.rotation.z = -0.25;
          const strike = c > 0.5 && c < 0.8;
          body.rotation.x = (gather === 'farm' ? 0.25 : 0.05) + (strike ? 0.18 : 0);
          if (state === 'build') {
            body.rotation.x = 0.3 + (strike ? 0.1 : 0);
            legL.rotation.x = -0.3;
            legR.rotation.x = 0.1;
          }
        }
      }
    },
    dispose() {
      root.removeFromParent();
    },
  };
}

function createRider(type: UnitType, team: Team): UnitModel {
  const def = cached(riderCache, `${type}:${team}`, () => buildRider(type, team));
  const root = new THREE.Group();
  const body = new THREE.Group(); // tilts when dead
  root.add(body);
  const bob = new THREE.Group();
  body.add(bob);
  bob.add(mesh(def.horse.body));
  const lx = def.bulky ? 0.075 : 0.062;
  const legs = [
    pivot(def.horse.leg, lx, 0.44, 0.21, bob),
    pivot(def.horse.leg, -lx, 0.44, 0.21, bob),
    pivot(def.horse.leg, lx, 0.44, -0.22, bob),
    pivot(def.horse.leg, -lx, 0.44, -0.22, bob),
  ];
  const rider = new THREE.Group();
  rider.position.set(0, SEAT_Y, -0.02);
  bob.add(rider);
  rider.add(mesh(def.torso));
  const sx = def.bulky ? 0.15 : 0.14;
  const armL = pivot(def.armL, sx, 0.24, 0, rider);
  const armR = pivot(def.armR, -sx, 0.24, 0, rider);
  const rig: ArmRig = {
    armL, armR, wL: attachWeapon(armL, def.wL), wR: attachWeapon(armR, def.wR),
    shoulderX: sx, shoulderY: 0.24, style: def.style, left: def.left,
  };
  const phase = Math.random() * 10;
  const legPhase = [0, 0.45, PI, PI + 0.45];

  return {
    root,
    animate(state, time) {
      const t = time + phase;
      body.rotation.set(0, 0, 0);
      body.position.set(0, 0, 0);
      bob.position.set(0, 0, 0);
      bob.rotation.set(0, 0, 0);
      rider.rotation.set(0, 0, 0);
      for (const l of legs) l.rotation.set(0, 0, 0);
      if (state === 'dead') {
        body.rotation.z = PI / 2;
        body.position.y = 0.13;
        legs[0].rotation.x = 0.5;
        legs[2].rotation.x = -0.4;
        rider.rotation.x = -0.4;
        armL.rotation.set(-0.3, 0, 0.5);
        armR.rotation.set(-0.3, 0, -0.5);
        return;
      }
      if (state === 'walk') {
        const f = t * 11;
        for (let i = 0; i < 4; i++) legs[i].rotation.x = 0.7 * Math.sin(f + legPhase[i]);
        bob.position.y = 0.035 * Math.abs(Math.sin(f));
        bob.rotation.x = 0.06 * Math.sin(f + 0.5);
        rider.rotation.x = -0.06 * Math.sin(f + 0.5);
      } else if (state === 'idle') {
        // occasional hoof shift
        const c = frac(t * 0.2);
        if (c > 0.85) legs[0].rotation.x = Math.sin((c - 0.85) / 0.15 * PI) * 0.6;
      }
      const lean = poseArms(rig, state, t, 0, true);
      rider.rotation.x += lean;
    },
    dispose() {
      root.removeFromParent();
    },
  };
}

function createDeer(): UnitModel {
  const geos = deerGeos();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  body.add(mesh(geos.body));
  const neck = pivot(geos.neck, 0, 0.5, 0.22, body);
  const legs = [
    pivot(geos.leg, 0.045, 0.38, 0.16, body),
    pivot(geos.leg, -0.045, 0.38, 0.16, body),
    pivot(geos.leg, 0.045, 0.38, -0.16, body),
    pivot(geos.leg, -0.045, 0.38, -0.16, body),
  ];
  const phase = Math.random() * 20;
  return {
    root,
    animate(state, time) {
      const t = time + phase;
      body.position.set(0, 0, 0);
      body.rotation.set(0, 0, 0);
      neck.rotation.set(0, 0, 0);
      for (const l of legs) l.rotation.set(0, 0, 0);
      if (state === 'dead') {
        body.rotation.z = PI / 2;
        body.position.y = 0.08;
        neck.rotation.x = -0.6;
        legs[0].rotation.x = 0.4;
        legs[3].rotation.x = -0.4;
        return;
      }
      if (state === 'walk') {
        const f = t * 13;
        legs[0].rotation.x = legs[1].rotation.x = 0.8 * Math.sin(f);
        legs[2].rotation.x = legs[3].rotation.x = 0.8 * Math.sin(f + PI);
        body.position.y = 0.05 * Math.abs(Math.sin(f));
        body.rotation.x = 0.1 * Math.sin(f);
        neck.rotation.x = -0.1;
      } else {
        // graze: head down most of the time, look up now and then
        const c = frac(t / 7);
        let k: number;
        if (c < 0.1) k = ease(c / 0.1);
        else if (c < 0.7) k = 1;
        else if (c < 0.8) k = 1 - ease((c - 0.7) / 0.1);
        else k = 0;
        neck.rotation.x = 1.75 * k + (k > 0.9 ? 0.06 * Math.sin(t * 6) : 0);
        neck.rotation.y = k < 0.1 ? 0.3 * Math.sin(t * 0.9) : 0;
      }
    },
    dispose() {
      root.removeFromParent();
    },
  };
}

const humanCache = new Map<string, HumanDef>();
const riderCache = new Map<string, RiderDef>();

export function createUnitModel(type: UnitType | 'Deer', team: Team): UnitModel {
  if (type === 'Deer') return createDeer();
  if (type === 'Scout' || type === 'HorseArcher' || type === 'Cavalry') return createRider(type, team);
  return createHuman(type, team);
}
