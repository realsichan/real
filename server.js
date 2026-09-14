const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const rooms = new Map();
const MAX_PLAYERS = 8;

function uid(){ return crypto.randomBytes(8).toString('hex'); }
function roomCode(){
  let code;
  do code = crypto.randomBytes(4).toString('base64').replace(/[^A-Z0-9]/gi,'').slice(0,5).toUpperCase(); while(!code || rooms.has(code));
  return code;
}
function send(ws,msg){ if(ws.readyState===ws.OPEN) ws.send(JSON.stringify(msg)); }
function publicPlayers(room){ return [...room.players.values()].map(p=>({id:p.id,name:p.name,host:p.id===room.hostId})); }
function broadcast(room,msg){ for(const p of room.players.values()) send(p.ws,msg); }
function leave(ws){
  const id=ws.playerId, code=ws.roomCode; if(!id||!code) return;
  const room=rooms.get(code); if(!room) return;
  room.players.delete(id); ws.playerId=null; ws.roomCode=null;
  if(room.hostId===id){ room.hostId=room.players.keys().next().value || null; }
  if(room.players.size===0){ rooms.delete(code); return; }
  broadcast(room,{type:'players',players:publicPlayers(room)});
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true,rooms:rooms.size}));}
  let reqPath=(req.url||'/').split('?')[0]; if(reqPath==='/') reqPath='/index.html';
  const safe=path.normalize(reqPath).replace(/^([.][.][\\/])+/, '');
  const file=path.join(PUBLIC,safe);
  if(!file.startsWith(PUBLIC)) return res.writeHead(403).end('Forbidden');
  fs.readFile(file,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found')} const ext=path.extname(file); const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'text/javascript; charset=utf-8':'application/octet-stream';res.writeHead(200,{'content-type':type});res.end(data);});
});

const wss=new WebSocketServer({server});
wss.on('connection',(ws)=>{
  const id=uid(); ws.playerId=id; send(ws,{type:'hello',id});
  ws.on('message',(buf)=>{
    let m; try{m=JSON.parse(buf.toString())}catch{return}
    if(m.type==='createRoom'){
      leave(ws); const code=roomCode(); const player={id,ws,name:String(m.name||'플레이어').slice(0,12),carId:Number(m.carId||0),state:{}}; const room={code,hostId:id,mapId:Number(m.mapId||0),started:false,players:new Map([[id,player]])}; rooms.set(code,room); ws.roomCode=code; send(ws,{type:'room',code,hostId:id,players:publicPlayers(room)}); return;
    }
    if(m.type==='joinRoom'){
      const code=String(m.code||'').toUpperCase(); const room=rooms.get(code); if(!room)return send(ws,{type:'error',message:'방을 찾을 수 없습니다.'}); if(room.started)return send(ws,{type:'error',message:'이미 시작된 방입니다.'}); if(room.players.size>=MAX_PLAYERS)return send(ws,{type:'error',message:'방이 가득 찼습니다.'}); leave(ws); room.players.set(id,{id,ws,name:String(m.name||'플레이어').slice(0,12),carId:Number(m.carId||0),state:{}}); ws.roomCode=code; send(ws,{type:'room',code,hostId:room.hostId,players:publicPlayers(room)}); broadcast(room,{type:'players',players:publicPlayers(room)}); return;
    }
    const room=rooms.get(ws.roomCode); if(!room)return;
    if(m.type==='startRace'){
      if(room.hostId!==id)return send(ws,{type:'error',message:'방장만 레이스를 시작할 수 있습니다.'});
      room.mapId=Number(m.mapId||room.mapId); room.started=true; broadcast(room,{type:'raceStart',mapId:room.mapId}); return;
    }
    if(m.type==='state'){
      const p=room.players.get(id); if(!p)return; p.state={x:Number(m.x)||0,y:Number(m.y)||0,z:Number(m.z)||0,rot:Number(m.rot)||0,color:Number(m.color)||0xffffff,lap:Number(m.lap)||1,speed:Number(m.speed)||0}; return;
    }
  });
  ws.on('close',()=>leave(ws)); ws.on('error',()=>leave(ws));
});

setInterval(()=>{
  for(const room of rooms.values()){
    if(!room.started) continue;
    const players=[...room.players.values()].map(p=>({id:p.id,...p.state}));
    broadcast(room,{type:'snapshot',players});
  }
},66);
server.listen(PORT,()=>console.log(`MINI KART server listening on ${PORT}`));
