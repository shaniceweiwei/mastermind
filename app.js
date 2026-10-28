// Mastermind Duel — 2-player peer-to-peer Mastermind (PeerJS / WebRTC).
// Each player keeps their own secret and scores the opponent's guesses locally,
// so the secret code never leaves the browser until the round is over.

const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6',
                '#e67e22', '#1abc9c', '#fd79a8', '#8d6e63', '#95a5a6'];
const PEGS = 4;
const MAX_GUESSES = 10;
const PEER_PREFIX = 'mmduel-';

const $ = (id) => document.getElementById(id);

let peer = null;
let conn = null;
let online = false;   // data connection to the opponent is up
let isHost = false;   // I'm the one registered under the room's peer id (can change on reconnect)
let p1 = false;       // stable seat: player 1 starts odd rounds
let roomCode = '';
let numColors = 6;    // how many colors are in play (6–10), set by the room creator
let round = 1;
let draft = [];
let lastSentDraft = '';
let lastSeen = 0;
let S = null; // per-round state
let tickets = { me: { jub: 0, got: 0 }, them: { jub: 0, got: 0 } };

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
    oppDraft: null,     // opponent's in-progress guess, streamed live
    result: null,       // frozen at game end: {me, them, nMine, nTheirs}
    revealed: false,    // my secret has been sent to the opponent
    wantRematch: false,
    oppRematch: false,
  };
  draft = [];
  lastSentDraft = '';
}

// Player 1 starts odd rounds, player 2 starts even rounds.
const iStart = () => (round % 2 === 1) === p1;

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

// The game is saved per room so a refresh (or coming back later) can pick up where it left off.
const storeKey = () => 'mmduel:' + roomCode;

function save() {
  try { localStorage.setItem(storeKey(), JSON.stringify({ S, round, p1, tickets, numColors })); } catch {}
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(storeKey()));
    if (d && d.S) ({ S, round, p1, tickets } = d);
    if (d && d.numColors) numColors = d.numColors;
  } catch {}
}

function enterRoom(code, create) {
  roomCode = code.trim().toUpperCase();
  if (!roomCode) return;
  history.replaceState(null, '', `${location.pathname}?room=${roomCode}`);
  $('share-link').value = location.href;
  $('room-code').textContent = roomCode;
  load();
  if (S) { showGame(); render(); }
  create ? host() : join();
}

function resetPeer() {
  if (peer) peer.destroy();
  peer = null;
}

// Register under the room id and wait for the opponent. If the id is taken, someone
// is already hosting — join them instead.
function host() {
  resetPeer();
  isHost = true;
  lobbyMsg('Opening room…');
  peer = new Peer(PEER_PREFIX + roomCode);
  peer.on('open', () => {
    $('lobby-start').hidden = true;
    $('lobby-wait').hidden = false;
    lobbyMsg('');
  });
  peer.on('connection', bindConn);
  peer.on('disconnected', () => peer && !peer.destroyed && peer.reconnect());
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') setTimeout(join, 1500);
    else lobbyMsg('Connection error: ' + err.type);
  });
}

// Connect to whoever hosts the room. If nobody does (e.g. they refreshed), host it ourselves.
function join() {
  resetPeer();
  isHost = false;
  lobbyMsg('Connecting to room ' + roomCode + '…');
  peer = new Peer();
  peer.on('open', () => bindConn(peer.connect(PEER_PREFIX + roomCode, { reliable: true })));
  peer.on('error', (err) => {
    if (err.type === 'peer-unavailable') setTimeout(host, 500);
    else lobbyMsg('Connection error: ' + err.type);
  });
}

function bindConn(c) {
  c.on('open', () => {
    const old = conn;
    conn = c;
    if (old) old.close(); // a rejoin replaces a stale connection
    online = true;
    lastSeen = Date.now();
    lastSentDraft = null;
    send({ t: 'hello', fresh: !S, round, p1, tickets, numColors });
  });
  c.on('data', (msg) => {
    if (c !== conn) return;
    lastSeen = Date.now();
    onMessage(msg);
  });
  c.on('close', () => { if (c === conn) dropped(); });
}

function dropped() {
  conn = null;
  online = false;
  render();
  // The host keeps listening; a guest goes back to join-or-host until the opponent is back.
  if (!isHost) setTimeout(() => { if (!conn) join(); }, 1500);
}

// Heartbeat: notice a vanished opponent even when WebRTC doesn't report the close.
// Generous timeout because browsers throttle timers in background tabs to ~1/min.
setInterval(() => {
  if (!conn) return;
  if (Date.now() - lastSeen > 75000) { const c = conn; dropped(); c.close(); return; }
  send({ t: 'ping' });
}, 5000);

// Close cleanly on refresh/leave so the opponent notices right away.
window.addEventListener('pagehide', () => conn && conn.close());

