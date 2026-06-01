// ============================================================================
// PaintBrawl — Shared Constants
// Single source of truth. Imported by BOTH server (authoritative sim) and
// client (prediction + rendering). Never fork these values per-side.
// ============================================================================

// ---- Timing -----------------------------------------------------------------
// The SIMULATION runs at a fixed timestep. Both server and client step the
// world in these exact quanta so client prediction can replay deterministically.
export const TICK_RATE = 60;                 // simulation steps per second
export const DT = 1 / TICK_RATE;             // fixed delta, seconds. NEVER use wall-clock.
export const MS_PER_TICK = 1000 / TICK_RATE; // ~16.667ms

// The server BROADCASTS snapshots slower than it simulates, to save bandwidth.
// Clients interpolate remote entities between snapshots.
export const SNAPSHOT_RATE = 20;             // snapshots per second
export const TICKS_PER_SNAPSHOT = TICK_RATE / SNAPSHOT_RATE; // = 3

// ---- World / Grid -----------------------------------------------------------
export const TILE = 32;                       // px per tile (square)
export const GRID_W = 30;                      // tiles wide  -> 960 px
export const GRID_H = 17;                      // tiles tall  -> 544 px
export const WORLD_W = TILE * GRID_W;          // 960
export const WORLD_H = TILE * GRID_H;          // 544

// Tile type codes (used in the level map array)
export const TT = {
  EMPTY: 0,
  SOLID: 1,   // standard solid block (cartoon diamond styling, client-side)
  ICE: 2,     // translucent breakable barrier (still solid for collision in v1)
  BOUNCE: 3,  // yellow capsule bounce pad / platform
  FLAG: 4,    // decorative only, NON-solid
};

export const SOLID_TILES = new Set([TT.SOLID, TT.ICE, TT.BOUNCE]);

// ---- Player physics ---------------------------------------------------------
export const PLAYER_W = 24;
export const PLAYER_H = 28;
export const GRAVITY = 1800;        // px/s^2
export const MOVE_SPEED = 230;      // px/s horizontal target
export const MOVE_ACCEL = 3200;     // px/s^2 toward target (snappy)
export const MOVE_FRICTION = 2600;  // px/s^2 decel when no input / grounded
export const AIR_CONTROL = 0.55;    // multiplier on accel while airborne
export const JUMP_VELOCITY = -560;  // instant jump impulse (px/s)
export const MAX_FALL = 1200;       // terminal velocity
export const COYOTE_TICKS = 6;      // ticks after leaving ground you can still jump
export const JUMP_BUFFER_TICKS = 6; // ticks a jump press is remembered before landing
export const BOUNCE_VELOCITY = -780;// launch velocity off a bounce pad

export const MAX_HP = 100;
export const RESPAWN_TICKS = TICK_RATE * 2; // 2s as a ghost before respawn

// ---- Weapons ----------------------------------------------------------------
// Each weapon is a profile. Player starts with BLASTER. Pickups switch profile.
export const WEAPON = {
  BLASTER: 'blaster',
  SNIPER: 'sniper',
  BOMB: 'bomb', // not a held weapon; thrown via the down/secondary action
};

export const WEAPON_PROFILES = {
  [WEAPON.BLASTER]: {
    name: 'Blaster',
    cooldownTicks: 8,        // ~7.5 shots/sec
    projectileSpeed: 720,    // px/s
    projectileRadius: 5,
    damage: 12,
    gravityScale: 0.35,      // arc: fraction of GRAVITY applied to projectile
    recoil: 70,              // px/s knockback to shooter
    lifeTicks: TICK_RATE * 2,
    spread: 0.02,            // radians
  },
  [WEAPON.SNIPER]: {
    name: 'Sniper',
    cooldownTicks: 42,       // slow
    projectileSpeed: 1400,
    projectileRadius: 4,
    damage: 55,
    gravityScale: 0.05,      // nearly flat
    recoil: 260,             // high-recoil
    lifeTicks: TICK_RATE * 2,
    spread: 0.0,
  },
};

// Splat bomb (thrown projectile -> bounces -> AOE detonation)
export const BOMB = {
  cooldownTicks: TICK_RATE * 3, // 3s between bombs
  speed: 520,                   // initial throw speed
  radius: 7,                    // projectile body radius
  gravityScale: 1.0,            // full gravity, it arcs and falls
  restitution: 0.5,             // bounciness on tile hit
  maxBounces: 3,
  fuseTicks: TICK_RATE * 2,     // detonates after this if it hasn't already
  detonateOnBounceLimit: true,
  aoeRadius: 90,                // px blast radius
  aoeMaxDamage: 70,             // at center, falls off linearly to edge
  selfDamageScale: 0.5,         // you take half from your own bomb
};

// ---- Weapon pickups ---------------------------------------------------------
export const PICKUP = {
  respawnTicks: TICK_RATE * 10, // a collected pickup pad refills after 10s
  radius: 16,                    // overlap radius (circle) with player center
};

// ---- Match / scoring --------------------------------------------------------
export const MATCH = {
  durationTicks: TICK_RATE * 60 * 5, // 5 minute deathmatch
  killScore: 1,
  botCount: 5,                        // bots filling the arena (server spawns)
  maxEntities: 16,                    // hard cap (humans + bots)
};

// ---- Netcode ----------------------------------------------------------------
export const NET = {
  // client keeps a ring buffer of unacked inputs for reconciliation
  inputBufferSize: 256,
  // server lag-compensation rewind history (in snapshots)
  lagCompHistory: 12,            // ~600ms at 20Hz
  // how hard to smooth a reconciliation correction visually (0..1 per frame)
  reconcileSmoothing: 0.25,
  // entity interpolation delay: render remote entities this far in the past
  interpDelayMs: 100,            // ~2 snapshots
  maxExtrapolateMs: 120,
};

// ---- Message types (see protocol.js for shapes) -----------------------------
export const MSG = {
  // client -> server
  JOIN: 'join',
  INPUT: 'input',
  PING: 'ping',
  // server -> client
  WELCOME: 'welcome',     // assigns your id, sends static level + initial state
  SNAPSHOT: 'snapshot',   // periodic authoritative world state
  KILL: 'kill',           // a kill event (for kill feed)
  PLAYER_JOIN: 'pjoin',
  PLAYER_LEAVE: 'pleave',
  PONG: 'pong',
};
