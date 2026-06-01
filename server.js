// ============================================================================
// PaintBrawl — Authoritative Game Server
// Node + ws. Runs the shared sim at a FIXED 60Hz tick, buffers each client's
// inputs, broadcasts snapshots at 20Hz. Spawns bots. Emits kill events.
// ============================================================================
import { WebSocketServer } from 'ws';
import http from 'http';

import {
  TICK_RATE, MS_PER_TICK, TICKS_PER_SNAPSHOT, MATCH, MAX_HP, WEAPON,
} from './constants.js';
import { step, makePlayer, serializeSnapshot, respawnAll } from './physics.js';
import {
  makeInitialState, sanitizeInput, Msg, encode, decode, MapMeta,
} from './protocol.js';
import { makeBotBrain, botInput } from './bots.js';

const PORT = process.env.PORT || 8080;

// ---- World ------------------------------------------------------------------
let state = makeInitialState(Date.now() & 0xffffffff);
const clients = new Map();   // playerId -> { ws, inputQueue:[], lastSeq }
const botBrains = new Map(); // botId -> brain
let matchTimer = MATCH.durationTicks;

// Lag-comp: ring buffer of recent serialized positions, keyed by tick.
const history = [];
const HISTORY_LEN = 40;

// ---- Bot spawning -----------------------------------------------------------
function spawnBots() {
  for (let i = 0; i < MATCH.botCount; i++) {
    const id = `bot_${i + 1}`;
    const sp = state.spawnPoints[(i * 7 + 3) % state.spawnPoints.length];
    state.players[id] = makePlayer(id, `Bot_${String(i + 1).padStart(2, '0')}`, sp, true);
    botBrains.set(id, makeBotBrain());
  }
}
spawnBots();

// ---- Player join/leave ------------------------------------------------------
let humanCounter = 0;
function addHuman(ws, name) {
  if (Object.keys(state.players).length >= MATCH.maxEntities) return null;
  humanCounter++;
  const id = `p_${humanCounter}_${Math.floor(Math.random() * 1e4)}`;
  const sp = state.spawnPoints[Math.floor(Math.random() * state.spawnPoints.length)];
  const safeName = String(name || `Player${humanCounter}`).slice(0, 16);
  state.players[id] = makePlayer(id, safeName, sp, false);
  clients.set(id, { ws, inputQueue: [], lastSeq: 0 });
  broadcast(Msg.pjoin(id, safeName, false), id);
  return id;
}

function removeHuman(id) {
  if (!state.players[id]) return;
  delete state.players[id];
  clients.delete(id);
  broadcast(Msg.pleave(id));
}

// ---- Networking helpers -----------------------------------------------------
function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(encode(obj));
}
function broadcast(obj, exceptId) {
  const data = encode(obj);
  for (const [id, c] of clients) {
    if (id === exceptId) continue;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

// ---- HTTP + WS server -------------------------------------------------------
const server = http.createServer((req, res) => {
  // health check endpoint for Railway
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('PaintBrawl server OK');
    return;
  }
  res.writeHead(404); res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let myId = null;

  ws.on('message', (raw) => {
    const msg = decode(raw.toString());
    if (!msg) return;

    switch (msg.t) {
      case 'join': {
        if (myId) break;
        myId = addHuman(ws, msg.name);
        if (!myId) { send(ws, { t: 'full' }); ws.close(); break; }
        send(ws, Msg.welcome(myId, serializeSnapshot(state), MapMeta));
        break;
      }
      case 'input': {
        if (!myId) break;
        const c = clients.get(myId);
        if (!c) break;
        const cmd = sanitizeInput(msg);
        // de-dupe / order by seq; keep only newer than processed
        if (cmd.seq > c.lastSeq) c.inputQueue.push(cmd);
        break;
      }
      case 'ping': {
        send(ws, Msg.pong(msg.id, msg.ts));
        break;
      }
    }
  });

  ws.on('close', () => { if (myId) removeHuman(myId); });
  ws.on('error', () => { if (myId) removeHuman(myId); });
});

// ---- The authoritative fixed-timestep loop ----------------------------------
let acc = 0;
let last = Date.now();
let tickCount = 0;

function gameTick() {
  // Gather this tick's inputs for every entity.
  const inputs = {};

  // Humans: consume one queued input per tick (process oldest unprocessed).
  for (const [id, c] of clients) {
    if (c.inputQueue.length > 0) {
      // process the next sequential command
      const cmd = c.inputQueue.shift();
      c.lastSeq = cmd.seq;
      c.lastCmd = cmd;
    }
    // If no fresh input this tick, repeat last known (input continuity).
    inputs[id] = c.lastCmd || sanitizeInput({ seq: c.lastSeq });
  }

  // Bots: generate inputs from AI.
  for (const [id, brain] of botBrains) {
    const bot = state.players[id];
    if (bot) inputs[id] = botInput(state, bot, brain);
  }

  const events = step(state, inputs);

  // Emit kill events for the feed.
  for (const ev of events) {
    if (ev.t === 'kill') {
      broadcast(Msg.kill({
        victim: ev.victim, attacker: ev.attacker, cause: ev.cause,
        vn: state.players[ev.victim]?.name,
        an: state.players[ev.attacker]?.name,
      }));
    }
  }

  // Record lag-comp history.
  history.push({ tick: state.tick, snap: serializeSnapshot(state) });
  if (history.length > HISTORY_LEN) history.shift();

  // Match clock + reset.
  matchTimer--;
  if (matchTimer <= 0) {
    matchTimer = MATCH.durationTicks;
    for (const id in state.players) state.players[id].score = 0;
    broadcast({ t: 'matchreset' });
  }

  // Broadcast snapshot at 20Hz.
  tickCount++;
  if (tickCount % TICKS_PER_SNAPSHOT === 0) {
    const snap = serializeSnapshot(state);
    snap.matchTimer = matchTimer;
    broadcast(Msg.snapshot(snap, state.tick));
  }
}

// Drive the loop with accumulator so we hit exactly TICK_RATE regardless of jitter.
function loop() {
  const now = Date.now();
  acc += now - last;
  last = now;
  let guard = 0;
  while (acc >= MS_PER_TICK && guard < 8) {
    gameTick();
    acc -= MS_PER_TICK;
    guard++;
  }
  if (acc > MS_PER_TICK * 8) acc = 0; // drop if we fell way behind
}
setInterval(loop, MS_PER_TICK);

server.listen(PORT, () => {
  console.log(`PaintBrawl server listening on :${PORT} (tick ${TICK_RATE}Hz, snap ${TICK_RATE / TICKS_PER_SNAPSHOT}Hz)`);
  console.log(`Bots: ${MATCH.botCount}, max entities: ${MATCH.maxEntities}`);
});
