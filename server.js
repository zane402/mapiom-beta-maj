// Robo Violet 3D — serveur web + multijoueur (WebSocket)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ROOT = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };

/* ---------- fichiers du jeu ---------- */
const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '') url = '/index.html';
  const file = path.normalize(path.join(ROOT, url));
  const base = path.basename(file);
  if (!file.startsWith(ROOT) || /^(server\.js|package(-lock)?\.json|world\.json)$/.test(base) || file.includes('node_modules')) { res.writeHead(403); return res.end('Interdit'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page introuvable'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=600' });
    res.end(data);
  });
});

/* ---------- monde partagé du mode Créatif ---------- */
const WORLD_FILE = path.join(__dirname, 'world.json');
let world = { b: {}, o: {}, od: {}, n: {} };
try { world = Object.assign(world, JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'))); } catch (e) {}
let dirty = false;
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(WORLD_FILE, JSON.stringify(world), () => {}); } }, 15000);
const snapshot = () => ({ b: Object.entries(world.b), o: Object.values(world.o), od: Object.keys(world.od), n: Object.keys(world.n).map(Number) });
const num = v => typeof v === 'number' && isFinite(v);
function applyOp(op) {
  if (!op || typeof op !== 'object') return false;
  if (op.k === 'b' && [op.x, op.y, op.z].every(v => Number.isInteger(v) && Math.abs(v) < 500)) {
    const k = op.x + ',' + op.y + ',' + op.z;
    if (op.v) { if (typeof op.v !== 'string' || op.v.length > 20 || Object.keys(world.b).length > 30000) return false; world.b[k] = op.v; } else delete world.b[k];
  } else if (op.k === 'o' && Array.isArray(op.a) && typeof op.a[0] === 'string' && op.a[0].length < 20 && op.a.slice(1).every(num)) {
    if (Object.keys(world.o).length > 5000) return false;
    const key = op.a[0] + '|' + op.a[1].toFixed(1) + '|' + op.a[2].toFixed(1); world.o[key] = op.a.slice(0, 5); delete world.od[key];
  } else if (op.k === 'od' && typeof op.key === 'string' && op.key.length < 60) {
    if (world.o[op.key]) delete world.o[op.key]; else world.od[op.key] = 1;
  } else if (op.k === 'n' && Number.isInteger(op.t) && op.t >= 0 && op.t < 220 * 220) {
    world.n[op.t] = 1;
  } else return false;
  dirty = true; return true;
}

/* ---------- joueurs ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const players = new Map(); let nextId = 1;
const clean = s => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 14) || 'Héros';
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function toRoom(room, o, except) { const m = JSON.stringify(o); for (const p of players.values()) if (p.room === room && p !== except && p.ws.readyState === 1) p.ws.send(m); }
const pub = p => ({ id: p.id, name: p.name, look: p.look, s: p.s });

wss.on('connection', ws => {
  const p = { id: nextId++, ws, name: 'Héros', room: null, look: null, s: null, dirty: false, last: 0, alive: true };
  players.set(p.id, p);
  ws.on('pong', () => { p.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'hello') {
      if (p.room) toRoom(p.room, { t: 'leave', id: p.id }, p);
      p.name = clean(m.name || p.name); p.room = (m.room === 'adv' || m.room === 'cre') ? m.room : null; p.s = null;
      if (!p.room) return;
      const others = [...players.values()].filter(q => q.room === p.room && q !== p && q.look).map(pub);
      send(ws, { t: 'welcome', id: p.id, players: others, world: p.room === 'cre' ? snapshot() : null });
      if (p.look) toRoom(p.room, { t: 'join', p: pub(p) }, p);
    } else if (m.t === 'look' && m.look && typeof m.look.race === 'string') {
      const first = !p.look; p.look = { race: m.look.race.slice(0, 12), pal: m.look.pal | 0, eq: m.look.eq && typeof m.look.eq === 'object' ? m.look.eq : {} };
      if (JSON.stringify(p.look).length > 800) p.look.eq = {};
      if (p.room) toRoom(p.room, first ? { t: 'join', p: pub(p) } : { t: 'look', id: p.id, look: p.look }, p);
    } else if (m.t === 's' && Array.isArray(m.s) && m.s.length === 7 && m.s.every(num)) {
      p.s = [p.id, ...m.s]; p.dirty = true;
    } else if (m.t === 'chat' && Number.isInteger(m.m) && m.m >= 0 && m.m < 30) {
      const now = Date.now(); if (now - p.last < 1200 || !p.room) return; p.last = now;
      toRoom(p.room, { t: 'chat', id: p.id, m: m.m }, p);
    } else if (m.t === 'fx' && p.room) {
      toRoom(p.room, { t: 'fx', id: p.id, k: m.k ? 1 : 0 }, p);
    } else if (m.t === 'build' && p.room === 'cre') {
      if (applyOp(m.op)) toRoom('cre', { t: 'build', op: m.op }, p);
    }
  });
  ws.on('close', () => { players.delete(p.id); if (p.room) toRoom(p.room, { t: 'leave', id: p.id }); });
});

// positions envoyées 10 fois par seconde
setInterval(() => {
  for (const room of ['adv', 'cre']) {
    const l = []; for (const p of players.values()) if (p.room === room && p.dirty && p.s) { l.push(p.s); p.dirty = false; }
    if (l.length) toRoom(room, { t: 'st', l });
  }
}, 100);
// coupe les connexions mortes
setInterval(() => { for (const p of players.values()) { if (!p.alive) { p.ws.terminate(); continue; } p.alive = false; try { p.ws.ping(); } catch (e) {} } }, 30000);

server.listen(PORT, () => console.log('Robo Violet 3D en ligne sur le port ' + PORT));
