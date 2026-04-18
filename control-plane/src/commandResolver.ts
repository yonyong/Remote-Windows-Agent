import { nanoid } from 'nanoid';
import { assembleCommandSpec, parseWithRules } from './commandParser.js';
import {
  augmentLlmUserTextForForegroundHint,
  isExplicitRemoteOperationIntent,
  preprocessUserCommand,
  shouldSkipLlmForCheapRules
} from './preprocess.js';
import type { CommandSpec, Step } from './types.js';
import type { ParseMode } from './commandParseTypes.js';
import type { EffectiveLlmConfig } from './parseSettings.js';
import { casualChatWithLlmProvider, helpCoachWithLlmProvider, parseWithLlmProvider } from './llm/dispatch.js';
import type { LlmUsageSnapshot } from './llm/usageTypes.js';
import type { ChatTurnForLlm } from './chatMessages.js';
import { helpCoachFallbackNoLlm, parseHelpCoachGoal } from './helpCoachIntent.js';

export type { ParseMode } from './commandParseTypes.js';

export type ParseBundle =
  | {
      kind: 'execute';
      commandId: string;
      spec: CommandSpec;
      interpretation: string;
      llmUsage?: LlmUsageSnapshot | null;
      /** GLM/LLM 解析失败时：模型正文或上游 HTTP 体，写入聊天供前端展示 */
      llmParseRawOutput?: string | null;
    }
  | { kind: 'chat'; commandId: string; interpretation: string; llmUsage?: LlmUsageSnapshot | null };

function llmLabel(cfg: EffectiveLlmConfig): string {
  if (cfg.provider === 'gemini') return 'Gemini';
  if (cfg.provider === 'zhipu') return 'GLM';
  return 'LLM';
}

function withPreprocessHint(bundle: ParseBundle, pre: ReturnType<typeof preprocessUserCommand>): ParseBundle {
  /** 闲聊/大模型回复不向用户拼接预处理说明，避免污染可见文案 */
  if (bundle.kind === 'chat') return bundle;
  if (!pre.trimmedFiller && !pre.truncated) return bundle;
  const bits = [pre.trimmedFiller ? '去客套' : '', pre.truncated ? '截断' : ''].filter(Boolean).join('/');
  return {
    ...bundle,
    interpretation: `${bundle.interpretation} · 预处理：${bits}`,
    llmUsage: bundle.llmUsage
  };
}

export type ParseLogger = {
  warn: (o: object, msg?: string) => void;
  error?: (o: object, msg?: string) => void;
};

/** 聊天里展示的短文案，避免把整段 Zod JSON 塞给用户 */
function formatLlmFailureForUser(err: unknown): string {
  const msg = err && typeof (err as { message?: string }).message === 'string' ? (err as { message: string }).message : String(err);
  if (msg.includes('llm_no_json_object')) return '模型未返回可解析的 JSON（常为纯文字或 Markdown）';
  if (msg.includes('Required') && msg.includes('steps')) return '模型 JSON 缺少可执行步骤 steps';
  if (msg.includes('JSON Parse error') || msg.includes('Unexpected token')) return '模型输出不是合法 JSON';
  const oneLine = msg.replace(/\s+/g, ' ').trim();
  return oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
}

/**
 * COMMAND_PARSE_MODE=rule|llm|hybrid（默认 rule）；也可在 Web「解析设置」里按用户覆盖。
 * - rule：仅规则（仍做文本预处理以统一匹配）
 * - llm：大模型；未配 KEY 或解析失败则回退规则
 * - hybrid：帮助/危险/纯截图等走规则省 token，其余走大模型
 */
