# 协议（MVP）

## Web ⇄ Control Plane（REST）

### 认证
- `POST /auth/register`：`{ email, password }`
- `POST /auth/login`：`{ email, password }` → `{ token }`（JWT）

### 设备绑定
- Agent 启动后生成 `pairingCode` 并通过 WS 连接到 `/ws/agent?pairingCode=...`
- 用户在 Web 输入 `pairingCode` 调用：
  - `POST /devices/claim`：`{ pairingCode, deviceName }` → `{ deviceId }`

### 设备与命令
- `GET /devices`：列出当前用户设备
- `POST /devices/:deviceId/commands`：`{ text }` → `{ commandId }`
- `GET /commands/:commandId`：查询状态/日志/最新截图

## Control Plane ⇄ Agent（WebSocket）

### Agent 连接阶段
1. **未绑定**：`/ws/agent?pairingCode=...`
   - 服务端推送：`{ type:"paired", deviceToken, deviceId }`
2. **已绑定**：Agent 以后用 `deviceToken` 连接：`/ws/agent?deviceToken=...`

### 命令下发
- 服务端 → Agent：`{ type:"command", command: CommandSpec }`

### 执行回传
- Agent → 服务端：`{ type:"event", commandId, level, message, atMs }`
- Agent → 服务端：`{ type:"result", commandId, status, finishedAtMs }`
- Agent → 服务端：`{ type:"screenshot", commandId, pngBase64, atMs }`

