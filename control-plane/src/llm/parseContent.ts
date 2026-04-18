import { z } from 'zod';
import type { CommandSpec, RiskLevel, Step } from '../types.js';
import { assembleCommandSpec } from '../commandParser.js';

const llmEnvelopeSchema = z
  .object({
    risk_level: z.enum(['low', 'medium', 'high']).optional(),
    interpretation: z.string().max(400).optional(),
    steps: z.array(z.unknown()).min(1).max(48)
  })
  .passthrough();

/** 将模型爱用的别名映射为 open_app 的 app 键 */
function mapAliasToOpenAppKey(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (/chrome|chromium|谷歌/.test(s)) return 'chrome';
  if (/edge|edg|微软浏览/.test(s)) return 'edge';
  if (/firefox|火狐/.test(s)) return 'firefox';
  if (/notepad|记事本/.test(s)) return 'notepad';
  if (/calc|计算器/.test(s)) return 'calc';
  if (/vscode|code|代码编辑/.test(s)) return 'vscode';
  if (/explorer|资源管理|文件管理|此电脑/.test(s)) return 'explorer';
  if (/^wt$|windows\s*terminal|终端/.test(s)) return 'wt';
  if (/powershell|ps\s*控制台/.test(s)) return 'powershell';
  if (/\bcmd\b|命令提示/.test(s)) return 'cmd';
  if (/设置|settings/.test(s)) return 'settings';
  if (/画图|paint|mspaint/.test(s)) return 'paint';
  if (/任务管理|task\s*mgr|taskmgr/.test(s)) return 'taskmgr';
  const one = s.replace(/\s+/g, '');
  const known =
    /^(calc|notepad|explorer|cmd|powershell|wt|settings|edge|chrome|firefox|paint|taskmgr|control|mmsys|ncpa|regedit|snip|wordpad|vscode)$/;
  if (known.test(one)) return one;
  return null;
}

/** 模型杜撰的「切换窗口」类步骤 → open_app（Windows 下再次 Start 通常可激活已运行实例） */
function coerceSwitchLikeToOpenApp(o: Record<string, unknown>): Step | null {
  const appRaw = o.app ?? o.name ?? o.window ?? o.browser ?? o.target;
  if (typeof appRaw !== 'string') return null;
  const key = mapAliasToOpenAppKey(appRaw);
  if (!key) return null;
  return { type: 'open_app', app: key };
}

function coerceStep(raw: unknown): Step | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (typeof type !== 'string') return null;
  const t = type.trim().toLowerCase().replace(/-/g, '_');

  switch (t) {
    case 'open_app': {
      const app = o.app;
      if (typeof app !== 'string' || app.length > 64) return null;
      return { type: 'open_app', app: app.trim() };
    }
    case 'open_url': {
      const url = o.url;
      if (typeof url !== 'string' || url.length > 2048) return null;
      if (!/^https?:\/\//i.test(url)) return null;
      return { type: 'open_url', url: url.trim() };
    }
    case 'type_text': {
      const text = o.text;
      if (typeof text !== 'string' || text.length > 2048) return null;
      return { type: 'type_text', text };
    }
    case 'press_key': {
      const key = o.key;
      if (typeof key !== 'string' || key.length > 32) return null;
      return { type: 'press_key', key };
    }
    case 'sendkeys': {
      const sequence = o.sequence;
      if (typeof sequence !== 'string' || sequence.length > 256) return null;
      return { type: 'sendkeys', sequence };
    }
    case 'sleep': {
      const ms = o.ms;
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
      const m = Math.max(0, Math.min(600_000, Math.round(ms)));
      return { type: 'sleep', ms: m };
    }
    case 'screenshot':
      return { type: 'screenshot' };
    case 'notify': {
      const message = o.message;
      if (typeof message !== 'string' || message.length > 2048) return null;
      return { type: 'notify', message };
    }
    case 'volume': {
      const action = o.action;
      if (action !== 'up' && action !== 'down' && action !== 'mute') return null;
      return { type: 'volume', action };
    }
    case 'lock_screen':
      return { type: 'lock_screen' };
    case 'media': {
      const action = o.action;
      if (action !== 'play_pause' && action !== 'next' && action !== 'prev') return null;
      return { type: 'media', action };
    }
    case 'show_desktop':
      return { type: 'show_desktop' };
    case 'switch_to_window':
    case 'switch_window':
    case 'activate_app':
    case 'activate_window':
    case 'focus_app':
    case 'focus_window': {
      const s = coerceSwitchLikeToOpenApp(o);
      return s;
    }
    default:
      return null;
  }
}

function refineRiskFromSteps(steps: Step[], llmRisk: RiskLevel | undefined): RiskLevel {
  let r: RiskLevel = llmRisk ?? 'low';
  const bump = (x: RiskLevel) => {
    if (x === 'high') r = 'high';
    else if (x === 'medium' && r === 'low') r = 'medium';
  };
  for (const s of steps) {
    if (s.type === 'open_app' && s.app.toLowerCase() === 'regedit') bump('high');
    if (s.type === 'open_url') bump('medium');
    if (s.type === 'lock_screen') bump('medium');
  }
  return r;
}

export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('llm_no_json_object');
  return JSON.parse(body.slice(start, end + 1)) as unknown;
}

/** 先尝试纯对话信封，否则按远程指令解析 */
export function parseLlmFlexibleOutput(args: {
  content: string;
  commandId: string;
  deviceId: string;
  nowMs: number;
}): { mode: 'chat'; reply: string } | { mode: 'command'; commandId: string; spec: CommandSpec; interpretation: string } {
  const obj = extractJsonObject(args.content) as Record<string, unknown>;
  const replyRaw = obj.assistant_reply;
  const reply = typeof replyRaw === 'string' ? replyRaw.trim() : '';
  const stepsRaw = obj.steps;
  const hasSteps = Array.isArray(stepsRaw) && stepsRaw.length > 0;

  // 有可执行 steps 时一律走指令（即使有 assistant_reply）
  if (hasSteps) {
    const bundle = buildCommandBundleFromLlmText({
      content: args.content,
      commandId: args.commandId,
      deviceId: args.deviceId,
      nowMs: args.nowMs
    });
    return { mode: 'command', ...bundle };
  }

  // 无 steps 但有 assistant_reply：按对话处理（兼容未写 conversation_only 的模型输出）
  if (reply.length > 0) {
    return { mode: 'chat', reply: reply.slice(0, 4000) };
  }

  const bundle = buildCommandBundleFromLlmText({
    content: args.content,
    commandId: args.commandId,
    deviceId: args.deviceId,
    nowMs: args.nowMs
  });
  return { mode: 'command', ...bundle };
}

export function buildCommandBundleFromLlmText(args: {
  content: string;
  commandId: string;
  deviceId: string;
  nowMs: number;
}): { commandId: string; spec: CommandSpec; interpretation: string } {
  const parsed = llmEnvelopeSchema.parse(extractJsonObject(args.content));

  const steps: Step[] = [];
  for (const item of parsed.steps) {
    const s = coerceStep(item);
    if (s) steps.push(s);
  }
  if (steps.length === 0) throw new Error('llm_no_valid_steps');

  const risk = refineRiskFromSteps(steps, parsed.risk_level);
  const bundle = assembleCommandSpec(args.commandId, args.deviceId, args.nowMs, risk, steps);
  if (parsed.interpretation && parsed.interpretation.trim()) {
    return {
      ...bundle,
      interpretation: `${parsed.interpretation.trim()} · ${bundle.interpretation}`
    };
  }
  return bundle;
}
