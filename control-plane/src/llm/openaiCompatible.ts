import {
  CASUAL_CHAT_SYSTEM_PROMPT,
  COMMAND_LLM_JSON_REPAIR_SYSTEM_PROMPT,
  COMMAND_LLM_SYSTEM_PROMPT
} from './systemPrompt.js';
import { clipForLlmLog, llmLogBodyMaxChars, type LlmDiagnosticLogger } from './diagnosticLog.js';
import { parseLlmFlexibleOutput } from './parseContent.js';
import { throwWithLlmHttpBody, throwWithLlmModelOutput } from './throwWithDiagnostic.js';
import { mergeLlmUsage, type LlmUsageSnapshot } from './usageTypes.js';
import type { ChatTurnForLlm } from '../chatMessages.js';

function usageFromOpenAiJson(data: any, durationMs: number): LlmUsageSnapshot | null {
  const u = data?.usage;
  if (!u || typeof u !== 'object') return { durationMs };
  const pt = u.prompt_tokens ?? u.promptTokens;
  const ct = u.completion_tokens ?? u.completionTokens;
  const tt = u.total_tokens ?? u.totalTokens;
  return {
    durationMs,
    promptTokens: typeof pt === 'number' ? pt : undefined,
    completionTokens: typeof ct === 'number' ? ct : undefined,
    totalTokens: typeof tt === 'number' ? tt : undefined
  };
}

export async function openAiCompatibleChatCompletion(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  userText: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** 为 true 时在请求体中加 response_format: json_object（智谱等 OpenAI 兼容实现） */
  responseFormatJsonObject?: boolean;
  /** 不含当前 userText；按时间顺序 */
  chatHistory?: ChatTurnForLlm[];
  /** 失败时写入 HTTP 响应体等（勿在生产长期打开超大日志） */
  diagnosticLog?: LlmDiagnosticLogger;
}): Promise<{ content: string; usage: LlmUsageSnapshot | null }> {
  const t0 = Date.now();
  const url = `${args.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const logMax = llmLogBodyMaxChars();
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: args.systemPrompt ?? COMMAND_LLM_SYSTEM_PROMPT }
  ];
  for (const h of args.chatHistory ?? []) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: args.userText });
  const body: Record<string, unknown> = {
    model: args.model,
    temperature: args.temperature ?? 0.12,
    max_tokens: args.maxTokens ?? 768,
    messages
  };
  if (args.responseFormatJsonObject) {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify(body)
  });

  const rawText = await res.text();
  const durationMs = Date.now() - t0;
  if (!res.ok) {
    args.diagnosticLog?.warn?.(
      {
        phase: 'openai_compatible_http',
        httpStatus: res.status,
        request: {
          model: args.model,
          responseFormatJsonObject: Boolean(body.response_format),
          userTextPreview: clipForLlmLog(args.userText, 600)
        },
        responseBody: clipForLlmLog(rawText, logMax)
      },
      'llm_http_error'
    );
    throwWithLlmHttpBody(`openai_http_${res.status}:${rawText.slice(0, 200)}`, clipForLlmLog(rawText, logMax));
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch {
    args.diagnosticLog?.warn?.(
      {
        phase: 'openai_compatible_response_json',
        responseBody: clipForLlmLog(rawText, logMax)
      },
      'llm_upstream_invalid_json'
    );
    throwWithLlmHttpBody('openai_bad_json_response', clipForLlmLog(rawText, logMax));
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    args.diagnosticLog?.warn?.(
      {
        phase: 'openai_compatible_empty_content',
        responseBody: clipForLlmLog(rawText, logMax)
      },
      'llm_empty_message_content'
    );
    throwWithLlmHttpBody('openai_empty_content', clipForLlmLog(rawText, logMax));
  }
  return { content, usage: usageFromOpenAiJson(data, durationMs) };
}

/** 连通性探测：不要求输出可解析指令 JSON。 */
export async function openAiCompatiblePing(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
}): Promise<void> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`
    },
    body: JSON.stringify({
      model: args.model,
      temperature: 0,
      max_tokens: 8,
      messages: [
        { role: 'system', content: 'Reply with exactly: ok' },
        { role: 'user', content: 'ping' }
      ]
    })
  });
  const rawText = await res.text();
  if (!res.ok) {
    throw new Error(`openai_http_${res.status}:${rawText.slice(0, 200)}`);
  }
}

