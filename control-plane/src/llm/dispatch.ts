import {
  casualChatWithOpenAiCompatible,
  openAiCompatibleChatCompletion,
  parseWithOpenAiCompatible,
  openAiCompatiblePing
} from './openaiCompatible.js';
import { geminiGenerateText, parseWithGemini, geminiPing } from './gemini.js';
import { CASUAL_CHAT_SYSTEM_PROMPT, HELP_COACH_SYSTEM_PROMPT } from './systemPrompt.js';
import type { LlmProvider } from '../parseSettings.js';
import type { LlmDiagnosticLogger } from './diagnosticLog.js';
import type { LlmUsageSnapshot } from './usageTypes.js';
import type { ChatTurnForLlm } from '../chatMessages.js';

function wantOpenAiJsonObjectMode(provider: LlmProvider): boolean {
  if (provider === 'gemini') return false;
  const v = process.env.COMMAND_LLM_DISABLE_JSON_OBJECT;
  if (v === '1' || v === 'true' || v === 'yes') return false;
  return true;
}

/** 非操控句：纯文本闲聊 */
export async function casualChatWithLlmProvider(args: {
  provider: LlmProvider;
  userText: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  chatHistory?: ChatTurnForLlm[];
}): Promise<{ reply: string; llmUsage: LlmUsageSnapshot | null }> {
  if (args.provider === 'gemini') {
    const { text, usage } = await geminiGenerateText({
      apiKey: args.apiKey,
      model: args.model,
      userText: args.userText,
      systemPrompt: CASUAL_CHAT_SYSTEM_PROMPT,
      chatHistory: args.chatHistory,
      temperature: 0.55,
      maxOutputTokens: 1024
    });
    return { reply: text.trim(), llmUsage: usage };
  }
  const { reply, usage } = await casualChatWithOpenAiCompatible({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    userText: args.userText,
    chatHistory: args.chatHistory
  });
  return { reply, llmUsage: usage };
}

function buildHelpCoachUserMessage(args: { originalLine: string; goal: string }): string {
  const g = args.goal.trim();
  return [
    '【用户本轮完整输入】',
    args.originalLine.trim(),
    '',
    '【去掉「求助 / help」前缀后的诉求】',
    g.length > 0 ? g : '（空白：请引导用户补充他想在远程电脑上完成的具体目标。）',
    '',
    '请按系统设定输出教学与可复制示例指令。'
  ].join('\n');
}

/** 「求助」「help …」：教用户如何组织远程指令（自然语言，非 JSON） */
export async function helpCoachWithLlmProvider(args: {
  provider: LlmProvider;
  originalLine: string;
  goal: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  chatHistory?: ChatTurnForLlm[];
}): Promise<{ reply: string; llmUsage: LlmUsageSnapshot | null }> {
  const userText = buildHelpCoachUserMessage({ originalLine: args.originalLine, goal: args.goal });
  if (args.provider === 'gemini') {
    const { text, usage } = await geminiGenerateText({
      apiKey: args.apiKey,
      model: args.model,
      userText,
      systemPrompt: HELP_COACH_SYSTEM_PROMPT,
      chatHistory: args.chatHistory,
      temperature: 0.45,
      maxOutputTokens: 1536
    });
    return { reply: text.trim(), llmUsage: usage };
  }
  const { content, usage } = await openAiCompatibleChatCompletion({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    userText,
    systemPrompt: HELP_COACH_SYSTEM_PROMPT,
    chatHistory: args.chatHistory,
    temperature: 0.45,
    maxTokens: 1536
  });
  return { reply: content.trim(), llmUsage: usage };
}

/** 对话 Agent：自定义系统提示，纯文本回复（不经指令 JSON 解析） */
export async function agentCasualChatWithLlmProvider(args: {
  provider: LlmProvider;
  userText: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  systemPrompt: string;
  chatHistory?: ChatTurnForLlm[];
}): Promise<{ reply: string; llmUsage: LlmUsageSnapshot | null }> {
  if (args.provider === 'gemini') {
    const { text, usage } = await geminiGenerateText({
      apiKey: args.apiKey,
      model: args.model,
      userText: args.userText,
      systemPrompt: args.systemPrompt,
      chatHistory: args.chatHistory,
      temperature: 0.55,
      maxOutputTokens: 2048
    });
    return { reply: text.trim(), llmUsage: usage };
  }
  const { content, usage } = await openAiCompatibleChatCompletion({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    userText: args.userText,
    systemPrompt: args.systemPrompt,
    chatHistory: args.chatHistory,
    temperature: 0.55,
    maxTokens: 2048
  });
  return { reply: content.trim(), llmUsage: usage };
}

export async function parseWithLlmProvider(args: {
  provider: LlmProvider;
  commandId: string;
  deviceId: string;
  nowMs: number;
  userText: string;
  apiKey: string;
  model: string;
  /** OpenAI 兼容基址（智谱 / OpenAI / DeepSeek 等）；Gemini 忽略 */
  baseUrl: string;
  chatHistory?: ChatTurnForLlm[];
  /** 指令解析失败时记录模型原始输出等（见环境变量 COMMAND_LLM_LOG_BODY_MAX_CHARS） */
  log?: LlmDiagnosticLogger;
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
  if (args.provider === 'gemini') {
    return parseWithGemini({
      commandId: args.commandId,
      deviceId: args.deviceId,
      nowMs: args.nowMs,
      userText: args.userText,
      apiKey: args.apiKey,
      model: args.model,
      chatHistory: args.chatHistory,
      diagnosticLog: args.log
    });
  }
  return parseWithOpenAiCompatible({
    commandId: args.commandId,
    deviceId: args.deviceId,
    nowMs: args.nowMs,
    userText: args.userText,
    apiKey: args.apiKey,
    model: args.model,
    baseUrl: args.baseUrl,
    chatHistory: args.chatHistory,
    responseFormatJsonObject: wantOpenAiJsonObjectMode(args.provider),
    diagnosticLog: args.log
  });
}

export async function pingLlmProvider(args: {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
}): Promise<void> {
  if (args.provider === 'gemini') {
    await geminiPing({ apiKey: args.apiKey, model: args.model });
    return;
  }
  await openAiCompatiblePing({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model
  });
}