const send = (msg) => conn && conn.open && conn.send(msg);

function showGame() {
  $('lobby').hidden = true;
  $('game').hidden = false;
}

const swapTickets = (t) => ({ me: t.them, them: t.me });

function onHello(h) {
  if (!S && h.fresh) {
    // Brand-new game.
    p1 = isHost;
    if (!isHost) numColors = h.numColors; // the room host's choice wins
    round = 1;
    newRound();
  } else if (!S) {
    // I lost my saved game (new device / cleared storage): take the opponent's side of it
    // and start a fresh round, since my old secret is gone.
    p1 = !h.p1;
    numColors = h.numColors;
    round = h.round + 1;
    tickets = swapTickets(h.tickets);
    newRound();
  } else if (h.fresh) {
    // Opponent lost their game — start a fresh round together.
    round++;
    newRound();
  } else {
    // Both still have the game: catch up on anything sent while disconnected.
    if (h.round > round) { round = h.round; newRound(); } // they advanced on my rematch
    if (S.myReady) send({ t: 'ready' });
    if (S.pending) send({ t: 'guess', code: S.mine[S.mine.length - 1].code, n: S.mine.length - 1 });
    if (S.revealed) send({ t: 'reveal', code: S.secret });
    if (S.wantRematch) send({ t: 'rematch', round });
  }
  showGame();
}

