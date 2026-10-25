// In-game screen: renderer, viewports/layouts, HUD, AI logs, timeline and results.
import { api, download } from '../api';
import { navigate } from '../main';
import { GameSession } from '../game/session';
import { InputController } from '../game/input';
import { Renderer, Viewport } from '../render/renderer';
import { World, Perspective, teamCss } from '../render/world';
import { AI_CATEGORY, commandCategories } from '../../shared/ai/apply';
import { describeOrder, fmtTime } from '../../shared/ai/observation';
import {
  BUILDING_TYPES, BUILDINGS, BuildingType, costString, FARM_FOOD, RES_AMOUNT, RES_NAMES, RES_TYPES_LIST, TECHS, TechType, TICK_RATE, UNITS, UnitType,
} from './gameRules';
import { canAfford, getEnt, missingRequirements, popCapacity, popUsed, techAvailable, timeLimitTicks } from '../../shared/sim';
import type { AiCommand, BuildingEnt, Command, DecisionRecord, Entity, GameState, LoggedCommand, PlayerId, UnitEnt } from '../../shared/types';
import { clearTooltip, escapeHtml, h, modal, toast, tooltip } from './dom';
import { BUILDING_ICON, RES_ICON, TECH_ICON, UNIT_ICON } from './icons';

export async function openGame(root: HTMLElement, id: string): Promise<() => void> {
  root.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'empty' }, 'Loading match…')));
  let data;
  try { data = await api.get(id); } catch (e) {
    root.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'empty' }, `Could not load match: ${(e as Error).message}`, h('br'), h('button', { onclick: () => navigate({ name: 'home' }) }, 'Back'))));
    return () => {};
  }
  root.replaceChildren();
  const view = new GameView(root, new GameSession(data.record, data.snapshot));
  return () => view.dispose();
}

type Layout = 'split' | 'left' | 'right';

function playerName(s: GameSession, p: PlayerId) {
  const slot = s.record.config.players[p];
  return slot.kind === 'human' ? slot.name || 'You' : slot.ai.name || slot.ai.model;
}

class GameView {
  el: HTMLDivElement;
  stage: HTMLDivElement;
  world: World;
  renderer: Renderer;
  input: InputController;
  vps: Viewport[] = [];
  layout: Layout = 'split';
  private raf = 0;
  private last = performance.now();
  private hudAt = 0;
  private cmdSig = '';
  private top!: Record<string, HTMLElement>;
  private bottomInfo: HTMLDivElement;
  private bottomCmds: HTMLDivElement;
  private aiLogs: Record<number, { box: HTMLDivElement; log: HTMLDivElement; cats: HTMLDivElement; status: HTMLElement; count: number; viewTick: number }> = {};
  private slider: HTMLInputElement;
  private timeLabel: HTMLSpanElement;
  private liveBtn: HTMLButtonElement;
  private verifyEl: HTMLSpanElement;
  private seekOverlay: HTMLDivElement | null = null;
  private ordersLog: HTMLDivElement | null = null;
  private resultShown = false;
  private sliderDragging = false;
  private disposed = false;
  private onResize = () => this.resize();
  private resizeObs: ResizeObserver | null = null;
  private onKey = (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') { e.preventDefault(); this.togglePause(); }
  };

