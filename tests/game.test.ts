import { describe, expect, it } from 'vitest';
import { generateMap, mapStats } from '../src/shared/mapgen';
import {
  BIOMES, BUILDING_TYPES, BUILDINGS, DEFAULT_POP_CAP, DEFAULT_TIME_LIMIT_MIN, MAP_SIZES, MapSize, Res, STARTING_RESOURCES, UNIT_TYPES, UNITS,
} from '../src/shared/rules';
import { applyCommand, createInitialState, getEnt, popCapacity, popUsed, scoreSide, step, timeLimitTicks } from '../src/shared/sim';
import { hashState } from '../src/shared/serialize';
import { runHeadless, testConfig, mockProvider } from '../src/shared/headless';
import { MatchEngine, newRecord } from '../src/shared/engine';
import { LiveMatch, DecisionProvider } from '../src/shared/controller';
import { exportRecord, validateRecord } from '../src/shared/record';
import { commandCategories, findPlacement } from '../src/shared/ai/apply';
import { parseDecision } from '../src/shared/ai/prompt';
import type { BuildingEnt, GameState, MatchConfig, PlayerId, UnitEnt } from '../src/shared/types';

const units = (s: GameState, p: PlayerId) => s.entities.filter((e): e is UnitEnt => e.kind === 'unit' && e.owner === p && e.hp > 0);
const buildings = (s: GameState, p: PlayerId) => s.entities.filter((e): e is BuildingEnt => e.kind === 'building' && e.owner === p && e.hp > 0);
const run = (s: GameState, ticks: number) => { for (let i = 0; i < ticks && !s.result; i++) step(s, []); };

function mapHash(seed: string, size: MapSize, biome: (typeof BIOMES)[number]) {
  const m = generateMap(seed, size, biome);
  let h = 0;
  for (let i = 0; i < m.terrain.length; i++) h = (Math.imul(h, 31) + m.terrain[i] * 7 + m.resType[i] * 13 + m.resAmt[i]) | 0;
  return `${h}:${m.starts.join(',')}:${m.deer.length}`;
}

describe('maps', () => {
  it('every size × biome combination generates a playable map', () => {
    for (const size of Object.keys(MAP_SIZES) as MapSize[]) {
      for (const biome of BIOMES) {
        const m = generateMap('acceptance', size, biome);
        const st = mapStats(m);
        expect(m.size).toBe(MAP_SIZES[size]);
        expect(st.basesConnected, `${size}/${biome} connected`).toBe(true);
        expect(st.reachableFraction, `${size}/${biome} walkable`).toBeGreaterThan(0.4);
        expect(st.trees).toBeGreaterThan(100);
        expect(st.gold).toBeGreaterThanOrEqual(10);
        expect(st.stone).toBeGreaterThanOrEqual(8);
        expect(st.berries).toBeGreaterThanOrEqual(12);
        // the initial state is valid and a short simulation runs
        const s = createInitialState(testConfig({ mapSize: size, biome, seed: 'acceptance' }));
        run(s, 50);
        expect(s.result).toBeNull();
      }
    }
  });

  it('same seed, size, biome and version produce the same map; different seeds differ', () => {
    expect(mapHash('abc', 'Medium', 'DesertOasis')).toBe(mapHash('abc', 'Medium', 'DesertOasis'));
    expect(mapHash('abc', 'Medium', 'DesertOasis')).not.toBe(mapHash('abd', 'Medium', 'DesertOasis'));
    expect(mapHash('abc', 'Medium', 'DesertOasis')).not.toBe(mapHash('abc', 'Large', 'DesertOasis'));
    expect(() => generateMap('abc', 'Small', 'DesertOasis', 99)).toThrow();
  });

  it('maps are point-symmetric so both sides get equivalent resources', () => {
    const m = generateMap('fair', 'Large', 'RockySteppe');
    const N = m.size * m.size;
    for (let i = 0; i < N; i++) expect(m.resType[i]).toBe(m.resType[N - 1 - i]);
  });
});

