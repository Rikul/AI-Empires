// Resolves high-level LLM commands into concrete simulation commands. This runs inside
// the simulation at the decision's apply tick, so it is fully deterministic and replayable.
import {
  BUILDING_TYPES, BUILDINGS, BuildingType, Res, RES_YIELD, resBlocks, TECH_TYPES, TechType, UNIT_TYPES, UNITS, UnitType,
} from '../rules';
import {
  applyCommand, bCenter, bSize, entityVisibleTo, getEnt, isBlocked, placementError,
} from '../sim';
import type { AiCommand, BuildingEnt, Command, GameState, PlayerId, UnitEnt } from '../types';

export const AI_CATEGORY: Record<AiCommand['type'], string> = {
  gather: 'gathering',
  build: 'building placement',
  train: 'production',
  research: 'production',
  explore: 'exploration',
  move: 'movement',
  attack: 'attack',
  defend: 'defense',
  group: 'army coordination',
  stop: 'movement',
  rally: 'production',
};

export function commandCategories(c: AiCommand): string[] {
  const cats = [AI_CATEGORY[c.type] ?? 'other'];
  if (typeof c.units === 'string' && /^group:/i.test(c.units) && !cats.includes('army coordination')) cats.push('army coordination');
  return cats;
}

const MAX_COMMANDS = 40;

export function applyAiCommands(s: GameState, p: PlayerId, plan: string, cmds: AiCommand[]) {
  const ps = s.players[p];
  ps.plan = String(plan ?? '').slice(0, 800);
  ps.feedback = [];
  const used = new Set<number>();
  cmds.slice(0, MAX_COMMANDS).forEach((c, i) => {
    let res: string | null;
    try {
      res = applyOne(s, p, c, used);
    } catch (e) {
      res = `error: ${(e as Error).message}`;
    }
    ps.feedback.push(`#${i + 1} ${c?.type ?? '?'}: ${res ?? 'ok'}`);
  });
  if (cmds.length > MAX_COMMANDS) ps.feedback.push(`ignored ${cmds.length - MAX_COMMANDS} commands beyond the limit of ${MAX_COMMANDS}`);
}

function norm(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

export function parseBuildingType(v: unknown): BuildingType | null {
  const n = norm(v);
  if (!n) return null;
  for (const t of BUILDING_TYPES) if (norm(t) === n || norm(BUILDINGS[t].name) === n) return t;
  const aliases: Record<string, BuildingType> = { tower: 'WatchTower', tc: 'TownCenter', pit: 'StoragePit', storage: 'StoragePit', range: 'ArcheryRange', archery: 'ArcheryRange', smith: 'Blacksmith', walls: 'Wall' };
  return aliases[n] ?? null;
}

export function parseUnitType(v: unknown): UnitType | null {
  const n = norm(v).replace(/s$/, '');
  if (!n) return null;
  for (const t of UNIT_TYPES) if (norm(t) === n || norm(UNITS[t].name) === n) return t;
  const aliases: Record<string, UnitType> = { archer: 'Bowman', bow: 'Bowman', horsearcher: 'HorseArcher', cav: 'Cavalry', knight: 'Cavalry', sword: 'Swordsman', spear: 'Spearman', villagers: 'Villager', worker: 'Villager', skirm: 'Skirmisher' };
  return aliases[n] ?? null;
}

function parseTech(v: unknown): TechType | null {
  const n = norm(v);
  for (const t of TECH_TYPES) if (norm(t) === n) return t;
  return null;
}

function point(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length >= 2 && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) return [Number(v[0]), Number(v[1])];
  if (v && typeof v === 'object' && 'x' in v && 'y' in v) {
    const o = v as { x: unknown; y: unknown };
    if (Number.isFinite(Number(o.x)) && Number.isFinite(Number(o.y))) return [Number(o.x), Number(o.y)];
  }
  return null;
}

function ownUnits(s: GameState, p: PlayerId): UnitEnt[] {
  const out: UnitEnt[] = [];
  for (const e of s.entities) if (e.kind === 'unit' && e.owner === p && e.hp > 0) out.push(e);
  return out;
}
function ownBuildings(s: GameState, p: PlayerId): BuildingEnt[] {
  const out: BuildingEnt[] = [];
  for (const e of s.entities) if (e.kind === 'building' && e.owner === p && e.hp > 0) out.push(e);
  return out;
}

export function townCenter(s: GameState, p: PlayerId): BuildingEnt | null {
  for (const b of ownBuildings(s, p)) if (b.type === 'TownCenter') return b;
  return null;
}

