// Mastermind Duel — 2-player peer-to-peer Mastermind (PeerJS / WebRTC).
// Each player keeps their own secret and scores the opponent's guesses locally,
// so the secret code never leaves the browser until the round is over.

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'];
const PEGS = 4;
const MAX_GUESSES = 10;
const PEER_PREFIX = 'mmduel-';

const $ = (id) => document.getElementById(id);

let peer = null;
let conn = null;
let isHost = false;
let round = 1;
let draft = [];
let S = null; // per-round state
const tickets = { me: { jub: 0, got: 0 }, them: { jub: 0, got: 0 } }; // won this session

function newRound() {
  S = {
    phase: 'setup',     // setup | play | over
    secret: null,
    myReady: false,
    oppReady: false,
    mine: [],           // my guesses at their code: {code, b, w}
    theirs: [],         // their guesses at my code: {code, b, w}
    myTurn: false,
    pending: false,     // waiting for feedback on my last guess
    oppSecret: null,
    wantRematch: false,
    oppRematch: false,
  };
  draft = [];
}

// Host starts odd rounds, guest starts even rounds.
const iStart = () => (round % 2 === 1) === isHost;

function score(secret, guess) {
  let b = 0;
  const sc = Array(COLORS.length).fill(0);
  const gc = Array(COLORS.length).fill(0);
  for (let i = 0; i < PEGS; i++) {
    if (secret[i] === guess[i]) b++;
    else { sc[secret[i]]++; gc[guess[i]]++; }
  }
  let w = 0;
  for (let c = 0; c < COLORS.length; c++) w += Math.min(sc[c], gc[c]);
  return { b, w };
}

const solved = (list) => list.some((g) => g.b === PEGS);

// ---------- Networking ----------

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function createGame() {
  isHost = true;
  const code = randomCode();
  lobbyMsg('Creating room…');
  peer = new Peer(PEER_PREFIX + code);
  peer.on('open', () => {
    const link = `${location.origin}${location.pathname}?room=${code}`;
    $('share-link').value = link;
    $('room-code').textContent = code;
    $('lobby-start').hidden = true;
    $('lobby-wait').hidden = false;
    lobbyMsg('');
  });
  peer.on('connection', (c) => {
    if (conn) { c.on('open', () => c.close()); return; }
    bindConn(c);
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') { peer.destroy(); createGame(); return; }
    lobbyMsg('Connection error: ' + err.type);
  });
}

function joinGame(code) {
  isHost = false;
  code = code.trim().toUpperCase();
  if (!code) return;
  lobbyMsg('Connecting to room ' + code + '…');
  peer = new Peer();
  peer.on('open', () => bindConn(peer.connect(PEER_PREFIX + code, { reliable: true })));
  peer.on('error', (err) => {
    lobbyMsg(err.type === 'peer-unavailable'
      ? 'Room not found. Check the code or ask your friend for a new link.'
      : 'Connection error: ' + err.type);
  });
}

function bindConn(c) {
  c.on('open', () => {
    conn = c;
    history.replaceState(null, '', location.pathname);
    $('lobby').hidden = true;
    $('game').hidden = false;
    newRound();
    render();
  });
  c.on('data', onMessage);
  c.on('close', () => {
    if (S) S.disconnected = true;
    render();
  });
}

const send = (msg) => conn && conn.open && conn.send(msg);

function onMessage(msg) {
  switch (msg.t) {
    case 'ready':
      S.oppReady = true;
      maybeStart();
      break;
    case 'guess': {
      const fb = score(S.secret, msg.code);
      S.theirs.push({ code: msg.code, ...fb });
      send({ t: 'feedback', ...fb });
      S.myTurn = true;
      checkEnd();
      break;
    }
    case 'feedback': {
      const last = S.mine[S.mine.length - 1];
      last.b = msg.b;
      last.w = msg.w;
      S.pending = false;
      S.myTurn = false;
      checkEnd();
      break;
    }
    case 'reveal':
      S.oppSecret = msg.code;
      break;
    case 'rematch':
      S.oppRematch = true;
      maybeRematch();
      break;
  }
  render();
}

// ---------- Game flow ----------

function maybeStart() {
  if (S.myReady && S.oppReady && S.phase === 'setup') {
    S.phase = 'play';
    S.myTurn = iStart();
  }
}

function checkEnd() {
  if (S.pending) return;
  const first = iStart() ? S.mine : S.theirs;
  const second = iStart() ? S.theirs : S.mine;
  if (first.length !== second.length) return;
  if (solved(first) || solved(second) || first.length >= MAX_GUESSES) {
    S.phase = 'over';
    send({ t: 'reveal', code: S.secret });
    const me = solved(S.mine), them = solved(S.theirs);
    if (me && !them) { tickets.me.jub++; tickets.them.got++; celebrate(); }
    if (them && !me) { tickets.them.jub++; tickets.me.got++; consolation(); }
  }
}

