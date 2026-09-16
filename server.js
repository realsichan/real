const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = __dirname;

const rooms = new Map();
const MAX_PLAYERS = 8;

const ADMIN_PASSWORD = 'hanchan0705';

let records = [];

// -------------------------
// 기록 게시판
// -------------------------

function sortRecords() {
  records.sort((a, b) => {
    return a.time - b.time || a.date - b.date;
  });
}

function mergeRecord(input) {
  const nickname =
    String(input.nickname || '플레이어')
      .trim()
      .slice(0, 12) || '플레이어';

  const map = String(input.map || '').slice(0, 80);
  const time = Number(input.time);

  if (!map || !Number.isFinite(time) || time <= 0) {
    return;
  }

  const next = {
    nickname,
    map,
    time,
    stars: Number(input.stars) || 0,
    car: String(input.car || '-').slice(0, 40),
    date: Number(input.date) || Date.now()
  };

  // 같은 맵 + 같은 닉네임이면 최고 기록 하나만 유지
  const idx = records.findIndex(
    r =>
      r.map === map &&
      r.nickname.toLowerCase() === nickname.toLowerCase()
  );

  if (idx >= 0) {
    if (time < records[idx].time) {
      records[idx] = next;
    }
  } else {
    records.push(next);
  }

  sortRecords();
}

// -------------------------
// 공통
// -------------------------

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
  return [...room.players.values()].map(p => ({
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

  // 방장이 나갔으면 다음 사람을 방장으로 지정
  if (room.hostId === id) {
    room.hostId =
      room.players.keys().next().value || null;
  }

  // 아무도 없으면 방 삭제
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }

  // 레이스 도중 방장이 나간 경우 일단 레이스 종료 상태로 되돌림
  if (room.started) {
    room.started = false;
  }

  syncPlayers(room);
}

// -------------------------
// HTTP 서버
// -------------------------

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', chunk => {
      body += chunk;

      if (body.length > 100000) {
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {

  // 상태 확인
  if (req.url === '/health') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8'
    });

    return res.end(
      JSON.stringify({
        ok: true,
        rooms: rooms.size
      })
    );
  }

  // -----------------------
  // 기록 조회
  // -----------------------

  if (
    req.url === '/api/records' &&
    req.method === 'GET'
  ) {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });

    return res.end(
      JSON.stringify(records.slice(0, 500))
    );
  }

  // -----------------------
  // 기록 등록
  // -----------------------

  if (
    req.url === '/api/records' &&
    req.method === 'POST'
  ) {
    try {
      const data = await readJson(req);

      mergeRecord(data);

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });

      return res.end(
        JSON.stringify(records.slice(0, 500))
      );

    } catch (error) {
      res.writeHead(400);
      return res.end('Bad request');
    }
  }

  // -----------------------
  // 기록 삭제
  // -----------------------

  if (
    req.url === '/api/records' &&
    req.method === 'DELETE'
  ) {
    try {
      const data = await readJson(req);

      if (data.password !== ADMIN_PASSWORD) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      // 전체 기록 초기화
      if (data.reset) {
        records = [];
      }

      // 특정 맵 + 닉네임 기록 삭제
      else {
        const map = String(data.map || '');

        const nickname = String(
          data.nickname || ''
        )
          .trim()
          .toLowerCase();

        records = records.filter(r => {
          return !(
            r.map === map &&
            r.nickname.toLowerCase() === nickname
          );
        });
      }

      sortRecords();

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });

      return res.end(
        JSON.stringify(records.slice(0, 500))
      );

    } catch (error) {
      res.writeHead(400);
      return res.end('Bad request');
    }
  }

  // -----------------------
  // 정적 파일
  // -----------------------

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

    let type = 'application/octet-stream';

    if (ext === '.html') {
      type = 'text/html; charset=utf-8';
    }

    if (ext === '.js') {
      type = 'text/javascript; charset=utf-8';
    }

    if (ext === '.css') {
      type = 'text/css; charset=utf-8';
    }

    res.writeHead(200, {
      'content-type': type
    });

    res.end(data);
  });
});

// -------------------------
// WebSocket
// -------------------------

const wss = new WebSocketServer({
  server
});