function homePoint(s: GameState, p: PlayerId): [number, number] {
  const tc = townCenter(s, p);
  if (tc) return bCenter(tc);
  const st = s.map.starts[p];
  return [st[0] + 0.5, st[1] + 0.5];
}

/** Resolve a unit selector into own live units. */
export function selectUnits(s: GameState, p: PlayerId, sel: unknown, opts: { count?: unknown; near?: [number, number] | null; villagersOnly?: boolean; militaryOnly?: boolean; exclude?: Set<number> } = {}): UnitEnt[] {
  const all = ownUnits(s, p);
  let cands: UnitEnt[];
  if (Array.isArray(sel)) {
    const ids = new Set(sel.map((v) => Number(v)));
    cands = all.filter((u) => ids.has(u.id));
  } else {
    const str = String(sel ?? '').trim();
    const n = str.toLowerCase().replace(/[\s-]+/g, '_');
    const groups = s.players[p].groups;
    if (n.startsWith('group:') || groups[str]) {
      const name = n.startsWith('group:') ? str.slice(6).trim() : str;
      const ids = new Set(groups[name] ?? []);
      cands = all.filter((u) => ids.has(u.id));
    } else if (n.startsWith('type:') || parseUnitType(n)) {
      const t = parseUnitType(n.startsWith('type:') ? n.slice(5) : n);
      cands = all.filter((u) => u.type === t);
    } else if (n.startsWith('gatherers:')) {
      const r = n.slice(10);
      cands = all.filter((u) => u.type === 'Villager' && ((u.order?.k === 'gather' && RES_YIELD[u.order.res] === r) || (r === 'food' && u.order?.k === 'farm')));
    } else {
      switch (n) {
        case 'idle_villagers': case 'idle': case 'idle_villager': cands = all.filter((u) => u.type === 'Villager' && !u.order); break;
        case 'villagers': case 'all_villagers': case 'villager': case '': cands = all.filter((u) => u.type === 'Villager'); break;
        case 'military': case 'all_military': case 'army': case 'all_units_military': case 'soldiers': cands = all.filter((u) => u.type !== 'Villager'); break;
        case 'idle_military': cands = all.filter((u) => u.type !== 'Villager' && !u.order); break;
        case 'scouts': case 'scout': cands = all.filter((u) => u.type === 'Scout'); break;
        case 'all': cands = all; break;
        default: cands = []; break;
      }
    }
  }
  if (opts.villagersOnly) cands = cands.filter((u) => u.type === 'Villager');
  if (opts.militaryOnly) cands = cands.filter((u) => u.type !== 'Villager');
  const count = Number(opts.count);
  if (Number.isFinite(count) && count > 0) {
    const ex = opts.exclude;
    const near = opts.near;
    cands = cands.slice().sort((a, b) => {
      const ua = ex?.has(a.id) ? 1 : 0, ub = ex?.has(b.id) ? 1 : 0;
      if (ua !== ub) return ua - ub;
      const ia = a.order ? 1 : 0, ib = b.order ? 1 : 0;
      if (ia !== ib) return ia - ib;
      // builders are reassigned last
      const ba = a.order?.k === 'build' ? 1 : 0, bb = b.order?.k === 'build' ? 1 : 0;
      if (ba !== bb) return ba - bb;
      if (near) {
        const da = (a.x - near[0]) ** 2 + (a.y - near[1]) ** 2;
        const db = (b.x - near[0]) ** 2 + (b.y - near[1]) ** 2;
        if (da !== db) return da - db;
      }
      return a.id - b.id;
    }).slice(0, Math.floor(count));
  }
  return cands;
}

function centroid(units: UnitEnt[]): [number, number] {
  let x = 0, y = 0;
  for (const u of units) { x += u.x; y += u.y; }
  return [x / units.length, y / units.length];
}

/** Explored tiles of a natural resource with an accessible neighbour, nearest to ref first. */
function resourceCandidates(s: GameState, p: PlayerId, res: number[], ref: [number, number], limit: number): number[] {
  const S = s.map.size;
  const exp = s.players[p].explored;
  const out: [number, number][] = [];
  for (let i = 0; i < S * S; i++) {
    const r = s.map.resType[i];
    if (!r || !res.includes(r) || !exp[i] || s.map.resAmt[i] === 0) continue;
    const x = i % S, y = (i / S) | 0;
    if (resBlocks(r)) {
      let open = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < S && ny < S && !isBlocked(s, ny * S + nx)) { open = true; break; }
      }
      if (!open) continue;
    }
    const dx = x + 0.5 - ref[0], dy = y + 0.5 - ref[1];
    out.push([i, dx * dx + dy * dy]);
  }
  out.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return out.slice(0, limit).map((o) => o[0]);
}

