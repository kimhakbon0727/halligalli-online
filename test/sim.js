'use strict';
/**
 * 규칙 검증 테스트 (Node 22+ 의 내장 WebSocket 클라이언트 사용)
 *   npm test
 */
const assert = require('node:assert/strict');
const { server, rooms } = require('../server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(url, name) {
    this.name = name;
    this.events = [];
    this.errors = [];
    this.state = null;
    this.joined = null;
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
    this.ws.onmessage = (e) => this.onMsg(JSON.parse(e.data));
  }
  onMsg(m) {
    if (m.t === 'state') {
      this.state = m;
      if (this.onState) this.onState(m);
    } else if (m.t === 'event') {
      this.events.push(m);
      if (this.onEvent) this.onEvent(m);
    } else if (m.t === 'joined') this.joined = m;
    else if (m.t === 'error') this.errors.push(m);
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  async waitFor(pred, ms = 3000, what = '조건') {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return;
      await sleep(5);
    }
    throw new Error(`시간 초과: ${what}`);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

let url;

async function connect(n) {
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(new Client(url, 'P' + i));
  await Promise.all(cs.map((c) => c.ready));
  return cs;
}

async function startRoom(n) {
  const cs = await connect(n);
  cs[0].send({ t: 'create', name: 'P0' });
  await cs[0].waitFor(() => cs[0].joined, 3000, '방 생성');
  const code = cs[0].joined.code;
  for (let i = 1; i < n; i++) {
    cs[i].send({ t: 'join', code, name: 'P' + i });
    await cs[i].waitFor(() => cs[i].joined, 3000, '방 입장');
  }
  cs[0].send({ t: 'start' });
  await Promise.all(cs.map((c) => c.waitFor(() => c.state && c.state.phase === 'playing', 3000, '게임 시작')));
  return { cs, room: rooms.get(code), code };
}

const allCards = (room) => room.players.flatMap((p) => [...p.draw, ...p.up]).concat(room.pot);

// 현재 테이블을 원하는 모양으로 세팅 (실제 카드를 옮겨서 56장 보존 유지)
function setTable(room, spec) {
  for (const p of room.players) {
    p.draw.push(...p.up);
    p.up = [];
    p.bellLockUntil = 0;
  }
  room.graceUntil = 0;
  const take = (fruit, n) => {
    for (const arr of [...room.players.map((p) => p.draw), room.pot]) {
      const i = arr.findIndex((c) => c.fruit === fruit && c.n === n);
      if (i >= 0) return arr.splice(i, 1)[0];
    }
    throw new Error(`카드를 찾지 못함: ${fruit} ${n}`);
  };
  spec.forEach((cards, i) => {
    for (const [f, n] of cards) room.players[i].up.push(take(f, n));
  });
}

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n      ${e.stack.split('\n').slice(0, 4).join('\n      ')}`);
  }
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${server.address().port}`;
  console.log(`\n테스트 서버: ${url}\n`);

  await test('덱 구성: 56장, 과일별 14장, 1~5개 분포 5/3/3/2/1', async () => {
    const { buildDeck } = require('../server');
    const deck = buildDeck();
    assert.equal(deck.length, 56);
    assert.equal(new Set(deck.map((c) => c.id)).size, 56);
    for (const f of ['strawberry', 'banana', 'lime', 'plum']) {
      const of = deck.filter((c) => c.fruit === f);
      assert.equal(of.length, 14);
      for (const [n, k] of Object.entries({ 1: 5, 2: 3, 3: 3, 4: 2, 5: 1 }))
        assert.equal(of.filter((c) => c.n === Number(n)).length, k);
    }
  });

  await test('로비 규칙: 없는 방 / 1명 시작 / 방장 아님 / 7번째 입장', async () => {
    const [a] = await connect(1);
    a.send({ t: 'join', code: 'ZZZZ', name: 'x' });
    await a.waitFor(() => a.errors.length, 2000, '없는 방 에러');
    assert.equal(a.errors[0].code, 'no-room');
    a.close();

    const cs = await connect(7);
    cs[0].send({ t: 'create', name: 'H' });
    await cs[0].waitFor(() => cs[0].joined);
    const code = cs[0].joined.code;
    cs[0].send({ t: 'start' });
    await cs[0].waitFor(() => cs[0].errors.length, 2000, '1명 시작 에러');
    assert.equal(cs[0].errors[0].code, 'few');

    for (let i = 1; i < 6; i++) {
      cs[i].send({ t: 'join', code, name: 'H' }); // 이름 중복 → 자동 구분
      await cs[i].waitFor(() => cs[i].joined);
    }
    cs[6].send({ t: 'join', code, name: 'late' });
    await cs[6].waitFor(() => cs[6].errors.length, 2000, '정원 초과 에러');
    assert.equal(cs[6].errors[0].code, 'full');

    cs[1].send({ t: 'start' });
    await cs[1].waitFor(() => cs[1].errors.length, 2000, '방장 아님 에러');
    assert.equal(cs[1].errors[0].code, 'not-host');

    const names = cs[0].state.players.map((p) => p.name);
    assert.equal(new Set(names).size, 6, '이름 중복이 해소되어야 함: ' + names);
    cs.forEach((c) => c.close());
  });

  await test('카드 분배: 56장이 인원수에 맞게 나뉨 (4명 → 14장씩)', async () => {
    const { cs, room } = await startRoom(4);
    assert.equal(allCards(room).length, 56);
    assert.deepEqual(room.players.map((p) => p.draw.length), [14, 14, 14, 14]);
    cs.forEach((c) => c.close());
  });

  await test('종 성공: 같은 과일 합 5 → 모든 펼친 카드 획득, 56장 보존', async () => {
    const { cs, room } = await startRoom(3);
    setTable(room, [[['strawberry', 2]], [['strawberry', 3]], [['banana', 4]]]);
    const before = room.players[2].draw.length;
    cs.forEach((c) => (c.events.length = 0));
    cs[2].send({ t: 'bell' });
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'bell'), 2000, '종 결과');
    const ev = cs[0].events.find((e) => e.kind === 'bell');
    assert.equal(ev.ok, true);
    assert.equal(ev.fruit, 'strawberry');
    assert.equal(ev.gained, 3);
    assert.equal(room.players[2].draw.length, before + 3);
    assert.ok(room.players.every((p) => p.up.length === 0));
    assert.equal(allCards(room).length, 56);
    cs.forEach((c) => c.close());
  });

  await test('종 성공: 카드 한 장짜리 5개도 성공 / 서로 다른 과일 합 5는 실패', async () => {
    const { cs, room } = await startRoom(2);
    setTable(room, [[['plum', 5]], [['lime', 1]]]);
    cs[1].send({ t: 'bell' });
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'bell'), 2000);
    assert.equal(cs[0].events.at(-1).ok, true);

    cs.forEach((c) => (c.events.length = 0));
    setTable(room, [[['strawberry', 2]], [['banana', 3]]]); // 2+3=5지만 과일이 다름
    cs[0].send({ t: 'bell' });
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'bell'), 2000);
    assert.equal(cs[0].events.at(-1).ok, false);
    assert.equal(allCards(room).length, 56);
    cs.forEach((c) => c.close());
  });

  await test('종 실패: 합이 5가 아니면(6) 다른 사람에게 1장씩 지급', async () => {
    const { cs, room } = await startRoom(3);
    setTable(room, [[['lime', 3]], [['lime', 3]], [['banana', 1]]]);
    const d = room.players.map((p) => p.draw.length);
    cs.forEach((c) => (c.events.length = 0));
    cs[1].send({ t: 'bell' });
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'bell'), 2000);
    const ev = cs[0].events.find((e) => e.kind === 'bell');
    assert.equal(ev.ok, false);
    assert.equal(ev.paid, 2);
    assert.equal(room.players[1].draw.length, d[1] - 2);
    assert.equal(room.players[0].draw.length, d[0] + 1);
    assert.equal(room.players[2].draw.length, d[2] + 1);
    assert.equal(allCards(room).length, 56);
    cs.forEach((c) => c.close());
  });

  await test('늦은 종: 성공 직후 살짝 늦게 친 사람은 벌칙 없이 무시', async () => {
    const { cs, room } = await startRoom(3);
    setTable(room, [[['banana', 2]], [['banana', 3]], [['lime', 1]]]);
    cs.forEach((c) => (c.events.length = 0));
    cs[1].send({ t: 'bell' });
    await cs[1].waitFor(() => cs[1].events.some((e) => e.kind === 'bell'), 2000);
    const d0 = room.players[0].draw.length;
    cs[0].send({ t: 'bell' }); // 거의 동시에 늦게 침
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'late'), 2000, 'late 이벤트');
    assert.equal(room.players[0].draw.length, d0, '벌칙 카드가 나가면 안 됨');
    assert.equal(allCards(room).length, 56);
    cs.forEach((c) => c.close());
  });

  await test('같은 사람의 연타는 한 번만 처리', async () => {
    const { cs, room } = await startRoom(3);
    setTable(room, [[['lime', 1]], [['plum', 2]], [['banana', 1]]]);
    const d = room.players[0].draw.length;
    for (let i = 0; i < 5; i++) cs[0].send({ t: 'bell' });
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'bell'), 2000);
    await sleep(150);
    assert.equal(cs[0].events.filter((e) => e.kind === 'bell').length, 1);
    assert.equal(room.players[0].draw.length, d - 2);
    cs.forEach((c) => c.close());
  });

  await test('탈락과 승리: 뒤집을 카드가 없는 차례가 되면 탈락, 마지막 1명이 우승', async () => {
    const { cs, room } = await startRoom(2);
    const [p0, p1] = room.players;
    p0.draw.push(...p0.up, ...p1.draw, ...p1.up);
    p0.up = [];
    p1.draw = [];
    p1.up = [];
    room.turnIdx = 1;
    cs[1].send({ t: 'flip' });
    await cs[0].waitFor(() => cs[0].state.phase === 'ended', 2000, '게임 종료');
    assert.equal(cs[0].state.winner, p0.id);
    assert.equal(allCards(room).length, 56);
    assert.ok(cs[0].events.some((e) => e.kind === 'out'));
    assert.ok(cs[0].events.some((e) => e.kind === 'end'));
    cs.forEach((c) => c.close());
  });

  await test('차례 순서: 내 차례가 아닐 때 flip 은 무시', async () => {
    const { cs, room } = await startRoom(3);
    const cur = room.turnIdx;
    const other = (cur + 1) % 3;
    cs[other].send({ t: 'flip' });
    await sleep(100);
    assert.equal(room.players.reduce((a, p) => a + p.up.length, 0), 0);
    cs[cur].send({ t: 'flip' });
    await cs[0].waitFor(() => room.players.reduce((a, p) => a + p.up.length, 0) === 1, 2000);
    assert.equal(room.turnIdx, (cur + 1) % 3);
    cs.forEach((c) => c.close());
  });

  await test('자동 뒤집기: 제한 시간이 지나면 서버가 대신 뒤집음', async () => {
    const { cs, room } = await startRoom(2);
    room.settings.turnSecs = 0.2;
    cs[room.turnIdx].send({ t: 'flip' }); // 이 시점부터 새 타이머 적용
    await cs[0].waitFor(() => room.players.reduce((a, p) => a + p.up.length, 0) >= 3, 3000, '자동 뒤집기');
    cs.forEach((c) => c.close());
  });

  await test('재접속: 연결이 끊겨도 토큰으로 같은 자리에 복귀', async () => {
    const { cs, room, code } = await startRoom(3);
    const { token, id } = cs[1].joined;
    cs[1].close();
    await cs[0].waitFor(() => cs[0].state.players.find((p) => p.id === id).connected === false, 2000, '끊김 감지');
    const [n] = await connect(1);
    n.send({ t: 'rejoin', code, token });
    await n.waitFor(() => n.state, 2000, '재접속 상태');
    assert.equal(n.state.you, id);
    await cs[0].waitFor(() => cs[0].state.players.find((p) => p.id === id).connected === true, 2000);

    const [bad] = await connect(1);
    bad.send({ t: 'rejoin', code, token: 'wrong' });
    await bad.waitFor(() => bad.errors.length, 2000);
    assert.equal(bad.errors[0].code, 'rejoin-failed');
    [cs[0], cs[2], n, bad].forEach((c) => c.close());
  });

  await test('도중 퇴장: 카드가 바닥으로 가고, 다음 종 성공자가 가져감', async () => {
    const { cs, room } = await startRoom(3);
    const leaverCards = room.players[2].draw.length + room.players[2].up.length;
    cs[2].send({ t: 'leave' });
    await cs[0].waitFor(() => cs[0].state.pot === leaverCards, 2000, '바닥 카드');
    assert.equal(cs[0].state.players.filter((p) => p.alive).length, 2);
    assert.equal(allCards(room).length, 56);
    setTable(room, [[['strawberry', 4]], [['strawberry', 1]], []]);
    cs.forEach((c) => (c.events.length = 0));
    cs[1].send({ t: 'bell' });
    await cs[0].waitFor(() => cs[0].events.some((e) => e.kind === 'bell'), 2000);
    assert.equal(cs[0].events.find((e) => e.kind === 'bell').gained, leaverCards + 2);
    assert.equal(allCards(room).length, 56);
    cs.forEach((c) => c.close());
  });

  await test('다시 하기: 방장이 로비로 되돌리면 같은 방에서 재시작 가능', async () => {
    const { cs, room } = await startRoom(2);
    const [p0, p1] = room.players;
    p0.draw.push(...p0.up, ...p1.draw, ...p1.up);
    p0.up = [];
    p1.draw = [];
    p1.up = [];
    room.turnIdx = 1;
    cs[1].send({ t: 'flip' });
    await cs[0].waitFor(() => cs[0].state.phase === 'ended');
    cs[1].send({ t: 'rematch' }); // 방장이 아니면 무시
    await sleep(80);
    assert.equal(cs[0].state.phase, 'ended');
    cs[0].send({ t: 'rematch' });
    await cs[0].waitFor(() => cs[0].state.phase === 'lobby');
    cs[0].send({ t: 'start' });
    await cs[0].waitFor(() => cs[0].state.phase === 'playing');
    assert.equal(allCards(room).length, 56);
    cs.forEach((c) => c.close());
  });

  await test('랜덤 대전: 봇 4명이 끝까지 플레이 (56장 보존, 정상 종료)', async () => {
    const { cs, room } = await startRoom(4);
    let violations = 0;
    let okBells = 0;
    let badBells = 0;
    for (const c of cs) {
      c.onEvent = (e) => {
        if (c !== cs[0] || e.kind !== 'bell') return;
        e.ok ? okBells++ : badBells++;
      };
      c.onState = (st) => {
        const sum = st.players.reduce((a, p) => a + p.draw + p.up, 0) + st.pot;
        if (sum !== 56) violations++;
        if (st.phase !== 'playing') return;
        const me = st.players.find((p) => p.id === st.you);
        if (st.turn === st.you && me.alive && !c.flipPending) {
          // 사람처럼 약간의 간격을 두고 뒤집기 (너무 빠르면 종 칠 틈이 없음)
          c.flipPending = true;
          setTimeout(() => {
            c.flipPending = false;
            c.send({ t: 'flip' });
          }, 40 + Math.random() * 40);
        }
        const sums = {};
        for (const p of st.players) if (p.alive && p.top) sums[p.top.fruit] = (sums[p.top.fruit] || 0) + p.top.n;
        const match = Object.values(sums).includes(5);
        const key = st.players.map((p) => (p.top ? p.top.id : '-')).join(',');
        if (me.alive && key !== c.lastKey) {
          c.lastKey = key;
          if (match) setTimeout(() => c.send({ t: 'bell' }), 5 + Math.random() * 30);
          else if (Math.random() < 0.02) setTimeout(() => c.send({ t: 'bell' }), Math.random() * 30);
        }
      };
      c.onState(c.state);
    }
    await cs[0].waitFor(() => cs[0].state.phase === 'ended', 120000, '게임 종료');
    const st = cs[0].state;
    assert.equal(violations, 0, '카드 수 보존 위반 발생');
    assert.equal(st.players.filter((p) => p.alive).length, 1);
    assert.equal(st.winner, st.players.find((p) => p.alive).id);
    assert.equal(allCards(room).length, 56);
    console.log(`      (정상 종 ${okBells}회, 오답 종 ${badBells}회)`);
    cs.forEach((c) => c.close());
  });

  const failed = results.filter(([ok]) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} 통과${failed ? `, ${failed}개 실패` : ''}\n`);
  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
