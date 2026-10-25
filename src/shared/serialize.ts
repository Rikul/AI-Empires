// State snapshots, cloning and checksums.
import { generateMap } from './mapgen';
import { Hasher } from './rng';
import { rebuildDerived, emptyDerived } from './sim';
import type { Entity, GameState, MatchConfig, MatchResult, PlayerState } from './types';

export interface SerializedPlayer extends Omit<PlayerState, 'explored'> { explored: string }
export interface SerializedState {
  v: 1;
  tick: number;
  config: MatchConfig;
  players: [SerializedPlayer, SerializedPlayer];
  entities: Entity[];
  nextId: number;
  rng: number;
  result: MatchResult | null;
  resType: string;
  resAmt: string;
  visible: [string, string];
}

export function toBase64(u8: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + CH)));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

function cloneEntities(es: Entity[]): Entity[] {
  return JSON.parse(JSON.stringify(es));
}

export function serializeState(s: GameState): SerializedState {
  return {
    v: 1,
    tick: s.tick,
    config: s.config,
    players: s.players.map((p) => ({ ...JSON.parse(JSON.stringify({ ...p, explored: undefined })), explored: toBase64(p.explored) })) as [SerializedPlayer, SerializedPlayer],
    entities: cloneEntities(s.entities),
    nextId: s.nextId,
    rng: s.rng,
    result: s.result ? { ...s.result, scores: [...s.result.scores] as [number, number] } : null,
    resType: toBase64(s.map.resType),
    resAmt: toBase64(new Uint8Array(s.map.resAmt.buffer, s.map.resAmt.byteOffset, s.map.resAmt.byteLength)),
    visible: [toBase64(s.derived.visible[0]), toBase64(s.derived.visible[1])],
  };
}

/** Restore a state; static terrain is regenerated from the config (or reused if supplied). */
export function deserializeState(ss: SerializedState, staticMap?: { terrain: Uint8Array; height: Float32Array; starts: [number, number][] }): GameState {
  const base = staticMap ?? generateMap(ss.config.seed, ss.config.mapSize, ss.config.biome, ss.config.generationVersion);
  const size = Math.round(Math.sqrt(base.terrain.length));
  const resAmtBytes = fromBase64(ss.resAmt);
  const resAmt = new Uint16Array(size * size);
  new Uint8Array(resAmt.buffer).set(resAmtBytes);
  const s: GameState = {
    tick: ss.tick,
    config: ss.config,
    map: { size, terrain: base.terrain, height: base.height, starts: base.starts, resType: fromBase64(ss.resType), resAmt },
    players: ss.players.map((p) => ({ ...JSON.parse(JSON.stringify({ ...p, explored: undefined })), explored: fromBase64(p.explored) })) as [PlayerState, PlayerState],
    entities: cloneEntities(ss.entities),
    nextId: ss.nextId,
    rng: ss.rng,
    result: ss.result ? { ...ss.result, scores: [...ss.result.scores] as [number, number] } : null,
    derived: emptyDerived(size * size),
    events: [],
  };
  rebuildDerived(s);
  // visibility is refreshed every few ticks, so it is restored rather than recomputed
  s.derived.visible = [fromBase64(ss.visible[0]), fromBase64(ss.visible[1])];
  return s;
}

/** Fast in-memory clone sharing static terrain arrays. */
export function cloneState(s: GameState): GameState {
  const c: GameState = {
    tick: s.tick,
    config: s.config,
    map: { ...s.map, resType: s.map.resType.slice(), resAmt: s.map.resAmt.slice() },
    players: s.players.map((p) => ({ ...JSON.parse(JSON.stringify({ ...p, explored: undefined })), explored: p.explored.slice() })) as [PlayerState, PlayerState],
    entities: cloneEntities(s.entities),
    nextId: s.nextId,
    rng: s.rng,
    result: s.result ? { ...s.result, scores: [...s.result.scores] as [number, number] } : null,
    derived: emptyDerived(s.map.size * s.map.size),
    events: [],
  };
  rebuildDerived(c);
  c.derived.visible = [s.derived.visible[0].slice(), s.derived.visible[1].slice()];
  return c;
}

export function hashState(s: GameState): string {
  const h = new Hasher();
  h.int(s.tick);
  h.int(s.rng);
  h.int(s.nextId);
  for (const p of s.players) {
    h.num(p.res.food); h.num(p.res.wood); h.num(p.res.gold); h.num(p.res.stone);
    h.str(p.techs.join(','));
    let ex = 0;
    for (let i = 0; i < p.explored.length; i++) ex += p.explored[i] * ((i % 251) + 1);
    h.int(ex);
  }
  for (const e of s.entities) {
    h.int(e.id);
    h.num(e.hp);
    if (e.kind === 'unit') {
      h.str(e.type);
      h.num(e.x); h.num(e.y); h.num(e.carry);
      h.str(e.order ? e.order.k : '-');
    } else {
      h.str(e.type);
      h.int(e.tx); h.int(e.ty); h.num(e.progress);
      h.int(e.queue.length);
    }
  }
  let ra = 0;
  for (let i = 0; i < s.map.resAmt.length; i++) ra = (ra + s.map.resAmt[i] * ((i % 997) + 1)) | 0;
  h.int(ra);
  return h.hex();
}
