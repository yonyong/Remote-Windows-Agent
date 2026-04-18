import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { openDb } from './db.js';
import { hashPassword, verifyPassword } from './auth.js';
import { parseTextToCommandSpec } from './commandResolver.js';
import { stripImplicitScreenshotSteps } from './commandSpecPolicy.js';
import { parseWithRules } from './commandParser.js';
import { getParseSettingsForApi, resolveEffectiveLlmConfig, resolveEffectiveLlmConfigForPing } from './parseSettings.js';
import { agentCasualChatWithLlmProvider, pingLlmProvider } from './llm/dispatch.js';
import { buildAgentSystemPrompt, buildCustomAgentSystemPrompt, getBuiltinAgentById, listAgentsPublic } from './agentCatalog.js';
import { appendExecutionResultToInterpretation, assertDeviceOwned, buildChatHistoryForLlm, insertDeviceChatMessage, listDeviceChatMessages, DEVICE_CHAT_PAGE_MAX } from './chatMessages.js';
const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? 'control-plane.sqlite';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
const db = openDb(DB_PATH);
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(jwt, { secret: JWT_SECRET });
await app.register(websocket);
async function requireAuthUser(request, reply) {
    try {
        await request.jwtVerify();
    }
    catch {
        return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = request.user.sub;
    const row = db.prepare('select id from users where id = ?').get(userId);
    if (!row) {
        return reply.code(401).send({
            error: 'session_stale',
            hint: 'This token user id no longer exists in the database (common after deleting control-plane.sqlite). Log out in the web UI and register/login again.'
        });
    }
}
const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });
/** 登录：完整邮箱，或仅 @ 前的本地部分（不区分大小写，与库中邮箱匹配） */
const loginSchema = z.object({
    email: z.string().min(1).max(128),
    password: z.string().min(8).max(128)
});
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
app.post('/auth/register', async (req, reply) => {
    const body = registerSchema.parse(req.body);
    const email = normalizeEmail(body.email);
    const existing = db.prepare('select id from users where lower(trim(email)) = ?').get(email);
    if (existing)
        return reply.code(409).send({ error: 'email_taken' });
    const userId = `usr_${nanoid(16)}`;
    db.prepare('insert into users (id, email, password_hash, created_at_ms) values (?, ?, ?, ?)')
        .run(userId, email, hashPassword(body.password), Date.now());
    return reply.send({ ok: true });
});
app.post('/auth/login', async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const raw = body.email.trim();
    const hint = '账号或密码不匹配。若电脑能登录而手机不能，多半是手机连到了另一台控制面（空库）：请在登录页的「控制面 API」填写与电脑相同的地址（例如 http://电脑IP:8787）。';
    let user;
    if (raw.includes('@')) {
        const email = normalizeEmail(raw);
        user = db.prepare('select id, email, password_hash from users where lower(trim(email)) = ?').get(email);
        if (!user || !verifyPassword(body.password, user.password_hash)) {
            return reply.code(401).send({ error: 'invalid_credentials', hint });
        }
    }
    else {
        const local = normalizeEmail(raw);
        if (!/^[a-z0-9._+-]+$/i.test(local)) {
            return reply.code(400).send({
                error: 'invalid_login_id',
                hint: '登录请使用完整邮箱（含 @），或仅使用 @ 前的邮箱前缀（字母、数字、._+-）。'
            });
        }
        const rows = db
            .prepare(`select id, email, password_hash from users
         where instr(lower(trim(email)), '@') > 0
           and lower(substr(lower(trim(email)), 1, instr(lower(trim(email)), '@') - 1)) = ?`)
            .all(local);
        const matches = rows.filter((r) => verifyPassword(body.password, r.password_hash));
        if (matches.length === 1) {
            user = matches[0];
        }
        else if (matches.length > 1) {
            return reply.code(409).send({
                error: 'ambiguous_login_prefix',
                hint: '该邮箱前缀对应多个账号，请改用完整邮箱（含 @ 域名）登录，例如 admin@qq.com。'
            });
        }
        else {
            return reply.code(401).send({ error: 'invalid_credentials', hint });
        }
    }
    const token = app.jwt.sign({ sub: user.id, email: user.email }, { expiresIn: '12h' });
    return reply.send({ token });
});
const changePasswordSchema = z.object({
    currentPassword: z.string().min(8).max(128),
    newPassword: z.string().min(8).max(128)
});
app.post('/auth/change-password', { preHandler: requireAuthUser }, async (req, reply) => {
    const body = changePasswordSchema.parse(req.body);
    const userId = getUserId(req);
    const user = db
        .prepare('select id, password_hash from users where id = ?')
        .get(userId);
    if (!user)
        return reply.code(401).send({ error: 'user_missing' });
    if (!verifyPassword(body.currentPassword, user.password_hash)) {
        return reply.code(400).send({ error: 'invalid_current_password', hint: '当前密码不正确。' });
    }
    if (body.currentPassword === body.newPassword) {
        return reply.code(400).send({ error: 'password_unchanged', hint: '新密码不能与当前密码相同。' });
    }
    db.prepare('update users set password_hash = ? where id = ?').run(hashPassword(body.newPassword), userId);
    return reply.send({ ok: true });
});
function getUserId(req) {
    const payload = req.user;
    return payload.sub;
}
function persistCommandLlmUsage(commandId, usage) {
    if (usage == null)
        return;
    db.prepare('update commands set llm_parse_json = ? where id = ?').run(JSON.stringify(usage), commandId);
}
const agentsByDeviceId = new Map();
const agentsByPairingCode = new Map();
function sendJson(ws, obj) {
    ws.send(JSON.stringify(obj));
}
// Agent WS:
// - /ws/agent?pairingCode=xxxx  (未绑定)
// - /ws/agent?deviceToken=tok   (已绑定)
app.get('/ws/agent', { websocket: true }, (conn, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pairingCode = url.searchParams.get('pairingCode') ?? undefined;
    const deviceToken = url.searchParams.get('deviceToken') ?? undefined;
    const socketId = `ws_${nanoid(8)}`;
    // @fastify/websocket 在不同版本里可能把 WebSocket 直接作为第一个参数传入，
    // 也可能包装成 { socket }. 这里做兼容。
    const ws = conn.socket ?? conn;
    const agentConn = {
        socketId,
        pairingCode,
        deviceToken,
        send: (msg) => sendJson(ws, msg),
        closeSocket: () => {
            try {
                ws.close();
            }
            catch {
                /* noop */
            }
        }
    };
    if (pairingCode) {
        agentsByPairingCode.set(pairingCode, agentConn);
        db.prepare('insert or ignore into pairings (pairing_code, agent_socket_id, created_at_ms) values (?, ?, ?)')
            .run(pairingCode, socketId, Date.now());
        app.log.info({ pairingCode }, 'agent_connected_pending_pairing');
    }
    else if (deviceToken) {
        const device = db.prepare('select id, revoked_at_ms from devices where device_token = ?').get(deviceToken);
        if (!device || device.revoked_at_ms) {
            sendJson(ws, { type: 'error', error: 'invalid_device_token' });
            ws.close();
            return;
        }
        agentConn.deviceId = device.id;
        agentConn.deviceToken = deviceToken;
        agentsByDeviceId.set(device.id, agentConn);
        app.log.info({ deviceId: device.id }, 'agent_connected_authenticated');
    }
    else {
        sendJson(ws, { type: 'error', error: 'missing_pairingCode_or_deviceToken' });
        ws.close();
        return;
    }
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            const commandExists = (commandId) => Boolean(db.prepare('select 1 as ok from commands where id = ?').get(commandId));
            if (msg.type === 'event') {
                if (!commandExists(msg.commandId)) {
                    app.log.warn({ commandId: msg.commandId }, 'skip_event_unknown_command');
                    return;
                }
                db.prepare('insert into command_events (id, command_id, at_ms, level, message) values (?, ?, ?, ?, ?)')
                    .run(`evt_${nanoid(16)}`, msg.commandId, msg.atMs, msg.level, msg.message);
            }
            else if (msg.type === 'screenshot') {
                if (!commandExists(msg.commandId)) {
                    app.log.warn({ commandId: msg.commandId }, 'skip_screenshot_unknown_command');
                    return;
                }
                db.prepare('update commands set last_screenshot_base64 = ? where id = ?').run(msg.pngBase64, msg.commandId);
                const shotCmd = db
                    .prepare('select user_id, device_id from commands where id = ?')
                    .get(msg.commandId);
                if (shotCmd && msg.pngBase64) {
                    const dup = db
                        .prepare(`select 1 as ok from device_chat_messages where command_id = ? and kind = 'screenshot' and attachment_base64 = ? limit 1`)
                        .get(msg.commandId, msg.pngBase64);
                    if (dup) {
                        app.log.info({ commandId: msg.commandId }, 'skip_duplicate_screenshot_chat');
                    }
                    else {
                        insertDeviceChatMessage(db, {
                            userId: shotCmd.user_id,
                            deviceId: shotCmd.device_id,
                            role: 'assistant',
                            content: '运行截图',
                            commandId: msg.commandId,
                            kind: 'screenshot',
                            attachmentBase64: msg.pngBase64
                        });
                    }
                }
            }
            else if (msg.type === 'result') {
                if (!commandExists(msg.commandId)) {
                    app.log.warn({ commandId: msg.commandId }, 'skip_result_unknown_command');
                    return;
                }
                db.prepare('update commands set status = ?, finished_at_ms = ?, last_error = ? where id = ?')
                    .run(msg.status, msg.finishedAtMs, msg.error ?? null, msg.commandId);
                const cmdRow = db
                    .prepare('select user_id, device_id from commands where id = ?')
                    .get(msg.commandId);
                if (cmdRow) {
                    const err = msg.error != null ? String(msg.error).trim().slice(0, 600) : '';
                    const suffix = msg.status === 'succeeded'
                        ? '执行结果：成功。'
                        : msg.status === 'failed'
                            ? err
                                ? `执行结果：失败。原因：${err}`
                                : '执行结果：失败。'
                            : `执行结果：状态「${msg.status}」。`;
                    const ok = appendExecutionResultToInterpretation(db, {
                        userId: cmdRow.user_id,
                        deviceId: cmdRow.device_id,
                        commandId: msg.commandId,
                        suffix
                    });
                    if (!ok) {
                        insertDeviceChatMessage(db, {
                            userId: cmdRow.user_id,
                            deviceId: cmdRow.device_id,
                            role: 'assistant',
                            content: suffix,
                            commandId: msg.commandId,
                            kind: 'result'
                        });
                    }
                }
            }
        }
        catch (e) {
            app.log.warn({ err: e }, 'bad_agent_message');
        }
    });
    ws.on('close', () => {
        if (pairingCode)
            agentsByPairingCode.delete(pairingCode);
        if (agentConn.deviceId)
            agentsByDeviceId.delete(agentConn.deviceId);
    });
});
// --- 设备 API（需要登录） ---
app.get('/devices', { preHandler: requireAuthUser }, async (req) => {
    const userId = getUserId(req);
    const rows = db
        .prepare('select id, name, created_at_ms, revoked_at_ms from devices where owner_user_id = ? order by created_at_ms desc')
        .all(userId);
    const withOnline = rows.map((d) => ({ ...d, online: agentsByDeviceId.has(d.id) }));
    return { devices: withOnline };
});
app.post('/devices/claim', { preHandler: requireAuthUser }, async (req, reply) => {
    const body = z.object({ pairingCode: z.string().min(4).max(32), deviceName: z.string().min(1).max(64) }).parse(req.body);
    const userId = getUserId(req);
    const pairing = db.prepare('select pairing_code, claimed_at_ms from pairings where pairing_code = ?').get(body.pairingCode);
    if (!pairing)
        return reply.code(404).send({ error: 'pairing_not_found' });
    if (pairing.claimed_at_ms) {
        return reply.code(409).send({
            error: 'pairing_already_claimed',
            hint: 'This pairing code was already claimed on this control-plane (pairings are single-use). Do not reuse an old PAIR_ code from docs/screenshots. Fix: (1) Stop Agent, delete agent/agent-state.json, restart Agent to get a NEW code in agent/pairing-code.txt. (2) If you still see the same old code, reset the server dev DB by running scripts/reset-control-plane-db.bat then restart control-plane.'
        });
    }
    const deviceId = `dev_${nanoid(16)}`;
    const deviceToken = `dtok_${nanoid(32)}`;
    db.prepare('insert into devices (id, owner_user_id, name, device_token, created_at_ms) values (?, ?, ?, ?, ?)')
        .run(deviceId, userId, body.deviceName, deviceToken, Date.now());
    db.prepare('update pairings set claimed_by_user_id = ?, claimed_device_id = ?, claimed_at_ms = ? where pairing_code = ?')
        .run(userId, deviceId, Date.now(), body.pairingCode);
    const agent = agentsByPairingCode.get(body.pairingCode);
    if (agent) {
        agent.deviceId = deviceId;
        agent.deviceToken = deviceToken;
        agentsByDeviceId.set(deviceId, agent);
        agent.send({ type: 'paired', deviceToken, deviceId });
    }
    return { deviceId };
});
const parseSettingsPutSchema = z.object({
    parseMode: z.enum(['rule', 'llm', 'hybrid']),
    llmProvider: z.enum(['zhipu', 'openai_compatible', 'gemini']),
    llmModel: z.string().min(1).max(128),
    llmBaseUrl: z.union([z.string().max(512), z.null()]).optional(),
    /** 非空则写入新密钥；不传或空字符串表示保留原密钥（除非 clearApiKey） */
    apiKey: z.string().max(4096).optional(),
    clearApiKey: z.boolean().optional()
});
app.get('/me/parse-settings', { preHandler: requireAuthUser }, async (req) => {
    const userId = getUserId(req);
    return getParseSettingsForApi(db, userId);
});
const parseSettingsTestBodySchema = z.object({
    apiKey: z.string().max(4096).optional(),
    llmProvider: z.enum(['zhipu', 'openai_compatible', 'gemini']).optional(),
    llmModel: z.string().max(128).optional(),
    llmBaseUrl: z.union([z.string().max(512), z.null()]).optional()
});
app.put('/me/parse-settings', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const body = parseSettingsPutSchema.parse(req.body ?? {});
    const prev = db.prepare('select llm_api_key from user_parse_settings where user_id = ?').get(userId);
    let nextKey = prev?.llm_api_key ?? null;
    if (body.clearApiKey)
        nextKey = null;
    else if (body.apiKey !== undefined && body.apiKey.trim().length > 0) {
        nextKey = body.apiKey.trim();
    }
    const baseRaw = body.llmBaseUrl === undefined ? null : body.llmBaseUrl;
    const baseStored = typeof baseRaw === 'string' && baseRaw.trim().length > 0 ? baseRaw.trim() : null;
    const now = Date.now();
    db.prepare(`insert into user_parse_settings (user_id, parse_mode, llm_provider, llm_api_key, llm_base_url, llm_model, updated_at_ms)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(user_id) do update set
       parse_mode = excluded.parse_mode,
       llm_provider = excluded.llm_provider,
       llm_api_key = excluded.llm_api_key,
       llm_base_url = excluded.llm_base_url,
       llm_model = excluded.llm_model,
       updated_at_ms = excluded.updated_at_ms`).run(userId, body.parseMode, body.llmProvider, nextKey, baseStored, body.llmModel.trim(), now);
    return { ok: true };
});
app.post('/me/parse-settings/test', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const raw = parseSettingsTestBodySchema.parse(req.body && typeof req.body === 'object' ? req.body : {});
    const eff = resolveEffectiveLlmConfigForPing(db, userId, raw);
    if (!eff.apiKey?.trim()) {
        return reply.code(400).send({
            error: 'no_api_key',
            hint: '没有可用的 API Key：请先在「API Key」输入框填写并点击「保存解析设置」，或直接在测试请求里带上未保存的 Key。也可在服务器环境变量中配置对应厂商的密钥。'
        });
    }
    try {
        await pingLlmProvider({
            provider: eff.provider,
            apiKey: eff.apiKey,
            model: eff.model,
            baseUrl: eff.baseUrl
        });
        return { ok: true };
    }
    catch (e) {
        const msg = e?.message ? String(e.message) : String(e);
        return reply.code(502).send({ error: 'llm_ping_failed', message: msg.slice(0, 400) });
    }
});
app.get('/agent-chats', { preHandler: requireAuthUser }, async () => {
    return { agents: listAgentsPublic() };
});
const agentCompleteBodySchema = z.object({
    text: z.string().min(1).max(2000),
    history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
        .max(32)
        .optional(),
    personaAddon: z.string().max(2000).optional()
});
app.post('/agent-chats/:agentId/complete', { preHandler: requireAuthUser }, async (req, reply) => {
    const agentId = req.params.agentId;
    const agent = getBuiltinAgentById(agentId);
    if (!agent)
        return reply.code(404).send({ error: 'agent_not_found' });
    const body = agentCompleteBodySchema.parse(req.body ?? {});
    const userId = getUserId(req);
    const llm = resolveEffectiveLlmConfig(db, userId);
    const key = llm.apiKey?.trim();
    if (!key) {
        return reply.code(400).send({
            error: 'llm_not_configured',
            hint: '请先在「我」中配置大模型 API Key，或由管理员在控制面环境变量中配置。'
        });
    }
    const hist = (body.history ?? []).map((h) => ({ role: h.role, content: h.content }));
    const systemPrompt = buildAgentSystemPrompt(agent, body.personaAddon);
    try {
        const { reply: replyText, llmUsage } = await agentCasualChatWithLlmProvider({
            provider: llm.provider,
            userText: body.text,
            apiKey: key,
            model: llm.model,
            baseUrl: llm.baseUrl,
            systemPrompt,
            chatHistory: hist
        });
        return { reply: replyText, llmParse: llmUsage ?? null };
    }
    catch (e) {
        req.log.warn({ err: String(e?.message ?? e), agentId }, 'agent_chat_failed');
        return reply.code(502).send({ error: 'agent_chat_failed', message: String(e?.message ?? e).slice(0, 400) });
    }
});
const agentCustomCompleteBodySchema = z.object({
    displayName: z.string().trim().min(1).max(32),
    text: z.string().min(1).max(2000),
    history: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
        .max(32)
        .optional(),
    personaAddon: z.string().max(2000).optional()
});
app.post('/agent-chats/custom/complete', { preHandler: requireAuthUser }, async (req, reply) => {
    const body = agentCustomCompleteBodySchema.parse(req.body ?? {});
    const userId = getUserId(req);
    const llm = resolveEffectiveLlmConfig(db, userId);
    const key = llm.apiKey?.trim();
    if (!key) {
        return reply.code(400).send({
            error: 'llm_not_configured',
            hint: '请先在「我」中配置大模型 API Key，或由管理员在控制面环境变量中配置。'
        });
    }
    const hist = (body.history ?? []).map((h) => ({ role: h.role, content: h.content }));
    const systemPrompt = buildCustomAgentSystemPrompt(body.displayName, body.personaAddon);
    try {
        const { reply: replyText, llmUsage } = await agentCasualChatWithLlmProvider({
            provider: llm.provider,
            userText: body.text,
            apiKey: key,
            model: llm.model,
            baseUrl: llm.baseUrl,
            systemPrompt,
            chatHistory: hist
        });
        return { reply: replyText, llmParse: llmUsage ?? null };
    }
    catch (e) {
        req.log.warn({ err: String(e?.message ?? e) }, 'agent_custom_chat_failed');
        return reply.code(502).send({ error: 'agent_chat_failed', message: String(e?.message ?? e).slice(0, 400) });
    }
});
app.get('/devices/:deviceId/chat', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const deviceId = req.params.deviceId;
    const raw = (req.query ?? {});
    const limRaw = raw.limit;
    const limStr = Array.isArray(limRaw) ? limRaw[0] : limRaw;
    let limit = Math.min(300, DEVICE_CHAT_PAGE_MAX);
    if (typeof limStr === 'string' && limStr.trim()) {
        const n = Number.parseInt(limStr, 10);
        if (Number.isFinite(n))
            limit = Math.min(DEVICE_CHAT_PAGE_MAX, Math.max(1, n));
    }
    if (!assertDeviceOwned(db, deviceId, userId))
        return reply.code(404).send({ error: 'device_not_found' });
    const messages = listDeviceChatMessages(db, userId, deviceId, limit);
    return { messages };
});
app.post('/devices/:deviceId/revoke', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const deviceId = req.params.deviceId;
    const device = db.prepare('select id from devices where id = ? and owner_user_id = ?').get(deviceId, userId);
    if (!device)
        return reply.code(404).send({ error: 'device_not_found' });
    db.prepare('update devices set revoked_at_ms = ? where id = ?').run(Date.now(), deviceId);
    const agent = agentsByDeviceId.get(deviceId);
    if (agent) {
        try {
            agent.closeSocket();
        }
        catch {
            /* noop */
        }
    }
    return { ok: true };
});
// --- 命令 API ---
app.post('/devices/:deviceId/commands', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const deviceId = req.params.deviceId;
    const body = z.object({ text: z.string().min(1).max(2000) }).parse(req.body);
    const device = db.prepare('select id from devices where id = ? and owner_user_id = ? and revoked_at_ms is null').get(deviceId, userId);
    if (!device)
        return reply.code(404).send({ error: 'device_not_found' });
    const nowMs = Date.now();
    const commandId = `cmd_${nanoid(16)}`;
    const llm = resolveEffectiveLlmConfig(db, userId);
    const chatHistory = buildChatHistoryForLlm(db, userId, deviceId);
    const bundleRaw = await parseTextToCommandSpec({
        deviceId,
        text: body.text,
        nowMs,
        commandId,
        log: app.log,
        llm,
        chatHistory
    });
    const bundle = bundleRaw.kind === 'execute'
        ? { ...bundleRaw, spec: stripImplicitScreenshotSteps(bundleRaw.spec, body.text) }
        : bundleRaw;
    insertDeviceChatMessage(db, {
        userId,
        deviceId,
        role: 'user',
        content: body.text,
        commandId: bundle.kind === 'execute' ? commandId : null,
        kind: 'message'
    });
    if (bundle.kind === 'chat') {
        insertDeviceChatMessage(db, {
            userId,
            deviceId,
            role: 'assistant',
            content: bundle.interpretation,
            commandId: null,
            kind: 'conversation'
        });
        return reply.send({ conversationOnly: true, reply: bundle.interpretation, llmParse: bundle.llmUsage ?? null });
    }
    const { spec, interpretation, llmUsage, llmParseRawOutput } = bundle;
    insertDeviceChatMessage(db, {
        userId,
        deviceId,
        role: 'assistant',
        content: interpretation,
        commandId,
        kind: 'interpretation',
        llmParseRaw: llmParseRawOutput ?? null
    });
    const needsApproval = spec.risk_level === 'high';
    const initialStatus = needsApproval ? 'needs_approval' : 'queued';
    db.prepare('insert into commands (id, device_id, user_id, input_text, status, created_at_ms) values (?, ?, ?, ?, ?, ?)')
        .run(commandId, deviceId, userId, body.text, initialStatus, nowMs);
    persistCommandLlmUsage(commandId, llmUsage);
    if (needsApproval) {
        return reply.send({ commandId, requiresApproval: true, interpretation, llmParse: llmUsage ?? null });
    }
    const agent = agentsByDeviceId.get(deviceId);
    if (!agent) {
        db.prepare('update commands set status = ?, last_error = ? where id = ?').run('failed', 'device_offline', commandId);
        insertDeviceChatMessage(db, {
            userId,
            deviceId,
            role: 'assistant',
            content: '设备当前离线，未能下发到 Agent。',
            commandId,
            kind: 'notice'
        });
        return reply.code(409).send({ error: 'device_offline', commandId, interpretation, llmParse: llmUsage ?? null });
    }
    db.prepare('update commands set status = ?, started_at_ms = ? where id = ?').run('running', nowMs, commandId);
    agent.send({ type: 'command', command: spec });
    return { commandId, interpretation, llmParse: llmUsage ?? null };
});
app.post('/commands/:commandId/approve', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const commandId = req.params.commandId;
    const cmd = db.prepare('select * from commands where id = ? and user_id = ?').get(commandId, userId);
    if (!cmd)
        return reply.code(404).send({ error: 'command_not_found' });
    if (cmd.status !== 'needs_approval')
        return reply.code(409).send({ error: 'not_approvable', status: cmd.status });
    const nowMs = Date.now();
    db.prepare('update commands set approved_at_ms = ?, approved_by_user_id = ?, status = ? where id = ?')
        .run(nowMs, userId, 'queued', commandId);
    const agent = agentsByDeviceId.get(cmd.device_id);
    if (!agent) {
        db.prepare('update commands set status = ?, last_error = ? where id = ?').run('failed', 'device_offline', commandId);
        insertDeviceChatMessage(db, {
            userId,
            deviceId: cmd.device_id,
            role: 'assistant',
            content: '已批准，但设备当前离线，未能下发。',
            commandId,
            kind: 'notice'
        });
        return reply.code(409).send({ error: 'device_offline', commandId });
    }
    // 重新解析一次（MVP：解析是确定性的）
    const llm = resolveEffectiveLlmConfig(db, userId);
    const chatHistory = buildChatHistoryForLlm(db, userId, cmd.device_id);
    let execBundleRaw = await parseTextToCommandSpec({
        deviceId: cmd.device_id,
        text: cmd.input_text,
        nowMs: cmd.created_at_ms,
        commandId,
        log: app.log,
        llm,
        chatHistory
    });
    let execBundle = execBundleRaw.kind === 'execute'
        ? { ...execBundleRaw, spec: stripImplicitScreenshotSteps(execBundleRaw.spec, cmd.input_text) }
        : execBundleRaw;
    if (execBundle.kind === 'chat') {
        const r = parseWithRules({
            deviceId: cmd.device_id,
            text: cmd.input_text,
            nowMs: cmd.created_at_ms,
            commandId
        });
        execBundle = {
            kind: 'execute',
            commandId,
            spec: stripImplicitScreenshotSteps(r.spec, cmd.input_text),
            interpretation: r.interpretation
        };
    }
    const { spec, interpretation, llmUsage } = execBundle;
    persistCommandLlmUsage(commandId, llmUsage);
    insertDeviceChatMessage(db, {
        userId,
        deviceId: cmd.device_id,
        role: 'assistant',
        content: '已批准执行，指令已下发到设备。',
        commandId,
        kind: 'notice'
    });
    db.prepare('update commands set status = ?, started_at_ms = ? where id = ?').run('running', nowMs, commandId);
    agent.send({ type: 'command', command: spec });
    return { ok: true, interpretation, llmParse: llmUsage ?? null };
});
app.get('/commands/:commandId', { preHandler: requireAuthUser }, async (req, reply) => {
    const userId = getUserId(req);
    const commandId = req.params.commandId;
    const cmd = db.prepare('select * from commands where id = ? and user_id = ?').get(commandId, userId);
    if (!cmd)
        return reply.code(404).send({ error: 'command_not_found' });
    const events = db.prepare('select at_ms, level, message from command_events where command_id = ? order by at_ms asc')
        .all(commandId);
    return { command: cmd, events };
});
app.get('/health', async () => ({ ok: true }));
await app.listen({ port: PORT, host: HOST });
app.log.info({ port: PORT }, 'control_plane_started');
