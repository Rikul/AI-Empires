// Game rules shared by the simulation, the UI and the AI prompt builder.
// Both sides always use exactly these definitions.

export const TICK_RATE = 10; // simulation ticks per simulated second
export const TICK_DT = 1 / TICK_RATE;
export const GENERATION_VERSION = 1;
export const RULES_VERSION = 1;

export type ResourceType = 'food' | 'wood' | 'gold' | 'stone';
export const RESOURCE_TYPES: ResourceType[] = ['food', 'wood', 'gold', 'stone'];
export type Cost = Partial<Record<ResourceType, number>>;

export const STARTING_RESOURCES: Record<ResourceType, number> = { food: 300, wood: 300, gold: 150, stone: 100 };
export const STARTING_VILLAGERS = 6;
export const DEFAULT_POP_CAP = 200;
export const DEFAULT_TIME_LIMIT_MIN = 60;

export type UnitType =
  | 'Villager' | 'Clubman' | 'Scout' | 'Swordsman' | 'Spearman'
  | 'Bowman' | 'Skirmisher' | 'HorseArcher' | 'Cavalry' | 'Centurion';
export const UNIT_TYPES: UnitType[] = [
  'Villager', 'Clubman', 'Scout', 'Swordsman', 'Spearman',
  'Bowman', 'Skirmisher', 'HorseArcher', 'Cavalry', 'Centurion',
];
export type GaiaUnitType = 'Deer';

export type BuildingType =
  | 'TownCenter' | 'House' | 'Granary' | 'StoragePit' | 'Farm' | 'Barracks'
  | 'ArcheryRange' | 'Stable' | 'Blacksmith' | 'WatchTower' | 'Wall';
export const BUILDING_TYPES: BuildingType[] = [
  'TownCenter', 'House', 'Granary', 'StoragePit', 'Farm', 'Barracks',
  'ArcheryRange', 'Stable', 'Blacksmith', 'WatchTower', 'Wall',
];

export type TechType = 'Toolworking' | 'Fletching' | 'ScaleArmor';
export const TECH_TYPES: TechType[] = ['Toolworking', 'Fletching', 'ScaleArmor'];

export type ArmorClass = 'infantry' | 'archer' | 'cavalry' | 'villager' | 'building' | 'animal';

export interface UnitDef {
  type: UnitType;
  name: string;
  cost: Cost;
  hp: number;
  attack: number;
  /** 'melee' attacks hit melee armor, 'pierce' attacks hit pierce armor */
  attackKind: 'melee' | 'pierce';
  meleeArmor: number;
  pierceArmor: number;
  /** attack range in tiles (melee units use a small reach) */
  range: number;
  /** seconds between attacks */
  reload: number;
  /** tiles per second */
  speed: number;
  sight: number;
  trainTime: number;
  trainedAt: BuildingType;
  requires: BuildingType[];
  armorClass: ArmorClass;
  /** extra damage against units of the given class */
  bonus?: Partial<Record<ArmorClass, number>>;
  mounted: boolean;
  description: string;
}

