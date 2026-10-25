// Deterministic lockstep simulation. All game rules live here and apply identically
// to both sides regardless of whether a human or an LLM issues the orders.
import { generateMap } from './mapgen';
import { findPath, lineClear } from './pathfind';
import { rngNext } from './rng';
import {
  BUILD_RATE, BUILDINGS, BuildingType, CARRY_CAPACITY, Cost, costValue, FARM_FOOD, GAIA_UNITS, GATHER_RATE,
  REPAIR_HP_PER_SEC, Res, RES_YIELD, resBlocks, ResourceType, STARTING_RESOURCES, STARTING_VILLAGERS, TECHS,
  TechType, terrainBuildable, terrainPassable, TICK_DT, TICK_RATE, UnitType, UNITS,
} from './rules';
import type {
  BuildingEnt, Command, Derived, Entity, GameState, MatchConfig, Order, Owner, PlayerId, PlayerState, UnitEnt,
} from './types';
import { applyAiCommands } from './ai/apply';

export const VIS_INTERVAL = 5;
const PATH_BUDGET_PER_TICK = 60000;
const BUILDING_MELEE_ARMOR = 1;
const BUILDING_PIERCE_ARMOR = 6;

// ---------------------------------------------------------------------------
// Construction of state

export function createInitialState(config: MatchConfig): GameState {
  const gm = generateMap(config.seed, config.mapSize, config.biome, config.generationVersion);
  const N = gm.size * gm.size;
  const mkPlayer = (): PlayerState => ({
    res: { ...STARTING_RESOURCES },
    techs: [],
    explored: new Uint8Array(N),
    memory: {},
    groups: {},
    plan: '',
    feedback: [],
    alerts: [],
    stats: { gathered: { food: 0, wood: 0, gold: 0, stone: 0 }, trained: 0, built: 0, killed: 0, lost: 0 },
    lastAttackedTick: -9999,
  });
  const state: GameState = {
    tick: 0,
    config,
    map: { size: gm.size, terrain: gm.terrain, height: gm.height, resType: gm.resType, resAmt: gm.resAmt, starts: gm.starts },
    players: [mkPlayer(), mkPlayer()],
    entities: [],
    nextId: 1,
    rng: (gm.size * 7919) ^ 0x5eed,
    result: null,
    derived: emptyDerived(N),
    events: [],
  };
  rebuildDerived(state);
  for (const p of [0, 1] as PlayerId[]) {
    const [cx, cy] = gm.starts[p];
    const tc = addBuilding(state, p, 'TownCenter', cx - 1, cy - 1, true);
    // villagers spread around the TC, scout a bit further toward the map center
    const ring = spawnRing(state, tc, gm.size / 2, gm.size / 2);
    for (let i = 0; i < STARTING_VILLAGERS; i++) {
      const t = ring[i % ring.length];
      addUnit(state, p, 'Villager', (t % gm.size) + 0.5, Math.floor(t / gm.size) + 0.5);
    }
    const st = ring[Math.min(ring.length - 1, STARTING_VILLAGERS + 2)];
    addUnit(state, p, 'Scout', (st % gm.size) + 0.5, Math.floor(st / gm.size) + 0.5);
  }
  for (const d of gm.deer) addUnit(state, -1, 'Deer', d.x, d.y);
  updateVisibility(state);
  return state;
}

export function emptyDerived(N: number): Derived {
  return {
    byId: new Map(),
    bgrid: new Int32Array(N),
    fgrid: new Int32Array(N),
    visible: [new Uint8Array(N), new Uint8Array(N)],
    blockVersion: 0,
    pathBudget: PATH_BUDGET_PER_TICK,
  };
}

export function rebuildDerived(s: GameState) {
  const N = s.map.size * s.map.size;
  const d = s.derived.bgrid.length === N ? s.derived : emptyDerived(N);
  d.byId = new Map();
  d.bgrid.fill(0);
  d.fgrid.fill(0);
  for (const e of s.entities) {
    d.byId.set(e.id, e);
    if (e.kind === 'building') stampBuilding(s, d, e, true);
  }
  d.blockVersion++;
  s.derived = d;
}

function stampBuilding(s: GameState, d: Derived, b: BuildingEnt, on: boolean) {
  const def = BUILDINGS[b.type];
  const S = s.map.size;
  const grid = def.blocking ? d.bgrid : d.fgrid;
  for (let y = b.ty; y < b.ty + def.size; y++) {
    for (let x = b.tx; x < b.tx + def.size; x++) {
      grid[y * S + x] = on ? b.id + 1 : 0;
    }
  }
  d.blockVersion++;
}

export function addUnit(s: GameState, owner: Owner, type: UnitEnt['type'], x: number, y: number): UnitEnt {
  const hp = type === 'Deer' ? GAIA_UNITS.Deer.hp : UNITS[type].hp;
  const u: UnitEnt = {
    kind: 'unit', id: s.nextId++, owner, type, x, y, hp, order: null, autoTarget: 0,
    path: null, pathI: 0, pathGoal: -1, repath: 0, carryType: null, carry: 0, cd: 0, anim: 'idle',
    dirX: 0, dirY: 1, gatherKind: null, returnTo: -1, stuck: 0, lastX: x, lastY: y, deadTicks: 0,
  };
  s.entities.push(u);
  s.derived.byId.set(u.id, u);
  return u;
}

export function addBuilding(s: GameState, owner: Owner, type: BuildingType, tx: number, ty: number, built: boolean): BuildingEnt {
  const def = BUILDINGS[type];
  const b: BuildingEnt = {
    kind: 'building', id: s.nextId++, owner, type, tx, ty, hp: built ? def.hp : 1, built,
    progress: built ? def.buildTime : 0, queue: [], rally: null, food: type === 'Farm' ? FARM_FOOD : 0, cd: 0, target: 0,
  };
  s.entities.push(b);
  s.derived.byId.set(b.id, b);
  stampBuilding(s, s.derived, b, true);
  // eject units standing in a blocking footprint
  if (def.blocking) {
    for (const e of s.entities) {
      if (e.kind !== 'unit' || e.hp <= 0) continue;
      if (e.x >= tx && e.x < tx + def.size && e.y >= ty && e.y < ty + def.size) {
        const t = nearestFreeTile(s, Math.floor(e.x), Math.floor(e.y));
        if (t >= 0) { e.x = (t % s.map.size) + 0.5; e.y = Math.floor(t / s.map.size) + 0.5; e.path = null; }
      }
    }
  }
  return b;
}

// ---------------------------------------------------------------------------
// Queries

export const unitRadius = (u: UnitEnt) => (u.type === 'Deer' ? 0.3 : UNITS[u.type].mounted ? 0.35 : 0.25);
export const isAlive = (e: Entity | undefined): e is Entity => !!e && e.hp > 0;
export function getEnt(s: GameState, id: number): Entity | undefined {
  const e = s.derived.byId.get(id);
  return e && e.hp > 0 ? e : undefined;
}
export function bSize(b: BuildingEnt) { return BUILDINGS[b.type].size; }
export function bCenter(b: BuildingEnt): [number, number] {
  const sz = bSize(b);
  return [b.tx + sz / 2, b.ty + sz / 2];
}
export function entPos(e: Entity): [number, number] {
  return e.kind === 'unit' ? [e.x, e.y] : bCenter(e);
}

export function isBlocked(s: GameState, i: number): boolean {
  return !terrainPassable(s.map.terrain[i]) || resBlocks(s.map.resType[i]) || s.derived.bgrid[i] !== 0;
}