/** 非操控句：走纯文本闲聊，不调指令 JSON 解析 */
export async function casualChatWithOpenAiCompatible(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  userText: string;
  chatHistory?: ChatTurnForLlm[];
}): Promise<{ reply: string; usage: LlmUsageSnapshot | null }> {
  const { content, usage } = await openAiCompatibleChatCompletion({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    userText: args.userText,
    systemPrompt: CASUAL_CHAT_SYSTEM_PROMPT,
    chatHistory: args.chatHistory,
    temperature: 0.55,
    maxTokens: 1024
  });
  return { reply: content.trim(), usage };
}

export async function parseWithOpenAiCompatible(args: {
  commandId: string;
  deviceId: string;
  nowMs: number;
  userText: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  /** 智谱等厂商建议开启以强制 JSON */
  responseFormatJsonObject?: boolean;
  chatHistory?: ChatTurnForLlm[];
  diagnosticLog?: LlmDiagnosticLogger;
}): Promise<
  | {
      commandId: string;
      interpretation: string;
      llmUsage: LlmUsageSnapshot | null;
      conversationOnly: true;
    }
  | {
      commandId: string;
      spec: import('../types.js').CommandSpec;
      interpretation: string;
      llmUsage: LlmUsageSnapshot | null;
      conversationOnly: false;
    }
> {
  const logParseFail = (content: string, err: unknown) => {
    const logMax = llmLogBodyMaxChars();
    args.diagnosticLog?.warn?.(
      {
        phase: 'command_parse_from_model_text',
        commandId: args.commandId,
        model: args.model,
        responseFormatJsonObject: Boolean(args.responseFormatJsonObject),
        userTextPreview: clipForLlmLog(args.userText, 800),
        modelOutputChars: content.length,
        modelOutput: clipForLlmLog(content, logMax),
        err: err instanceof Error ? err.message : String(err)
      },
      'llm_command_json_parse_failed'
    );
  };

  const { content: c1, usage: u1 } = await openAiCompatibleChatCompletion({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    userText: args.userText,
    chatHistory: args.chatHistory,
    temperature: 0.22,
    maxTokens: 1280,
    responseFormatJsonObject: args.responseFormatJsonObject,
    diagnosticLog: args.diagnosticLog
  });

  let content = c1;
  let usage: LlmUsageSnapshot | null = u1;
  let parsed: ReturnType<typeof parseLlmFlexibleOutput>;
  try {
    parsed = parseLlmFlexibleOutput({
      content,
      commandId: args.commandId,
      deviceId: args.deviceId,
      nowMs: args.nowMs
    });
  } catch (e1) {
    logParseFail(content, e1);
    const repairOff = process.env.COMMAND_LLM_JSON_REPAIR === '0';
    if (repairOff) {
      throwWithLlmModelOutput(e1 instanceof Error ? e1.message : String(e1), content, e1);
    }
    let fixed = '';
    try {
      const clip = clipForLlmLog(content, 6000);
      const r2 = await openAiCompatibleChatCompletion({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.model,
        userText: `【用户原句】\n${args.userText}\n\n【模型上次输出】\n${clip}`,
        systemPrompt: COMMAND_LLM_JSON_REPAIR_SYSTEM_PROMPT,
        chatHistory: [],
        temperature: 0,
        maxTokens: 2048,
        responseFormatJsonObject: true,
        diagnosticLog: args.diagnosticLog
      });
      fixed = r2.content;
      usage = mergeLlmUsage(usage, r2.usage);
      parsed = parseLlmFlexibleOutput({
        content: fixed,
        commandId: args.commandId,
        deviceId: args.deviceId,
        nowMs: args.nowMs
      });
      content = `${content}\n---json_repair---\n${fixed}`;
    } catch (e2) {
      logParseFail(fixed || content, e2);
      throwWithLlmModelOutput(
        e2 instanceof Error ? e2.message : String(e2),
        fixed ? `${c1}\n---json_repair_failed---\n${fixed}` : c1,
        e2
      );
    }
  }
  if (parsed.mode === 'chat') {
    return {
      commandId: args.commandId,
      interpretation: parsed.reply,
      llmUsage: usage,
      conversationOnly: true
    };
  }
  return {
    commandId: parsed.commandId,
    spec: parsed.spec,
    interpretation: parsed.interpretation,
    llmUsage: usage,
    conversationOnly: false
  };
}