export const UNITS: Record<UnitType, UnitDef> = {
  Villager: {
    type: 'Villager', name: 'Villager', cost: { food: 50 }, hp: 25, attack: 3, attackKind: 'melee',
    meleeArmor: 0, pierceArmor: 0, range: 0.6, reload: 1.5, speed: 1.1, sight: 5, trainTime: 20,
    trainedAt: 'TownCenter', requires: [], armorClass: 'villager', mounted: false,
    description: 'Gathers resources, constructs buildings.',
  },
  Clubman: {
    type: 'Clubman', name: 'Clubman', cost: { food: 50 }, hp: 40, attack: 4, attackKind: 'melee',
    meleeArmor: 0, pierceArmor: 0, range: 0.6, reload: 1.5, speed: 1.2, sight: 5, trainTime: 18,
    trainedAt: 'Barracks', requires: [], armorClass: 'infantry', mounted: false,
    description: 'Cheap early infantry.',
  },
  Scout: {
    type: 'Scout', name: 'Scout', cost: { food: 100 }, hp: 60, attack: 3, attackKind: 'melee',
    meleeArmor: 0, pierceArmor: 0, range: 0.7, reload: 1.5, speed: 2.0, sight: 10, trainTime: 25,
    trainedAt: 'Stable', requires: [], armorClass: 'cavalry', mounted: true,
    description: 'Fast mounted explorer with wide line of sight.',
  },
  Swordsman: {
    type: 'Swordsman', name: 'Swordsman', cost: { food: 35, gold: 15 }, hp: 60, attack: 7, attackKind: 'melee',
    meleeArmor: 1, pierceArmor: 0, range: 0.6, reload: 1.5, speed: 1.2, sight: 5, trainTime: 22,
    trainedAt: 'Barracks', requires: ['Blacksmith'], armorClass: 'infantry', mounted: false,
    description: 'Solid melee infantry. Requires a Blacksmith.',
  },
  Spearman: {
    type: 'Spearman', name: 'Spearman', cost: { food: 35, wood: 25 }, hp: 45, attack: 4, attackKind: 'melee',
    meleeArmor: 0, pierceArmor: 0, range: 0.8, reload: 1.5, speed: 1.2, sight: 5, trainTime: 20,
    trainedAt: 'Barracks', requires: [], armorClass: 'infantry', bonus: { cavalry: 12 }, mounted: false,
    description: 'Anti-cavalry infantry (+12 vs cavalry).',
  },
  Bowman: {
    type: 'Bowman', name: 'Bowman', cost: { food: 40, wood: 20 }, hp: 30, attack: 4, attackKind: 'pierce',
    meleeArmor: 0, pierceArmor: 0, range: 6, reload: 1.6, speed: 1.2, sight: 7, trainTime: 22,
    trainedAt: 'ArcheryRange', requires: [], armorClass: 'archer', bonus: { infantry: 1 }, mounted: false,
    description: 'Ranged foot archer.',
  },
  Skirmisher: {
    type: 'Skirmisher', name: 'Skirmisher', cost: { food: 25, wood: 35 }, hp: 32, attack: 2, attackKind: 'pierce',
    meleeArmor: 0, pierceArmor: 3, range: 5, reload: 1.6, speed: 1.2, sight: 6, trainTime: 20,
    trainedAt: 'ArcheryRange', requires: [], armorClass: 'infantry', bonus: { archer: 5 }, mounted: false,
    description: 'Javelin thrower that counters archers (+5 vs archers, high pierce armor).',
  },
  HorseArcher: {
    type: 'HorseArcher', name: 'Horse Archer', cost: { food: 40, gold: 70 }, hp: 55, attack: 5, attackKind: 'pierce',
    meleeArmor: 0, pierceArmor: 1, range: 5, reload: 1.8, speed: 1.9, sight: 7, trainTime: 30,
    trainedAt: 'ArcheryRange', requires: ['Stable'], armorClass: 'archer', mounted: true,
    description: 'Fast mounted archer. Requires a Stable.',
  },
  Cavalry: {
    type: 'Cavalry', name: 'Cavalry', cost: { food: 70, gold: 75 }, hp: 120, attack: 8, attackKind: 'melee',
    meleeArmor: 1, pierceArmor: 1, range: 0.8, reload: 1.8, speed: 1.8, sight: 6, trainTime: 30,
    trainedAt: 'Stable', requires: [], armorClass: 'cavalry', bonus: { archer: 4 }, mounted: true,
    description: 'Heavy mounted melee (+4 vs archers).',
  },
  Centurion: {
    type: 'Centurion', name: 'Centurion', cost: { food: 70, wood: 20, gold: 60 }, hp: 150, attack: 12, attackKind: 'melee',
    meleeArmor: 3, pierceArmor: 2, range: 0.7, reload: 1.6, speed: 1.1, sight: 6, trainTime: 35,
    trainedAt: 'Barracks', requires: ['Blacksmith'], armorClass: 'infantry', bonus: { building: 6 }, mounted: false,
    description: 'Elite heavy infantry, strong vs buildings. Requires a Blacksmith.',
  },
};

