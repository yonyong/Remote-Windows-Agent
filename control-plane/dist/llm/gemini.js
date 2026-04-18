import { clipForLlmLog, llmLogBodyMaxChars } from './diagnosticLog.js';
import { COMMAND_LLM_JSON_REPAIR_SYSTEM_PROMPT, COMMAND_LLM_SYSTEM_PROMPT } from './systemPrompt.js';
import { parseLlmFlexibleOutput } from './parseContent.js';
import { throwWithLlmHttpBody, throwWithLlmModelOutput } from './throwWithDiagnostic.js';
import { mergeLlmUsage } from './usageTypes.js';
function geminiGenerateUrl(model, apiKey) {
    const m = encodeURIComponent(model);
    const k = encodeURIComponent(apiKey);
    return `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${k}`;
}
function usageFromGemini(data, durationMs) {
    const um = data?.usageMetadata;
    if (!um || typeof um !== 'object')
        return { durationMs };
    return {
        durationMs,
        promptTokens: typeof um.promptTokenCount === 'number' ? um.promptTokenCount : undefined,
        completionTokens: typeof um.candidatesTokenCount === 'number' ? um.candidatesTokenCount : undefined,
        totalTokens: typeof um.totalTokenCount === 'number' ? um.totalTokenCount : undefined
    };
}
export async function geminiGenerateText(args) {
    const t0 = Date.now();
    const logMax = llmLogBodyMaxChars();
    const url = geminiGenerateUrl(args.model, args.apiKey);
    const contents = [];
    for (const h of args.chatHistory ?? []) {
        contents.push({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.content }]
        });
    }
    contents.push({ role: 'user', parts: [{ text: args.userText }] });
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: args.systemPrompt ?? COMMAND_LLM_SYSTEM_PROMPT }] },
            contents,
            generationConfig: {
                temperature: args.temperature ?? 0.12,
                maxOutputTokens: args.maxOutputTokens ?? 768,
                ...(args.responseMimeType ? { responseMimeType: args.responseMimeType } : {})
            }
        })
    });
    const rawText = await res.text();
    const durationMs = Date.now() - t0;
    if (!res.ok) {
        args.diagnosticLog?.warn?.({
            phase: 'gemini_http',
            httpStatus: res.status,
            request: { model: args.model, userTextPreview: clipForLlmLog(args.userText, 600) },
            responseBody: clipForLlmLog(rawText, logMax)
        }, 'llm_http_error');
        throwWithLlmHttpBody(`gemini_http_${res.status}:${rawText.slice(0, 240)}`, clipForLlmLog(rawText, logMax));
    }
    let data;
    try {
        data = JSON.parse(rawText);
    }
    catch {
        args.diagnosticLog?.warn?.({ phase: 'gemini_response_json', responseBody: clipForLlmLog(rawText, logMax) }, 'llm_upstream_invalid_json');
        throwWithLlmHttpBody('gemini_bad_json_response', clipForLlmLog(rawText, logMax));
    }
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        args.diagnosticLog?.warn?.({
            phase: 'gemini_empty_candidates',
            responseBody: clipForLlmLog(rawText, logMax)
        }, 'llm_gemini_no_candidates');
        throwWithLlmHttpBody('gemini_empty_candidates', clipForLlmLog(rawText, logMax));
    }
    const texts = parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('');
    if (!texts.trim()) {
        args.diagnosticLog?.warn?.({
            phase: 'gemini_empty_text',
            responseBody: clipForLlmLog(rawText, logMax)
        }, 'llm_gemini_empty_content');
        throwWithLlmHttpBody('gemini_empty_content', clipForLlmLog(rawText, logMax));
    }
    return { text: texts, usage: usageFromGemini(data, durationMs) };
}
export async function geminiPing(args) {
    const url = geminiGenerateUrl(args.model, args.apiKey);
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: 'Reply exactly: ok' }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 8 }
        })
    });
    const rawText = await res.text();
    if (!res.ok) {
        throw new Error(`gemini_http_${res.status}:${rawText.slice(0, 240)}`);
    }
}
export async function parseWithGemini(args) {
    const logParseFail = (t, err) => {
        const logMax = llmLogBodyMaxChars();
        args.diagnosticLog?.warn?.({
            phase: 'command_parse_from_model_text',
            commandId: args.commandId,
            model: args.model,
            userTextPreview: clipForLlmLog(args.userText, 800),
            modelOutputChars: t.length,
            modelOutput: clipForLlmLog(t, logMax),
            err: err instanceof Error ? err.message : String(err)
        }, 'llm_command_json_parse_failed');
    };
    const r1 = await geminiGenerateText({
        apiKey: args.apiKey,
        model: args.model,
        userText: args.userText,
        chatHistory: args.chatHistory,
        temperature: 0.22,
        maxOutputTokens: 1280,
        diagnosticLog: args.diagnosticLog,
        responseMimeType: 'application/json'
    });
    let text = r1.text;
    let usage = r1.usage;
    let parsed;
    try {
        parsed = parseLlmFlexibleOutput({
            content: text,
            commandId: args.commandId,
            deviceId: args.deviceId,
            nowMs: args.nowMs
        });
    }
    catch (e1) {
        logParseFail(text, e1);
        if (process.env.COMMAND_LLM_JSON_REPAIR === '0') {
            throwWithLlmModelOutput(e1 instanceof Error ? e1.message : String(e1), text, e1);
        }
        let fixed = '';
        try {
            const clip = clipForLlmLog(text, 6000);
            const r2 = await geminiGenerateText({
                apiKey: args.apiKey,
                model: args.model,
                userText: `【用户原句】\n${args.userText}\n\n【模型上次输出】\n${clip}`,
                systemPrompt: COMMAND_LLM_JSON_REPAIR_SYSTEM_PROMPT,
                chatHistory: [],
                temperature: 0,
                maxOutputTokens: 2048,
                diagnosticLog: args.diagnosticLog,
                responseMimeType: 'application/json'
            });
            fixed = r2.text;
            usage = mergeLlmUsage(usage, r2.usage);
            parsed = parseLlmFlexibleOutput({
                content: fixed,
                commandId: args.commandId,
                deviceId: args.deviceId,
                nowMs: args.nowMs
            });
            text = `${text}\n---json_repair---\n${fixed}`;
        }
        catch (e2) {
            logParseFail(fixed || text, e2);
            throwWithLlmModelOutput(e2 instanceof Error ? e2.message : String(e2), fixed ? `${r1.text}\n---json_repair_failed---\n${fixed}` : r1.text, e2);
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
