'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 8787);
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
const ALLOW_GUESTS = process.env.ALLOW_GUESTS === 'true';
const ROUND_SECONDS = Math.max(30, Math.min(900, Number(process.env.ROUND_SECONDS || 180)));
const TICK_MS = 50;
const WORLD = { w: 1600, h: 1000 };
const rooms = new Map();
const waiting = [];
let nextPlayerId = 1;

function cleanName(value) {
  return String(value || 'Игрок').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Игрок';
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) {
    return ALLOW_GUESTS
      ? { ok: true, user: null, dev: true }
      : { ok: false, code: 'AUTH_BOT_TOKEN_MISSING', error: '[AUTH_BOT_TOKEN_MISSING] Сервер не настроен: добавь BOT_TOKEN в переменные окружения.' };
  }
  if (!initData || typeof initData !== 'string') {
    return { ok: false, code: 'AUTH_INITDATA_MISSING', error: '[AUTH_INITDATA_MISSING] Сервер не получил initData. Открой игру из Telegram и проверь клиентский index.html.' };
  }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, code: 'AUTH_INITDATA_PARSE_FAILED', error: '[AUTH_INITDATA_PARSE_FAILED] Не удалось прочитать initData.' };
  }

  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) {
    return { ok: false, code: 'AUTH_HASH_MISSING_OR_INVALID', error: '[AUTH_HASH_MISSING_OR_INVALID] В initData отсутствует корректный hash.' };
  }

  params.delete('hash');
  // При проверке токеном бота исключается только hash.
  // Поле signature, если оно присутствует, должно остаться в data-check-string.
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const actual = Buffer.from(hash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    const diagnostic = {
      code: 'AUTH_HASH_MISMATCH',
      fields: [...params.keys()].sort(),
      hasUser: params.has('user'),
      hasAuthDate: params.has('auth_date'),
      hasSignature: params.has('signature'),
      botTokenConfigured: Boolean(BOT_TOKEN),
    };
    console.warn('[AUTH] Telegram initData hash mismatch', JSON.stringify(diagnostic));
    return { ok: false, code: diagnostic.code, error: '[AUTH_HASH_MISMATCH] Подпись initData не совпала. Проверь BOT_TOKEN (должен быть от того же бота) и передачу Telegram.WebApp.initData. Подробности без секретов — в Logs Render.' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate <= 0 || authDate > nowSeconds + 60 || nowSeconds - authDate > 86400) {
    return { ok: false, code: 'AUTH_DATE_INVALID_OR_EXPIRED', error: '[AUTH_DATE_INVALID_OR_EXPIRED] Данные Telegram устарели или время некорректно. Закрой и снова открой игру.' };
  }

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, code: 'AUTH_USER_JSON_INVALID', error: '[AUTH_USER_JSON_INVALID] Не удалось прочитать профиль пользователя из initData.' };
  }
  if (!user || user.id === undefined || user.id === null) {
    return { ok: false, code: 'AUTH_USER_MISSING', error: '[AUTH_USER_MISSING] В initData нет профиля пользователя.' };
  }
  return { ok: true, user };
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function broadcast(room, message) {
  for (const player of room.players) send(player.ws, message);
}

function makeObstacles() {
  return [
    { x: 280, y: 180, w: 180, h: 90 },
    { x: 620, y: 120, w: 90, h: 220 },
    { x: 1000, y: 190, w: 220, h: 90 },
    { x: 230, y: 470, w: 130, h: 150 },
    { x: 680, y: 400, w: 220, h: 100 },
    { x: 1240, y: 450, w: 120, h: 180 },
    { x: 440, y: 760, w: 230, h: 90 },
    { x: 920, y: 720, w: 100, h: 180 },
    { x: 1120, y: 800, w: 220, h: 90 },
  ];
}