export interface GaiaUnitDef { type: GaiaUnitType; hp: number; speed: number; food: number }
export const GAIA_UNITS: Record<GaiaUnitType, GaiaUnitDef> = {
  Deer: { type: 'Deer', hp: 8, speed: 1.6, food: 120 },
};

export interface BuildingDef {
  type: BuildingType;
  name: string;
  cost: Cost;
  hp: number;
  size: number; // footprint is size x size tiles
  buildTime: number; // seconds for one villager
  pop: number;
  dropoff: ResourceType[];
  trains: UnitType[];
  researches: TechType[];
  requires: BuildingType[];
  sight: number;
  /** blocks movement when placed */
  blocking: boolean;
  attack?: { damage: number; range: number; reload: number };
  description: string;
}

export const BUILDINGS: Record<BuildingType, BuildingDef> = {
  TownCenter: {
    type: 'TownCenter', name: 'Town Center', cost: { wood: 275, stone: 100 }, hp: 1500, size: 3, buildTime: 120,
    pop: 10, dropoff: ['food', 'wood', 'gold', 'stone'], trains: ['Villager'], researches: [], requires: [],
    sight: 8, blocking: true, description: 'Trains villagers. Drop-off for all resources. Houses 10.',
  },
  House: {
    type: 'House', name: 'House', cost: { wood: 30 }, hp: 300, size: 2, buildTime: 20, pop: 5,
    dropoff: [], trains: [], researches: [], requires: [], sight: 3, blocking: true,
    description: 'Increases population capacity by 5.',
  },
  Granary: {
    type: 'Granary', name: 'Granary', cost: { wood: 100 }, hp: 600, size: 2, buildTime: 30, pop: 0,
    dropoff: ['food'], trains: [], researches: [], requires: [], sight: 4, blocking: true,
    description: 'Food drop-off. Required for Farms.',
  },
  StoragePit: {
    type: 'StoragePit', name: 'Storage Pit', cost: { wood: 100 }, hp: 600, size: 2, buildTime: 30, pop: 0,
    dropoff: ['wood', 'gold', 'stone'], trains: [], researches: [], requires: [], sight: 4, blocking: true,
    description: 'Drop-off for wood, gold and stone.',
  },
  Farm: {
    type: 'Farm', name: 'Farm', cost: { wood: 60 }, hp: 200, size: 3, buildTime: 15, pop: 0,
    dropoff: [], trains: [], researches: [], requires: ['Granary'], sight: 2, blocking: false,
    description: 'Renewable-looking but finite food field (300 food). Requires a Granary.',
  },
  Barracks: {
    type: 'Barracks', name: 'Barracks', cost: { wood: 125 }, hp: 900, size: 3, buildTime: 40, pop: 0,
    dropoff: [], trains: ['Clubman', 'Spearman', 'Swordsman', 'Centurion'], researches: [], requires: [], sight: 4,
    blocking: true, description: 'Trains infantry.',
  },
  ArcheryRange: {
    type: 'ArcheryRange', name: 'Archery Range', cost: { wood: 150 }, hp: 900, size: 3, buildTime: 40, pop: 0,
    dropoff: [], trains: ['Bowman', 'Skirmisher', 'HorseArcher'], researches: [], requires: ['Barracks'], sight: 4,
    blocking: true, description: 'Trains archers. Requires Barracks.',
  },
  Stable: {
    type: 'Stable', name: 'Stable', cost: { wood: 150 }, hp: 900, size: 3, buildTime: 40, pop: 0,
    dropoff: [], trains: ['Scout', 'Cavalry'], researches: [], requires: ['Barracks'], sight: 4,
    blocking: true, description: 'Trains mounted units. Requires Barracks.',
  },
  Blacksmith: {
    type: 'Blacksmith', name: 'Blacksmith', cost: { wood: 150 }, hp: 900, size: 2, buildTime: 40, pop: 0,
    dropoff: [], trains: [], researches: ['Toolworking', 'Fletching', 'ScaleArmor'], requires: ['Barracks'], sight: 4,
    blocking: true, description: 'Researches military upgrades. Unlocks Swordsman and Centurion.',
  },
  WatchTower: {
    type: 'WatchTower', name: 'Watch Tower', cost: { wood: 25, stone: 75 }, hp: 500, size: 1, buildTime: 30, pop: 0,
    dropoff: [], trains: [], researches: [], requires: [], sight: 9, blocking: true,
    attack: { damage: 5, range: 7, reload: 2 }, description: 'Defensive tower that shoots arrows.',
  },
  Wall: {
    type: 'Wall', name: 'Wall', cost: { stone: 4 }, hp: 400, size: 1, buildTime: 4, pop: 0,
    dropoff: [], trains: [], researches: [], requires: [], sight: 1, blocking: true,
    description: 'Blocks movement. One segment per tile; place in lines.',
  },
};

