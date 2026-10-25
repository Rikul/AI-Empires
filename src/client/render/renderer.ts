// One WebGL renderer drawing one or two viewports (scissored) of the shared world.
import * as THREE from 'three';
import type { GameState } from '../../shared/types';
import { World, Perspective } from './world';
import { Minimap } from './minimap';

export class Viewport {
  camera = new THREE.PerspectiveCamera(42, 1, 0.5, 400);
  target = new THREE.Vector2(0, 0);
  dist = 34;
  pitch = 0.95; // radians from horizontal
  persp: Perspective = 'omni';
  rect = { x: 0, y: 0, w: 1, h: 1 };
  visible = true;
  el: HTMLDivElement;
  minimap: Minimap;
  keys = new Set<string>();

  constructor(public world: World, public index: number, container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'viewport-overlay';
    container.appendChild(this.el);
    this.minimap = new Minimap(world, this);
    this.el.appendChild(this.minimap.canvas);
  }

  lookAt(x: number, z: number) {
    const S = this.world.size;
    this.target.set(Math.max(0, Math.min(S, x)), Math.max(0, Math.min(S, z)));
    this.updateCamera();
  }

  pan(dx: number, dz: number) { this.lookAt(this.target.x + dx, this.target.y + dz); }

  zoom(f: number) {
    this.dist = Math.max(10, Math.min(90, this.dist * f));
    this.updateCamera();
  }

  updateCamera() {
    const h = this.world.heightAt(this.target.x, this.target.y);
    const y = Math.sin(this.pitch) * this.dist, back = Math.cos(this.pitch) * this.dist;
    this.camera.position.set(this.target.x, h + y, this.target.y + back);
    this.camera.lookAt(this.target.x, h, this.target.y);
    this.camera.aspect = this.rect.w / Math.max(1, this.rect.h);
    this.camera.updateProjectionMatrix();
  }

  /** Ground points at the four screen corners (for the minimap frustum). */
  frustumOnGround(): THREE.Vector2[] {
    const out: THREE.Vector2[] = [];
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    for (const [x, y] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, p)) out.push(new THREE.Vector2(p.x, p.z));
      else out.push(new THREE.Vector2(this.target.x + x * 60, this.target.y - y * 60));
    }
    return out;
  }

  setRect(x: number, y: number, w: number, h: number) {
    this.rect = { x, y, w, h };
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px`, display: this.visible ? 'block' : 'none' });
    this.updateCamera();
  }

  /** NDC coordinates of a client point, or null if outside. */
  toNdc(clientX: number, clientY: number, canvasRect: DOMRect): THREE.Vector2 | null {
    const x = clientX - canvasRect.left - this.rect.x, y = clientY - canvasRect.top - this.rect.y;
    if (x < 0 || y < 0 || x > this.rect.w || y > this.rect.h) return null;
    return new THREE.Vector2((x / this.rect.w) * 2 - 1, -(y / this.rect.h) * 2 + 1);
  }
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  canvas: HTMLCanvasElement;
  viewports: Viewport[] = [];
  private lastMinimap = 0;

  constructor(public container: HTMLElement, public world: World) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'game-canvas';
    container.appendChild(this.canvas);
  }

  addViewport(): Viewport {
    const v = new Viewport(this.world, this.viewports.length, this.container);
    this.viewports.push(v);
    return v;
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  render(s: GameState) {
    const r = this.renderer;
    const H = this.container.clientHeight;
    this.world.updateFog(s);
    r.setScissorTest(true);
    r.setClearColor(0x05060a);
    r.clear();
    for (const v of this.viewports) {
      if (!v.visible || v.rect.w < 2) continue;
      const { x, y, w, h } = v.rect;
      r.setViewport(x, H - y - h, w, h);
      r.setScissor(x, H - y - h, w, h);
      v.updateCamera();
      this.world.focusShadow(v.target.x, v.target.y);
      this.world.prepareView(s, v.persp, v.camera);
      r.render(this.world.scene, v.camera);
    }
    r.setScissorTest(false);
    const now = performance.now();
    if (now - this.lastMinimap > 200) {
      this.lastMinimap = now;
      for (const v of this.viewports) if (v.visible) v.minimap.draw(s);
    }
  }

  dispose() {
    this.renderer.dispose();
    this.canvas.remove();
    for (const v of this.viewports) v.el.remove();
  }
}
