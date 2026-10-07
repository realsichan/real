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

const MAP_STARS = [1,1,4,4,3,3,2,5,1,4,3,2,5];

function sortRecords(){
  records.sort((a,b)=>a.time-b.time || a.date-b.date);
}

function mergeRecord(input){
  const nickname =
    String(input.nickname || '플레이어')
      .trim()
      .slice(0,12) || '플레이어';

  const map = String(input.map || '').slice(0,80);
  const time = Number(input.time);

  if(!map || !Number.isFinite(time) || time <= 0) return;

  const next = {
    nickname,
    map,
    time,
    stars: Number(input.stars) || 0,
    car: String(input.car || '-').slice(0,40),
    date: Number(input.date) || Date.now()
  };

  const idx = records.findIndex(
    r =>
      r.map === map &&
      r.nickname.toLowerCase() === nickname.toLowerCase()
  );

  if(idx >= 0){
    if(time < records[idx].time){
      records[idx] = next;
    }
  }else{
    records.push(next);
  }

  sortRecords();
}

const uid = () =>
  crypto.randomBytes(8).toString('hex');

function roomCode(){
  let code;

  do{
    code = crypto
      .randomBytes(4)
      .toString('base64')
      .replace(/[^A-Z0-9]/gi,'')
      .slice(0,5)
      .toUpperCase();
  }while(!code || rooms.has(code));

  return code;
}

function send(ws,msg){
  if(ws && ws.readyState === ws.OPEN){
    ws.send(JSON.stringify(msg));
  }
}

function publicPlayers(room){
  return [...room.players.values()].map(p=>({
    id:p.id,
    name:p.name,
    host:p.id === room.hostId,
    carId:p.carId,
    ready:!!p.ready
  }));
}

/*
 * 렉 개선:
 * 같은 메시지를 플레이어마다 JSON.stringify하지 않고
 * 한 번만 문자열로 만든 뒤 전송
 */
function broadcast(room,msg){
  const data = JSON.stringify(msg);

  for(const p of room.players.values()){
    if(p.ws && p.ws.readyState === p.ws.OPEN){
      p.ws.send(data);
    }
  }
}

function syncPlayers(room){
  broadcast(room,{
    type:'players',
    players:publicPlayers(room),
    code:room.code,
    hostId:room.hostId,
    mapId:room.mapId,
    randomMode:room.randomMode
  });
}

function leave(ws){
  const id = ws.playerId;
  const code = ws.roomCode;

  if(!id || !code) return;

  const room = rooms.get(code);

  if(!room) return;

  room.players.delete(id);

  ws.playerId = null;
  ws.roomCode = null;

  if(room.hostId === id){
    room.hostId =
      room.players.keys().next().value || null;
  }

  if(room.players.size === 0){
    rooms.delete(code);
    return;
  }

  syncPlayers(room);
}

function readJson(req){
  return new Promise((resolve,reject)=>{
    let body = '';

    req.on('data',chunk=>{
      body += chunk;

      if(body.length > 100000){
        req.destroy();
      }
    });

    req.on('end',()=>{
      try{
        resolve(body ? JSON.parse(body) : {});
      }catch(e){
        reject(e);
      }
    });

    req.on('error',reject);
  });
}


// =========================
// HTTP 서버
// =========================

