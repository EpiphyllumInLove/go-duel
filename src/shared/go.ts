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

/* ------------------------------------------------------------------ */
/* 悔棋（undo）                                                        */
/* ------------------------------------------------------------------ */

/** 一手棋的悔棋所需最小信息（不含恢复局面之外的服务端字段） */
export interface MoveUndo {
  color: Stone;
  /** pass 时为 -1 */
  x: number;
  y: number;
  pass: boolean;
  /** 这一手提掉的对方棋子下标（悔棋时要原样放回） */
  captured: number[];
  /** 这一手的总手数编号，用于同步裁剪展示历史 */
  moveNumber: number;
}

/**
 * 撤销一手：删除刚落下的棋子，并把被提掉的对方棋子放回原位。
 * 返回新棋盘，不修改原棋盘。
 */
export function undoOne(board: readonly Cell[], size: number, entry: MoveUndo): Cell[] {
  const next = board.slice() as Cell[];
  if (!entry.pass) {
    const p = idx(size, entry.x, entry.y);
    if (p >= 0 && p < next.length) next[p] = null;
  }
  for (const raw of entry.captured) {
    if (raw >= 0 && raw < next.length) next[raw] = other(entry.color);
  }
  return next;
}

/**
 * 你能否悔棋：栈顶必须是「你自己刚下的那一手」。
 *
 * 这样悔棋天然是交替的：
 *   局面 [A1, B2, A3]
 *   A 悔 → 退掉 A3，剩 [A1, B2]（轮到 A 重下）
 *   B 悔 → 退掉 B2，剩 [A1]（轮到 B 重下）
 *   A 悔 → 退掉 A1，剩 []（轮到 A 重下，此后谁都不能悔）
 *
 * 不要求「轮到你」才能申请：B 悔 B2 时轮到的是 B 重下，但逻辑上 B 也不是
 * 「当前该落子的人」——所以这里只看栈顶归属，不看 currentTurn。
 */
export function canUndoBy(stack: readonly MoveUndo[], color: Stone): boolean {
  if (stack.length === 0) return false;
  return stack[stack.length - 1].color === color;
}

/** 当前栈里还剩几手可退（上限由 UNDO_STACK_LIMIT 控制） */
export function undoRemaining(stack: readonly MoveUndo[]): number {
  return stack.length;
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