function issue(s: GameState, p: PlayerId, c: Command): string | null {
  return applyCommand(s, p, c);
}

function applyOne(s: GameState, p: PlayerId, c: AiCommand, used: Set<number>): string | null {
  if (!c || typeof c !== 'object') return 'invalid command';
  const S = s.map.size;
  switch (c.type) {
    case 'gather': {
      const resource = norm(c.resource);
      const near = point(c.near) ?? point(c.at);
      const vills = selectUnits(s, p, c.units ?? 'idle_villagers', { count: c.count, near, villagersOnly: true, exclude: used });
      if (!vills.length) return 'no matching villagers';
      vills.forEach((v) => used.add(v.id));
      const ref = near ?? centroid(vills);
      let assigned = 0;
      if (['food', 'farm', 'farms'].includes(resource)) {
        // idle farms first
        const farms = ownBuildings(s, p).filter((b) => b.type === 'Farm' && b.built);
        const farmers = new Map<number, number>();
        for (const u of ownUnits(s, p)) if (u.order?.k === 'farm') farmers.set(u.order.target, (farmers.get(u.order.target) ?? 0) + 1);
        const free = farms.filter((f) => !farmers.get(f.id)).sort((a, b) => {
          const [ax, ay] = bCenter(a), [bx, by] = bCenter(b);
          return (ax - ref[0]) ** 2 + (ay - ref[1]) ** 2 - ((bx - ref[0]) ** 2 + (by - ref[1]) ** 2) || a.id - b.id;
        });
        while (assigned < vills.length && free.length) {
          const f = free.shift()!;
          issue(s, p, { t: 'assist', units: [vills[assigned].id], target: f.id });
          assigned++;
        }
        if (resource !== 'food' && assigned < vills.length) return assigned ? `only ${assigned} free farms; ${vills.length - assigned} villagers unassigned` : 'no free farms (build more Farms)';
      }
      if (assigned >= vills.length) return null;
      const rest = vills.slice(assigned);
      let resTypes: number[];
      switch (resource) {
        case 'wood': case 'tree': case 'trees': case 'lumber': resTypes = [Res.Tree]; break;
        case 'gold': resTypes = [Res.Gold]; break;
        case 'stone': resTypes = [Res.Stone]; break;
        case 'berries': case 'berry': case 'forage': resTypes = [Res.Berry]; break;
        case 'meat': resTypes = [Res.Meat]; break;
        case 'hunt': case 'deer': resTypes = []; break;
        case 'food': resTypes = [Res.Meat, Res.Berry]; break;
        default: return `unknown resource "${c.resource}"`;
      }
      const cands = resTypes.length ? resourceCandidates(s, p, resTypes, ref, 60) : [];
      const load = new Map<number, number>();
      const cap = resTypes.includes(Res.Tree) ? 1 : 2;
      for (const v of rest) {
        let best = -1, bd = 1e18;
        for (const i of cands) {
          const l = load.get(i) ?? 0;
          if (l >= cap + Math.floor(rest.length / Math.max(1, cands.length))) continue;
          const dx = (i % S) + 0.5 - v.x, dy = Math.floor(i / S) + 0.5 - v.y;
          const rx = (i % S) + 0.5 - ref[0], ry = Math.floor(i / S) + 0.5 - ref[1];
          const d = dx * dx + dy * dy + 2 * (rx * rx + ry * ry) + l * 20;
          if (d < bd) { bd = d; best = i; }
        }
        if (best >= 0) {
          load.set(best, (load.get(best) ?? 0) + 1);
          issue(s, p, { t: 'gather', units: [v.id], x: best % S, y: Math.floor(best / S) });
          assigned++;
          continue;
        }
        // hunting fallback for food
        if (resource === 'food' || resource === 'hunt' || resource === 'deer') {
          let deer: UnitEnt | null = null, dd = 1e18;
          for (const e of s.entities) {
            if (e.kind !== 'unit' || e.type !== 'Deer' || e.hp <= 0 || !entityVisibleTo(s, p, e)) continue;
            const d = (e.x - ref[0]) ** 2 + (e.y - ref[1]) ** 2;
            if (d < dd) { dd = d; deer = e; }
          }
          if (deer) { issue(s, p, { t: 'attack', units: [v.id], target: deer.id }); assigned++; continue; }
        }
      }
      if (!assigned) return `no known ${c.resource} (explore or build farms)`;
      return assigned < vills.length ? `assigned ${assigned}/${vills.length}` : null;
    }
    case 'build': {
      const type = parseBuildingType(c.building);
      if (!type) return `unknown building "${c.building}"`;
      const def = BUILDINGS[type];
      const at = point(c.at) ?? homePoint(s, p);
      const defaultCount = type === 'TownCenter' ? 4 : def.size >= 3 ? 2 : 1;
      const builders = selectUnits(s, p, c.units ?? 'villagers', { count: c.count ?? (Array.isArray(c.units) ? undefined : defaultCount), near: at, villagersOnly: true, exclude: used });
      if (!builders.length) return 'no villagers available to build';
      builders.forEach((b) => used.add(b.id));
      if (type === 'Wall') {
        const to = point(c.to);
        if (!to) return 'Wall needs "at" and "to" endpoints';
        return issue(s, p, { t: 'build', units: builders.map((b) => b.id), building: 'Wall', x: Math.floor(at[0]), y: Math.floor(at[1]), x2: Math.floor(to[0]), y2: Math.floor(to[1]) });
      }
      const spot = findPlacement(s, p, type, at[0], at[1], 10);
      if (!spot) return `no valid ${def.name} location near (${Math.round(at[0])},${Math.round(at[1])})`;
      const r = issue(s, p, { t: 'build', units: builders.map((b) => b.id), building: type, x: spot[0], y: spot[1] });
      if (r) return r;
      const [cx, cy] = [spot[0] + def.size / 2, spot[1] + def.size / 2];
      const moved = Math.abs(cx - at[0]) + Math.abs(cy - at[1]) > 1.5;
      return moved ? `ok (placed at (${cx},${cy}) instead)` : null;
    }
    case 'train': {
      const ut = parseUnitType(c.unit);
      if (!ut) return `unknown unit "${c.unit}"`;
      const def = UNITS[ut];
      let count = Math.max(1, Math.min(10, Math.floor(Number(c.count ?? 1)) || 1));
      let blds: BuildingEnt[];
      if (c.building !== undefined && Number.isFinite(Number(c.building))) {
        const b = getEnt(s, Number(c.building));
        blds = b && b.kind === 'building' && b.owner === p ? [b] : [];
      } else blds = ownBuildings(s, p).filter((b) => b.type === def.trainedAt && b.built);
      if (!blds.length) return `no finished ${BUILDINGS[def.trainedAt].name}`;
      let lastErr: string | null = null, queued = 0;
      while (count > 0) {
        blds.sort((a, b) => a.queue.length - b.queue.length || a.id - b.id);
        const r = issue(s, p, { t: 'train', building: blds[0].id, unit: ut, count: 1 });
        if (r) { lastErr = r; break; }
        queued++;
        count--;
      }
      if (!queued) return lastErr;
      return lastErr ? `queued ${queued} (${lastErr})` : null;
    }
    case 'research': {
      const t = parseTech(c.tech);
      if (!t) return `unknown tech "${c.tech}"`;
      const b = ownBuildings(s, p).find((x) => x.built && BUILDINGS[x.type].researches.includes(t));
      if (!b) return 'need a finished Blacksmith';
      return issue(s, p, { t: 'research', building: b.id, tech: t });
    }
    case 'explore': {
      const units = selectUnits(s, p, c.units ?? 'scouts', { count: c.count, exclude: used });
      if (!units.length) return 'no units to explore with';
      units.forEach((u) => used.add(u.id));
      const to = point(c.to) ?? point(c.at);
      if (to) return issue(s, p, { t: 'move', units: units.map((u) => u.id), x: clamp(to[0], S), y: clamp(to[1], S) });
      return issue(s, p, { t: 'explore', units: units.map((u) => u.id) });
    }
    case 'move': {
      const to = point(c.to) ?? point(c.at);
      if (!to) return 'move needs "to"';
      const units = selectUnits(s, p, c.units, { count: c.count, near: to, exclude: used });
      if (!units.length) return 'no matching units';
      units.forEach((u) => used.add(u.id));
      return issue(s, p, { t: 'move', units: units.map((u) => u.id), x: clamp(to[0], S), y: clamp(to[1], S) });
    }
    case 'attack': {
      const to = point(c.to) ?? point(c.at);
      const units = selectUnits(s, p, c.units ?? 'military', { count: c.count, near: to, exclude: used, militaryOnly: c.units === undefined });
      if (!units.length) return 'no matching units';
      units.forEach((u) => used.add(u.id));
      const ids = units.map((u) => u.id);
      if (c.target !== undefined) {
        const tid = Number(c.target);
        const t = getEnt(s, tid);
        if (t && t.owner !== p && entityVisibleTo(s, p, t)) return issue(s, p, { t: 'attack', units: ids, target: tid });
        const mem = s.players[p].memory[tid];
        if (mem) {
          const sz = BUILDINGS[mem.type].size;
          return issue(s, p, { t: 'move', units: ids, x: mem.tx + sz / 2, y: mem.ty + sz / 2, attack: true });
        }
        if (!to) return `target ${tid} is not visible or unknown`;
      }
      if (!to) return 'attack needs "target" or "to"';
      return issue(s, p, { t: 'move', units: ids, x: clamp(to[0], S), y: clamp(to[1], S), attack: true });
    }
    case 'defend': {
      const at = point(c.at) ?? point(c.to) ?? homePoint(s, p);
      const units = selectUnits(s, p, c.units ?? 'military', { count: c.count, near: at, exclude: used });
      if (!units.length) return 'no matching units';
      units.forEach((u) => used.add(u.id));
      return issue(s, p, { t: 'guard', units: units.map((u) => u.id), x: clamp(at[0], S), y: clamp(at[1], S), r: Number(c.radius ?? 8) || 8 });
    }
    case 'group': {
      const name = String(c.name ?? '').trim().slice(0, 24);
      if (!name || /^group:/i.test(name)) return 'group needs a "name"';
      const units = selectUnits(s, p, c.units, { count: c.count });
      const groups = s.players[p].groups;
      if (!units.length) { delete groups[name]; return 'group cleared (no units)'; }
      groups[name] = units.map((u) => u.id);
      if (Object.keys(groups).length > 12) delete groups[Object.keys(groups)[0]];
      return null;
    }
    case 'stop': {
      const units = selectUnits(s, p, c.units, { count: c.count });
      return issue(s, p, { t: 'stop', units: units.map((u) => u.id) });
    }
    case 'rally': {
      const at = point(c.at) ?? point(c.to);
      if (!at) return 'rally needs "at"';
      let blds: BuildingEnt[];
      if (Number.isFinite(Number(c.building))) {
        const b = getEnt(s, Number(c.building));
        blds = b && b.kind === 'building' && b.owner === p ? [b] : [];
      } else {
        const t = parseBuildingType(c.building);
        blds = ownBuildings(s, p).filter((b) => (t ? b.type === t : BUILDINGS[b.type].trains.length > 0));
      }
      if (!blds.length) return 'no such building';
      for (const b of blds) issue(s, p, { t: 'rally', building: b.id, x: clamp(at[0], S), y: clamp(at[1], S) });
      return null;
    }
    default:
      return `unknown command type "${(c as AiCommand).type}"`;
  }
}

