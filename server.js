'use strict';
/**
 * 할리갈리 온라인 서버
 *  - 정적 파일(public/) 제공 + WebSocket 게임 서버를 한 포트에서 처리합니다.
 *  - 외부 패키지 없이 Node.js 내장 모듈만 사용합니다.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { attach } = require('./ws-lite');

// ------------------------------------------------------------------ 설정
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

const FRUITS = ['strawberry', 'banana', 'lime', 'plum'];
// 과일 한 종류당 14장 (1개 5장, 2개 3장, 3개 3장, 4개 2장, 5개 1장) × 4종 = 56장
const COUNT_DIST = { 1: 5, 2: 3, 3: 3, 4: 2, 5: 1 };
const BELL_SUM = 5;

const LATE_GRACE_MS = 900; // 누군가 종을 맞게 친 직후, 살짝 늦은 사람은 벌칙 없이 무시
const BELL_COOLDOWN_MS = 500; // 같은 사람의 연타 방지
const TURN_SECS_OPTIONS = [0, 10, 15, 20, 30]; // 0 = 자동 뒤집기 없음
const DEFAULT_TURN_SECS = 15;
const DISCONNECTED_TURN_MS = 2000; // 연결 끊긴 사람 차례는 빨리 넘김
const LOBBY_DROP_MS = 30 * 1000; // 로비에서 끊기면 30초 뒤 제거
const PLAYING_DROP_MS = 90 * 1000; // 게임 중 끊기면 90초 뒤 기권 처리
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ 유틸
const rand = (n) => crypto.randomInt(n);
const newId = (bytes) => crypto.randomBytes(bytes).toString('hex');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildDeck() {
  const deck = [];
  let id = 0;
  for (const fruit of FRUITS) {
    for (const [n, count] of Object.entries(COUNT_DIST)) {
      for (let i = 0; i < count; i++) deck.push({ id: id++, fruit, n: Number(n) });
    }
  }
  return shuffle(deck);
}

const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 헷갈리는 I, O 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[rand(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function uniqueName(room, raw) {
  let base = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>&"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  base = Array.from(base).slice(0, 12).join('');
  if (!base) base = '플레이어';
  const taken = new Set(room.players.map((p) => p.name));
  let name = base;
  let k = 2;
  while (taken.has(name)) name = `${Array.from(base).slice(0, 10).join('')}${k++}`;
  return name;
}

// ------------------------------------------------------------------ 전송
function sendTo(conn, obj) {
  if (conn && !conn.closed) conn.send(JSON.stringify(obj));
}

function snapshotFor(room, viewer) {
  const cur = room.phase === 'playing' ? room.players[room.turnIdx] : null;
  const now = Date.now();
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    you: viewer.id,
    host: room.hostId,
    turn: cur ? cur.id : null,
    turnMs: room.turnDeadline ? Math.max(0, room.turnDeadline - now) : null,
    turnTotalMs: room.turnTotalMs || null,
    pot: room.pot.length,
    winner: room.winnerId,
    settings: { turnSecs: room.settings.turnSecs, options: TURN_SECS_OPTIONS },
    limits: { min: MIN_PLAYERS, max: MAX_PLAYERS },
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      alive: p.alive,
      left: p.left,
      draw: p.draw.length,
      up: p.up.length,
      top: p.up.length ? p.up[p.up.length - 1] : null,
    })),
  };
}

function broadcast(room) {
  for (const p of room.players) if (p.conn) sendTo(p.conn, snapshotFor(room, p));
}

function broadcastEvent(room, ev) {
  const msg = JSON.stringify({ t: 'event', ...ev });
  for (const p of room.players) if (p.conn && !p.conn.closed) p.conn.send(msg);
}

// ------------------------------------------------------------------ 방/플레이어 관리
function createRoom() {
  const room = {
    code: makeCode(),
    phase: 'lobby', // lobby | playing | ended
    players: [],
    hostId: null,
    turnIdx: 0,
    pot: [], // 탈락/기권한 사람의 펼친 카드 (다음 종 성공자가 가져감)
    winnerId: null,
    settings: { turnSecs: DEFAULT_TURN_SECS },
    turnTimer: null,
    turnDeadline: null,
    turnTotalMs: null,
    graceUntil: 0,
    emptySince: null,
  };
  rooms.set(room.code, room);
  return room;
}

function destroyRoom(room) {
  clearTimeout(room.turnTimer);
  for (const p of room.players) clearTimeout(p.dropTimer);
  rooms.delete(room.code);
}

function addPlayer(room, conn, name) {
  const p = {
    id: newId(3),
    token: newId(12),
    name: uniqueName(room, name),
    conn,
    connected: true,
    draw: [], // 뒤집을 카드 (맨 앞이 맨 위)
    up: [], // 펼쳐 놓은 카드 (맨 뒤가 맨 위)
    alive: true,
    left: false,
    bellLockUntil: 0,
    dropTimer: null,
  };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  room.emptySince = null;
  conn.ctx = { room, player: p };
  sendTo(conn, { t: 'joined', code: room.code, token: p.token, id: p.id });
  broadcast(room);
  return p;
}

function removePlayer(room, p) {
  clearTimeout(p.dropTimer);
  if (p.conn) {
    p.conn.ctx = null;
    p.conn = null;
  }
  const idx = room.players.indexOf(p);
  if (idx >= 0) room.players.splice(idx, 1);
  if (room.players.length === 0) return destroyRoom(room);
  if (room.hostId === p.id) {
    const next = room.players.find((x) => x.connected) || room.players[0];
    room.hostId = next.id;
  }
  broadcast(room);
}

function scheduleDrop(room, p) {
  clearTimeout(p.dropTimer);
  const ms = room.phase === 'playing' ? PLAYING_DROP_MS : LOBBY_DROP_MS;
  p.dropTimer = setTimeout(() => {
    p.dropTimer = null;
    if (p.connected || !rooms.has(room.code)) return;
    if (room.phase === 'playing') forfeit(room, p);
    else removePlayer(room, p);
  }, ms);
}

// ------------------------------------------------------------------ 게임 진행
const currentPlayer = (room) => (room.phase === 'playing' ? room.players[room.turnIdx] : null);

function startGame(room) {
  room.players = room.players.filter((p) => p.connected);
  if (room.players.length < MIN_PLAYERS) return false;

  const deck = buildDeck();
  for (const p of room.players) {
    p.draw = [];
    p.up = [];
    p.alive = true;
    p.left = false;
    p.bellLockUntil = 0;
  }
  deck.forEach((card, i) => room.players[i % room.players.length].draw.push(card));

  room.phase = 'playing';
  room.pot = [];
  room.winnerId = null;
  room.graceUntil = 0;
  room.turnIdx = rand(room.players.length);
  if (!room.players.some((p) => p.id === room.hostId)) room.hostId = room.players[0].id;

  broadcastEvent(room, { kind: 'start' });
  scheduleTurn(room);
  broadcast(room);
  return true;
}

function advanceTurn(room) {
  const n = room.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (room.turnIdx + i) % n;
    if (room.players[idx].alive) {
      room.turnIdx = idx;
      return;
    }
  }
}

function scheduleTurn(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnDeadline = null;
  room.turnTotalMs = null;
  const p = currentPlayer(room);
  if (!p) return;
  const ms = p.connected ? room.settings.turnSecs * 1000 : DISCONNECTED_TURN_MS;
  if (!ms) return;
  room.turnDeadline = Date.now() + ms;
  room.turnTotalMs = ms;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    doFlip(room, p);
  }, ms);
}

function checkEnd(room) {
  if (room.phase !== 'playing') return;
  const alive = room.players.filter((p) => p.alive);
  if (alive.length > 1) return;
  room.phase = 'ended';
  room.winnerId = alive.length === 1 ? alive[0].id : null;
  clearTimeout(room.turnTimer);
  room.turnTimer = null;
  room.turnDeadline = null;
  room.turnTotalMs = null;
  broadcastEvent(room, {
    kind: 'end',
    id: room.winnerId,
    name: alive.length === 1 ? alive[0].name : null,
  });
}

// 뒤집을 카드가 없는 차례가 되면 탈락. 펼쳐 둔 카드는 바닥(pot)으로.
function eliminate(room, p) {
  p.alive = false;
  room.pot.push(...p.up);
  p.up = [];
  broadcastEvent(room, { kind: 'out', id: p.id, name: p.name });
  checkEnd(room);
}

// 도중에 나가거나 오래 끊긴 사람: 가진 카드를 전부 바닥(pot)으로.
function forfeit(room, p) {
  if (!p.alive) return;
  const wasTurn = currentPlayer(room) === p;
  p.alive = false;
  p.left = true;
  room.pot.push(...p.up, ...p.draw);
  p.up = [];
  p.draw = [];
  broadcastEvent(room, { kind: 'out', id: p.id, name: p.name, left: true });
  checkEnd(room);
  if (room.phase === 'playing') {
    if (wasTurn) advanceTurn(room);
    scheduleTurn(room);
  }
  broadcast(room);
}

function doFlip(room, p) {
  if (room.phase !== 'playing' || currentPlayer(room) !== p || !p.alive) return;
  if (p.draw.length === 0) {
    eliminate(room, p);
  } else {
    p.up.push(p.draw.shift());
  }
  if (room.phase === 'playing') {
    advanceTurn(room);
    scheduleTurn(room);
  }
  broadcast(room);
}

function tallies(room) {
  const sums = {};
  const tops = [];
  for (const p of room.players) {
    if (!p.alive || p.up.length === 0) continue;
    const c = p.up[p.up.length - 1];
    sums[c.fruit] = (sums[c.fruit] || 0) + c.n;
    tops.push({ id: p.id, name: p.name, fruit: c.fruit, n: c.n });
  }
  return { sums, tops };
}

function doBell(room, p) {
  if (room.phase !== 'playing' || !p.alive) return;
  const now = Date.now();
  if (now < p.bellLockUntil) return;

  const { sums, tops } = tallies(room);
  const fruit = Object.keys(sums).find((f) => sums[f] === BELL_SUM);

  // 방금 다른 사람이 맞게 친 직후라면, 늦은 사람은 벌칙 없이 무시
  if (!fruit && now < room.graceUntil) {
    sendTo(p.conn, { t: 'event', kind: 'late' });
    return;
  }
  p.bellLockUntil = now + BELL_COOLDOWN_MS;

  if (fruit) {
    // 성공: 모든 펼친 카드 + 바닥 카드를 가져와 섞어서 자기 더미 아래에 넣음
    const loot = room.pot.splice(0);
    for (const q of room.players) {
      loot.push(...q.up);
      q.up = [];
    }
    shuffle(loot);
    p.draw.push(...loot);
    room.graceUntil = now + LATE_GRACE_MS;
    broadcastEvent(room, {
      kind: 'bell',
      ok: true,
      id: p.id,
      name: p.name,
      fruit,
      tops,
      gained: loot.length,
    });
  } else {
    // 실패: 다른 살아있는 플레이어에게 카드 1장씩 지급
    let paid = 0;
    for (const q of room.players) {
      if (q === p || !q.alive) continue;
      if (p.draw.length === 0) break;
      q.draw.push(p.draw.shift());
      paid++;
    }
    broadcastEvent(room, { kind: 'bell', ok: false, id: p.id, name: p.name, tops, paid });
  }
  broadcast(room);
}

// ------------------------------------------------------------------ 메시지 처리
function err(conn, code, msg) {
  sendTo(conn, { t: 'error', code, msg });
}

function onCreate(conn, msg) {
  if (conn.ctx) return err(conn, 'already', '이미 방에 들어와 있어요.');
  const room = createRoom();
  addPlayer(room, conn, msg.name);
}

function onJoin(conn, msg) {
  if (conn.ctx) return err(conn, 'already', '이미 방에 들어와 있어요.');
  const code = String(msg.code || '').trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) return err(conn, 'no-room', '그런 방이 없어요. 코드를 다시 확인해 주세요.');
  if (room.phase === 'playing') return err(conn, 'started', '이미 게임이 시작된 방이에요.');
  if (room.phase === 'ended') return err(conn, 'started', '게임이 끝난 방이에요. 방장이 다시 시작하면 들어올 수 있어요.');
  if (room.players.length >= MAX_PLAYERS) return err(conn, 'full', `방이 가득 찼어요. (최대 ${MAX_PLAYERS}명)`);
  addPlayer(room, conn, msg.name);
}

function onRejoin(conn, msg) {
  const room = rooms.get(String(msg.code || '').toUpperCase());
  const p = room && room.players.find((x) => x.token === msg.token && !x.left);
  if (!p) return err(conn, 'rejoin-failed', '이전 방을 찾을 수 없어요.');
  if (p.conn && p.conn !== conn) {
    p.conn.ctx = null;
    p.conn.close(1000);
  }
  clearTimeout(p.dropTimer);
  p.dropTimer = null;
  p.conn = conn;
  p.connected = true;
  conn.ctx = { room, player: p };
  room.emptySince = null;
  sendTo(conn, { t: 'joined', code: room.code, token: p.token, id: p.id });
  if (room.phase === 'playing' && currentPlayer(room) === p) scheduleTurn(room);
  broadcast(room);
}

function onClose(conn) {
  conns.delete(conn);
  const ctx = conn.ctx;
  if (!ctx) return;
  const { room, player: p } = ctx;
  if (p.conn !== conn) return;
  p.conn = null;
  p.connected = false;
  conn.ctx = null;
  scheduleDrop(room, p);
  if (room.phase === 'playing' && currentPlayer(room) === p) scheduleTurn(room);
  broadcast(room);
}

function handle(conn, msg) {
  switch (msg.t) {
    case 'create':
      return onCreate(conn, msg);
    case 'join':
      return onJoin(conn, msg);
    case 'rejoin':
      return onRejoin(conn, msg);
    case 'ping':
      return sendTo(conn, { t: 'pong' });
  }

  const ctx = conn.ctx;
  if (!ctx) return err(conn, 'no-room', '먼저 방에 들어가 주세요.');
  const { room, player: p } = ctx;
  const isHost = room.hostId === p.id;

  switch (msg.t) {
    case 'settings': {
      if (!isHost || room.phase !== 'lobby') return;
      const secs = Number(msg.turnSecs);
      if (TURN_SECS_OPTIONS.includes(secs)) room.settings.turnSecs = secs;
      return broadcast(room);
    }
    case 'start': {
      if (!isHost) return err(conn, 'not-host', '방장만 시작할 수 있어요.');
      if (room.phase !== 'lobby') return;
      const connected = room.players.filter((x) => x.connected).length;
      if (connected < MIN_PLAYERS) return err(conn, 'few', `${MIN_PLAYERS}명 이상 모여야 시작할 수 있어요.`);
      return void startGame(room);
    }
    case 'flip':
      return doFlip(room, p);
    case 'bell':
      return doBell(room, p);
    case 'rematch': {
      if (!isHost || room.phase !== 'ended') return;
      room.players = room.players.filter((x) => x.connected && !x.left);
      for (const x of room.players) {
        x.draw = [];
        x.up = [];
        x.alive = true;
      }
      room.pot = [];
      room.winnerId = null;
      room.phase = 'lobby';
      return broadcast(room);
    }
    case 'leave': {
      conn.ctx = null;
      if (room.phase === 'playing') {
        p.conn = null;
        p.connected = false;
        clearTimeout(p.dropTimer);
        forfeit(room, p);
      } else {
        p.conn = conn; // removePlayer 가 정리
        removePlayer(room, p);
      }
      return sendTo(conn, { t: 'left' });
    }
  }
}

// ------------------------------------------------------------------ HTTP + WebSocket
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (e, data) => {
    if (e) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const conns = new Set();

attach(server, {
  maxPayload: 2048,
  onConnection(conn) {
    conns.add(conn);
    conn.bucket = { t: Date.now(), n: 0 };
    conn.on('message', (raw) => {
      // 초당 40개 넘는 메시지는 무시 (도배 방지)
      const now = Date.now();
      if (now - conn.bucket.t > 1000) conn.bucket = { t: now, n: 0 };
      if (++conn.bucket.n > 40) return;

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;
      try {
        handle(conn, msg);
      } catch (e) {
        console.error('[handler error]', e);
        err(conn, 'server', '서버에서 오류가 났어요. 잠시 후 다시 시도해 주세요.');
      }
    });
    conn.on('close', () => onClose(conn));
  },
});

// 연결 유지(터널/프록시가 유휴 연결을 끊지 않도록) + 죽은 연결 정리
setInterval(() => {
  for (const c of conns) {
    if (!c.isAlive) {
      c.terminate();
      continue;
    }
    c.isAlive = false;
    c.ping();
  }
}, 25 * 1000).unref();

// 비어 있는 방 정리
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.connected)) {
      room.emptySince = null;
    } else if (!room.emptySince) {
      room.emptySince = now;
    } else if (now - room.emptySince > EMPTY_ROOM_TTL_MS) {
      destroyRoom(room);
    }
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n🔔 할리갈리 서버 실행 중 (포트 ${PORT})`);
    console.log(`   이 컴퓨터에서:  http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) console.log(`   같은 네트워크:  http://${ni.address}:${PORT}`);
      }
    }
    console.log('   종료: Ctrl+C\n');
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

module.exports = { server, rooms, buildDeck };
