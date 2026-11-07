import type { Env } from './env';
import { isValidRoomCode, normalizeRoomCode } from './shared/types';

export { GameRoom } from './game-room';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket 入口：/ws?room=ABC123
    if (url.pathname === '/ws') {
      const roomCode = normalizeRoomCode(url.searchParams.get('room'));
      if (!isValidRoomCode(roomCode)) {
        return new Response('房间码非法：必须为 6 位大写字母或数字', { status: 400 });
      }
      const id = env.GAME_ROOM.idFromName(roomCode);
      const stub = env.GAME_ROOM.get(id);
      // 把原始请求（含 Upgrade 头）转发给 DO
      return stub.fetch(request);
    }

    // 健康检查
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    // 其余请求交给静态资产（public/）
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;