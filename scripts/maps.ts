import { generateMap, mapStats } from '../src/shared/mapgen';
import { BIOMES, MAP_SIZES, MapSize } from '../src/shared/rules';
for (const size of Object.keys(MAP_SIZES) as MapSize[]) for (const b of BIOMES) {
  const t0 = performance.now();
  const m = generateMap('seed1', size, b);
  const st = mapStats(m);
  console.log(size.padEnd(7), b.padEnd(20), `${(performance.now()-t0).toFixed(0)}ms`, JSON.stringify({ ...st, reachableFraction: +st.reachableFraction.toFixed(2), deer: m.deer.length, starts: m.starts }));
}
