// ============================================================================
// PaintBrawl — Shared Deterministic Simulation
// ============================================================================
// The ONE function that advances the world by exactly one fixed tick (DT).
// Server calls it to be authoritative. Client calls the IDENTICAL function to
// predict the local player and to replay during reconciliation.
//
// Rules that keep it deterministic:
//   - No Date.now(), no Math.random() (seeded RNG passed in via state.rng).
//   - No variable delta — always DT.
//   - Pure-ish: mutates `state` in place but only as a function of (state, inputs).
//   - Same inputs + same starting state => same resulting state on both sides.
//
// `state` shape (see makeInitialState):
//   {
//     tick, rngSeed,
//     players: { [id]: Player },
//     projectiles: [Projectile],
//     bombs: [Bomb],
//     pickups: [Pickup],
//     map,                 // tile array (read-only during step)
//     spawnPoints,         // precomputed
//     nextEntityId,
//   }
//
// `inputsById`: { [playerId]: InputCmd }  for THIS tick.
//   InputCmd = { seq, left, right, jump, fire, bomb, aimX, aimY, switchTo }
//
// Returns an array of `events` produced this tick (kills, splats, detonations,
// pickups) so the caller can build kill feed / VFX / scoring.
// ============================================================================
import {
  DT, GRAVITY, MAX_FALL, MOVE_SPEED, MOVE_ACCEL, MOVE_FRICTION, AIR_CONTROL,
  JUMP_VELOCITY, BOUNCE_VELOCITY, COYOTE_TICKS, JUMP_BUFFER_TICKS,
  PLAYER_W, PLAYER_H, TILE, MAX_HP, RESPAWN_TICKS,
  WEAPON, WEAPON_PROFILES, BOMB, PICKUP, MATCH,
  TT,
} from './constants.js';
import { tileAt, isSolidTile } from './level.js';

