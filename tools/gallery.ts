// Model gallery: `cd tools && npx vite --port 5199` then open /gallery.html
// URL params: view=overview|units|anims|buildings|construction|resources|<UnitType>|<BuildingType>
//             t=<seconds> freezes time (for screenshots); anim=idle|walk|attack|...; dist=<camera distance>; az=<deg>
import * as THREE from 'three';
import {
  createUnitModel, createBuildingModel, createTreeGeometry, createGoldMineGeometry, createStoneMineGeometry,
  createBerryBushGeometry, createMeatGeometry, createTreeStumpGeometry, MODEL_MATERIAL,
} from '../src/client/render/models/index';
import type { UnitModel, BuildingModel, AnimState, GatherKind, Team } from '../src/client/render/models/index';
import { UNIT_TYPES, BUILDING_TYPES, BIOMES, BUILDINGS } from '../src/shared/rules';
import type { ResourceType, UnitType, BuildingType } from '../src/shared/rules';

const params = new URLSearchParams(location.search);
const view = params.get('view') ?? 'overview';
const fixedT = params.has('t') ? parseFloat(params.get('t')!) : null;
const animParam = (params.get('anim') ?? 'cycle') as AnimState | 'cycle';

const hud = document.getElementById('hud')!;
hud.innerHTML = ['village', 'overview', 'units', 'anims', 'buildings', 'construction', 'resources', 'villagers']
  .map((v) => `<a href="?view=${v}">${v}</a>`).join('') + ` | view=${view}`;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9cc8e8);
scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a2a, 1.3));
const sun = new THREE.DirectionalLight(0xfff2d8, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const sc = sun.shadow.camera;
sc.left = -40; sc.right = 40; sc.top = 40; sc.bottom = -40; sc.near = 1; sc.far = 150;
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ color: 0x6f9a48 }));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 500);

function label(text: string, x: number, z: number, size = 0.35, y = 0.02): void {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, 0, 512, 64);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 34);
  const tex = new THREE.CanvasTexture(c);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 8, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  scene.add(m);
}

interface UnitEntry { m: UnitModel; state: AnimState | 'cycle'; carry: ResourceType | null; gather: GatherKind }
const units: UnitEntry[] = [];
const buildings: { m: BuildingModel; farm?: boolean }[] = [];

function addUnit(type: UnitType | 'Deer', team: Team, x: number, z: number, state: AnimState | 'cycle' = animParam, carry: ResourceType | null = null, gather: GatherKind = null, rotY = 0): void {
  const m = createUnitModel(type, team);
  m.root.position.set(x, 0, z);
  m.root.rotation.y = rotY;
  scene.add(m.root);
  units.push({ m, state, carry, gather });
}
function addBuilding(type: BuildingType, team: Team, x: number, z: number, progress = 1, built = true, farmFrac = 1): void {
  const m = createBuildingModel(type, team);
  m.root.position.set(x, 0, z);
  m.setConstruction(progress, built);
  m.setFarmFraction(farmFrac);
  scene.add(m.root);
  buildings.push({ m });
}
function addRes(geo: THREE.BufferGeometry, x: number, z: number): void {
  const m = new THREE.Mesh(geo, MODEL_MATERIAL);
  m.position.set(x, 0, z);
  m.castShadow = true;
  m.receiveShadow = true;
  scene.add(m);
}

const ALL_UNITS: (UnitType | 'Deer')[] = [...UNIT_TYPES, 'Deer'];
let focus = new THREE.Vector3();
let dist = 20;

function layoutUnits(ox: number, oz: number, spacing = 1.3): THREE.Vector3 {
  ALL_UNITS.forEach((t, i) => {
    const x = ox + i * spacing;
    addUnit(t, t === 'Deer' ? -1 : 0, x, oz);
    if (t !== 'Deer') addUnit(t, 1, x, oz + 1.6);
    label(t, x, oz + 2.5, 0.22);
  });
  return new THREE.Vector3(ox + (ALL_UNITS.length - 1) * spacing / 2, 0.4, oz + 0.8);
}
function layoutBuildings(ox: number, oz: number): THREE.Vector3 {
  let x = ox;
  for (const t of BUILDING_TYPES) {
    const s = BUILDINGS[t].size;
    addBuilding(t, 0, x + s / 2, oz);
    addBuilding(t, 1, x + s / 2, oz + 4.2);
    label(t, x + s / 2, oz + 2.0, 0.3);
    x += s + 0.8;
  }
  return new THREE.Vector3((ox + x) / 2, 0.5, oz + 2.1);
}
function layoutResources(ox: number, oz: number): THREE.Vector3 {
  BIOMES.forEach((b, row) => {
    const z = oz + row * 1.7;
    for (let v = 0; v < 3; v++) addRes(createTreeGeometry(b, v), ox + v * 1.2, z);
    label(b, ox - 2.4, z, 0.25);
  });
  const z = oz + BIOMES.length * 1.7;
  const extras: [string, THREE.BufferGeometry][] = [
    ['Gold', createGoldMineGeometry()], ['Stone', createStoneMineGeometry()], ['Berry', createBerryBushGeometry()],
    ['Meat', createMeatGeometry()], ['Stump', createTreeStumpGeometry()],
  ];
  extras.forEach(([n, g], i) => {
    addRes(g, ox - 1.2 + i * 1.2, z);
    label(n, ox - 1.2 + i * 1.2, z + 0.75, 0.18);
  });
  return new THREE.Vector3(ox + 1.2, 0.5, oz + 4.5);
}