export interface TechDef { type: TechType; name: string; cost: Cost; time: number; description: string }
export const TECHS: Record<TechType, TechDef> = {
  Toolworking: { type: 'Toolworking', name: 'Toolworking', cost: { food: 100, gold: 40 }, time: 40, description: '+2 attack for melee military units.' },
  Fletching: { type: 'Fletching', name: 'Fletching', cost: { food: 100, wood: 50 }, time: 40, description: '+1 attack and +1 range for ranged units and towers.' },
  ScaleArmor: { type: 'ScaleArmor', name: 'Scale Armor', cost: { food: 100, gold: 50 }, time: 45, description: '+1 melee and +1 pierce armor for military units.' },
};

export const FARM_FOOD = 300;

// Natural resources on tiles
export enum Res { None = 0, Tree = 1, Gold = 2, Stone = 3, Berry = 4, Meat = 5 }
export const RES_NAMES = ['none', 'tree', 'gold', 'stone', 'berry', 'meat'] as const;
export const RES_YIELD: ResourceType[] = ['food', 'wood', 'gold', 'stone', 'food', 'food'];
export const RES_AMOUNT = [0, 100, 450, 350, 150, 120];
export function resBlocks(r: number): boolean { return r >= 1 && r <= 4; }

/** gather rate (resource per second) by natural resource / farm */
export const GATHER_RATE = { tree: 0.5, gold: 0.45, stone: 0.45, berry: 0.5, meat: 0.8, farm: 0.45 };
export const CARRY_CAPACITY = 10;
export const BUILD_RATE = 1; // build-seconds per villager-second
export const REPAIR_HP_PER_SEC = 4;

// Terrain
export enum Terrain { Grass = 0, Sand = 1, Snow = 2, Dirt = 3, Rock = 4, Water = 5, Shallow = 6, Forest = 7 }
export function terrainPassable(t: number): boolean { return t !== Terrain.Water && t !== Terrain.Rock; }
export function terrainBuildable(t: number): boolean { return t !== Terrain.Water && t !== Terrain.Rock && t !== Terrain.Shallow; }

export type MapSize = 'Small' | 'Medium' | 'Large' | 'Huge';
export const MAP_SIZES: Record<MapSize, number> = { Small: 96, Medium: 128, Large: 160, Huge: 200 };
export type Biome = 'TemperateGrasslands' | 'DesertOasis' | 'SnowyHighlands' | 'DenseWoodland' | 'RockySteppe';
export const BIOMES: Biome[] = ['TemperateGrasslands', 'DesertOasis', 'SnowyHighlands', 'DenseWoodland', 'RockySteppe'];
export const BIOME_NAMES: Record<Biome, string> = {
  TemperateGrasslands: 'Temperate Grasslands',
  DesertOasis: 'Desert Oasis',
  SnowyHighlands: 'Snowy Highlands',
  DenseWoodland: 'Dense Woodland',
  RockySteppe: 'Rocky Steppe',
};

export function costValue(c: Cost): number {
  return (c.food ?? 0) + (c.wood ?? 0) + (c.gold ?? 0) + (c.stone ?? 0);
}

export function costString(c: Cost): string {
  return RESOURCE_TYPES.filter((r) => c[r]).map((r) => `${c[r]} ${r}`).join(', ');
}

export const isMilitary = (t: UnitType) => t !== 'Villager';
export const isRanged = (t: UnitType) => UNITS[t].attackKind === 'pierce';