// ---- Tiny deterministic RNG (mulberry32) ------------------------------------
// Seeded so server & client agree; advance via state.rngSeed.
export function rngNext(state) {
  let t = (state.rngSeed += 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---- Entity factories -------------------------------------------------------
export function makePlayer(id, name, spawn, isBot = false) {
  return {
    id, name, isBot,
    x: spawn.x, y: spawn.y, vx: 0, vy: 0,
    w: PLAYER_W, h: PLAYER_H,
    grounded: false,
    facing: 1,                 // 1 right, -1 left
    aimAngle: 0,               // radians, weapon barrel direction
    hp: MAX_HP,
    alive: true,
    respawnTimer: 0,
    weapon: WEAPON.BLASTER,
    fireCooldown: 0,
    bombCooldown: 0,
    coyote: 0,
    jumpBuffer: 0,
    score: 0,
    lastInputSeq: 0,
    recoilVx: 0, recoilVy: 0,  // visual/physical knockback accumulator
  };
}

function makeProjectile(state, owner, profileKey, angle) {
  const p = WEAPON_PROFILES[profileKey];
  const spread = (rngNext(state) - 0.5) * 2 * p.spread;
  const a = angle + spread;
  const muzzleX = owner.x + Math.cos(a) * (owner.w * 0.6);
  const muzzleY = owner.y + Math.sin(a) * (owner.h * 0.3) - owner.h * 0.2;
  return {
    id: state.nextEntityId++,
    kind: 'proj',
    owner: owner.id,
    profile: profileKey,
    x: muzzleX, y: muzzleY,
    vx: Math.cos(a) * p.projectileSpeed,
    vy: Math.sin(a) * p.projectileSpeed,
    r: p.projectileRadius,
    gravityScale: p.gravityScale,
    damage: p.damage,
    life: p.lifeTicks,
    dead: false,
  };
}

function makeBomb(state, owner, angle) {
  const muzzleX = owner.x + Math.cos(angle) * (owner.w * 0.6);
  const muzzleY = owner.y - owner.h * 0.2;
  return {
    id: state.nextEntityId++,
    kind: 'bomb',
    owner: owner.id,
    x: muzzleX, y: muzzleY,
    vx: Math.cos(angle) * BOMB.speed,
    vy: Math.sin(angle) * BOMB.speed - 120, // slight upward toss
    r: BOMB.radius,
    bounces: 0,
    fuse: BOMB.fuseTicks,
    dead: false,
  };
}

// ---- AABB tile collision ----------------------------------------------------
// Sweeps an axis at a time so we know which side we hit (for grounded/bounce).
function collideAxis(map, ent, dx, dy) {
  // Move along one axis, resolve against solid tiles. Returns collision info.
  let hit = { x: false, y: false, bounce: false, groundedBelow: false };

  if (dx !== 0) {
    ent.x += dx;
    const left = ent.x - ent.w / 2, right = ent.x + ent.w / 2;
    const top = ent.y - ent.h, bottom = ent.y - 1;
    const probeX = dx > 0 ? right : left;
    const tx = Math.floor(probeX / TILE);
    for (let py = top; py <= bottom; py += TILE / 2) {
      const ty = Math.floor(py / TILE);
      if (isSolidTile(tileAt(map, tx, ty))) {
        if (dx > 0) ent.x = tx * TILE - ent.w / 2 - 0.01;
        else        ent.x = (tx + 1) * TILE + ent.w / 2 + 0.01;
        ent.vx = 0; hit.x = true; break;
      }
    }
  }

  if (dy !== 0) {
    ent.y += dy;
    const left = ent.x - ent.w / 2 + 1, right = ent.x + ent.w / 2 - 1;
    const top = ent.y - ent.h, bottom = ent.y;
    const probeY = dy > 0 ? bottom : top;
    const ty = Math.floor(probeY / TILE);
    for (let px = left; px <= right; px += TILE / 2) {
      const tx = Math.floor(px / TILE);
      const t = tileAt(map, tx, ty);
      if (isSolidTile(t)) {
        if (dy > 0) { // moving down -> landed on top of tile
          ent.y = ty * TILE - 0.01;
          hit.y = true; hit.groundedBelow = true;
          if (t === TT.BOUNCE) hit.bounce = true;
        } else {      // moving up -> bonked head
          ent.y = (ty + 1) * TILE + ent.h + 0.01;
          hit.y = true;
        }
        ent.vy = 0;
        break;
      }
    }
  }
  return hit;
}

// ---- Player update ----------------------------------------------------------
function stepPlayer(state, pl, input, events) {
  if (!pl.alive) {
    pl.respawnTimer--;
    if (pl.respawnTimer <= 0) respawn(state, pl);
    return;
  }

  const inp = input || { left: false, right: false, jump: false, fire: false, bomb: false, aimX: pl.x + pl.facing, aimY: pl.y };
  pl.lastInputSeq = input ? input.seq : pl.lastInputSeq;

  // Aim angle toward cursor/target
  const adx = inp.aimX - pl.x;
  const ady = inp.aimY - (pl.y - pl.h * 0.5);
  pl.aimAngle = Math.atan2(ady, adx);
  pl.facing = adx >= 0 ? 1 : -1;

  // Horizontal: accelerate toward target speed (snappy), friction otherwise.
  const wantDir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
  const accel = (pl.grounded ? MOVE_ACCEL : MOVE_ACCEL * AIR_CONTROL);
  if (wantDir !== 0) {
    const target = wantDir * MOVE_SPEED;
    if (pl.vx < target) pl.vx = Math.min(target, pl.vx + accel * DT);
    else if (pl.vx > target) pl.vx = Math.max(target, pl.vx - accel * DT);
  } else if (pl.grounded) {
    if (pl.vx > 0) pl.vx = Math.max(0, pl.vx - MOVE_FRICTION * DT);
    else if (pl.vx < 0) pl.vx = Math.min(0, pl.vx + MOVE_FRICTION * DT);
  }

  // Apply + decay knockback
  pl.vx += pl.recoilVx; pl.vy += pl.recoilVy;
  pl.recoilVx *= 0.0; pl.recoilVy *= 0.0; // applied once

  // Jump with coyote time + input buffering
  if (inp.jump) pl.jumpBuffer = JUMP_BUFFER_TICKS; else if (pl.jumpBuffer > 0) pl.jumpBuffer--;
  if (pl.grounded) pl.coyote = COYOTE_TICKS; else if (pl.coyote > 0) pl.coyote--;
  if (pl.jumpBuffer > 0 && pl.coyote > 0) {
    pl.vy = JUMP_VELOCITY; pl.grounded = false; pl.coyote = 0; pl.jumpBuffer = 0;
  }

  // Gravity
  pl.vy = Math.min(MAX_FALL, pl.vy + GRAVITY * DT);

  // Integrate with collision
  pl.grounded = false;
  collideAxis(state.map, pl, pl.vx * DT, 0);
  const v = collideAxis(state.map, pl, 0, pl.vy * DT);
  if (v.groundedBelow) {
    if (v.bounce) { pl.vy = BOUNCE_VELOCITY; pl.grounded = false; }
    else pl.grounded = true;
  }

  // Cooldowns
  if (pl.fireCooldown > 0) pl.fireCooldown--;
  if (pl.bombCooldown > 0) pl.bombCooldown--;

  // Weapon switch (from pickup logic sets pl.weapon; switchTo allows manual)
  if (inp.switchTo && WEAPON_PROFILES[inp.switchTo]) pl.weapon = inp.switchTo;

  // Fire primary
  if (inp.fire && pl.fireCooldown <= 0) {
    const prof = WEAPON_PROFILES[pl.weapon] || WEAPON_PROFILES[WEAPON.BLASTER];
    state.projectiles.push(makeProjectile(state, pl, pl.weapon, pl.aimAngle));
    pl.fireCooldown = prof.cooldownTicks;
    // recoil opposite the aim
    pl.recoilVx = -Math.cos(pl.aimAngle) * prof.recoil;
    pl.recoilVy = -Math.sin(pl.aimAngle) * prof.recoil * 0.5;
    events.push({ t: 'fire', owner: pl.id, weapon: pl.weapon, x: pl.x, y: pl.y, angle: pl.aimAngle });
  }

  // Throw bomb
  if (inp.bomb && pl.bombCooldown <= 0) {
    state.bombs.push(makeBomb(state, pl, pl.aimAngle));
    pl.bombCooldown = BOMB.cooldownTicks;
    events.push({ t: 'bombthrow', owner: pl.id, x: pl.x, y: pl.y });
  }
}

function respawn(state, pl) {
  const pts = state.spawnPoints;
  // Pick a spawn far from other living players (deterministic via seeded rng).
  let best = pts[Math.floor(rngNext(state) * pts.length)] || { x: TILE * 2, y: TILE * 2 };
  let bestScore = -1;
  for (let i = 0; i < 6; i++) {
    const cand = pts[Math.floor(rngNext(state) * pts.length)];
    if (!cand) continue;
    let minD = Infinity;
    for (const id in state.players) {
      const o = state.players[id];
      if (!o.alive || o.id === pl.id) continue;
      const d = (o.x - cand.x) ** 2 + (o.y - cand.y) ** 2;
      if (d < minD) minD = d;
    }
    if (minD > bestScore) { bestScore = minD; best = cand; }
  }
  pl.x = best.x; pl.y = best.y; pl.vx = 0; pl.vy = 0;
  pl.hp = MAX_HP; pl.alive = true; pl.respawnTimer = 0;
  pl.weapon = WEAPON.BLASTER; pl.fireCooldown = 0; pl.bombCooldown = 0;
}

export function respawnAll(state) {
  for (const id in state.players) respawn(state, state.players[id]);
}

function applyDamage(state, victim, amount, attackerId, cause, events) {
  if (!victim.alive) return;
  victim.hp -= amount;
  if (victim.hp <= 0) {
    victim.hp = 0; victim.alive = false; victim.respawnTimer = RESPAWN_TICKS;
    const attacker = state.players[attackerId];
    if (attacker && attackerId !== victim.id) {
      attacker.score += MATCH.killScore;
    }
    events.push({
      t: 'kill', victim: victim.id, attacker: attackerId,
      cause, x: victim.x, y: victim.y,
    });
  }
}

// ---- Projectile update ------------------------------------------------------
function circleHitsTile(map, x, y, r) {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  return isSolidTile(tileAt(map, tx, ty));
}

function projHitsPlayer(proj, pl) {
  if (!pl.alive || pl.id === proj.owner) return false;
  const cx = Math.max(pl.x - pl.w / 2, Math.min(proj.x, pl.x + pl.w / 2));
  const cy = Math.max(pl.y - pl.h, Math.min(proj.y, pl.y));
  const dx = proj.x - cx, dy = proj.y - cy;
  return dx * dx + dy * dy <= proj.r * proj.r;
}

function stepProjectiles(state, events) {
  for (const proj of state.projectiles) {
    if (proj.dead) continue;
    proj.vy += GRAVITY * proj.gravityScale * DT;
    proj.x += proj.vx * DT;
    proj.y += proj.vy * DT;
    proj.life--;

    if (proj.life <= 0) { proj.dead = true; continue; }
    if (proj.x < 0 || proj.x > state.map._w || proj.y < 0 || proj.y > state.map._h) { proj.dead = true; continue; }

    if (circleHitsTile(state.map, proj.x, proj.y, proj.r)) {
      proj.dead = true;
      events.push({ t: 'splat', x: proj.x, y: proj.y, owner: proj.owner, r: 18 });
      continue;
    }
    for (const id in state.players) {
      const pl = state.players[id];
      if (projHitsPlayer(proj, pl)) {
        applyDamage(state, pl, proj.damage, proj.owner, 'proj', events);
        proj.dead = true;
        events.push({ t: 'splat', x: proj.x, y: proj.y, owner: proj.owner, r: 22 });
        break;
      }
    }
  }
  if (state.projectiles.length > 0)
    state.projectiles = state.projectiles.filter(p => !p.dead);
}

// ---- Bomb update ------------------------------------------------------------
function detonate(state, bomb, events) {
  bomb.dead = true;
  events.push({ t: 'detonate', x: bomb.x, y: bomb.y, owner: bomb.owner, r: BOMB.aoeRadius });
  for (const id in state.players) {
    const pl = state.players[id];
    if (!pl.alive) continue;
    const dx = pl.x - bomb.x, dy = (pl.y - pl.h / 2) - bomb.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= BOMB.aoeRadius) {
      const falloff = 1 - dist / BOMB.aoeRadius;
      let dmg = BOMB.aoeMaxDamage * falloff;
      if (pl.id === bomb.owner) dmg *= BOMB.selfDamageScale;
      applyDamage(state, pl, dmg, bomb.owner, 'bomb', events);
    }
  }
}

function stepBombs(state, events) {
  for (const bomb of state.bombs) {
    if (bomb.dead) continue;
    bomb.fuse--;
    bomb.vy += GRAVITY * BOMB.gravityScale * DT;

    const hx = collideAxis(state.map, bomb, bomb.vx * DT, 0);
    if (hx.x) { bomb.vx = -bomb.vx * BOMB.restitution; bomb.bounces++; }
    const hy = collideAxis(state.map, bomb, 0, bomb.vy * DT);
    if (hy.y) {
      bomb.vy = -Math.abs(bomb.vy) * BOMB.restitution - 40;
      bomb.vx *= 0.8; bomb.bounces++;
    }

    if (bomb.fuse <= 0) { detonate(state, bomb, events); continue; }
    if (bomb.bounces >= BOMB.maxBounces && BOMB.detonateOnBounceLimit) {
      detonate(state, bomb, events); continue;
    }
  }
  if (state.bombs.length > 0)
    state.bombs = state.bombs.filter(b => !b.dead);
}

// ---- Pickups ----------------------------------------------------------------
function stepPickups(state, events) {
  for (const pk of state.pickups) {
    if (!pk.active) {
      pk.timer--;
      if (pk.timer <= 0) pk.active = true;
      continue;
    }
    for (const id in state.players) {
      const pl = state.players[id];
      if (!pl.alive) continue;
      const dx = pl.x - pk.x, dy = (pl.y - pl.h / 2) - pk.y;
      if (dx * dx + dy * dy <= (PICKUP.radius + pl.w / 2) ** 2) {
        pl.weapon = pk.weapon;
        pk.active = false; pk.timer = PICKUP.respawnTicks;
        events.push({ t: 'pickup', player: pl.id, weapon: pk.weapon, x: pk.x, y: pk.y });
        break;
      }
    }
  }
}

// ============================================================================
// THE STEP FUNCTION
// ============================================================================
export function step(state, inputsById) {
  const events = [];
  state.tick++;

  // Players (sorted by id for deterministic iteration order across machines)
  const ids = Object.keys(state.players).sort();
  for (const id of ids) {
    stepPlayer(state, state.players[id], inputsById[id], events);
  }

  stepProjectiles(state, events);
  stepBombs(state, events);
  stepPickups(state, events);

  return events;
}

// ---- Snapshot serialization (authoritative state -> wire) -------------------
export function serializeSnapshot(state) {
  const players = {};
  for (const id in state.players) {
    const p = state.players[id];
    players[id] = {
      id: p.id, n: p.name, b: p.isBot ? 1 : 0,
      x: round(p.x), y: round(p.y), vx: round(p.vx), vy: round(p.vy),
      f: p.facing, a: round2(p.aimAngle), hp: Math.round(p.hp),
      al: p.alive ? 1 : 0, rt: p.respawnTimer, w: p.weapon,
      sc: p.score, seq: p.lastInputSeq, g: p.grounded ? 1 : 0,
    };
  }
  return {
    tick: state.tick,
    players,
    projectiles: state.projectiles.map(p => ({
      id: p.id, x: round(p.x), y: round(p.y), r: p.r, o: p.owner, w: p.profile,
    })),
    bombs: state.bombs.map(b => ({ id: b.id, x: round(b.x), y: round(b.y), r: b.r, o: b.owner })),
    pickups: state.pickups.map(pk => ({ i: pk.i, x: pk.x, y: pk.y, w: pk.weapon, act: pk.active ? 1 : 0 })),
  };
}

const round = n => Math.round(n * 100) / 100;
const round2 = n => Math.round(n * 1000) / 1000;
