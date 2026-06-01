// ============================================================================
// PaintBrawl — Bot AI (server-side)
// Bots are NOT special-cased in physics. They produce the same InputCmd shape
// a human client sends, and feed it into the identical shared step().
// Simple state machines: patrol, jump on wall-collide, raycast-and-fire.
// ============================================================================
import { TILE, WORLD_W, MOVE_SPEED, WEAPON } from './constants.js';
import { tileAt, isSolidTile } from './level.js';

// Line-of-sight: step from a->b through tiles, fail if a solid blocks.
function hasLOS(map, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const dist = Math.hypot(dx, dy);
  const steps = Math.ceil(dist / (TILE / 2));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + dx * t, y = ay + dy * t;
    if (isSolidTile(tileAt(map, Math.floor(x / TILE), Math.floor(y / TILE)))) return false;
  }
  return true;
}

export function makeBotBrain() {
  return {
    dir: Math.random() < 0.5 ? -1 : 1,
    repathTimer: 0,
    jumpTimer: 0,
    targetId: null,
    lastX: 0,
    stuckTicks: 0,
    seq: 0,
  };
}

// Produce an InputCmd for a bot given current world state.
export function botInput(state, bot, brain) {
  brain.seq++;
  const inp = {
    seq: brain.seq, left: false, right: false, jump: false,
    fire: false, bomb: false, switchTo: null, aimX: bot.x, aimY: bot.y,
  };
  if (!bot.alive) return inp;

  // --- Target acquisition: nearest visible living enemy ---
  let target = null, bestD = Infinity;
  for (const id in state.players) {
    const o = state.players[id];
    if (o.id === bot.id || !o.alive) continue;
    const d = Math.hypot(o.x - bot.x, o.y - bot.y);
    if (d < bestD && hasLOS(state.map, bot.x, bot.y - bot.h / 2, o.x, o.y - o.h / 2)) {
      bestD = d; target = o;
    }
  }

  // --- Patrol direction with periodic re-roll ---
  if (--brain.repathTimer <= 0) {
    brain.repathTimer = 60 + Math.floor(Math.random() * 90);
    if (Math.random() < 0.3) brain.dir *= -1;
  }

  // Stuck detection (barely moved horizontally) -> turn + jump
  if (Math.abs(bot.x - brain.lastX) < 0.5 && bot.grounded) {
    brain.stuckTicks++;
    if (brain.stuckTicks > 8) { brain.dir *= -1; inp.jump = true; brain.stuckTicks = 0; }
  } else brain.stuckTicks = 0;
  brain.lastX = bot.x;

  // Edge avoidance near arena bounds
  if (bot.x < TILE * 1.5) brain.dir = 1;
  if (bot.x > WORLD_W - TILE * 1.5) brain.dir = -1;

  if (target) {
    // Engage: face target, aim at it, fire. Strafe toward/away to keep range.
    inp.aimX = target.x; inp.aimY = target.y - target.h / 2;
    inp.fire = true;
    // prefer sniper if held already; bots use whatever weapon they have
    const desiredRange = bot.weapon === WEAPON.SNIPER ? 320 : 200;
    if (bestD > desiredRange + 40) brain.dir = target.x > bot.x ? 1 : -1;
    else if (bestD < desiredRange - 40) brain.dir = target.x > bot.x ? -1 : 1;
    // occasional bomb at close range
    if (bestD < 140 && Math.random() < 0.01) inp.bomb = true;
    // hop to dodge
    if (Math.random() < 0.03 && bot.grounded) inp.jump = true;
  } else {
    // Wander; aim where we walk
    inp.aimX = bot.x + brain.dir * 60;
    inp.aimY = bot.y - bot.h / 2;
    // random hops while patrolling
    if (Math.random() < 0.012 && bot.grounded) inp.jump = true;
  }

  if (brain.dir < 0) inp.left = true; else inp.right = true;
  return inp;
}
