import * as THREE from 'three';
import { Biome, Terrain } from '../../shared/rules';

type Pal = Record<Terrain, number>;

const PALETTES: Record<Biome, Pal> = {
  TemperateGrasslands: {
    [Terrain.Grass]: 0x6f9e3e, [Terrain.Sand]: 0xd2c08a, [Terrain.Snow]: 0xe8eef2, [Terrain.Dirt]: 0x8d7a4c,
    [Terrain.Rock]: 0x7c7770, [Terrain.Water]: 0x3c5a5a, [Terrain.Shallow]: 0xb9b07a, [Terrain.Forest]: 0x4a7a2e,
  },
  DesertOasis: {
    [Terrain.Grass]: 0x8fa04a, [Terrain.Sand]: 0xdcc58c, [Terrain.Snow]: 0xe8eef2, [Terrain.Dirt]: 0xc29a5f,
    [Terrain.Rock]: 0x9a7e62, [Terrain.Water]: 0x2f6e72, [Terrain.Shallow]: 0xc8b47a, [Terrain.Forest]: 0x9aa357,
  },
  SnowyHighlands: {
    [Terrain.Grass]: 0x7e9a6a, [Terrain.Sand]: 0xcfc6b0, [Terrain.Snow]: 0xe6edf2, [Terrain.Dirt]: 0x8e8270,
    [Terrain.Rock]: 0x6b6966, [Terrain.Water]: 0x4f7182, [Terrain.Shallow]: 0xb8c4cc, [Terrain.Forest]: 0xc9d4d8,
  },
  DenseWoodland: {
    [Terrain.Grass]: 0x557f33, [Terrain.Sand]: 0xc4b27e, [Terrain.Snow]: 0xe8eef2, [Terrain.Dirt]: 0x6f5e3a,
    [Terrain.Rock]: 0x6e6b63, [Terrain.Water]: 0x2f4f4a, [Terrain.Shallow]: 0x7f8a52, [Terrain.Forest]: 0x3b5f25,
  },
  RockySteppe: {
    [Terrain.Grass]: 0x8f9a55, [Terrain.Sand]: 0xc9b483, [Terrain.Snow]: 0xe8eef2, [Terrain.Dirt]: 0xa08a5c,
    [Terrain.Rock]: 0x77706a, [Terrain.Water]: 0x3c5c66, [Terrain.Shallow]: 0xb5a678, [Terrain.Forest]: 0x7d8448,
  },
};

const cache = new Map<string, THREE.Color>();
export function terrainColor(b: Biome, t: number, out: THREE.Color): THREE.Color {
  const key = `${b}:${t}`;
  let c = cache.get(key);
  if (!c) {
    c = new THREE.Color(PALETTES[b][t as Terrain] ?? 0xff00ff);
    cache.set(key, c);
  }
  return out.copy(c);
}

export function terrainHex(b: Biome, t: number): number {
  return PALETTES[b][t as Terrain] ?? 0xff00ff;
}
