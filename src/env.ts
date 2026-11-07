export interface Env {
  /** 每个房间一个 Durable Object 实例 */
  GAME_ROOM: DurableObjectNamespace;
  /** 静态资产绑定（public/） */
  ASSETS: Fetcher;
}
