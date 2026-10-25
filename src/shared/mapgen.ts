// Deterministic map generator. The map is point-symmetric around its center so both
// sides get exactly equivalent terrain and resources.
import { fbm, hash2, hashString, Rng, valueNoise } from './rng';
import { Biome, GENERATION_VERSION, MAP_SIZES, MapSize, Res, RES_AMOUNT, resBlocks, Terrain, terrainPassable } from './rules';
import type { MapData } from './types';

interface BiomeParams {
  base: Terrain;
  alt: Terrain;
  altThresh: number;
  hillAmp: number;
  waterThresh: number;
  forestThresh: number;
  treeDensity: number;
  rockThresh: number;
  goldPer100: number;
  stonePer100: number;
  berryPer100: number;
  deerPer100: number;
  oasis: boolean;
}

const PARAMS: Record<Biome, BiomeParams> = {
  TemperateGrasslands: {
    base: Terrain.Grass, alt: Terrain.Dirt, altThresh: 0.7, hillAmp: 1.4, waterThresh: 0.71, forestThresh: 0.63,
    treeDensity: 0.85, rockThresh: 9, goldPer100: 2.5, stonePer100: 2, berryPer100: 3, deerPer100: 5, oasis: false,
  },
  DesertOasis: {
    base: Terrain.Sand, alt: Terrain.Dirt, altThresh: 0.72, hillAmp: 1.8, waterThresh: 9, forestThresh: 0.78,
    treeDensity: 0.5, rockThresh: 0.8, goldPer100: 3.5, stonePer100: 2.5, berryPer100: 2, deerPer100: 4, oasis: true,
  },
  SnowyHighlands: {
    base: Terrain.Snow, alt: Terrain.Dirt, altThresh: 0.74, hillAmp: 4.0, waterThresh: 0.74, forestThresh: 0.6,
    treeDensity: 0.8, rockThresh: 0.76, goldPer100: 2.5, stonePer100: 3.5, berryPer100: 2, deerPer100: 4, oasis: false,
  },
  DenseWoodland: {
    base: Terrain.Grass, alt: Terrain.Dirt, altThresh: 0.75, hillAmp: 1.2, waterThresh: 0.77, forestThresh: 0.5,
    treeDensity: 0.9, rockThresh: 9, goldPer100: 2.5, stonePer100: 2, berryPer100: 3.5, deerPer100: 5, oasis: false,
  },
  RockySteppe: {
    base: Terrain.Dirt, alt: Terrain.Grass, altThresh: 0.62, hillAmp: 2.2, waterThresh: 0.8, forestThresh: 0.74,
    treeDensity: 0.6, rockThresh: 0.7, goldPer100: 3, stonePer100: 4, berryPer100: 2, deerPer100: 4, oasis: false,
  },
};

export interface GaiaSpawn { type: 'Deer'; x: number; y: number }

export interface GeneratedMap extends MapData {
  deer: GaiaSpawn[];
}

export function mapSeedNumber(seed: string, size: MapSize, biome: Biome, version = GENERATION_VERSION): number {
  return hashString(`${seed}|${size}|${biome}|v${version}`);
}