function clamp(v: number, S: number) { return Math.max(0.5, Math.min(S - 0.5, v)); }

/** Nearest valid top-left placement for a building centred near (cx, cy). */
export function findPlacement(s: GameState, p: PlayerId, type: BuildingType, cx: number, cy: number, maxR: number): [number, number] | null {
  const sz = BUILDINGS[type].size;
  const x0 = Math.round(cx - sz / 2), y0 = Math.round(cy - sz / 2);
  let fallback: [number, number] | null = null;
  for (let r = 0; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx, y = y0 + dy;
        if (placementError(s, p, type, x, y)) continue;
        if (type === 'Wall' || hasMargin(s, x, y, sz)) return [x, y];
        if (!fallback) fallback = [x, y];
      }
    }
    if (fallback && r >= 3) return fallback;
  }
  return fallback;
}

/** Keep a one-tile corridor around buildings so bases stay walkable. */
function hasMargin(s: GameState, tx: number, ty: number, sz: number): boolean {
  const S = s.map.size;
  for (let y = ty - 1; y <= ty + sz; y++) {
    for (let x = tx - 1; x <= tx + sz; x++) {
      if (x >= tx && x < tx + sz && y >= ty && y < ty + sz) continue;
      if (x < 0 || y < 0 || x >= S || y >= S) return false;
      const i = y * S + x;
      if (s.derived.bgrid[i] !== 0) return false;
      if (resBlocks(s.map.resType[i]) && s.map.resType[i] !== Res.Tree) return false;
    }
  }
  return true;
}

export { bSize };
