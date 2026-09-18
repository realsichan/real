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

function sortRecords(){ records.sort((a,b)=>a.time-b.time || a.date-b.date); }

function mergeRecord(input){
  const nickname = String(input.nickname || '플레이어').trim().slice(0,12) || '플레이어';
  const map = String(input.map || '').slice(0,80);
  const time = Number(input.time);

  if(!map || !Number.isFinite(time) || time <= 0) return;

  const next = {
    nickname,
    map,
    time,
    stars:Number(input.stars)||0,
    car:String(input.car||'-').slice(0,40),
    date:Number(input.date)||Date.now()
  };

  const idx = records.findIndex(
    r => r.map === map &&
    r.nickname.toLowerCase() === nickname.toLowerCase()
  );

  if(idx >= 0){
    if(time < records[idx].time) records[idx] = next;
  } else {
    records.push(next);
  }

  sortRecords();
}

const uid = () => crypto.randomBytes(8).toString('hex');

function roomCode(){
  let code;

  do {
    code = crypto.randomBytes(4)
      .toString('base64')
      .replace(/[^A-Z0-9]/gi,'')
      .slice(0,5)
      .toUpperCase();
  } while(!code || rooms.has(code));

  return code;
}

function send(ws,msg){
  if(ws && ws.readyState===ws.OPEN){
    ws.send(JSON.stringify(msg));
  }
}

function publicPlayers(room){
  return [...room.players.values()].map(p=>({
    id:p.id,
    name:p.name,
    host:p.id===room.hostId,
    carId:p.carId,
    ready:!!p.ready
  }));
}

function broadcast(room,msg){
  for(const p of room.players.values()){
    send(p.ws,msg);
  }
}

function syncPlayers(room){
  broadcast(room,{
    type:'players',
    players:publicPlayers(room),
    code:room.code,
    hostId:room.hostId,
    mapId:room.mapId
  });
}

function leave(ws){
  const id=ws.playerId;
  const code=ws.roomCode;

  if(!id || !code) return;

  const room=rooms.get(code);

  if(!room) return;

  room.players.delete(id);

  ws.playerId=null;
  ws.roomCode=null;

  if(room.hostId===id){
    room.hostId=room.players.keys().next().value || null;
  }

  if(room.players.size===0){
    room.hostId=null;
    room.started=false;
    room.firstFinisherId=null;
    room.finishDeadline=0;
    room.finishRanks=[];
    return;
  }

  syncPlayers(room);
}

