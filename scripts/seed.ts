// Seed the server with a headless match advanced to a given minute (for visual testing).
// usage: tsx scripts/seed.ts <minutes> [size] [biome] [seed] [base] [pva]
import { runHeadless, testConfig } from '../src/shared/headless';
import { serializeState } from '../src/shared/serialize';
import type { MapSize, Biome } from '../src/shared/rules';
import type { MatchConfig, UnitEnt } from '../src/shared/types';
const [minutes = '10', size = 'Small', biome = 'TemperateGrasslands', seed = 'seed-demo', base = 'http://localhost:8091', mode = 'ava'] = process.argv.slice(2);
let cfg: MatchConfig = testConfig({ mapSize: size as MapSize, biome: biome as Biome, seed });
cfg.players = cfg.players.map((p) => (p.kind === 'ai' ? { kind: 'ai', ai: { ...p.ai, baseUrl: `${base}/mock/v1`, model: 'scripted-mock' } } : p)) as typeof cfg.players;
if (mode === 'pva') cfg = { ...cfg, mode: 'pva', players: [{ kind: 'human', name: 'Scripted human' }, cfg.players[1]] };
const created = await (await fetch(`${base}/api/matches`, { method: 'POST', body: JSON.stringify({ config: cfg, name: `Seeded ${mode} ${minutes}min ${size} ${biome}` }) })).json();
const { record, live } = await runHeadless(cfg, {
  maxTicks: Math.round(+minutes * 600),
  onTick: mode === 'pva' ? (m) => {
    // a simple scripted "human": keeps training villagers, gathers, scouts
    const s = m.engine.state;
    if (s.tick % 150 !== 7) return;
    const own = s.entities.filter((e) => e.owner === 0 && e.hp > 0);
    const tc = own.find((e) => e.kind === 'building' && e.type === 'TownCenter');
    if (tc) m.engine.issue(0, { t: 'train', building: tc.id, unit: 'Villager', count: 1 });
    const idle = own.filter((e): e is UnitEnt => e.kind === 'unit' && e.type === 'Villager' && !e.order);
    const S = s.map.size;
    for (const v of idle.slice(0, 3)) {
      // nearest tree
      let best = -1, bd = 1e9;
      for (let i = 0; i < S * S; i++) if (s.map.resType[i] === 1 && s.players[0].explored[i]) { const d = ((i % S) - v.x) ** 2 + (Math.floor(i / S) - v.y) ** 2; if (d < bd) { bd = d; best = i; } }
      if (best >= 0) m.engine.issue(0, { t: 'gather', units: [v.id], x: best % S, y: Math.floor(best / S) });
    }
    const sc = own.find((e): e is UnitEnt => e.kind === 'unit' && e.type === 'Scout');
    if (sc && !sc.order) m.engine.issue(0, { t: 'explore', units: [sc.id] });
  } : undefined,
});
const r = await fetch(`${base}/api/matches/${created.id}`, { method: 'PUT', body: JSON.stringify({ status: record.status, currentTick: record.currentTick, result: record.result, commands: record.commands, decisions: record.decisions, checksums: record.checksums, snapshot: serializeState(live.engine.state) }) });
console.log(created.id, r.status, record.status, record.currentTick, JSON.stringify(record.result));
