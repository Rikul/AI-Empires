// Three.js world: terrain, water, natural resources, entity models, overlays and effects.
import * as THREE from 'three';
import { BUILDINGS, FARM_FOOD, Res, ResourceType, UNITS, UnitType, Biome } from '../../shared/rules';
import { hash2 } from '../../shared/rng';
import type { BuildingEnt, Entity, GameState, PlayerId, SimEvent, UnitEnt } from '../../shared/types';
import { entityVisibleTo } from '../../shared/sim';
import {
  createBuildingModel, createUnitModel, createTreeGeometry, createGoldMineGeometry, createStoneMineGeometry,
  createBerryBushGeometry, createMeatGeometry, createTreeStumpGeometry, TEAM_COLORS,
} from './models';
import type { UnitModel, BuildingModel } from './models';
import { applyFog, applyFogToObject, fogUniforms, FogTexture } from './fog';
import { terrainColor } from './palette';

export type Perspective = 'omni' | PlayerId;

interface View {
  id: number;
  kind: 'unit' | 'building';
  root: THREE.Group;
  unit?: UnitModel;
  building?: BuildingModel;
  px: number; py: number; // previous tick position
  cx: number; cy: number; // current tick position
  yaw: number;
  owner: number;
  type: string;
  seen: number;
}