function readJson(req){
  return new Promise((resolve,reject)=>{
    let body='';

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

const server=http.createServer(async (req,res)=>{

  if(req.url==='/api/records' && req.method==='GET'){
    res.writeHead(200,{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store'
    });

    return res.end(JSON.stringify(records.slice(0,500)));
  }

  if(req.url==='/api/records' && req.method==='POST'){
    try{
      const data=await readJson(req);

      mergeRecord(data);

      res.writeHead(200,{
        'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store'
      });

      return res.end(JSON.stringify(records.slice(0,500)));

    }catch(e){
      res.writeHead(400);
      return res.end('Bad request');
    }
  }

  if(req.url==='/api/records' && req.method==='DELETE'){
    try{
      const data=await readJson(req);

      if(data.password !== ADMIN_PASSWORD){
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if(data.reset){
        records=[];
      }else{
        const map=String(data.map||'');
        const nickname=String(data.nickname||'')
          .trim()
          .toLowerCase();

        records=records.filter(
          r=>!(r.map===map && r.nickname.toLowerCase()===nickname)
        );
      }

      sortRecords();

      res.writeHead(200,{
        'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store'
      });

      return res.end(JSON.stringify(records.slice(0,500)));

    }catch(e){
      res.writeHead(400);
      return res.end('Bad request');
    }
  }

  if(req.url==='/health'){
    res.writeHead(200,{
      'content-type':'application/json'
    });

    return res.end(JSON.stringify({
      ok:true,
      rooms:rooms.size
    }));
  }

  let reqPath=(req.url||'/').split('?')[0];

  if(reqPath==='/'){
    reqPath='/index.html';
  }

  const safe=path.normalize(reqPath)
    .replace(/^([.][.][\\/])+/, '');

  const file=path.join(PUBLIC,safe);

  if(!file.startsWith(PUBLIC)){
    return res.writeHead(403).end('Forbidden');
  }

  fs.readFile(file,(err,data)=>{
    if(err){
      res.writeHead(404);
      return res.end('Not found');
    }

    const ext=path.extname(file);

    const type=
      ext==='.html'
        ? 'text/html; charset=utf-8'
        : ext==='.js'
        ? 'text/javascript; charset=utf-8'
        : 'application/octet-stream';

    res.writeHead(200,{
      'content-type':type
    });

    res.end(data);
  });
});

const wss=new WebSocketServer({
  server
});

wss.on('connection',(ws)=>{

  const id=uid();

  ws.playerId=id;

  send(ws,{
    type:'hello',
    id
  });

  ws.on('message',(buf)=>{

    let m;

    try{
      m=JSON.parse(buf.toString());
    }catch{
      return;
    }

    if(m.type==='createRoom'){

      leave(ws);

      const code=roomCode();

      const player={
        id,
        ws,
        name:String(m.name||'플레이어').slice(0,12),
        carId:Number(m.carId||0),
        ready:false,
        finished:false,
        state:{}
      };

      const room={
        code,
        hostId:id,
        mapId:Number(m.mapId||0),
        started:false,
        firstFinisherId:null,
        finishDeadline:0,
        finishRanks:[],
        players:new Map([[id,player]])
      };

      rooms.set(code,room);

      ws.roomCode=code;

      send(ws,{
        type:'room',
        code,
        hostId:id,
        mapId:room.mapId,
        players:publicPlayers(room)
      });

      return;
    }

    if(m.type==='joinRoom'){

      const code=String(m.code||'').toUpperCase();
      const room=rooms.get(code);

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

      if(room.players.size>=MAX_PLAYERS){
        return send(ws,{
          type:'error',
          message:'방이 가득 찼습니다.'
        });
      }

      leave(ws);

      room.players.set(id,{
        id,
        ws,
        name:String(m.name||'플레이어').slice(0,12),
        carId:Number(m.carId||0),
        ready:false,
        finished:false,
        state:{}
      });

      if(!room.hostId){
        room.hostId=id;
      }

      ws.roomCode=code;

      send(ws,{
        type:'room',
        code,
        hostId:room.hostId,
        mapId:room.mapId,
        players:publicPlayers(room)
      });

      syncPlayers(room);

      return;
    }

    const room=rooms.get(ws.roomCode);

    if(!room) return;

    const me=room.players.get(id);

    if(!me) return;

    if(m.type==='carSelect'){

      if(room.started) return;

      me.carId=Number.isFinite(Number(m.carId))
        ? Number(m.carId)
        : 0;

      me.ready=false;

      syncPlayers(room);

      return;
    }

    if(m.type==='ready'){

      if(room.started) return;

      me.ready=!!m.ready;

      if(Number.isFinite(Number(m.carId))){
        me.carId=Number(m.carId);
      }

      syncPlayers(room);

      return;
    }

    if(m.type==='mapSelect'){

      if(room.started || room.hostId!==id){
        return;
      }

      room.mapId=Number(m.mapId||0);

      for(const p of room.players.values()){
        p.ready=false;
      }

      broadcast(room,{
        type:'mapSelected',
        mapId:room.mapId,
        players:publicPlayers(room)
      });

      return;
    }

    if(m.type==='startRace'){

      if(room.hostId!==id){

        return send(ws,{
          type:'error',
          message:'방장만 레이스를 시작할 수 있습니다.'
        });

      }

      const allReady=
        room.players.size>0 &&
        [...room.players.values()].every(p=>p.ready);

      if(!allReady){

        return send(ws,{
          type:'error',
          message:'모든 플레이어가 준비해야 합니다.'
        });

      }

      room.mapId=Number.isFinite(Number(m.mapId))
        ? Number(m.mapId)
        : room.mapId;

      room.started=true;

      room.firstFinisherId=null;
      room.finishDeadline=0;
      room.finishRanks=[];

      for(const p of room.players.values()){
        p.ready=false;
        p.finished=false;
        p.state={};
      }

      broadcast(room,{
        type:'raceStart',
        mapId:room.mapId
      });

      return;
    }

    if(m.type==='finishRace'){

      if(!room.started || me.finished){
        return;
      }

      me.finished=true;

      const rank=room.finishRanks.length+1;

      room.finishRanks.push({
        id,
        time:Number(m.time)||0,
        rank
      });

      if(!room.firstFinisherId){

        room.firstFinisherId=id;
        room.finishDeadline=Date.now()+10000;

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

      if(room.finishRanks.length>=room.players.size){

        room.started=false;

        const rankings=buildRankings(room);

        broadcast(room,{
          type:'raceEnd',
          reason:'allFinished',
          rankings
        });
      }

      return;
    }

    if(m.type==='state'){

      me.state={
        x:Number(m.x)||0,
        y:Number(m.y)||0,
        z:Number(m.z)||0,
        rot:Number(m.rot)||0,
        color:Number(m.color)||0xffffff,
        lap:Number(m.lap)||1,
        speed:Number(m.speed)||0
      };

      return;
    }
  });

  ws.on('close',()=>leave(ws));
  ws.on('error',()=>leave(ws));
});

function buildRankings(room){

  const finished=
    [...room.finishRanks]
      .sort((a,b)=>a.rank-b.rank)
      .map(r=>{

        const p=room.players.get(r.id);

        return {
          rank:r.rank,
          id:r.id,
          name:p?.name||'플레이어',
          time:r.time,
          car:carsName(p?.carId),
          finished:true
        };
      });

  const finishedIds=new Set(
    finished.map(r=>r.id)
  );

  const dnf=
    [...room.players.values()]
      .filter(p=>!finishedIds.has(p.id))
      .map((p,i)=>({

        rank:finished.length+i+1,
        id:p.id,
        name:p.name||'플레이어',
        time:0,
        car:carsName(p.carId),
        finished:false

      }));

  return finished.concat(dnf);
}

function carsName(carId){

  const names=[
    '레드 볼트',
    '블루 스톰',
    '퍼플 드리프터',
    '그린 스프린터',
    '충돌형 카트'
  ];

  return names[Number(carId)]||'-';
}

setInterval(()=>{

  for(const room of rooms.values()){

    if(
      room.started &&
      room.finishDeadline &&
      Date.now()>=room.finishDeadline
    ){

      room.started=false;

      const rankings=buildRankings(room);

      for(const p of room.players.values()){

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

    if(!room.started) continue;

    const players=
      [...room.players.values()]
        .map(p=>({
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

},66);

server.listen(PORT,()=>{

  console.log(
    `MINI KART server listening on ${PORT}`
  );

});
