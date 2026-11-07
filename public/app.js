'use strict';

/* ------------------------------------------------------------------ */
/* Go Duel 前端：原生 JS，无构建步骤                                    */
/* 服务协议见 src/shared/types.ts                                      */
/* ------------------------------------------------------------------ */

const ROOM_RE = /^[A-Z0-9]{6}$/;
/** localStorage 里保存 playerToken 的 key 前缀 */
const TOKEN_KEY_SAFE = (room) => 'go-duel:token:' + room;

const IDS = [
  'lobby',
  'game',
  'room-input',
  'btn-create',
  'btn-join',
  'btn-copy',
  'btn-pass',
  'btn-undo',
  'btn-resign',
  'btn-restart',
  'btn-leave',
  'btn-swap',
  'undo-panel',
  'undo-text',
  'btn-undo-accept',
  'btn-undo-reject',
  'btn-undo-cancel',
  'room-code',
  'turn-label',
  'black-status',
  'white-status',
  'black-you',
  'white-you',
  'seat-black',
  'seat-white',
  'capture-label',
  'move-label',
  'result-label',
  'toast',
  'canvas',
  'board-overlay',
  'conn-label',
  'spectator-label',
  'komi-label',
  'lobby-error',
];

const els = {};

let socket = null;
let gameState = null;
let currentRoom = '';
let manualClose = false;
let reconnectTimer = null;
let reconnectDelay = 1000;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

function boot() {
  for (const id of IDS) els[id] = document.getElementById(id);

  els['btn-create'].addEventListener('click', () => {
    navigateToRoom(randomRoomCode());
  });

  els['btn-join'].addEventListener('click', () => {
    const code = (els['room-input'].value || '').trim().toUpperCase();
    if (!ROOM_RE.test(code)) {
      els['lobby-error'].textContent = '房间码必须是 6 位大写字母或数字';
      return;
    }
    els['lobby-error'].textContent = '';
    navigateToRoom(code);
  });

  els['room-input'].addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els['btn-join'].click();
  });

  els['btn-copy'].addEventListener('click', copyLink);
  els['btn-leave'].addEventListener('click', () => {
    manualClose = true;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
    location.href = location.pathname;
  });

  els['btn-pass'].addEventListener('click', () => send({ type: 'pass' }));
  els['btn-undo'].addEventListener('click', requestUndo);
  els['btn-resign'].addEventListener('click', () => {
    if (window.confirm('确定认输？')) send({ type: 'resign' });
  });
  els['btn-restart'].addEventListener('click', () => send({ type: 'restart' }));
  els['btn-undo-accept'].addEventListener('click', () => send({ type: 'undoAccept' }));
  els['btn-undo-reject'].addEventListener('click', () => send({ type: 'undoReject' }));
  els['btn-undo-cancel'].addEventListener('click', () => send({ type: 'undoCancel' }));
  els['btn-swap'].addEventListener('click', () => {
    const target = gameState && gameState.you === 'black' ? 'white' : 'black';
    send({ type: 'chooseColor', color: target });
  });

  els['canvas'].addEventListener('click', onCanvasClick);
  window.addEventListener('resize', () => {
    if (gameState) drawBoard(gameState);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && currentRoom && (!socket || socket.readyState > 1)) {
      connect(currentRoom);
    }
  });

  const params = new URLSearchParams(location.search);
  const room = (params.get('room') || '').trim().toUpperCase();
  if (ROOM_RE.test(room)) {
    enterRoom(room);
  } else {
    els['lobby'].classList.remove('hidden');
  }
}

/* ------------------------------------------------------------------ */
/* 房间入口                                                           */
/* ------------------------------------------------------------------ */

function randomRoomCode() {
  // 去掉易混淆字符 0/O/1/I
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < 6; i++) out += chars[buf[i] % chars.length];
  return out;
}

function navigateToRoom(code) {
  location.href = `${location.pathname}?room=${code}`;
}

