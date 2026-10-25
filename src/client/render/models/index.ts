// Public API of the procedural model module.
export { TEAM_COLORS, MAT as MODEL_MATERIAL } from './common';
export type { Team } from './common';
export { createUnitModel } from './units';
export type { UnitModel, AnimState, GatherKind } from './units';
export { createBuildingModel } from './buildings';
export type { BuildingModel } from './buildings';
export {
  createTreeGeometry,
  createGoldMineGeometry,
  createStoneMineGeometry,
  createBerryBushGeometry,
  createMeatGeometry,
  createTreeStumpGeometry,
} from './resources';