describe('starting conditions and defaults', () => {
  it('each side starts with 1 Town Center, 6 villagers, 1 scout, 300/300/150/100 and room for all units', () => {
    const s = createInitialState(testConfig());
    for (const p of [0, 1] as PlayerId[]) {
      const b = buildings(s, p), u = units(s, p);
      expect(b.length).toBe(1);
      expect(b[0].type).toBe('TownCenter');
      expect(u.filter((x) => x.type === 'Villager').length).toBe(6);
      expect(u.filter((x) => x.type === 'Scout').length).toBe(1);
      expect(u.length).toBe(7);
      expect(s.players[p].res).toEqual({ food: 300, wood: 300, gold: 150, stone: 100 });
      expect(popCapacity(s, p)).toBeGreaterThanOrEqual(popUsed(s, p));
    }
    expect(STARTING_RESOURCES).toEqual({ food: 300, wood: 300, gold: 150, stone: 100 });
  });

  it('defaults are pop cap 200 and a 60 minute limit', () => {
    expect(DEFAULT_POP_CAP).toBe(200);
    expect(DEFAULT_TIME_LIMIT_MIN).toBe(60);
  });
});

describe('rules', () => {
  it('all buildings and units are usable by both sides with identical rules', () => {
    const s = createInitialState(testConfig({ seed: 'usable' }));
    for (const p of [0, 1] as PlayerId[]) {
      s.players[p].res = { food: 99999, wood: 99999, gold: 99999, stone: 99999 };
      s.players[p].explored.fill(1);
    }
    const S = s.map.size;
    const placed: Record<number, BuildingEnt[]> = { 0: [], 1: [] };
    for (const p of [0, 1] as PlayerId[]) {
      const tc = buildings(s, p)[0];
      const vills = units(s, p).filter((u) => u.type === 'Villager').map((u) => u.id);
      // place each building type in a spiral around the TC and let villagers finish them
      let k = 0;
      for (const type of BUILDING_TYPES) {
        let ok = false;
        for (let r = 4; r < 30 && !ok; r++) {
          for (let a = 0; a < 16 && !ok; a++) {
            const x = tc.tx + Math.round(r * Math.cos((a / 16) * Math.PI * 2 + k));
            const y = tc.ty + Math.round(r * Math.sin((a / 16) * Math.PI * 2 + k));
            if (x < 2 || y < 2 || x > S - 6 || y > S - 6) continue;
            const before = buildings(s, p).length;
            const err = applyCommand(s, p, { t: 'build', units: vills, building: type, x, y });
            if (!err && buildings(s, p).length > before) ok = true;
          }
        }
        k += 0.7;
        expect(ok, `player ${p} can place ${type}`).toBe(true);
        const b = buildings(s, p).at(-1)!;
        // instant-complete for the test (construction itself is covered elsewhere)
        b.built = true; b.progress = BUILDINGS[type].buildTime; b.hp = BUILDINGS[type].hp;
        placed[p].push(b);
      }
    }
    // free population room (TC + House = 15) for one of each unit type
    for (const p of [0, 1] as PlayerId[]) for (const u of units(s, p)) u.hp = 0;
    run(s, 30);
    for (const p of [0, 1] as PlayerId[]) {
      for (const ut of UNIT_TYPES) {
        const b = placed[p].find((x) => x.type === UNITS[ut].trainedAt)!;
        expect(applyCommand(s, p, { t: 'train', building: b.id, unit: ut, count: 1 }), `${p} trains ${ut}`).toBeNull();
      }
      const smith = placed[p].find((x) => x.type === 'Blacksmith')!;
      expect(applyCommand(s, p, { t: 'research', building: smith.id, tech: 'Toolworking' })).toBeNull();
    }
    run(s, 1300); // the Barracks queue is 95 s long
    for (const p of [0, 1] as PlayerId[]) {
      const types = new Set(units(s, p).map((u) => u.type));
      for (const ut of UNIT_TYPES) expect(types.has(ut), `player ${p} has ${ut}`).toBe(true);
      expect(s.players[p].techs).toContain('Toolworking');
    }
  });

  it('villagers deplete finite resources and deposit only at compatible drop-offs', () => {
    const s = createInitialState(testConfig({ seed: 'gather' }));
    const S = s.map.size;
    const p: PlayerId = 0;
    const tc = buildings(s, p)[0];
    const v = units(s, p).find((u) => u.type === 'Villager')!;
    // find nearest tree
    let tree = -1, bd = 1e9;
    for (let i = 0; i < S * S; i++) {
      if (s.map.resType[i] !== Res.Tree) continue;
      const d = ((i % S) - tc.tx) ** 2 + (Math.floor(i / S) - tc.ty) ** 2;
      if (d < bd) { bd = d; tree = i; }
    }
    const tx = tree % S, ty = Math.floor(tree / S);
    // remove the Town Center's drop-off ability by replacing it with a Granary-only setup:
    // wood must not be accepted at a Granary
    s.players[p].res.wood = 1000;
    s.players[p].explored.fill(1);
    tc.hp = 0; // destroy TC so the only drop-off will be a granary
    run(s, 1);
    const err = applyCommand(s, p, { t: 'build', units: [v.id], building: 'Granary', x: tx + 2 > S - 4 ? tx - 4 : tx + 2, y: ty });
    if (err) applyCommand(s, p, { t: 'build', units: [v.id], building: 'Granary', x: tx - 4, y: ty - 3 });
    const gran = buildings(s, p).find((b) => b.type === 'Granary')!;
    gran.built = true; gran.progress = BUILDINGS.Granary.buildTime; gran.hp = BUILDINGS.Granary.hp;
    const amount0 = s.map.resAmt[tree];
    const wood0 = s.players[p].res.wood;
    applyCommand(s, p, { t: 'gather', units: [v.id], x: tx, y: ty });
    run(s, 600);
    expect(s.map.resAmt[tree] < amount0 || s.map.resType[tree] !== Res.Tree).toBe(true);
    expect(s.players[p].res.wood).toBe(wood0); // no compatible drop-off: nothing deposited
    expect(v.carry).toBeGreaterThanOrEqual(10 - 1e-9);
    // now add a storage pit: wood gets deposited
    applyCommand(s, p, { t: 'build', units: [], building: 'StoragePit', x: gran.tx, y: gran.ty + 3 });
    const pit = buildings(s, p).find((b) => b.type === 'StoragePit');
    expect(pit).toBeTruthy();
    pit!.built = true; pit!.hp = BUILDINGS.StoragePit.hp; pit!.progress = BUILDINGS.StoragePit.buildTime;
    const wood1 = s.players[p].res.wood;
    applyCommand(s, p, { t: 'gather', units: [v.id], x: tx, y: ty });
    run(s, 900);
    expect(s.players[p].res.wood).toBeGreaterThan(wood1);
  });

  it('a tree is removed when depleted', () => {
    const s = createInitialState(testConfig({ seed: 'deplete' }));
    const S = s.map.size;
    const v = units(s, 0).find((u) => u.type === 'Villager')!;
    const tc = buildings(s, 0)[0];
    let tree = -1, bd = 1e9;
    for (let i = 0; i < S * S; i++) if (s.map.resType[i] === Res.Tree) { const d = ((i % S) - tc.tx) ** 2 + (Math.floor(i / S) - tc.ty) ** 2; if (d < bd) { bd = d; tree = i; } }
    s.map.resAmt[tree] = 5;
    applyCommand(s, 0, { t: 'gather', units: [v.id], x: tree % S, y: Math.floor(tree / S) });
    run(s, 900);
    expect(s.map.resType[tree]).toBe(Res.None);
  });

  it('conquest needs the Town Center and every unit gone; other buildings do not prevent defeat', () => {
    const s = createInitialState(testConfig({ seed: 'conquest' }));
    s.players[1].explored.fill(1);
    const spot = findPlacement(s, 1, 'House', s.map.starts[1][0] + 4, s.map.starts[1][1] + 4, 10)!;
    expect(applyCommand(s, 1, { t: 'build', units: [], building: 'House', x: spot[0], y: spot[1] })).toBeNull();
    const house = buildings(s, 1).find((b) => b.type === 'House')!;
    house.built = true; house.hp = BUILDINGS.House.hp;
    // lose the Town Center but keep units: match continues
    buildings(s, 1).find((b) => b.type === 'TownCenter')!.hp = 0;
    run(s, 2);
    expect(s.result).toBeNull();
    // lose all units too: defeat although a House remains
    for (const u of units(s, 1)) u.hp = 0;
    run(s, 2);
    expect(buildings(s, 1).some((b) => b.type === 'House')).toBe(true);
    expect(s.result?.reason).toBe('conquest');
    expect(s.result?.winner).toBe(0);
  });

  it('losing all units but keeping the Town Center is not defeat', () => {
    const s = createInitialState(testConfig({ seed: 'tc-only' }));
    for (const u of units(s, 1)) u.hp = 0;
    run(s, 30);
    expect(s.result).toBeNull();
  });

  it('time limit decides by surviving asset value; equal scores draw', () => {
    const cfg = testConfig({ timeLimitMin: 1, seed: 'timeup' });
    const s = createInitialState(cfg);
    run(s, timeLimitTicks(cfg));
    expect(s.result?.reason).toBe('time');
    // untouched symmetric sides: TC 375 + 6×50 + 100 = 775 each -> draw
    expect(s.result?.scores).toEqual([775, 775]);
    expect(s.result?.winner).toBeNull();

    const s2 = createInitialState(cfg);
    const vill = units(s2, 1).find((u) => u.type === 'Villager')!;
    vill.hp = 12.5; // half HP -> 25 value lost
    run(s2, timeLimitTicks(cfg));
    expect(s2.result?.scores[0]).toBe(775);
    expect(s2.result?.scores[1]).toBe(750);
    expect(s2.result?.winner).toBe(0);
    expect(scoreSide(s2, 1)).toBe(750);
  });
});

