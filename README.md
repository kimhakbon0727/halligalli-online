# 할리갈리 온라인

2~6명이 브라우저로 같이 하는 할리갈리입니다. 서버는 Node.js 하나, **외부 패키지 설치가 필요 없어요** (`npm install` 불필요).

## 실행 (WSL)

```bash
# Node.js 18 이상 필요 (node -v 로 확인)
cd halligalli
node server.js
```

```
🔔 할리갈리 서버 실행 중 (포트 3000)
   이 컴퓨터에서:  http://localhost:3000
```

포트를 바꾸려면 `PORT=8080 node server.js`.

## 친구들이 접속하게 하는 방법

WSL은 Windows 안의 가상 네트워크에 있어서, 친구들이 바로 접속하려면 길을 하나 열어줘야 해요. 상황에 맞는 걸 고르세요.

### A. 같은 공유기(같은 와이파이/집 안)에 있는 친구

Windows PowerShell(관리자)에서:

```powershell
$wslIp = (wsl hostname -I).Trim().Split(' ')[0]
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$wslIp
New-NetFirewallRule -DisplayName "HalliGalli 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow
```

친구들은 `http://<내 Windows PC의 IP>:3000` 으로 접속합니다. (`ipconfig`의 IPv4 주소)
WSL의 IP는 재부팅하면 바뀌어서, 그때마다 위 `netsh` 줄을 다시 실행해야 해요.
(Windows 11 최신 버전이라면 `%UserProfile%\.wslconfig`에 `[wsl2]` 아래 `networkingMode=mirrored`를 넣고 `wsl --shutdown` 하는 방법도 있어요.)

### B. 인터넷 너머의 친구 (가장 쉬움)

터널 도구를 쓰면 공유기 설정 없이 `https://...` 주소가 생겨요. WebSocket도 지나갑니다.

```bash
# 예: Cloudflare Tunnel (cloudflared 설치 후)
cloudflared tunnel --url http://localhost:3000
```

출력되는 `https://....trycloudflare.com` 주소를 친구에게 주면 됩니다. ngrok, Tailscale도 같은 방식으로 쓸 수 있어요.

> 초대 링크는 **내가 접속한 주소 기준**으로 만들어져요. 터널 주소나 IP 주소로 접속해서 방을 만들어야 "초대 링크 복사"가 친구에게 열립니다.
> localhost로 접속했다면 친구가 서버 주소로 들어온 뒤 방 코드(4글자)만 입력해도 돼요.

## 서버를 계속 켜두기

```bash
tmux new -s halli      # 또는 screen
node server.js         # Ctrl+B, D 로 빠져나오면 계속 실행됩니다
```

## 게임 규칙 (구현 기준)

- 카드 56장: 딸기·바나나·라임·자두 각 14장 (과일 1개 5장, 2개 3장, 3개 3장, 4개 2장, 5개 1장).
- 카드를 똑같이 나눠 갖고, 차례마다 내 더미 맨 위 카드를 뒤집어 내 앞에 펼칩니다.
- **펼쳐진 맨 위 카드들**에서 같은 과일이 정확히 5개면 종을 칩니다. 가장 먼저 맞게 친 사람이 테이블의 모든 펼친 카드를 가져가 자기 더미 아래에 넣습니다.
- 틀리게 치면 다른 살아있는 플레이어에게 카드 1장씩 줍니다. (줄 카드가 없으면 벌칙 없음)
- 내 차례에 뒤집을 카드가 없으면 탈락. 마지막까지 남은 사람이 우승.

원작에서 모호한 부분은 이렇게 정했어요.

| 상황 | 이 게임의 처리 |
| --- | --- |
| 누가 맞게 친 직후 거의 동시에 친 사람 | 0.9초 안에 친 헛종은 벌칙 없이 무시 ("한발 늦었어요") |
| 한 사람이 연타 | 0.5초 안의 중복 입력은 무시 |
| 탈락/퇴장한 사람의 카드 | 바닥에 모였다가 다음에 종을 맞게 친 사람이 가져감 |
| 카드가 없지만 펼친 카드는 있는 사람 | 자기 차례가 오기 전에 종을 맞게 치면 다시 살아남 |
| 차례에 카드를 안 뒤집고 가만히 있음 | 방장이 정한 시간(기본 15초)이 지나면 자동으로 뒤집힘 (끌 수도 있음) |
| 접속이 끊김 | 같은 브라우저로 다시 열면 그 자리로 복귀. 90초 넘게 안 돌아오면 기권 처리 |

조작: **스페이스바** = 종, **F 또는 Enter** = 카드 뒤집기. 모바일은 화면 버튼.

## 파일 구성

```
server.js        게임 규칙 + HTTP 서버 + WebSocket 메시지 처리
ws-lite.js       의존성 없는 최소 WebSocket 서버 구현
public/          index.html, style.css, app.js (브라우저 화면)
test/sim.js      규칙 검증 테스트 (npm test, Node 22 이상)
```

- 과일 그림을 바꾸고 싶으면 `public/app.js` 맨 위 `FRUITS`의 이모지만 고치면 됩니다.
- 카드 구성(장수)을 바꾸려면 `server.js`의 `COUNT_DIST`, 종 조건(합 5)은 `BELL_SUM`입니다.
- 방 정보는 메모리에만 저장돼서 서버를 재시작하면 모든 방이 사라져요.
- 로그인이나 비밀번호는 없어요. 방 코드를 아는 사람은 누구나 들어올 수 있으니, 인터넷에 열어둘 땐 필요할 때만 켜두세요.