interface Effect { obj: THREE.Object3D; t: number; dur: number; update: (f: number) => void }

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class World {
  scene = new THREE.Scene();
  size: number;
  terrain!: THREE.Mesh;
  water!: THREE.Mesh;
  views = new Map<number, View>();
  entityGroup = new THREE.Group();
  overlayGroup = new THREE.Group();
  fx: Effect[] = [];
  fog: Record<'omni' | 0 | 1, FogTexture>;
  sun: THREE.DirectionalLight;
  selection = new Set<number>();
  hover = 0;
  private rings = new Map<number, THREE.Mesh>();
  private bars = new Map<number, THREE.Group>();
  private buildBars = new Map<number, THREE.Group>();
  private resMeshes: { kind: number; mesh: THREE.InstancedMesh; tiles: Int32Array; shown: Uint8Array }[] = [];
  private stumpMesh: THREE.InstancedMesh | null = null;
  private stumpTiles: Int32Array | null = null;
  private stumpShown: Uint8Array | null = null;
  private meatMesh!: THREE.InstancedMesh;
  private lastResSync = -1;
  private lastFogTick = -1;
  private ringGeo = new THREE.RingGeometry(0.42, 0.5, 32);
  private ringMats: Record<string, THREE.MeshBasicMaterial> = {
    own: new THREE.MeshBasicMaterial({ color: 0x5cff5c, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    enemy: new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    gaia: new THREE.MeshBasicMaterial({ color: 0xffe14a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
    hover: new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide }),
  };
  ghost: THREE.Group | null = null;
  private arrowGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.6, 4).rotateX(Math.PI / 2);
  private arrowMat = new THREE.MeshBasicMaterial({ color: 0x3b2a1a });
  private spriteCache = new Map<string, THREE.SpriteMaterial>();
  time = 0;
  /** viewer side for PvA (own = green rings) */
  localPlayer: PlayerId | null = null;

  constructor(public state: GameState) {
    this.size = state.map.size;
    fogUniforms.uMapSize.value = this.size;
    this.fog = { omni: new FogTexture(this.size, 255), 0: new FogTexture(this.size, 0), 1: new FogTexture(this.size, 0) };
    fogUniforms.uFogTex.value = this.fog.omni.tex;
    this.scene.background = new THREE.Color(0x0b0d12);
    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x4a4030, 1.25);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 160;
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.buildTerrain();
    this.buildResources();
    this.scene.add(this.entityGroup);
    this.scene.add(this.overlayGroup);
    this.syncEntities(state, true);
  }

  // ---------------------------------------------------------------- terrain

  heightAt(x: number, y: number): number {
    const S = this.size;
    const h = this.state.map.height;
    const fx = Math.max(0, Math.min(S - 0.001, x)), fy = Math.max(0, Math.min(S - 0.001, y));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const V = S + 1;
    const a = h[y0 * V + x0], b = h[y0 * V + x0 + 1], c = h[(y0 + 1) * V + x0], d = h[(y0 + 1) * V + x0 + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  private buildTerrain() {
    const S = this.size;
    const V = S + 1;
    const m = this.state.map;
    const biome = this.state.config.biome;
    const pos = new Float32Array(V * V * 3);
    const col = new Float32Array(V * V * 3);
    const c = new THREE.Color();
    for (let y = 0; y <= S; y++) {
      for (let x = 0; x <= S; x++) {
        const vi = y * V + x;
        pos[vi * 3] = x;
        pos[vi * 3 + 1] = m.height[vi];
        pos[vi * 3 + 2] = y;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
          const tx = x + dx, ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= S || ty >= S) continue;
          terrainColor(biome, m.terrain[ty * S + tx], c);
          r += c.r; g += c.g; b += c.b; n++;
        }
        const jitter = 0.92 + hash2(x, y, 99) * 0.14;
        col[vi * 3] = (r / n) * jitter;
        col[vi * 3 + 1] = (g / n) * jitter;
        col[vi * 3 + 2] = (b / n) * jitter;
      }
    }
    const idx = new Uint32Array(S * S * 6);
    let k = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const a = y * V + x, b = a + 1, cc = a + V, d = cc + 1;
        idx[k++] = a; idx[k++] = cc; idx[k++] = b;
        idx[k++] = b; idx[k++] = cc; idx[k++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    applyFog(mat);
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.receiveShadow = true;
    this.terrain.name = 'terrain';
    this.scene.add(this.terrain);

    // water plane
    const wgeo = new THREE.PlaneGeometry(S, S, 1, 1).rotateX(-Math.PI / 2).translate(S / 2, -0.32, S / 2);
    const wcolor = biome === 'SnowyHighlands' ? 0x6f9fb8 : biome === 'DesertOasis' ? 0x2f9ab0 : 0x2f7fa8;
    const wmat = new THREE.MeshPhongMaterial({ color: wcolor, transparent: true, opacity: 0.78, shininess: 80, specular: 0x88aacc, depthWrite: false });
    applyFog(wmat);
    this.water = new THREE.Mesh(wgeo, wmat);
    this.water.renderOrder = 1;
    this.scene.add(this.water);

    // dark skirt around the map edges
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(S * 4, S * 4).rotateX(-Math.PI / 2).translate(S / 2, -1.2, S / 2), new THREE.MeshBasicMaterial({ color: 0x07080b }));
    this.scene.add(skirt);
  }

  private buildResources() {
    const S = this.size;
    const m = this.state.map;
    const biome = this.state.config.biome as Biome;
    const makeMat = () => { const mat = new THREE.MeshLambertMaterial({ vertexColors: true }); applyFog(mat); return mat; };
    const groups: { kind: number; variant: number; geo: THREE.BufferGeometry }[] = [
      { kind: Res.Tree, variant: 0, geo: createTreeGeometry(biome, 0) },
      { kind: Res.Tree, variant: 1, geo: createTreeGeometry(biome, 1) },
      { kind: Res.Tree, variant: 2, geo: createTreeGeometry(biome, 2) },
      { kind: Res.Gold, variant: 0, geo: createGoldMineGeometry() },
      { kind: Res.Stone, variant: 0, geo: createStoneMineGeometry() },
      { kind: Res.Berry, variant: 0, geo: createBerryBushGeometry() },
    ];
    const treeTiles: number[] = [];
    for (const g of groups) {
      const tiles: number[] = [];
      for (let i = 0; i < S * S; i++) {
        if (m.resType[i] !== g.kind) continue;
        if (g.kind === Res.Tree) {
          const v = Math.floor(hash2(i % S, Math.floor(i / S), 7) * 3);
          if (v !== g.variant) continue;
          treeTiles.push(i);
        }
        tiles.push(i);
      }
      if (!tiles.length) continue;
      const mesh = new THREE.InstancedMesh(g.geo, makeMat(), tiles.length);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const shown = new Uint8Array(tiles.length);
      tiles.forEach((t, k) => {
        this.tileMatrix(t, g.kind, tmpM, 1);
        mesh.setMatrixAt(k, tmpM);
        shown[k] = 1;
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.userData.resKind = g.kind;
      mesh.userData.tiles = Int32Array.from(tiles);
      this.scene.add(mesh);
      this.resMeshes.push({ kind: g.kind, mesh, tiles: Int32Array.from(tiles), shown });
    }
    if (treeTiles.length) {
      const st = new THREE.InstancedMesh(createTreeStumpGeometry(), makeMat(), treeTiles.length);
      this.stumpTiles = Int32Array.from(treeTiles);
      this.stumpShown = new Uint8Array(treeTiles.length);
      const zero = new THREE.Matrix4().makeScale(0, 0, 0);
      for (let k = 0; k < treeTiles.length; k++) st.setMatrixAt(k, zero);
      st.instanceMatrix.needsUpdate = true;
      this.stumpMesh = st;
      this.scene.add(st);
    }
    this.meatMesh = new THREE.InstancedMesh(createMeatGeometry(), makeMat(), 96);
    this.meatMesh.count = 0;
    this.scene.add(this.meatMesh);
  }

  private tileMatrix(t: number, kind: number, out: THREE.Matrix4, scale: number) {
    const S = this.size;
    const x = (t % S) + 0.5, y = Math.floor(t / S) + 0.5;
    const jx = kind === Res.Tree ? (hash2(t, 1, 3) - 0.5) * 0.3 : 0;
    const jy = kind === Res.Tree ? (hash2(t, 2, 3) - 0.5) * 0.3 : 0;
    const rot = hash2(t, 3, 3) * Math.PI * 2;
    const sc = scale * (kind === Res.Tree ? 0.85 + hash2(t, 4, 3) * 0.35 : 1);
    tmpQ.setFromAxisAngle(UP, rot);
    tmpV.set(x + jx, this.heightAt(x, y), y + jy);
    tmpS.set(sc, sc, sc);
    out.compose(tmpV, tmpQ, tmpS);
  }

  /** Show/hide natural resources to match the state (also handles rewinds). */
  private syncResources(s: GameState) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (const r of this.resMeshes) {
      let changed = false;
      for (let k = 0; k < r.tiles.length; k++) {
        const t = r.tiles[k];
        const has = s.map.resType[t] === r.kind && s.map.resAmt[t] > 0 ? 1 : 0;
        if (has !== r.shown[k]) {
          r.shown[k] = has;
          if (has) this.tileMatrix(t, r.kind, tmpM, 1); else tmpM.copy(zero);
          r.mesh.setMatrixAt(k, tmpM);
          changed = true;
        } else if (has && r.kind !== Res.Tree) {
          // mines shrink as they are depleted
          const full = r.kind === Res.Gold ? 450 : r.kind === Res.Stone ? 350 : 150;
          const f = 0.55 + 0.45 * Math.min(1, s.map.resAmt[t] / full);
          const q = Math.round(f * 10);
          if ((r.mesh.userData['q' + k] ?? 10) !== q) {
            r.mesh.userData['q' + k] = q;
            this.tileMatrix(t, r.kind, tmpM, q / 10);
            r.mesh.setMatrixAt(k, tmpM);
            changed = true;
          }
        }
      }
      if (changed) r.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.stumpMesh && this.stumpTiles && this.stumpShown) {
      let changed = false;
      for (let k = 0; k < this.stumpTiles.length; k++) {
        const t = this.stumpTiles[k];
        const stump = s.map.resType[t] === Res.Tree ? 0 : 1;
        if (stump !== this.stumpShown[k]) {
          this.stumpShown[k] = stump;
          if (stump) this.tileMatrix(t, Res.Tree, tmpM, 1); else tmpM.copy(zero);
          this.stumpMesh.setMatrixAt(k, tmpM);
          changed = true;
        }
      }
      if (changed) this.stumpMesh.instanceMatrix.needsUpdate = true;
    }
    let n = 0;
    const S = this.size;
    for (let i = 0; i < S * S && n < 96; i++) {
      if (s.map.resType[i] !== Res.Meat) continue;
      this.tileMatrix(i, Res.Meat, tmpM, 1);
      this.meatMesh.setMatrixAt(n++, tmpM);
    }
    this.meatMesh.count = n;
    this.meatMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- entities

  /** Called whenever the displayed state advanced by one tick. */
  onTick(s: GameState) {
    this.state = s;
    for (const v of this.views.values()) { v.px = v.cx; v.py = v.cy; }
    this.syncEntities(s, false);
    for (const e of s.events) this.spawnEventFx(e, s);
  }

  /** Called after a seek/jump: no interpolation. */
  onJump(s: GameState) {
    this.state = s;
    this.syncEntities(s, true);
    this.lastResSync = -1;
    this.lastFogTick = -1;
  }

  private syncEntities(s: GameState, snap: boolean) {
    const stamp = s.tick + 1;
    for (const e of s.entities) {
      let v = this.views.get(e.id);
      if (!v) { v = this.createView(e); snap = snap || false; }
      v.seen = stamp;
      if (e.kind === 'unit') {
        if (snap || v.seen === stamp && v.cx === -999) { v.px = e.x; v.py = e.y; }
        v.cx = e.x; v.cy = e.y;
        if (snap) { v.px = e.x; v.py = e.y; }
      }
    }
    for (const [id, v] of this.views) {
      if (v.seen !== stamp) {
        this.entityGroup.remove(v.root);
        v.unit?.dispose();
        v.building?.dispose();
        this.views.delete(id);
        const ring = this.rings.get(id);
        if (ring) { this.overlayGroup.remove(ring); this.rings.delete(id); }
        const bar = this.bars.get(id);
        if (bar) { this.overlayGroup.remove(bar); this.bars.delete(id); }
      }
    }
    if (s.tick !== this.lastResSync && (s.tick % 5 === 0 || this.lastResSync < 0 || snap)) {
      this.syncResources(s);
      this.lastResSync = s.tick;
    }
  }

  private createView(e: Entity): View {
    const root = new THREE.Group();
    const team = (e.owner === -1 ? -1 : e.owner) as 0 | 1 | -1;
    const v: View = { id: e.id, kind: e.kind, root, px: -999, py: -999, cx: -999, cy: -999, yaw: 0, owner: e.owner, type: e.type, seen: 0 };
    if (e.kind === 'unit') {
      v.unit = createUnitModel(e.type as UnitType | 'Deer', team);
      root.add(v.unit.root);
      v.px = v.cx = e.x; v.py = v.cy = e.y;
      v.yaw = Math.atan2(e.dirX, e.dirY);
    } else {
      v.building = createBuildingModel(e.type, team);
      root.add(v.building.root);
      const sz = BUILDINGS[e.type].size;
      const cx = e.tx + sz / 2, cy = e.ty + sz / 2;
      let h = 0, n = 0;
      for (let y = e.ty; y <= e.ty + sz; y++) for (let x = e.tx; x <= e.tx + sz; x++) { h += this.state.map.height[y * (this.size + 1) + x]; n++; }
      root.position.set(cx, h / n, cy);
      v.px = v.cx = cx; v.py = v.cy = cy;
    }
    root.userData.entityId = e.id;
    root.traverse((o) => { o.userData.entityId = e.id; });
    applyFogToObject(root);
    this.entityGroup.add(root);
    this.views.set(e.id, v);
    return v;
  }

  /** Per-frame update: interpolation, animation, overlays. alpha in [0,1]. */
  frame(s: GameState, alpha: number, dt: number) {
    this.time += dt;
    for (const e of s.entities) {
      const v = this.views.get(e.id);
      if (!v) continue;
      if (e.kind === 'unit') {
        const x = v.px + (v.cx - v.px) * alpha, y = v.py + (v.cy - v.py) * alpha;
        const sink = e.hp <= 0 ? (1 - e.deadTicks / 25) * 0.35 : 0;
        v.root.position.set(x, this.heightAt(x, y) - sink, y);
        const target = Math.atan2(e.dirX, e.dirY);
        let d = target - v.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        v.yaw += d * Math.min(1, dt * 12);
        v.root.rotation.y = v.yaw;
        v.unit!.animate(e.hp <= 0 ? 'dead' : e.anim, this.time + e.id * 0.37, e.carry >= 1 ? e.carryType : null, e.gatherKind);
      } else {
        const def = BUILDINGS[e.type];
        v.building!.setConstruction(e.built ? 1 : e.progress / def.buildTime, e.built);
        if (e.type === 'Farm') v.building!.setFarmFraction(e.food / FARM_FOOD);
        v.building!.animate(this.time);
      }
    }
    // effects
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      f.update(k);
      if (k >= 1) {
        this.scene.remove(f.obj);
        this.fx.splice(i, 1);
      }
    }
    this.updateRings(s);
  }

  /** Visibility and fog for one viewport's perspective. */
  prepareView(s: GameState, persp: Perspective, camera: THREE.Camera) {
    fogUniforms.uFogTex.value = this.fog[persp].tex;
    for (const e of s.entities) {
      const v = this.views.get(e.id);
      if (!v) continue;
      let vis = true;
      if (persp !== 'omni' && e.owner !== persp) {
        if (e.kind === 'building') vis = e.owner === -1 || !!s.players[persp].memory[e.id] || entityVisibleTo(s, persp, e);
        else vis = entityVisibleTo(s, persp, e);
      }
      v.root.visible = vis;
      const ring = this.rings.get(e.id);
      if (ring) ring.visible = vis;
      const bar = this.bars.get(e.id);
      if (bar) { bar.visible = vis; bar.quaternion.copy(camera.quaternion); }
      const bb = this.buildBars.get(e.id);
      if (bb) { bb.visible = vis; bb.quaternion.copy(camera.quaternion); }
    }
    for (const f of this.fx) {
      if (f.obj.userData.fogPos) {
        const [x, y] = f.obj.userData.fogPos;
        f.obj.visible = persp === 'omni' || s.derived.visible[persp][Math.floor(y) * this.size + Math.floor(x)] === 1;
      }
      if (f.obj.userData.billboard) f.obj.quaternion.copy(camera.quaternion);
    }
  }

  updateFog(s: GameState) {
    if (s.tick === this.lastFogTick) return;
    this.lastFogTick = s.tick;
    this.fog[0].update(s.players[0].explored, s.derived.visible[0]);
    this.fog[1].update(s.players[1].explored, s.derived.visible[1]);
  }

  // ---------------------------------------------------------------- overlays

  private updateRings(s: GameState) {
    const want = new Set<number>(this.selection);
    if (this.hover) want.add(this.hover);
    for (const [id, r] of this.rings) {
      if (!want.has(id) || !s.derived.byId.get(id) || (s.derived.byId.get(id)!.hp <= 0)) {
        this.overlayGroup.remove(r);
        this.rings.delete(id);
      }
    }
    // construction progress bars are always shown above foundations
    const building = new Set<number>();
    for (const e of s.entities) {
      if (e.kind !== 'building' || e.built || e.hp <= 0) continue;
      const v = this.views.get(e.id);
      if (!v) continue;
      building.add(e.id);
      let bar = this.buildBars.get(e.id);
      if (!bar) {
        bar = makeBar();
        ((bar.userData.fg as THREE.Mesh).material as THREE.MeshBasicMaterial).color.setHex(0xf0b030);
        bar.userData.build = true;
        this.overlayGroup.add(bar);
        this.buildBars.set(e.id, bar);
      }
      const d = BUILDINGS[e.type];
      const f = Math.max(0, Math.min(1, e.progress / d.buildTime));
      const fg = bar.userData.fg as THREE.Mesh;
      bar.scale.set(Math.max(1, d.size * 0.7), Math.max(1, d.size * 0.7) * 1.6, 1);
      fg.scale.x = Math.max(0.001, f);
      fg.position.x = -(1 - f) / 2;
      bar.position.set(v.root.position.x, v.root.position.y + (e.type === 'WatchTower' ? 2.2 : d.size * 0.5 + 0.8) + (this.selection.has(e.id) ? 0.35 : 0), v.root.position.z);
    }
    for (const [id, b] of this.buildBars) if (!building.has(id)) { this.overlayGroup.remove(b); this.buildBars.delete(id); }
    for (const [id, b] of this.bars) {
      const e = s.derived.byId.get(id);
      if (!this.selection.has(id) || !e || e.hp <= 0) { this.overlayGroup.remove(b); this.bars.delete(id); }
    }
    for (const id of want) {
      const e = s.derived.byId.get(id);
      const v = this.views.get(id);
      if (!e || !v || e.hp <= 0) continue;
      let r = this.rings.get(id);
      const kind = !this.selection.has(id) ? 'hover' : e.owner === -1 ? 'gaia' : this.localPlayer === null || e.owner === this.localPlayer ? 'own' : 'enemy';
      if (!r) {
        r = new THREE.Mesh(this.ringGeo, this.ringMats[kind]);
        r.rotation.x = -Math.PI / 2;
        r.renderOrder = 2;
        this.overlayGroup.add(r);
        this.rings.set(id, r);
      }
      r.material = this.ringMats[kind];
      const scale = e.kind === 'building' ? BUILDINGS[e.type].size * 0.85 : e.kind === 'unit' && e.type !== 'Deer' && UNITS[e.type as UnitType].mounted ? 1.4 : 1;
      r.scale.setScalar(scale);
      r.position.set(v.root.position.x, v.root.position.y + 0.06, v.root.position.z);
      if (this.selection.has(id)) {
        let bar = this.bars.get(id);
        if (!bar) { bar = makeBar(); this.overlayGroup.add(bar); this.bars.set(id, bar); }
        const maxHp = e.kind === 'unit' ? (e.type === 'Deer' ? 8 : UNITS[e.type as UnitType].hp) : BUILDINGS[e.type].hp;
        const f = Math.max(0, Math.min(1, e.hp / maxHp));
        const mounted = e.kind === 'unit' && e.type !== 'Deer' && UNITS[e.type as UnitType].mounted;
        const height = e.kind === 'unit' ? (mounted ? 1.6 : 1.25) : e.type === 'WatchTower' ? 3.6 : e.type === 'Farm' || e.type === 'Wall' ? 1.6 : BUILDINGS[e.type].size * 0.8 + 1;
        setBar(bar, f, e.kind === 'unit' ? 0.75 : Math.max(1, BUILDINGS[e.type].size * 0.7));
        bar.position.set(v.root.position.x, v.root.position.y + height, v.root.position.z);
      }
    }
  }

  setGhost(type: string | null, tx = 0, ty = 0, ok = true, wallTiles?: [number, number][]) {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
    if (!type) return;
    const def = BUILDINGS[type as keyof typeof BUILDINGS];
    const g = new THREE.Group();
    const tiles = wallTiles ?? [[tx, ty]];
    const mat = new THREE.MeshBasicMaterial({ color: ok ? 0x55ff66 : 0xff4444, transparent: true, opacity: 0.35, depthWrite: false });
    for (const [x, y] of tiles) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(def.size, type === 'Farm' ? 0.1 : 0.9, def.size), mat);
      box.position.set(x + def.size / 2, this.heightAt(x + def.size / 2, y + def.size / 2) + (type === 'Farm' ? 0.05 : 0.45), y + def.size / 2);
      g.add(box);
    }
    this.ghost = g;
    this.scene.add(g);
  }

  marker(x: number, y: number, color: number) {
    const geo = new THREE.RingGeometry(0.3, 0.42, 24);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, this.heightAt(x, y) + 0.08, y);
    m.renderOrder = 3;
    this.scene.add(m);
    this.fx.push({ obj: m, t: 0, dur: 0.7, update: (k) => { m.scale.setScalar(1.6 - k); mat.opacity = 1 - k; } });
  }

  private spawnEventFx(e: SimEvent, s: GameState) {
    if (e.type === 'attack' && e.ranged && e.x !== undefined) {
      const from = new THREE.Vector3(e.x, this.heightAt(e.x, e.y!) + (this.views.get(e.src!)?.kind === 'building' ? 2.5 : 0.7), e.y!);
      const to = new THREE.Vector3(e.x2!, this.heightAt(e.x2!, e.y2!) + 0.5, e.y2!);
      const a = new THREE.Mesh(this.arrowGeo, this.arrowMat);
      const dist = from.distanceTo(to);
      a.userData.fogPos = [e.x2, e.y2];
      this.scene.add(a);
      const dur = Math.max(0.15, dist / 18);
      const prev = new THREE.Vector3();
      this.fx.push({
        obj: a, t: 0, dur, update: (k) => {
          prev.copy(a.position);
          a.position.lerpVectors(from, to, k);
          a.position.y += Math.sin(k * Math.PI) * dist * 0.12;
          if (k > 0) a.lookAt(a.position.clone().add(a.position.clone().sub(prev)));
        },
      });
    } else if (e.type === 'deposit' && e.amount && e.x !== undefined) {
      const sp = this.textSprite(`+${e.amount}`, RES_COLORS[e.res!] ?? '#fff');
      sp.position.set(e.x, this.heightAt(e.x, e.y!) + 1.2, e.y!);
      sp.userData.fogPos = [e.x, e.y];
      this.scene.add(sp);
      this.fx.push({ obj: sp, t: 0, dur: 1.2, update: (k) => { sp.position.y += 0.012; (sp.material as THREE.SpriteMaterial).opacity = 1 - k * k; } });
    } else if (e.type === 'destroyed' && e.x !== undefined) {
      this.dust(e.x, e.y!, 2.2);
    } else if (e.type === 'built' && e.src) {
      const b = s.derived.byId.get(e.src);
      if (b && b.kind === 'building') { const [x, y] = [b.tx + BUILDINGS[b.type].size / 2, b.ty + BUILDINGS[b.type].size / 2]; this.dust(x, y, 0.8); }
    }
  }

  private dust(x: number, y: number, scale: number) {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: 0x9a8f80, transparent: true, opacity: 0.8, depthWrite: false });
    const geo = new THREE.IcosahedronGeometry(0.35, 0);
    const parts: { m: THREE.Mesh; vx: number; vz: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(geo, mat);
      const a = (i / 10) * Math.PI * 2;
      parts.push({ m, vx: Math.cos(a) * scale, vz: Math.sin(a) * scale });
      g.add(m);
    }
    g.position.set(x, this.heightAt(x, y) + 0.3, y);
    g.userData.fogPos = [x, y];
    this.scene.add(g);
    this.fx.push({ obj: g, t: 0, dur: 1.4, update: (k) => {
      for (const p of parts) { p.m.position.set(p.vx * k, k * 1.2 * scale * 0.5, p.vz * k); p.m.scale.setScalar(0.6 + k * scale * 0.6); }
      mat.opacity = 0.8 * (1 - k);
    } });
  }

  private textSprite(text: string, color: string): THREE.Sprite {
    const key = text + color;
    let mat = this.spriteCache.get(key);
    if (!mat) {
      const c = document.createElement('canvas');
      c.width = 128; c.height = 64;
      const g = c.getContext('2d')!;
      g.font = 'bold 40px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.strokeText(text, 64, 32);
      g.fillStyle = color;
      g.fillText(text, 64, 32);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      this.spriteCache.set(key, mat);
    }
    const sp = new THREE.Sprite(mat.clone());
    sp.scale.set(1.2, 0.6, 1);
    sp.renderOrder = 5;
    return sp;
  }

  /** Entity id under a raycast, if any. */
  pickEntity(ray: THREE.Raycaster): number {
    const hits = ray.intersectObjects(this.entityGroup.children.filter((c) => c.visible), true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o && !o.visible) o = o.parent;
      const id = h.object.userData.entityId;
      if (id) return id;
    }
    return 0;
  }

  pickGround(ray: THREE.Raycaster): THREE.Vector3 | null {
    const hits = ray.intersectObject(this.terrain, false);
    if (hits.length) return hits[0].point;
    // fall back to the water plane height
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.3);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(plane, p) ? p : null;
  }

  pickResourceTile(ray: THREE.Raycaster): number {
    const meshes = this.resMeshes.map((r) => r.mesh);
    const hits = ray.intersectObjects(meshes, false);
    for (const h of hits) {
      const tiles = (h.object as THREE.InstancedMesh).userData.tiles as Int32Array;
      if (h.instanceId !== undefined && tiles) {
        const t = tiles[h.instanceId];
        if (this.state.map.resType[t]) return t;
      }
    }
    return -1;
  }

  focusShadow(x: number, z: number) {
    this.sun.position.set(x + 30, 60, z + 20);
    this.sun.target.position.set(x, 0, z);
    this.sun.target.updateMatrixWorld();
  }

  unitScreenPositions(camera: THREE.Camera, w: number, h: number, s: GameState, filter: (u: UnitEnt) => boolean): { id: number; sx: number; sy: number; type: string }[] {
    const out: { id: number; sx: number; sy: number; type: string }[] = [];
    for (const e of s.entities) {
      if (e.kind !== 'unit' || e.hp <= 0 || !filter(e)) continue;
      const v = this.views.get(e.id);
      if (!v || !v.root.visible) continue;
      tmpV.copy(v.root.position);
      tmpV.y += 0.5;
      tmpV.project(camera);
      if (tmpV.z > 1) continue;
      out.push({ id: e.id, sx: (tmpV.x + 1) / 2 * w, sy: (1 - tmpV.y) / 2 * h, type: e.type });
    }
    return out;
  }

  buildingAt(b: BuildingEnt) { return this.views.get(b.id); }

  dispose() {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
    });
  }
}