describe('LLM decisions, timing and replay', () => {
  it('the commander issues every order category over a match', async () => {
    const { record } = await runHeadless(testConfig({ seed: 'categories' }), { maxTicks: 12000 });
    const cats = new Set<string>();
    for (const d of record.decisions) for (const c of d.commands) for (const k of commandCategories(c)) cats.add(k);
    for (const k of ['exploration', 'gathering', 'building placement', 'movement', 'attack', 'defense', 'army coordination']) expect(cats.has(k), k).toBe(true);
  }, 60000);

  it('no decision requests are made for the human side in Player vs AI', async () => {
    const calls: number[] = [];
    const provider: DecisionProvider = async (p, ai, m) => { calls.push(p); return mockProvider(p, ai, m); };
    const cfg: MatchConfig = { ...testConfig(), mode: 'pva', players: [{ kind: 'human', name: 'H' }, testConfig().players[1]] };
    await runHeadless(cfg, { maxTicks: 3000, provider });
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.every((p) => p === 1)).toBe(true);
  }, 60000);

  it('wall-clock pacing (1x/2x) and model latency do not change outcomes or decision ticks', async () => {
    const replies = new Map<string, string>();
    const mk = (delayFor: (n: number) => number): DecisionProvider => {
      let n = 0;
      return async (p, ai, m) => {
        const k = n++;
        const r = await mockProvider(p, ai, m);
        replies.set(`${p}`, r.content);
        await new Promise((res) => setTimeout(res, delayFor(k)));
        return r;
      };
    };
    async function pace(stepsPerFrame: number, delay: (n: number) => number) {
      const rec = newRecord(testConfig({ seed: 'pacing', timeLimitMin: 4 }), 'x', 'x');
      const eng = new MatchEngine(rec, 'record');
      const live = new LiveMatch(eng, mk(delay));
      while (!eng.finished) {
        for (let i = 0; i < stepsPerFrame; i++) {
          const r = live.tryStep();
          if (r !== 'stepped') break;
        }
        await new Promise((res) => setTimeout(res, 0));
      }
      return { hash: hashState(eng.state), decisionTicks: rec.decisions.map((d) => `${d.player}:${d.requestTick}:${d.applyTick}`).sort(), result: eng.state.result };
    }
    const a = await pace(1, () => 0); // "1x"
    const b = await pace(2, (n) => (n % 3) * 3); // "2x" with variable latency
    expect(b.hash).toBe(a.hash);
    expect(b.decisionTicks).toEqual(a.decisionTicks);
    expect(b.result).toEqual(a.result);
    // decisions every 15 simulated seconds
    const p1 = a.decisionTicks.filter((d) => d.startsWith('1:')).map((d) => Number(d.split(':')[1])).sort((x, y) => x - y);
    expect(p1.slice(0, 4)).toEqual([0, 150, 300, 450]);
  }, 60000);

  it('pausing stops at a tick boundary while a decision request is in flight', async () => {
    const resolvers: ((v: { content: string; latencyMs: number }) => void)[] = [];
    const provider: DecisionProvider = () => new Promise((res) => { resolvers.push(res); });
    const rec = newRecord(testConfig(), 'p', 'p');
    const eng = new MatchEngine(rec, 'record');
    const live = new LiveMatch(eng, provider);
    let r = live.tryStep(); // tick 0: requests decisions
    expect(r).toBe('stepped');
    expect(live.waitingFor().length).toBe(2); // one request per AI side
    // play until the apply tick: the match stalls there
    while ((r = live.tryStep()) === 'stepped');
    expect(r).toBe('stalled');
    const stallTick = eng.tick;
    expect(stallTick).toBe(50);
    // "paused": no more steps happen; the reply arrives while paused
    for (const res of resolvers) res({ content: '{"commands":[]}', latencyMs: 10 });
    await new Promise((res) => setTimeout(res, 0));
    expect(eng.tick).toBe(stallTick);
    expect(rec.commands.some((c) => c.tick === stallTick && c.cmd.t === 'ai')).toBe(true);
  });

  it('exported records validate; replay reproduces human orders, fog and the final result exactly', async () => {
    // PvA with scripted "human" orders
    const cfg: MatchConfig = { ...testConfig({ seed: 'replay', timeLimitMin: 3 }), mode: 'pva', players: [{ kind: 'human', name: 'H' }, testConfig().players[1]] };
    const { record, live } = await runHeadless(cfg, {
      onTick: (m) => {
        const s = m.engine.state;
        if (s.tick % 97 === 0) {
          const vills = units(s, 0).filter((u) => u.type === 'Villager');
          const sc = units(s, 0).find((u) => u.type === 'Scout');
          if (sc) m.engine.issue(0, { t: 'move', units: [sc.id], x: (s.tick * 7) % s.map.size, y: (s.tick * 13) % s.map.size });
          if (vills.length && s.tick % 194 === 0) m.engine.issue(0, { t: 'explore', units: [vills[0].id] });
          const tc = buildings(s, 0).find((b) => b.type === 'TownCenter');
          if (tc) m.engine.issue(0, { t: 'train', building: tc.id, unit: 'Villager', count: 1 });
        }
      },
    });
    expect(record.status).toBe('completed');
    expect(record.commands.some((c) => c.source === 'human')).toBe(true);
    const exported = JSON.parse(JSON.stringify(exportRecord(record)));
    const v = validateRecord(exported);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    // replay matches the live run (including fog: explored arrays)
    const eng = new MatchEngine(exported, 'verify');
    while (!eng.finished) eng.stepOnce();
    expect(eng.mismatch).toBeNull();
    expect(eng.state.result).toEqual(record.result);
    expect(Array.from(eng.state.players[0].explored)).toEqual(Array.from(live.engine.state.players[0].explored));
    expect(Array.from(eng.state.derived.visible[1])).toEqual(Array.from(live.engine.state.derived.visible[1]));
  }, 60000);

  it('a running/paused match exports and validates too', async () => {
    const { record } = await runHeadless(testConfig({ seed: 'partial' }), { maxTicks: 1300 });
    expect(record.status).toBe('paused');
    const v = validateRecord(JSON.parse(JSON.stringify(exportRecord({ ...record, status: 'running' }))));
    expect(v.errors).toEqual([]);
  }, 60000);

  it('imports reject malformed or tampered files', async () => {
    const { record } = await runHeadless(testConfig({ seed: 'tamper' }), { maxTicks: 1300 });
    const good = JSON.parse(JSON.stringify(exportRecord(record)));
    expect(validateRecord(good).ok).toBe(true);
    const bad = (mut: (r: any) => void) => { const r = JSON.parse(JSON.stringify(good)); mut(r); return validateRecord(r); };
    expect(validateRecord('nope').ok).toBe(false);
    expect(validateRecord(null).ok).toBe(false);
    expect(bad((r) => { r.formatVersion = 2; }).ok).toBe(false);
    expect(bad((r) => { r.config.mapSize = 'Gigantic'; }).ok).toBe(false);
    expect(bad((r) => { r.config.players[0] = { kind: 'human', name: 'x' }; }).ok).toBe(false);
    expect(bad((r) => { r.commands[3].tick = -5; }).ok).toBe(false);
    expect(bad((r) => { r.commands.reverse(); }).ok).toBe(false);
    expect(bad((r) => { r.commands[2].cmd = { t: 'teleport' }; }).ok).toBe(false);
    expect(bad((r) => { r.checksums[0].hash = 'zzzzzzzz'; }).ok).toBe(false);
    expect(bad((r) => { r.extra = 1; }).ok).toBe(false);
    // structurally valid but the simulation diverges from the recorded checksums
    const div = bad((r) => { r.checksums[0].hash = r.checksums[0].hash === '00000000' ? '11111111' : '00000000'; });
    expect(div.ok).toBe(false);
    expect(div.errors.join()).toMatch(/checksum mismatch/);
    const div2 = bad((r) => { const c = r.commands.find((x: any) => x.cmd.t === 'ai' && x.cmd.cmds.length); c.cmd.cmds = []; });
    expect(div2.ok).toBe(false);
  }, 60000);

  it('parses model replies with fences and prose', () => {
    const d = parseDecision('Sure!\n```json\n{"thoughts":"x","plan":"p","commands":[{"type":"Gather","resource":"wood"},{"type":"bogus"}]}\n```');
    expect(d.commands).toHaveLength(1);
    expect(d.commands[0].type).toBe('gather');
    expect(() => parseDecision('no json here')).toThrow();
  });

  it('AI commands resolve through the same simulation commands as the human', () => {
    const s = createInitialState(testConfig({ seed: 'ai-apply' }));
    const p: PlayerId = 1;
    applyCommand(s, p, { t: 'ai', plan: 'test', cmds: [
      { type: 'gather', units: 'villagers', count: 3, resource: 'wood' },
      { type: 'build', building: 'House', at: [s.map.starts[p][0] + 5, s.map.starts[p][1] + 5], count: 1 },
      { type: 'train', unit: 'Villager', count: 2 },
      { type: 'explore', units: 'scouts' },
      { type: 'group', name: 'army', units: 'scouts' },
    ] });
    expect(s.players[p].feedback.every((f) => /ok/.test(f))).toBe(true);
    expect(buildings(s, p).some((b) => b.type === 'House')).toBe(true);
    expect(buildings(s, p).find((b) => b.type === 'TownCenter')!.queue.length).toBe(2);
    expect(units(s, p).filter((u) => u.order?.k === 'gather').length).toBe(3);
    expect(units(s, p).find((u) => u.type === 'Scout')!.order?.k).toBe('explore');
    expect(s.players[p].groups.army).toHaveLength(1);
    void getEnt;
  });
});
