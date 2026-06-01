// ============================================================================
// PaintBrawl — Client Entry
// Handles the connect screen, instantiates NetClient + Game on connect.
// ============================================================================
import { NetClient } from './netcode.js';
import { Game } from './game.js';

const $ = (id) => document.getElementById(id);

// Default server URL: same host on :8080 in dev, or whatever the user enters.
// On GitHub Pages you MUST point this at your Railway server (wss://...).
function defaultServerUrl() {
  const saved = localStorage.getItem('pb_server');
  if (saved) return saved;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return 'ws://localhost:8080';
  }
  return ''; // force the user to enter it on a hosted page
}

window.addEventListener('DOMContentLoaded', () => {
  $('server-url').value = defaultServerUrl();
  $('player-name').value = localStorage.getItem('pb_name') || '';

  $('connect-btn').addEventListener('click', startGame);
  $('player-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') startGame(); });

  // top-right utility buttons
  $('btn-home').addEventListener('click', () => location.reload());
  $('btn-audio').addEventListener('click', (e) => {
    const on = e.currentTarget.classList.toggle('off');
    e.currentTarget.textContent = on ? '🔇' : '🔊';
  });
});

async function startGame() {
  const name = ($('player-name').value || '').trim() || `Player${Math.floor(Math.random() * 999)}`;
  let url = ($('server-url').value || '').trim();
  if (!url) { showError('Enter your server URL (ws:// or wss://)'); return; }

  localStorage.setItem('pb_name', name);
  localStorage.setItem('pb_server', url);

  $('connect-btn').disabled = true;
  $('connect-btn').textContent = 'Connecting…';
  showError('');

  const net = new NetClient(url);
  try {
    await net.connect(name);
  } catch (e) {
    showError('Could not connect. Check the server URL and that the server is running.');
    $('connect-btn').disabled = false;
    $('connect-btn').textContent = 'Play';
    return;
  }

  // Hide menu, show game
  $('menu').style.display = 'none';
  $('hud').style.display = 'block';

  const canvas = $('game-canvas');
  const game = new Game(net, canvas);
  game.start();
  window.__game = game;
  window.__net = net;
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