wss.on('connection', ws => {
  const id = uid();

  ws.playerId = id;
  ws.roomCode = null;

  send(ws, {
    type: 'hello',
    id
  });

  ws.on('message', buf => {
    let m;

    try {
      m = JSON.parse(buf.toString());
    } catch {
      return;
    }

    // -----------------------
    // 방 만들기
    // -----------------------

    if (m.type === 'createRoom') {
      leave(ws);

      const code = roomCode();

      const player = {
        id,
        ws,
        name: String(
          m.name || '플레이어'
        ).slice(0, 12),

        carId:
          Number.isFinite(Number(m.carId))
            ? Number(m.carId)
            : 0,

        ready: false,

        state: {}
      };

      const room = {
        code,
        hostId: id,

        mapId:
          Number.isFinite(Number(m.mapId))
            ? Number(m.mapId)
            : 0,

        started: false,

        players: new Map([
          [id, player]
        ])
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

    // -----------------------
    // 방 참가
    // -----------------------

    if (m.type === 'joinRoom') {
      const code = String(
        m.code || ''
      ).toUpperCase();

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

        name: String(
          m.name || '플레이어'
        ).slice(0, 12),

        carId:
          Number.isFinite(Number(m.carId))
            ? Number(m.carId)
            : 0,

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

    // 방이 없는 상태에서 아래 메시지는 무시
    const room = rooms.get(ws.roomCode);

    if (!room) return;

    const me = room.players.get(id);

    if (!me) return;

    // -----------------------
    // 차 선택
    // -----------------------

    if (m.type === 'carSelect') {
      if (room.started) return;

      const carId = Number(m.carId);

      if (Number.isFinite(carId)) {
        me.carId = carId;
      }

      // 차를 다시 고르면 준비 취소
      me.ready = false;

      syncPlayers(room);

      return;
    }

    // -----------------------
    // 준비
    // -----------------------

    if (m.type === 'ready') {
      if (room.started) return;

      me.ready = !!m.ready;

      if (Number.isFinite(Number(m.carId))) {
        me.carId = Number(m.carId);
      }

      syncPlayers(room);

      return;
    }

    // -----------------------
    // 방장 맵 선택
    // -----------------------

    if (m.type === 'mapSelect') {
      if (room.started) return;

      if (room.hostId !== id) {
        return;
      }

      const mapId = Number(m.mapId);

      if (Number.isFinite(mapId)) {
        room.mapId = mapId;
      }

      // 맵이 바뀌면 준비 상태 초기화
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

    // -----------------------
    // 레이스 시작
    // -----------------------

    if (m.type === 'startRace') {

      if (room.hostId !== id) {
        return send(ws, {
          type: 'error',
          message:
            '방장만 레이스를 시작할 수 있습니다.'
        });
      }

      const allReady =
        room.players.size > 0 &&
        [...room.players.values()]
          .every(p => p.ready);

      if (!allReady) {
        return send(ws, {
          type: 'error',
          message:
            '모든 플레이어가 준비해야 합니다.'
        });
      }

      if (Number.isFinite(Number(m.mapId))) {
        room.mapId = Number(m.mapId);
      }

      room.started = true;

      // 레이스 시작 후 준비 상태 초기화
      for (const p of room.players.values()) {
        p.ready = false;
      }

      broadcast(room, {
        type: 'raceStart',
        mapId: room.mapId
      });

      return;
    }

    // -----------------------
    // 실시간 카트 상태
    // -----------------------

    if (m.type === 'state') {
      me.state = {
        x: Number(m.x) || 0,
        y: Number(m.y) || 0,
        z: Number(m.z) || 0,

        rot:
          Number(m.rot) || 0,

        color:
          Number(m.color) || 0xffffff,

        lap:
          Number(m.lap) || 1,

        speed:
          Number(m.speed) || 0
      };

      return;
    }
  });

  ws.on('close', () => {
    leave(ws);
  });

  ws.on('error', () => {
    leave(ws);
  });
});

// -------------------------
// 실시간 상태 전송
// 약 15 FPS
// -------------------------

setInterval(() => {
  for (const room of rooms.values()) {

    if (!room.started) continue;

    const players = [
      ...room.players.values()
    ].map(p => ({
      id: p.id,
      ...p.state
    }));

    broadcast(room, {
      type: 'snapshot',
      players
    });
  }
}, 66);

// -------------------------
// 서버 시작
// -------------------------

server.listen(PORT, () => {
  console.log(
    `MINI KART server listening on ${PORT}`
  );
});