export const RES_COLORS: Record<ResourceType, string> = { food: '#ff8a7a', wood: '#d9a066', gold: '#ffd84a', stone: '#c8d0d8' };

export function teamCss(p: number) { return p === 0 ? '#3d7bff' : p === 1 ? '#ff4a3d' : '#cccccc'; }
export { TEAM_COLORS };

function makeBar(): THREE.Group {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 0.13), new THREE.MeshBasicMaterial({ color: 0x111111, depthTest: false, transparent: true, opacity: 0.85 }));
  const fg = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.08), new THREE.MeshBasicMaterial({ color: 0x44dd44, depthTest: false, transparent: true }));
  fg.position.z = 0.001;
  bg.renderOrder = 10; fg.renderOrder = 11;
  g.add(bg, fg);
  g.userData.fg = fg;
  return g;
}

function setBar(g: THREE.Group, f: number, width: number) {
  const fg = g.userData.fg as THREE.Mesh;
  g.scale.set(width, width * 1.6, 1);
  fg.scale.x = Math.max(0.001, f);
  fg.position.x = -(1 - f) / 2;
  (fg.material as THREE.MeshBasicMaterial).color.setHex(f > 0.6 ? 0x44dd44 : f > 0.3 ? 0xe8c33a : 0xe04040);
}
