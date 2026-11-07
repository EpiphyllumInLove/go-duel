import type { Cell, ScoreResult, Stone } from './go';

export type { Cell, Stone, ScoreResult };
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
  | { type: 'pong' };

/** 挂在 WebSocket 上的身份信息（Hibernation 唤醒后仍可读） */
export interface SocketAttachment {
  token: string | null;
  color: PlayerColor | null;
}