function enterRoom(room) {
  currentRoom = room;
  els['lobby'].classList.add('hidden');
  els['game'].classList.remove('hidden');
  els['room-code'].textContent = room;
  els['result-label'].classList.add('hidden');
  setOverlay('正在连接服务器…');
  connect(room);
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                          */
/* ------------------------------------------------------------------ */

function connect(room) {
  clearTimeout(reconnectTimer);
  if (socket) {
    manualClose = true;
    try {
      socket.close();
    } catch (_) {
      /* ignore */
    }
    socket = null;
  }
  manualClose = false;

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}/ws?room=${encodeURIComponent(room)}`;
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (_) {
    scheduleReconnect(room);
    return;
  }
  socket = ws;

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    setConnected(true);
    const token = loadToken(room);
    ws.send(
      JSON.stringify({ type: 'join', roomCode: room, playerToken: token || undefined }),
    );
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (_) {
      return;
    }
    handleServerMessage(msg);
  });

  ws.addEventListener('close', () => {
    setConnected(false);
    if (!manualClose && currentRoom) scheduleReconnect(currentRoom);
  });

  ws.addEventListener('error', () => setConnected(false));
}

function scheduleReconnect(room) {
  clearTimeout(reconnectTimer);
  setConnected(false);
  setOverlay('连接中断，正在重连…');
  reconnectTimer = setTimeout(() => connect(room), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    toast('未连接到服务器');
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
}

function handleServerMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'joined':
      if (msg.playerToken) saveToken(currentRoom, msg.playerToken);
      break;
    case 'state':
      gameState = msg.state;
      render();
      break;
    case 'error':
      toast(msg.message || '操作失败');
      break;
    case 'notice':
      toast(msg.message || '');
      break;
    case 'pong':
      break;
    default:
      break;
  }
}

function loadToken(room) {
  try {
    return localStorage.getItem(TOKEN_KEY_SAFE(room)) || null;
  } catch (_) {
    return null;
  }
}

function saveToken(room, token) {
  try {
    localStorage.setItem(TOKEN_KEY_SAFE(room), token);
  } catch (_) {
    /* ignore */
  }
}

function setConnected(on) {
  const el = els['conn-label'];
  if (!el) return;
  el.textContent = on ? '已连接' : '连接中断';
  el.classList.toggle('on', on);
  el.classList.toggle('off', !on);
}

function setOverlay(text) {
  const el = els['board-overlay'];
  if (!el) return;
  if (!text) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  el.textContent = text;
  el.classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* 渲染                                                               */
/* ------------------------------------------------------------------ */

function colorName(c) {
  return c === 'black' ? '黑棋' : '白棋';
}

function seatText(seat) {
  if (!seat.joined) return '未加入';
  return seat.connected ? '在线' : '离线';
}

function render() {
  const g = gameState;
  if (!g) return;

  els['room-code'].textContent = g.roomCode;

  els['black-status'].textContent = seatText(g.players.black);
  els['black-status'].classList.toggle('online', g.players.black.connected);
  els['white-status'].textContent = seatText(g.players.white);
  els['white-status'].classList.toggle('online', g.players.white.connected);

  els['black-you'].classList.toggle('hidden', g.you !== 'black');
  els['white-you'].classList.toggle('hidden', g.you !== 'white');
  els['seat-black'].classList.toggle('active', g.currentTurn === 'black' && g.status === 'playing');
  els['seat-white'].classList.toggle('active', g.currentTurn === 'white' && g.status === 'playing');

  els['move-label'].textContent = `手数 ${g.moveNumber}`;
  els['capture-label'].textContent = `提子 黑 ${g.captures.black} / 白 ${g.captures.white}`;
  els['spectator-label'].classList.toggle('hidden', g.you !== null);

  els['komi-label'].classList.remove('hidden');
  els['komi-label'].textContent = `贴目 ${g.komi}`;

  if (g.status === 'waiting') {
    els['turn-label'].textContent = '等待对手加入…';
    setOverlay('等待对手加入\n把链接发给朋友即可开始');
  } else if (g.status === 'finished') {
    els['turn-label'].textContent = '对局已结束';
    setOverlay(null);
  } else if (g.status === 'playing') {
    const mine = g.you === g.currentTurn;
    if (g.you === null) {
      els['turn-label'].textContent = `观战中 · 轮到${colorName(g.currentTurn)}`;
    } else {
      els['turn-label'].textContent = `轮到${colorName(g.currentTurn)}${
        mine ? '（你）' : '（对手）'
      }`;
    }
    // 观战者也应能看清棋盘，不遮挡
    setOverlay(null);
  } else {
    setOverlay(null);
  }

  // 结果
  if (g.result) {
    const winner = g.result.winner === 'draw' ? '和棋' : `${colorName(g.result.winner)}胜`;
    els['result-label'].textContent =
      `${winner} · ${g.result.detail}\n黑 ${g.result.blackScore} : 白 ${g.result.whiteScore}` +
      `（贴目 ${g.result.komi}）`;
    els['result-label'].classList.remove('hidden');
  } else {
    els['result-label'].classList.add('hidden');
  }

  renderUndoPanel(g);
  updateControls(g);
  drawBoard(g);
}

/** 悔棋申请条：申请方显示「等待对手同意 + 撤回」，对手显示「同意 / 拒绝」 */
function renderUndoPanel(g) {
  const panel = els['undo-panel'];
  const req = g.undoRequest || null;

  if (!req) {
    panel.classList.add('hidden');
    return;
  }

  const mine = req.by === g.you;
  els['undo-text'].textContent = mine
    ? '你申请悔一手，等待对手同意…'
    : '对手申请悔一手，是否同意？';

  els['btn-undo-accept'].classList.toggle('hidden', mine);
  els['btn-undo-reject'].classList.toggle('hidden', mine);
  els['btn-undo-cancel'].classList.toggle('hidden', !mine);
  // 观战者只看到文字
  const spectator = g.you === null;
  panel.classList.remove('hidden');
  if (spectator) {
    els['undo-text'].textContent = `${colorName(req.by)} 申请悔一手`;
    els['btn-undo-accept'].classList.add('hidden');
    els['btn-undo-reject'].classList.add('hidden');
    els['btn-undo-cancel'].classList.add('hidden');
  }
}

/** 点「悔棋」：申请回退一手，等待对手同意 */
function requestUndo() {
  const g = gameState;
  if (!g) return;
  if (g.you === null) {
    toast('观战中，不能悔棋');
    return;
  }
  if (g.undoRequest) {
    toast(g.undoRequest.by === g.you ? '申请已发出，等对手同意' : '请先处理对手的悔棋申请');
    return;
  }
  if (!g.undoAvailable) {
    toast(g.undoLeft > 0 ? '最后一手不是你下的，不能悔' : '已经没有可悔的棋了');
    return;
  }
  if (!window.confirm('确定悔一手？\n会向对手发送申请，需要对方同意。')) return;
  send({ type: 'undoRequest', steps: 1 });
}

function updateControls(g) {
  const isPlayer = g.you !== null;
  const myTurn = g.status === 'playing' && isPlayer && g.you === g.currentTurn;
  const pending = Boolean(g.undoRequest);

  els['btn-pass'].disabled = !myTurn || pending;
  els['btn-resign'].disabled = !isPlayer || g.status !== 'playing' || pending;
  els['btn-restart'].disabled = !isPlayer || pending;

  // 悔棋：只有「栈顶是自己的手」才能申请；申请挂起时禁用
  const canUndo = isPlayer && !pending && Boolean(g.undoAvailable);
  els['btn-undo'].disabled = !canUndo;
  els['btn-undo'].textContent = '悔棋';
  els['btn-undo'].title =
    g.undoLeft > 0 ? `本局还剩 ${g.undoLeft} 手可悔` : '本局已无可悔的棋';

  els['btn-restart'].textContent =
    isPlayer && g.restartRequest && g.restartRequest !== g.you
      ? '同意重开'
      : isPlayer && g.restartRequest === g.you
        ? '取消重开'
        : '重开';

  // 第一个加入者可在未落子时交换先后手
  const canSwap = isPlayer && g.moveNumber === 0 && g.status !== 'finished';
  els['btn-swap'].classList.toggle('hidden', !canSwap);
  els['btn-swap'].textContent = g.you === 'black' ? '改执白棋' : '改执黑棋';
}

/* ------------------------------------------------------------------ */
/* 棋盘绘制（Canvas）                                                  */
/* ------------------------------------------------------------------ */

function drawBoard(g) {
  const canvas = els['canvas'];
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const cssSize = Math.max(200, Math.floor(canvas.clientWidth || wrap.clientWidth || 480));
  const dpr = window.devicePixelRatio || 1;

  canvas.width = Math.round(cssSize * dpr);
  canvas.height = Math.round(cssSize * dpr);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);

  const N = g.boardSize || 19;
  const cell = cssSize / (N + 1);

  // 木纹底色
  const bgGrad = ctx.createLinearGradient(0, 0, cssSize, cssSize);
  bgGrad.addColorStop(0, '#e8c184');
  bgGrad.addColorStop(0.5, '#e3b873');
  bgGrad.addColorStop(1, '#d8a95f');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, cssSize, cssSize);

  // 网格
  ctx.strokeStyle = 'rgba(60, 40, 15, 0.8)';
  ctx.lineWidth = Math.max(1, cssSize / 620);
  ctx.beginPath();
  for (let i = 0; i < N; i++) {
    const p = cell * (i + 1);
    ctx.moveTo(cell, p);
    ctx.lineTo(cell * N, p);
    ctx.moveTo(p, cell);
    ctx.lineTo(p, cell * N);
  }
  ctx.stroke();

  // 星位
  ctx.fillStyle = 'rgba(50, 32, 10, 0.9)';
  const hoshiR = Math.max(1.8, cell * 0.07);
  for (const [hx, hy] of hoshiPoints(N)) {
    ctx.beginPath();
    ctx.arc(cell * (hx + 1), cell * (hy + 1), hoshiR, 0, Math.PI * 2);
    ctx.fill();
  }

  // 棋子
  const r = cell * 0.46;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const c = g.board[y * N + x];
      if (c) drawStone(ctx, cell * (x + 1), cell * (y + 1), r, c);
    }
  }

  // 最后一步标记
  if (g.lastMove && g.lastMove.x >= 0) {
    const { x, y, color } = g.lastMove;
    ctx.beginPath();
    ctx.arc(cell * (x + 1), cell * (y + 1), Math.max(2, r * 0.34), 0, Math.PI * 2);
    ctx.fillStyle = color === 'black' ? '#ff6b6b' : '#c62828';
    ctx.fill();
  }
}

function drawStone(ctx, cx, cy, r, color) {
  // 阴影
  ctx.beginPath();
  ctx.arc(cx + r * 0.1, cy + r * 0.12, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.fill();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  const grd = ctx.createRadialGradient(
    cx - r * 0.32,
    cy - r * 0.32,
    r * 0.12,
    cx,
    cy,
    r,
  );
  if (color === 'black') {
    grd.addColorStop(0, '#5f5f5f');
    grd.addColorStop(1, '#040404');
  } else {
    grd.addColorStop(0, '#ffffff');
    grd.addColorStop(0.75, '#f2f2f2');
    grd.addColorStop(1, '#c4c4c4');
  }
  ctx.fillStyle = grd;
  ctx.fill();
  ctx.lineWidth = Math.max(0.5, r * 0.08);
  ctx.strokeStyle = color === 'black' ? 'rgba(0,0,0,0.5)' : 'rgba(120,120,120,0.5)';
  ctx.stroke();
}

function hoshiPoints(N) {
  if (N === 19) {
    return [
      [3, 3], [9, 3], [15, 3],
      [3, 9], [9, 9], [15, 9],
      [3, 15], [9, 15], [15, 15],
    ];
  }
  if (N === 13) {
    return [
      [3, 3], [9, 3],
      [3, 6], [6, 6], [9, 6],
      [3, 9], [9, 9],
    ];
  }
  if (N === 9) {
    return [
      [2, 2], [6, 2],
      [2, 4], [4, 4], [6, 4],
      [2, 6], [6, 6],
    ];
  }
  return [];
}

/* ------------------------------------------------------------------ */
/* 点击落子                                                            */
/* ------------------------------------------------------------------ */

function onCanvasClick(ev) {
  const g = gameState;
  if (!g) return;

  if (g.you === null) {
    toast('观战中，无法落子');
    return;
  }
  if (g.status === 'waiting') {
    toast('等待对手加入');
    return;
  }
  if (g.status === 'finished') {
    toast('对局已结束，可点击重开');
    return;
  }
  if (g.currentTurn !== g.you) {
    toast('还没轮到你');
    return;
  }
  if (g.undoRequest) {
    toast(g.undoRequest.by === g.you ? '悔棋申请等待中' : '请先处理对手的悔棋申请');
    return;
  }

  const rect = els['canvas'].getBoundingClientRect();
  const N = g.boardSize;
  const cell = rect.width / (N + 1);

  const x = Math.round((ev.clientX - rect.left) / cell) - 1;
  const y = Math.round((ev.clientY - rect.top) / cell) - 1;
  if (x < 0 || y < 0 || x >= N || y >= N) return;

  if (g.board[y * N + x]) {
    toast('该点已有棋子');
    return;
  }

  send({ type: 'move', x, y });
}

/* ------------------------------------------------------------------ */
/* 杂项                                                               */
/* ------------------------------------------------------------------ */

async function copyLink() {
  const url = `${location.origin}${location.pathname}?room=${currentRoom}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    toast('链接已复制，快发给朋友');
  } catch (_) {
    toast('复制失败，请手动复制：' + url);
  }
}

function toast(text) {
  const el = els['toast'];
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}

boot();