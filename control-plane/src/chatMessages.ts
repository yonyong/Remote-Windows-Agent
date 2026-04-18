import { nanoid } from 'nanoid';
import type { Db } from './db.js';

export type ChatRole = 'user' | 'assistant';

export type DeviceChatRow = {
  id: string;
  user_id: string;
  device_id: string;
  role: string;
  content: string;
  command_id: string | null;
  kind: string;
  created_at_ms: number;
  attachment_base64: string | null;
  llm_parse_raw: string | null;
};

/** 供 OpenAI 兼容接口的 messages（assistant 角色名与 OpenAI 一致） */
export type ChatTurnForLlm = { role: 'user' | 'assistant'; content: string };

const MAX_LLM_TURNS = 20;
const MAX_CONTENT_CHARS = 1200;

export function assertDeviceOwned(db: Db, deviceId: string, userId: string): boolean {
  const row = db.prepare('select 1 as ok from devices where id = ? and owner_user_id = ? and revoked_at_ms is null').get(deviceId, userId) as
    | { ok: number }
    | undefined;
  return Boolean(row);
}

export function insertDeviceChatMessage(
  db: Db,
  args: {
    userId: string;
    deviceId: string;
    role: ChatRole;
    content: string;
    commandId?: string | null;
    kind?: string;
    /** PNG 等纯 base64（不含 data: 前缀）；与 kind=screenshot 等配合 */
    attachmentBase64?: string | null;
    /** 指令解析失败时：大模型原始输出或上游错误体，供前端「感叹号」展示 */
    llmParseRaw?: string | null;
  }
): string {
  const id = `cht_${nanoid(14)}`;
  const kind = args.kind ?? 'message';
  const cmd = args.commandId ?? null;
  const text = args.content.slice(0, 8000);
  const att = args.attachmentBase64 != null && args.attachmentBase64.length > 0 ? args.attachmentBase64.slice(0, 12_000_000) : null;
  const raw =
    args.llmParseRaw != null && args.llmParseRaw.length > 0 ? clipLlmParseRawForDb(args.llmParseRaw) : null;
  db.prepare(
    `insert into device_chat_messages (id, user_id, device_id, role, content, command_id, kind, created_at_ms, attachment_base64, llm_parse_raw)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, args.userId, args.deviceId, args.role, text, cmd, kind, Date.now(), att, raw);
  return id;
}

const LLM_PARSE_RAW_DB_MAX = 80_000;

function clipLlmParseRawForDb(s: string): string {
  const t = s.slice(0, LLM_PARSE_RAW_DB_MAX);
  return s.length > LLM_PARSE_RAW_DB_MAX ? `${t}\n…[truncated ${s.length} chars]` : t;
}

/**
 * 将执行结果追加到本命令最新的「解析」气泡末尾（与「风险 low · GLM」等同一条），避免单独一条结果消息插在中间。
 * 若无对应 interpretation 行则返回 false，由调用方决定是否插入独立消息。
 */
export function appendExecutionResultToInterpretation(
  db: Db,
  args: { userId: string; deviceId: string; commandId: string; suffix: string }
): boolean {
  const row = db
    .prepare(
      `select id, content from device_chat_messages
       where command_id = ? and user_id = ? and device_id = ? and kind = 'interpretation'
       order by created_at_ms desc, id desc
       limit 1`
    )
    .get(args.commandId, args.userId, args.deviceId) as { id: string; content: string } | undefined;
  if (!row) return false;
  const suffix = args.suffix.trim();
  if (!suffix) return true;
  const next = `${row.content}\n\n${suffix}`.slice(0, 8000);
  db.prepare(`update device_chat_messages set content = ? where id = ?`).run(next, row.id);
  return true;
}

/** 单页最大条数（再大可能影响首屏与 base64 体积） */
export const DEVICE_CHAT_PAGE_MAX = 500;

/**
 * 拉取**最近** limit 条（时间升序），避免 `asc + limit` 只拿到最早一批导致新消息与闲聊回复不显示。
 */
export function listDeviceChatMessages(db: Db, userId: string, deviceId: string, limit = 100): DeviceChatRow[] {
  if (!assertDeviceOwned(db, deviceId, userId)) return [];
  const lim = Math.min(DEVICE_CHAT_PAGE_MAX, Math.max(1, limit));
  const rows = db
    .prepare(
      `select id, user_id, device_id, role, content, command_id, kind, created_at_ms, attachment_base64, llm_parse_raw
       from device_chat_messages
       where user_id = ? and device_id = ?
       order by created_at_ms desc, id desc
       limit ?`
    )
    .all(userId, deviceId, lim) as DeviceChatRow[];
  return rows.slice().reverse();
}

/** 在写入本轮用户消息之前调用：不含当前句。 */
export function buildChatHistoryForLlm(db: Db, userId: string, deviceId: string): ChatTurnForLlm[] {
  if (!assertDeviceOwned(db, deviceId, userId)) return [];
  const rows = db
    .prepare(
      `select role, content, kind from device_chat_messages
       where user_id = ? and device_id = ?
       order by created_at_ms desc, id desc
       limit ?`
    )
    .all(userId, deviceId, MAX_LLM_TURNS * 2) as { role: string; content: string; kind: string }[];

  const rev = rows.slice().reverse();
  const out: ChatTurnForLlm[] = [];
  for (const r of rev) {
    if (r.role !== 'user' && r.role !== 'assistant') continue;
    let c = (r.content ?? '').trim();
    if (r.kind === 'screenshot') {
      c = c.length > 0 ? `${c}（附运行截图，略）` : '（助手返回一张运行截图，略）';
    }
    c = c.slice(0, MAX_CONTENT_CHARS);
    if (!c) continue;
    out.push({ role: r.role as 'user' | 'assistant', content: c });
  }
  return out;
}
