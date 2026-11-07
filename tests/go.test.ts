import { describe, expect, it } from 'vitest';
import {
  createBoard,
  idx,
  isGameOverAfterPass,
  playMove,
  scoreChinese,
} from '../src/shared/go';
import type { Cell, Stone } from '../src/shared/go';

const SIZE = 9;

function build(stones: Array<{ x: number; y: number; c: Stone }>): Cell[] {
  const board = createBoard(SIZE);
  for (const s of stones) board[idx(SIZE, s.x, s.y)] = s.c;
  return board;
}

describe('落子合法性', () => {
  it('空点可以合法落子，且不修改原棋盘', () => {
    const board = createBoard(SIZE);
    const res = playMove(board, SIZE, 'black', 4, 4);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.board[idx(SIZE, 4, 4)]).toBe('black');
    expect(board[idx(SIZE, 4, 4)]).toBe(null); // 不可变
    expect(res.captures).toBe(0);
    expect(res.koPoint).toBe(null);
  });

  it('已有棋子的点不能落子', () => {
    const board = build([{ x: 4, y: 4, c: 'white' }]);
    const res = playMove(board, SIZE, 'black', 4, 4);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('已有棋子');
  });

  it('越界坐标被拒绝', () => {
    const board = createBoard(SIZE);
    expect(playMove(board, SIZE, 'black', -1, 0).ok).toBe(false);
    expect(playMove(board, SIZE, 'black', SIZE, 0).ok).toBe(false);
    expect(playMove(board, SIZE, 'black', 0, 99).ok).toBe(false);
    expect(playMove(board, SIZE, 'black', 1.5, 2).ok).toBe(false);
  });
});

describe('提子', () => {
  it('提掉没有气的对方棋子', () => {
    // 白子 (1,1)，黑在 (0,1)(2,1)(1,0)，黑落 (1,2) 提掉白子
    const board = build([
      { x: 1, y: 1, c: 'white' },
      { x: 0, y: 1, c: 'black' },
      { x: 2, y: 1, c: 'black' },
      { x: 1, y: 0, c: 'black' },
    ]);
    const res = playMove(board, SIZE, 'black', 1, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.captures).toBe(1);
    expect(res.board[idx(SIZE, 1, 1)]).toBe(null);
    expect(res.capturedPoints).toEqual([idx(SIZE, 1, 1)]);
  });

  it('一次提掉多子棋块', () => {
    // 白两子 (1,1)(2,1)，黑围住除 (1,2)(2,2) 以外的所有气，黑落 (1,2) 提两子
    const board = build([
      { x: 1, y: 1, c: 'white' },
      { x: 2, y: 1, c: 'white' },
      { x: 1, y: 0, c: 'black' },
      { x: 2, y: 0, c: 'black' },
      { x: 0, y: 1, c: 'black' },
      { x: 3, y: 1, c: 'black' },
      { x: 2, y: 2, c: 'black' },
      { x: 0, y: 2, c: 'black' },
    ]);
    const res = playMove(board, SIZE, 'black', 1, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.captures).toBe(2);
    expect(res.board[idx(SIZE, 1, 1)]).toBe(null);
    expect(res.board[idx(SIZE, 2, 1)]).toBe(null);
  });
});

