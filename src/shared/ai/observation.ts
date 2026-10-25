// Builds what one side knows (fog-of-war filtered) as a compact JSON object for the LLM.
import { BUILDING_TYPES, BUILDINGS, Res, RES_NAMES, TECH_TYPES, TECHS, TICK_RATE, UNIT_TYPES, UNITS, UnitType } from '../rules';
import { bCenter, entityVisibleTo, hasBuilt, popCapacity, popUsed, techAvailable, timeLimitTicks } from '../sim';
import type { GameState, Order, PlayerId, UnitEnt } from '../types';

export function fmtTime(ticks: number): string {
  const s = Math.floor(ticks / TICK_RATE);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function describeOrder(o: Order | null, u?: UnitEnt): string {
  if (!o) return 'idle';
  switch (o.k) {
    case 'move': return `moving to (${r1(o.x)},${r1(o.y)})`;
    case 'amove': return `attack-moving to (${r1(o.x)},${r1(o.y)})`;
    case 'attack': return `attacking #${o.target}`;
    case 'gather': return `gathering ${RES_NAMES[o.res]} at (${o.tx},${o.ty})${u && u.carry >= 1 ? ` carrying ${Math.floor(u.carry)} ${u.carryType}` : ''}`;
    case 'farm': return `farming #${o.target}`;
    case 'build': return `building #${o.target}`;
    case 'guard': return `defending (${r1(o.x)},${r1(o.y)}) r=${o.r}`;
    case 'explore': return 'exploring';
  }
}

export interface Observation {
  you: string;
  time: string;
  timeLeft: string;
  resources: Record<string, number>;
  population: { used: number; capacity: number; max: number };
  techs: string[];
  map: Record<string, unknown>;
  canBuild: string[];
  canTrain: string[];
  canResearch: string[];
  buildings: unknown[];
  villagers: unknown[];
  villagerSummary: Record<string, number>;
  military: unknown[];
  groups: Record<string, number[]>;
  enemy: { visibleUnits: unknown[]; knownBuildings: unknown[] };
  knownResources: Record<string, unknown[]>;
  recentEvents: string[];
  lastCommandResults: string[];
  yourPreviousPlan: string;
}

export function buildObservation(s: GameState, p: PlayerId): Observation {
  const S = s.map.size;
  const ps = s.players[p];
  const enemy = (1 - p) as PlayerId;
  const own = s.entities.filter((e) => e.owner === p && e.hp > 0);
  const tc = own.find((e) => e.kind === 'building' && e.type === 'TownCenter');
  const home: [number, number] = tc && tc.kind === 'building' ? bCenter(tc) : [s.map.starts[p][0] + 0.5, s.map.starts[p][1] + 0.5];

  let explored = 0;
  for (let i = 0; i < S * S; i++) explored += ps.explored[i];

  const buildings = own.filter((e) => e.kind === 'building').map((b) => {
    if (b.kind !== 'building') return null;
    const def = BUILDINGS[b.type];
    const [cx, cy] = bCenter(b);
    const o: Record<string, unknown> = { id: b.id, type: b.type, at: [cx, cy], hp: `${Math.ceil(b.hp)}/${def.hp}` };
    if (!b.built) o.status = `under construction ${Math.floor((b.progress / def.buildTime) * 100)}%`;
    if (b.queue.length) o.queue = b.queue.map((q) => `${q.what}${q.progress > 0 ? ` ${Math.floor((q.progress / (q.kind === 'unit' ? UNITS[q.what as UnitType].trainTime : TECHS[q.what as keyof typeof TECHS].time)) * 100)}%` : ''}`);
    if (b.type === 'Farm') o.food = b.food;
    return o;
  }).filter(Boolean);

  const villagers: unknown[] = [];
  const summary: Record<string, number> = { idle: 0, food: 0, wood: 0, gold: 0, stone: 0, building: 0, other: 0 };
  const military: unknown[] = [];
  for (const e of own) {
    if (e.kind !== 'unit') continue;
    const at = [r1(e.x), r1(e.y)];
    if (e.type === 'Villager') {
      villagers.push({ id: e.id, at, task: describeOrder(e.order, e), ...(e.hp < UNITS.Villager.hp ? { hp: e.hp } : {}) });
      const o = e.order;
      if (!o) summary.idle++;
      else if (o.k === 'gather') summary[o.res === Res.Tree ? 'wood' : o.res === Res.Gold ? 'gold' : o.res === Res.Stone ? 'stone' : 'food']++;
      else if (o.k === 'farm') summary.food++;
      else if (o.k === 'build') summary.building++;
      else summary.other++;
    } else {
      military.push({ id: e.id, type: e.type, at, hp: `${e.hp}/${UNITS[e.type as UnitType].hp}`, task: describeOrder(e.order) });
    }
  }

  // enemy knowledge
  const visibleUnits: { id: number; type: string; at: number[]; hp: number; d: number }[] = [];
  for (const e of s.entities) {
    if (e.kind !== 'unit' || e.hp <= 0 || e.owner !== enemy) continue;
    if (!entityVisibleTo(s, p, e)) continue;
    visibleUnits.push({ id: e.id, type: e.type, at: [r1(e.x), r1(e.y)], hp: e.hp, d: (e.x - home[0]) ** 2 + (e.y - home[1]) ** 2 });
  }
  visibleUnits.sort((a, b) => a.d - b.d || a.id - b.id);
  const knownBuildings = Object.values(ps.memory).filter((m) => m.owner === enemy).sort((a, b) => a.id - b.id).map((m) => {
    const sz = BUILDINGS[m.type].size;
    const ent = s.derived.byId.get(m.id);
    const visible = !!ent && ent.hp > 0 && entityVisibleTo(s, p, ent);
    return { id: m.id, type: m.type, at: [m.tx + sz / 2, m.ty + sz / 2], hp: visible && ent ? Math.ceil(ent.hp) : m.hp, visibleNow: visible, ...(m.built ? {} : { underConstruction: true }) };
  });
  const enemyTC = knownBuildings.find((b) => b.type === 'TownCenter');
  const st = s.map.starts[p];

  // resource clusters in explored territory
  const CH = 8;
  const clusters = new Map<string, { res: number; count: number; amount: number; sx: number; sy: number; best: number; bd: number }>();
  for (let i = 0; i < S * S; i++) {
    const r = s.map.resType[i];
    if (!r || !ps.explored[i]) continue;
    const x = i % S, y = (i / S) | 0;
    const key = `${r}:${Math.floor(x / CH)}:${Math.floor(y / CH)}`;
    let c = clusters.get(key);
    if (!c) { c = { res: r, count: 0, amount: 0, sx: 0, sy: 0, best: i, bd: 1e9 }; clusters.set(key, c); }
    c.count++;
    c.amount += s.map.resAmt[i];
    c.sx += x; c.sy += y;
  }
  const knownResources: Record<string, unknown[]> = { wood: [], gold: [], stone: [], berries: [], meat: [], deer: [] };
  const byRes: Record<number, { at: number[]; amount: number; tiles: number; dist: number }[]> = {};
  for (const c of clusters.values()) {
    const mx = c.sx / c.count, my = c.sy / c.count;
    // representative tile: the cluster tile closest to its centroid
    let best = -1, bd = 1e9;
    const x0 = Math.floor(mx / CH) * CH, y0 = Math.floor(my / CH) * CH;
    for (let y = y0; y < Math.min(S, y0 + CH); y++) for (let x = x0; x < Math.min(S, x0 + CH); x++) {
      const i = y * S + x;
      if (s.map.resType[i] !== c.res || !ps.explored[i]) continue;
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) continue;
    const bx = best % S, by = Math.floor(best / S);
    (byRes[c.res] ??= []).push({ at: [bx, by], amount: c.amount, tiles: c.count, dist: Math.round(Math.sqrt((bx - home[0]) ** 2 + (by - home[1]) ** 2)) });
  }
  const names: Record<number, string> = { [Res.Tree]: 'wood', [Res.Gold]: 'gold', [Res.Stone]: 'stone', [Res.Berry]: 'berries', [Res.Meat]: 'meat' };
  for (const [r, list] of Object.entries(byRes)) {
    list.sort((a, b) => a.dist - b.dist || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
    knownResources[names[+r]] = list.slice(0, 6).map((l) => ({ at: l.at, amount: l.amount, tiles: l.tiles, distFromBase: l.dist }));
  }
  const deer = s.entities.filter((e) => e.kind === 'unit' && e.type === 'Deer' && e.hp > 0 && entityVisibleTo(s, p, e)) as UnitEnt[];
  knownResources.deer = deer.slice(0, 8).map((d) => ({ id: d.id, at: [r1(d.x), r1(d.y)] }));

  // groups (live members only)
  const groups: Record<string, number[]> = {};
  for (const [name, ids] of Object.entries(ps.groups)) {
    const live = ids.filter((id) => { const e = s.derived.byId.get(id); return e && e.hp > 0; });
    if (live.length) groups[name] = live;
  }

  const canBuild = BUILDING_TYPES.filter((t) => BUILDINGS[t].requires.every((r) => hasBuilt(s, p, r)));
  const canTrain = UNIT_TYPES.filter((t) => hasBuilt(s, p, UNITS[t].trainedAt) && UNITS[t].requires.every((r) => hasBuilt(s, p, r)));
  const canResearch = hasBuilt(s, p, 'Blacksmith') ? TECH_TYPES.filter((t) => techAvailable(s, p, t)) : [];

  return {
    you: `Player ${p + 1} (${p === 0 ? 'blue' : 'red'})`,
    time: fmtTime(s.tick),
    timeLeft: fmtTime(Math.max(0, timeLimitTicks(s.config) - s.tick)),
    resources: { ...ps.res },
    population: { used: popUsed(s, p), capacity: popCapacity(s, p), max: s.config.popCap },
    techs: [...ps.techs],
    map: {
      size: S,
      yourBase: home,
      enemyBase: enemyTC ? enemyTC.at : `unknown — maps are point-symmetric, so the enemy most likely started near (${S - 1 - st[0]},${S - 1 - st[1]})`,
      exploredPercent: Math.round((explored / (S * S)) * 100),
    },
    canBuild,
    canTrain,
    canResearch,
    buildings,
    villagers,
    villagerSummary: summary,
    military,
    groups,
    enemy: { visibleUnits: visibleUnits.slice(0, 40).map(({ d: _d, ...rest }) => rest), knownBuildings },
    knownResources,
    recentEvents: ps.alerts.slice(-12).map((a) => `[${fmtTime(a.tick)}] ${a.text}`),
    lastCommandResults: ps.feedback.slice(0, 40),
    yourPreviousPlan: ps.plan,
  };
}