  constructor(root: HTMLElement, public session: GameSession) {
    const s = session;
    const ava = s.record.config.mode === 'ava';
    this.el = h('div', { class: 'game' });
    this.stage = h('div', { class: 'stage' });
    this.bottomInfo = h('div', { class: 'sel-info' });
    this.bottomCmds = h('div', { class: 'cmds' });
    this.slider = h('input', { type: 'range', min: '0', max: '1', step: '1', value: '0' }) as HTMLInputElement;
    this.timeLabel = h('span', { class: 'small' });
    this.liveBtn = h('button', { onclick: () => this.goLive(), title: 'Return to the live match' }, '● Live') as HTMLButtonElement;
    this.verifyEl = h('span', { class: 'verify' });
    this.el.append(this.buildTopbar(), this.stage, this.buildTimeline(), this.buildBottom(ava));
    root.appendChild(this.el);

    this.world = new World(s.view);
    this.world.localPlayer = s.humanPlayer;
    this.renderer = new Renderer(this.stage, this.world);
    const n = ava ? 2 : 1;
    for (let i = 0; i < n; i++) this.vps.push(this.renderer.addViewport());
    const starts = s.view.map.starts;
    if (ava) {
      this.vps[0].persp = 0; this.vps[0].lookAt(starts[0][0] + 0.5, starts[0][1] + 3);
      this.vps[1].persp = 1; this.vps[1].lookAt(starts[1][0] + 0.5, starts[1][1] + 3);
      this.vps.forEach((v, i) => this.addVpHeader(v, i));
    } else {
      this.vps[0].persp = s.mode === 'replay' ? 'omni' : 0;
      this.vps[0].lookAt(starts[0][0] + 0.5, starts[0][1] + 3);
      if (s.mode === 'replay') this.addVpHeader(this.vps[0], 0);
      this.ordersLog = h('div', { class: 'orders-log' });
      if (s.mode === 'replay') this.stage.appendChild(this.ordersLog);
    }
    this.input = new InputController(s, this.renderer, this.world, ava ? null : s.mode === 'live' ? 0 : null, {
      onSelectionChange: () => { this.cmdSig = ''; this.updatePanels(true); },
      onMessage: (t, k) => toast(t, k),
    });

    s.listeners.tick.push(() => this.onTick());
    s.listeners.jump.push(() => { this.world.onJump(s.view); this.input.pruneSelection(); this.updatePanels(true); });
    s.listeners.decision.push(() => this.updatePanels(true));
    s.listeners.finished.push(() => this.showResult());
    if (!ava && s.mode === 'live') {
      let lastErr = 0;
      s.listeners.decision.push((d) => {
        if (d.error && Date.now() - lastErr > 20000) { lastErr = Date.now(); toast(`AI decision failed: ${d.error.slice(0, 140)}`, 'error'); }
      });
    }
    // handle for automated UI tests
    (window as unknown as Record<string, unknown>).__aiEmpires = { session: s, world: this.world, input: this.input, viewports: this.vps };

    window.addEventListener('resize', this.onResize);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.stage);
    window.addEventListener('keydown', this.onKey);
    this.resize();
    this.updatePanels(true);
    if (s.mode === 'replay') {
      toast('Replay: press ▶ to play the recorded match from the start, or drag the timeline.');
    } else if (s.record.currentTick > 0) {
      toast(`Match restored at ${fmtTime(s.record.currentTick)} — press ▶ (or Space) to resume.`);
    } else toast('Press ▶ (or Space) to start the match.');
    this.loop();
  }

  // ------------------------------------------------------------- building UI

  private buildTopbar(): HTMLElement {
    const s = this.session;
    const ava = s.record.config.mode === 'ava';
    const top: Record<string, HTMLElement> = {};
    top.res = h('div', { class: 'res' });
    top.clock = h('div', { class: 'clock' });
    top.status = h('div', { class: 'status' });
    top.ai = h('div', { class: 'small' });
    top.pause = h('button', { onclick: () => this.togglePause(), title: 'Pause / resume (Space)' }, '▶');
    top.x1 = h('button', { onclick: () => this.setSpeed(1), title: 'Normal speed' }, '1×');
    top.x2 = h('button', { onclick: () => this.setSpeed(2), title: 'Double speed (same outcome, same AI decision interval in game time)' }, '2×');
    top.save = h('span', { class: 'small muted' });
    const layoutSeg = ava ? h('div', { class: 'seg' },
      ...(['split', 'left', 'right'] as Layout[]).map((l) => {
        const b = h('button', { onclick: () => { this.layout = l; this.resize(); this.updateLayoutButtons(); }, title: l === 'split' ? 'Side-by-side views' : l === 'left' ? 'Full-width left view' : 'Full-width right view' }, l === 'split' ? 'Split' : l === 'left' ? 'Left' : 'Right');
        b.dataset.layout = l;
        return b;
      })) : null;
    if (layoutSeg) top.layout = layoutSeg;
    this.top = top;
    return h('div', { class: 'topbar' },
      h('button', { onclick: () => this.exit(), title: 'Save and return to the main menu' }, '☰ Menu'),
      top.res,
      h('div', { class: 'grow' }),
      top.clock,
      top.status,
      ava ? null : top.ai,
      h('div', { class: 'grow' }),
      top.pause, top.x1, top.x2,
      layoutSeg,
      h('button', { onclick: () => this.exportMatch(), title: 'Export versioned match JSON' }, '⤓ Export'),
      ava ? null : top.save,
    );
  }

  private buildTimeline(): HTMLElement {
    const s = this.session;
    this.slider.addEventListener('input', () => { this.sliderDragging = true; this.timeLabel.textContent = `${fmtTime(+this.slider.value)} / ${fmtTime(s.endTick)}`; });
    this.slider.addEventListener('change', () => { this.sliderDragging = false; this.seek(+this.slider.value); });
    return h('div', { class: 'timeline' },
      h('span', { class: 'small muted' }, s.mode === 'replay' ? 'Replay' : 'History'),
      h('button', { title: 'Jump to start', onclick: () => this.seek(0) }, '⏮'),
      h('button', { title: 'Rewind 30 seconds', onclick: () => this.seek(s.view.tick - 30 * TICK_RATE) }, '⏪ 30s'),
      this.slider,
      h('button', { title: 'Forward 30 seconds', onclick: () => this.seek(s.view.tick + 30 * TICK_RATE) }, '30s ⏩'),
      this.timeLabel,
      s.mode === 'live' ? this.liveBtn : null,
      this.verifyEl,
    );
  }

  private buildBottom(ava: boolean): HTMLElement {
    if (!ava) {
      const b = h('div', { class: 'bottom' }, this.bottomInfo, this.bottomCmds);
      if (this.session.mode === 'replay') this.stage.appendChild(this.aiPanel(1, 'right'));
      return b;
    }
    const b = h('div', { class: 'bottom', style: { gridTemplateColumns: 'minmax(0,1.2fr) minmax(200px,0.8fr) minmax(0,1.2fr)', height: '190px' } },
      this.aiPanelInline(0), this.bottomInfo, this.aiPanelInline(1));
    return b;
  }

  private aiPanelInline(p: PlayerId): HTMLElement {
    const box = h('div', { class: 'ai-panel', style: { position: 'relative', width: 'auto', background: 'transparent', border: 'none', borderRight: p === 0 ? '1px solid #2b3340' : 'none', borderLeft: p === 1 ? '1px solid #2b3340' : 'none' } });
    return this.fillAiPanel(box, p);
  }

  private aiPanel(p: PlayerId, side: 'left' | 'right'): HTMLElement {
    const box = h('div', { class: `ai-panel ${side} collapsed` });
    const toggle = h('button', { class: 'panel-toggle', style: { [side]: '8px' }, onclick: () => box.classList.toggle('collapsed') }, `🤖 ${playerName(this.session, p)} log`);
    this.stage.appendChild(toggle);
    return this.fillAiPanel(box, p);
  }

  private fillAiPanel(box: HTMLDivElement, p: PlayerId): HTMLDivElement {
    const s = this.session;
    const slot = s.record.config.players[p];
    const status = h('span', { class: 'small muted' });
    const cats = h('div', { class: 'cats' });
    const log = h('div', { class: 'log' });
    box.append(
      h('div', { class: 'head' },
        h('span', { class: 'dot', style: { background: teamCss(p) } }),
        h('h3', { title: slot.kind === 'ai' ? `${slot.ai.baseUrl} · ${slot.ai.model}` : '' }, `${playerName(s, p)} ${slot.kind === 'ai' ? `· ${slot.ai.model}` : ''}`),
        status),
      cats, log);
    this.aiLogs[p] = { box, log, cats, status, count: -1, viewTick: -1 };
    return box;
  }

  private addVpHeader(v: Viewport, i: number) {
    const s = this.session;
    const opts: [Perspective, string][] = [['omni', 'Omniscient'], [0, `${playerName(s, 0)} knowledge`], [1, `${playerName(s, 1)} knowledge`]];
    const sel = h('select', {
      onchange: () => { const val = (sel as HTMLSelectElement).value; v.persp = val === 'omni' ? 'omni' : (Number(val) as PlayerId); },
    }, ...opts.map(([val, label]) => h('option', { value: String(val), selected: v.persp === val }, label))) as HTMLSelectElement;
    const label = s.record.config.mode === 'ava' ? (i === 0 ? 'Left view' : 'Right view') : 'View';
    v.el.appendChild(h('div', { class: 'vp-header' }, h('b', {}, label), sel,
      h('button', { style: { padding: '1px 6px', fontSize: '12px' }, title: 'Center on a base', onclick: () => {
        const p = (v.persp === 'omni' ? i : v.persp) as PlayerId;
        const tc = s.view.entities.find((e) => e.kind === 'building' && e.type === 'TownCenter' && e.owner === p && e.hp > 0) as BuildingEnt | undefined;
        const [x, y] = tc ? [tc.tx + 1.5, tc.ty + 1.5] : s.view.map.starts[p];
        v.lookAt(x, y + 3);
      } }, '⌂')));
  }

  private updateLayoutButtons() {
    this.top.layout?.querySelectorAll('button').forEach((b) => b.classList.toggle('active', (b as HTMLButtonElement).dataset.layout === this.layout));
  }

  resize() {
    this.renderer.resize();
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (this.vps.length === 1) {
      this.vps[0].visible = true;
      this.vps[0].setRect(0, 0, W, H);
    } else {
      const [a, b] = this.vps;
      a.visible = this.layout !== 'right';
      b.visible = this.layout !== 'left';
      if (this.layout === 'split') { a.setRect(0, 0, Math.floor(W / 2), H); b.setRect(Math.floor(W / 2), 0, W - Math.floor(W / 2), H); }
      else if (this.layout === 'left') { a.setRect(0, 0, W, H); b.setRect(0, 0, W, H); }
      else { b.setRect(0, 0, W, H); a.setRect(0, 0, W, H); }
      a.el.style.display = a.visible ? 'block' : 'none';
      b.el.style.display = b.visible ? 'block' : 'none';
    }
    this.updateLayoutButtons();
  }

  // ------------------------------------------------------------- loop

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const s = this.session;
    s.update(dt);
    if (this.world.state !== s.view) this.world.onJump(s.view);
    this.input.update(dt);
    this.world.frame(s.view, s.alpha, dt);
    this.renderer.render(s.view);
    if (now - this.hudAt > 150) { this.hudAt = now; this.updatePanels(false); }
  };

  private onTick() {
    const s = this.session;
    const v = s.view;
    this.world.onTick(v);
    if (s.isReviewing) {
      // show the recorded human orders while reviewing / replaying
      const t = v.tick - 1;
      for (const c of s.record.commands) {
        if (c.tick !== t) continue;
        if (c.source === 'human') this.markOrder(c, v);
      }
    }
    if (!s.isReviewing || true) this.input.pruneSelection();
  }

  private markOrder(c: LoggedCommand, s: GameState) {
    const cmd = c.cmd;
    const col = c.player === 0 ? 0x5aa0ff : 0xff6a5a;
    if ('x' in cmd && 'y' in cmd && typeof cmd.x === 'number') this.world.marker(cmd.x + (cmd.t === 'gather' || cmd.t === 'build' ? 0.5 : 0), cmd.y + (cmd.t === 'gather' || cmd.t === 'build' ? 0.5 : 0), col);
    else if ('target' in cmd) {
      const t = s.derived.byId.get(cmd.target);
      if (t) { const [x, y] = t.kind === 'unit' ? [t.x, t.y] : [t.tx + BUILDINGS[t.type].size / 2, t.ty + BUILDINGS[t.type].size / 2]; this.world.marker(x, y, 0xff3030); }
    }
  }

  // ------------------------------------------------------------- controls

  togglePause() {
    const s = this.session;
    if (s.seeking) return;
    if (s.engine.finished && s.mode === 'live' && !s.review) { this.showResult(); return; }
    if (s.mode === 'replay' && s.paused && s.view.tick >= s.endTick) { this.seek(0).then(() => s.setPaused(false)); return; }
    s.setPaused(!s.paused);
    this.updatePanels(true);
  }

  setSpeed(v: 1 | 2) { this.session.setSpeed(v); this.updatePanels(true); }

  async seek(t: number) {
    const s = this.session;
    const target = Math.max(0, Math.min(Math.round(t), s.endTick));
    const far = Math.abs(target - s.view.tick) > 3000;
    if (far) {
      const bar = h('i');
      this.seekOverlay = h('div', { class: 'overlay' }, h('div', { class: 'modal' }, h('div', {}, `Rebuilding history to ${fmtTime(target)}…`), h('div', { class: 'progress' }, bar)));
      this.stage.appendChild(this.seekOverlay);
      const iv = setInterval(() => { if (s.seeking) bar.style.width = `${Math.round(s.seeking.progress * 100)}%`; }, 100);
      await s.seek(target);
      clearInterval(iv);
      this.seekOverlay.remove();
      this.seekOverlay = null;
    } else await s.seek(target);
    this.updatePanels(true);
  }

  goLive() {
    this.session.exitReview();
    this.world.onJump(this.session.view);
    this.updatePanels(true);
  }

  async exportMatch() {
    const s = this.session;
    if (s.mode === 'live') {
      await s.save(true);
      if (s.saveError) { toast(`Save failed: ${s.saveError}`, 'error'); return; }
    }
    download(api.exportUrl(s.record.id));
    toast(`Exported ${s.record.status} match (${fmtTime(s.record.currentTick)})`);
  }

  async exit() {
    const s = this.session;
    if (s.mode === 'live') {
      if (!s.paused) s.setPaused(true);
      await s.save(true);
    }
    navigate({ name: 'home' });
  }

  showResult() {
    const s = this.session;
    const r = s.engine.state.result ?? s.record.result;
    if (!r || this.resultShown) return;
    this.resultShown = true;
    const human = s.humanPlayer;
    let title: string;
    if (r.winner === null) title = 'Draw';
    else if (human !== null && s.mode === 'live') title = r.winner === human ? 'Victory!' : 'Defeat';
    else title = `${playerName(s, r.winner)} wins`;
    const close = modal(h('div', {},
      h('h2', {}, title),
      h('p', {}, r.reason === 'conquest' ? 'Conquest — the losing side lost its Town Center and every unit.' : 'Time limit reached — decided by surviving asset value (cost × remaining HP fraction).'),
      h('table', { class: 'matches' },
        h('tr', {}, h('th', {}, 'Side'), h('th', {}, 'Surviving asset value')),
        ...[0, 1].map((p) => h('tr', {}, h('td', { style: { color: teamCss(p) } }, playerName(s, p as PlayerId)), h('td', {}, r.scores[p].toFixed(1))))),
      h('p', { class: 'small muted' }, `Ended at ${fmtTime(r.tick)}.`),
      h('div', { class: 'row', style: { marginTop: '12px' } },
        h('button', { onclick: () => close() }, 'Review match'),
        h('button', { onclick: () => this.exportMatch() }, '⤓ Export'),
        h('button', { class: 'primary', onclick: () => { close(); navigate({ name: 'home' }); } }, 'Main menu'),
      )));
  }

  // ------------------------------------------------------------- HUD updates

  private updatePanels(force: boolean) {
    const s = this.session;
    const v = s.view;
    const ava = s.record.config.mode === 'ava';
    // top bar
    const resBlock = (p: PlayerId, compact: boolean) => {
      const ps = v.players[p];
      const items = RES_TYPES_LIST.map((r) => `<span title="${r}">${RES_ICON[r]} ${Math.floor(ps.res[r])}</span>`).join('');
      const pop = `<span title="population">👥 ${popUsed(v, p)}/${popCapacity(v, p)}</span>`;
      return compact ? `<div class="side" style="border-left:3px solid ${teamCss(p)}"><b style="color:${teamCss(p)}">${escapeHtml(playerName(s, p))}</b>${items}${pop}</div>` : `${items}${pop}`;
    };
    this.top.res.innerHTML = ava || s.mode === 'replay' || s.humanPlayer === null ? resBlock(0, true) + resBlock(1, true) : resBlock(0, false);
    const limit = timeLimitTicks(s.record.config);
    this.top.clock.textContent = `⏱ ${fmtTime(v.tick)} / ${fmtTime(limit)}`;
    let status = '', cls = '';
    if (s.seeking) { status = 'Seeking…'; cls = 'review'; }
    else if (v.result && (!s.isReviewing || v.tick >= s.endTick)) { status = v.result.winner === null ? 'Draw' : `${playerName(s, v.result.winner)} won`; }
    else if (s.mode === 'replay') { status = s.paused ? 'Replay paused' : `Replay ${s.speed}×`; cls = 'review'; }
    else if (s.review) { status = s.paused ? 'Reviewing history (paused)' : `Reviewing history ${s.speed}×`; cls = 'review'; }
    else if (s.paused) {
      const n = s.live?.waitingFor().length ?? 0;
      status = n ? `Paused at tick ${v.tick} · ${n} AI request${n > 1 ? 's' : ''} in flight` : `Paused at tick ${v.tick}`;
      cls = 'wait';
    } else if (s.stalled) {
      const w = s.live?.waitingFor().filter((p) => p.applyTick <= v.tick).map((p) => playerName(s, p.player)).join(', ');
      status = `Waiting for ${w}…`; cls = 'wait';
    } else status = `Running ${s.speed}×`;
    this.top.status.textContent = status;
    this.top.status.className = `status ${cls}`;
    if (s.live) {
      const pend = s.live.waitingFor();
      this.top.ai.innerHTML = s.live.aiPlayers.map((p) => {
        const w = pend.find((x) => x.player === p);
        return `<span style="color:${teamCss(p)}">🤖 ${escapeHtml(playerName(s, p))}: ${w ? `thinking (${((Date.now() - w.startedAt) / 1000).toFixed(0)}s)` : 'ready'}</span>`;
      }).join(' &nbsp; ');
    } else this.top.ai.textContent = '';
    this.top.pause.textContent = s.paused ? '▶' : '⏸';
    this.top.pause.classList.toggle('active', !s.paused);
    this.top.x1.classList.toggle('active', s.speed === 1);
    this.top.x2.classList.toggle('active', s.speed === 2);
    this.top.save.textContent = s.mode === 'live' ? (s.saveError ? `⚠ save failed` : s.lastSavedAt ? `saved ${s.lastSavedAt.toLocaleTimeString()}` : '') : '';

    // timeline
    this.slider.max = String(Math.max(1, s.endTick));
    if (!this.sliderDragging) {
      this.slider.value = String(v.tick);
      this.timeLabel.textContent = `${fmtTime(v.tick)} / ${fmtTime(s.endTick)}`;
    }
    this.liveBtn.disabled = !s.review;
    this.liveBtn.classList.toggle('active', !s.review);
    if (s.mode === 'replay') {
      const eng = s.engine;
      const verified = s.record.checksums.filter((c) => c.tick <= eng.tick).length;
      if (eng.mismatch) { this.verifyEl.className = 'verify bad'; this.verifyEl.textContent = `✗ ${eng.mismatch}`; }
      else { this.verifyEl.className = 'verify ok'; this.verifyEl.textContent = `✓ replay matches recording (${verified}/${s.record.checksums.length} checkpoints)`; }
    }

    // AI logs
    for (const [pk, L] of Object.entries(this.aiLogs)) {
      const p = Number(pk) as PlayerId;
      const showAll = s.mode === 'replay' || ava;
      if (!showAll) continue;
      const decs = s.record.decisions.filter((d) => d.player === p && (s.isReviewing ? d.applyTick <= v.tick : true));
      const pend = s.live?.waitingFor().find((x) => x.player === p);
      L.status.textContent = pend ? `thinking ${((Date.now() - pend.startedAt) / 1000).toFixed(0)}s` : `${decs.length} decisions`;
      if (!force && decs.length === L.count) continue;
      L.count = decs.length;
      const used = new Set<string>();
      for (const d of decs) for (const c of d.commands) for (const cat of commandCategories(c)) used.add(cat);
      const allCats = [...new Set(Object.values(AI_CATEGORY))];
      L.cats.innerHTML = allCats.map((c) => `<span class="cat-${c.replace(/ /g, '-')} ${used.has(c) ? 'on' : ''}" title="${used.has(c) ? 'issued' : 'not issued yet'}">${used.has(c) ? '✓' : '·'} ${c}</span>`).join('');
      L.log.innerHTML = decs.slice(-40).reverse().map((d) => this.decisionHtml(d)).join('');
    }

    this.updateSelectionPanel(force);
  }

  private decisionHtml(d: DecisionRecord): string {
    const cmds = d.commands.map((c) => {
      const cat = commandCategories(c)[0];
      return `<span class="cmd cat-${cat.replace(/ /g, '-')}" title="${escapeHtml(JSON.stringify(c))}">${escapeHtml(cmdLabel(c))}</span>`;
    }).join('');
    return `<div class="entry"><div class="t">${fmtTime(d.requestTick)} → applied ${fmtTime(d.applyTick)} · ${(d.latencyMs / 1000).toFixed(1)}s</div>` +
      (d.error ? `<div class="err">⚠ ${escapeHtml(d.error)}</div>` : '') +
      (d.thoughts ? `<div class="thoughts">${escapeHtml(d.thoughts)}</div>` : '') +
      (d.plan ? `<div class="muted">plan: ${escapeHtml(d.plan)}</div>` : '') +
      `<div>${cmds || '<span class="muted">no commands</span>'}</div></div>`;
  }

  private updateSelectionPanel(force: boolean) {
    const s = this.session;
    const v = s.view;
    const sel = this.input.selectedEntities();
    const info = this.bottomInfo;
    if (this.ordersLog && s.mode === 'replay') this.updateOrdersLog();
    // selection info
    if (!sel.length) {
      const t = this.input.selectedTile;
      if (t >= 0 && v.map.resType[t]) {
        const r = v.map.resType[t];
        info.innerHTML = `<h3>${RES_NAMES[r] === 'tree' ? '🌳 Tree' : RES_NAMES[r] === 'gold' ? '🪙 Gold mine' : RES_NAMES[r] === 'stone' ? '🪨 Stone mine' : RES_NAMES[r] === 'berry' ? '🫐 Berry bush' : '🍖 Carcass'}</h3>
          <div>${v.map.resAmt[t]} / ${RES_AMOUNT[r]} ${r === 1 ? 'wood' : r === 2 ? 'gold' : r === 3 ? 'stone' : 'food'} remaining</div>
          <div class="hpbar"><i style="width:${Math.min(100, (v.map.resAmt[t] / RES_AMOUNT[r]) * 100)}%;background:var(--gold)"></i></div>
          <div class="muted small">Finite resource. Villagers carry 10 at a time to a compatible drop-off.</div>`;
      } else if (s.humanPlayer !== null && s.mode === 'live') {
        info.innerHTML = `<h3>Controls</h3><div class="small muted">Left-click select · drag to box-select · Shift adds/removes · double-click selects all visible of that type · right-click to move / gather / attack / build · Ctrl+right-click attack-move · A attack-move · Ctrl+1–9 groups · H Town Center · . idle villager · WASD/arrows/edge pan · wheel zoom · Space pause</div>`;
      } else {
        info.innerHTML = `<h3>Spectating</h3><div class="small muted">Click or drag to inspect units. Use each view's selector to switch between omniscient and either AI's knowledge. Wheel zooms the hovered view, WASD/arrows pan it, the minimap jumps.</div>`;
      }
    } else if (sel.length === 1) {
      info.innerHTML = this.entityInfoHtml(sel[0], v);
    } else {
      const counts = new Map<string, number>();
      for (const e of sel) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
      info.replaceChildren(h('h3', {}, `${sel.length} selected`), h('div', { class: 'sel-grid' }, ...[...counts.entries()].map(([t, n]) => {
        const chip = h('span', { class: 'sel-chip', title: 'Select only these' }, `${(UNIT_ICON as Record<string, string>)[t] ?? (BUILDING_ICON as Record<string, string>)[t] ?? ''} ${UNITS[t as UnitType]?.name ?? BUILDINGS[t as BuildingType]?.name ?? t} ×${n}`);
        chip.addEventListener('click', () => this.input.setSelection(sel.filter((e) => e.type === t).map((e) => e.id)));
        return chip;
      })));
    }
    // commands
    if (s.record.config.mode === 'ava') return;
    const sig = this.commandSignature(sel, v);
    if (!force && sig === this.cmdSig) { this.updateQueueProgress(sel, v); return; }
    this.cmdSig = sig;
    clearTooltip();
    this.bottomCmds.replaceChildren(...this.buildCommands(sel, v));
  }

  private updateOrdersLog() {
    const s = this.session, v = s.view;
    const human = s.record.commands.filter((c) => c.source === 'human');
    if (!human.length) { this.ordersLog!.style.display = 'none'; return; }
    this.ordersLog!.style.display = 'block';
    const key = `${v.tick >> 3}`;
    if (this.ordersLog!.dataset.key === key) return;
    this.ordersLog!.dataset.key = key;
    const past = human.filter((c) => c.tick < v.tick);
    this.ordersLog!.innerHTML = `<b>Human orders</b> (${past.length}/${human.length})<br>` + past.slice(-12).reverse().map((c, i) =>
      `<div class="${i === 0 && v.tick - c.tick < 30 ? 'cur' : ''}">${fmtTime(c.tick)} ${escapeHtml(humanCmdLabel(c.cmd))}</div>`).join('');
  }

  private entityInfoHtml(e: Entity, v: GameState): string {
    const s = this.session;
    const owner = e.owner === -1 ? 'Gaia' : playerName(s, e.owner as PlayerId);
    const color = teamCss(e.owner);
    if (e.kind === 'unit') {
      if (e.type === 'Deer') return `<h3>🦌 Deer</h3><div class="hpbar"><i style="width:${(e.hp / 8) * 100}%"></i></div><div class="small muted">Hunt with villagers for ${120} food.</div>`;
      const d = UNITS[e.type];
      const f = Math.max(0, e.hp / d.hp);
      const techs = e.owner !== -1 ? v.players[e.owner as PlayerId].techs : [];
      const atk = d.attack + (e.type !== 'Villager' && d.attackKind === 'melee' && techs.includes('Toolworking') ? 2 : 0) + (d.attackKind === 'pierce' && techs.includes('Fletching') ? 1 : 0);
      const arm = e.type !== 'Villager' && techs.includes('ScaleArmor') ? 1 : 0;
      return `<h3>${UNIT_ICON[e.type]} ${d.name} <span class="small" style="color:${color}">· ${escapeHtml(owner)}</span></h3>
        <div class="small">HP ${Math.ceil(e.hp)} / ${d.hp}</div><div class="hpbar"><i style="width:${f * 100}%;background:${f > 0.6 ? 'var(--green)' : f > 0.3 ? '#e8c33a' : 'var(--danger)'}"></i></div>
        <div class="small">⚔ ${atk} ${d.attackKind} · 🛡 ${d.meleeArmor + arm}/${d.pierceArmor + arm} · range ${d.range + (d.attackKind === 'pierce' && techs.includes('Fletching') ? 1 : 0)} · speed ${d.speed}</div>
        <div class="small muted">${escapeHtml(describeOrder(e.order, e))}</div>
        ${e.carry >= 1 ? `<div class="small">Carrying ${RES_ICON[e.carryType!]} ${Math.floor(e.carry)} ${e.carryType}</div>` : ''}`;
    }
    const d = BUILDINGS[e.type];
    const f = Math.max(0, e.hp / d.hp);
    let extra = '';
    if (!e.built) extra += `<div class="small">🔨 Under construction: ${Math.floor((e.progress / d.buildTime) * 100)}%</div><div class="hpbar"><i style="width:${(e.progress / d.buildTime) * 100}%;background:var(--gold)"></i></div>`;
    if (e.type === 'Farm') extra += `<div class="small">🌾 ${e.food} / ${FARM_FOOD} food</div>`;
    if (d.pop) extra += `<div class="small muted">Houses ${d.pop}</div>`;
    if (d.dropoff.length) extra += `<div class="small muted">Drop-off: ${d.dropoff.join(', ')}</div>`;
    if (e.queue.length) extra += `<div class="small">Producing: ${e.queue.map((q) => q.what).join(', ')}</div>`;
    return `<h3>${BUILDING_ICON[e.type]} ${d.name} <span class="small" style="color:${color}">· ${escapeHtml(owner)}</span></h3>
      <div class="small">HP ${Math.ceil(e.hp)} / ${d.hp}</div><div class="hpbar"><i style="width:${f * 100}%;background:${f > 0.6 ? 'var(--green)' : f > 0.3 ? '#e8c33a' : 'var(--danger)'}"></i></div>${extra}
      <div class="small muted">${escapeHtml(d.description)}</div>`;
  }

  private commandSignature(sel: Entity[], v: GameState): string {
    const p = this.session.humanPlayer;
    if (p === null || !this.input.canCommand) return `none|${sel.map((e) => e.id).join(',')}`;
    const ps = v.players[p];
    const afford = [...BUILDING_TYPES.map((t) => canAfford(ps, BUILDINGS[t].cost) && !missingRequirements(v, p, BUILDINGS[t].requires).length),
      ...Object.values(UNITS).map((u) => canAfford(ps, u.cost) && !missingRequirements(v, p, u.requires).length),
      ...Object.values(TECHS).map((t) => canAfford(ps, t.cost) && techAvailable(v, p, t.type))].map((b) => (b ? 1 : 0)).join('');
    const b = sel.length === 1 && sel[0].kind === 'building' ? `${sel[0].built}|${sel[0].queue.map((q) => q.what).join(',')}` : '';
    return `${sel.map((e) => e.id).join(',')}|${afford}|${b}|${this.input.placing?.type ?? ''}`;
  }

  private updateQueueProgress(sel: Entity[], _v: GameState) {
    if (sel.length !== 1 || sel[0].kind !== 'building') return;
    const b = sel[0];
    this.bottomCmds.querySelectorAll<HTMLElement>('.qi').forEach((el, i) => {
      const q = b.queue[i];
      if (!q) return;
      const total = q.kind === 'unit' ? UNITS[q.what as UnitType].trainTime : TECHS[q.what as TechType].time;
      const bar = el.querySelector('b') as HTMLElement | null;
      if (bar) bar.style.width = `${Math.min(100, (q.progress / total) * 100)}%`;
    });
  }

  private buildCommands(sel: Entity[], v: GameState): Node[] {
    const p = this.session.humanPlayer;
    if (p === null) return [];
    if (!this.input.canCommand) {
      return [h('div', { class: 'small muted' }, this.session.review ? 'Reviewing history — orders are disabled. Click ● Live to return.' : this.session.engine.finished ? 'The match is over.' : '')];
    }
    const mine = sel.filter((e) => e.owner === p);
    if (!mine.length) return [h('div', { class: 'small muted' }, sel.length ? 'Not your unit.' : 'Select units or buildings to see their commands.')];
    const ps = v.players[p];
    const out: Node[] = [];
    const units = mine.filter((e): e is UnitEnt => e.kind === 'unit');
    const vills = units.filter((u) => u.type === 'Villager');
    const mil = units.filter((u) => u.type !== 'Villager');
    const issue = (c: Command) => { this.session.issue(c); this.cmdSig = ''; };
    const btn = (icon: string, label: string, onclick: () => void, tip: () => string, disabled = false) => {
      const b = h('button', { onclick, disabled }, h('span', { class: 'ico' }, icon), h('span', {}, label)) as HTMLButtonElement;
      tooltip(b, tip);
      return b;
    };
    if (vills.length) {
      out.push(h('div', { class: 'small muted' }, 'Build'));
      out.push(h('div', { class: 'cmd-grid' }, ...BUILDING_TYPES.map((t) => {
        const d = BUILDINGS[t];
        const missing = missingRequirements(v, p, d.requires);
        const ok = !missing.length && canAfford(ps, d.cost);
        const b = btn(BUILDING_ICON[t], d.name, () => this.input.startPlacing(t),
          () => `<b>${d.name}</b> — ${costString(d.cost)}<br>${escapeHtml(d.description)}${missing.length ? `<br><span style="color:#ff9a8a">Requires ${missing.join(', ')}</span>` : ''}`, !ok);
        if (this.input.placing?.type === t) b.classList.add('active');
        return b;
      })));
    }
    if (units.length) {
      const ids = units.map((u) => u.id);
      const cx = units.reduce((a, u) => a + u.x, 0) / units.length, cy = units.reduce((a, u) => a + u.y, 0) / units.length;
      out.push(h('div', { class: 'cmd-grid' },
        btn('✋', 'Stop', () => issue({ t: 'stop', units: ids }), () => 'Stop all current orders'),
        mil.length ? btn('⚔️', 'Attack-move', () => { this.input.attackMove = true; document.body.classList.add('cursor-attack'); toast('Attack-move: left-click a location'); }, () => 'Move and fight everything on the way (A)') : null,
        mil.length ? btn('🛡️', 'Defend here', () => issue({ t: 'guard', units: mil.map((u) => u.id), x: cx, y: cy, r: 8 }), () => 'Hold this area and engage enemies within 8 tiles') : null,
        btn('🧭', 'Explore', () => issue({ t: 'explore', units: ids }), () => 'Automatically explore unexplored land'),
        btn('🗑️', 'Delete', () => issue({ t: 'delete', ids }), () => 'Delete selected units (Del)'),
      ));
    }
    if (mine.length === 1 && mine[0].kind === 'building') {
      const b = mine[0];
      const d = BUILDINGS[b.type];
      if (b.built && (d.trains.length || d.researches.length)) {
        const popFull = popUsed(v, p) >= popCapacity(v, p);
        out.push(h('div', { class: 'cmd-grid' },
          ...d.trains.map((u) => {
            const ud = UNITS[u];
            const missing = missingRequirements(v, p, ud.requires);
            return btn(UNIT_ICON[u], ud.name, () => issue({ t: 'train', building: b.id, unit: u, count: 1 }),
              () => `<b>${ud.name}</b> — ${costString(ud.cost)} · ${ud.trainTime}s<br>${escapeHtml(ud.description)}<br>HP ${ud.hp} · atk ${ud.attack} · armor ${ud.meleeArmor}/${ud.pierceArmor}${missing.length ? `<br><span style="color:#ff9a8a">Requires ${missing.join(', ')}</span>` : ''}${popFull ? '<br><span style="color:#f0c96a">Population full — build Houses</span>' : ''}<br><i>Shift-click: queue 5</i>`,
              !!missing.length || !canAfford(ps, ud.cost) || b.queue.length >= 10);
          }),
          ...d.researches.map((t) => {
            const td = TECHS[t];
            const avail = techAvailable(v, p, t);
            return btn(TECH_ICON[t], td.name, () => issue({ t: 'research', building: b.id, tech: t }), () => `<b>${td.name}</b> — ${costString(td.cost)} · ${td.time}s<br>${td.description}${v.players[p].techs.includes(t) ? '<br>✓ Researched' : ''}`, !avail || !canAfford(ps, td.cost));
          }),
        ));
        // shift-click queues 5
        this.bottomCmds.onclick = null;
      }
      if (b.queue.length) {
        out.push(h('div', { class: 'queue' }, h('span', { class: 'muted' }, 'Queue (click to cancel):'), ...b.queue.map((q, i) => {
          const el = h('span', { class: 'qi', title: 'Cancel and refund', onclick: () => issue({ t: 'cancel', building: b.id, index: i }) },
            `${q.kind === 'unit' ? UNIT_ICON[q.what as UnitType] : TECH_ICON[q.what as TechType]} ${q.what}`, h('b', { style: { width: '0%' } }));
          return el;
        })));
      }
      out.push(h('div', { class: 'row' },
        d.trains.length ? h('span', { class: 'small muted' }, 'Right-click the ground to set a rally point.') : null,
        h('button', { onclick: () => issue({ t: 'delete', ids: [b.id] }), style: { padding: '2px 8px', fontSize: '12px' } }, b.built ? '🗑 Delete building' : '🗑 Cancel construction'),
      ));
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.resizeObs?.disconnect();
    window.removeEventListener('keydown', this.onKey);
    this.input.dispose();
    this.renderer.dispose();
    this.world.dispose();
    this.session.dispose();
    clearTooltip();
  }
}

