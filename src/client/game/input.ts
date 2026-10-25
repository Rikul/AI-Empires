// Desktop RTS controls: click/box/shift/double-click selection, right-click orders,
// building placement, camera movement and hotkeys.
import * as THREE from 'three';
import { BUILDINGS, BuildingType, Res, UNITS } from '../../shared/rules';
import { canAfford, getEnt, missingRequirements, placementError } from '../../shared/sim';
import type { Command, Entity, GameState, PlayerId, UnitEnt } from '../../shared/types';
import type { Renderer, Viewport } from '../render/renderer';
import type { World } from '../render/world';
import type { GameSession } from './session';

export interface InputCallbacks {
  onSelectionChange(): void;
  onMessage(text: string, kind?: 'info' | 'error'): void;
}

export class InputController {
  selection: number[] = [];
  selectedTile = -1;
  placing: { type: BuildingType; wallStart: [number, number] | null } | null = null;
  attackMove = false;
  private dragStart: { x: number; y: number; vp: Viewport } | null = null;
  private dragEl: HTMLDivElement;
  private mouse = { x: 0, y: 0, inside: false };
  private lastClick = { t: 0, id: 0 };
  private groups: Record<string, number[]> = {};
  private lastGroupKey = { k: '', t: 0 };
  private keys = new Set<string>();
  private middleDrag: { x: number; y: number; vp: Viewport } | null = null;
  private disposers: (() => void)[] = [];
  private ray = new THREE.Raycaster();
  private hoverAt = 0;

