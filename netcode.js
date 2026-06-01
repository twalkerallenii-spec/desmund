// ============================================================================
// PaintBrawl — Client Netcode
// ============================================================================
// The brain of the client. Holds:
//   - the connection
//   - a LOCAL predicted copy of the world stepped with the SAME shared step()
//   - an input ring buffer for reconciliation
//   - interpolation buffers for REMOTE entities
//
// Flow each frame:
//   1. Sample input -> send to server + apply to local prediction immediately.
//   2. When a snapshot arrives -> snap local player to authoritative position,
//      then REPLAY all unacked inputs to catch back up ("reconciliation").
//   3. Remote entities are rendered from interpolation buffer (100ms in past).
// ============================================================================
import {
  DT, TICK_RATE, NET, WORLD_W, WORLD_H,
} from './constants.js';
import { step, makePlayer } from './physics.js';
import { makeInitialState, Msg, encode, decode } from './protocol.js';

export class NetClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.connected = false;
    this.yourId = null;
    this.mapMeta = null;

    // Local predicted world (authoritative-mirror we step ourselves)
    this.state = makeInitialState(1);

    // Input handling
    this.inputSeq = 0;
    this.pendingInputs = [];   // unacked inputs for reconciliation
    this.currentInput = this.blankInput();

    // Interpolation buffers: id -> [{t, x, y, ...}]
    this.remoteBuffer = new Map();
    this.snapshotTimes = [];

    // Events for the UI layer to consume
    this.killFeed = [];        // {text, ts}
    this.onWelcome = null;
    this.localEvents = [];     // VFX events from local prediction (splats etc.)

    // ping
    this.rtt = 0;
    this._pingId = 0;

    // accumulator for fixed-step local prediction
    this._acc = 0;
    this._lastTime = performance.now();
  }

  blankInput() {
    return { left: false, right: false, jump: false, fire: false, bomb: false, switchTo: null, aimX: 0, aimY: 0 };
  }

  connect(name) {
    return new Promise((resolve, reject) => {
      try { this.ws = new WebSocket(this.url); }
      catch (e) { reject(e); return; }

      this.ws.onopen = () => {
        this.connected = true;
        this.ws.send(encode(Msg.join(name)));
        this._startPing();
      };
      this.ws.onmessage = (ev) => this._onMessage(ev.data, resolve);
      this.ws.onclose = () => { this.connected = false; };
      this.ws.onerror = (e) => { if (!this.yourId) reject(e); };

      setTimeout(() => { if (!this.yourId) reject(new Error('Connection timed out')); }, 8000);
    });
  }

  _startPing() {
    this._pingTimer = setInterval(() => {
      if (this.connected) this.ws.send(encode(Msg.ping(++this._pingId)));
    }, 1000);
  }

  _onMessage(raw, resolveConnect) {
    const m = decode(raw);
    if (!m) return;
    switch (m.t) {
      case 'welcome': {
        this.yourId = m.yourId;
        this.mapMeta = m.map;
        this._ingestSnapshot(m.snapshot, true);
        if (this.onWelcome) this.onWelcome(m);
        if (resolveConnect) resolveConnect(m);
        break;
      }
      case 'snapshot': this.matchTimer = m.s.matchTimer; this._ingestSnapshot(m.s, false); break;
      case 'kill': this._onKill(m); break;
      case 'pjoin': this._pushFeed(`${m.name} joined`); break;
      case 'pleave': {
        const p = this.state.players[m.id];
        if (p) this._pushFeed(`${p.name} left`);
        delete this.state.players[m.id];
        this.remoteBuffer.delete(m.id);
        break;
      }
      case 'pong': this.rtt = Date.now() - m.ts; break;
      case 'matchreset': this._pushFeed('— New match —'); break;
      case 'full': this._pushFeed('Server full'); break;
    }
  }

  _onKill(m) {
    const an = m.an || 'someone', vn = m.vn || 'someone';
    if (m.cause === 'bomb') this._pushFeed(`${an} 💣 ${vn}`);
    else this._pushFeed(`${an} painted ${vn}`);
  }

  _pushFeed(text) {
    this.killFeed.push({ text, ts: performance.now() });
    if (this.killFeed.length > 6) this.killFeed.shift();
  }

  // --- Ingest an authoritative snapshot ---
  _ingestSnapshot(snap, isInitial) {
    const now = performance.now();

    // Update/insert all players into our local state and interp buffers.
    for (const id in snap.players) {
      const sp = snap.players[id];
      if (!this.state.players[id]) {
        this.state.players[id] = makePlayer(id, sp.n, { x: sp.x, y: sp.y }, !!sp.b);
      }
      const p = this.state.players[id];
      // keep authoritative cosmetic/score fields always
      p.name = sp.n; p.isBot = !!sp.b; p.hp = sp.hp; p.alive = !!sp.al;
      p.score = sc(sp.sc); p.weapon = sp.w; p.respawnTimer = sp.rt;
      p.facing = sp.f; p.aimAngle = sp.a; p.grounded = !!sp.g;

      if (id === this.yourId) {
        // RECONCILIATION: snap to authoritative, replay unacked inputs.
        p.x = sp.x; p.y = sp.y; p.vx = sp.vx; p.vy = sp.vy;
        // drop inputs the server has already processed
        this.pendingInputs = this.pendingInputs.filter(i => i.seq > sp.seq);
        // replay remaining
        for (const inp of this.pendingInputs) {
          step(this.state, { [this.yourId]: inp });
        }
      } else {
        // REMOTE: push into interpolation buffer
        let buf = this.remoteBuffer.get(id);
        if (!buf) { buf = []; this.remoteBuffer.set(id, buf); }
        buf.push({ t: now, x: sp.x, y: sp.y, vx: sp.vx, vy: sp.vy, f: sp.f, a: sp.a, hp: sp.hp, al: !!sp.al, w: sp.w, g: !!sp.g });
        if (buf.length > 30) buf.shift();
      }
    }

    // Remove players no longer present
    for (const id in this.state.players) {
      if (!snap.players[id]) { delete this.state.players[id]; this.remoteBuffer.delete(id); }
    }

    // Authoritative projectiles/bombs/pickups (rendered directly, short-lived)
    this.state.projectiles = (snap.projectiles || []).map(p => ({ ...p, profile: p.w }));
    this.state.bombs = snap.bombs || [];
    if (snap.pickups) {
      this.state.pickups = snap.pickups.map(pk => ({ i: pk.i, x: pk.x, y: pk.y, weapon: pk.w, active: !!pk.act }));
    }
  }

  // --- Called every render frame with the freshly sampled input ---
  setInput(input) { this.currentInput = input; }

  // Fixed-step local prediction for the LOCAL player only.
  // Remote entities are NOT stepped here (they interpolate).
  update() {
    if (!this.yourId || !this.state.players[this.yourId]) return;
    const now = performance.now();
    this._acc += now - this._lastTime;
    this._lastTime = now;
    const stepMs = 1000 / TICK_RATE;
    let guard = 0;
    while (this._acc >= stepMs && guard < 5) {
      this._tickLocal();
      this._acc -= stepMs;
      guard++;
    }
    if (this._acc > stepMs * 5) this._acc = 0;
  }

  _tickLocal() {
    this.inputSeq++;
    const cmd = { seq: this.inputSeq, ...this.currentInput };
    // Send to server
    if (this.connected) this.ws.send(encode(Msg.input(cmd)));
    // Record for reconciliation
    this.pendingInputs.push(cmd);
    if (this.pendingInputs.length > NET.inputBufferSize) this.pendingInputs.shift();
    // Predict locally: step ONLY the local player. We freeze remotes by feeding
    // them no input and skipping their integration would desync — instead we
    // step the whole sim but remotes get their last-known input (cheap & close);
    // remote *rendering* uses interpolation buffer, so prediction error on them
    // is invisible.
    const inputs = {};
    inputs[this.yourId] = cmd;
    const evs = step(this.state, inputs);
    for (const e of evs) if (e.t === 'splat' || e.t === 'detonate') this.localEvents.push({ ...e, ts: performance.now() });
  }

  // Interpolated render position for a remote entity (100ms in the past).
  getRenderEntity(id) {
    if (id === this.yourId) return this.state.players[id];
    const buf = this.remoteBuffer.get(id);
    const base = this.state.players[id];
    if (!buf || buf.length === 0) return base;
    const renderTime = performance.now() - NET.interpDelayMs;
    // find two samples surrounding renderTime
    let a = buf[0], b = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderTime && buf[i + 1].t >= renderTime) { a = buf[i]; b = buf[i + 1]; break; }
    }
    const span = (b.t - a.t) || 1;
    let f = (renderTime - a.t) / span;
    f = Math.max(0, Math.min(1, f));
    return {
      ...base,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      facing: b.f, aimAngle: b.a, hp: b.hp, alive: b.al, weapon: b.w, grounded: b.g,
    };
  }

  // leaderboard array, sorted desc by score, scales with entity count
  getLeaderboard() {
    const arr = Object.values(this.state.players).map(p => ({
      id: p.id, name: p.name, score: p.score, isBot: p.isBot, you: p.id === this.yourId, alive: p.alive,
    }));
    arr.sort((x, y) => y.score - x.score || x.name.localeCompare(y.name));
    return arr;
  }

  drainLocalEvents() { const e = this.localEvents; this.localEvents = []; return e; }
}

function sc(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
