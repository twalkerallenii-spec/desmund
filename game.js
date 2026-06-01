// ============================================================================
// PaintBrawl — Vanilla Canvas Client (no Phaser)
// ============================================================================
// Pure HTML5 canvas renderer. Reads interpolated/predicted state from the
// NetClient and draws it with a requestAnimationFrame loop. No engine, no CDN.
// Physics lives entirely in shared/ — this file only draws + samples input.
// ============================================================================
import {
  TILE, GRID_W, GRID_H, WORLD_W, WORLD_H, TT, WEAPON, MAX_HP, PLAYER_W, PLAYER_H,
  MATCH, TICK_RATE,
} from './constants.js';
import { NetClient } from './netcode.js';

const PALETTE = {
  sky: '#1a1f3a',
  solidFill: ['#ffd23f', '#4ea3ff', '#f7f7f7'],
  solidEdge: '#0a0e27',
  ice: 'rgba(127,212,255,0.42)',
  bounce: '#ffe14d',
  flag: '#ff5470',
  you: '#46e5b7',
  bot: '#ff6b9d',
  enemy: '#ffa94d',
};

export class Game {
  constructor(net, canvas) {
    this.net = net;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    // Persistent paint-splat layer (offscreen canvas stamped over time)
    this.splatLayer = document.createElement('canvas');
    this.splatLayer.width = WORLD_W; this.splatLayer.height = WORLD_H;
    this.splatCtx = this.splatLayer.getContext('2d');

    // Pre-rendered static tile layer
    this.tileLayer = document.createElement('canvas');
    this.tileLayer.width = WORLD_W; this.tileLayer.height = WORLD_H;
    this.drawTiles();

    this.trails = [];
    this.shake = 0;
    this.input = this.blank();
    this._switch = null;
    this.pointer = { x: WORLD_W / 2, y: WORLD_H / 2 };
    this.pointerDown = false;
    this.audioOn = true;

    this.setupInput();
    this._raf = null;
    this._lastFeedRender = 0;
  }

  blank() { return { left: false, right: false, jump: false, fire: false, bomb: false, switchTo: null, aimX: 0, aimY: 0 }; }

  // ---- Static tiles ----
  drawTiles() {
    const g = this.tileLayer.getContext('2d');
    const map = this.net.mapMeta.map;
    g.clearRect(0, 0, WORLD_W, WORLD_H);
    for (let ty = 0; ty < GRID_H; ty++) {
      for (let tx = 0; tx < GRID_W; tx++) {
        const t = map[ty * GRID_W + tx];
        const x = tx * TILE, y = ty * TILE;
        if (t === TT.SOLID) {
          g.fillStyle = PALETTE.solidFill[(tx + ty) % 3];
          g.fillRect(x, y, TILE, TILE);
          g.strokeStyle = PALETTE.solidEdge; g.lineWidth = 2;
          g.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
          g.fillStyle = 'rgba(255,255,255,0.18)';
          g.beginPath();
          g.moveTo(x + TILE / 2, y + 6); g.lineTo(x + TILE - 6, y + TILE / 2);
          g.lineTo(x + TILE / 2, y + TILE - 6); g.lineTo(x + 6, y + TILE / 2);
          g.closePath(); g.fill();
        } else if (t === TT.ICE) {
          g.fillStyle = PALETTE.ice; g.fillRect(x, y, TILE, TILE);
          g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 2;
          g.strokeRect(x + 2, y + 2, TILE - 4, TILE - 4);
        } else if (t === TT.BOUNCE) {
          g.fillStyle = PALETTE.bounce;
          roundRect(g, x + 2, y + TILE * 0.35, TILE - 4, TILE * 0.3, 8); g.fill();
          g.strokeStyle = '#8a6d00'; g.lineWidth = 2; g.stroke();
        } else if (t === TT.FLAG) {
          g.strokeStyle = '#cccccc'; g.lineWidth = 3;
          g.beginPath(); g.moveTo(x + 6, y + 4); g.lineTo(x + 6, y + TILE - 2); g.stroke();
          g.fillStyle = PALETTE.flag;
          g.beginPath(); g.moveTo(x + 6, y + 5); g.lineTo(x + TILE - 4, y + 9); g.lineTo(x + 6, y + 15); g.closePath(); g.fill();
        }
      }
    }
  }

