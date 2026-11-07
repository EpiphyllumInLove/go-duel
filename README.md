# Go Duel · Cloudflare Workers 实时双人围棋

纯 Cloudflare 方案：**Workers + Durable Objects（每房间一个实例）+ Workers Assets（静态前端）+ WebSocket Hibernation API**。
零数据库、零账号、零 Express/Koa、无构建步骤。

打开网页 → 创建房间 → 把链接发给朋友 → 双人实时落子。

---

## 1. 功能一览

| 能力 | 说明 |
| --- | --- |
| 房间 | 6 位房间码（去掉了易混淆的 `0/O/1/I`），链接形如 `https://域名/?room=ABC123` |
| 座位 | 第一个加入者执黑，第二个执白，第三个及以后为观战者 |
| 换先后手 | 未落子前，第一个加入者点「改执白棋 / 改执黑棋」即可交换（`chooseColor`） |
| 实时同步 | WebSocket，服务端权威校验后广播完整状态 |
| 断线重连 | 首次加入服务端下发 `playerToken`，前端存 `localStorage`，刷新/断网自动恢复座位，并顶掉旧连接 |
| 规则 | 落子合法性、自动提子、自杀禁着、简单劫（`koPoint`）、Pass、连续两次 Pass 终局 |
| 计分 | 简化中国规则数子法（盘面棋子 + 单色围空），白方加贴目（默认 7.5） |
| 其它操作 | 认输、双方确认重开（`restart`） |
| 界面 | Canvas 棋盘、最后一步标记、提子数、手数、双方在线状态、观战提示、复制链接 |
| 持久化 | 关键状态写入 DO storage，实例回收后可恢复 |

---

## 2. 快速开始（本地）

```bash
npm install
npx wrangler dev          # 打开 http://localhost:8787
```

验证流程：

1. 浏览器窗口 A 打开 `http://localhost:8787/` → 点「创建房间」→ 复制链接
2. 浏览器窗口 B（普通 + 隐私窗口最省事）打开该链接 → 自动成为白棋，A 为黑棋
3. 交替点击棋盘交叉点落子；面板实时显示轮次、提子数、在线状态
4. 双方各点一次 Pass → 显示终局与比分
5. 刷新任一窗口 → 通过 `localStorage` 的 token 重连并恢复身份

---

## 3. 部署到 Cloudflare

```bash
npx wrangler login         # 首次需要授权
npx wrangler deploy
```

成功后输出类似：

```
https://go-duel.<your-subdomain>.workers.dev
```

把这个地址加上 `?room=XXXXXX` 发给朋友即可对弈。

> **关于 Durable Objects 迁移**
> `wrangler.toml` 中使用的是 `[[migrations]] new_sqlite_classes = ["GameRoom"]`（SQLite 后端 DO，免费计划可用）。
> 若你的账号或 wrangler 版本要求经典 DO，把它改成 `new_classes = ["GameRoom"]` 即可。
> 迁移 tag 一旦部署过就不要再改 tag 名。

---

## 4. 类型检查与测试

```bash
npm run typecheck   # tsc --noEmit，严格模式全通过
npm run test        # vitest，规则引擎用例
```

测试覆盖（`tests/go.test.ts`）：

- 合法落子（含原棋盘不可变）
- 已有棋子 / 越界 / 非整数坐标被拒
- 单子提子、多子整块提子
- 自杀禁着被拒
- 能提对方棋子时不算自杀
- 简单劫：形成 → 立即回提被拒 → 异地落子后解除
- 连续两次 Pass 终局
- 中国数子法计分（含贴目影响胜负）

---

## 5. 文件结构

```
.
├── package.json
├── wrangler.toml          # DO binding + migrations + assets
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts           # Worker 路由：/ws → DO，/health，其余 → Assets
│   ├── env.ts             # Env 类型（GAME_ROOM / ASSETS）
│   ├── game-room.ts       # GameRoom Durable Object：状态机 / 校验 / 持久化 / 广播
│   └── shared/
│       ├── go.ts          # 规则引擎（纯函数，前后端复用）
│       └── types.ts       # 消息协议与状态类型
├── public/
│   ├── index.html         # 单页前端
│   ├── style.css
│   └── app.js             # 原生 JS，无构建
└── tests/
    └── go.test.ts
```

> 仓库根目录的 `index.html` 只是工作区导航页，不参与部署；实际部署的前端是 `public/`。

---

## 6. 切换棋盘大小（19 / 13 / 9）

只改**一处**：

```ts
// src/shared/go.ts
export const DEFAULT_BOARD_SIZE = 19; // ← 改成 9 或 13
export const DEFAULT_KOMI = 7.5;      // ← 9 路常用 5.5~7，13 路常用 7.5
```

前端无需任何改动：

- 棋盘尺寸按 `state.boardSize` 动态计算（`cell = size / (N + 1)`）
- 星位由 `hoshiPoints(N)` 按 9 / 13 / 19 分别返回
- 点击坐标换算同样基于 `boardSize`

> 注意：本项目默认 `19` 路（按需求主段「默认支持 19 路」）。原始需求末尾另写「默认实现 9 路」，两者冲突，这里取 19 路为默认；改成 9 路就是上面那一行。

---

## 7. WebSocket 消息协议