export function generateMap(seed: string, sizeName: MapSize, biome: Biome, version = GENERATION_VERSION): GeneratedMap {
  if (version !== GENERATION_VERSION) throw new Error(`Unsupported generation version ${version}`);
  const S = MAP_SIZES[sizeName];
  const P = PARAMS[biome];
  const seedNum = mapSeedNumber(seed, sizeName, biome, version);
  const rng = new Rng(seedNum);
  const N = S * S;
  const terrain = new Uint8Array(N);
  const resType = new Uint8Array(N);
  const resAmt = new Uint16Array(N);
  const height = new Float32Array((S + 1) * (S + 1));
  const idx = (x: number, y: number) => y * S + x;
  const mirror = (i: number) => N - 1 - i;
  const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < S && y < S;

  const sHeight = seedNum ^ 0x1234;
  const sWater = seedNum ^ 0x5678;
  const sForest = seedNum ^ 0x9abc;
  const sAlt = seedNum ^ 0xdef0;
  const sRock = seedNum ^ 0x2468;

  // --- starting positions (point symmetric) ---
  const layouts: [number, number][] = [[0.2, 0.2], [0.2, 0.5], [0.2, 0.8], [0.5, 0.2]];
  const lay = layouts[rng.int(layouts.length)];
  const jitter = () => rng.range(-0.04, 0.04);
  const sx = Math.floor(S * (lay[0] + jitter()));
  const sy = Math.floor(S * (lay[1] + jitter()));
  const starts: [number, number][] = [[sx, sy], [S - 1 - sx, S - 1 - sy]];
  const distToStart = (x: number, y: number) => {
    let best = 1e9;
    for (const [px, py] of starts) {
      const d = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
      if (d < best) best = d;
    }
    return best;
  };

  // --- heights (vertices), mirrored ---
  const VS = S + 1;
  for (let y = 0; y <= S; y++) {
    for (let x = 0; x <= S; x++) {
      const vi = y * VS + x;
      const mi = (S - y) * VS + (S - x);
      if (mi < vi) { height[vi] = height[mi]; continue; }
      const n = fbm(x / 22, y / 22, sHeight, 4);
      let h = (n - 0.45) * P.hillAmp * 2;
      // flatten around starting positions
      const d = distToStart(x, y);
      if (d < 12) h *= Math.max(0, (d - 6) / 6);
      height[vi] = h;
    }
  }

  // --- base terrain features, mirrored ---
  const oasisCenters: [number, number, number][] = [];
  if (P.oasis) {
    const count = Math.max(2, Math.round(S / 40));
    for (let i = 0; i < count * 6 && oasisCenters.length < count; i++) {
      const ox = rng.int(S), oy = rng.int(Math.floor(S / 2));
      const r = rng.range(3, 5.5);
      if (distToStart(ox, oy) < 20) continue;
      if (distToStart(S - 1 - ox, S - 1 - oy) < 20) continue;
      oasisCenters.push([ox, oy, r]);
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = idx(x, y);
      if (mirror(i) < i) continue;
      let t = P.base;
      const a = fbm(x / 12, y / 12, sAlt, 3);
      if (a > P.altThresh) t = P.alt;
      const d = distToStart(x, y);
      const w = fbm(x / 18, y / 18, sWater, 4);
      let isWater = d > 16 && w > P.waterThresh;
      if (P.oasis) {
        for (const [ox, oy, r] of oasisCenters) {
          const dd = Math.sqrt((x - ox) * (x - ox) + (y - oy) * (y - oy));
          const wobble = valueNoise(x / 3, y / 3, sWater) * 1.6;
          if (dd < r + wobble - 0.8) isWater = true;
        }
      }
      if (isWater) t = Terrain.Water;
      else if (d > 14 && P.rockThresh < 2) {
        const r = fbm(x / 9, y / 9, sRock, 3);
        const hv = height[y * VS + x];
        if (r > P.rockThresh || (biomeHasPeaks(biome) && hv > P.hillAmp * 0.62)) t = Terrain.Rock;
      }
      terrain[i] = t;
      // forests
      if (t !== Terrain.Water && t !== Terrain.Rock && d > 9) {
        let f = fbm(x / 10, y / 10, sForest, 4);
        if (P.oasis) {
          for (const [ox, oy, r] of oasisCenters) {
            const dd = Math.sqrt((x - ox) * (x - ox) + (y - oy) * (y - oy));
            if (dd < r + 3.5 && dd > r - 0.5) f = Math.max(f, 0.9);
          }
        }
        // clearings / trails keep dense forests navigable
        const trail = Math.abs(valueNoise(x / 14, y / 14, sForest ^ 0x77) - 0.5) < 0.05;
        if (f > P.forestThresh && !trail && hash2(x, y, sForest) < P.treeDensity) {
          resType[i] = Res.Tree;
          resAmt[i] = RES_AMOUNT[Res.Tree];
          terrain[i] = Terrain.Forest;
        }
      }
    }
  }
  copyMirror();

  // shallows on water edges
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = idx(x, y);
      if (terrain[i] === Terrain.Water) continue;
      if (terrain[i] === Terrain.Rock || resType[i]) continue;
      let nearWater = false;
      for (let dy = -1; dy <= 1 && !nearWater; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inMap(nx, ny) && terrain[idx(nx, ny)] === Terrain.Water) { nearWater = true; break; }
        }
      }
      if (nearWater) terrain[i] = Terrain.Shallow;
    }
  }

  // lower water vertices
  for (let y = 0; y <= S; y++) {
    for (let x = 0; x <= S; x++) {
      let water = 0, cnt = 0;
      for (const [dx, dy] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
        const tx = x + dx, ty = y + dy;
        if (!inMap(tx, ty)) continue;
        cnt++;
        if (terrain[idx(tx, ty)] === Terrain.Water) water++;
      }
      const vi = y * VS + x;
      if (water === cnt && cnt > 0) height[vi] = Math.min(height[vi], 0) - 0.7;
      else if (water > 0) height[vi] = Math.min(height[vi], 0) - 0.25;
    }
  }

  // --- place resources: start areas use identical (negated) offsets for fairness ---
  const deer: GaiaSpawn[] = [];
  const clearTile = (x: number, y: number) => {
    if (!inMap(x, y)) return;
    const i = idx(x, y);
    if (terrain[i] === Terrain.Water || terrain[i] === Terrain.Rock || terrain[i] === Terrain.Shallow || terrain[i] === Terrain.Forest) terrain[i] = P.base;
    resType[i] = Res.None;
    resAmt[i] = 0;
  };
  // clear base area
  for (const [px, py] of starts) {
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        if (dx * dx + dy * dy <= 100) clearTile(px + dx, py + dy);
      }
    }
  }
  const placeRes = (x: number, y: number, r: Res, amount = RES_AMOUNT[r]) => {
    if (!inMap(x, y)) return false;
    const i = idx(x, y);
    if (terrain[i] === Terrain.Water || terrain[i] === Terrain.Rock) terrain[i] = P.base;
    if (terrain[i] === Terrain.Shallow) terrain[i] = P.base;
    resType[i] = r;
    resAmt[i] = amount;
    if (r === Res.Tree) terrain[i] = Terrain.Forest;
    else {
      // keep the surroundings of mines and bushes open
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!inMap(nx, ny)) continue;
        const j = idx(nx, ny);
        if (resType[j] === Res.Tree) { resType[j] = Res.None; resAmt[j] = 0; terrain[j] = P.base; }
        if (terrain[j] === Terrain.Rock) terrain[j] = P.base;
      }
    }
    return true;
  };
  const placeBoth = (dx: number, dy: number, r: Res) => {
    placeRes(starts[0][0] + dx, starts[0][1] + dy, r);
    placeRes(starts[1][0] - dx, starts[1][1] - dy, r);
  };
  const dirTo = (ang: number, dist: number): [number, number] => {
    // integer direction from a small table to avoid trig
    const dirs: [number, number][] = [[1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7]];
    const d = dirs[((ang % 8) + 8) % 8];
    return [Math.round(d[0] * dist), Math.round(d[1] * dist)];
  };
  // direction from start 0 to map center: put berries/gold/stone on varied sides
  const baseAng = rng.int(8);
  // berries: cluster of 6
  {
    const [cx, cy] = dirTo(baseAng, 7);
    const offs = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [2, 1]];
    for (const [ox, oy] of offs) placeBoth(cx + ox, cy + oy, Res.Berry);
  }
  // gold: 5 tiles
  {
    const [cx, cy] = dirTo(baseAng + 3, 9);
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1], [2, 1]]) placeBoth(cx + ox, cy + oy, Res.Gold);
  }
  // stone: 4 tiles
  {
    const [cx, cy] = dirTo(baseAng + 5, 9);
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) placeBoth(cx + ox, cy + oy, Res.Stone);
  }
  // woodline: dense clump
  {
    const [cx, cy] = dirTo(baseAng + 6 + rng.int(2), 11);
    for (let oy = -3; oy <= 3; oy++) {
      for (let ox = -3; ox <= 3; ox++) {
        if (ox * ox + oy * oy > 11) continue;
        if (hash2(ox + 50, oy + 50, seedNum) < 0.15) continue;
        placeBoth(cx + ox, cy + oy, Res.Tree);
      }
    }
  }
  // starting deer
  for (let k = 0; k < 3; k++) {
    const [cx, cy] = dirTo(baseAng + 1 + k, 12 + k);
    for (const [px, py, sgn] of [[starts[0][0], starts[0][1], 1], [starts[1][0], starts[1][1], -1]] as const) {
      const x = px + sgn * cx, y = py + sgn * cy;
      if (inMap(x, y)) {
        clearTile(x, y);
        deer.push({ type: 'Deer', x: x + 0.5, y: y + 0.5 });
      }
    }
  }

  if (!connected(S, terrain, resType, starts[0], starts[1])) carveLine(starts[0], starts[1]);
  const reach0 = reachable(S, terrain, resType, starts[0]);
  const nearReach = (x: number, y: number) => {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = x + dx, ny = y + dy;
      if (inMap(nx, ny) && reach0[idx(nx, ny)]) return true;
    }
    return false;
  };
  // extra map resources (pairs mirrored)
  const area100 = (S * S) / 10000;
  const extraClusters: [Res, number, number][] = [
    [Res.Gold, Math.round(P.goldPer100 * area100), 5],
    [Res.Stone, Math.round(P.stonePer100 * area100), 4],
    [Res.Berry, Math.round(P.berryPer100 * area100), 5],
  ];
  const freeForCluster = (x: number, y: number, rad: number) => {
    for (let dy = -rad; dy <= rad; dy++) {
      for (let dx = -rad; dx <= rad; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!inMap(nx, ny)) return false;
        const t = terrain[idx(nx, ny)];
        if (t === Terrain.Water || t === Terrain.Rock) return false;
        if (resType[idx(nx, ny)] && resType[idx(nx, ny)] !== Res.Tree) return false;
      }
    }
    return true;
  };
  for (const [r, count, tiles] of extraClusters) {
    let placed = 0;
    for (let attempt = 0; attempt < count * 30 && placed < Math.ceil(count / 2); attempt++) {
      const x = 3 + rng.int(S - 6), y = 3 + rng.int(S - 6);
      if (distToStart(x, y) < 18) continue;
      const mx = S - 1 - x, my = S - 1 - y;
      if (Math.abs(mx - x) < 4 && Math.abs(my - y) < 4) continue;
      if (!freeForCluster(x, y, 2) || !freeForCluster(mx, my, 2) || !nearReach(x, y)) continue;
      const offs = [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 0], [0, -1]].slice(0, tiles);
      for (const [ox, oy] of offs) {
        placeRes(x + ox, y + oy, r);
        placeRes(mx - ox, my - oy, r);
      }
      placed++;
    }
  }
  // deer herds
  {
    const herds = Math.max(1, Math.round((P.deerPer100 * area100) / 4));
    let placed = 0;
    for (let attempt = 0; attempt < herds * 40 && placed < herds; attempt++) {
      const x = 3 + rng.int(S - 6), y = 3 + rng.int(S - 6);
      if (distToStart(x, y) < 18) continue;
      if (!freeForCluster(x, y, 1) || !freeForCluster(S - 1 - x, S - 1 - y, 1) || !reach0[idx(x, y)]) continue;
      for (let k = 0; k < 3; k++) {
        const ox = k - 1, oy = (k % 2);
        for (const [hx, hy] of [[x + ox, y + oy], [S - 1 - x - ox, S - 1 - y - oy]]) {
          const i = idx(hx, hy);
          if (resType[i] || !terrainPassable(terrain[i])) continue;
          deer.push({ type: 'Deer', x: hx + 0.5, y: hy + 0.5 });
        }
      }
      placed++;
    }
  }

  // --- connectivity: carve a symmetric corridor if bases are not connected ---
  if (!connected(S, terrain, resType, starts[0], starts[1])) {
    carveLine(starts[0], starts[1]);
  }
  // make sure every non-tree resource tile touches a reachable tile
  const reach = reachable(S, terrain, resType, starts[0]);
  for (let i = 0; i < N; i++) {
    const r = resType[i];
    if (!r || r === Res.Tree) continue;
    const x = i % S, y = (i / S) | 0;
    let ok = false;
    for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (inMap(nx, ny) && reach[idx(nx, ny)]) { ok = true; break; }
    }
    if (!ok) {
      // remove unreachable resource on both sides
      resType[i] = 0; resAmt[i] = 0;
      resType[mirror(i)] = 0; resAmt[mirror(i)] = 0;
    }
  }
  // deer must stand on reachable tiles
  const deerOk = deer.filter((d) => reach[idx(Math.floor(d.x), Math.floor(d.y))]);

  return { size: S, terrain, height, resType, resAmt, starts, deer: deerOk };

  function copyMirror() {
    for (let i = 0; i < N; i++) {
      const m = mirror(i);
      if (m < i) {
        terrain[i] = terrain[m];
        resType[i] = resType[m];
        resAmt[i] = resAmt[m];
      }
    }
  }

  function carveLine(a: [number, number], b: [number, number]) {
    const steps = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(a[0] + ((b[0] - a[0]) * s) / steps);
      const y = Math.round(a[1] + ((b[1] - a[1]) * s) / steps);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!inMap(nx, ny)) continue;
        const i = idx(nx, ny);
        if (!terrainPassable(terrain[i]) || resBlocks(resType[i])) {
          terrain[i] = terrain[i] === Terrain.Water ? Terrain.Shallow : P.base;
          resType[i] = 0; resAmt[i] = 0;
          const m = mirror(i);
          terrain[m] = terrain[i]; resType[m] = 0; resAmt[m] = 0;
        }
      }
    }
  }
}

