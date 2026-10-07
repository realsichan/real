const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = __dirname;

const rooms = new Map();
const MAX_PLAYERS = 8;
const ADMIN_PASSWORD = 'hanchan0705';

const records = [];

// =========================
// 기본 유틸
// =========================

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function roomCode() {
  let code;

  do {
    code = crypto
      .randomBytes(4)
      .toString('base64')
      .replace(/[^A-Z0-9]/gi, '')
      .toUpperCase()
      .slice(0, 5);
  } while (!code || rooms.has(code));

  return code;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    carId: p.carId,
    ready: !!p.ready,
    host: !!p.host,
    state: p.state,
    finished: !!p.finished
  }));
}

// =========================
// 렉 개선된 broadcast
// =========================

function broadcast(room, msg) {
  const data = JSON.stringify(msg);

  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === p.ws.OPEN) {
      p.ws.send(data);
    }
  }
}

// =========================
// 랭킹
// =========================

function buildRankings(room) {
  return [...room.players.values()]
    .filter(p => p.finished)
    .sort((a, b) => {
      const at = Number(a.finishTime) || Infinity;
      const bt = Number(b.finishTime) || Infinity;
      return at - bt;
    })
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      time: p.finishTime
    }));
}

// =========================
// HTTP 서버
// =========================

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 상태 확인
  if (url.pathname === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8'
    });

    res.end(JSON.stringify({
      ok: true,
      rooms: rooms.size
    }));

    return;
  }

  // 기록 가져오기
  if (url.pathname === '/api/records' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8'
    });

    res.end(JSON.stringify(records));
    return;
  }

  // 기록 삭제
  if (url.pathname === '/api/records' && req.method === 'DELETE') {
    let body = '';

    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');

        if (data.password !== ADMIN_PASSWORD) {
          res.writeHead(403, {
            'Content-Type': 'application/json; charset=utf-8'
          });

          res.end(JSON.stringify({
            ok: false,
            error: '비밀번호가 틀렸습니다.'
          }));

          return;
        }

        records.length = 0;

        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
          ok: true
        }));

      } catch (err) {
        res.writeHead(400, {
          'Content-Type': 'application/json; charset=utf-8'
        });

        res.end(JSON.stringify({
          ok: false,
          error: '잘못된 요청입니다.'
        }));
      }
    });

    return;
  }

  // =========================
  // 정적 파일
  // =========================

  let filePath;

  if (url.pathname === '/' || url.pathname === '/index.html') {
    filePath = path.join(PUBLIC, 'index.html');
  } else {
    filePath = path.join(PUBLIC, url.pathname);
  }

  filePath = path.normalize(filePath);

  // 상위 폴더 접근 방지
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8'
      });

      res.end('Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();

    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp'
    };

    res.writeHead(200, {
      'Content-Type':
        contentTypes[ext] || 'application/octet-stream'
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

// =========================
// WebSocket
// =========================

const wss = new WebSocketServer({
  server
});

wss.on('connection', ws => {
  const me = {
    ws,
    id: crypto.randomUUID(),
    name: '플레이어',
    room: null,
    host: false,
    ready: false,
    carId: 0,
    finished: false,
    finishTime: null,

    state: {
      x: 0,
      y: 0,
      z: 0,
      rot: 0,
      color: 0xffffff,
      lap: 1,
      speed: 0
    }
  };

  // =========================
  // 메시지 수신
  // =========================

  ws.on('message', raw => {
    let m;

    try {
      m = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // -------------------------
    // 방 만들기
    // -------------------------

    if (m.type === 'createRoom') {
      if (me.room) return;

      const code = roomCode();

      const room = {
        code,
        hostId: me.id,
        players: new Map(),

        started: false,
        mapId: null,
        randomMap: false,

        finishDeadline: 0
      };

      rooms.set(code, room);

      me.room = code;
      me.host = true;

      room.players.set(me.id, me);

      send(ws, {
        type: 'roomCreated',
        code,
        players: publicPlayers(room)
      });

      return;
    }

    // -------------------------
    // 방 참가
    // -------------------------

    if (m.type === 'joinRoom') {
      if (me.room) return;

      const code = String(m.code || '').toUpperCase();
      const room = rooms.get(code);

      if (!room) {
        send(ws, {
          type: 'error',
          message: '방을 찾을 수 없습니다.'
        });

        return;
      }

      if (room.started) {
        send(ws, {
          type: 'error',
          message: '이미 게임이 시작된 방입니다.'
        });

        return;
      }

      if (room.players.size >= MAX_PLAYERS) {
        send(ws, {
          type: 'error',
          message: '방이 가득 찼습니다.'
        });

        return;
      }

      me.room = code;
      me.name =
        String(m.name || '플레이어').slice(0, 16);

      room.players.set(me.id, me);

      send(ws, {
        type: 'roomJoined',
        code,
        players: publicPlayers(room)
      });

      broadcast(room, {
        type: 'players',
        players: publicPlayers(room)
      });

      return;
    }

    // -------------------------
    // 이름 변경
    // -------------------------

    if (m.type === 'name') {
      me.name =
        String(m.name || '플레이어').slice(0, 16);

      if (me.room) {
        const room = rooms.get(me.room);

        if (room) {
          broadcast(room, {
            type: 'players',
            players: publicPlayers(room)
          });
        }
      }

      return;
    }

    // -------------------------
    // 카트 선택
    // -------------------------

    if (m.type === 'carSelect') {
      me.carId = Number(m.carId) || 0;

      if (me.room) {
        const room = rooms.get(me.room);

        if (room) {
          broadcast(room, {
            type: 'players',
            players: publicPlayers(room)
          });
        }
      }

      return;
    }

    // -------------------------
    // 준비
    // -------------------------

    if (m.type === 'ready') {
      me.ready = !!m.ready;

      if (me.room) {
        const room = rooms.get(me.room);

        if (room) {
          broadcast(room, {
            type: 'players',
            players: publicPlayers(room)
          });
        }
      }

      return;
    }

    // -------------------------
    // 맵 선택
    // -------------------------

    if (m.type === 'mapSelect') {
      if (!me.room) return;

      const room = rooms.get(me.room);
      if (!room) return;

      if (room.hostId !== me.id) return;

      room.mapId = m.mapId;
      room.randomMap = false;

      broadcast(room, {
        type: 'mapSelected',
        mapId: room.mapId,
        random: false
      });

      return;
    }

    // -------------------------
    // 랜덤 맵
    // -------------------------

    if (m.type === 'randomMap') {
      if (!me.room) return;

      const room = rooms.get(me.room);
      if (!room) return;

      if (room.hostId !== me.id) return;

      room.randomMap = true;
      room.mapId = null;

      broadcast(room, {
        type: 'mapSelected',
        mapId: null,
        random: true
      });

      return;
    }

    // -------------------------
    // 게임 시작
    // -------------------------

    if (m.type === 'start') {
      if (!me.room) return;

      const room = rooms.get(me.room);
      if (!room) return;

      if (room.hostId !== me.id) return;

      if (room.started) return;

      room.started = true;

      room.finishDeadline =
        Date.now() + 10 * 60 * 1000;

      for (const p of room.players.values()) {
        p.finished = false;
        p.finishTime = null;
        p.ready = false;

        p.state = {
          x: 0,
          y: 0,
          z: 0,
          rot: 0,
          color: 0xffffff,
          lap: 1,
          speed: 0
        };
      }

      broadcast(room, {
        type: 'gameStart',
        mapId: room.mapId,
        random: room.randomMap
      });

      return;
    }

    // -------------------------
    // 플레이어 상태
    // -------------------------

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

    // -------------------------
    // 완주
    // -------------------------

    if (m.type === 'finish') {
      if (!me.room) return;

      const room = rooms.get(me.room);
      if (!room) return;

      if (!room.started) return;
      if (me.finished) return;

      me.finished = true;
      me.finishTime = Number(m.time) || 0;

      const rankings = buildRankings(room);

      broadcast(room, {
        type: 'playerFinish',
        player: {
          id: me.id,
          name: me.name,
          time: me.finishTime
        },
        rankings
      });

      return;
    }

    // -------------------------
    // 방 나가기
    // -------------------------

    if (m.type === 'leave') {
      leaveRoom(me);
      return;
    }
  });

  // =========================
  // 연결 종료
  // =========================

  ws.on('close', () => {
    leaveRoom(me);
  });
});

// =========================
// 방 나가기 처리
// =========================

function leaveRoom(me) {
  if (!me.room) return;

  const room = rooms.get(me.room);

  if (!room) {
    me.room = null;
    return;
  }

  room.players.delete(me.id);

  const wasHost = room.hostId === me.id;

  me.room = null;
  me.host = false;

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  // 호스트가 나가면 다른 플레이어에게 넘김
  if (wasHost) {
    const next = room.players.values().next().value;

    if (next) {
      room.hostId = next.id;

      for (const p of room.players.values()) {
        p.host = p.id === room.hostId;
      }

      send(next.ws, {
        type: 'hostChanged',
        hostId: room.hostId
      });
    }
  }

  broadcast(room, {
    type: 'playerLeave',
    id: me.id,
    players: publicPlayers(room)
  });
}

// =========================
// 온라인 상태 전송 루프
// =========================
//
// 기존 약 66ms → 100ms
// 초당 약 15회 → 10회
//
// 플레이어가 많을수록 네트워크/CPU 사용량 감소
// =========================

setInterval(() => {
  for (const room of rooms.values()) {

    // 게임 시간 초과
    if (
      room.started &&
      room.finishDeadline &&
      Date.now() >= room.finishDeadline
    ) {
      room.started = false;

      const rankings = buildRankings(room);

      for (const p of room.players.values()) {
        if (!p.finished) {
          send(p.ws, {
            type: 'raceTimeout'
          });
        }
      }

      broadcast(room, {
        type: 'raceEnd',
        reason: 'timeout',
        rankings
      });

      continue;
    }

    if (!room.started) continue;

    const players = [
      ...room.players.values()
    ].map(p => ({
      id: p.id,
      name: p.name,
      ...p.state,
      carId: p.carId,
      finished: !!p.finished
    }));

    broadcast(room, {
      type: 'snapshot',
      players
    });
  }
}, 100);

// =========================
// 서버 시작
// =========================

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
