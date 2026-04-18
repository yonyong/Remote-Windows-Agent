const PROVIDERS = ['zhipu', 'openai_compatible', 'gemini'];
export function parseLlmProvider(s) {
    const x = (s ?? 'zhipu').toLowerCase().trim();
    if (x === 'openai' || x === 'openai_compatible' || x === 'chatgpt' || x === 'deepseek')
        return 'openai_compatible';
    if (x === 'gemini' || x === 'google')
        return 'gemini';
    if (x === 'zhipu' || x === 'glm' || x === 'bigmodel')
        return 'zhipu';
    return 'zhipu';
}
export function parseModeFromString(s) {
    const m = (s ?? 'rule').toLowerCase().trim();
    if (m === 'llm' || m === 'hybrid')
        return m;
    return 'rule';
}
export function defaultBaseUrl(provider) {
    switch (provider) {
        case 'zhipu':
            return 'https://open.bigmodel.cn/api/paas/v4';
        case 'openai_compatible':
            return 'https://api.openai.com/v1';
        case 'gemini':
            return '';
    }
}
export function defaultModel(provider) {
    switch (provider) {
        case 'zhipu':
            return 'glm-4-flash';
        case 'openai_compatible':
            return 'gpt-4o-mini';
        case 'gemini':
            return 'gemini-2.0-flash';
    }
}
export function normalizeLlmBaseUrl(provider, raw) {
    const d = defaultBaseUrl(provider);
    const t = raw?.trim();
    if (!t)
        return d;
    return t.replace(/\/$/, '');
}
function resolveApiKey(provider, row) {
    const fromUser = row?.llm_api_key?.trim();
    if (fromUser)
        return fromUser;
    if (provider === 'zhipu')
        return process.env.ZHIPU_API_KEY?.trim() || null;
    if (provider === 'openai_compatible') {
        return (process.env.OPENAI_API_KEY?.trim() ||
            process.env.OPENAI_COMPAT_API_KEY?.trim() ||
            process.env.DEEPSEEK_API_KEY?.trim() ||
            null);
    }
    if (provider === 'gemini')
        return process.env.GEMINI_API_KEY?.trim() || null;
    return null;
}
function resolveModel(provider, row) {
    const m = row?.llm_model?.trim();
    if (m)
        return m;
    if (provider === 'zhipu')
        return process.env.ZHIPU_MODEL?.trim() || defaultModel(provider);
    return defaultModel(provider);
}
/**
 * 合并优先级：用户表中的非空字段覆盖环境变量默认；API Key 在用户未填时按厂商回退到对应 env。
 */
export function resolveEffectiveLlmConfig(db, userId) {
    const row = db
        .prepare(`select user_id, parse_mode, llm_provider, llm_api_key, llm_base_url, llm_model, updated_at_ms
       from user_parse_settings where user_id = ?`)
        .get(userId);
    const envMode = parseModeFromString(process.env.COMMAND_PARSE_MODE);
    const parseMode = row ? parseModeFromString(row.parse_mode) : envMode;
    const provider = row ? parseLlmProvider(row.llm_provider) : parseLlmProvider(process.env.DEFAULT_LLM_PROVIDER);
    const model = resolveModel(provider, row);
    let baseUrl = normalizeLlmBaseUrl(provider, row?.llm_base_url);
    if (provider === 'zhipu' && !row?.llm_base_url?.trim()) {
        const envB = process.env.ZHIPU_API_BASE?.trim();
        if (envB)
            baseUrl = envB.replace(/\/$/, '');
    }
    if (provider === 'openai_compatible' && !row?.llm_base_url?.trim()) {
        const envB = process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_COMPAT_BASE_URL?.trim();
        if (envB)
            baseUrl = envB.replace(/\/$/, '');
    }
    const apiKey = resolveApiKey(provider, row);
    return { parseMode, provider, apiKey, baseUrl, model };
}
export function resolveEffectiveLlmConfigForPing(db, userId, overrides) {
    const eff = resolveEffectiveLlmConfig(db, userId);
    const provider = overrides?.llmProvider ?? eff.provider;
    const apiKey = (typeof overrides?.apiKey === 'string' && overrides.apiKey.trim().length > 0 ? overrides.apiKey.trim() : null) ||
        eff.apiKey?.trim() ||
        null;
    let model = eff.model;
    if (typeof overrides?.llmModel === 'string' && overrides.llmModel.trim().length > 0) {
        model = overrides.llmModel.trim();
    }
    else if (overrides?.llmProvider !== undefined && overrides.llmProvider !== eff.provider) {
        model = defaultModel(provider);
    }
    let baseUrl = eff.baseUrl;
    if (overrides?.llmBaseUrl !== undefined) {
        baseUrl = normalizeLlmBaseUrl(provider, overrides.llmBaseUrl);
    }
    else if (overrides?.llmProvider !== undefined && overrides.llmProvider !== eff.provider) {
        baseUrl = normalizeLlmBaseUrl(provider, null);
    }
    return {
        parseMode: eff.parseMode,
        provider,
        apiKey,
        baseUrl,
        model
    };
}
export function maskApiKeyHint(key) {
    const k = key?.trim();
    if (!k)
        return { hasApiKey: false, hint: null };
    if (k.length <= 6)
        return { hasApiKey: true, hint: '****' };
    return { hasApiKey: true, hint: `${k.slice(0, 3)}…${k.slice(-4)}` };
}
export function getParseSettingsForApi(db, userId) {
    const row = db
        .prepare(`select user_id, parse_mode, llm_provider, llm_api_key, llm_base_url, llm_model, updated_at_ms
       from user_parse_settings where user_id = ?`)
        .get(userId);
    const eff = resolveEffectiveLlmConfig(db, userId);
    const storedKey = row?.llm_api_key?.trim() ?? '';
    const { hasApiKey, hint } = maskApiKeyHint(storedKey || null);
    const formProvider = row ? parseLlmProvider(row.llm_provider) : parseLlmProvider(process.env.DEFAULT_LLM_PROVIDER);
    const formParseMode = row ? parseModeFromString(row.parse_mode) : parseModeFromString(process.env.COMMAND_PARSE_MODE);
    return {
        parseMode: formParseMode,
        llmProvider: formProvider,
        llmModel: row?.llm_model?.trim() || defaultModel(formProvider),
        llmBaseUrl: row?.llm_base_url?.trim() || null,
        hasStoredApiKey: Boolean(storedKey),
        storedApiKeyHint: hasApiKey ? hint : null,
        effectiveHasApiKey: Boolean(eff.apiKey),
        effectiveParseMode: eff.parseMode,
        updatedAtMs: row?.updated_at_ms ?? null,
        providerOptions: LLM_PROVIDERS_META
    };
}
export const LLM_PROVIDERS_META = PROVIDERS.map((p) => ({
    id: p,
    label: p === 'zhipu'
        ? '智谱 GLM（OpenAI 兼容接口）'
        : p === 'openai_compatible'
            ? 'OpenAI 兼容（ChatGPT / DeepSeek / 其它）'
            : 'Google Gemini'
}));
