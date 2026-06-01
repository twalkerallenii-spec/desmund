// ============================================================================
// PaintBrawl — Shared Level
// The arena map. A flat array of tile codes, row-major (y * GRID_W + x).
// Both server (collision) and client (rendering) read from this.
// ============================================================================
import { TT, GRID_W, GRID_H, TILE, SOLID_TILES } from './constants.js';

// Legend for the ASCII map below:
//   '.' empty   '#' solid   '~' ice   '=' bounce pad   'F' flag (decorative)
const ASCII = [
  '..............................',
  '..............................',
  '....F....................F....',
  '...###..................###...',
  '..............................',
  '.......====........====.......',
  '..............................',
  '....##.......####.......##....',
  '..............................',
  '..#####...............#####...',
  '..............................',
  '......~~~~........~~~~.........',
  '..............F...............',
  '###....########....########...',
  '..............................',
  '..............................',
  '##############################',
];

const CHAR_TO_TT = { '.': TT.EMPTY, '#': TT.SOLID, '~': TT.ICE, '=': TT.BOUNCE, 'F': TT.FLAG };

function buildMap() {
  const map = new Array(GRID_W * GRID_H).fill(TT.EMPTY);
  for (let y = 0; y < GRID_H; y++) {
    const row = ASCII[y] || '';
    for (let x = 0; x < GRID_W; x++) {
      const ch = row[x] || '.';
      map[y * GRID_W + x] = CHAR_TO_TT[ch] ?? TT.EMPTY;
    }
  }
  return map;
}

export const LEVEL = {
  map: buildMap(),
  width: GRID_W,
  height: GRID_H,
};

export function tileAt(map, tx, ty) {
  if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return TT.SOLID; // walls bound the arena
  return map[ty * GRID_W + tx];
}

export function isSolidTile(t) {
  return SOLID_TILES.has(t);
}

// Returns array of {x,y} pixel coordinates (tile centers) that are EMPTY and
// have a SOLID tile directly beneath them — valid spawn points standing on ground.
export function computeSpawnPoints(map) {
  const pts = [];
  for (let ty = 0; ty < GRID_H - 1; ty++) {
    for (let tx = 0; tx < GRID_W; tx++) {
      const here = tileAt(map, tx, ty);
      const below = tileAt(map, tx, ty + 1);
      if (here === TT.EMPTY && isSolidTile(below)) {
        pts.push({ x: tx * TILE + TILE / 2, y: ty * TILE + TILE - 1 });
      }
    }
  }
  return pts;
}