function showOverlay(cls, message, ticketText, ticketCls, makeBit) {
  const overlay = document.createElement('div');
  overlay.className = 'celebrate ' + cls;
  const text = document.createElement('div');
  text.className = 'celebrate-text';
  text.textContent = message;
  const ticket = document.createElement('div');
  ticket.className = 'ticket celebrate-ticket ' + ticketCls;
  ticket.textContent = ticketText;
  const stack = document.createElement('div');
  stack.className = 'celebrate-stack';
  if (cls === 'hug') {
    const hug = document.createElement('div');
    hug.className = 'hug-emoji';
    hug.textContent = '🫂';
    stack.appendChild(hug);
  }
  stack.append(text, ticket);
  overlay.appendChild(stack);
  for (let i = 0; i < 40; i++) {
    const bit = makeBit(i);
    bit.style.left = Math.random() * 100 + 'vw';
    bit.style.animationDelay = Math.random() * 1.2 + 's';
    bit.style.animationDuration = 2 + Math.random() * 1.5 + 's';
    bit.style.setProperty('--drift', (Math.random() * 200 - 100) + 'px');
    overlay.appendChild(bit);
  }
  const close = () => overlay.remove();
  overlay.onclick = close;
  setTimeout(close, 4500);
  document.body.appendChild(overlay);
}

function celebrate() {
  showOverlay('win', 'teerak geng maak!', '+1 Jub ticket 💋', '', (i) => {
    const bit = document.createElement('i');
    bit.style.background = COLORS[i % COLORS.length];
    return bit;
  });
}

function consolation() {
  showOverlay('hug', 'mai bpen rai~ got na~', '+1 Got ticket 🫂', 'got', () => {
    const bit = document.createElement('span');
    bit.className = 'heart';
    bit.textContent = '💜';
    return bit;
  });
}

function maybeRematch() {
  if (S.wantRematch && S.oppRematch) {
    round++;
    newRound();
  }
}

function submit() {
  if (draft.length !== PEGS) return;
  if (S.phase === 'setup' && !S.myReady) {
    S.secret = draft;
    S.myReady = true;
    send({ t: 'ready' });
    maybeStart();
  } else if (canGuess()) {
    S.mine.push({ code: draft });
    S.pending = true;
    send({ t: 'guess', code: draft });
  }
  draft = [];
  render();
}

const canGuess = () =>
  S.phase === 'play' && S.myTurn && !S.pending && !solved(S.mine) && S.mine.length < MAX_GUESSES;

const canEdit = () => !S.disconnected && ((S.phase === 'setup' && !S.myReady) || canGuess());

// ---------- Rendering ----------

function pegEl(color, extra = '') {
  const el = document.createElement('div');
  el.className = 'peg ' + extra;
  if (color != null) el.style.background = COLORS[color];
  return el;
}

function pegsEl(code, size = '') {
  const wrap = document.createElement('div');
  wrap.className = 'pegs ' + size;
  for (let i = 0; i < PEGS; i++) wrap.appendChild(pegEl(code ? code[i] : null));
  return wrap;
}

function feedbackEl(g) {
  const fb = document.createElement('div');
  fb.className = 'fb';
  for (let i = 0; i < PEGS; i++) {
    const dot = document.createElement('i');
    if (g.b != null) {
      if (i < g.b) dot.className = 'black';
      else if (i < g.b + g.w) dot.className = 'white';
    }
    fb.appendChild(dot);
  }
  return fb;
}

function renderRows(container, list, isCurrent) {
  container.innerHTML = '';
  for (let i = 0; i < MAX_GUESSES; i++) {
    const g = list[i];
    const row = document.createElement('div');
    row.className = 'guess-row' + (isCurrent && i === list.length ? ' current' : '');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    row.append(num, pegsEl(g && g.code), feedbackEl(g || {}));
    container.appendChild(row);
  }
}

function renderSecret(container, code, label) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'pegs';
  for (let i = 0; i < PEGS; i++) {
    const p = code ? pegEl(code[i]) : pegEl(null, 'hidden');
    if (!code) p.textContent = '?';
    wrap.appendChild(p);
  }
  const lbl = document.createElement('span');
  lbl.className = 'label';
  lbl.textContent = label;
  container.append(wrap, lbl);
}

