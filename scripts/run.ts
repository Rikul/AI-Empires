import { runHeadless, testConfig } from '../src/shared/headless';
import { popUsed } from '../src/shared/sim';
import type { MapSize, Biome } from '../src/shared/rules';
const [size='Small', biome='TemperateGrasslands', seed='test', minutes='60'] = process.argv.slice(2);
const t0 = performance.now();
const errs = new Map<string, number>();
let last = performance.now();
const { record, live } = await runHeadless(testConfig({ mapSize: size as MapSize, biome: biome as Biome, seed, timeLimitMin: +minutes }), {
  onTick: (m) => {
    const s = m.engine.state;
    for (const p of s.players) for (const f of p.feedback) if (!/: ok$/.test(f)) errs.set(f.replace(/^#\d+ /, '').replace(/\d+/g, 'N'), (errs.get(f.replace(/^#\d+ /, '').replace(/\d+/g, 'N')) ?? 0) + 1);
    if (s.tick % 1200 === 0) {
      const now = performance.now();
      const line = [0, 1].map((p) => {
        const es = s.entities.filter((e) => e.owner === p && e.hp > 0);
        const v = es.filter((e) => e.kind === 'unit' && e.type === 'Villager').length;
        const mil = es.filter((e) => e.kind === 'unit' && e.type !== 'Villager').length;
        const b = es.filter((e) => e.kind === 'building').map((e) => (e as any).type[0] + (e as any).type[1]).join('');
        const r = s.players[p].res;
        const idle = es.filter((e) => e.kind === 'unit' && e.type === 'Villager' && !e.order).length;
        return `P${p}: pop ${popUsed(s, p as 0)} v${v}(idle ${idle}) m${mil} res ${Math.floor(r.food)}/${Math.floor(r.wood)}/${Math.floor(r.gold)}/${Math.floor(r.stone)} b[${b}]`;
      });
      console.log(`${(s.tick / 600).toFixed(0)}min ${((now - last) / 1200).toFixed(2)}ms/tick | ${line.join(' | ')}`);
      last = now;
    }
  },
});
console.log('result', record.result, 'ticks', record.currentTick, 'decisions', record.decisions.length, 'cmds', record.commands.length, `total ${((performance.now() - t0) / 1000).toFixed(1)}s`);
console.log([...errs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25));
const fb = live.engine.state.players.map((p) => p.feedback.slice(0, 12));
console.log('feedback', JSON.stringify(fb, null, 0).slice(0, 2500));
