import type { Cell, MoveUndo, ScoreResult, Stone } from './go';

export type { Cell, Stone, ScoreResult, MoveUndo };
export type PlayerColor = Stone;
export type GameStatus = 'waiting' | 'playing' | 'finished';

/** 房间码：6 位大写字母或数字 */
export const ROOM_CODE_PATTERN = /^[A-Z0-9]{6}$/;

export function normalizeRoomCode(input: unknown): string {
  return typeof input === 'string' ? input.trim().toUpperCase() : '';
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_PATTERN.test(code);
}

/* ------------------------------------------------------------------ */
/* 服务端内部状态（持久化到 DO storage）                               */
/* ------------------------------------------------------------------ */

export interface SeatState {
  /** 玩家令牌：只有本人知道，永不写入广播 */
  token: string;
  /** 由活跃 WebSocket 实时推算，持久化值不可信 */
  connected: boolean;
}

export interface MoveRecord {
  moveNumber: number;
  color: Stone;
  /** pass 时为 -1 */
  x: number;
  y: number;
  pass: boolean;
  captures: number;
}

/** 待对手确认的悔棋申请 */
export interface UndoRequest {
  /** 申请方颜色 */
  by: PlayerColor;
  /** 回退手数：固定 1（保留字段便于将来扩展，服务端只接受 1） */
  steps: number;
  /** 申请时间戳，用于超时作废 */
  at: number;
}

/** 悔棋栈条目：比纯函数所需字段多带了「这一手之前的局面快照」 */
export interface UndoEntry extends MoveUndo {
  /** 这一手之前的 koPoint，悔棋时精确恢复 */
  prevKoPoint: number | null;
  /** 这一手之前的 passCount */
  prevPassCount: number;
  /** 这一手之前的 lastMove */
  prevLastMove: { x: number; y: number; color: Stone } | null;
}

export interface GameResult {
  winner: Stone | 'draw';
  reason: 'resign' | 'score';
  blackScore: number;
  whiteScore: number;
  komi: number;
  detail: string;
}

export interface StoredRoomState {
  roomCode: string;
  boardSize: number;
  board: Cell[];
  currentTurn: PlayerColor;
  status: GameStatus;
  players: { black: SeatState | null; white: SeatState | null };
  /** 最近若干手（有上限，避免 DO storage 单值 128KB 限制） */
  moveHistory: MoveRecord[];
  /** 总手数（不受 moveHistory 截断影响） */
  moveCount: number;
  /**
   * 悔棋栈：最多 3 条，栈顶是最后一手。
   * 保存了恢复局面所需的提子信息与前一局面的快照，因此不随 moveHistory 裁剪。
   */
  undoStack: UndoEntry[];
  /** 待确认的悔棋申请（双方都看得到，用于展示「等待对手同意」） */
  undoRequest: UndoRequest | null;
  /** 各方累计提子数 */
  captures: { black: number; white: number };
  lastMove: { x: number; y: number; color: Stone } | null;
  passCount: number;
  koPoint: number | null;
  result: GameResult | null;
  /** 请求重开的一方；双方都按才真正重开 */
  restartRequest: PlayerColor | null;
  komi: number;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* 广播结构（不含任何 token）                                          */
/* ------------------------------------------------------------------ */

export interface PublicSeat {
  joined: boolean;
  connected: boolean;
}

export interface PublicRoomState {
  roomCode: string;
  boardSize: number;
  board: Cell[];
  currentTurn: PlayerColor;
  status: GameStatus;
  players: { black: PublicSeat; white: PublicSeat };
  spectatorCount: number;
  /** 总手数（含被裁剪掉的历史） */
  moveNumber: number;
  /** 最近 HISTORY_LIMIT 手 */
  moveHistory: MoveRecord[];
  captures: { black: number; white: number };
  lastMove: { x: number; y: number; color: Stone } | null;
  passCount: number;
  koPoint: number | null;
  result: GameResult | null;
  restartRequest: PlayerColor | null;
  /** 待确认的悔棋申请（观战者也能看到，但不含 token） */
  undoRequest: UndoRequest | null;
  /** 这条连接现在能不能悔一手：1 可以，0 不行（栈顶不是自己下的手也不行） */
  undoAvailable: number;
  /** 全局还剩几手可悔（栈深，上限 3） */
  undoLeft: number;
  komi: number;
  /** 该连接自己的颜色；观战者为 null。每个接收者不同，所以逐条发送 */
  you: PlayerColor | null;
}

/* ------------------------------------------------------------------ */
/* 消息协议                                                            */
/* ------------------------------------------------------------------ */

export type ClientMessage =
  | { type: 'join'; roomCode: string; playerToken?: string }
  | { type: 'move'; x: number; y: number }
  | { type: 'pass' }
  | { type: 'resign' }
  | { type: 'restart' }
  | { type: 'undoRequest'; steps?: number }
  | { type: 'undoAccept' }
  | { type: 'undoReject' }
  | { type: 'undoCancel' }
  | { type: 'chooseColor'; color: PlayerColor }
  | { type: 'ping' };

export type ServerMessage =
  | {
      type: 'joined';
      roomCode: string;
      playerToken: string | null;
      color: PlayerColor | null;
    }
  | { type: 'state'; state: PublicRoomState }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string }
  | { type: 'pong' };

/** 挂在 WebSocket 上的身份信息（Hibernation 唤醒后仍可读） */
export interface SocketAttachment {
  token: string | null;
  color: PlayerColor | null;
}