  // ---- Input ----
  setupInput() {
    this.held = {};
    window.addEventListener('keydown', (e) => {
      this.held[e.code] = true;
      if (e.code === 'Digit1') this._switch = WEAPON.BLASTER;
      if (e.code === 'Digit2') this._switch = WEAPON.SNIPER;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.held[e.code] = false; });

    const rect = () => this.canvas.getBoundingClientRect();
    this.canvas.addEventListener('mousemove', (e) => {
      const r = rect();
      this.pointer.x = (e.clientX - r.left) * (WORLD_W / r.width);
      this.pointer.y = (e.clientY - r.top) * (WORLD_H / r.height);
    });
    this.canvas.addEventListener('mousedown', () => { this.pointerDown = true; });
    window.addEventListener('mouseup', () => { this.pointerDown = false; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  sampleInput() {
    const h = this.held;
    const inp = {
      left: h['KeyA'] || h['ArrowLeft'] || false,
      right: h['KeyD'] || h['ArrowRight'] || false,
      jump: h['KeyW'] || h['ArrowUp'] || h['Space'] || false,
      bomb: h['KeyS'] || h['ArrowDown'] || false,
      fire: this.pointerDown,
      switchTo: this._switch,
      aimX: this.pointer.x,
      aimY: this.pointer.y,
    };
    this._switch = null;
    return inp;
  }

  start() {
    const loop = (t) => {
      this.frame(t);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); }

  // ---- Per-frame ----
  frame(time) {
    if (!this.net.yourId) return;
    this.net.setInput(this.sampleInput());
    this.net.update();

    for (const e of this.net.drainLocalEvents()) {
      if (e.t === 'splat') this.stampSplat(e.x, e.y, this.colorFor(e.owner));
      if (e.t === 'detonate') this.bigSplat(e.x, e.y, e.r, this.colorFor(e.owner));
    }

    const ctx = this.ctx;
    ctx.save();
    if (this.shake > 0) {
      ctx.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
      this.shake *= 0.85; if (this.shake < 0.3) this.shake = 0;
    }

    ctx.fillStyle = PALETTE.sky;
    ctx.fillRect(-20, -20, WORLD_W + 40, WORLD_H + 40);
    ctx.drawImage(this.tileLayer, 0, 0);
    ctx.drawImage(this.splatLayer, 0, 0);

    this.drawProjectiles(ctx);
    this.drawBombs(ctx);
    this.drawPickups(ctx, time);

    for (const id of Object.keys(this.net.state.players)) {
      const e = this.net.getRenderEntity(id);
      if (!e) continue;
      if (!e.alive) this.drawGhost(ctx, e); else this.drawPlayer(ctx, e, id);
    }

    const you = this.net.state.players[this.net.yourId];
    if (you && !you.alive) this.drawSkull(ctx);

    ctx.restore();
    this.updateHUD();
  }

  colorFor(id) {
    if (id === this.net.yourId) return PALETTE.you;
    const p = this.net.state.players[id];
    return (p && p.isBot) ? PALETTE.bot : PALETTE.enemy;
  }

  // ---- Players ----
  drawPlayer(ctx, e, id) {
    const color = this.colorFor(id);
    const x = e.x, w = PLAYER_W, h = PLAYER_H;
    const left = x - w / 2, top = e.y - h;

    roundRect(ctx, left, top, w, h, 6);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#0a0e27'; ctx.lineWidth = 2; ctx.stroke();

    // sunglasses
    ctx.fillStyle = '#0a0e27';
    roundRect(ctx, left + 3, top + 6, w - 6, 6, 2); ctx.fill();
    // headphones band
    ctx.strokeStyle = '#0a0e27'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, top + 4, w / 2 - 1, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#0a0e27';
    roundRect(ctx, left - 2, top + 2, 4, 10, 2); ctx.fill();
    roundRect(ctx, left + w - 2, top + 2, 4, 10, 2); ctx.fill();
    // smile
    ctx.strokeStyle = '#0a0e27'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, top + 16, 4, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();

    // weapon barrel
    const a = e.aimAngle || 0;
    const len = e.weapon === WEAPON.SNIPER ? 26 : 16;
    const bx = x + Math.cos(a) * 6, by = top + h * 0.45 + Math.sin(a) * 6;
    ctx.strokeStyle = '#2a2a3a'; ctx.lineWidth = e.weapon === WEAPON.SNIPER ? 5 : 4;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a) * len, by + Math.sin(a) * len); ctx.stroke();
    ctx.fillStyle = e.weapon === WEAPON.SNIPER ? '#ff5470' : '#2a2a3a';
    ctx.beginPath(); ctx.arc(bx + Math.cos(a) * len, by + Math.sin(a) * len, 3, 0, 7); ctx.fill();

    // tag
    ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    const tag = id === this.net.yourId ? '▼ YOU' : e.name;
    ctx.lineWidth = 3; ctx.strokeStyle = '#0a0e27'; ctx.strokeText(tag, x, top - 16);
    ctx.fillStyle = '#fff'; ctx.fillText(tag, x, top - 16);

    // health bar
    const bw = 30, bh = 4, hx = x - bw / 2, hy = top - 12;
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(hx - 1, hy - 1, bw + 2, bh + 2);
    ctx.fillStyle = '#222244'; ctx.fillRect(hx, hy, bw, bh);
    const frac = Math.max(0, e.hp / MAX_HP);
    ctx.fillStyle = frac > 0.5 ? '#46e5b7' : frac > 0.25 ? '#ffd23f' : '#ff5470';
    ctx.fillRect(hx, hy, bw * frac, bh);
  }

  drawGhost(ctx, e) {
    const x = e.x, y = e.y - PLAYER_H / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(ctx, x - 12, y - 14, 24, 22, 10); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 12, y + 8); ctx.lineTo(x - 6, y + 14); ctx.lineTo(x, y + 8);
    ctx.lineTo(x + 6, y + 14); ctx.lineTo(x + 12, y + 8); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(34,34,68,0.7)';
    ctx.beginPath(); ctx.arc(x - 4, y - 4, 2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x + 4, y - 4, 2, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(34,34,68,0.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y + 4, 3, 1.15 * Math.PI, 1.85 * Math.PI); ctx.stroke();
  }

  // ---- Projectiles / bombs / pickups ----
  drawProjectiles(ctx) {
    for (const p of this.net.state.projectiles) {
      const col = this.colorFor(p.o);
      this.trails.push({ x: p.x, y: p.y, r: p.r, life: 14, max: 14, color: col });
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, p.r + 1, 0, 7); ctx.fill();
    }
    for (const t of this.trails) {
      const alpha = t.life / t.max;
      ctx.globalAlpha = alpha * 0.5; ctx.fillStyle = t.color;
      ctx.beginPath(); ctx.arc(t.x, t.y, t.r * alpha, 0, 7); ctx.fill();
      t.life--;
    }
    ctx.globalAlpha = 1;
    this.trails = this.trails.filter(t => t.life > 0);
  }