function createRoom() {
  const room = {
    id: `room-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    players: [], bullets: [], obstacles: makeObstacles(), lastTick: Date.now(), endAt: 0, over: false,
  };
  rooms.set(room.id, room);
  return room;
}

function createPlayer(ws) {
  const profile = ws.telegramUser;
  const fullName = profile
    ? [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.username || 'Игрок'
    : ws.guestName || 'Гость';
  return {
    id: `p${nextPlayerId++}`,
    ws,
    telegramId: profile?.id != null ? String(profile.id) : null,
    name: cleanName(fullName),
    username: profile?.username || null,
    x: 150, y: 150, hp: 100, kills: 0, deaths: 0,
    aimX: 1, aimY: 0,
    input: { x: 0, y: 0, aimX: 1, aimY: 0, fire: false },
    lastShot: 0,
    invulnerableUntil: Date.now() + 1000,
    room: null,
  };
}

function publicPlayer(player) {
  return {
    id: player.id, name: player.name, username: player.username,
    x: player.x, y: player.y, hp: player.hp,
    kills: player.kills, deaths: player.deaths,
    aimX: player.aimX, aimY: player.aimY,
  };
}

function removeFromWaiting(ws) {
  for (let i = waiting.length - 1; i >= 0; i--) {
    if (waiting[i] === ws) waiting.splice(i, 1);
  }
}

function startMatch(room) {
  room.lastTick = Date.now();
  room.endAt = room.lastTick + ROUND_SECONDS * 1000;
  room.over = false;
  room.bullets = [];
  room.players.forEach((player, index) => {
    player.hp = 100;
    player.kills = 0;
    player.deaths = 0;
    player.x = index === 0 ? 150 : WORLD.w - 150;
    player.y = index === 0 ? 150 : WORLD.h - 150;
    player.aimX = index === 0 ? 1 : -1;
    player.aimY = 0;
    player.input = { x: 0, y: 0, aimX: player.aimX, aimY: 0, fire: false };
    player.invulnerableUntil = Date.now() + 1500;
  });
  broadcast(room, { type: 'match', roomId: room.id, seconds: ROUND_SECONDS });
}

function joinQueue(ws) {
  if (!ws.authed || ws.readyState !== WebSocket.OPEN) return;

  if (ws.player && ws.room && !ws.room.over) {
    if (ws.room.players.length === 1) {
      if (!waiting.includes(ws)) waiting.push(ws);
      send(ws, { type: 'joined', id: ws.player.id, name: ws.player.name, roomId: ws.room.id, waiting: true });
    } else {
      send(ws, { type: 'error', message: 'Ты уже участвуешь в раунде.' });
    }
    return;
  }

  if (ws.player) removePlayer(ws, false);
  removeFromWaiting(ws);

  let room = null;
  while (waiting.length > 0) {
    const candidate = waiting.shift();
    if (!candidate || candidate.readyState !== WebSocket.OPEN || !candidate.authed || !candidate.player || !candidate.room) continue;
    if (candidate.room.over || candidate.room.players.length !== 1 || candidate.room.players[0] !== candidate.player) continue;
    room = candidate.room;
    break;
  }

  if (!room) room = createRoom();
  const player = createPlayer(ws);
  player.room = room;
  ws.player = player;
  ws.room = room;
  room.players.push(player);

  const index = room.players.length - 1;
  player.x = index === 0 ? 150 : WORLD.w - 150;
  player.y = index === 0 ? 150 : WORLD.h - 150;
  player.aimX = index === 0 ? 1 : -1;
  player.input.aimX = player.aimX;

  send(ws, { type: 'joined', id: player.id, name: player.name, roomId: room.id, waiting: room.players.length < 2 });
  if (room.players.length === 2) startMatch(room);
  else waiting.push(ws);
}

function removePlayer(ws, announce = true) {
  removeFromWaiting(ws);
  const player = ws.player;
  const room = ws.room;
  if (!player || !room) {
    ws.player = null;
    ws.room = null;
    return;
  }

  room.players = room.players.filter((entry) => entry !== player);
  player.room = null;
  ws.player = null;
  ws.room = null;

  if (room.players.length === 0) {
    rooms.delete(room.id);
    return;
  }

  if (!room.over && announce) {
    room.over = true;
    broadcast(room, { type: 'roundEnd', winnerId: room.players[0].id, scores: room.players.map((p) => p.kills), reason: 'opponent_left' });
  }
  if (room.over && room.players.length === 1) {
    // Keep the remaining client connected, but it must press Play again to re-queue.
  }
}

function circleHitsRect(x, y, radius, obstacle) {
  const nearestX = Math.max(obstacle.x, Math.min(x, obstacle.x + obstacle.w));
  const nearestY = Math.max(obstacle.y, Math.min(y, obstacle.y + obstacle.h));
  return (x - nearestX) ** 2 + (y - nearestY) ** 2 < radius ** 2;
}

function isBlocked(x, y, radius, room) {
  return x < radius || y < radius || x > WORLD.w - radius || y > WORLD.h - radius ||
    room.obstacles.some((obstacle) => circleHitsRect(x, y, radius, obstacle));
}

function finishRound(room, reason = 'time') {
  if (room.over) return;
  room.over = true;
  const [a, b] = room.players;
  let winnerId = null;
  if (a && b && a.kills !== b.kills) winnerId = a.kills > b.kills ? a.id : b.id;
  broadcast(room, { type: 'roundEnd', winnerId, scores: room.players.map((p) => p.kills), reason });
}

function tickRoom(room, now) {
  if (room.over || room.players.length !== 2) return;
  const dt = Math.min(0.08, Math.max(0.001, (now - room.lastTick) / 1000));
  room.lastTick = now;

  for (const player of room.players) {
    const input = player.input;
    const length = Math.hypot(input.x, input.y) || 1;
    if (player.hp > 0) {
      const dx = input.x / length * 250 * dt;
      const dy = input.y / length * 250 * dt;
      const nextX = player.x + dx;
      const nextY = player.y + dy;
      if (!isBlocked(nextX, player.y, 16, room)) player.x = nextX;
      if (!isBlocked(player.x, nextY, 16, room)) player.y = nextY;
      player.aimX = input.aimX || player.aimX;
      player.aimY = input.aimY || player.aimY;

      if (input.fire && now - player.lastShot >= 240) {
        player.lastShot = now;
        room.bullets.push({
          id: crypto.randomBytes(5).toString('hex'), ownerId: player.id,
          x: player.x + player.aimX * 24, y: player.y + player.aimY * 24,
          vx: player.aimX * 850, vy: player.aimY * 850, created: now, damage: 25,
        });
      }
    }
  }

  for (const bullet of room.bullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
  }

  room.bullets = room.bullets.filter((bullet) => {
    if (bullet.x < 0 || bullet.y < 0 || bullet.x > WORLD.w || bullet.y > WORLD.h || now - bullet.created > 1400) return false;
    if (room.obstacles.some((o) => bullet.x >= o.x && bullet.x <= o.x + o.w && bullet.y >= o.y && bullet.y <= o.y + o.h)) return false;
    const target = room.players.find((p) => p.id !== bullet.ownerId && p.hp > 0 && now > p.invulnerableUntil && Math.hypot(p.x - bullet.x, p.y - bullet.y) < 21);
    if (!target) return true;

    target.hp = Math.max(0, target.hp - bullet.damage);
    if (target.hp === 0) {
      const owner = room.players.find((p) => p.id === bullet.ownerId);
      if (owner) owner.kills++;
      target.deaths++;
      setTimeout(() => {
        if (!room.over && room.players.includes(target)) {
          target.hp = 100;
          target.x = target === room.players[0] ? 150 : WORLD.w - 150;
          target.y = target === room.players[0] ? 150 : WORLD.h - 150;
          target.invulnerableUntil = Date.now() + 1500;
        }
      }, 900);
    }
    return false;
  });

  if (now >= room.endAt) {
    finishRound(room, 'time');
    return;
  }

  broadcast(room, {
    type: 'state', roomId: room.id, world: WORLD,
    players: room.players.map(publicPlayer),
    bullets: room.bullets.map(({ id, x, y, vx, vy, ownerId }) => ({ id, x, y, vx, vy, ownerId })),
    obstacles: room.obstacles,
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((total, room) => total + room.players.length, 0), authConfigured: Boolean(BOT_TOKEN) }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Strike Arena PvP server is running. Use /health for status.\n');
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: false });
wss.on('connection', (ws, req) => {
  if (ALLOWED_ORIGIN && req.headers.origin !== ALLOWED_ORIGIN) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  ws.player = null;
  ws.room = null;
  ws.authed = false;
  ws.lastMessageAt = 0;
  ws.messageCount = 0;
  ws.rateWindowAt = Date.now();

  ws.on('message', (raw) => {
    const now = Date.now();
    if (now - ws.rateWindowAt >= 1000) {
      ws.rateWindowAt = now;
      ws.messageCount = 0;
    }
    ws.messageCount++;
    if (ws.messageCount > 80) {
      ws.close(1008, 'Too many messages');
      return;
    }

    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (!message || typeof message.type !== 'string') return;

    if (message.type === 'join') {
      if (ws.authed) {
        joinQueue(ws);
        return;
      }
      const auth = verifyTelegramInitData(message.initData || '');
      if (!auth.ok) {
        console.warn(`[AUTH] ${auth.code || 'AUTH_FAILED'}: ${auth.error}`);
        send(ws, { type: 'error', code: auth.code || 'AUTH_FAILED', message: auth.error });
        ws.close(1008, 'Telegram authentication failed');
        return;
      }
      ws.authed = true;
      ws.telegramUser = auth.user;
      ws.guestName = cleanName(message.name || 'Гость');
      joinQueue(ws);
      return;
    }

    if (message.type === 'queue' && ws.authed) {
      joinQueue(ws);
      return;
    }

    if (message.type === 'leave') {
      removePlayer(ws);
      return;
    }

    if (message.type === 'input' && ws.player && ws.room && !ws.room.over) {
      const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
      const x = number(message.x);
      const y = number(message.y);
      const aimX = number(message.aimX);
      const aimY = number(message.aimY);
      ws.player.input.x = Math.max(-1, Math.min(1, x));
      ws.player.input.y = Math.max(-1, Math.min(1, y));
      const clampedAimX = Math.max(-1, Math.min(1, aimX));
      const clampedAimY = Math.max(-1, Math.min(1, aimY));
      const aimLength = Math.hypot(clampedAimX, clampedAimY) || 1;
      ws.player.input.aimX = clampedAimX / aimLength;
      ws.player.input.aimY = clampedAimY / aimLength;
      ws.player.input.fire = Boolean(message.fire);
    }
  });

  ws.on('close', () => removePlayer(ws));
  ws.on('error', () => removePlayer(ws));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) tickRoom(room, now);
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Strike Arena server listening on :${PORT}`);
  if (!BOT_TOKEN && !ALLOW_GUESTS) console.warn('BOT_TOKEN is missing and guests are disabled; joins will be rejected.');
  if (!ALLOWED_ORIGIN) console.warn('ALLOWED_ORIGIN is empty; WebSocket connections are not restricted by Origin.');
});

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
