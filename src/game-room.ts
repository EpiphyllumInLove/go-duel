import {
  DEFAULT_BOARD_SIZE,
  DEFAULT_KOMI,
  createBoard,
  isGameOverAfterPass,
  other,
  playMove,
  scoreChinese,
} from './shared/go';
import type { Stone } from './shared/go';
import type {
  ClientMessage,
  GameResult,
  MoveRecord,
  PlayerColor,
  PublicRoomState,
  SocketAttachment,
  StoredRoomState,
} from './shared/types';
import { isValidRoomCode } from './shared/types';
import type { Env } from './env';

const STORAGE_KEY = 'room:v1';
/** 单条消息最大字节数（防滥用） */
const MAX_MESSAGE_BYTES = 2048;
/** playerToken 最大长度 */
const MAX_TOKEN_LENGTH = 64;
/** 广播给前端的最近手数上限（避免 DO storage 单值 128KB 限制） */
const HISTORY_LIMIT = 60;
/** WebSocket.readyState 为 CLOSED 的数值（避免依赖常量名差异） */
const WS_CLOSED = 3;

function isAlive(ws: WebSocket): boolean {
  return ws.readyState !== WS_CLOSED;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 生成 32 位十六进制随机令牌（仅依赖 crypto.getRandomValues） */
function newToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function createEmptyState(roomCode: string, boardSize: number): StoredRoomState {
  const now = Date.now();
  return {
    roomCode,
    boardSize,
    board: createBoard(boardSize),
    currentTurn: 'black',
    status: 'waiting',
    players: { black: null, white: null },
    moveHistory: [],
    moveCount: 0,
    captures: { black: 0, white: 0 },
    lastMove: null,
    passCount: 0,
    koPoint: null,
    result: null,
    restartRequest: null,
    komi: DEFAULT_KOMI,
    createdAt: now,
    updatedAt: now,
  };
}

export class GameRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private state: StoredRoomState;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    // env 目前未使用（零 D1、无 secret），保留签名以便后续扩展
    void env;
    this.state = createEmptyState('', DEFAULT_BOARD_SIZE);
    // 阻塞并发：先恢复持久化状态，避免第一条消息读到空状态
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<StoredRoomState>(STORAGE_KEY);
      if (stored && typeof stored === 'object' && Array.isArray(stored.board)) {
        this.state = stored;
        // 兼容旧版本存档：缺 moveCount 时用历史长度兜底
        if (typeof this.state.moveCount !== 'number') {
          this.state.moveCount = Array.isArray(this.state.moveHistory)
            ? this.state.moveHistory.length
            : 0;
        }
        if (!Array.isArray(this.state.moveHistory)) this.state.moveHistory = [];
        // 连接标记不可信，重连时重新计算
        if (this.state.players.black) this.state.players.black.connected = false;
        if (this.state.players.white) this.state.players.white.connected = false;
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* HTTP / WebSocket 入口                                            */
  /* ---------------------------------------------------------------- */

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomCode = (url.searchParams.get('room') ?? '').toUpperCase();

    if (roomCode && !this.state.roomCode) {
      if (!isValidRoomCode(roomCode)) {
        return new Response('invalid room code', { status: 400 });
      }
      // 首次进入：初始化房间号并持久化
      this.state.roomCode = roomCode;
      await this.persist();
    }

    if (!this.state.roomCode) {
      return new Response('room not initialised', { status: 400 });
    }

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      // 便于调试：HTTP GET 返回公共状态（不含 token）
      return new Response(JSON.stringify(this.buildPublicState(null)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernation API：连接交给运行时托管
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ token: null, color: null } satisfies SocketAttachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------------- */
  /* 消息处理（Hibernation 回调，不要用 addEventListener）             */
  /* ---------------------------------------------------------------- */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let text: string;
    if (typeof message === 'string') {
      text = message;
    } else if (message instanceof ArrayBuffer) {
      if (message.byteLength > MAX_MESSAGE_BYTES) {
        this.sendError(ws, '消息过大');
        return;
      }
      text = new TextDecoder().decode(message);
    } else {
      return;
    }

    if (text.length > MAX_MESSAGE_BYTES) {
      this.sendError(ws, '消息过大');
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      this.sendError(ws, '消息不是合法 JSON');
      return;
    }
    if (!isRecord(data) || typeof data['type'] !== 'string') {
      this.sendError(ws, '缺少消息类型');
      return;
    }

    const msg = data as unknown as ClientMessage;
    try {
      switch (msg.type) {
        case 'join':
          await this.handleJoin(ws, data);
          return;
        case 'move':
          await this.handleMove(ws, data);
          return;
        case 'pass':
          await this.handlePass(ws);
          return;
        case 'resign':
          await this.handleResign(ws);
          return;
        case 'restart':
          await this.handleRestart(ws);
          return;
        case 'chooseColor':
          await this.handleChooseColor(ws, data);
          return;
        case 'ping':
          this.send(ws, { type: 'pong' });
          return;
        default:
          this.sendError(ws, '未知消息类型');
      }
    } catch (err) {
      console.error('[GameRoom] message handler failed', err);
      this.sendError(ws, '服务器内部错误');
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _clean: boolean,
  ): Promise<void> {
    // 连接断开后重算在线状态并广播
    this.broadcast();
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 操作：加入                                                       */
  /* ---------------------------------------------------------------- */

  private async handleJoin(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const rawRoom = typeof data['roomCode'] === 'string' ? data['roomCode'].toUpperCase() : '';
    if (rawRoom && rawRoom !== this.state.roomCode) {
      this.sendError(ws, '房间不匹配');
      return;
    }

    const offeredRaw = data['playerToken'];
    const offered =
      typeof offeredRaw === 'string' &&
      offeredRaw.length > 0 &&
      offeredRaw.length <= MAX_TOKEN_LENGTH
        ? offeredRaw
        : null;

    const s = this.state;
    let color: PlayerColor | null = null;
    let token: string | null = null;

    // 1) 凭 token 恢复座位
    if (offered) {
      if (s.players.black && s.players.black.token === offered) {
        color = 'black';
        token = offered;
      } else if (s.players.white && s.players.white.token === offered) {
        color = 'white';
        token = offered;
      }
    }

    // 2) 空座位入座；座位已满则观战
    if (!color) {
      if (!s.players.black) {
        color = 'black';
        token = newToken();
        s.players.black = { token, connected: true };
      } else if (!s.players.white) {
        color = 'white';
        token = newToken();
        s.players.white = { token, connected: true };
      }
    }
    if (color && token) {
      const seat = color === 'black' ? s.players.black : s.players.white;
      if (seat) seat.connected = true;
    }

    // 3) 顶掉同 token 的旧连接（刷新 / 多标签页）
    if (token) {
      for (const otherWs of this.ctx.getWebSockets()) {
        if (otherWs === ws) continue;
        const att = this.attachment(otherWs);
        if (att.token && att.token === token) {
          try {
            otherWs.close(4000, 'replaced by new connection');
          } catch {
            /* 忽略 */
          }
        }
      }
    }

    ws.serializeAttachment({ token, color } satisfies SocketAttachment);

    // 4) 两人到齐即开局
    if (s.players.black && s.players.white && s.status === 'waiting') {
      s.status = 'playing';
      s.currentTurn = 'black';
    }

    await this.persist();

    this.send(ws, {
      type: 'joined',
      roomCode: s.roomCode,
      playerToken: token,
      color,
    });
    if (color === null) {
      this.sendError(ws, '房间已满，你以观战者身份加入');
    }
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 操作：落子                                                       */
  /* ---------------------------------------------------------------- */

  private async handleMove(ws: WebSocket, data: Record<string, unknown>): Promise<void> {
    const { color } = this.attachment(ws);
    if (!color) {
      this.sendError(ws, '观战者不能落子');
      return;
    }
    const s = this.state;
    if (s.status === 'finished') {
      this.sendError(ws, '对局已结束');
      return;
    }
    if (s.status !== 'playing') {
      this.sendError(ws, '对局尚未开始（等待对手加入）');
      return;
    }
    if (s.currentTurn !== color) {
      this.sendError(ws, '还没轮到你');
      return;
    }

    const x = data['x'];
    const y = data['y'];
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isInteger(x) ||
      !Number.isInteger(y)
    ) {
      this.sendError(ws, '坐标必须是整数');
      return;
    }

    const res = playMove(s.board, s.boardSize, color, x, y, s.koPoint);
    if (!res.ok) {
      this.sendError(ws, res.error);
      return;
    }

    s.board = res.board;
    s.captures[color] += res.captures;
    s.koPoint = res.koPoint;
    s.passCount = 0;
    s.lastMove = { x, y, color };
    s.restartRequest = null;
    this.pushMove({
      moveNumber: s.moveCount + 1,
      color,
      x,
      y,
      pass: false,
      captures: res.captures,
    });
    s.currentTurn = other(color);

    await this.persist();
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 操作：Pass                                                       */
  /* ---------------------------------------------------------------- */

  private async handlePass(ws: WebSocket): Promise<void> {
    const { color } = this.attachment(ws);
    if (!color) {
      this.sendError(ws, '观战者不能弃一手');
      return;
    }
    const s = this.state;
    if (s.status !== 'playing') {
      this.sendError(ws, '当前无法 Pass');
      return;
    }
    if (s.currentTurn !== color) {
      this.sendError(ws, '还没轮到你');
      return;
    }

    s.passCount += 1;
    s.koPoint = null;
    s.lastMove = null;
    s.restartRequest = null;
    this.pushMove({
      moveNumber: s.moveCount + 1,
      color,
      x: -1,
      y: -1,
      pass: true,
      captures: 0,
    });
    s.currentTurn = other(color);

    if (isGameOverAfterPass(s.passCount)) {
      this.finishByScore();
    }

    await this.persist();
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 操作：认输                                                       */
  /* ---------------------------------------------------------------- */

  private async handleResign(ws: WebSocket): Promise<void> {
    const { color } = this.attachment(ws);
    if (!color) {
      this.sendError(ws, '观战者不能认输');
      return;
    }
    const s = this.state;
    if (s.status === 'finished') {
      this.sendError(ws, '对局已结束');
      return;
    }
    if (s.status !== 'playing') {
      this.sendError(ws, '对局尚未开始');
      return;
    }
    const score = scoreChinese(s.board, s.boardSize, s.komi);
    const winner: Stone = other(color);
    s.status = 'finished';
    s.result = {
      winner,
      reason: 'resign',
      blackScore: score.black,
      whiteScore: score.white,
      komi: s.komi,
      detail: `${winner === 'black' ? '黑' : '白'}胜（对方认输）`,
    };
    s.restartRequest = null;
    await this.persist();
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 操作：重开（双方都按才真正重开）                                  */
  /* ---------------------------------------------------------------- */

  private async handleRestart(ws: WebSocket): Promise<void> {
    const { color } = this.attachment(ws);
    if (!color) {
      this.sendError(ws, '观战者不能重开');
      return;
    }
    const s = this.state;

    // 还没落过子且未结束 → 无需重开
    if (s.moveCount === 0 && s.status !== 'finished') {
      s.restartRequest = null;
      await this.persist();
      this.broadcast();
      return;
    }

    if (s.restartRequest && s.restartRequest !== color) {
      // 对方已请求 → 真正重开
      this.resetBoard();
      await this.persist();
      this.broadcast();
      return;
    }

    // 自己第一次请求 / 再次点击取消
    s.restartRequest = s.restartRequest === color ? null : color;
    await this.persist();
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 操作：开局前交换先后手                                            */
  /* ---------------------------------------------------------------- */

  private async handleChooseColor(
    ws: WebSocket,
    data: Record<string, unknown>,
  ): Promise<void> {
    const { color } = this.attachment(ws);
    if (!color) {
      this.sendError(ws, '观战者不能选择先后手');
      return;
    }
    const target = data['color'];
    if (target !== 'black' && target !== 'white') {
      this.sendError(ws, '颜色参数非法');
      return;
    }
    const s = this.state;
    if (s.moveCount > 0) {
      this.sendError(ws, '对局已开始，无法更改先后手');
      return;
    }
    if (target === color) return;

    const me = color === 'black' ? s.players.black : s.players.white;
    const rivalColor = other(color);
    const rival = rivalColor === 'black' ? s.players.black : s.players.white;
    if (!me) return;

    // 交换（或把自己移动到空位）
    if (target === 'black') {
      s.players.black = me;
      s.players.white = rival;
    } else {
      s.players.white = me;
      s.players.black = rival;
    }

    // 重新映射所有连接的 color 附件
    this.remapAttachments();
    s.currentTurn = 'black';
    await this.persist();
    this.broadcast();
  }

  /* ---------------------------------------------------------------- */
  /* 内部工具                                                          */
  /* ---------------------------------------------------------------- */

  /** 追加一手记录，并把历史裁剪到 HISTORY_LIMIT 条 */
  private pushMove(record: MoveRecord): void {
    const s = this.state;
    s.moveHistory.push(record);
    s.moveCount += 1;
    if (s.moveHistory.length > HISTORY_LIMIT) {
      s.moveHistory.splice(0, s.moveHistory.length - HISTORY_LIMIT);
    }
  }

  private remapAttachments(): void {
    const s = this.state;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachment(ws);
      if (!att.token) continue;
      let newColor: PlayerColor | null = null;
      if (s.players.black && s.players.black.token === att.token) newColor = 'black';
      else if (s.players.white && s.players.white.token === att.token) newColor = 'white';
      ws.serializeAttachment({ token: att.token, color: newColor } satisfies SocketAttachment);
    }
  }

  private resetBoard(): void {
    const s = this.state;
    s.board = createBoard(s.boardSize);
    s.currentTurn = 'black';
    s.moveHistory = [];
    s.moveCount = 0;
    s.captures = { black: 0, white: 0 };
    s.lastMove = null;
    s.passCount = 0;
    s.koPoint = null;
    s.result = null;
    s.restartRequest = null;
    s.status = s.players.black && s.players.white ? 'playing' : 'waiting';
  }

  private finishByScore(): void {
    const s = this.state;
    const score = scoreChinese(s.board, s.boardSize, s.komi);
    const detail =
      score.winner === 'draw'
        ? `和棋（黑 ${score.black} : 白 ${score.white}，贴目 ${s.komi}）`
        : `${score.winner === 'black' ? '黑' : '白'}胜 ${score.black} : ${score.white}（贴目 ${s.komi}）`;
    s.status = 'finished';
    s.result = {
      winner: score.winner,
      reason: 'score',
      blackScore: score.black,
      whiteScore: score.white,
      komi: s.komi,
      detail,
    } satisfies GameResult;
  }

  private attachment(ws: WebSocket): SocketAttachment {
    const raw = ws.deserializeAttachment() as unknown;
    if (!isRecord(raw)) return { token: null, color: null };
    const token = typeof raw['token'] === 'string' ? raw['token'] : null;
    const color =
      raw['color'] === 'black' || raw['color'] === 'white'
        ? (raw['color'] as PlayerColor)
        : null;
    return { token, color };
  }

  private refreshConnectionFlags(): void {
    const tokens = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (!isAlive(ws)) continue;
      const att = this.attachment(ws);
      if (att.token) tokens.add(att.token);
    }
    const s = this.state;
    if (s.players.black) s.players.black.connected = tokens.has(s.players.black.token);
    if (s.players.white) s.players.white.connected = tokens.has(s.players.white.token);
  }

  private countSpectators(): number {
    let n = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (!isAlive(ws)) continue;
      if (!this.attachment(ws).token) n++;
    }
    return n;
  }

  private buildPublicState(viewer: PlayerColor | null): PublicRoomState {
    const s = this.state;
    return {
      roomCode: s.roomCode,
      boardSize: s.boardSize,
      board: s.board,
      currentTurn: s.currentTurn,
      status: s.status,
      players: {
        black: {
          joined: s.players.black !== null,
          connected: s.players.black?.connected ?? false,
        },
        white: {
          joined: s.players.white !== null,
          connected: s.players.white?.connected ?? false,
        },
      },
      spectatorCount: this.countSpectators(),
      moveNumber: s.moveCount,
      moveHistory: s.moveHistory,
      captures: s.captures,
      lastMove: s.lastMove,
      passCount: s.passCount,
      koPoint: s.koPoint,
      result: s.result,
      restartRequest: s.restartRequest,
      komi: s.komi,
      you: viewer,
    };
  }

  private async persist(): Promise<void> {
    this.state.updatedAt = Date.now();
    await this.ctx.storage.put(STORAGE_KEY, this.state);
  }

  private broadcast(): void {
    this.refreshConnectionFlags();
    for (const ws of this.ctx.getWebSockets()) {
      if (!isAlive(ws)) continue;
      const att = this.attachment(ws);
      this.send(ws, { type: 'state', state: this.buildPublicState(att.color) });
    }
  }

  private send(ws: WebSocket, message: { type: string } & Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* 连接已关闭，忽略 */
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    this.send(ws, { type: 'error', message });
  }
}