# PaintBrawl 🎨💥

A real-time, server-authoritative 2D paintball deathmatch. Vanilla HTML5
canvas client (no game engine, no build step) + a Node.js authoritative
multiplayer server. Play against AI bots, or against other humans who connect
to the same server.

## Files (flat layout — everything in the repo root)

| File | Role |
|---|---|
| `index.html` | The page: canvas + connect screen + HUD overlays |
| `style.css` | Arcade styling |
| `main.js` | Entry: connect screen → boots the game |
| `game.js` | Vanilla canvas renderer + input + render loop |
| `netcode.js` | Client prediction / reconciliation / interpolation |
| `constants.js` | Tuning: physics, weapons, tick rate, bot count, match length |
| `level.js` | The arena map (ASCII grid) + spawn-point computation |
| `physics.js` | The deterministic `step()` — the shared simulation core |
| `protocol.js` | Network message shapes + initial-state factory |
| `server.js` | Authoritative game server (Node + ws) — runs on Railway |
| `bots.js` | Bot AI (state machines feeding the shared sim) |
| `package.json` | Server dependency (ws) |

The same simulation files (`constants/level/physics/protocol.js`) are imported
by **both** the browser and the server. That shared code is what makes client
prediction work without desync.

## How it works

- The **server** runs the sim at a fixed **60 ticks/sec** and is the single
  source of truth. Clients send *inputs*, never positions — so you can't cheat
  by lying about where you are.
- The server broadcasts **snapshots at 20/sec**; clients interpolate other
  players smoothly between them.
- Your **own** player is predicted instantly with the identical `step()`, then
  reconciled against the server — so your movement feels zero-lag.
- **Bots** feed the same input shape a human does into the same simulation.

## Run locally

Needs [Node.js 18+](https://nodejs.org).

```bash
npm install        # installs ws
npm start          # server on :8080
```

Then serve the client (it's just static files):

```bash
python3 -m http.server 5500
```

Open `http://localhost:5500`. The Server field auto-fills `ws://localhost:8080`.
Click **Play**. Open a second tab to join as another human.

## Deploy

GitHub Pages can only serve static files — it can't run the server. So:
**client → GitHub Pages, server → Railway.** With this flat layout, one repo
holds both.

### Server on Railway
1. Push this repo to GitHub.
2. [railway.app](https://railway.app) → New Project → Deploy from GitHub repo →
   pick this repo. It auto-detects Node and runs `npm start`.
3. Settings → Networking → **Generate Domain** → you get
   `your-app.up.railway.app`.
4. Your WebSocket URL is `wss://your-app.up.railway.app` (use `wss://`, not
   `ws://`). Visiting the domain should show `PaintBrawl server OK`.

### Client on GitHub Pages
Because every client file is in the repo **root**, Pages can serve it directly:
1. Repo → Settings → Pages.
2. Source: **Deploy from a branch**, branch `main`, folder **`/ (root)`**.
3. Wait for the deploy, open `https://yourname.github.io/your-repo/`.
4. Enter your Railway `wss://` URL in the Server field and play.

> The server files (`server.js`, `bots.js`) sitting in root are harmless to
> Pages — it just serves `index.html` and ignores the rest.

## Controls

| Action | Keys |
|---|---|
| Move / Jump | `W` `A` `D` or Arrows (`Space` jumps too) |
| Aim | Mouse |
| Fire | Click / hold mouse |
| Throw splat bomb | `S` or `↓` |
| Switch weapon | `1` Blaster · `2` Sniper (or walk through a pickup) |

## Tuning

Edit `constants.js` — gravity, speeds, weapon stats, bomb radius, bot count,
match length, tick rate. Both server and client read it, so they can't drift
out of sync. Edit the ASCII map in `level.js` to redesign the arena
(`#` solid, `~` ice, `=` bounce pad, `F` flag, `.` empty).

## Notes / next steps

- Lag compensation is kept simple (hits resolve on the server's current frame);
  a rewind buffer exists on the server to build full lag comp later.
- Ice blocks are solid-but-styled; making them breakable is a natural next step.
- No persistence — scores reset each match. Adding a DB is a server-only change.