function onMessage(msg) {
  if (msg.t === 'ping') return;
  if (msg.t === 'hello') { onHello(msg); render(); return; }
  if (!S) return;
  switch (msg.t) {
    case 'ready':
      S.oppReady = true;
      maybeStart();
      break;
    case 'draft':
      S.oppDraft = msg.code;
      break;
    case 'guess': {
      // Already scored (resent after a reconnect)? Just resend that feedback.
      const old = S.theirs[msg.n];
      if (old) { send({ t: 'feedback', b: old.b, w: old.w, n: msg.n }); break; }
      S.oppDraft = null;
      const fb = score(S.secret, msg.code);
      S.theirs.push({ code: msg.code, ...fb });
      send({ t: 'feedback', ...fb, n: msg.n });
      S.myTurn = true;
      checkEnd();
      maybeReveal();
      break;
    }
    case 'feedback': {
      if (!S.pending || msg.n !== S.mine.length - 1) break;
      const last = S.mine[msg.n];
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
      if (msg.round !== round) break;
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
  if (S.pending || S.phase !== 'play') return;
  const first = iStart() ? S.mine : S.theirs;
  const second = iStart() ? S.theirs : S.mine;
  if (first.length !== second.length) return;
  if (solved(first) || solved(second) || first.length >= MAX_GUESSES) {
    S.phase = 'over';
    const me = solved(S.mine), them = solved(S.theirs);
    S.result = { me, them, nMine: S.mine.length, nTheirs: S.theirs.length };
    if (me && !them) { tickets.me.jub++; tickets.them.got++; celebrate(); }
    if (them && !me) { tickets.them.jub++; tickets.me.got++; consolation(); }
    maybeReveal();
  }
}

// Send my secret only once the opponent can no longer guess it — a loser who is
// still finishing never receives it, so it can't be peeked at in devtools.
function maybeReveal() {
  if (S.phase !== 'over' || S.revealed || theyMustFinish()) return;
  S.revealed = true;
  send({ t: 'reveal', code: S.secret });
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
    send({ t: 'guess', code: draft, n: S.mine.length - 1 });
  }
  draft = [];
  render();
}

const canGuess = () =>
  !S.pending && !solved(S.mine) && S.mine.length < MAX_GUESSES &&
  ((S.phase === 'play' && S.myTurn) || iMustFinish());

// After losing, the result is locked in but the loser keeps guessing until they
// crack the code or run out — rematch unlocks only once they're done.
const finishing = (lost, list) =>
  S.phase === 'over' && lost && !solved(list) && list.length < MAX_GUESSES;
const iMustFinish = () => finishing(S.result.them && !S.result.me, S.mine);
const theyMustFinish = () => finishing(S.result.me && !S.result.them, S.theirs);

const canEdit = () => online && ((S.phase === 'setup' && !S.myReady) || canGuess());

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

// `live` is an in-progress guess shown in the next empty row (null = none).
function renderRows(container, list, live, liveCls) {
  container.innerHTML = '';
  for (let i = 0; i < MAX_GUESSES; i++) {
    const g = list[i];
    const isLive = live && i === list.length;
    const row = document.createElement('div');
    row.className = 'guess-row' + (isLive ? ' ' + liveCls : '');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i + 1;
    row.append(num, pegsEl(g ? g.code : isLive ? live : null), feedbackEl(g || {}));
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
  if (!online) return [`Waiting for opponent to (re)join room ${roomCode}…`, 'lose'];
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
  const { me, them, nMine, nTheirs } = S.result;
  if (me && them) return [`Draw! Both cracked it in ${nMine}.`, ''];
  if (me) {
    const wait = theyMustFinish() ? ' · Waiting for them to finish 👀' : '';
    return [`You win in ${nMine} guesses! +1 Jub ticket 💋` + wait, 'win'];
  }
  if (them) {
    if (solved(S.mine)) return [`Lost, but you still cracked it in ${S.mine.length} 💪`, ''];
    if (iMustFinish()) {
      return [S.pending ? 'Checking your guess…'
        : `They won — now finish cracking theirs! Guess ${S.mine.length + 1} of ${MAX_GUESSES}`, 'lose'];
    }
    return [`You lose — they cracked it in ${nTheirs}. +1 Got ticket 🫂`, 'lose'];
  }
  return ['Draw — nobody cracked the code.', ''];
}

function render() {
  if (!S) return;
  save();
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

  const showOpp = S.oppSecret && !iMustFinish(); // keep it hidden while I'm still guessing
  renderSecret($('opp-secret'), showOpp ? S.oppSecret : null, showOpp ? 'Their code' : 'Their secret');
  renderSecret($('my-secret'), S.secret, S.secret ? 'Your code' : 'Not set');
  renderRows($('my-rows'), S.mine, canGuess() ? draft : null, 'current');
  renderRows($('their-rows'), S.theirs, S.phase !== 'setup' ? S.oppDraft : null, 'current live');

  // Stream my in-progress guess so the opponent can watch live (never during setup — that's the secret).
  const key = draft.join(',');
  if (canGuess() && key !== lastSentDraft) {
    lastSentDraft = key;
    send({ t: 'draft', code: draft });
  }

  // Input area
  const editable = canEdit();
  $('input').hidden = S.phase === 'over' && !iMustFinish();
  const d = $('draft');
  d.innerHTML = '';
  for (let i = 0; i < PEGS; i++) {
    const p = pegEl(draft[i]);
    p.title = 'Click to remove';
    p.onclick = () => { if (editable && draft[i] != null) { draft.splice(i, 1); render(); } };
    d.appendChild(p);
  }
  buildPalette();
  document.querySelectorAll('.swatch').forEach((s) => (s.disabled = !editable || draft.length >= PEGS));
  $('btn-clear').disabled = !editable || draft.length === 0;
  $('btn-submit').disabled = !editable || draft.length !== PEGS;
  $('btn-submit').textContent = S.phase === 'setup' ? 'Lock secret' : 'Guess';

  // Game over
  $('over').hidden = S.phase !== 'over';
  const rb = $('btn-rematch');
  const blocked = S.phase === 'over' && (iMustFinish() || theyMustFinish());
  rb.disabled = S.wantRematch || !online || S.pending || blocked;
  rb.textContent = blocked
    ? (iMustFinish() ? 'Finish cracking their code to rematch' : 'Rematch after they finish…')
    : S.wantRematch ? 'Waiting for opponent…' : S.oppRematch ? 'Opponent wants a rematch!' : 'Rematch';
}

function lobbyMsg(text) {
  $('lobby-msg').textContent = text;
}

// ---------- Wire up ----------

function buildPalette() {
  const pal = $('palette');
  if (pal.children.length === numColors) return;
  pal.innerHTML = '';
  COLORS.slice(0, numColors).forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.style.background = c;
    b.textContent = (i + 1) % 10; // keyboard shortcut: 1–9, 0
    b.onclick = () => { if (draft.length < PEGS) { draft.push(i); render(); } };
    pal.appendChild(b);
  });
}

$('btn-clear').onclick = () => { draft = []; render(); };
$('btn-submit').onclick = submit;
$('btn-rematch').onclick = () => {
  S.wantRematch = true;
  send({ t: 'rematch', round });
  maybeRematch();
  render();
};
$('btn-create').onclick = () => {
  numColors = +$('num-colors').value;
  enterRoom(randomCode(), true);
};
$('join-form').onsubmit = (e) => { e.preventDefault(); enterRoom($('join-code').value, false); };
$('btn-copy').onclick = () => {
  navigator.clipboard.writeText($('share-link').value).then(() => {
    $('btn-copy').textContent = 'Copied!';
    setTimeout(() => ($('btn-copy').textContent = 'Copy'), 1500);
  });
};

document.addEventListener('keydown', (e) => {
  if ($('game').hidden || !S || !canEdit()) return;
  const n = parseInt(e.key, 10);
  const idx = n === 0 ? 9 : n - 1;
  if (!isNaN(n) && idx < numColors && draft.length < PEGS) { draft.push(idx); render(); }
  else if (e.key === 'Backspace') { draft.pop(); render(); }
  else if (e.key === 'Enter') submit();
});

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $('join-code').value = roomParam;
  enterRoom(roomParam, false);
}
