// A scripted stand-in for an LLM, served by the app's built-in OpenAI-compatible test
// endpoint (/mock/v1). It reads only the observation JSON from the prompt — exactly what a
// real model receives — and answers in the same JSON response format.
import { hashString } from '../rng';
import type { AiCommand } from '../types';
import type { Observation } from './observation';
import { OBS_BEGIN, OBS_END } from './prompt';

interface V { id: number; at: [number, number]; task: string }
interface M { id: number; type: string; at: [number, number]; hp: string; task: string }
interface B { id: number; type: string; at: [number, number]; status?: string; queue?: string[]; food?: number }

export function extractObservation(prompt: string): Observation | null {
  const a = prompt.indexOf(OBS_BEGIN), b = prompt.indexOf(OBS_END);
  if (a < 0 || b < 0) return null;
  try { return JSON.parse(prompt.slice(a + OBS_BEGIN.length, b)); } catch { return null; }
}

function parseTime(t: string): number { const [m, s] = t.split(':').map(Number); return m * 60 + s; }

export function mockDecide(obs: Observation, persona: string): { thoughts: string; plan: string; commands: AiCommand[] } {
  const h = hashString(persona);
  const style = ['rush', 'balanced', 'boom'][h % 3];
  const attackSize = style === 'rush' ? 7 : style === 'balanced' ? 11 : 16;
  const cmds: AiCommand[] = [];
  const notes: string[] = [];
  const t = parseTime(obs.time);
  const res = obs.resources;
  const pop = obs.population;
  const home = obs.map.yourBase as [number, number];
  const enemyGuess: [number, number] = Array.isArray(obs.map.enemyBase)
    ? (obs.map.enemyBase as [number, number])
    : (() => { const m = String(obs.map.enemyBase).match(/\((\d+),(\d+)\)/); return m ? [+m[1], +m[2]] as [number, number] : [home[0], home[1]] as [number, number]; })();
  let dx = enemyGuess[0] - home[0], dy = enemyGuess[1] - home[1];
  const dl = Math.sqrt(dx * dx + dy * dy) || 1;
  dx /= dl; dy /= dl;
  const off = (fwd: number, side: number): [number, number] => [Math.round(home[0] + dx * fwd - dy * side), Math.round(home[1] + dy * fwd + dx * side)];

  const buildings = obs.buildings as B[];
  const villagers = obs.villagers as V[];
  const military = obs.military as M[];
  const count = (type: string, builtOnly = false) => buildings.filter((b) => b.type === type && (!builtOnly || !b.status)).length;
  const underConstruction = (type: string) => buildings.some((b) => b.type === type && b.status);
  const spend = { ...res };
  const canPay = (c: Partial<Record<string, number>>) => Object.entries(c).every(([k, v]) => spend[k] >= (v ?? 0));
  const pay = (c: Partial<Record<string, number>>) => { for (const [k, v] of Object.entries(c)) spend[k] -= v ?? 0; };
  const nVill = villagers.length;
  const targetVill = style === 'boom' ? 34 : style === 'balanced' ? 28 : 22;
  const tcs = buildings.filter((b) => b.type === 'TownCenter' && !b.status);

  // --- exploration ---
  const scouts = military.filter((m) => m.type === 'Scout');
  if (scouts.length && scouts.some((s) => s.task === 'idle') && (obs.map.exploredPercent as number) < 60) {
    cmds.push({ type: 'explore', units: scouts.filter((s) => s.task === 'idle').map((s) => s.id) });
    notes.push('scouting');
  }

  // --- houses ---
  const room = pop.capacity - pop.used;
  const queuedPop = buildings.reduce((n, b) => n + (b.queue?.filter((q) => !/Toolworking|Fletching|ScaleArmor/.test(q)).length ?? 0), 0);
  if (pop.capacity < pop.max && room - Math.min(queuedPop, 3) <= 3 && !underConstruction('House') && canPay({ wood: 30 })) {
    const n = count('House');
    const ang = (n * 2.4) % 6.28;
    const side = Math.round(Math.sin(ang) * 7), back = Math.round(-4 - Math.cos(ang) * 3);
    cmds.push({ type: 'build', building: 'House', at: off(back, side), count: 1 });
    pay({ wood: 30 });
    if (pop.used > 25 && canPay({ wood: 30 })) { cmds.push({ type: 'build', building: 'House', at: off(back - 3, -side), count: 1 }); pay({ wood: 30 }); }
  }

  // --- villagers ---
  for (const tc of tcs) {
    if (nVill < targetVill && (tc.queue?.length ?? 0) < 2 && canPay({ food: 50 })) {
      const n = Math.min(2, Math.floor(spend.food / 50));
      cmds.push({ type: 'train', unit: 'Villager', count: n, building: tc.id });
      pay({ food: 50 * n });
    }
  }

  // --- drop-offs near resources ---
  const kr = obs.knownResources as Record<string, { at: [number, number]; amount: number; distFromBase: number }[]>;
  const nearestRes = (k: string) => (kr[k] ?? [])[0];
  const pits = count('StoragePit');
  const wood = nearestRes('wood');
  if (pits === 0 && wood && wood.distFromBase > 6 && canPay({ wood: 100 }) && nVill >= 7) {
    cmds.push({ type: 'build', building: 'StoragePit', at: towards(wood.at, home, 2), count: 2 });
    pay({ wood: 100 });
  } else if (pits === 1 && t > 360 && canPay({ wood: 100 })) {
    const g = nearestRes('gold');
    if (g && g.distFromBase > 6) { cmds.push({ type: 'build', building: 'StoragePit', at: towards(g.at, home, 2), count: 1 }); pay({ wood: 100 }); }
  }
  const berries = nearestRes('berries');
  if (count('Granary') === 0 && canPay({ wood: 100 }) && nVill >= 9) {
    const at: [number, number] = berries && berries.distFromBase < 14 ? towards(berries.at, home, 2) : off(-5, 4);
    cmds.push({ type: 'build', building: 'Granary', at, count: 1 });
    pay({ wood: 100 });
  }

  // --- farms when natural food runs low ---
  const naturalFood = (kr.berries ?? []).filter((b) => b.distFromBase < 18).reduce((n, b) => n + b.amount, 0);
  const farms = buildings.filter((b) => b.type === 'Farm');
  const farmTarget = naturalFood < 300 ? Math.min(12, Math.floor(nVill * 0.4)) : t > 600 ? 3 : 0;
  if (count('Granary', true) > 0 && farms.length < farmTarget && canPay({ wood: 60 })) {
    const gran = buildings.find((b) => b.type === 'Granary' && !b.status) ?? tcs[0];
    const ring: [number, number][] = [[4, 0], [-4, 0], [0, 4], [0, -4], [4, 4], [-4, -4], [4, -4], [-4, 4], [7, 0], [-7, 0], [0, 7], [0, -7]];
    const [ox, oy] = ring[farms.length % ring.length];
    cmds.push({ type: 'build', building: 'Farm', at: [gran.at[0] + ox, gran.at[1] + oy], count: 1 });
    pay({ wood: 60 });
  }

  // --- gathering assignments ---
  const sum = obs.villagerSummary;
  const idle = villagers.filter((v) => v.task === 'idle').length;
  if (idle > 0) {
    const want = t < 300 ? { food: 0.5, wood: 0.4, gold: 0.1, stone: 0 } : t < 900 ? { food: 0.4, wood: 0.32, gold: 0.18, stone: 0.1 } : { food: 0.38, wood: 0.27, gold: 0.25, stone: 0.1 };
    const cur: Record<string, number> = { food: sum.food, wood: sum.wood, gold: sum.gold, stone: sum.stone };
    const total = nVill;
    for (let i = 0; i < idle; i++) {
      let best = 'wood', deficit = -1e9;
      for (const r of ['food', 'wood', 'gold', 'stone'] as const) {
        if (!(kr[r === 'food' ? 'berries' : r]?.length) && r !== 'food') continue;
        const d = want[r] * total - cur[r];
        if (d > deficit) { deficit = d; best = r; }
      }
      cur[best]++;
      const near = best === 'food' ? (berries && berries.distFromBase < 20 ? berries.at : home) : nearestRes(best)?.at ?? home;
      const resource = best === 'food' && farms.some((f) => !f.status) ? 'food' : best === 'food' ? (berries ? 'berries' : 'hunt') : best;
      cmds.push({ type: 'gather', units: 'idle_villagers', count: 1, resource, near });
    }
    notes.push(`assigned ${idle} idle villagers`);
  }
  // rebalance: pull a wood gatherer to gold/stone mid-game if none
  if (t > 600 && sum.gold < 3 && sum.wood > 6 && kr.gold?.length) cmds.push({ type: 'gather', units: 'gatherers:wood', count: 2, resource: 'gold', near: kr.gold[0].at });
  if (t > 700 && sum.stone < 2 && sum.wood > 6 && kr.stone?.length) cmds.push({ type: 'gather', units: 'gatherers:wood', count: 1, resource: 'stone', near: kr.stone[0].at });

  // --- military infrastructure ---
  const milStart = style === 'rush' ? 9 : style === 'balanced' ? 13 : 17;
  if (nVill >= milStart && count('Barracks') === 0 && canPay({ wood: 125 })) {
    cmds.push({ type: 'build', building: 'Barracks', at: off(7, -3), count: 2 }); pay({ wood: 125 });
  }
  if (count('Barracks', true) && nVill >= milStart + 4 && count('ArcheryRange') === 0 && canPay({ wood: 150 })) {
    cmds.push({ type: 'build', building: 'ArcheryRange', at: off(7, 4), count: 2 }); pay({ wood: 150 });
  }
  if (count('Barracks', true) && nVill >= milStart + 6 && count('Blacksmith') === 0 && canPay({ wood: 150 })) {
    cmds.push({ type: 'build', building: 'Blacksmith', at: off(2, -7), count: 1 }); pay({ wood: 150 });
  }
  if (count('Barracks', true) && nVill >= milStart + 8 && count('Stable') === 0 && canPay({ wood: 150 })) {
    cmds.push({ type: 'build', building: 'Stable', at: off(2, 8), count: 2 }); pay({ wood: 150 });
  }
  if (t > 480 && count('WatchTower') < (style === 'boom' ? 2 : 1) && canPay({ wood: 25, stone: 75 })) {
    cmds.push({ type: 'build', building: 'WatchTower', at: off(10, count('WatchTower') ? 5 : -5), count: 1 }); pay({ wood: 25, stone: 75 });
  }
  if (t > 540 && count('Wall') === 0 && style !== 'rush' && canPay({ stone: 28 })) {
    const a = off(12, -6), b = off(12, -2);
    cmds.push({ type: 'build', building: 'Wall', at: a, to: b, count: 1 }); pay({ stone: 20 });
  }
  if (t > 1200 && count('TownCenter') < 2 && style === 'boom' && canPay({ wood: 275, stone: 100 }) && nVill > 25) {
    const g = (kr.gold ?? []).find((x) => x.distFromBase > 15 && x.distFromBase < 35);
    if (g) { cmds.push({ type: 'build', building: 'TownCenter', at: towards(g.at, home, 4), count: 4 }); pay({ wood: 275, stone: 100 }); }
  }

  // --- research ---
  for (const tech of obs.canResearch) {
    const c = tech === 'Toolworking' ? { food: 100, gold: 40 } : tech === 'Fletching' ? { food: 100, wood: 50 } : { food: 100, gold: 50 };
    if (canPay({ food: c.food + 150, gold: (c.gold ?? 0), wood: (c.wood ?? 0) })) { cmds.push({ type: 'research', tech }); pay(c); break; }
  }

  // --- unit production ---
  const enemyTypes = (obs.enemy.visibleUnits as { type: string }[]).map((u) => u.type);
  const enemyCav = enemyTypes.filter((x) => x === 'Cavalry' || x === 'Scout' || x === 'HorseArcher').length;
  const enemyArch = enemyTypes.filter((x) => x === 'Bowman' || x === 'HorseArcher').length;
  const costs: Record<string, Record<string, number>> = {
    Clubman: { food: 50 }, Spearman: { food: 35, wood: 25 }, Swordsman: { food: 35, gold: 15 }, Centurion: { food: 70, wood: 20, gold: 60 },
    Bowman: { food: 40, wood: 20 }, Skirmisher: { food: 25, wood: 35 }, HorseArcher: { food: 40, gold: 70 }, Cavalry: { food: 70, gold: 75 },
  };
  const reserve = nVill < targetVill ? 50 : 0;
  const prodBuildings = buildings.filter((b) => ['Barracks', 'ArcheryRange', 'Stable'].includes(b.type) && !b.status && (b.queue?.length ?? 0) < 2);
  for (const b of prodBuildings) {
    let pick: string[];
    if (b.type === 'Barracks') pick = enemyCav > 2 ? ['Spearman'] : obs.canTrain.includes('Centurion') && t > 1100 ? ['Centurion', 'Swordsman'] : obs.canTrain.includes('Swordsman') ? ['Swordsman', 'Spearman'] : ['Clubman', 'Spearman'];
    else if (b.type === 'ArcheryRange') pick = enemyArch > 2 ? ['Skirmisher'] : obs.canTrain.includes('HorseArcher') && t > 1000 ? ['HorseArcher', 'Bowman'] : ['Bowman', 'Skirmisher'];
    else pick = ['Cavalry'];
    const u = pick.find((x) => canPay({ ...costs[x], food: (costs[x].food ?? 0) + reserve }));
    if (u && pop.used + 1 < pop.capacity) {
      cmds.push({ type: 'train', unit: u, count: 1, building: b.id });
      pay(costs[u]);
    }
  }

  // --- army coordination, defense and attacks ---
  const army = military.filter((m) => m.type !== 'Scout');
  const armyIds = army.map((m) => m.id);
  if (armyIds.length) cmds.push({ type: 'group', name: 'army', units: armyIds });
  const threats = (obs.enemy.visibleUnits as { id: number; at: [number, number]; type: string }[]).filter((u) => Math.hypot(u.at[0] - home[0], u.at[1] - home[1]) < 22);
  const attacking = army.some((m) => m.task.startsWith('attack'));
  const wave = Number((obs.yourPreviousPlan.match(/wave=(\d+)/) ?? [])[1] ?? 0);
  let nextWave = wave;
  if (threats.length >= 1 && armyIds.length) {
    const tgt = threats[0];
    cmds.push({ type: 'defend', units: 'group:army', at: tgt.at, radius: 10 });
    notes.push(`defending against ${threats.length} enemies near base`);
    if (threats.length > armyIds.length + 3 && nVill > 0) {
      // villagers fight back when overwhelmed
      cmds.push({ type: 'attack', units: 'villagers', count: Math.min(nVill, threats.length), target: tgt.id });
    }
  } else if (armyIds.length >= attackSize + wave * 2 && !attacking) {
    const known = (obs.enemy.knownBuildings as { id: number; type: string; at: [number, number] }[]);
    const tc = known.find((b) => b.type === 'TownCenter');
    if (tc) cmds.push({ type: 'attack', units: 'group:army', target: tc.id });
    else cmds.push({ type: 'attack', units: 'group:army', to: enemyGuess });
    nextWave = wave + 1;
    notes.push(`attack wave ${nextWave} with ${armyIds.length} units`);
  } else if (!attacking && armyIds.length) {
    const idleArmy = army.filter((m) => m.task === 'idle');
    if (idleArmy.length) cmds.push({ type: 'move', units: idleArmy.map((m) => m.id), to: off(6, 0) });
  } else if (attacking) {
    // focus visible enemy units near the army
    const known = (obs.enemy.knownBuildings as { id: number; type: string; at: [number, number] }[]);
    const tc = known.find((b) => b.type === 'TownCenter');
    if (tc && army.filter((m) => m.task.startsWith('attack-moving')).length > 3) cmds.push({ type: 'attack', units: 'group:army', target: tc.id });
  }
  // enemy Town Center gone: sweep remaining enemy buildings and units (conquest needs every unit)
  const knownB = obs.enemy.knownBuildings as { id: number; type: string; at: [number, number] }[];
  const visibleEnemies = obs.enemy.visibleUnits as { id: number; at: [number, number] }[];
  if (!Array.isArray(obs.map.enemyBase) && wave > 0 && armyIds.length >= 4 && !threats.length) {
    if (visibleEnemies.length) cmds.push({ type: 'attack', units: 'group:army', target: visibleEnemies[0].id });
    else if (knownB.length) cmds.push({ type: 'attack', units: 'group:army', to: knownB[(t / 15 | 0) % knownB.length].at });
    else {
      const sweep: [number, number][] = [enemyGuess, [enemyGuess[0], home[1]], [home[0], enemyGuess[1]], [(home[0] + enemyGuess[0]) / 2, (home[1] + enemyGuess[1]) / 2]];
      cmds.push({ type: 'attack', units: 'group:army', to: sweep[(t / 60 | 0) % sweep.length] });
    }
    if (scouts.length) cmds.push({ type: 'explore', units: 'scouts' });
    notes.push('hunting down remaining enemy units');
  }
  // spend floating resources on more production
  const milB = buildings.filter((b) => ['Barracks', 'ArcheryRange', 'Stable'].includes(b.type)).length;
  if (milB >= 2 && milB < 6 && spend.wood > 450 && t > 600) {
    const type = ['Barracks', 'ArcheryRange', 'Stable'][milB % 3];
    cmds.push({ type: 'build', building: type, at: off(9, (milB % 2 ? 1 : -1) * (4 + milB)), count: 2 }); pay({ wood: 150 });
  }
  if (spend.wood > 500 && spend.food < 150 && sum.wood > 5) cmds.push({ type: 'gather', units: 'gatherers:wood', count: 3, resource: 'food', near: home });
  if (scouts.length && wave === 0 && (obs.map.exploredPercent as number) >= 60 && scouts.some((s) => s.task === 'idle')) {
    cmds.push({ type: 'defend', units: 'scouts', at: off(5, 0), radius: 12 });
  }

  return {
    thoughts: `${style} strategy. ${notes.join('; ') || 'economy running'}. Villagers ${nVill}, army ${armyIds.length}, pop ${pop.used}/${pop.capacity}.`,
    plan: `style=${style}; wave=${nextWave}`,
    commands: cmds,
  };
}

function towards(from: [number, number], to: [number, number], dist: number): [number, number] {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  const l = Math.sqrt(dx * dx + dy * dy) || 1;
  return [Math.round(from[0] + (dx / l) * dist), Math.round(from[1] + (dy / l) * dist)];
}