客户端 → 服务端：

```jsonc
{ "type": "join", "roomCode": "ABC123", "playerToken": "可选，重连时必须带" }
{ "type": "move", "x": 3, "y": 15 }
{ "type": "pass" }
{ "type": "resign" }
{ "type": "restart" }                       // 双方各按一次才真正重开
{ "type": "chooseColor", "color": "white" }  // 未落子前交换先后手
{ "type": "ping" }
```

服务端 → 客户端：

```jsonc
{ "type": "joined", "roomCode": "ABC123", "playerToken": "uuid 或 null", "color": "black" }
{ "type": "state", "state": { /* PublicRoomState，字段含 you */ } }
{ "type": "error", "message": "还没轮到你" }
{ "type": "pong" }
```

`PublicRoomState` 字段：

```ts
{
  roomCode, boardSize, board, currentTurn, status,
  players: { black: { joined, connected }, white: { joined, connected } },
  spectatorCount, moveNumber, moveHistory,
  captures: { black, white }, lastMove, passCount, koPoint,
  result, restartRequest, komi,
  you: 'black' | 'white' | null   // 该连接自己的颜色，观战者为 null
}
```

---

## 8. 安全与健壮性

- **token 不外泄**：`PublicRoomState` 完全不含 `playerToken`；token 只在 `joined` 中单独返回给本人。
- **消息上限**：单条消息 2KB（`MAX_MESSAGE_BYTES`），`playerToken` 最长 64 字符。
- **严格校验**：`type` 必须是已知字符串；`x/y` 必须是整数且在棋盘内；`roomCode` 必须匹配 `^[A-Z0-9]{6}$`。
- **权威裁决**：非当前玩家、观战者、对局已结束、未开局的一切落子/PASS/认输请求都被拒绝，且不修改棋盘。
- **无 secret**：项目不需要任何环境变量或密钥。
- **在线状态不可伪造**：`connected` 每次广播都用 `ctx.getWebSockets()` 实时推算，不信任持久化值。
- **重复连接**：同 token 新连接会关闭旧连接（`close(4000, 'replaced by new connection')`），避免双开互相抢手。

---

## 9. WebSocket Hibernation 实现要点

用的是 **Hibernation API**（不是 `addEventListener`），实例休眠唤醒后仍能读取连接上挂的身份：

```ts
// DO.fetch 中接受连接
this.ctx.acceptWebSocket(server);
server.serializeAttachment({ token: null, color: null } satisfies SocketAttachment);

// 运行时直接调度这三个回调，不要自己 addEventListener
async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) { /* 校验 + 改状态 + 广播 */ }
async webSocketClose(ws, code, reason, wasClean) { this.broadcast(); }
async webSocketError(ws, err) { this.broadcast(); }
```

身份恢复链路：

1. 连接建立 → attachment 为 `{token:null,color:null}`，此时身份未知（观战视角）
2. 客户端在 `onopen` 里发 `join`（带 localStorage 里的 token）
3. 服务端匹配 token → 恢复座位；匹配不到但有空座 → 分配新座位 + 32 位随机 hex token（`crypto.getRandomValues`）
4. `ws.serializeAttachment({token, color})` 写回连接
5. 之后每条消息都用 `deserializeAttachment()` 判断身份，**不信任客户端自报的颜色**

状态持久化：单 key `room:v1`，构造时 `ctx.blockConcurrencyWhile()` 先加载，避免第一条消息读到空状态。

---

## 10. 规则实现说明

`src/shared/go.ts` 全部是纯函数，棋盘为一维数组 `index = y * size + x`：

- `getGroup()`：BFS 求棋块与气数
- `playMove()`：校验 → 落子 → 提对方无气棋块 → 提完再判自身是否有气（无气即自杀）→ 返回 `koPoint`
- 劫：仅在「单子提单子且自身只剩一口气」时设置 `koPoint`，下一手若落该点直接拒绝；任何一手 `pass` 或异地落子都会清空 `koPoint`
- `isGameOverAfterPass(passCount >= 2)`
- `scoreChinese()`：盘面棋子 + 只接触单一颜色的空点（territory），白方加 `komi`

**已知取舍（README 明示）**

- 只做**简单劫**，不检测三劫循环 / 长生（会造成长对局需要裁判介入）
- 不自动判死子、不处理双活（seki）：终局前请把死子提干净，否则比分会有偏差
- 不做打谱、悔棋、计时、AI 托管
- 计分为「数子法」而非「数目法」，与日本规则结果可能不同

---

## 11. 常见问题

**Q: 本地启动后 WebSocket 连不上？**
确认访问的是 `http://localhost:8787` 而不是直接打开 `public/index.html` 文件（`file://` 无法连接 `/ws`）。

**Q: 部署后页面 404？**
确认 `wrangler.toml` 里 `[assets] directory = "./public"` 指向正确，且 `public/index.html` 存在。

**Q: 两个人都想执黑？**
未落子前点「改执黑棋」会与对方交换座位；一旦落子就不能再换，需要重开新房间。

**Q: 房间会过期吗？**
没有主动清理逻辑。DO 实例回收后状态仍在 storage 中，重新访问同一 roomCode 会恢复。若需长期归档清理，可在 DO 里加 `alarm()` 定期删除 `room:v1`。