function statusText() {
  if (S.disconnected) return ['Opponent disconnected. Refresh to start a new game.', 'lose'];
  if (S.phase === 'setup') {
    return S.myReady
      ? ['Waiting for opponent to lock in their code…', '']
      : ['Pick your secret code — 4 colors, repeats allowed', ''];
  }
  if (S.phase === 'play') {
    if (solved(S.theirs) && !solved(S.mine)) return ['They cracked your code! Last chance to tie…', 'lose'];
    if (solved(S.mine)) return ['Cracked it! Waiting for their final guess…', 'win'];
    if (S.pending) return ['Checking your guess…', ''];
    if (S.myTurn) return [`Your turn — guess ${S.mine.length + 1} of ${MAX_GUESSES}`, ''];
    return ['Opponent is guessing…', ''];
  }
  const me = solved(S.mine), them = solved(S.theirs);
  if (me && them) return [`Draw! Both cracked it in ${S.mine.length}.`, ''];
  if (me) return [`You win in ${S.mine.length} guesses! +1 Jub ticket 💋`, 'win'];
  if (them) return [`You lose — they cracked it in ${S.theirs.length}. +1 Got ticket 🫂`, 'lose'];
  return ['Draw — nobody cracked the code.', ''];
}

function render() {
  if (!S) return;
  const [text, cls] = statusText();
  const status = $('status');
  status.textContent = text;
  status.className = 'status ' + cls;

  $('tickets').innerHTML = '';
  [['You', tickets.me], ['Them', tickets.them]].forEach(([who, t]) => {
    const group = document.createElement('div');
    group.className = 'ticket-group';
    const label = document.createElement('span');
    label.textContent = who;
    group.appendChild(label);
    [['jub', '💋', 'Jub tickets'], ['got', '🫂', 'Got tickets']].forEach(([kind, icon, title]) => {
      const el = document.createElement('div');
      el.className = 'ticket ' + kind + (t[kind] ? '' : ' empty');
      el.textContent = `${icon} ×${t[kind]}`;
      el.title = title;
      group.appendChild(el);
    });
    $('tickets').appendChild(group);
  });

  renderSecret($('opp-secret'), S.oppSecret, S.oppSecret ? 'Their code' : 'Their secret');
  renderSecret($('my-secret'), S.secret, S.secret ? 'Your code' : 'Not set');
  renderRows($('my-rows'), S.mine, canGuess());
  renderRows($('their-rows'), S.theirs, false);

  // Input area
  const editable = canEdit();
  $('input').hidden = S.phase === 'over';
  const d = $('draft');
  d.innerHTML = '';
  for (let i = 0; i < PEGS; i++) {
    const p = pegEl(draft[i]);
    p.title = 'Click to remove';
    p.onclick = () => { if (editable && draft[i] != null) { draft.splice(i, 1); render(); } };
    d.appendChild(p);
  }
  document.querySelectorAll('.swatch').forEach((s) => (s.disabled = !editable || draft.length >= PEGS));
  $('btn-clear').disabled = !editable || draft.length === 0;
  $('btn-submit').disabled = !editable || draft.length !== PEGS;
  $('btn-submit').textContent = S.phase === 'setup' ? 'Lock secret' : 'Guess';

  // Game over
  $('over').hidden = S.phase !== 'over';
  const rb = $('btn-rematch');
  rb.disabled = S.wantRematch || S.disconnected;
  rb.textContent = S.wantRematch ? 'Waiting for opponent…' : S.oppRematch ? 'Opponent wants a rematch!' : 'Rematch';
}

function lobbyMsg(text) {
  $('lobby-msg').textContent = text;
}

// ---------- Wire up ----------

COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch';
  b.style.background = c;
  b.onclick = () => { if (draft.length < PEGS) { draft.push(i); render(); } };
  $('palette').appendChild(b);
});

$('btn-clear').onclick = () => { draft = []; render(); };
$('btn-submit').onclick = submit;
$('btn-rematch').onclick = () => {
  S.wantRematch = true;
  send({ t: 'rematch' });
  maybeRematch();
  render();
};
$('btn-create').onclick = createGame;
$('join-form').onsubmit = (e) => { e.preventDefault(); joinGame($('join-code').value); };
$('btn-copy').onclick = () => {
  navigator.clipboard.writeText($('share-link').value).then(() => {
    $('btn-copy').textContent = 'Copied!';
    setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1500);
  });
};

document.addEventListener('keydown', (e) => {
  if ($('game').hidden || !S || !canEdit()) return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= COLORS.length && draft.length < PEGS) { draft.push(n - 1); render(); }
  else if (e.key === 'Backspace') { draft.pop(); render(); }
  else if (e.key === 'Enter') submit();
});

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $('join-code').value = roomParam;
  joinGame(roomParam);
}
