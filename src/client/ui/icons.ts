import type { BuildingType, ResourceType, TechType, UnitType } from '../../shared/rules';

export const UNIT_ICON: Record<UnitType | 'Deer', string> = {
  Villager: '🧑‍🌾', Clubman: '🏏', Scout: '🐴', Swordsman: '⚔️', Spearman: '🔱', Bowman: '🏹',
  Skirmisher: '🎯', HorseArcher: '🏇', Cavalry: '🐎', Centurion: '🛡️', Deer: '🦌',
};
export const BUILDING_ICON: Record<BuildingType, string> = {
  TownCenter: '🏛️', House: '🏠', Granary: '🌾', StoragePit: '⛏️', Farm: '🌱', Barracks: '⚔️',
  ArcheryRange: '🏹', Stable: '🐎', Blacksmith: '🔨', WatchTower: '🗼', Wall: '🧱',
};
export const TECH_ICON: Record<TechType, string> = { Toolworking: '🗡️', Fletching: '🪶', ScaleArmor: '🥋' };
export const RES_ICON: Record<ResourceType, string> = { food: '🍖', wood: '🪵', gold: '🪙', stone: '🪨' };
