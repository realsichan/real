# MINI KART 온라인 멀티플레이 (Render용)

## 로컬 실행
```bash
npm install
npm start
```
브라우저에서 `http://localhost:3000` 접속.

## Render 배포
- GitHub에 이 폴더 전체 업로드
- Render → New → Web Service
- 저장소 선택
- Build Command: `npm install`
- Start Command: `npm start`
- Node.js 20 이상 권장

Render가 제공하는 `PORT`를 서버가 자동 사용합니다.

## 현재 멀티플레이 프로토타입
- 방 만들기 / 5자리 방 코드 참가
- 최대 8명
- WebSocket 연결
- 방장 레이스 시작
- 다른 플레이어 카트 위치/방향 실시간 동기화
- 기존 3D 카트 화면 유지

아직 게임 물리/랩/순위의 최종 권한은 클라이언트 쪽입니다. 실제 공개 서비스 단계에서는 서버 권한형 판정으로 옮기는 것이 좋습니다.
