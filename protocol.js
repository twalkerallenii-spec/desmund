// ============================================================================
// PaintBrawl — Shared Protocol & State Init
// JSON-over-WebSocket message shapes, plus the canonical world-state factory
// used by both server and client (client builds a local mirror to predict on).
// ============================================================================
import { MSG, WEAPON, PICKUP, WORLD_W, WORLD_H, TILE } from './constants.js';
import { LEVEL, computeSpawnPoints } from './level.js';

// ---- Message builders (client -> server) ------------------------------------
export const Msg = {
  join: (name) => ({ t: MSG.JOIN, name }),
  // One input command. `seq` is a monotonically increasing client sequence
  // number the server echoes back so the client knows what's been processed.
  input: (cmd) => ({ t: MSG.INPUT, ...cmd }),
  ping: (id) => ({ t: MSG.PING, id, ts: Date.now() }),

  // server -> client
  welcome: (yourId, snapshot, mapMeta) => ({ t: MSG.WELCOME, yourId, snapshot, map: mapMeta }),
  snapshot: (snap, serverTick) => ({ t: MSG.SNAPSHOT, s: snap, st: serverTick }),
  kill: (ev) => ({ t: MSG.KILL, ...ev }),
  pjoin: (id, name, isBot) => ({ t: MSG.PLAYER_JOIN, id, name, isBot }),
  pleave: (id) => ({ t: MSG.PLAYER_LEAVE, id }),
  pong: (id, ts) => ({ t: MSG.PONG, id, ts }),
};

export function encode(obj) { return JSON.stringify(obj); }
export function decode(str) {
  try { return JSON.parse(str); } catch { return null; }
}

// ---- Input command normalizer ----------------------------------------------
// Guards against malformed/cheating input from clients. Server runs every
// incoming input through this before feeding the sim.
export function sanitizeInput(raw) {
  return {
    seq: (raw.seq | 0),
    left: !!raw.left,
    right: !!raw.right,
    jump: !!raw.jump,
    fire: !!raw.fire,
    bomb: !!raw.bomb,
    switchTo: (raw.switchTo === WEAPON.SNIPER || raw.switchTo === WEAPON.BLASTER) ? raw.switchTo : null,
    aimX: clampNum(raw.aimX, -2000, WORLD_W + 2000, 0),
    aimY: clampNum(raw.aimY, -2000, WORLD_H + 2000, 0),
  };
}
function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ---- Initial world state ----------------------------------------------------
export function makeInitialState(seed = 12345) {
  const map = LEVEL.map.slice();
  // attach world bounds onto map object reference used by sim
  map._w = WORLD_W; map._h = WORLD_H;
  const spawnPoints = computeSpawnPoints(map);

  // Weapon pickups: place a couple of sniper pads at fixed arena spots.
  const pickups = [
    { i: 0, x: TILE * 15, y: TILE * 5 - 4, weapon: WEAPON.SNIPER, active: true, timer: 0 },
    { i: 1, x: TILE * 4,  y: TILE * 9 - 4, weapon: WEAPON.SNIPER, active: true, timer: 0 },
    { i: 2, x: TILE * 25, y: TILE * 9 - 4, weapon: WEAPON.SNIPER, active: true, timer: 0 },
  ];

  return {
    tick: 0,
    rngSeed: seed >>> 0,
    players: {},
    projectiles: [],
    bombs: [],
    pickups,
    map,
    spawnPoints,
    nextEntityId: 1,
  };
}

export const MapMeta = {
  width: LEVEL.width,
  height: LEVEL.height,
  tile: TILE,
  map: LEVEL.map,
};