const server = http.createServer(async (req,res)=>{

  // 기록 가져오기
  if(
    req.url === '/api/records' &&
    req.method === 'GET'
  ){
    res.writeHead(200,{
      'content-type':
        'application/json; charset=utf-8',
      'cache-control':'no-store'
    });

    return res.end(
      JSON.stringify(records.slice(0,500))
    );
  }


  // 기록 추가
  if(
    req.url === '/api/records' &&
    req.method === 'POST'
  ){
    try{
      const data = await readJson(req);

      mergeRecord(data);

      res.writeHead(200,{
        'content-type':
          'application/json; charset=utf-8',
        'cache-control':'no-store'
      });

      return res.end(
        JSON.stringify(records.slice(0,500))
      );

    }catch(e){
      res.writeHead(400);
      return res.end('Bad request');
    }
  }


  // 기록 삭제
  if(
    req.url === '/api/records' &&
    req.method === 'DELETE'
  ){
    try{
      const data = await readJson(req);

      if(data.password !== ADMIN_PASSWORD){
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if(data.reset){
        records = [];
      }else{
        const map =
          String(data.map || '');

        const nickname =
          String(data.nickname || '')
            .trim()
            .toLowerCase();

        records = records.filter(
          r =>
            !(
              r.map === map &&
              r.nickname.toLowerCase() === nickname
            )
        );
      }

      sortRecords();

      res.writeHead(200,{
        'content-type':
          'application/json; charset=utf-8',
        'cache-control':'no-store'
      });

      return res.end(
        JSON.stringify(records.slice(0,500))
      );

    }catch(e){
      res.writeHead(400);
      return res.end('Bad request');
    }
  }


  // 서버 상태
  if(req.url === '/health'){
    res.writeHead(200,{
      'content-type':'application/json'
    });

    return res.end(
      JSON.stringify({
        ok:true,
        rooms:rooms.size
      })
    );
  }


  // =========================
  // 정적 파일
  // =========================

  let reqPath =
    (req.url || '/').split('?')[0];

  if(reqPath === '/'){
    reqPath = '/index.html';
  }

  const safe =
    path.normalize(reqPath)
      .replace(/^([.][.][\\/])+/,'');

  const file =
    path.join(PUBLIC,safe);

  if(!file.startsWith(PUBLIC)){
    return res
      .writeHead(403)
      .end('Forbidden');
  }

  fs.readFile(file,(err,data)=>{
    if(err){
      res.writeHead(404);
      return res.end('Not found');
    }

    const ext =
      path.extname(file);

    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';

    res.writeHead(200,{
      'content-type':type
    });

    res.end(data);
  });
});


// =========================
// WebSocket 서버
// =========================

const wss =
  new WebSocketServer({
    server
  });

wss.on('connection',(ws)=>{

  const id = uid();

  ws.playerId = id;

  // 접속 직후 자신의 ID 전달
  send(ws,{
    type:'hello',
    id
  });


  ws.on('message',(buf)=>{

    let m;

    try{
      m = JSON.parse(
        buf.toString()
      );
    }catch{
      return;
    }


    // =========================
    // 방 만들기
    // =========================

    if(m.type === 'createRoom'){

      leave(ws);

      const code = roomCode();

      const player = {
        id,
        ws,
        name:
          String(
            m.name || '플레이어'
          ).slice(0,12),

        carId:
          Number(m.carId || 0),

        ready:false,
        finished:false,
        state:{}
      };

      const room = {
        code,
        hostId:id,

        mapId:
          Number(m.mapId || 0),

        randomMode:null,

        started:false,

        firstFinisherId:null,

        finishDeadline:0,

        finishRanks:[],

        players:
          new Map([
            [id,player]
          ])
      };

      rooms.set(code,room);

      ws.roomCode = code;

      // 현재 HTML이 기다리는 메시지
      send(ws,{
        type:'room',
        code,
        hostId:id,
        mapId:room.mapId,
        randomMode:room.randomMode,
        players:
          publicPlayers(room)
      });

      return;
    }


    // =========================
    // 방 참가
    // =========================

    if(m.type === 'joinRoom'){

      const code =
        String(m.code || '')
          .toUpperCase();

      const room =
        rooms.get(code);

      if(!room){
        return send(ws,{
          type:'error',
          message:'방을 찾을 수 없습니다.'
        });
      }

      if(room.started){
        return send(ws,{
          type:'error',
          message:'이미 시작된 방입니다.'
        });
      }

      if(
        room.players.size >=
        MAX_PLAYERS
      ){
        return send(ws,{
          type:'error',
          message:'방이 가득 찼습니다.'
        });
      }

      leave(ws);

      room.players.set(
        id,
        {
          id,
          ws,

          name:
            String(
              m.name || '플레이어'
            ).slice(0,12),

          carId:
            Number(m.carId || 0),

          ready:false,
          finished:false,
          state:{}
        }
      );

      if(!room.hostId){
        room.hostId = id;
      }

      ws.roomCode = code;

      send(ws,{
        type:'room',
        code,
        hostId:room.hostId,
        mapId:room.mapId,
        randomMode:room.randomMode,
        players:
          publicPlayers(room)
      });

      syncPlayers(room);

      return;
    }


    // 방에 들어와 있지 않으면
    // 아래 명령들은 처리하지 않음
    const room =
      rooms.get(ws.roomCode);

    if(!room) return;

    const me =
      room.players.get(id);

    if(!me) return;


    // =========================
    // 카트 선택
    // =========================

    if(m.type === 'carSelect'){

      if(room.started) return;

      me.carId =
        Number.isFinite(
          Number(m.carId)
        )
          ? Number(m.carId)
          : 0;

      me.ready = false;

      syncPlayers(room);

      return;
    }


    // =========================
    // 준비
    // =========================

    if(m.type === 'ready'){

      if(room.started) return;

      me.ready = !!m.ready;

      if(
        Number.isFinite(
          Number(m.carId)
        )
      ){
        me.carId =
          Number(m.carId);
      }

      syncPlayers(room);

      return;
    }


    // =========================
    // 맵 선택
    // =========================

    if(m.type === 'mapSelect'){

      if(
        room.started ||
        room.hostId !== id
      ){
        return;
      }

      room.mapId =
        Number(m.mapId || 0);

      room.randomMode = null;

      // 맵 변경하면 모두 다시 준비
      for(
        const p of room.players.values()
      ){
        p.ready = false;
      }

      broadcast(room,{
        type:'mapSelected',
        mapId:room.mapId,
        randomMode:room.randomMode,
        players:
          publicPlayers(room)
      });

      return;
    }


    // =========================
    // 랜덤 맵
    // =========================

    if(m.type === 'randomMap'){

      if(
        room.started ||
        room.hostId !== id
      ){
        return;
      }

      const stars =
        m.stars === null ||
        m.stars === undefined
          ? null
          : Math.max(
              1,
              Math.min(
                5,
                Number(m.stars) || 1
              )
            );

      room.randomMode =
        stars === null
          ? -1
          : stars;

      for(
        const p of room.players.values()
      ){
        p.ready = false;
      }

      broadcast(room,{
        type:'mapSelected',
        mapId:room.mapId,
        randomMode:room.randomMode,
        players:
          publicPlayers(room)
      });

      return;
    }


    // =========================
    // 레이스 시작
    // =========================

    if(m.type === 'startRace'){

      if(room.hostId !== id){

        return send(ws,{
          type:'error',
          message:
            '방장만 레이스를 시작할 수 있습니다.'
        });
      }

      const allReady =
        room.players.size > 0 &&
        [
          ...room.players.values()
        ].every(
          p => p.ready
        );

      if(!allReady){

        return send(ws,{
          type:'error',
          message:
            '모든 플레이어가 준비해야 합니다.'
        });
      }


      // 랜덤 맵 처리
      if(
        room.randomMode !== null &&
        room.randomMode !== undefined
      ){

        const candidates =
          MAP_STARS
            .map(
              (stars,i)=>({
                stars,
                i
              })
            )
            .filter(
              x =>
                room.randomMode === -1 ||
                x.stars === room.randomMode
            );

        if(candidates.length){

          room.mapId =
            candidates[
              Math.floor(
                Math.random() *
                candidates.length
              )
            ].i;
        }

      }else{

        if(
          Number.isFinite(
            Number(m.mapId)
          )
        ){
          room.mapId =
            Number(m.mapId);
        }
      }


      const actualMapId =
        room.mapId;

      room.randomMode = null;

      room.started = true;

      room.firstFinisherId = null;

      room.finishDeadline = 0;

      room.finishRanks = [];


      for(
        const p of room.players.values()
      ){
        p.ready = false;
        p.finished = false;
        p.state = {};
      }


      // 현재 HTML이 기다리는 메시지
      broadcast(room,{
        type:'raceStart',
        mapId:actualMapId
      });

      return;
    }


    // =========================
    // 완주
    // =========================

    if(m.type === 'finishRace'){

      if(
        !room.started ||
        me.finished
      ){
        return;
      }

      me.finished = true;

      const rank =
        room.finishRanks.length + 1;

      room.finishRanks.push({
        id,
        time:
          Number(m.time) || 0,
        rank
      });


      // 첫 완주자가 나오면
      // 10초 동안 나머지 플레이어 대기
      if(!room.firstFinisherId){

        room.firstFinisherId = id;

        room.finishDeadline =
          Date.now() + 10000;

        broadcast(room,{
          type:'firstFinish',
          id,
          remaining:10000
        });

      }else{

        send(ws,{
          type:'raceFinished',
          rank
        });
      }


      // 전원 완주
      if(
        room.finishRanks.length >=
        room.players.size
      ){

        room.started = false;

        const rankings =
          buildRankings(room);

        broadcast(room,{
          type:'raceEnd',
          reason:'allFinished',
          rankings
        });
      }

      return;
    }


    // =========================
    // 플레이어 위치/상태
    // =========================

    if(m.type === 'state'){

      me.state = {
        x:Number(m.x) || 0,
        y:Number(m.y) || 0,
        z:Number(m.z) || 0,
        rot:Number(m.rot) || 0,
        color:
          Number(m.color) ||
          0xffffff,
        lap:
          Number(m.lap) || 1,
        speed:
          Number(m.speed) || 0
      };

      return;
    }

  });


  // 연결 종료
  ws.on('close',()=>{
    leave(ws);
  });

  ws.on('error',()=>{
    leave(ws);
  });

});


// =========================
// 랭킹
// =========================

function buildRankings(room){

  const finished =
    [
      ...room.finishRanks
    ]
      .sort(
        (a,b)=>a.rank-b.rank
      )
      .map(r=>{

        const p =
          room.players.get(r.id);

        return {
          rank:r.rank,
          id:r.id,
          name:
            p?.name || '플레이어',
          time:r.time,
          car:
            carsName(
              p?.carId
            ),
          finished:true
        };
      });


  const finishedIds =
    new Set(
      finished.map(
        r=>r.id
      )
    );


  const dnf =
    [
      ...room.players.values()
    ]
      .filter(
        p =>
          !finishedIds.has(p.id)
      )
      .map(
        (p,i)=>({
          rank:
            finished.length + i + 1,
          id:p.id,
          name:
            p.name || '플레이어',
          time:0,
          car:
            carsName(p.carId),
          finished:false
        })
      );


  return finished.concat(dnf);
}


function carsName(carId){

  const names = [
    '레드 볼트',
    '블루 스톰',
    '퍼플 드리프터',
    '그린 스프린터',
    '충돌형 카트'
  ];

  return (
    names[Number(carId)] ||
    '-'
  );
}


// =========================
// 온라인 상태 전송
// =========================
//
// 기존보다 전송 빈도를 낮춰
// 여러 명이 동시에 플레이할 때
// 네트워크 부담을 줄임.
//
// 100ms = 초당 약 10회
// =========================

setInterval(()=>{

  for(
    const room of rooms.values()
  ){

    // 레이스 종료 제한시간
    if(
      room.started &&
      room.finishDeadline &&
      Date.now() >=
        room.finishDeadline
    ){

      room.started = false;

      const rankings =
        buildRankings(room);


      for(
        const p of room.players.values()
      ){

        if(!p.finished){

          send(p.ws,{
            type:'raceTimeout'
          });
        }
      }


      broadcast(room,{
        type:'raceEnd',
        reason:'timeout',
        rankings
      });

      continue;
    }


    if(!room.started){
      continue;
    }


    const players =
      [
        ...room.players.values()
      ].map(p=>({
        id:p.id,
        name:p.name,
        ...p.state,
        carId:p.carId,
        finished:!!p.finished
      }));


    broadcast(room,{
      type:'snapshot',
      players
    });

  }

},100);


// =========================
// 서버 시작
// =========================

server.listen(
  PORT,
  ()=>{
    console.log(
      `MINI KART server listening on ${PORT}`
    );
  }
);
