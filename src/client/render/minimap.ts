import { BUILDINGS, Res } from '../../shared/rules';
import type { GameState, MapData } from '../../shared/types';
import { entityVisibleTo } from '../../shared/sim';
import { terrainHex } from './palette';
import type { World } from './world';
import type { Viewport } from './renderer';
import type { Biome } from '../../shared/rules';

const RES_PX: Record<number, [number, number, number]> = {
  [Res.Tree]: [38, 82, 30], [Res.Gold]: [255, 214, 60], [Res.Stone]: [200, 200, 205], [Res.Berry]: [220, 60, 110], [Res.Meat]: [200, 80, 60],
};

/** Render a top-down image of a map (used by the minimap and the setup preview). */
export function renderMapImage(m: MapData, biome: Biome, px: number, showResources = true): ImageData {
  const S = m.size;
  const img = new ImageData(px, px);
  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const tx = Math.floor((x / px) * S), ty = Math.floor((y / px) * S);
      const i = ty * S + tx;
      let r: number, g: number, b: number;
      const res = m.resType[i];
      if (showResources && res && RES_PX[res]) [r, g, b] = RES_PX[res];
      else {
        const hex = terrainHex(biome, m.terrain[i]);
        r = (hex >> 16) & 255; g = (hex >> 8) & 255; b = hex & 255;
        const h = m.height[ty * (S + 1) + tx];
        const shade = 1 + Math.max(-0.25, Math.min(0.25, h * 0.08));
        r *= shade; g *= shade; b *= shade;
      }
      const o = (y * px + x) * 4;
      img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  }
  return img;
}

export class Minimap {
  canvas = document.createElement('canvas');
  private base: HTMLCanvasElement | null = null;
  private baseTick = -1;
  private fogCanvas = document.createElement('canvas');
  private dragging = false;
  readonly px = 176;

  constructor(public world: World, public vp: Viewport) {
    this.canvas.width = this.canvas.height = this.px;
    this.canvas.className = 'minimap';
    this.fogCanvas.width = this.fogCanvas.height = world.size;
    const go = (e: MouseEvent) => {
      const r = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * world.size, y = ((e.clientY - r.top) / r.height) * world.size;
      vp.lookAt(x, y);
    };
    this.canvas.addEventListener('mousedown', (e) => { if (e.button === 0) { this.dragging = true; go(e); e.stopPropagation(); } });
    window.addEventListener('mousemove', (e) => { if (this.dragging) go(e); });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  draw(s: GameState) {
    const g = this.canvas.getContext('2d')!;
    const S = s.map.size;
    const px = this.px;
    // terrain + resources image (refreshed periodically as resources deplete)
    if (!this.base || s.tick - this.baseTick > 50 || s.tick < this.baseTick) {
      this.base = this.base ?? document.createElement('canvas');
      this.base.width = this.base.height = px;
      this.base.getContext('2d')!.putImageData(renderMapImage(s.map, s.config.biome, px), 0, 0);
      this.baseTick = s.tick;
    }
    g.drawImage(this.base, 0, 0);
    const persp = this.vp.persp;
    if (persp !== 'omni') {
      const fg = this.fogCanvas.getContext('2d')!;
      const img = fg.createImageData(S, S);
      const exp = s.players[persp].explored, vis = s.derived.visible[persp];
      for (let i = 0; i < S * S; i++) {
        img.data[i * 4 + 3] = vis[i] ? 0 : exp[i] ? 120 : 255;
      }
      fg.putImageData(img, 0, 0);
      g.imageSmoothingEnabled = true;
      g.drawImage(this.fogCanvas, 0, 0, px, px);
    }
    const k = px / S;
    for (const e of s.entities) {
      if (e.hp <= 0) continue;
      if (persp !== 'omni' && e.owner !== persp) {
        if (e.kind === 'building' ? !(s.players[persp].memory[e.id] || entityVisibleTo(s, persp, e)) : !entityVisibleTo(s, persp, e)) continue;
      }
      g.fillStyle = e.owner === 0 ? '#3d7bff' : e.owner === 1 ? '#ff3d30' : '#e6d6a8';
      if (e.kind === 'building') {
        const sz = BUILDINGS[e.type].size;
        g.fillRect(e.tx * k, e.ty * k, Math.max(2, sz * k), Math.max(2, sz * k));
        g.strokeStyle = 'rgba(0,0,0,0.6)';
        g.strokeRect(e.tx * k, e.ty * k, Math.max(2, sz * k), Math.max(2, sz * k));
      } else {
        const r = e.owner === -1 ? 1.2 : 1.8;
        g.fillRect(e.x * k - r, e.y * k - r, r * 2, r * 2);
      }
    }
    // camera frustum
    const f = this.vp.frustumOnGround();
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 1;
    g.beginPath();
    f.forEach((p, i) => (i ? g.lineTo(p.x * k, p.y * k) : g.moveTo(p.x * k, p.y * k)));
    g.closePath();
    g.stroke();
  }
}