  drawBombs(ctx) {
    for (const b of this.net.state.bombs) {
      const col = this.colorFor(b.o);
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      this.trails.push({ x: b.x, y: b.y, r: 5, life: 8, max: 8, color: col });
      const pulse = 2 + Math.sin(performance.now() / 80) * 1.5;
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(b.x, b.y - b.r - 2, pulse, 0, 7); ctx.fill();
    }
  }

  drawPickups(ctx, time) {
    for (const pk of (this.net.state.pickups || [])) {
      if (!pk.active) continue;
      const y = pk.y + Math.sin(time / 300 + pk.x) * 4;
      ctx.fillStyle = 'rgba(70,229,183,0.15)'; ctx.beginPath(); ctx.arc(pk.x, y, 18, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(70,229,183,0.6)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(pk.x, y, 16, 0, 7); ctx.stroke();
      ctx.fillStyle = '#ff5470'; ctx.fillRect(pk.x - 9, y - 2, 18, 4);
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(pk.x + 9, y, 2, 0, 7); ctx.fill();
    }
  }

  // ---- Splats ----
  stampSplat(x, y, color) {
    const g = this.splatCtx;
    g.globalAlpha = 0.8; g.fillStyle = color;
    const r = 10 + Math.random() * 6;
    g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * 7, d = r * (0.6 + Math.random());
      g.beginPath(); g.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, r * 0.4 * Math.random() + 2, 0, 7); g.fill();
    }
    g.globalAlpha = 1;
  }
  bigSplat(x, y, r, color) {
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * 7, d = Math.random() * r;
      this.stampSplat(x + Math.cos(a) * d, y + Math.sin(a) * d, color);
    }
    this.shake = Math.max(this.shake, 10);
  }

  drawSkull(ctx) {
    const cx = WORLD_W / 2, cy = WORLD_H / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.beginPath(); ctx.arc(cx, cy - 20, 46, 0, 7); ctx.fill();
    ctx.fillRect(cx - 30, cy + 10, 60, 30);
    ctx.fillStyle = '#0a0e27';
    ctx.beginPath(); ctx.arc(cx - 18, cy - 22, 12, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 18, cy - 22, 12, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx - 6, cy + 6); ctx.lineTo(cx + 6, cy + 6); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (let i = -2; i <= 2; i++) ctx.fillRect(cx + i * 11 - 4, cy + 12, 8, 22);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - 60, cy + 50); ctx.lineTo(cx + 60, cy + 70); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx + 60, cy + 50); ctx.lineTo(cx - 60, cy + 70); ctx.stroke();
    ctx.lineCap = 'butt';
  }

  // ---- HTML HUD ----
  updateHUD() {
    // timer
    const secs = Math.max(0, Math.ceil((this.net.matchTimer ?? MATCH.durationTicks) / TICK_RATE));
    const el = document.getElementById('timer');
    if (el) el.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;

    // leaderboard
    const lb = this.net.getLeaderboard();
    const tbody = document.getElementById('lb-body');
    if (tbody) {
      tbody.innerHTML = lb.map((r, i) =>
        `<tr class="${r.you ? 'you' : ''}"><td>${i + 1}</td><td>${escapeHtml(r.name)}${r.you ? ' ●' : ''}</td><td>${r.score}</td></tr>`
      ).join('');
    }

    // kill feed
    const feed = document.getElementById('killfeed');
    if (feed) {
      const now = performance.now();
      feed.innerHTML = this.net.killFeed
        .filter(k => now - k.ts < 5000)
        .map(k => `<div class="feed-item" style="opacity:${Math.max(0.2, 1 - (now - k.ts) / 5000)}">${escapeHtml(k.text)}</div>`)
        .join('');
    }

    // ping
    const ping = document.getElementById('ping');
    if (ping) ping.textContent = `${this.net.rtt}ms`;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
