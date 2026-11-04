(() => {
  'use strict';

  // 과일 표시를 바꾸고 싶다면 여기만 고치면 돼요. (이모지 → 원하는 글자/이모지)
  const FRUITS = {
    strawberry: { emoji: '🍓', name: '딸기' },
    banana: { emoji: '🍌', name: '바나나' },
    lime: { emoji: '🍏', name: '라임' },
    plum: { emoji: '🍇', name: '자두' },
  };
  // 3x3 칸 중 어느 칸에 과일을 놓을지 (1~9)
  const PATTERN = { 1: [5], 2: [1, 9], 3: [1, 5, 9], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9] };

  const $ = (s) => document.querySelector(s);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const store = {
    get(k) {
      try {
        return JSON.parse(localStorage.getItem(k));
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        localStorage.removeItem(k);
      } catch {}
    },
  };

  const S = {
    ws: null,
    retry: 0,
    rt: null,
    session: store.get('hg-session'),
    state: null,
    topIds: {},
    seeded: false,
    muted: !!store.get('hg-muted'),
    deadlineAt: 0,
    totalMs: 0,
    screen: 'loading',
  };

  // ------------------------------------------------------------ 소리 (WebAudio, 파일 없음)
  let actx = null;
  function audio() {
    if (!actx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) actx = new AC();
    }
    if (actx && actx.state === 'suspended') actx.resume();
    return actx;
  }
  function tone(freq, dur, { type = 'sine', vol = 0.15, at = 0, slide } = {}) {
    if (S.muted) return;
    const a = audio();
    if (!a) return;
    const t = a.currentTime + at;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  }
  const sfx = {
    flip: () => tone(520, 0.07, { type: 'triangle', vol: 0.08, slide: 300 }),
    ok: () => {
      tone(988, 0.55, { vol: 0.2 });
      tone(1480, 0.75, { vol: 0.11, at: 0.03 });
      tone(1976, 0.9, { vol: 0.05, at: 0.06 });
    },
    bad: () => tone(150, 0.3, { type: 'sawtooth', vol: 0.11, slide: 90 }),
    turn: () => {
      tone(760, 0.09, { vol: 0.08 });
      tone(1010, 0.12, { vol: 0.08, at: 0.08 });
    },
    win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.32, { vol: 0.14, at: i * 0.12 })),
  };

  // ------------------------------------------------------------ 카드 그리기
  function cardHTML(card, cls = '') {
    if (!card) return `<div class="card empty ${cls}"></div>`;
    const f = FRUITS[card.fruit];
    const cells = PATTERN[card.n];
    let inner = '';
    for (let i = 1; i <= 9; i++) inner += `<span class="cell">${cells.includes(i) ? f.emoji : ''}</span>`;
    return `<div class="card f-${card.fruit} ${cls}" role="img" aria-label="${f.name} ${card.n}개">${inner}</div>`;
  }

  // ------------------------------------------------------------ 화면 전환
  function showScreen(name) {
    S.screen = name;
    for (const id of ['loading', 'home', 'lobby', 'game']) $('#screen-' + id).classList.toggle('hidden', id !== name);
    $('#btn-leave').classList.toggle('hidden', name === 'home' || name === 'loading');
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  let bannerTimer = null;
  function banner(kind, msgHTML, chipsHTML = '') {
    const el = $('#banner');
    el.className = `banner ${kind} show`;
    el.innerHTML = `<div class="banner-msg">${msgHTML}</div>${chipsHTML ? `<div class="banner-chips">${chipsHTML}</div>` : ''}`;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => el.classList.remove('show'), 3400);
  }

  // ------------------------------------------------------------ 네트워크
  function send(o) {
    if (S.ws && S.ws.readyState === 1) {
      S.ws.send(JSON.stringify(o));
      return true;
    }
    return false;
  }

  function connect() {
    clearTimeout(S.rt);
    if (S.ws && S.ws.readyState <= 1) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    S.ws = ws;
    ws.onopen = () => {
      S.retry = 0;
      $('#conn').classList.add('hidden');
      if (S.session) send({ t: 'rejoin', code: S.session.code, token: S.session.token });
      else if (S.screen === 'loading') showScreen('home');
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      onMessage(m);
    };
    ws.onclose = () => {
      if (S.ws !== ws) return;
      $('#conn').classList.remove('hidden');
      S.rt = setTimeout(connect, Math.min(4000, 400 * 2 ** S.retry++));
    };
    ws.onerror = () => {};
  }

  function clearSession(resetUrl = true) {
    S.session = null;
    S.state = null;
    S.topIds = {};
    S.seeded = false;
    store.del('hg-session');
    if (resetUrl) history.replaceState(null, '', location.pathname);
  }

  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        S.session = { code: m.code, token: m.token };
        store.set('hg-session', S.session);
        history.replaceState(null, '', `?room=${m.code}`);
        break;
      case 'state':
        onState(m);
        break;
      case 'event':
        onEvent(m);
        break;
      case 'error':
        onError(m);
        break;
      case 'left':
        clearSession();
        hideEnd();
        showScreen('home');
        break;
    }
  }

  function onError(m) {
    if (m.code === 'rejoin-failed') {
      const had = !!S.session;
      clearSession();
      showScreen('home');
      if (had) toast('이전에 있던 방이 사라졌어요');
      return;
    }
    if (S.screen === 'home') $('#home-error').textContent = m.msg;
    else toast(m.msg);
  }

  // ------------------------------------------------------------ 상태 반영
  function onState(st) {
    const prev = S.state;
    S.state = st;
    S.deadlineAt = st.turnMs != null ? performance.now() + st.turnMs : 0;
    S.totalMs = st.turnTotalMs || 0;

    if (st.phase === 'lobby') {
      S.topIds = {};
      S.seeded = false;
      hideEnd();
      showScreen('lobby');
      renderLobby(st);
    } else {
      showScreen('game');
      renderGame(st, prev);
    }
  }

  function renderLobby(st) {
    $('#lobby-code').textContent = st.code;
    const isHost = st.host === st.you;

    $('#lobby-players').innerHTML =
      st.players
        .map(
          (p) =>
            `<li class="${p.connected ? '' : 'dc'}"><span class="pname">${esc(p.name)}</span>` +
            (p.id === st.host ? '<span class="tag host">방장</span>' : '') +
            (p.id === st.you ? '<span class="tag">나</span>' : '') +
            (p.connected ? '' : '<span class="tag warn">연결 끊김</span>') +
            '</li>'
        )
        .join('') +
      Array.from({ length: Math.max(0, st.limits.max - st.players.length) }, () => '<li class="empty">빈 자리</li>').join('');

    const sel = $('#sel-turn');
    if (sel.options.length !== st.settings.options.length) {
      sel.innerHTML = st.settings.options.map((o) => `<option value="${o}">${o === 0 ? '사용 안 함' : o + '초'}</option>`).join('');
    }
    sel.value = String(st.settings.turnSecs);
    sel.disabled = !isHost;

    const ready = st.players.filter((p) => p.connected).length >= st.limits.min;
    $('#btn-start').classList.toggle('hidden', !isHost);
    $('#btn-start').disabled = !ready;
    $('#lobby-wait').textContent = isHost
      ? ready
        ? ''
        : `${st.limits.min}명 이상 모이면 시작할 수 있어요.`
      : '방장이 시작하길 기다리는 중이에요.';

    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const hint = $('#localhost-hint');
    hint.classList.toggle('hidden', !local);
    if (local) {
      hint.textContent =
        '지금 localhost로 접속 중이라 복사되는 초대 링크는 친구에게 열리지 않아요. 친구가 서버 주소로 접속한 뒤 이 방 코드를 입력하면 들어올 수 있어요.';
    }
  }

  function seatHTML(p, st, isMe, newTops) {
    const isTurn = st.phase === 'playing' && st.turn === p.id;
    const tid = p.top ? p.top.id : null;
    const isNew = S.seeded && tid !== null && S.topIds[p.id] !== tid;
    newTops[p.id] = tid;
    if (isNew) newTops.__flipped = true;

    const badge = !p.alive ? `<div class="out-badge">${p.left ? '나감' : '탈락'}</div>` : '';
    return (
      `<div class="seat ${isTurn ? 'turn' : ''} ${!p.alive ? 'out' : ''} ${isMe ? 'me' : ''}">` +
      `<div class="seat-name">${esc(p.name)}${isMe ? ' (나)' : ''}${st.host === p.id ? ' 👑' : ''}</div>` +
      `<div class="slot">${cardHTML(p.top, isNew ? 'flip-in' : '')}${badge}</div>` +
      `<div class="seat-meta"><span>더미 ${p.draw}</span><span>펼침 ${p.up}</span></div>` +
      (isTurn && st.turnMs != null ? '<div class="timer"><i></i></div>' : '') +
      (!p.connected && p.alive ? '<div class="dc-badge">연결 끊김</div>' : '') +
      '</div>'
    );
  }

  function renderGame(st, prev) {
    const meIdx = st.players.findIndex((p) => p.id === st.you);
    const me = st.players[meIdx];
    const opps = st.players.slice(meIdx + 1).concat(st.players.slice(0, meIdx));
    const newTops = {};

    $('#opponents').innerHTML = opps.map((p) => seatHTML(p, st, false, newTops)).join('');
    $('#me').innerHTML = seatHTML(me, st, true, newTops);

    const flipped = !!newTops.__flipped;
    delete newTops.__flipped;
    S.topIds = newTops;
    S.seeded = true;
    if (flipped) sfx.flip();

    const playing = st.phase === 'playing';
    const myTurn = playing && st.turn === st.you && me.alive;
    const turnP = st.players.find((p) => p.id === st.turn);

    $('#turn-info').textContent = !playing ? '' : myTurn ? '내 차례예요. 카드를 뒤집으세요' : turnP ? `${turnP.name} 차례` : '';
    $('#pot-info').textContent = st.pot > 0 ? `바닥에 카드 ${st.pot}장 · 다음에 종을 맞게 친 사람이 가져가요` : '';

    const flip = $('#flip');
    flip.disabled = !myTurn;
    flip.classList.toggle('ready', myTurn);
    flip.textContent = !me.alive
      ? me.left
        ? '나갔어요'
        : '탈락했어요'
      : myTurn
        ? me.draw === 0
          ? '카드가 없어요 (누르면 탈락)'
          : '카드 뒤집기'
        : turnP
          ? `${turnP.name} 차례를 기다리는 중`
          : '카드 뒤집기';

    $('#bell').disabled = !(playing && me.alive);

    if (myTurn && !(prev && prev.turn === st.you && prev.phase === 'playing')) sfx.turn();

    if (st.phase === 'ended') {
      if (!prev || prev.phase !== 'ended') {
        sfx.win();
        showEnd(st);
      }
    } else {
      hideEnd();
    }
  }

  // ------------------------------------------------------------ 이벤트
  function ringBell() {
    const b = $('#bell');
    b.classList.remove('ring');
    void b.offsetWidth;
    b.classList.add('ring');
  }

  function onEvent(ev) {
    if (ev.kind === 'bell') {
      ringBell();
      const chips = ev.tops
        .map((t) => `<span class="chip">${esc(t.name)} ${FRUITS[t.fruit].emoji}×${t.n}</span>`)
        .join('');
      if (ev.ok) {
        sfx.ok();
        const f = FRUITS[ev.fruit];
        banner('ok', `<strong>${esc(ev.name)}</strong>님이 맞게 쳤어요! ${f.emoji} ${f.name} 5개 · 카드 ${ev.gained}장 획득`, chips);
      } else {
        sfx.bad();
        banner(
          'bad',
          `<strong>${esc(ev.name)}</strong>님 오답! ` + (ev.paid > 0 ? `카드 ${ev.paid}장을 나눠 줬어요` : '줄 카드가 없어서 벌칙은 없어요'),
          chips
        );
      }
    } else if (ev.kind === 'late') {
      toast('한발 늦었어요! 벌칙은 없어요');
    } else if (ev.kind === 'out') {
      toast(ev.left ? `${ev.name}님이 나갔어요` : `${ev.name}님이 카드를 다 써서 탈락했어요`);
    } else if (ev.kind === 'start') {
      toast('게임 시작!');
    }
  }

  function showEnd(st) {
    const w = st.players.find((p) => p.id === st.winner);
    const iWon = !!w && w.id === st.you;
    $('#end-title').textContent = w ? (iWon ? '우승! 🎉' : `${w.name}님 우승`) : '게임이 끝났어요';
    $('#end-sub').textContent = w ? (iWon ? '모든 카드를 모았어요.' : '다른 플레이어가 모든 카드를 모았어요.') : '';
    const isHost = st.host === st.you;
    $('#btn-rematch').classList.toggle('hidden', !isHost);
    $('#end-wait').textContent = isHost ? '' : '방장이 다시 시작하길 기다리는 중이에요.';
    $('#end-overlay').classList.remove('hidden');
  }
  function hideEnd() {
    $('#end-overlay').classList.add('hidden');
  }

  // ------------------------------------------------------------ 입력
  function homeErr(msg) {
    $('#home-error').textContent = msg || '';
  }
  function getName() {
    const name = $('#name').value.trim();
    if (name) store.set('hg-name', name);
    return name;
  }
  function doCreate() {
    homeErr('');
    const name = getName();
    if (!name) return homeErr('이름을 입력해 주세요.');
    if (!send({ t: 'create', name })) homeErr('서버에 연결하는 중이에요. 잠시 후 다시 눌러 주세요.');
  }
  function doJoin() {
    homeErr('');
    const name = getName();
    const code = $('#code').value.trim().toUpperCase();
    if (!name) return homeErr('이름을 입력해 주세요.');
    if (code.length !== 4) return homeErr('방 코드는 4글자예요.');
    if (!send({ t: 'join', code, name })) homeErr('서버에 연결하는 중이에요. 잠시 후 다시 눌러 주세요.');
  }

  $('#btn-create').addEventListener('click', doCreate);
  $('#btn-join').addEventListener('click', doJoin);
  $('#form-home').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#code').value.trim().length === 4 ? doJoin() : doCreate();
  });
  $('#form-home').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('#code').value.trim().length === 4 ? doJoin() : doCreate();
    }
  });
  $('#code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  $('#btn-start').addEventListener('click', () => send({ t: 'start' }));
  $('#sel-turn').addEventListener('change', (e) => send({ t: 'settings', turnSecs: Number(e.target.value) }));
  $('#btn-rematch').addEventListener('click', () => send({ t: 'rematch' }));

  $('#btn-copy').addEventListener('click', async () => {
    if (!S.state) return;
    const link = `${location.origin}/?room=${S.state.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('초대 링크를 복사했어요');
    } catch {
      window.prompt('이 링크를 복사해서 친구에게 보내세요', link);
    }
  });

  function leave() {
    const st = S.state;
    if (st && st.phase === 'playing' && !confirm('게임 중에 나가면 가진 카드가 모두 바닥으로 가요. 나갈까요?')) return;
    send({ t: 'leave' });
  }
  $('#btn-leave').addEventListener('click', leave);
  $('#btn-end-leave').addEventListener('click', leave);

  $('#btn-rules').addEventListener('click', () => $('#dlg-rules').showModal());

  function updateSoundBtn() {
    const b = $('#btn-sound');
    b.textContent = S.muted ? '효과음 끔' : '효과음 켬';
    b.setAttribute('aria-pressed', String(!S.muted));
  }
  $('#btn-sound').addEventListener('click', () => {
    S.muted = !S.muted;
    store.set('hg-muted', S.muted);
    updateSoundBtn();
    if (!S.muted) sfx.flip();
  });

  // 종은 pointerdown 으로 바로 반응 (클릭이 올라올 때까지 기다리지 않음)
  document.addEventListener('pointerdown', (e) => {
    audio();
    const el = e.target.closest('[data-act="bell"]');
    if (el && !el.disabled) {
      e.preventDefault();
      send({ t: 'bell' });
    }
  });
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act="flip"]');
    if (el && !el.disabled) send({ t: 'flip' });
  });
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (S.screen !== 'game' || !S.state || S.state.phase !== 'playing') return;
    if (e.code === 'Space') {
      e.preventDefault();
      send({ t: 'bell' });
    } else if (e.key === 'f' || e.key === 'F' || e.key === 'Enter') {
      e.preventDefault();
      send({ t: 'flip' });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!S.ws || S.ws.readyState > 1)) connect();
  });

  // 남은 시간 막대
  function tick() {
    if (S.screen === 'game' && S.deadlineAt && S.totalMs) {
      const f = Math.max(0, S.deadlineAt - performance.now()) / S.totalMs;
      document.querySelectorAll('.seat.turn .timer i').forEach((b) => (b.style.transform = `scaleX(${f})`));
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ 시작
  function boot() {
    $('#name').value = store.get('hg-name') || '';

    // 홈 화면의 규칙 예시: 딸기 2 + 딸기 3 = 종
    $('#hero-demo').innerHTML =
      cardHTML({ fruit: 'strawberry', n: 2 }) +
      '<span class="op">+</span>' +
      cardHTML({ fruit: 'strawberry', n: 3 }) +
      '<span class="op">=</span><span class="bell-mini">🔔</span>';

    const urlCode = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (urlCode) {
      $('#code').value = urlCode;
      $('#form-home').classList.add('invited');
      const note = $('#invite-note');
      note.textContent = `${urlCode} 방에 초대받았어요. 이름을 적고 입장하세요.`;
      note.classList.remove('hidden');
      if (S.session && S.session.code !== urlCode) clearSession(false);
    }

    updateSoundBtn();
    showScreen(S.session ? 'loading' : 'home');
    connect();
    requestAnimationFrame(tick);
  }
  boot();
})();
