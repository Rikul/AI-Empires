import type { Biome, BuildingType, GaiaUnitType, MapSize, ResourceType, TechType, UnitType } from './rules';

export type PlayerId = 0 | 1;
export type Owner = PlayerId | -1;

export interface AiConnection {
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export type PlayerSlot =
  | { kind: 'human'; name: string }
  | { kind: 'ai'; ai: AiConnection };

export type MatchMode = 'pva' | 'ava';

export interface MatchConfig {
  mode: MatchMode;
  mapSize: MapSize;
  biome: Biome;
  seed: string;
  popCap: number;
  timeLimitMin: number;
  generationVersion: number;
  rulesVersion: number;
  /** AI decisions are requested every `decisionIntervalSec` of simulated time... */
  decisionIntervalSec: number;
  /** ...and applied exactly `decisionWindowSec` of simulated time after the request. */
  decisionWindowSec: number;
  players: [PlayerSlot, PlayerSlot];
}

export interface MapData {
  size: number;
  terrain: Uint8Array; // size*size
  height: Float32Array; // (size+1)*(size+1) vertex heights
  resType: Uint8Array; // size*size (Res enum)
  resAmt: Uint16Array; // size*size
  starts: [number, number][]; // TC center tile per player
}

export type AnimState = 'idle' | 'walk' | 'attack' | 'gather' | 'build' | 'dead';

export type Order =
  | { k: 'move'; x: number; y: number }
  | { k: 'amove'; x: number; y: number }
  | { k: 'attack'; target: number; hunt?: boolean }
  | { k: 'gather'; tx: number; ty: number; res: number }
  | { k: 'farm'; target: number }
  | { k: 'build'; target: number; /** foundations to build next, in order */ then?: number[] }
  | { k: 'guard'; x: number; y: number; r: number }
  | { k: 'explore'; x: number; y: number };

export interface UnitEnt {
  kind: 'unit';
  id: number;
  owner: Owner;
  type: UnitType | GaiaUnitType;
  x: number;
  y: number;
  hp: number;
  order: Order | null;
  /** auto-acquired combat target while executing amove/guard/idle */
  autoTarget: number;
  path: number[] | null;
  pathI: number;
  pathGoal: number; // tile index the path was computed for (or -1)
  repath: number; // ticks until path refresh allowed
  carryType: ResourceType | null;
  carry: number;
  cd: number;
  anim: AnimState;
  dirX: number;
  dirY: number;
  gatherKind: 'wood' | 'food' | 'gold' | 'stone' | 'farm' | null;
  /** remembers resource tile to return to after a drop-off */
  returnTo: number;
  stuck: number;
  lastX: number;
  lastY: number;
  /** dead units linger a few ticks for the death animation */
  deadTicks: number;
}

export interface QueueItem {
  kind: 'unit' | 'tech';
  what: UnitType | TechType;
  progress: number; // seconds of work done
}

export interface BuildingEnt {
  kind: 'building';
  id: number;
  owner: Owner;
  type: BuildingType;
  tx: number;
  ty: number;
  hp: number;
  built: boolean;
  progress: number; // build seconds done
  queue: QueueItem[];
  rally: [number, number] | null;
  food: number; // farms: remaining food
  cd: number;
  target: number; // tower target
}

export type Entity = UnitEnt | BuildingEnt;

export interface RememberedBuilding {
  id: number;
  type: BuildingType;
  tx: number;
  ty: number;
  owner: Owner;
  hp: number;
  built: boolean;
}

export interface PlayerState {
  res: Record<ResourceType, number>;
  techs: TechType[];
  explored: Uint8Array;
  memory: Record<number, RememberedBuilding>;
  groups: Record<string, number[]>;
  plan: string;
  /** feedback for the AI: results of its last commands */
  feedback: string[];
  /** notable events (attacks, losses, completions), newest last */
  alerts: { tick: number; text: string }[];
  stats: { gathered: Record<ResourceType, number>; trained: number; built: number; killed: number; lost: number };
  lastAttackedTick: number;
}

export interface MatchResult {
  winner: PlayerId | null; // null = draw
  reason: 'conquest' | 'time';
  scores: [number, number];
  tick: number;
}

export interface SimEvent {
  type: 'attack' | 'death' | 'built' | 'trained' | 'researched' | 'destroyed' | 'deposit';
  res?: ResourceType;
  amount?: number;
  src?: number;
  dst?: number;
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  ranged?: boolean;
  owner?: Owner;
}

export interface GameState {
  tick: number;
  config: MatchConfig;
  map: MapData;
  players: [PlayerState, PlayerState];
  entities: Entity[];
  nextId: number;
  rng: number;
  result: MatchResult | null;
  /** derived, recomputed from entities on load */
  derived: Derived;
  /** transient per-tick events for rendering (not serialized) */
  events: SimEvent[];
}

export interface Derived {
  byId: Map<number, Entity>;
  /** building id occupying tile + 1 (0 = none) for blocking buildings & foundations */
  bgrid: Int32Array;
  /** farm id + 1 per tile */
  fgrid: Int32Array;
  visible: [Uint8Array, Uint8Array];
  blockVersion: number;
  pathBudget: number;
}

// ---- Commands -------------------------------------------------------------

export type Command =
  | { t: 'move'; units: number[]; x: number; y: number; attack?: boolean }
  | { t: 'attack'; units: number[]; target: number }
  | { t: 'gather'; units: number[]; x: number; y: number }
  | { t: 'build'; units: number[]; building: BuildingType; x: number; y: number; x2?: number; y2?: number; /** append to builders' current build job instead of replacing it */ queue?: boolean }
  | { t: 'assist'; units: number[]; target: number }
  | { t: 'train'; building: number; unit: UnitType; count: number }
  | { t: 'research'; building: number; tech: TechType }
  | { t: 'cancel'; building: number; index: number }
  | { t: 'stop'; units: number[] }
  | { t: 'guard'; units: number[]; x: number; y: number; r: number }
  | { t: 'explore'; units: number[] }
  | { t: 'rally'; building: number; x: number; y: number }
  | { t: 'delete'; ids: number[] }
  | { t: 'ai'; plan: string; cmds: AiCommand[] };

export interface LoggedCommand {
  tick: number;
  player: PlayerId;
  source: 'human' | 'ai';
  cmd: Command;
}

/** Commands as emitted by an LLM commander (resolved deterministically inside the simulation). */
export type UnitSelector = number[] | string;
export interface AiCommand {
  type: 'gather' | 'build' | 'train' | 'research' | 'explore' | 'move' | 'attack' | 'defend' | 'group' | 'stop' | 'rally';
  units?: UnitSelector;
  count?: number;
  resource?: string;
  near?: [number, number];
  building?: string | number;
  at?: [number, number];
  to?: [number, number];
  unit?: string;
  tech?: string;
  target?: number;
  radius?: number;
  name?: string;
  [k: string]: unknown;
}

export interface DecisionRecord {
  player: PlayerId;
  requestTick: number;
  applyTick: number;
  latencyMs: number;
  ok: boolean;
  error?: string;
  thoughts?: string;
  plan?: string;
  raw?: string;
  commands: AiCommand[];
}

export interface Checksum { tick: number; hash: string }

export type MatchStatus = 'running' | 'paused' | 'completed';

export interface MatchRecord {
  format: 'ai-empires-match';
  formatVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: MatchStatus;
  config: MatchConfig;
  currentTick: number;
  commands: LoggedCommand[];
  decisions: DecisionRecord[];
  checksums: Checksum[];
  result: MatchResult | null;
}
