import { z } from 'zod';
import { assembleCommandSpec } from './commandParser.js';
const ZHIPU_URL_DEFAULT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const llmEnvelopeSchema = z.object({
    risk_level: z.enum(['low', 'medium', 'high']).optional(),
    interpretation: z.string().max(400).optional(),
    steps: z.array(z.unknown()).min(1).max(48)
});
function coerceStep(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const o = raw;
    const type = o.type;
    if (typeof type !== 'string')
        return null;
    switch (type) {
        case 'open_app': {
            const app = o.app;
            if (typeof app !== 'string' || app.length > 64)
                return null;
            return { type: 'open_app', app: app.trim() };
        }
        case 'open_url': {
            const url = o.url;
            if (typeof url !== 'string' || url.length > 2048)
                return null;
            if (!/^https?:\/\//i.test(url))
                return null;
            return { type: 'open_url', url: url.trim() };
        }
        case 'type_text': {
            const text = o.text;
            if (typeof text !== 'string' || text.length > 2048)
                return null;
            return { type: 'type_text', text };
        }
        case 'press_key': {
            const key = o.key;
            if (typeof key !== 'string' || key.length > 32)
                return null;
            return { type: 'press_key', key };
        }
        case 'sendkeys': {
            const sequence = o.sequence;
            if (typeof sequence !== 'string' || sequence.length > 256)
                return null;
            return { type: 'sendkeys', sequence };
        }
        case 'sleep': {
            const ms = o.ms;
            if (typeof ms !== 'number' || !Number.isFinite(ms))
                return null;
            const m = Math.max(0, Math.min(600_000, Math.round(ms)));
            return { type: 'sleep', ms: m };
        }
        case 'screenshot':
            return { type: 'screenshot' };
        case 'notify': {
            const message = o.message;
            if (typeof message !== 'string' || message.length > 2048)
                return null;
            return { type: 'notify', message };
        }
        case 'volume': {
            const action = o.action;
            if (action !== 'up' && action !== 'down' && action !== 'mute')
                return null;
            return { type: 'volume', action };
        }
        case 'lock_screen':
            return { type: 'lock_screen' };
        case 'media': {
            const action = o.action;
            if (action !== 'play_pause' && action !== 'next' && action !== 'prev')
                return null;
            return { type: 'media', action };
        }
        case 'show_desktop':
            return { type: 'show_desktop' };
        default:
            return null;
    }
}
function refineRiskFromSteps(steps, llmRisk) {
    let r = llmRisk ?? 'low';
    const bump = (x) => {
        if (x === 'high')
            r = 'high';
        else if (x === 'medium' && r === 'low')
            r = 'medium';
    };
    for (const s of steps) {
        if (s.type === 'open_app' && s.app.toLowerCase() === 'regedit')
            bump('high');
        if (s.type === 'open_url')
            bump('medium');
        if (s.type === 'lock_screen')
            bump('medium');
    }
    return r;
}
function extractJsonObject(text) {
    const trimmed = text.trim();
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fence ? fence[1].trim() : trimmed;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start)
        throw new Error('glm_no_json_object');
    return JSON.parse(body.slice(start, end + 1));
}
const SYSTEM_PROMPT = `你是Windows远程控制指令生成器。用户用中文描述操作。只输出一个JSON对象，不要Markdown，不要解释。
键：risk_level(可选 low|medium|high)、steps(必填数组)、interpretation(可选，≤80字中文摘要)。
steps元素仅允许以下type（必须含type字段）：
open_app:{app:string}；open_url:{url:http(s)地址}；type_text:{text}；press_key:{key}；sendkeys:{sequence}；sleep:{ms:number}；screenshot:{}；notify:{message}；volume:{action:up|down|mute}；lock_screen:{}；media:{action:play_pause|next|prev}；show_desktop:{}。
app常用键：calc,notepad,explorer,cmd,powershell,wt,settings,edge,chrome,firefox,paint,taskmgr,control,mmsys,ncpa,regedit,snip,wordpad,vscode。
禁止生成关机/格式化等破坏性步骤；若用户要求则notify拒绝并risk_level=high。至少1步，未知意图可screenshot。`;
export async function parseWithGlm(args) {
    const url = `${args.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${args.apiKey}`
        },
        body: JSON.stringify({
            model: args.model,
            temperature: 0.12,
            max_tokens: 768,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: args.userText }
            ]
        })
    });
    const rawText = await res.text();
    if (!res.ok) {
        throw new Error(`glm_http_${res.status}:${rawText.slice(0, 200)}`);
    }
    let data;
    try {
        data = JSON.parse(rawText);
    }
    catch {
        throw new Error('glm_bad_json_response');
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('glm_empty_content');
    }
    const parsed = llmEnvelopeSchema.parse(extractJsonObject(content));
    const steps = [];
    for (const item of parsed.steps) {
        const s = coerceStep(item);
        if (s)
            steps.push(s);
    }
    if (steps.length === 0)
        throw new Error('glm_no_valid_steps');
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