const STATES: AnimState[] = ['idle', 'walk', 'attack', 'gather', 'build', 'dead'];

if (view === 'overview') {
  const a = layoutUnits(-7, 6, 1.3);
  const b = layoutBuildings(-22, -4);
  layoutResources(20, -4);
  focus.set((a.x + b.x) / 2 + 4, 0, 1);
  dist = 48;
} else if (view === 'units') {
  focus = layoutUnits(0, 0, 1.25);
  dist = 11;
} else if (view === 'anims') {
  ALL_UNITS.forEach((t, i) => {
    STATES.forEach((s, j) => {
      addUnit(t, (t === 'Deer' ? -1 : i % 2) as Team, i * 1.25, j * 1.4, s, null, t === 'Villager' ? 'wood' : null, 0.5);
    });
    label(t, i * 1.25, -0.9, 0.2);
  });
  STATES.forEach((s, j) => label(s, -1.6, j * 1.4, 0.22));
  focus.set(6, 0, 3.5);
  dist = 14;
} else if (view === 'villagers') {
  const combos: [AnimState, ResourceType | null, GatherKind][] = [
    ['idle', null, null], ['walk', 'wood', null], ['walk', 'food', null], ['walk', 'gold', null], ['walk', 'stone', null],
    ['gather', null, 'wood'], ['gather', null, 'gold'], ['gather', null, 'food'], ['gather', null, 'farm'], ['build', null, null],
  ];
  combos.forEach(([s, c, gk], i) => {
    addUnit('Villager', 0, i * 1.0, 0, s, c, gk, 0.6);
    addUnit('Villager', 1, i * 1.0, 1.4, s, c, gk, -0.6);
    label(`${s} ${c ?? gk ?? ''}`, i * 1.0, 2.3, 0.14);
  });
  focus.set(4.5, 0.4, 0.8);
  dist = 7.5;
} else if (view === 'buildings') {
  focus = layoutBuildings(0, 0);
  dist = 30;
} else if (view === 'construction') {
  addBuilding('TownCenter', 0, 0, 0, 0.4, false);
  addBuilding('Barracks', 1, 4.5, 0, 0.4, false);
  addBuilding('House', 0, 8, 0, 0.7, false);
  addBuilding('WatchTower', 1, 10.5, 0, 0.5, false);
  addBuilding('Farm', 0, 0, 4.5, 1, true, 0.3);
  addBuilding('Farm', 1, 4.5, 4.5, 1, true, 1);
  addBuilding('Farm', 0, 9, 4.5, 0.5, false);
  addBuilding('Granary', 0, 0, -4, 0.0, false);
  addBuilding('Stable', 1, 4.5, -4, 0.15, false);
  for (let i = 0; i < 6; i++) addBuilding('Wall', i % 2 as Team, 7.5 + i, -4, 1, true);
  addBuilding('Wall', 0, 7.5, -3, 0.5, false);
  focus.set(5, 0, 0.5);
  dist = 20;
} else if (view === 'village') {
  // mock game scene at real RTS distances
  addBuilding('TownCenter', 0, 0, 0);
  addBuilding('House', 0, -3.5, -2);
  addBuilding('House', 0, -3.5, 0.5);
  addBuilding('Granary', 0, 4, -2.5);
  addBuilding('Farm', 0, 4.5, 1, 1, true, 0.7);
  addBuilding('Barracks', 0, -1, -4.5);
  addBuilding('StoragePit', 0, -6, 4);
  addBuilding('WatchTower', 0, 2.5, 4.5);
  addBuilding('House', 0, 0, 4.5, 0.45, false);
  for (let i = 0; i < 6; i++) addBuilding('Wall', 0, -8 + i, -6);
  const BIOME = 'TemperateGrasslands';
  for (let i = 0; i < 14; i++) addRes(createTreeGeometry(BIOME, i % 3), -9 + (i % 4) * 0.9, 1 + Math.floor(i / 4) * 1.0);
  addRes(createGoldMineGeometry(), 7.5, 4.5); addRes(createGoldMineGeometry(), 8.5, 4.5);
  addRes(createStoneMineGeometry(), 7.5, -5);
  addRes(createBerryBushGeometry(), -4, 6); addRes(createBerryBushGeometry(), -3, 6.3);
  addUnit('Villager', 0, -6.5, 1.5, 'gather', null, 'wood', 1.6);
  addUnit('Villager', 0, -6.0, 2.5, 'walk', 'wood', null, 0.8);
  addUnit('Villager', 0, 4.5, 1.2, 'gather', null, 'farm', 0.3);
  addUnit('Villager', 0, 7.4, 3.8, 'gather', null, 'gold', 3.0);
  addUnit('Villager', 0, -3.6, 5.5, 'gather', null, 'food', 3.0);
  addUnit('Villager', 0, 0.9, 4.0, 'build', null, null, 3.6);
  addUnit('Villager', 0, 1.8, 1.8, 'walk', 'gold', null, -2.2);
  const army: (UnitType)[] = ['Swordsman', 'Spearman', 'Bowman', 'Skirmisher', 'Clubman', 'Centurion', 'Scout', 'Cavalry', 'HorseArcher'];
  army.forEach((t, i) => {
    addUnit(t, 0, 7 + (i % 3) * 0.8, -1.5 + Math.floor(i / 3) * 0.9, 'attack', null, null, Math.PI / 2);
    addUnit(t, 1, 10 + (i % 3) * 0.8, -1.5 + Math.floor(i / 3) * 0.9, i % 2 ? 'attack' : 'walk', null, null, -Math.PI / 2);
  });
  addUnit('Deer', -1, -7, 7, 'idle'); addUnit('Deer', -1, -6.2, 7.5, 'walk', null, null, 1);
  addBuilding('Barracks', 1, 13, -4); addBuilding('House', 1, 13, 1);
  focus.set(2, 0, 0.5);
  dist = 25;
} else if (view === 'resources') {
  focus = layoutResources(0, 0);
  dist = 14;
} else if ((UNIT_TYPES as string[]).includes(view) || view === 'Deer') {
  const t = view as UnitType | 'Deer';
  STATES.forEach((s, j) => {
    addUnit(t, 0, j * 1.3, 0, s, null, 'wood', 0.6);
    if (t !== 'Deer') addUnit(t, 1, j * 1.3, 1.5, s, null, 'gold', -0.6);
    label(s, j * 1.3, 2.4, 0.15);
  });
  focus.set(3.25, 0.4, 0.8);
  dist = 6.5;
} else if ((BUILDING_TYPES as string[]).includes(view)) {
  const t = view as BuildingType;
  const s = BUILDINGS[t].size;
  addBuilding(t, 0, 0, 0);
  addBuilding(t, 1, s + 1, 0);
  addBuilding(t, 0, 2 * (s + 1), 0, 0.4, false);
  focus.set(s + 1, 0.4, 0);
  dist = s * 3 + 4;
}
if (params.has('dist')) dist = parseFloat(params.get('dist')!);
const az = (parseFloat(params.get('az') ?? '0') * Math.PI) / 180;
const pitch = (50 * Math.PI) / 180;
camera.position.set(
  focus.x + Math.sin(az) * Math.cos(pitch) * dist,
  focus.y + Math.sin(pitch) * dist,
  focus.z + Math.cos(az) * Math.cos(pitch) * dist,
);
camera.lookAt(focus);
sun.position.set(focus.x + 15, 30, focus.z + 10);
sun.target.position.copy(focus);

const clock = new THREE.Clock();
function frame(): void {
  const t = fixedT ?? clock.getElapsedTime();
  const cycleState = STATES[Math.floor(t / 3) % 5];
  for (const u of units) {
    const st = u.state === 'cycle' ? cycleState : u.state;
    u.m.animate(st, t, u.carry, u.gather);
  }
  for (const b of buildings) b.m.animate(t);
  renderer.render(scene, camera);
}
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
if (fixedT !== null) {
  frame();
  (window as unknown as { __ready: boolean }).__ready = true;
} else {
  renderer.setAnimationLoop(frame);
  setTimeout(() => ((window as unknown as { __ready: boolean }).__ready = true), 500);
}
