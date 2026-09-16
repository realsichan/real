const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = __dirname;
const rooms = new Map();
const MAX_PLAYERS = 8;

const uid = () => crypto.randomBytes(8).toString('hex');

function roomCode() {
  let code;
  do {
    code = crypto
      .randomBytes(4)
      .toString('base64')
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 5)
      .toUpperCase();
  } while (!code || rooms.has(code));

  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    host: p.id === room.hostId,
    carId: p.carId,
    ready: !!p.ready
  }));
}

function broadcast(room, msg) {
  for (const p of room.players.values()) {
    send(p.ws, msg);
  }
}

function syncPlayers(room) {
  broadcast(room, {
    type: 'players',
    players: publicPlayers(room),
    code: room.code,
    hostId: room.hostId,
    mapId: room.mapId
  });
}

function leave(ws) {
  const id = ws.playerId;
  const code = ws.roomCode;

  if (!id || !code) return;

  const room = rooms.get(code);
  if (!room) return;

  room.players.delete(id);

  ws.playerId = null;
  ws.roomCode = null;

  if (room.hostId === id) {
    room.hostId = room.players.keys().next().value || null;
  }

  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.started) {
    room.started = false;
  }

  syncPlayers(room);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json'
    });

    return res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size
      })
    );
  }

  let reqPath = (req.url || '/').split('?')[0];

  if (reqPath === '/') {
    reqPath = '/index.html';
  }

  const safe = path
    .normalize(reqPath)
    .replace(/^([.][.][\\/])+/, '');

  const file = path.join(PUBLIC, safe);

  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }

    const ext = path.extname(file);

    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';

    res.writeHead(200, {
      'content-type': type
    });

    res.end(data);
  });
});

const wss = new WebSocketServer({
  server
});

wss.on('connection', (ws) => {
  const id = uid();

  ws.playerId = id;

  send(ws, {
    type: 'hello',
    id
  });

  ws.on('message', (buf) => {
    let m;

    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }

    if (m.type === 'createRoom') {
      leave(ws);

      const code = roomCode();

      const player = {
        id,
        ws,
        name: String(m.name || '플레이어').slice(0, 12),
        carId: Number(m.carId || 0),
        ready: false,
        state: {}
      };

      const room = {
        code,
        hostId: id,
        mapId: Number(m.mapId || 0),
        started: false,
        players: new Map([[id, player]])
      };

      rooms.set(code, room);
      ws.roomCode = code;

      send(ws, {
        type: 'room',
        code,
        hostId: id,
        mapId: room.mapId,
        players: publicPlayers(room)
      });

      return;
    }

    if (m.type === 'joinRoom') {
      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        return send(ws, {
          type: 'error',
          message: '방을 찾을 수 없습니다.'
        });
      }

      if (room.started) {
        return send(ws, {
          type: 'error',
          message: '이미 시작된 방입니다.'
        });
      }

      if (room.players.size >= MAX_PLAYERS) {
        return send(ws, {
          type: 'error',
          message: '방이 가득 찼습니다.'
        });
      }

      leave(ws);

      room.players.set(id, {
        id,
        ws,
        name: String(m.name || '플레이어').slice(0, 12),
        carId: Number(m.carId || 0),
        ready: false,
        state: {}
      });

      ws.roomCode = code;

      send(ws, {
        type: 'room',
        code,
        hostId: room.hostId,
        mapId: room.mapId,
        players: publicPlayers(room)
      });

      syncPlayers(room);
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;

    const me = room.players.get(id);
    if (!me) return;

    if (m.type === 'carSelect') {
      if (room.started) return;

      me.carId = Number.isFinite(Number(m.carId))
        ? Number(m.carId)
        : 0;

      me.ready = false;

      syncPlayers(room);
      return;
    }

    if (m.type === 'ready') {
      if (room.started) return;

      me.ready = !!m.ready;

      if (Number.isFinite(Number(m.carId))) {
        me.carId = Number(m.carId);
      }

      syncPlayers(room);
      return;
    }

    if (m.type === 'mapSelect') {
      if (room.started || room.hostId !== id) return;

      room.mapId = Number(m.mapId || 0);

      for (const p of room.players.values()) {
        p.ready = false;
      }

      broadcast(room, {
        type: 'mapSelected',
        mapId: room.mapId,
        players: publicPlayers(room)
      });

      return;
    }

    if (m.type === 'startRace') {
      if (room.hostId !== id) {
        return send(ws, {
          type: 'error',
          message: '방장만 레이스를 시작할 수 있습니다.'
        });
      }

      const allReady =
        room.players.size > 0 &&
        [...room.players.values()].every((p) => p.ready);

      if (!allReady) {
        return send(ws, {
          type: 'error',
          message: '모든 플레이어가 준비해야 합니다.'
        });
      }

      room.mapId = Number.isFinite(Number(m.mapId))
        ? Number(m.mapId)
        : room.mapId;

      room.started = true;

      for (const p of room.players.values()) {
        p.ready = false;
      }

      broadcast(room, {
        type: 'raceStart',
        mapId: room.mapId
      });

      return;
    }

    if (m.type === 'state') {
      me.state = {
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
        z: Number(m.z) || 0,
        rot: Number(m.rot) || 0,
        color: Number(m.color) || 0xffffff,
        lap: Number(m.lap) || 1,
        speed: Number(m.speed) || 0
      };

      return;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;

    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      ...p.state
    }));

    broadcast(room, {
      type: 'snapshot',
      players
    });
  }
}, 66);

server.listen(PORT, () => {
  console.log(`MINI KART server listening on ${PORT}`);
});
