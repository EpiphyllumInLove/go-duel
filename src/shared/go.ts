/**
 * 围棋规则引擎（纯函数，前后端可复用）
 *
 * 棋盘用一维数组表示：index = y * size + x
 *
 * 默认棋盘 19 路。把 DEFAULT_BOARD_SIZE 改成 9 或 13 即可切换，
 * 前端无需任何改动（棋盘尺寸、星位、点击换算全部按 boardSize 动态计算）。
 *
 * 计分：简化中国规则数子法（盘面棋子 + 单色围空），不做死子/双活判定。
 * 终局前请把死子提干净。贴目 DEFAULT_KOMI 可配置。
 */

export type Stone = 'black' | 'white';
export type Cell = Stone | null;

/** 默认棋盘路数：19。改成 9 或 13 即切换。 */
export const DEFAULT_BOARD_SIZE = 19;
/** 默认贴目（白方额外得分）。设 0 即无贴目。 */
export const DEFAULT_KOMI = 7.5;

export function other(color: Stone): Stone {
  return color === 'black' ? 'white' : 'black';
}

export function assertSize(size: number): void {
  if (!Number.isInteger(size) || size < 5 || size > 25) {
    throw new Error(`非法棋盘大小: ${size}`);
  }
}

export function createBoard(size: number): Cell[] {
  assertSize(size);
  return new Array<Cell>(size * size).fill(null);
}

export function idx(size: number, x: number, y: number): number {
  return y * size + x;
}

export function pointOf(size: number, index: number): { x: number; y: number } {
  const x = index % size;
  return { x, y: (index - x) / size };
}

export function inBounds(size: number, x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < size &&
    y < size
  );
}

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function neighborIndices(size: number, index: number): number[] {
  const x = index % size;
  const y = (index - x) / size;
  const out: number[] = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) out.push(ny * size + nx);
  }
  return out;
}

export interface GroupInfo {
  /** 该棋块所有棋子的下标 */
  stones: number[];
  /** 气的数量 */
  liberties: number;
}

/** 取某点所在棋块（颜色由该点决定）与气数 */
export function getGroup(
  board: readonly Cell[],
  size: number,
  start: number,
): GroupInfo {
  const color = board[start];
  if (!color) return { stones: [], liberties: 0 };
  const stack: number[] = [start];
  const seen = new Set<number>([start]);
  const stones: number[] = [];
  const libs = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop() as number;
    stones.push(cur);
    for (const ni of neighborIndices(size, cur)) {
      if (board[ni] === null) libs.add(ni);
      else if (board[ni] === color && !seen.has(ni)) {
        seen.add(ni);
        stack.push(ni);
      }
    }
  }
  return { stones, liberties: libs.size };
}

export type MoveResult =
  | {
      ok: true;
      /** 落子后的新棋盘（原棋盘不被修改） */
      board: Cell[];
      /** 本手提掉对方棋子数 */
      captures: number;
      /** 被提掉的点下标 */
      capturedPoints: number[];
      /** 若本手形成简单劫，这里是对方不能立即回提的点 */
      koPoint: number | null;
    }
  | { ok: false; error: string };

/**
 * 尝试落子。校验：越界 / 已有棋子 / 劫争立即回提 / 自杀禁着。
 * 会先自动提掉对方无气棋子，再判断自身是否有气。
 */
export function playMove(
  board: readonly Cell[],
  size: number,
  color: Stone,
  x: number,
  y: number,
  koPoint: number | null = null,
): MoveResult {
  if (!inBounds(size, x, y)) return { ok: false, error: '坐标越界' };
  const p = idx(size, x, y);
  if (board[p] !== null) return { ok: false, error: '该点已有棋子' };
  if (koPoint !== null && p === koPoint) {
    return { ok: false, error: '劫争：不能立即回提' };
  }

  const next = board.slice() as Cell[];
  next[p] = color;

  const opp = other(color);
  let captures = 0;
  const capturedPoints: number[] = [];

  for (const ni of neighborIndices(size, p)) {
    if (next[ni] !== opp) continue;
    const group = getGroup(next, size, ni);
    if (group.liberties === 0) {
      for (const s of group.stones) {
        next[s] = null;
        capturedPoints.push(s);
      }
      captures += group.stones.length;
    }
  }

  if (captures === 0) {
    const own = getGroup(next, size, p);
    if (own.liberties === 0) return { ok: false, error: '自杀禁着' };
  }

  let newKo: number | null = null;
  if (captures === 1) {
    const own = getGroup(next, size, p);
    // 单子提单子且自身只剩一口气 → 形成简单劫
    if (own.stones.length === 1 && own.liberties === 1) {
      newKo = capturedPoints[0];
    }
  }

  return { ok: true, board: next, captures, capturedPoints, koPoint: newKo };
}

/** 连续两次 Pass 即终局 */
export function isGameOverAfterPass(passCount: number): boolean {
  return passCount >= 2;
}

export interface ScoreResult {
  black: number;
  white: number;
  komi: number;
  blackStones: number;
  whiteStones: number;
  blackTerritory: number;
  whiteTerritory: number;
  winner: Stone | 'draw';
}

/**
 * 简化中国规则数子法：盘面棋子数 + 只被单色包围的空点数，白方加贴目。
 * 不处理双活（seki）与死子：终局前需把死子提干净。
 */
export function scoreChinese(
  board: readonly Cell[],
  size: number,
  komi: number = DEFAULT_KOMI,
): ScoreResult {
  let blackStones = 0;
  let whiteStones = 0;
  for (const cell of board) {
    if (cell === 'black') blackStones++;
    else if (cell === 'white') whiteStones++;
  }

  const visited = new Uint8Array(board.length);
  let blackTerritory = 0;
  let whiteTerritory = 0;

  for (let i = 0; i < board.length; i++) {
    if (board[i] !== null || visited[i] === 1) continue;
    const stack: number[] = [i];
    visited[i] = 1;
    let count = 0;
    let touchesBlack = false;
    let touchesWhite = false;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      count++;
      for (const ni of neighborIndices(size, cur)) {
        const c = board[ni];
        if (c === null) {
          if (visited[ni] === 0) {
            visited[ni] = 1;
            stack.push(ni);
          }
        } else if (c === 'black') touchesBlack = true;
        else touchesWhite = true;
      }
    }
    if (touchesBlack && !touchesWhite) blackTerritory += count;
    else if (touchesWhite && !touchesBlack) whiteTerritory += count;
  }

  const black = blackStones + blackTerritory;
  const white = whiteStones + whiteTerritory + komi;
  let winner: Stone | 'draw';
  if (black > white) winner = 'black';
  else if (white > black) winner = 'white';
  else winner = 'draw';

  return {
    black,
    white,
    komi,
    blackStones,
    whiteStones,
    blackTerritory,
    whiteTerritory,
    winner,
  };
}