  constructor(
    public session: GameSession,
    public renderer: Renderer,
    public world: World,
    public player: PlayerId | null, // null = spectator (inspect only)
    public cb: InputCallbacks,
  ) {
    this.dragEl = document.createElement('div');
    this.dragEl.className = 'drag-box';
    renderer.container.appendChild(this.dragEl);
    const c = renderer.canvas;
    const on = <K extends keyof WindowEventMap>(t: EventTarget, ev: K | string, fn: (e: never) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(ev, fn as EventListener, opts));
    };
    on(c, 'mousedown', (e: MouseEvent) => this.onDown(e));
    on(window, 'mousemove', (e: MouseEvent) => this.onMove(e));
    on(window, 'mouseup', (e: MouseEvent) => this.onUp(e));
    on(c, 'contextmenu', (e: MouseEvent) => e.preventDefault());
    on(c, 'wheel', (e: WheelEvent) => { e.preventDefault(); const vp = this.vpAt(e.clientX, e.clientY); vp?.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12); }, { passive: false });
    on(c, 'mouseenter', () => { this.mouse.inside = true; });
    on(c, 'mouseleave', () => { this.mouse.inside = false; });
    on(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    on(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    on(window, 'blur', () => this.keys.clear());
  }

  get canCommand() { return this.player !== null && this.session.mode === 'live' && !this.session.review && !this.session.engine.finished; }
  private get state(): GameState { return this.session.view; }

  private vpAt(cx: number, cy: number): Viewport | null {
    const r = this.renderer.canvas.getBoundingClientRect();
    for (const v of this.renderer.viewports) if (v.visible && v.toNdc(cx, cy, r)) return v;
    return null;
  }

  private rayFrom(cx: number, cy: number, vp: Viewport): THREE.Raycaster | null {
    const ndc = vp.toNdc(cx, cy, this.renderer.canvas.getBoundingClientRect());
    if (!ndc) return null;
    this.ray.setFromCamera(ndc, vp.camera);
    return this.ray;
  }

  private groundAt(cx: number, cy: number, vp: Viewport): [number, number] | null {
    const ray = this.rayFrom(cx, cy, vp);
    if (!ray) return null;
    const p = this.world.pickGround(ray);
    return p ? [p.x, p.z] : null;
  }

  private pick(cx: number, cy: number, vp: Viewport): { ent?: Entity; tile: number; ground: [number, number] | null } {
    const ray = this.rayFrom(cx, cy, vp);
    if (!ray) return { tile: -1, ground: null };
    // the renderer's visibility flags reflect the last rendered viewport; refresh for this one
    this.world.prepareView(this.state, vp.persp, vp.camera);
    let id = this.world.pickEntity(ray);
    let ent = id ? getEnt(this.state, id) : undefined;
    if (!ent || ent.kind !== 'unit') {
      // units are small on screen: accept clicks near a unit's projected body
      const r = this.renderer.canvas.getBoundingClientRect();
      const mx = cx - r.left - vp.rect.x, my = cy - r.top - vp.rect.y;
      const tol = Math.max(12, 520 / vp.dist);
      let best = 0, bd = tol * tol;
      for (const p of this.world.unitScreenPositions(vp.camera, vp.rect.w, vp.rect.h, this.state, () => true)) {
        const d = (p.sx - mx) ** 2 + ((p.sy - my) * 0.8) ** 2;
        if (d < bd) { bd = d; best = p.id; }
      }
      if (best) { id = best; ent = getEnt(this.state, best); }
    }
    let tile = this.world.pickResourceTile(ray);
    const p = this.world.pickGround(ray);
    const ground: [number, number] | null = p ? [p.x, p.z] : null;
    if (tile < 0 && ground) {
      const S = this.state.map.size;
      const tx = Math.floor(ground[0]), ty = Math.floor(ground[1]);
      if (tx >= 0 && ty >= 0 && tx < S && ty < S && this.state.map.resType[ty * S + tx]) tile = ty * S + tx;
    }
    // hidden tiles are not pickable from a fogged perspective
    if (tile >= 0 && vp.persp !== 'omni' && !this.state.players[vp.persp].explored[tile]) tile = -1;
    return { ent, tile, ground };
  }

  // ---------------------------------------------------------------- mouse

  private onDown(e: MouseEvent) {
    const vp = this.vpAt(e.clientX, e.clientY);
    if (!vp) return;
    if (e.button === 1) { this.middleDrag = { x: e.clientX, y: e.clientY, vp }; e.preventDefault(); return; }
    if (e.button === 2) { this.rightClick(e, vp); return; }
    if (e.button !== 0) return;
    if (this.placing) { this.placeClick(e, vp); return; }
    if (this.attackMove && this.canCommand) {
      const g = this.groundAt(e.clientX, e.clientY, vp);
      const { ent } = this.pick(e.clientX, e.clientY, vp);
      this.attackMove = false;
      document.body.classList.remove('cursor-attack');
      if (ent && ent.owner !== this.player) this.issueUnits((ids) => ({ t: 'attack', units: ids, target: ent.id }));
      else if (g) { this.issueUnits((ids) => ({ t: 'move', units: ids, x: g[0], y: g[1], attack: true })); this.world.marker(g[0], g[1], 0xff5040); }
      return;
    }
    this.dragStart = { x: e.clientX, y: e.clientY, vp };
  }

  private onMove(e: MouseEvent) {
    this.mouse.x = e.clientX; this.mouse.y = e.clientY;
    if (this.middleDrag) {
      const k = this.middleDrag.vp.dist / 400;
      this.middleDrag.vp.pan(-(e.clientX - this.middleDrag.x) * k, -(e.clientY - this.middleDrag.y) * k);
      this.middleDrag.x = e.clientX; this.middleDrag.y = e.clientY;
      return;
    }
    if (this.dragStart) {
      const r = this.renderer.container.getBoundingClientRect();
      const x0 = Math.min(this.dragStart.x, e.clientX) - r.left, y0 = Math.min(this.dragStart.y, e.clientY) - r.top;
      const w = Math.abs(e.clientX - this.dragStart.x), h = Math.abs(e.clientY - this.dragStart.y);
      if (w > 4 || h > 4) Object.assign(this.dragEl.style, { display: 'block', left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${h}px` });
    }
    const vp = this.vpAt(e.clientX, e.clientY);
    if (this.placing && vp) this.updateGhost(e.clientX, e.clientY, vp);
    const now = performance.now();
    if (vp && !this.dragStart && now - this.hoverAt > 60) {
      this.hoverAt = now;
      const { ent } = this.pick(e.clientX, e.clientY, vp);
      this.world.hover = ent ? ent.id : 0;
    }
  }

  private onUp(e: MouseEvent) {
    if (e.button === 1) { this.middleDrag = null; return; }
    if (e.button !== 0 || !this.dragStart) return;
    const ds = this.dragStart;
    this.dragStart = null;
    this.dragEl.style.display = 'none';
    const dx = Math.abs(e.clientX - ds.x), dy = Math.abs(e.clientY - ds.y);
    if (dx > 5 || dy > 5) this.boxSelect(ds.x, ds.y, e.clientX, e.clientY, ds.vp, e.shiftKey);
    else this.clickSelect(e.clientX, e.clientY, ds.vp, e.shiftKey);
  }

  private isMine(e: Entity) { return this.player === null ? true : e.owner === this.player; }

  private clickSelect(cx: number, cy: number, vp: Viewport, shift: boolean) {
    const { ent, tile } = this.pick(cx, cy, vp);
    const now = performance.now();
    const dbl = ent && this.lastClick.id === ent.id && now - this.lastClick.t < 350;
    this.lastClick = { t: now, id: ent?.id ?? 0 };
    if (ent && dbl && ent.kind === 'unit' && ent.owner !== -1 && (this.player === null || ent.owner === this.player)) {
      // double-click: all visible units of the same type and owner on screen
      const r = this.renderer.canvas.getBoundingClientRect();
      this.world.prepareView(this.state, vp.persp, vp.camera);
      const pts = this.world.unitScreenPositions(vp.camera, vp.rect.w, vp.rect.h, this.state, (u) => u.owner === ent.owner && u.type === ent.type);
      const ids = pts.filter((p) => p.sx >= 0 && p.sy >= 0 && p.sx <= vp.rect.w && p.sy <= vp.rect.h).map((p) => p.id);
      void r;
      this.setSelection(shift ? [...new Set([...this.selection, ...ids])] : ids);
      return;
    }
    if (ent) {
      const mine = this.isMine(ent) && ent.owner !== -1;
      if (shift && mine && this.selection.every((id) => { const s = getEnt(this.state, id); return s && this.isMine(s) && s.owner !== -1; })) {
        const has = this.selection.includes(ent.id);
        this.setSelection(has ? this.selection.filter((id) => id !== ent.id) : [...this.selection, ent.id]);
      } else this.setSelection([ent.id]);
      this.selectedTile = -1;
      return;
    }
    if (!shift) this.setSelection([]);
    this.selectedTile = tile;
    this.cb.onSelectionChange();
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, vp: Viewport, shift: boolean) {
    const r = this.renderer.canvas.getBoundingClientRect();
    const ax = Math.min(x0, x1) - r.left - vp.rect.x, bx = Math.max(x0, x1) - r.left - vp.rect.x;
    const ay = Math.min(y0, y1) - r.top - vp.rect.y, by = Math.max(y0, y1) - r.top - vp.rect.y;
    this.world.prepareView(this.state, vp.persp, vp.camera);
    const owner = this.player;
    const pts = this.world.unitScreenPositions(vp.camera, vp.rect.w, vp.rect.h, this.state, (u) => (owner === null ? u.owner !== -1 : u.owner === owner));
    let ids = pts.filter((p) => p.sx >= ax && p.sx <= bx && p.sy >= ay && p.sy <= by).map((p) => p.id);
    if (owner === null && ids.length) {
      // spectators: keep one side (the majority) per box
      const first = getEnt(this.state, ids[0])!.owner;
      ids = ids.filter((id) => getEnt(this.state, id)!.owner === first);
    }
    this.selectedTile = -1;
    this.setSelection(shift ? [...new Set([...this.selection, ...ids])] : ids);
  }

  setSelection(ids: number[]) {
    this.selection = ids;
    this.world.selection = new Set(ids);
    this.cb.onSelectionChange();
  }

  /** Remove dead/invisible entities from the selection. */
  pruneSelection() {
    const s = this.state;
    const keep = this.selection.filter((id) => getEnt(s, id));
    if (keep.length !== this.selection.length) this.setSelection(keep);
  }

  selectedEntities(): Entity[] {
    return this.selection.map((id) => getEnt(this.state, id)).filter((e): e is Entity => !!e);
  }

  private ownSelectedUnits(): UnitEnt[] {
    return this.selectedEntities().filter((e): e is UnitEnt => e.kind === 'unit' && e.owner === this.player);
  }

  private issue(cmd: Command): boolean {
    if (!this.canCommand) { this.cb.onMessage(this.session.review ? 'Return to live play to give orders.' : 'Orders are disabled.', 'error'); return false; }
    return this.session.issue(cmd);
  }

  issueUnits(make: (ids: number[]) => Command, filter?: (u: UnitEnt) => boolean) {
    const units = this.ownSelectedUnits().filter((u) => !filter || filter(u));
    if (!units.length) return false;
    return this.issue(make(units.map((u) => u.id)));
  }

  private rightClick(e: MouseEvent, vp: Viewport) {
    if (this.placing) { this.cancelPlacing(); return; }
    if (this.attackMove) { this.attackMove = false; document.body.classList.remove('cursor-attack'); return; }
    if (!this.canCommand) return;
    const { ent, tile, ground } = this.pick(e.clientX, e.clientY, vp);
    const sel = this.selectedEntities();
    const units = sel.filter((x): x is UnitEnt => x.kind === 'unit' && x.owner === this.player);
    const S = this.state.map.size;
    if (!units.length) {
      // rally point for selected production buildings
      const blds = sel.filter((x) => x.kind === 'building' && x.owner === this.player);
      if (blds.length && ground) {
        for (const b of blds) this.issue({ t: 'rally', building: b.id, x: ground[0], y: ground[1] });
        this.world.marker(ground[0], ground[1], 0xffffff);
        this.cb.onMessage('Rally point set');
      }
      return;
    }
    const ids = units.map((u) => u.id);
    const vill = units.filter((u) => u.type === 'Villager').map((u) => u.id);
    const others = units.filter((u) => u.type !== 'Villager').map((u) => u.id);
    if (ent && ent.owner !== this.player) {
      if (ent.owner === -1 && ent.kind === 'unit') {
        this.issue({ t: 'attack', units: ids, target: ent.id }); // hunting
      } else this.issue({ t: 'attack', units: ids, target: ent.id });
      this.world.marker(...(ent.kind === 'unit' ? [ent.x, ent.y] as [number, number] : [ent.tx + BUILDINGS[ent.type].size / 2, ent.ty + BUILDINGS[ent.type].size / 2] as [number, number]), 0xff4040);
      return;
    }
    if (ent && ent.kind === 'building' && ent.owner === this.player) {
      const needsWork = !ent.built || ent.hp < BUILDINGS[ent.type].hp || ent.type === 'Farm';
      if (vill.length && needsWork) this.issue({ t: 'assist', units: vill, target: ent.id });
      else if (vill.length) {
        // drop off / move next to the building
        const [cx, cy] = [ent.tx + BUILDINGS[ent.type].size / 2, ent.ty + BUILDINGS[ent.type].size + 0.5];
        this.issue({ t: 'move', units: vill, x: cx, y: cy });
      }
      if (others.length) this.issue({ t: 'move', units: others, x: ent.tx + BUILDINGS[ent.type].size / 2, y: ent.ty + BUILDINGS[ent.type].size + 1 });
      this.world.marker(ent.tx + BUILDINGS[ent.type].size / 2, ent.ty + BUILDINGS[ent.type].size / 2, 0x60ff60);
      return;
    }
    if (tile >= 0 && vill.length) {
      this.issue({ t: 'gather', units: vill, x: tile % S, y: Math.floor(tile / S) });
      this.world.marker((tile % S) + 0.5, Math.floor(tile / S) + 0.5, 0xffe060);
      if (others.length && ground) this.issue({ t: 'move', units: others, x: ground[0], y: ground[1] });
      return;
    }
    if (ground) {
      const atk = e.ctrlKey;
      this.issue({ t: 'move', units: ids, x: ground[0], y: ground[1], attack: atk });
      this.world.marker(ground[0], ground[1], atk ? 0xff5040 : 0x60ff60);
    }
  }

  // ---------------------------------------------------------------- placement

  startPlacing(type: BuildingType) {
    if (!this.canCommand || this.player === null) return;
    const def = BUILDINGS[type];
    const missing = missingRequirements(this.state, this.player, def.requires);
    if (missing.length) { this.cb.onMessage(`Requires ${missing.join(', ')}`, 'error'); return; }
    if (!canAfford(this.state.players[this.player], def.cost)) { this.cb.onMessage('Not enough resources', 'error'); return; }
    this.placing = { type, wallStart: null };
    this.cb.onMessage(type === 'Wall' ? 'Click the wall start, then the end point (right-click cancels)' : `Place ${def.name} (shift-click to place several, right-click cancels)`);
    const vp = this.vpAt(this.mouse.x, this.mouse.y);
    if (vp) this.updateGhost(this.mouse.x, this.mouse.y, vp);
  }

  cancelPlacing() {
    this.placing = null;
    this.world.setGhost(null);
  }

  private placementTile(cx: number, cy: number, vp: Viewport): [number, number] | null {
    const g = this.groundAt(cx, cy, vp);
    if (!g || !this.placing) return null;
    const sz = BUILDINGS[this.placing.type].size;
    return [Math.round(g[0] - sz / 2), Math.round(g[1] - sz / 2)];
  }

  private wallTiles(a: [number, number], b: [number, number]): [number, number][] {
    const steps = Math.min(40, Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])));
    const out: [number, number][] = [];
    for (let k = 0; k <= steps; k++) {
      const x = steps ? Math.round(a[0] + ((b[0] - a[0]) * k) / steps) : a[0];
      const y = steps ? Math.round(a[1] + ((b[1] - a[1]) * k) / steps) : a[1];
      if (!out.some(([p, q]) => p === x && q === y)) out.push([x, y]);
    }
    return out;
  }

  private updateGhost(cx: number, cy: number, vp: Viewport) {
    const t = this.placementTile(cx, cy, vp);
    if (!t || !this.placing || this.player === null) return;
    const type = this.placing.type;
    if (type === 'Wall' && this.placing.wallStart) {
      const tiles = this.wallTiles(this.placing.wallStart, t);
      const ok = tiles.every(([x, y]) => !placementError(this.state, this.player!, 'Wall', x, y)) && canAfford(this.state.players[this.player], BUILDINGS.Wall.cost, tiles.length);
      this.world.setGhost('Wall', 0, 0, ok, tiles);
      return;
    }
    const ok = !placementError(this.state, this.player, type, t[0], t[1]);
    this.world.setGhost(type, t[0], t[1], ok);
  }

  private placeClick(e: MouseEvent, vp: Viewport) {
    const t = this.placementTile(e.clientX, e.clientY, vp);
    if (!t || !this.placing || this.player === null) return;
    const type = this.placing.type;
    const builders = this.ownSelectedUnits().filter((u) => u.type === 'Villager').map((u) => u.id);
    if (type === 'Wall') {
      if (!this.placing.wallStart) { this.placing.wallStart = t; this.updateGhost(e.clientX, e.clientY, vp); return; }
      const err = this.issue({ t: 'build', units: builders, building: 'Wall', x: this.placing.wallStart[0], y: this.placing.wallStart[1], x2: t[0], y2: t[1], queue: e.shiftKey });
      if (err) this.cb.onMessage('Wall placed');
      if (e.shiftKey) this.placing.wallStart = null; else this.cancelPlacing();
      return;
    }
    const perr = placementError(this.state, this.player, type, t[0], t[1]);
    if (perr) { this.cb.onMessage(`Cannot place here: ${perr}`, 'error'); return; }
    this.issue({ t: 'build', units: builders, building: type, x: t[0], y: t[1], queue: e.shiftKey });
    if (!e.shiftKey) this.cancelPlacing();
    else if (!canAfford(this.state.players[this.player], BUILDINGS[type].cost, 2)) this.cancelPlacing();
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(e: KeyboardEvent, down: boolean) {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const k = e.key.toLowerCase();
    if (down) this.keys.add(k); else this.keys.delete(k);
    if (!down) return;
    if (k === 'escape') {
      if (this.placing) this.cancelPlacing();
      else if (this.attackMove) { this.attackMove = false; document.body.classList.remove('cursor-attack'); }
      else this.setSelection([]);
      return;
    }
    if (/^[0-9]$/.test(k)) {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.groups[k] = this.selection.slice();
        this.cb.onMessage(`Group ${k} set (${this.selection.length})`);
      } else if (this.groups[k]) {
        const now = performance.now();
        const ids = this.groups[k].filter((id) => getEnt(this.state, id));
        this.setSelection(e.shiftKey ? [...new Set([...this.selection, ...ids])] : ids);
        if (this.lastGroupKey.k === k && now - this.lastGroupKey.t < 400) this.centerOnSelection();
        this.lastGroupKey = { k, t: now };
      }
      return;
    }
    if (k === 'delete' && this.canCommand) {
      const ids = this.selectedEntities().filter((x) => x.owner === this.player).map((x) => x.id);
      if (ids.length) this.issue({ t: 'delete', ids });
      return;
    }
    if (k === 'h' && this.player !== null) {
      const tc = this.state.entities.find((x) => x.kind === 'building' && x.type === 'TownCenter' && x.owner === this.player && x.hp > 0);
      if (tc) { this.setSelection([tc.id]); this.centerOnSelection(); }
      return;
    }
    if (k === '.' && this.player !== null) {
      const idle = this.state.entities.filter((x): x is UnitEnt => x.kind === 'unit' && x.type === 'Villager' && x.owner === this.player && x.hp > 0 && !x.order);
      if (!idle.length) { this.cb.onMessage('No idle villagers'); return; }
      const cur = this.selection.length === 1 ? idle.findIndex((u) => u.id === this.selection[0]) : -1;
      const next = idle[(cur + 1) % idle.length];
      this.setSelection([next.id]);
      this.centerOnSelection();
      return;
    }
    if (k === 'a' && !e.ctrlKey && this.ownSelectedUnits().length && this.canCommand) {
      this.attackMove = true;
      document.body.classList.add('cursor-attack');
      this.cb.onMessage('Attack-move: left-click a target location');
      return;
    }
    if (k === 's' && e.shiftKey === false && this.ownSelectedUnits().length && this.canCommand && !this.keys.has('w')) {
      // 's' is also camera pan; only stop when units are selected and shift-S isn't used
    }
  }

  centerOnSelection() {
    const es = this.selectedEntities();
    if (!es.length) return;
    let x = 0, y = 0;
    for (const e of es) {
      if (e.kind === 'unit') { x += e.x; y += e.y; } else { x += e.tx + BUILDINGS[e.type].size / 2; y += e.ty + BUILDINGS[e.type].size / 2; }
    }
    const vp = this.vpAt(this.mouse.x, this.mouse.y) ?? this.renderer.viewports.find((v) => v.visible)!;
    vp.lookAt(x / es.length, y / es.length);
  }

  /** Per-frame camera movement from keys. */
  update(dt: number) {
    const vp = (this.mouse.inside ? this.vpAt(this.mouse.x, this.mouse.y) : null) ?? this.renderer.viewports.find((v) => v.visible);
    if (!vp) return;
    const sp = vp.dist * 1.1 * dt;
    let dx = 0, dz = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a') && !this.attackMove && !this.ownSelectedUnits().length) dx -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) dx += 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) dz -= 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) dz += 1;
    if (dx || dz) vp.pan(dx * sp, dz * sp);
  }

  isResourceTile(t: number) { return t >= 0 && this.state.map.resType[t] !== Res.None; }

  unitInfo(u: UnitEnt) { return u.type === 'Deer' ? null : UNITS[u.type]; }

  dispose() {
    this.disposers.forEach((d) => d());
    this.dragEl.remove();
    document.body.classList.remove('cursor-attack');
  }
}