function biomeHasPeaks(b: Biome) { return b === 'SnowyHighlands'; }

function reachable(S: number, terrain: Uint8Array, resType: Uint8Array, from: [number, number]): Uint8Array {
  const seen = new Uint8Array(S * S);
  const q = new Int32Array(S * S);
  let h = 0, t = 0;
  const s = from[1] * S + from[0];
  seen[s] = 1; q[t++] = s;
  while (h < t) {
    const i = q[h++];
    const x = i % S, y = (i / S) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= S || ny >= S) continue;
      const j = ny * S + nx;
      if (seen[j] || !terrainPassable(terrain[j]) || resBlocks(resType[j])) continue;
      seen[j] = 1; q[t++] = j;
    }
  }
  return seen;
}

function connected(S: number, terrain: Uint8Array, resType: Uint8Array, a: [number, number], b: [number, number]) {
  return reachable(S, terrain, resType, a)[b[1] * S + b[0]] === 1;
}

/** Fraction of tiles reachable from start 0 (used by tests/preview stats). */
export function mapStats(m: MapData) {
  const reach = reachable(m.size, m.terrain, m.resType, m.starts[0]);
  let reachCount = 0;
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < reach.length; i++) {
    if (reach[i]) reachCount++;
    counts[m.resType[i]]++;
  }
  return {
    reachableFraction: reachCount / reach.length,
    basesConnected: reach[m.starts[1][1] * m.size + m.starts[1][0]] === 1,
    trees: counts[Res.Tree], gold: counts[Res.Gold], stone: counts[Res.Stone], berries: counts[Res.Berry],
  };
}