function distToRect(x: number, y: number, x0: number, y0: number, x1: number, y1: number) {
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0;
  const dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Distance from unit center to target's body surface. */
export function distTo(u: UnitEnt, t: Entity): number {
  if (t.kind === 'unit') {
    const dx = t.x - u.x, dy = t.y - u.y;
    return Math.sqrt(dx * dx + dy * dy) - unitRadius(t);
  }
  const sz = bSize(t);
  return distToRect(u.x, u.y, t.tx, t.ty, t.tx + sz, t.ty + sz);
}

export function popUsed(s: GameState, p: PlayerId): number {
  let n = 0;
  for (const e of s.entities) if (e.kind === 'unit' && e.owner === p && e.hp > 0) n++;
  return n;
}

export function popCapacity(s: GameState, p: PlayerId): number {
  let n = 0;
  for (const e of s.entities) if (e.kind === 'building' && e.owner === p && e.built && e.hp > 0) n += BUILDINGS[e.type].pop;
  return Math.min(n, s.config.popCap);
}

export function hasBuilt(s: GameState, p: PlayerId, type: BuildingType): boolean {
  for (const e of s.entities) if (e.kind === 'building' && e.owner === p && e.type === type && e.built && e.hp > 0) return true;
  return false;
}

export function canAfford(ps: PlayerState, c: Cost, mult = 1): boolean {
  for (const k of Object.keys(c) as ResourceType[]) if (ps.res[k] < (c[k] ?? 0) * mult) return false;
  return true;
}
function pay(ps: PlayerState, c: Cost) { for (const k of Object.keys(c) as ResourceType[]) ps.res[k] -= c[k] ?? 0; }
function refund(ps: PlayerState, c: Cost) { for (const k of Object.keys(c) as ResourceType[]) ps.res[k] += c[k] ?? 0; }

export function missingRequirements(s: GameState, p: PlayerId, reqs: BuildingType[]): BuildingType[] {
  return reqs.filter((r) => !hasBuilt(s, p, r));
}

export function placementError(s: GameState, p: PlayerId, type: BuildingType, tx: number, ty: number): string | null {
  const def = BUILDINGS[type];
  const S = s.map.size;
  if (tx < 1 || ty < 1 || tx + def.size > S - 1 || ty + def.size > S - 1) return 'out of bounds';
  const exp = s.players[p].explored;
  for (let y = ty; y < ty + def.size; y++) {
    for (let x = tx; x < tx + def.size; x++) {
      const i = y * S + x;
      if (!exp[i]) return 'unexplored location';
      if (!terrainBuildable(s.map.terrain[i])) return 'terrain not buildable';
      if (s.map.resType[i] !== Res.None && resBlocks(s.map.resType[i])) return 'blocked by resources';
      if (s.derived.bgrid[i] !== 0 || s.derived.fgrid[i] !== 0) return 'overlaps a building';
    }
  }
  return null;
}

export function techAvailable(s: GameState, p: PlayerId, tech: TechType): boolean {
  if (s.players[p].techs.includes(tech)) return false;
  for (const e of s.entities) {
    if (e.kind === 'building' && e.owner === p && e.hp > 0) for (const q of e.queue) if (q.kind === 'tech' && q.what === tech) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command application (shared by humans and the AI resolver)

export function applyCommand(s: GameState, p: PlayerId, c: Command): string | null {
  const ownUnits = (ids: number[]) => {
    const out: UnitEnt[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = getEnt(s, id);
      if (e && e.kind === 'unit' && e.owner === p) out.push(e);
    }
    return out;
  };
  switch (c.t) {
    case 'move': {
      const units = ownUnits(c.units);
      if (!units.length) return 'no valid units';
      const spots = formation(s, units, c.x, c.y);
      units.forEach((u, i) => setOrder(u, c.attack ? { k: 'amove', x: spots[i][0], y: spots[i][1] } : { k: 'move', x: spots[i][0], y: spots[i][1] }));
      return null;
    }
    case 'attack': {
      const t = getEnt(s, c.target);
      if (!t || t.owner === p) return 'invalid target';
      const units = ownUnits(c.units);
      if (!units.length) return 'no valid units';
      for (const u of units) setOrder(u, { k: 'attack', target: t.id, hunt: t.owner === -1 && u.type === 'Villager' });
      return null;
    }
    case 'gather': {
      const tx = Math.floor(c.x), ty = Math.floor(c.y);
      if (!inMap(s, tx, ty)) return 'out of bounds';
      const S = s.map.size;
      const vills = ownUnits(c.units).filter((u) => u.type === 'Villager');
      if (!vills.length) return 'no villagers';
      // farm?
      const fid = s.derived.fgrid[ty * S + tx];
      if (fid) {
        const f = getEnt(s, fid - 1);
        if (f && f.kind === 'building' && f.owner === p) {
          for (const u of vills) setOrder(u, f.built ? { k: 'farm', target: f.id } : { k: 'build', target: f.id });
          return null;
        }
      }
      const r = s.map.resType[ty * S + tx];
      if (r === Res.None) return 'no resource there';
      for (const u of vills) setOrder(u, { k: 'gather', tx, ty, res: r });
      return null;
    }
    case 'build': {
      const def = BUILDINGS[c.building];
      if (!def) return 'unknown building';
      const ps = s.players[p];
      const missing = missingRequirements(s, p, def.requires);
      if (missing.length) return `requires ${missing.join(', ')}`;
      const builders = ownUnits(c.units).filter((u) => u.type === 'Villager');
      const placed: BuildingEnt[] = [];
      const tiles: [number, number][] = [];
      if (c.building === 'Wall' && c.x2 !== undefined && c.y2 !== undefined) {
        const x0 = Math.floor(c.x), y0 = Math.floor(c.y), x1 = Math.floor(c.x2), y1 = Math.floor(c.y2);
        const steps = Math.min(40, Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
        for (let k = 0; k <= steps; k++) {
          const x = steps ? Math.round(x0 + ((x1 - x0) * k) / steps) : x0;
          const y = steps ? Math.round(y0 + ((y1 - y0) * k) / steps) : y0;
          if (!tiles.some(([a, b]) => a === x && b === y)) tiles.push([x, y]);
        }
      } else tiles.push([Math.floor(c.x), Math.floor(c.y)]);
      let err: string | null = null;
      for (const [x, y] of tiles) {
        if (!canAfford(ps, def.cost)) { err = 'not enough resources'; break; }
        const e = placementError(s, p, c.building, x, y);
        if (e) { err = e; continue; }
        pay(ps, def.cost);
        placed.push(addBuilding(s, p, c.building, x, y, false));
      }
      if (!placed.length) return err ?? 'could not place';
      const ids = placed.map((b) => b.id);
      for (const u of builders) {
        const o = u.order;
        if (c.queue && o && o.k === 'build' && needsWork(s, u, o.target)) o.then = [...(o.then ?? []), ...ids].slice(0, MAX_BUILD_QUEUE);
        else setOrder(u, { k: 'build', target: ids[0], then: ids.slice(1, MAX_BUILD_QUEUE + 1) });
      }
      return null;
    }
    case 'assist': {
      const t = getEnt(s, c.target);
      if (!t || t.kind !== 'building' || t.owner !== p) return 'invalid building';
      for (const u of ownUnits(c.units)) if (u.type === 'Villager') setOrder(u, t.type === 'Farm' && t.built ? { k: 'farm', target: t.id } : { k: 'build', target: t.id });
      return null;
    }
    case 'train': {
      const b = getEnt(s, c.building);
      if (!b || b.kind !== 'building' || b.owner !== p) return 'invalid building';
      if (!b.built) return 'building not finished';
      const ud = UNITS[c.unit];
      if (!ud || !BUILDINGS[b.type].trains.includes(c.unit)) return `${b.type} cannot train ${c.unit}`;
      const missing = missingRequirements(s, p, ud.requires);
      if (missing.length) return `requires ${missing.join(', ')}`;
      const ps = s.players[p];
      let n = 0;
      const count = Math.max(1, Math.min(10, Math.floor(c.count || 1)));
      for (let i = 0; i < count; i++) {
        if (b.queue.length >= 10) break;
        if (!canAfford(ps, ud.cost)) break;
        pay(ps, ud.cost);
        b.queue.push({ kind: 'unit', what: c.unit, progress: 0 });
        n++;
      }
      return n ? null : b.queue.length >= 10 ? 'queue full' : 'not enough resources';
    }
    case 'research': {
      const b = getEnt(s, c.building);
      if (!b || b.kind !== 'building' || b.owner !== p || !b.built) return 'invalid building';
      const td = TECHS[c.tech];
      if (!td || !BUILDINGS[b.type].researches.includes(c.tech)) return 'cannot research that here';
      if (!techAvailable(s, p, c.tech)) return 'already researched or queued';
      const ps = s.players[p];
      if (!canAfford(ps, td.cost)) return 'not enough resources';
      if (b.queue.length >= 10) return 'queue full';
      pay(ps, td.cost);
      b.queue.push({ kind: 'tech', what: c.tech, progress: 0 });
      return null;
    }
    case 'cancel': {
      const b = getEnt(s, c.building);
      if (!b || b.kind !== 'building' || b.owner !== p) return 'invalid building';
      const it = b.queue[c.index];
      if (!it) return 'nothing to cancel';
      b.queue.splice(c.index, 1);
      refund(s.players[p], it.kind === 'unit' ? UNITS[it.what as UnitType].cost : TECHS[it.what as TechType].cost);
      return null;
    }
    case 'stop': {
      for (const u of ownUnits(c.units)) setOrder(u, null);
      return null;
    }
    case 'guard': {
      const units = ownUnits(c.units);
      const r = Math.max(2, Math.min(20, c.r || 8));
      const spots = formation(s, units, c.x, c.y);
      units.forEach((u, i) => setOrder(u, { k: 'guard', x: spots[i][0], y: spots[i][1], r }));
      return units.length ? null : 'no valid units';
    }
    case 'explore': {
      const units = ownUnits(c.units);
      for (const u of units) setOrder(u, { k: 'explore', x: -1, y: -1 });
      return units.length ? null : 'no valid units';
    }
    case 'rally': {
      const b = getEnt(s, c.building);
      if (!b || b.kind !== 'building' || b.owner !== p) return 'invalid building';
      b.rally = [c.x, c.y];
      return null;
    }
    case 'delete': {
      for (const id of c.ids) {
        const e = getEnt(s, id);
        if (!e || e.owner !== p) continue;
        if (e.kind === 'building' && !e.built && e.progress === 0) refund(s.players[p], BUILDINGS[e.type].cost);
        killEntity(s, e, -1);
      }
      return null;
    }
    case 'ai':
      applyAiCommands(s, p, c.plan, c.cmds);
      return null;
  }
  return 'unknown command';
}

export function setOrder(u: UnitEnt, o: Order | null) {
  u.order = o;
  u.path = null;
  u.pathGoal = -1;
  u.repath = 0;
  u.autoTarget = 0;
  u.stuck = 0;
  if (!o || (o.k !== 'gather' && o.k !== 'farm')) { u.returnTo = -1; u.gatherKind = null; }
}

function inMap(s: GameState, x: number, y: number) { return x >= 0 && y >= 0 && x < s.map.size && y < s.map.size; }

/** Spread destinations for a group around a point (deterministic). */
export function formation(s: GameState, units: UnitEnt[], x: number, y: number): [number, number][] {
  if (units.length <= 1) return units.map(() => [x, y]);
  const spacing = 0.8;
  const spots: [number, number][] = [];
  const S = s.map.size;
  const ring = Math.ceil(Math.sqrt(units.length)) + 2;
  const cand: [number, number, number][] = [];
  for (let gy = -ring; gy <= ring; gy++) {
    for (let gx = -ring; gx <= ring; gx++) {
      const px = x + gx * spacing, py = y + gy * spacing;
      const tx = Math.floor(px), ty = Math.floor(py);
      if (tx < 0 || ty < 0 || tx >= S || ty >= S || isBlocked(s, ty * S + tx)) continue;
      cand.push([px, py, gx * gx + gy * gy]);
    }
  }
  cand.sort((a, b) => a[2] - b[2]);
  for (let i = 0; i < units.length; i++) spots.push(cand[i] ? [cand[i][0], cand[i][1]] : [x, y]);
  return spots;
}

// ---------------------------------------------------------------------------
// Main step

export function step(s: GameState, cmds: { player: PlayerId; cmd: Command }[]): void {
  s.events = [];
  if (s.result) return;
  s.derived.pathBudget = PATH_BUDGET_PER_TICK;
  for (const c of cmds) applyCommand(s, c.player, c.cmd);

  for (const e of s.entities) if (e.kind === 'building' && e.hp > 0) updateBuilding(s, e);
  for (const e of s.entities) if (e.kind === 'unit' && e.hp > 0) updateUnit(s, e);
  separate(s);

  // remove dead
  let removed = false;
  for (const e of s.entities) {
    if (e.kind === 'unit' && e.hp <= 0) { e.deadTicks--; if (e.deadTicks <= 0) removed = true; }
    if (e.kind === 'building' && e.hp <= 0) removed = true;
  }
  if (removed) {
    s.entities = s.entities.filter((e) => {
      const keep = e.kind === 'unit' ? e.hp > 0 || e.deadTicks > 0 : e.hp > 0;
      if (!keep) s.derived.byId.delete(e.id);
      return keep;
    });
  }

  s.tick++;
  if (s.tick % VIS_INTERVAL === 0) updateVisibility(s);
  checkEnd(s);
}

function checkEnd(s: GameState) {
  const alive = [0, 1].map((p) => {
    let tc = false, units = false;
    for (const e of s.entities) {
      if (e.owner !== p || e.hp <= 0) continue;
      if (e.kind === 'unit') units = true;
      else if (e.type === 'TownCenter' && e.built) tc = true;
      if (tc && units) break;
    }
    return tc || units;
  });
  if (!alive[0] || !alive[1]) {
    const scores = [scoreSide(s, 0), scoreSide(s, 1)] as [number, number];
    const winner: PlayerId | null = alive[0] ? 0 : alive[1] ? 1 : null;
    s.result = { winner, reason: 'conquest', scores, tick: s.tick };
    return;
  }
  if (s.tick >= timeLimitTicks(s.config)) {
    const scores = [scoreSide(s, 0), scoreSide(s, 1)] as [number, number];
    const winner: PlayerId | null = scores[0] > scores[1] ? 0 : scores[1] > scores[0] ? 1 : null;
    s.result = { winner, reason: 'time', scores, tick: s.tick };
  }
}

export function timeLimitTicks(c: MatchConfig) { return Math.round(c.timeLimitMin * 60 * TICK_RATE); }

/** Surviving asset value: original cost of each unit/building times remaining HP fraction. */
export function scoreSide(s: GameState, p: PlayerId): number {
  let total = 0;
  for (const e of s.entities) {
    if (e.owner !== p || e.hp <= 0) continue;
    if (e.kind === 'unit') {
      const d = UNITS[e.type as UnitType];
      total += costValue(d.cost) * (e.hp / d.hp);
    } else {
      const d = BUILDINGS[e.type];
      total += costValue(d.cost) * (e.hp / d.hp);
    }
  }
  return Math.round(total * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Buildings

function updateBuilding(s: GameState, b: BuildingEnt) {
  if (!b.built || b.owner === -1) return;
  const p = b.owner as PlayerId;
  const def = BUILDINGS[b.type];
  if (b.queue.length) {
    const it = b.queue[0];
    if (it.kind === 'unit') {
      const ud = UNITS[it.what as UnitType];
      if (it.progress < ud.trainTime) it.progress += TICK_DT;
      if (it.progress >= ud.trainTime - 1e-9 && popUsed(s, p) < popCapacity(s, p)) {
        b.queue.shift();
        spawnFrom(s, b, it.what as UnitType);
      }
    } else {
      const td = TECHS[it.what as TechType];
      it.progress += TICK_DT;
      if (it.progress >= td.time - 1e-9) {
        b.queue.shift();
        s.players[p].techs.push(it.what as TechType);
        pushAlert(s, p, `Research complete: ${td.name}`);
        s.events.push({ type: 'researched', src: b.id, owner: p });
      }
    }
  }
  if (def.attack) {
    if (b.cd > 0) b.cd--;
    if (b.cd <= 0) {
      const [cx, cy] = bCenter(b);
      const range = def.attack.range + (s.players[p].techs.includes('Fletching') ? 1 : 0);
      let best: UnitEnt | null = null, bd = 1e9;
      for (const e of s.entities) {
        if (e.kind !== 'unit' || e.hp <= 0 || e.owner === -1 || e.owner === p) continue;
        const dx = e.x - cx, dy = e.y - cy;
        const d = dx * dx + dy * dy;
        if (d <= range * range && d < bd) { bd = d; best = e; }
      }
      if (best) {
        const dmgBase = def.attack.damage + (s.players[p].techs.includes('Fletching') ? 1 : 0);
        const armor = UNITS[best.type as UnitType].pierceArmor + (militaryArmorBonus(s, best));
        dealDamage(s, best, Math.max(1, dmgBase - armor), b.id);
        s.events.push({ type: 'attack', src: b.id, dst: best.id, x: cx, y: cy, x2: best.x, y2: best.y, ranged: true, owner: p });
        b.cd = Math.round(def.attack.reload * TICK_RATE);
      }
    }
  }
}

function spawnFrom(s: GameState, b: BuildingEnt, type: UnitType) {
  const p = b.owner as PlayerId;
  const S = s.map.size;
  const [rx, ry] = b.rally ?? [S / 2, S / 2];
  const ring = spawnRing(s, b, rx, ry);
  const [cx, cy] = bCenter(b);
  const t = ring[0];
  const u = addUnit(s, p, type, t !== undefined ? (t % S) + 0.5 : cx, t !== undefined ? Math.floor(t / S) + 0.5 : cy + bSize(b) / 2 + 0.5);
  s.players[p].stats.trained++;
  s.events.push({ type: 'trained', src: u.id, owner: p });
  if (b.rally) {
    const [x, y] = b.rally;
    const ti = Math.floor(y) * S + Math.floor(x);
    if (type === 'Villager' && inMap(s, Math.floor(x), Math.floor(y))) {
      const r = s.map.resType[ti];
      const f = s.derived.fgrid[ti];
      if (f) { const fb = getEnt(s, f - 1); if (fb && fb.kind === 'building' && fb.owner === p && fb.built) { setOrder(u, { k: 'farm', target: fb.id }); return; } }
      if (r !== Res.None) { setOrder(u, { k: 'gather', tx: Math.floor(x), ty: Math.floor(y), res: r }); return; }
    }
    setOrder(u, { k: 'move', x, y });
  }
}

/** Free tiles adjacent to a building footprint, nearest to (tx,ty) first. */
function spawnRing(s: GameState, b: BuildingEnt, towardX: number, towardY: number): number[] {
  const S = s.map.size;
  const sz = bSize(b);
  const out: [number, number][] = [];
  for (let r = 1; r <= 4 && out.length === 0; r++) {
    for (let y = b.ty - r; y < b.ty + sz + r; y++) {
      for (let x = b.tx - r; x < b.tx + sz + r; x++) {
        if (x >= b.tx && x < b.tx + sz && y >= b.ty && y < b.ty + sz) continue;
        if (!inMap(s, x, y)) continue;
        const i = y * S + x;
        if (isBlocked(s, i)) continue;
        const dx = x + 0.5 - towardX, dy = y + 0.5 - towardY;
        out.push([i, dx * dx + dy * dy]);
      }
    }
  }
  out.sort((a, b2) => a[1] - b2[1] || a[0] - b2[0]);
  return out.map((o) => o[0]);
}

function nearestFreeTile(s: GameState, x: number, y: number): number {
  const S = s.map.size;
  for (let r = 0; r < 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (!inMap(s, nx, ny)) continue;
        if (!isBlocked(s, ny * S + nx)) return ny * S + nx;
      }
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Combat

function militaryArmorBonus(s: GameState, u: UnitEnt): number {
  if (u.owner === -1 || u.type === 'Villager' || u.type === 'Deer') return 0;
  return s.players[u.owner as PlayerId].techs.includes('ScaleArmor') ? 1 : 0;
}

export function attackDamage(s: GameState, a: UnitEnt, t: Entity): number {
  const d = UNITS[a.type as UnitType];
  const techs = s.players[a.owner as PlayerId].techs;
  let atk = d.attack;
  if (a.type !== 'Villager') {
    if (d.attackKind === 'melee' && techs.includes('Toolworking')) atk += 2;
    if (d.attackKind === 'pierce' && techs.includes('Fletching')) atk += 1;
  }
  let armor = 0;
  let cls: string;
  if (t.kind === 'building') {
    armor = d.attackKind === 'melee' ? BUILDING_MELEE_ARMOR : BUILDING_PIERCE_ARMOR;
    cls = 'building';
  } else if (t.type === 'Deer') {
    cls = 'animal';
  } else {
    const td = UNITS[t.type as UnitType];
    armor = (d.attackKind === 'melee' ? td.meleeArmor : td.pierceArmor) + militaryArmorBonus(s, t);
    cls = td.armorClass;
  }
  const bonus = (d.bonus as Record<string, number> | undefined)?.[cls] ?? 0;
  return Math.max(1, atk - armor) + bonus;
}

export function attackRange(s: GameState, u: UnitEnt): number {
  if (u.type === 'Deer') return 0;
  const d = UNITS[u.type];
  let r = d.range;
  if (d.attackKind === 'pierce' && s.players[u.owner as PlayerId].techs.includes('Fletching')) r += 1;
  return r;
}

function dealDamage(s: GameState, t: Entity, dmg: number, srcId: number) {
  t.hp -= dmg;
  const src = s.derived.byId.get(srcId);
  if (t.owner !== -1) {
    const p = t.owner as PlayerId;
    const ps = s.players[p];
    if (s.tick - ps.lastAttackedTick > 150) {
      const [x, y] = entPos(t);
      pushAlert(s, p, `Under attack at (${Math.floor(x)},${Math.floor(y)})`);
    }
    ps.lastAttackedTick = s.tick;
    // retaliation for idle military units
    if (t.kind === 'unit' && t.hp > 0 && src && src.owner !== p && src.owner !== -1) {
      if (t.type !== 'Villager' && (!t.order || t.order.k === 'guard') && !getEnt(s, t.autoTarget)) t.autoTarget = src.id;
    }
  }
  if (t.hp <= 0) killEntity(s, t, src ? src.owner : -1);
}

function killEntity(s: GameState, t: Entity, killer: Owner) {
  t.hp = 0;
  const [x, y] = entPos(t);
  if (t.owner !== -1) {
    s.players[t.owner as PlayerId].stats.lost++;
    if (killer !== -1 && killer !== t.owner) s.players[killer as PlayerId].stats.killed++;
  }
  if (t.kind === 'unit') {
    t.deadTicks = 25;
    t.anim = 'dead';
    t.order = null;
    t.path = null;
    s.events.push({ type: 'death', src: t.id, x, y, owner: t.owner });
    if (t.type === 'Deer') {
      // leave a carcass that can be gathered
      const S = s.map.size;
      let ti = Math.floor(t.y) * S + Math.floor(t.x);
      if (s.map.resType[ti] !== Res.None && s.map.resType[ti] !== Res.Meat) {
        const f = nearestFreeTile(s, Math.floor(t.x), Math.floor(t.y));
        if (f >= 0) ti = f;
      }
      s.map.resType[ti] = Res.Meat;
      s.map.resAmt[ti] = Math.min(65000, s.map.resAmt[ti] + GAIA_UNITS.Deer.food);
    } else if (t.owner !== -1) {
      pushAlert(s, t.owner as PlayerId, `${UNITS[t.type as UnitType].name} lost at (${Math.floor(x)},${Math.floor(y)})`);
    }
  } else {
    stampBuilding(s, s.derived, t, false);
    s.events.push({ type: 'destroyed', src: t.id, x, y, owner: t.owner });
    if (t.owner !== -1) pushAlert(s, t.owner as PlayerId, `${BUILDINGS[t.type].name} destroyed at (${Math.floor(x)},${Math.floor(y)})`);
    // refund queued items
    if (t.owner !== -1) for (const it of t.queue) refund(s.players[t.owner as PlayerId], it.kind === 'unit' ? UNITS[it.what as UnitType].cost : TECHS[it.what as TechType].cost);
    t.queue = [];
  }
}

export function pushAlert(s: GameState, p: PlayerId, text: string) {
  const a = s.players[p].alerts;
  a.push({ tick: s.tick, text });
  if (a.length > 30) a.splice(0, a.length - 30);
}

// ---------------------------------------------------------------------------
// Units

function updateUnit(s: GameState, u: UnitEnt) {
  if (u.cd > 0) u.cd--;
  if (u.repath > 0) u.repath--;
  if (u.owner === -1) { deerLogic(s, u); return; }
  const prevX = u.x, prevY = u.y;
  u.anim = u.cd > Math.round(UNITS[u.type as UnitType].reload * TICK_RATE) - 5 ? 'attack' : 'idle';
  const o = u.order;
  if (!o) idleLogic(s, u);
  else {
    switch (o.k) {
      case 'move':
        if (moveTo(s, u, o.x, o.y)) setOrder(u, null);
        break;
      case 'amove':
        if (!engageAuto(s, u, true, UNITS[u.type as UnitType].sight)) {
          if (moveTo(s, u, o.x, o.y)) setOrder(u, null);
        }
        break;
      case 'attack': {
        const t = getEnt(s, o.target);
        if (!t || (t.kind === 'unit' && t.hp <= 0)) {
          const dead = s.derived.byId.get(o.target);
          if (o.hunt && dead && dead.kind === 'unit' && dead.type === 'Deer') {
            const tx = Math.floor(dead.x), ty = Math.floor(dead.y);
            const near = findNearestRes(s, Res.Meat, tx, ty, 2, u);
            if (near >= 0) { setOrder(u, { k: 'gather', tx: near % s.map.size, ty: Math.floor(near / s.map.size), res: Res.Meat }); break; }
          }
          setOrder(u, null);
          break;
        }
        engage(s, u, t);
        break;
      }
      case 'gather':
        gatherLogic(s, u, o);
        break;
      case 'farm':
        farmLogic(s, u, o);
        break;
      case 'build':
        buildLogic(s, u, o);
        break;
      case 'guard':
        guardLogic(s, u, o);
        break;
      case 'explore':
        exploreLogic(s, u, o);
        break;
    }
  }
  const mdx = u.x - prevX, mdy = u.y - prevY;
  if (mdx * mdx + mdy * mdy > 1e-6) u.anim = 'walk';
}

function idleLogic(s: GameState, u: UnitEnt) {
  if (u.type === 'Villager') return;
  engageAuto(s, u, false, UNITS[u.type as UnitType].sight);
}

/** Acquire/keep an automatic target near the unit. Returns true if busy fighting. */
function engageAuto(s: GameState, u: UnitEnt, includeBuildings: boolean, radius: number): boolean {
  let t = getEnt(s, u.autoTarget);
  if (t && t.owner === u.owner) t = undefined;
  if (t && distTo(u, t) > radius * 1.5) t = undefined;
  if (!t && (s.tick + u.id) % 4 === 0) t = acquireTarget(s, u, radius, includeBuildings);
  if (!t) { u.autoTarget = 0; return false; }
  u.autoTarget = t.id;
  engage(s, u, t);
  return true;
}

function acquireTarget(s: GameState, u: UnitEnt, radius: number, includeBuildings: boolean): Entity | undefined {
  let best: Entity | undefined, bd = 1e9;
  let bestB: Entity | undefined, bdB = 1e9;
  for (const e of s.entities) {
    if (e.hp <= 0 || e.owner === u.owner || e.owner === -1) continue;
    const d = distTo(u, e);
    if (d > radius) continue;
    if (e.kind === 'unit') {
      // prefer military threats slightly over villagers
      const w = d + (e.type === 'Villager' ? 1.5 : 0);
      if (w < bd) { bd = w; best = e; }
    } else if (includeBuildings || BUILDINGS[e.type].attack) {
      if (e.type === 'Wall' && !includeBuildings) continue;
      const w = d + (e.type === 'Wall' ? 4 : 0);
      if (w < bdB) { bdB = w; bestB = e; }
    }
  }
  return best ?? bestB;
}

function engage(s: GameState, u: UnitEnt, t: Entity) {
  const range = attackRange(s, u);
  const d = distTo(u, t);
  const reach = range + unitRadius(u) + 0.05;
  if (d <= reach) {
    const [tx, ty] = entPos(t);
    face(u, tx - u.x, ty - u.y);
    u.path = null;
    if (u.cd <= 0) {
      const ud = UNITS[u.type as UnitType];
      const dmg = attackDamage(s, u, t);
      s.events.push({ type: 'attack', src: u.id, dst: t.id, x: u.x, y: u.y, x2: tx, y2: ty, ranged: ud.attackKind === 'pierce', owner: u.owner });
      u.cd = Math.round(ud.reload * TICK_RATE);
      u.anim = 'attack';
      dealDamage(s, t, dmg, u.id);
    }
    return;
  }
  if (t.kind === 'unit') moveToUnit(s, u, t);
  else moveToRect(s, u, t.tx, t.ty, t.tx + bSize(t) - 1, t.ty + bSize(t) - 1);
}

function face(u: UnitEnt, dx: number, dy: number) {
  const l = Math.sqrt(dx * dx + dy * dy);
  if (l > 1e-6) { u.dirX = dx / l; u.dirY = dy / l; }
}

// ---- movement --------------------------------------------------------------

function blockedFn(s: GameState) { return (i: number) => isBlocked(s, i); }

function computePath(s: GameState, u: UnitEnt, gx0: number, gy0: number, gx1: number, gy1: number, reach: number, key: number): boolean {
  if (s.derived.pathBudget <= 0) return false;
  const S = s.map.size;
  const r = findPath({
    size: S, blocked: blockedFn(s), sx: clampI(Math.floor(u.x), S), sy: clampI(Math.floor(u.y), S),
    gx0, gy0, gx1, gy1, reach, maxNodes: 12000,
  });
  s.derived.pathBudget -= r.expanded + 50;
  u.path = r.path;
  u.pathI = 0;
  u.pathGoal = key;
  u.repath = r.complete ? 40 : 15;
  return true;
}

function clampI(v: number, S: number) { return v < 0 ? 0 : v >= S ? S - 1 : v; }

/** Follow current path; finalX/Y used for the last leg. Returns true when the path is exhausted. */
function followPath(s: GameState, u: UnitEnt, finalX: number, finalY: number): boolean {
  const S = s.map.size;
  const speed = speedOf(u) * TICK_DT;
  const path = u.path;
  if (!path) return true;
  const blocked = blockedFn(s);
  // skip ahead when there is a clear line
  let skips = 0;
  while (u.pathI + 1 < path.length && skips < 3) {
    const n = path[u.pathI + 1];
    if (!lineClear(S, blocked, u.x, u.y, (n % S) + 0.5, Math.floor(n / S) + 0.5, unitRadius(u) * 0.8)) break;
    u.pathI++;
    skips++;
  }
  if (u.pathI >= path.length) return true;
  const last = u.pathI === path.length - 1;
  const n = path[u.pathI];
  let wx = (n % S) + 0.5, wy = Math.floor(n / S) + 0.5;
  if (last && Math.floor(finalX) === n % S && Math.floor(finalY) === Math.floor(n / S)) { wx = finalX; wy = finalY; }
  const dx = wx - u.x, dy = wy - u.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= speed) {
    u.x = wx; u.y = wy;
    u.pathI++;
  } else {
    u.x += (dx / d) * speed;
    u.y += (dy / d) * speed;
  }
  face(u, dx, dy);
  return u.pathI >= path.length;
}

function speedOf(u: UnitEnt) { return u.type === 'Deer' ? GAIA_UNITS.Deer.speed : UNITS[u.type].speed; }

/** Move toward a point. Returns true when arrived (or cannot get closer). */
function moveTo(s: GameState, u: UnitEnt, x: number, y: number): boolean {
  const dx = x - u.x, dy = y - u.y;
  const d2 = dx * dx + dy * dy;
  if (d2 < 0.02) return true;
  const S = s.map.size;
  const gx = clampI(Math.floor(x), S), gy = clampI(Math.floor(y), S);
  const key = gy * S + gx;
  const speed = speedOf(u) * TICK_DT;
  // short direct hop
  if (d2 < 4 && lineClear(S, blockedFn(s), u.x, u.y, x, y, unitRadius(u) * 0.8)) {
    const d = Math.sqrt(d2);
    if (d <= speed) { u.x = x; u.y = y; return true; }
    u.x += (dx / d) * speed; u.y += (dy / d) * speed;
    face(u, dx, dy);
    return trackStuck(u);
  }
  if (u.pathGoal !== key || (!u.path && u.repath <= 0)) {
    const reach = isBlocked(s, key) ? 1 : 0;
    if (!computePath(s, u, gx, gy, gx, gy, reach, key)) return false;
  }
  const done = followPath(s, u, x, y);
  if (done) {
    // path ended but not at target: target unreachable -> give up when no progress
    if (u.repath <= 0) { u.path = null; u.pathGoal = -1; }
    const ddx = x - u.x, ddy = y - u.y;
    if (ddx * ddx + ddy * ddy < 0.05) return true;
    return trackStuck(u, 6);
  }
  return trackStuck(u);
}

function trackStuck(u: UnitEnt, limit = 30): boolean {
  const dx = u.x - u.lastX, dy = u.y - u.lastY;
  if (dx * dx + dy * dy < 0.0004) {
    u.stuck++;
    if (u.stuck === 12) { u.path = null; u.pathGoal = -1; u.repath = 0; }
    if (u.stuck > limit) { u.stuck = 0; return true; }
  } else u.stuck = 0;
  u.lastX = u.x; u.lastY = u.y;
  return false;
}

function moveToUnit(s: GameState, u: UnitEnt, t: UnitEnt) {
  const S = s.map.size;
  const dx = t.x - u.x, dy = t.y - u.y;
  const speed = speedOf(u) * TICK_DT;
  if (dx * dx + dy * dy < 9 && lineClear(S, blockedFn(s), u.x, u.y, t.x, t.y, unitRadius(u) * 0.8)) {
    const d = Math.sqrt(dx * dx + dy * dy);
    u.x += (dx / d) * speed; u.y += (dy / d) * speed;
    face(u, dx, dy);
    u.path = null;
    return;
  }
  const gx = clampI(Math.floor(t.x), S), gy = clampI(Math.floor(t.y), S);
  const key = gy * S + gx;
  if (!u.path || (u.pathGoal !== key && u.repath <= 0) || u.pathI >= u.path.length) {
    if (u.repath > 0 && u.path && u.pathI < u.path.length) { /* keep */ } else computePath(s, u, gx, gy, gx, gy, 1, key);
  }
  followPath(s, u, t.x, t.y);
  if (trackStuck(u)) { u.path = null; }
}

function moveToRect(s: GameState, u: UnitEnt, x0: number, y0: number, x1: number, y1: number) {
  const S = s.map.size;
  const key = -(y0 * S + x0) - 2;
  if (u.pathGoal !== key || ((!u.path || u.pathI >= u.path.length) && u.repath <= 0)) {
    computePath(s, u, x0, y0, x1, y1, 1, key);
  }
  if (u.path && u.pathI < u.path.length) followPath(s, u, (x0 + x1 + 1) / 2, (y0 + y1 + 1) / 2);
  else {
    // at path end but not in reach yet: nudge directly toward the rect
    const cx = Math.max(x0, Math.min(x1 + 1, u.x)), cy = Math.max(y0, Math.min(y1 + 1, u.y));
    const dx = cx - u.x, dy = cy - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const speed = speedOf(u) * TICK_DT;
    if (d > 1e-6) {
      const nx = u.x + (dx / d) * Math.min(speed, d), ny = u.y + (dy / d) * Math.min(speed, d);
      if (!isBlocked(s, Math.floor(ny) * S + Math.floor(nx))) { u.x = nx; u.y = ny; }
      face(u, dx, dy);
    }
  }
  if (trackStuck(u, 40)) { u.path = null; u.pathGoal = -1; }
}

// ---- villager work -----------------------------------------------------------

const REACH = 0.95;

function findNearestRes(s: GameState, res: number, tx: number, ty: number, radius: number, u: UnitEnt): number {
  const S = s.map.size;
  let best = -1, bd = 1e9;
  for (let y = Math.max(0, ty - radius); y <= Math.min(S - 1, ty + radius); y++) {
    for (let x = Math.max(0, tx - radius); x <= Math.min(S - 1, tx + radius); x++) {
      const i = y * S + x;
      if (s.map.resType[i] !== res || s.map.resAmt[i] === 0) continue;
      const dx = x + 0.5 - u.x, dy = y + 0.5 - u.y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

function findDropoff(s: GameState, u: UnitEnt, rt: ResourceType): BuildingEnt | null {
  let best: BuildingEnt | null = null, bd = 1e9;
  for (const e of s.entities) {
    if (e.kind !== 'building' || e.owner !== u.owner || !e.built || e.hp <= 0) continue;
    if (!BUILDINGS[e.type].dropoff.includes(rt)) continue;
    const d = distTo(u, e);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}

/** Returns true while the villager is busy delivering. */
function deliver(s: GameState, u: UnitEnt): 'busy' | 'done' | 'none' {
  if (!u.carryType || u.carry < 1) { u.carry = 0; u.carryType = null; return 'done'; }
  const d = findDropoff(s, u, u.carryType);
  if (!d) return 'none';
  if (distTo(u, d) <= REACH) {
    const amt = Math.floor(u.carry);
    const ps = s.players[u.owner as PlayerId];
    ps.res[u.carryType] += amt;
    ps.stats.gathered[u.carryType] += amt;
    s.events.push({ type: 'deposit', src: u.id, x: u.x, y: u.y, res: u.carryType, amount: amt, owner: u.owner });
    u.carry = 0;
    u.carryType = null;
    u.path = null;
    u.pathGoal = -1;
    return 'done';
  }
  moveToRect(s, u, d.tx, d.ty, d.tx + bSize(d) - 1, d.ty + bSize(d) - 1);
  return 'busy';
}

function gatherLogic(s: GameState, u: UnitEnt, o: Extract<Order, { k: 'gather' }>) {
  const S = s.map.size;
  const yieldType = RES_YIELD[o.res];
  if (u.carryType && u.carryType !== yieldType && u.carry > 0) { u.carry = 0; u.carryType = null; }
  u.gatherKind = yieldType === 'food' ? 'food' : yieldType;
  if (u.carry >= CARRY_CAPACITY || u.returnTo === -2) {
    u.returnTo = -2; // delivering
    const r = deliver(s, u);
    if (r === 'busy') return;
    if (r === 'none') { u.returnTo = -1; setOrder(u, null); return; }
    u.returnTo = -1;
  }
  let i = o.ty * S + o.tx;
  if (s.map.resType[i] !== o.res || s.map.resAmt[i] === 0) {
    const n = findNearestRes(s, o.res, o.tx, o.ty, 7, u);
    if (n < 0) {
      if (u.carry >= 1) { u.returnTo = -2; return; }
      setOrder(u, null);
      return;
    }
    o.tx = n % S; o.ty = Math.floor(n / S);
    i = n;
    u.path = null; u.pathGoal = -1;
  }
  const d = distToRect(u.x, u.y, o.tx, o.ty, o.tx + 1, o.ty + 1);
  if (d <= REACH) {
    face(u, o.tx + 0.5 - u.x, o.ty + 0.5 - u.y);
    u.anim = 'gather';
    u.path = null;
    const rate = o.res === Res.Tree ? GATHER_RATE.tree : o.res === Res.Gold ? GATHER_RATE.gold : o.res === Res.Stone ? GATHER_RATE.stone : o.res === Res.Berry ? GATHER_RATE.berry : GATHER_RATE.meat;
    const before = Math.floor(u.carry);
    u.carry += rate * TICK_DT;
    u.carryType = yieldType;
    const take = Math.floor(u.carry) - before;
    if (take > 0) {
      const avail = s.map.resAmt[i];
      const got = Math.min(avail, take);
      s.map.resAmt[i] = avail - got;
      if (got < take) u.carry -= take - got;
      if (s.map.resAmt[i] === 0) {
        const wasBlocking = resBlocks(s.map.resType[i]);
        s.map.resType[i] = Res.None;
        if (wasBlocking) s.derived.blockVersion++;
      }
    }
    if (u.carry >= CARRY_CAPACITY) u.returnTo = -2;
    return;
  }
  // stuck trying to reach (e.g. tree enclosed): pick another tile
  const before = u.stuck;
  moveToRect(s, u, o.tx, o.ty, o.tx, o.ty);
  if (before > 25 && u.stuck === 0) {
    const alt = findAltRes(s, o.res, o.tx, o.ty, u);
    if (alt >= 0) { o.tx = alt % S; o.ty = Math.floor(alt / S); }
  }
}

function findAltRes(s: GameState, res: number, tx: number, ty: number, u: UnitEnt): number {
  const S = s.map.size;
  let best = -1, bd = 1e9;
  for (let y = Math.max(0, ty - 5); y <= Math.min(S - 1, ty + 5); y++) {
    for (let x = Math.max(0, tx - 5); x <= Math.min(S - 1, tx + 5); x++) {
      if (x === tx && y === ty) continue;
      const i = y * S + x;
      if (s.map.resType[i] !== res) continue;
      // must have a free neighbour
      let open = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (inMap(s, nx, ny) && !isBlocked(s, ny * S + nx)) { open = true; break; }
      }
      if (!open) continue;
      const ddx = x + 0.5 - u.x, ddy = y + 0.5 - u.y;
      const d = ddx * ddx + ddy * ddy;
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

function farmLogic(s: GameState, u: UnitEnt, o: Extract<Order, { k: 'farm' }>) {
  const f = getEnt(s, o.target);
  u.gatherKind = 'farm';
  if (u.carryType && u.carryType !== 'food' && u.carry > 0) { u.carry = 0; u.carryType = null; }
  if (u.carry >= CARRY_CAPACITY || u.returnTo === -2 || !f) {
    u.returnTo = -2;
    const r = deliver(s, u);
    if (r === 'busy') return;
    u.returnTo = -1;
    if (r === 'none' || !f) { setOrder(u, null); return; }
  }
  if (!f || f.kind !== 'building') { setOrder(u, null); return; }
  if (!f.built) { setOrder(u, { k: 'build', target: f.id }); return; }
  const [cx, cy] = bCenter(f);
  const dx = cx - u.x, dy = cy - u.y;
  if (dx * dx + dy * dy <= 1.0) {
    u.anim = 'gather';
    u.path = null;
    face(u, dx || 0.01, dy);
    const before = Math.floor(u.carry);
    u.carry += GATHER_RATE.farm * TICK_DT;
    u.carryType = 'food';
    const take = Math.floor(u.carry) - before;
    if (take > 0) {
      f.food -= take;
      if (f.food <= 0) {
        f.food = 0;
        killEntity(s, f, -1);
        u.returnTo = -2;
        pushAlert(s, u.owner as PlayerId, `Farm depleted at (${Math.floor(cx)},${Math.floor(cy)})`);
      }
    }
    if (u.carry >= CARRY_CAPACITY) u.returnTo = -2;
    return;
  }
  moveTo(s, u, cx, cy);
}

const MAX_BUILD_QUEUE = 40;

/** True if `id` is one of the unit's own buildings that still needs construction or repair. */
function needsWork(s: GameState, u: UnitEnt, id: number): boolean {
  const b = getEnt(s, id);
  return !!b && b.kind === 'building' && b.owner === u.owner && b.hp > 0 && !(b.built && b.hp >= BUILDINGS[b.type].hp);
}

/** Switch to the next queued foundation that still needs work. Returns false if none is left. */
function nextQueuedBuild(s: GameState, u: UnitEnt, o: Extract<Order, { k: 'build' }>): boolean {
  const q = o.then ?? [];
  while (q.length) {
    const id = q.shift()!;
    if (needsWork(s, u, id)) { setOrder(u, { k: 'build', target: id, then: q }); return true; }
  }
  return false;
}

function buildLogic(s: GameState, u: UnitEnt, o: Extract<Order, { k: 'build' }>) {
  const b = getEnt(s, o.target);
  u.gatherKind = null;
  if (!b || b.kind !== 'building' || b.owner !== u.owner) { if (!nextQueuedBuild(s, u, o)) setOrder(u, null); return; }
  const def = BUILDINGS[b.type];
  if (b.built && b.hp >= def.hp) { if (!nextQueuedBuild(s, u, o)) afterBuild(s, u, b); return; }
  if (distTo(u, b) <= REACH + 0.2) {
    u.anim = 'build';
    u.path = null;
    const [cx, cy] = bCenter(b);
    face(u, cx - u.x, cy - u.y);
    if (!b.built) {
      b.progress += BUILD_RATE * TICK_DT;
      b.hp = Math.min(def.hp, b.hp + (def.hp * TICK_DT) / def.buildTime);
      if (b.progress >= def.buildTime - 1e-9) {
        b.built = true;
        b.progress = def.buildTime;
        const p = b.owner as PlayerId;
        s.players[p].stats.built++;
        s.events.push({ type: 'built', src: b.id, owner: p });
        if (b.type !== 'Wall') pushAlert(s, p, `${def.name} completed at (${b.tx},${b.ty})`);
      }
    } else {
      b.hp = Math.min(def.hp, b.hp + REPAIR_HP_PER_SEC * TICK_DT);
    }
    return;
  }
  moveToRect(s, u, b.tx, b.ty, b.tx + def.size - 1, b.ty + def.size - 1);
}

function afterBuild(s: GameState, u: UnitEnt, b: BuildingEnt) {
  // continue with nearby unfinished foundations (e.g. wall lines)
  let next: BuildingEnt | null = null, nd = 1e9;
  for (const e of s.entities) {
    if (e.kind !== 'building' || e.owner !== u.owner || e.built || e.hp <= 0) continue;
    const d = distTo(u, e);
    if (d < 6 && d < nd) { nd = d; next = e; }
  }
  if (next) { setOrder(u, { k: 'build', target: next.id }); return; }
  if (b.type === 'Farm') { setOrder(u, { k: 'farm', target: b.id }); return; }
  const S = s.map.size;
  const [cx, cy] = bCenter(b);
  const kinds = b.type === 'StoragePit' ? [Res.Tree, Res.Gold, Res.Stone] : b.type === 'Granary' ? [Res.Berry, Res.Meat] : [];
  let best = -1, bd = 1e9;
  for (const r of kinds) {
    const i = findNearestRes(s, r, Math.floor(cx), Math.floor(cy), 7, u);
    if (i < 0) continue;
    const dx = (i % S) + 0.5 - cx, dy = Math.floor(i / S) + 0.5 - cy;
    if (dx * dx + dy * dy < bd) { bd = dx * dx + dy * dy; best = i; }
  }
  if (best >= 0) setOrder(u, { k: 'gather', tx: best % S, ty: Math.floor(best / S), res: s.map.resType[best] });
  else setOrder(u, null);
}

function guardLogic(s: GameState, u: UnitEnt, o: Extract<Order, { k: 'guard' }>) {
  let t = getEnt(s, u.autoTarget);
  if (t) {
    const [tx, ty] = entPos(t);
    const dx = tx - o.x, dy = ty - o.y;
    if (dx * dx + dy * dy > (o.r + 3) * (o.r + 3) || t.owner === u.owner) { t = undefined; u.autoTarget = 0; }
  }
  if (!t && (s.tick + u.id) % 4 === 0) {
    let best: Entity | undefined, bd = 1e9;
    for (const e of s.entities) {
      if (e.hp <= 0 || e.owner === u.owner || e.owner === -1) continue;
      const [ex, ey] = entPos(e);
      const dx = ex - o.x, dy = ey - o.y;
      const dg = dx * dx + dy * dy;
      if (dg > o.r * o.r) continue;
      const d = distTo(u, e) + (e.kind === 'building' ? 6 : 0);
      if (d < bd) { bd = d; best = e; }
    }
    t = best;
  }
  if (t && u.type !== 'Villager') { u.autoTarget = t.id; engage(s, u, t); return; }
  u.autoTarget = 0;
  const dx = o.x - u.x, dy = o.y - u.y;
  if (dx * dx + dy * dy > 0.05) moveTo(s, u, o.x, o.y);
}

function exploreLogic(s: GameState, u: UnitEnt, o: Extract<Order, { k: 'explore' }>) {
  const S = s.map.size;
  const exp = s.players[u.owner as PlayerId].explored;
  const needNew = o.x < 0 || exp[clampI(Math.floor(o.y), S) * S + clampI(Math.floor(o.x), S)] === 1;
  if (needNew && (s.tick + u.id) % 5 === 0) {
    // nearest unexplored passable sample point
    let best: [number, number] | null = null, bd = 1e18;
    const stepG = 6;
    for (let y = 3; y < S - 2; y += stepG) {
      for (let x = 3; x < S - 2; x += stepG) {
        const i = y * S + x;
        if (exp[i] || isBlocked(s, i)) continue;
        const dx = x - u.x, dy = y - u.y;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = [x + 0.5, y + 0.5]; }
      }
    }
    if (!best) { setOrder(u, null); return; }
    o.x = best[0]; o.y = best[1];
    u.path = null; u.pathGoal = -1;
  }
  if (o.x >= 0 && moveTo(s, u, o.x, o.y)) { o.x = -1; }
}

// ---- gaia -------------------------------------------------------------------

function deerLogic(s: GameState, u: UnitEnt) {
  u.anim = 'idle';
  const o = u.order;
  if (o && o.k === 'move') {
    const S = s.map.size;
    const dx = o.x - u.x, dy = o.y - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    const sp = speedOf(u) * 0.4 * TICK_DT;
    if (d < sp) { u.x = o.x; u.y = o.y; u.order = null; }
    else {
      const nx = u.x + (dx / d) * sp, ny = u.y + (dy / d) * sp;
      if (isBlocked(s, Math.floor(ny) * S + Math.floor(nx))) u.order = null;
      else { u.x = nx; u.y = ny; u.anim = 'walk'; face(u, dx, dy); }
    }
    return;
  }
  if ((s.tick + u.id * 7) % 60 === 0) {
    let v: number;
    [s.rng, v] = rngNext(s.rng);
    if (v < 0.5) {
      let a: number, b: number;
      [s.rng, a] = rngNext(s.rng);
      [s.rng, b] = rngNext(s.rng);
      u.order = { k: 'move', x: u.x + (a - 0.5) * 4, y: u.y + (b - 0.5) * 4 };
    }
  }
}

// ---- separation -----------------------------------------------------------------

function separate(s: GameState) {
  const S = s.map.size;
  const cells = new Map<number, UnitEnt[]>();
  const units: UnitEnt[] = [];
  for (const e of s.entities) {
    if (e.kind !== 'unit' || e.hp <= 0) continue;
    units.push(e);
    const k = Math.floor(e.y) * S + Math.floor(e.x);
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(e);
  }
  const push = new Float64Array(units.length * 2);
  const index = new Map<number, number>();
  units.forEach((u, i) => index.set(u.id, i));
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const cx = Math.floor(u.x), cy = Math.floor(u.y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = cells.get((cy + dy) * S + (cx + dx));
        if (!arr) continue;
        for (const v of arr) {
          if (v.id <= u.id) continue;
          const ddx = v.x - u.x, ddy = v.y - u.y;
          const min = (unitRadius(u) + unitRadius(v)) * 0.9;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 >= min * min) continue;
          let d = Math.sqrt(d2);
          let nx: number, ny: number;
          if (d < 1e-4) { nx = ((u.id * 7) % 3) - 1 || 1; ny = ((v.id * 13) % 3) - 1; d = 1e-4; const l = Math.sqrt(nx * nx + ny * ny); nx /= l; ny /= l; }
          else { nx = ddx / d; ny = ddy / d; }
          const overlap = (min - d) * 0.25;
          const j = index.get(v.id)!;
          const wu = workingWeight(u), wv = workingWeight(v);
          push[i * 2] -= nx * overlap * wu; push[i * 2 + 1] -= ny * overlap * wu;
          push[j * 2] += nx * overlap * wv; push[j * 2 + 1] += ny * overlap * wv;
        }
      }
    }
  }
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const px = push[i * 2], py = push[i * 2 + 1];
    if (px === 0 && py === 0) continue;
    const nx = u.x + px, ny = u.y + py;
    const tx = Math.floor(nx), ty = Math.floor(ny);
    if (tx < 0 || ty < 0 || tx >= S || ty >= S) continue;
    if (isBlocked(s, ty * S + tx)) continue;
    u.x = nx; u.y = ny;
  }
  // units stuck inside blocked tiles get moved out
  for (const u of units) {
    const ti = Math.floor(u.y) * S + Math.floor(u.x);
    if (isBlocked(s, ti)) {
      const f = nearestFreeTile(s, Math.floor(u.x), Math.floor(u.y));
      if (f >= 0) { u.x = (f % S) + 0.5; u.y = Math.floor(f / S) + 0.5; u.path = null; }
    }
  }
}

function workingWeight(u: UnitEnt) { return u.anim === 'gather' || u.anim === 'build' || u.anim === 'attack' ? 0.3 : 1; }

// ---------------------------------------------------------------------------
// Fog of war

const circleCache = new Map<number, Int32Array>();
function circle(r: number): Int32Array {
  let c = circleCache.get(r);
  if (c) return c;
  const pts: number[] = [];
  const ri = Math.ceil(r);
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) if (dx * dx + dy * dy <= r * r + 0.5) pts.push(dx, dy);
  c = new Int32Array(pts);
  circleCache.set(r, c);
  return c;
}

export function updateVisibility(s: GameState) {
  const S = s.map.size;
  for (const p of [0, 1] as PlayerId[]) {
    const vis = s.derived.visible[p];
    vis.fill(0);
    const exp = s.players[p].explored;
    for (const e of s.entities) {
      if (e.owner !== p || e.hp <= 0) continue;
      let cx: number, cy: number, r: number;
      if (e.kind === 'unit') { cx = Math.floor(e.x); cy = Math.floor(e.y); r = UNITS[e.type as UnitType].sight; }
      else { const [bx, by] = bCenter(e); cx = Math.floor(bx); cy = Math.floor(by); r = BUILDINGS[e.type].sight + bSize(e) / 2; }
      const c = circle(r);
      for (let k = 0; k < c.length; k += 2) {
        const x = cx + c[k], y = cy + c[k + 1];
        if (x < 0 || y < 0 || x >= S || y >= S) continue;
        const i = y * S + x;
        vis[i] = 1;
        exp[i] = 1;
      }
    }
    // remember enemy buildings
    const mem = s.players[p].memory;
    for (const e of s.entities) {
      if (e.kind !== 'building' || e.owner === p || e.owner === -1 || e.hp <= 0) continue;
      if (buildingVisible(s, p, e)) mem[e.id] = { id: e.id, type: e.type, tx: e.tx, ty: e.ty, owner: e.owner, hp: Math.ceil(e.hp), built: e.built };
    }
    for (const k of Object.keys(mem)) {
      const m = mem[+k];
      const e = getEnt(s, m.id);
      if (!e) {
        // forget when its location is visible again
        if (vis[(m.ty) * S + m.tx]) delete mem[+k];
      }
    }
  }
}

export function buildingVisible(s: GameState, p: PlayerId, b: BuildingEnt): boolean {
  const S = s.map.size;
  const sz = bSize(b);
  const vis = s.derived.visible[p];
  for (let y = b.ty; y < b.ty + sz; y++) for (let x = b.tx; x < b.tx + sz; x++) if (vis[y * S + x]) return true;
  return false;
}

export function entityVisibleTo(s: GameState, p: PlayerId, e: Entity): boolean {
  if (e.owner === p) return true;
  if (e.kind === 'building') return buildingVisible(s, p, e);
  const S = s.map.size;
  const x = Math.floor(e.x), y = Math.floor(e.y);
  if (x < 0 || y < 0 || x >= S || y >= S) return false;
  return s.derived.visible[p][y * S + x] === 1;
}