describe('禁着', () => {
  it('自杀禁着被拒绝', () => {
    const board = build([
      { x: 1, y: 0, c: 'white' },
      { x: 0, y: 1, c: 'white' },
      { x: 2, y: 1, c: 'white' },
      { x: 1, y: 2, c: 'white' },
    ]);
    const res = playMove(board, SIZE, 'black', 1, 1);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('自杀');
  });

  it('能提对方棋子时不算自杀', () => {
    const board = build([
      { x: 1, y: 1, c: 'white' },
      { x: 0, y: 1, c: 'black' },
      { x: 2, y: 1, c: 'black' },
      { x: 1, y: 0, c: 'black' },
    ]);
    const res = playMove(board, SIZE, 'black', 1, 2);
    expect(res.ok).toBe(true);
  });

  it('提掉三子整块（最后一气被填）', () => {
    // 黑三子横排 (1,1)(2,1)(3,1)，唯一气是 (2,2)
    const board = build([
      { x: 1, y: 1, c: 'black' },
      { x: 2, y: 1, c: 'black' },
      { x: 3, y: 1, c: 'black' },
      { x: 0, y: 1, c: 'white' },
      { x: 4, y: 1, c: 'white' },
      { x: 1, y: 0, c: 'white' },
      { x: 2, y: 0, c: 'white' },
      { x: 3, y: 0, c: 'white' },
      { x: 1, y: 2, c: 'white' },
      { x: 3, y: 2, c: 'white' },
    ]);
    const res = playMove(board, SIZE, 'white', 2, 2);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.captures).toBe(3);
    expect(res.capturedPoints.length).toBe(3);
  });
});

describe('简单劫', () => {
  it('形成劫后禁止立即回提，异地落子后劫解除', () => {
    const board = build([
      { x: 1, y: 0, c: 'black' },
      { x: 0, y: 1, c: 'black' },
      { x: 1, y: 2, c: 'black' },
      { x: 2, y: 0, c: 'white' },
      { x: 1, y: 1, c: 'white' },
      { x: 3, y: 1, c: 'white' },
      { x: 2, y: 2, c: 'white' },
    ]);

    // 黑落 (2,1) 提掉白子 (1,1)，形成劫
    const first = playMove(board, SIZE, 'black', 2, 1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.captures).toBe(1);
    expect(first.koPoint).toBe(idx(SIZE, 1, 1));

    // 白立即回提同一位置 → 必须被拒绝
    const recapture = playMove(first.board, SIZE, 'white', 1, 1, first.koPoint);
    expect(recapture.ok).toBe(false);
    if (recapture.ok) return;
    expect(recapture.error).toContain('劫');

    // 白在别处落一手，劫解除
    const elsewhere = playMove(first.board, SIZE, 'white', 7, 7, first.koPoint);
    expect(elsewhere.ok).toBe(true);
    if (!elsewhere.ok) return;
    expect(elsewhere.koPoint).toBe(null);
  });
});

describe('终局与计分', () => {
  it('连续两次 Pass 判定终局', () => {
    expect(isGameOverAfterPass(0)).toBe(false);
    expect(isGameOverAfterPass(1)).toBe(false);
    expect(isGameOverAfterPass(2)).toBe(true);
  });

  it('中国数子法：只有一枚黑子时其余空点全算黑方', () => {
    const board = build([{ x: 0, y: 0, c: 'black' }]);
    const score = scoreChinese(board, SIZE, 0);
    expect(score.blackStones).toBe(1);
    expect(score.blackTerritory).toBe(SIZE * SIZE - 1);
    expect(score.black).toBe(SIZE * SIZE);
    expect(score.white).toBe(0);
    expect(score.winner).toBe('black');
  });

  it('双方均分盘面时空点不计入任何一方', () => {
    const stones: Array<{ x: number; y: number; c: Stone }> = [];
    for (let x = 0; x < SIZE; x++) {
      stones.push({ x, y: 0, c: 'black' });
      stones.push({ x, y: SIZE - 1, c: 'white' });
    }
    const board = build(stones);
    const score = scoreChinese(board, SIZE, 0);
    // 所有空点同时接触黑白 → 无目
    expect(score.blackTerritory).toBe(0);
    expect(score.whiteTerritory).toBe(0);
    expect(score.black).toBe(SIZE);
    expect(score.white).toBe(SIZE);
    expect(score.winner).toBe('draw');

    const withKomi = scoreChinese(board, SIZE, 7.5);
    expect(withKomi.winner).toBe('white');
  });
});