function pt(v: unknown) { return Array.isArray(v) ? `(${v.map((x) => Math.round(Number(x))).join(',')})` : ''; }

function cmdLabel(c: AiCommand): string {
  const u = typeof c.units === 'string' ? c.units : Array.isArray(c.units) ? `${c.units.length} units` : '';
  const n = c.count ? ` ×${c.count}` : '';
  switch (c.type) {
    case 'gather': return `gather ${c.resource ?? ''} ${u}${n}`;
    case 'build': return `build ${c.building} ${pt(c.at)}${c.to ? `→${pt(c.to)}` : ''}`;
    case 'train': return `train ${c.unit}${n}`;
    case 'research': return `research ${c.tech}`;
    case 'explore': return `explore ${u}${c.to ? ` ${pt(c.to)}` : ''}`;
    case 'move': return `move ${u}${n} ${pt(c.to ?? c.at)}`;
    case 'attack': return `attack ${u}${n} ${c.target !== undefined ? `#${c.target}` : pt(c.to ?? c.at)}`;
    case 'defend': return `defend ${u} ${pt(c.at)}`;
    case 'group': return `group "${c.name}" (${Array.isArray(c.units) ? c.units.length : c.units})`;
    case 'stop': return `stop ${u}`;
    case 'rally': return `rally ${c.building ?? ''} ${pt(c.at)}`;
  }
  return c.type;
}

function humanCmdLabel(c: Command): string {
  switch (c.t) {
    case 'move': return `${c.attack ? 'attack-move' : 'move'} ${c.units.length} → (${Math.round(c.x)},${Math.round(c.y)})`;
    case 'attack': return `attack #${c.target} with ${c.units.length}`;
    case 'gather': return `gather at (${c.x},${c.y}) with ${c.units.length}`;
    case 'build': return `build ${c.building} at (${c.x},${c.y})`;
    case 'assist': return `assist #${c.target}`;
    case 'train': return `train ${c.unit}`;
    case 'research': return `research ${c.tech}`;
    case 'cancel': return 'cancel production';
    case 'stop': return `stop ${c.units.length}`;
    case 'guard': return `defend (${Math.round(c.x)},${Math.round(c.y)})`;
    case 'explore': return `explore with ${c.units.length}`;
    case 'rally': return `rally point (${Math.round(c.x)},${Math.round(c.y)})`;
    case 'delete': return `delete ${c.ids.length}`;
    case 'ai': return 'AI decision';
  }
}

void getEnt;