export async function parseTextToCommandSpec(args: {
  deviceId: string;
  text: string;
  nowMs: number;
  commandId?: string;
  log?: ParseLogger;
  /** 登录用户解析配置（含页面上保存的模型与 Key）；不传则仅使用环境变量默认 */
  llm?: EffectiveLlmConfig;
  /** 不含当前句；供大模型理解多轮上文 */
  chatHistory?: ChatTurnForLlm[];
}): Promise<ParseBundle> {
  const commandId = args.commandId ?? `cmd_${nanoid(16)}`;
  const maxChars = Math.min(2000, Math.max(200, Number.parseInt(process.env.COMMAND_TEXT_MAX_CHARS ?? '900', 10) || 900));
  const pre = preprocessUserCommand(args.text, maxChars);
  const text = pre.normalized.length > 0 ? pre.normalized : args.text.trim();
  const rawTrim = args.text.trim();
  const cfg = args.llm;

  const helpCoachParsed = parseHelpCoachGoal(rawTrim);
  if (helpCoachParsed) {
    const runHelpCoach = async (): Promise<ParseBundle> => {
      const key = cfg?.apiKey?.trim();
      if (!key || !cfg) {
        return { kind: 'chat', commandId, interpretation: helpCoachFallbackNoLlm(helpCoachParsed.goal), llmUsage: null };
      }
      try {
        const { reply, llmUsage } = await helpCoachWithLlmProvider({
          provider: cfg.provider,
          originalLine: rawTrim,
          goal: helpCoachParsed.goal,
          apiKey: key,
          model: cfg.model,
          baseUrl: cfg.baseUrl ?? '',
          chatHistory: args.chatHistory
        });
        return { kind: 'chat', commandId, interpretation: reply, llmUsage };
      } catch (e: any) {
        args.log?.warn({ err: String(e?.message ?? e) }, 'help_coach_llm_failed');
        const fb = helpCoachFallbackNoLlm(helpCoachParsed.goal);
        return {
          kind: 'chat',
          commandId,
          interpretation: `暂时无法连接大模型生成个性化建议，以下为固定参考：\n\n${fb}`,
          llmUsage: null
        };
      }
    };
    return withPreprocessHint(await runHelpCoach(), pre);
  }

  const mode = cfg?.parseMode ?? 'rule';
  const cheapHit = shouldSkipLlmForCheapRules(text);
  const explicit = isExplicitRemoteOperationIntent(text, rawTrim);

  const ruleBundle = (): ParseBundle => {
    const b = parseWithRules({ deviceId: args.deviceId, text, nowMs: args.nowMs, commandId });
    return { kind: 'execute', commandId: b.commandId, spec: b.spec, interpretation: b.interpretation };
  };

  const casualChatFromLlm = async (): Promise<ParseBundle> => {
    const key = cfg?.apiKey?.trim();
    if (!key || !cfg) {
      return withPreprocessHint(
        {
          kind: 'chat',
          commandId,
          interpretation: '未配置大模型 API Key，无法进行自然语言对话。请在网页「解析设置」填写 Key，或让管理员在控制面环境变量中配置。',
          llmUsage: null
        },
        pre
      );
    }
    try {
      const { reply, llmUsage } = await casualChatWithLlmProvider({
        provider: cfg.provider,
        userText: rawTrim,
        apiKey: key,
        model: cfg.model,
        baseUrl: cfg.baseUrl ?? '',
        chatHistory: args.chatHistory
      });
      return withPreprocessHint({ kind: 'chat', commandId, interpretation: reply, llmUsage }, pre);
    } catch (e: any) {
      args.log?.warn({ err: String(e?.message ?? e) }, 'casual_chat_llm_failed');
      return withPreprocessHint(
        {
          kind: 'chat',
          commandId,
          interpretation: '大模型暂时不可用，请稍后再试。',
          llmUsage: null
        },
        pre
      );
    }
  };

  if (mode === 'rule') {
    if (!cheapHit && !explicit) return await casualChatFromLlm();
    return withPreprocessHint(ruleBundle(), pre);
  }

  const apiKey = cfg?.apiKey?.trim() || null;
  if (!apiKey) {
    args.log?.warn({ mode }, '未配置大模型 API Key（页面或环境变量），已使用规则引擎');
    if (!cheapHit && !explicit) return await casualChatFromLlm();
    return withPreprocessHint(ruleBundle(), pre);
  }

  if (cheapHit && (mode === 'llm' || mode === 'hybrid')) {
    args.log?.warn({ mode, cheap: true }, '省 token：命中固定句式，跳过大模型');
    return withPreprocessHint(ruleBundle(), pre);
  }

  if ((mode === 'llm' || mode === 'hybrid') && !explicit) {
    return await casualChatFromLlm();
  }

  const provider = cfg!.provider;
  const model = cfg!.model;
  const baseUrl = cfg!.baseUrl;

  const llmUserText = augmentLlmUserTextForForegroundHint(text);

  try {
    const out = await parseWithLlmProvider({
      provider,
      commandId,
      deviceId: args.deviceId,
      nowMs: args.nowMs,
      userText: llmUserText,
      apiKey,
      model,
      baseUrl,
      chatHistory: args.chatHistory,
      log: args.log
    });
    const tag = llmLabel(cfg!);
    if (out.conversationOnly) {
      return withPreprocessHint({ kind: 'chat', commandId, interpretation: out.interpretation, llmUsage: out.llmUsage }, pre);
    }
    return withPreprocessHint(
      {
        kind: 'execute',
        commandId,
        spec: out.spec,
        interpretation: `${out.interpretation} · ${tag}`,
        llmUsage: out.llmUsage
      },
      pre
    );
  } catch (e: any) {
    const raw = e?.message ? String(e.message) : String(e);
    args.log?.error?.({ err: raw, provider }, 'llm_parse_failed');
    const tag = cfg ? llmLabel(cfg) : 'LLM';
    const short = formatLlmFailureForUser(e);
    const modelOut = typeof e?.llmModelOutput === 'string' ? e.llmModelOutput.trim() : '';
    const httpBody = typeof e?.llmHttpBody === 'string' ? e.llmHttpBody.trim() : '';
    const rawOut = (modelOut || httpBody).slice(0, 80_000);
    const steps: Step[] = [
      {
        type: 'notify',
        message: `模型解析未成功（${short}）。请把需求说得更像操作句，例如「打开记事本」「截图」；本次不会自动截屏。`
      }
    ];
    const assembled = assembleCommandSpec(commandId, args.deviceId, args.nowMs, 'low', steps);
    return withPreprocessHint(
      {
        kind: 'execute',
        commandId: assembled.commandId,
        spec: assembled.spec,
        interpretation: `已处理 · ${tag} 解析未就绪（${short}），已下发提示步骤、未截屏。`,
        llmUsage: null,
        llmParseRawOutput: rawOut.length > 0 ? rawOut : null
      },
      pre
    );
  }
}
