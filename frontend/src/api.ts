const STORAGE_KEY = 'rwa_control_plane_api';

const envApi = ((import.meta as any).env?.VITE_API_URL as string | undefined)?.trim?.();

/** 根据当前页面地址推断控制面（与前端同主机、8787 端口），便于手机通过局域网 IP 访问开发页。 */
export function inferApiBaseFromLocation(): string {
  if (typeof window === 'undefined') {
    return envApi && envApi.length > 0 ? stripTrailingSlash(envApi) : 'http://127.0.0.1:8787';
  }
  const { hostname } = window.location;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1') {
    return 'http://127.0.0.1:8787';
  }
  // 本地开发控制面通常为 HTTP；若此处跟随页面写成 https，浏览器常会拦截混合内容。
  return `http://${hostname}:8787`;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/** 未写端口时默认补 8787（控制面约定端口） */
export function normalizeControlPlaneBase(u: string): string {
  const t = stripTrailingSlash(u.trim());
  try {
    const x = new URL(t);
    if (!x.port) {
      x.port = '8787';
      return stripTrailingSlash(x.toString());
    }
  } catch {
    /* keep */
  }
  return t;
}

/** 优先级：用户保存值 > 构建时 VITE_API_URL > 根据当前页面推断 */
export function getApiBase(): string {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim();
    if (saved) return stripTrailingSlash(saved);
  }
  if (envApi && envApi.length > 0) return stripTrailingSlash(envApi);
  return inferApiBaseFromLocation();
}

/** 传入 null 或空字符串则清除保存，恢复为「环境变量或自动推断」 */
export function setApiBase(url: string | null) {
  if (typeof window === 'undefined') return;
  const u = url?.trim();
  if (!u) localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, normalizeControlPlaneBase(u));
}

export type Device = {
  id: string;
  name: string;
  created_at_ms: number;
  revoked_at_ms: number | null;
  online: boolean;
};

export type CommandEvent = { at_ms: number; level: string; message: string };

/** 与控制面 `llm_parse_json` / 下发接口 `llmParse` 对齐 */
export type LlmParseStats = {
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type CommandDetail = {
  command: any;
  events: CommandEvent[];
};

function networkHint(path: string): string {
  const base = getApiBase();
  const lines = [
    `请求地址：${base}${path}`,
    '若用手机访问：浏览器里的 localhost 指向手机本身，必须把控制面填成「运行控制面的那台电脑」的局域网 IP，例如 http://192.168.1.5:8787。',
    '请在 Windows 防火墙中放行 TCP 8787；控制面进程需监听 0.0.0.0（默认已是）。'
  ];
  return lines.join('\n');
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiBase();
  let res: Response;
  try {
    res = await fetch(base + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers ?? {})
      }
    });
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : String(e);
    const hint = networkHint(path);
    throw Object.assign(new Error(`网络请求失败 ${path}\n${msg}\n\n${hint}`), { status: 0, data: {} });
  }

  const bodyText = await res.text();
  let data: any = {};
  if (bodyText) {
    try {
      data = JSON.parse(bodyText) as any;
    } catch {
      data = {
        error: 'non_json_response',
        hint: `HTTP ${res.status}. First bytes: ${bodyText.slice(0, 240).replace(/\s+/g, ' ')}`
      };
    }
  } else if (!res.ok) {
    data = { error: `HTTP_${res.status}`, hint: 'Empty response body' };
  }

  if (!res.ok) {
    const msg =
      typeof data?.hint === 'string' && data.hint.length > 0
        ? `${data.hint} (${data?.error ?? 'error'})`
        : typeof data?.error === 'string' && data.error.length > 0
          ? `${data.error} (HTTP ${res.status})`
          : `Request failed (HTTP ${res.status})`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data as T;
}

export async function register(email: string, password: string) {
  return await json<{ ok: boolean }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function login(email: string, password: string) {
  return await json<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
}

export async function changePassword(token: string, currentPassword: string, newPassword: string) {
  return await json<{ ok: boolean }>('/auth/change-password', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ currentPassword, newPassword })
  });
}

export async function listDevices(token: string) {
  return await json<{ devices: Device[] }>('/devices', { headers: { authorization: `Bearer ${token}` } });
}

export async function claimDevice(token: string, pairingCode: string, deviceName: string) {
  return await json<{ deviceId: string }>('/devices/claim', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ pairingCode, deviceName })
  });
}

export async function revokeDevice(token: string, deviceId: string) {
  return await json<{ ok: boolean }>(`/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({})
  });
}

export type DeviceChatMessage = {
  id: string;
  user_id: string;
  device_id: string;
  role: string;
  content: string;
  command_id: string | null;
  kind: string;
  created_at_ms: number;
  attachment_base64?: string | null;
  /** 解析失败时由控制面写入，供前端展示大模型原始返回 */
  llm_parse_raw?: string | null;
};

/** 与控制面 `DEVICE_CHAT_PAGE_MAX` 对齐 */
const DEVICE_CHAT_PAGE_MAX = 500;

export async function listDeviceChat(token: string, deviceId: string, limit?: number) {
  const q =
    typeof limit === 'number' && Number.isFinite(limit)
      ? `?limit=${Math.min(DEVICE_CHAT_PAGE_MAX, Math.max(1, Math.floor(limit)))}`
      : '';
  return await json<{ messages: DeviceChatMessage[] }>(
    `/devices/${encodeURIComponent(deviceId)}/chat${q}`,
    { headers: { authorization: `Bearer ${token}` } }
  );
}

export type AgentCatalogRow = {
  id: string;
  name: string;
  description: string;
  wallpaper: 'slate' | 'emerald' | 'violet' | 'amber';
};

export async function listAgentChats(token: string) {
  return await json<{ agents: AgentCatalogRow[] }>('/agent-chats', {
    headers: { authorization: `Bearer ${token}` }
  });
}

export async function completeAgentChat(
  token: string,
  agentId: string,
  body: {
    text: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    personaAddon?: string;
  }
) {
  return await json<{ reply: string; llmParse: LlmParseStats | null }>(
    `/agent-chats/${encodeURIComponent(agentId)}/complete`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }
  );
}

export async function completeCustomAgentChat(
  token: string,
  body: {
    displayName: string;
    text: string;
    history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    personaAddon?: string;
  }
) {
  return await json<{ reply: string; llmParse: LlmParseStats | null }>('/agent-chats/custom/complete', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export async function sendCommand(token: string, deviceId: string, text: string) {
  return await json<{
    commandId?: string;
    conversationOnly?: boolean;
    reply?: string;
    interpretation?: string;
    requiresApproval?: boolean;
    llmParse?: LlmParseStats | null;
  }>(`/devices/${encodeURIComponent(deviceId)}/commands`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text })
  });
}

export async function getCommand(token: string, commandId: string) {
  return await json<CommandDetail>(`/commands/${encodeURIComponent(commandId)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
}

export async function approveCommand(token: string, commandId: string) {
  return await json<{ ok: boolean; interpretation?: string; llmParse?: LlmParseStats | null }>(
    `/commands/${encodeURIComponent(commandId)}/approve`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    }
  );
}

export type ParseMode = 'rule' | 'llm' | 'hybrid';
export type LlmProviderId = 'zhipu' | 'openai_compatible' | 'gemini';

export type ParseSettingsResponse = {
  parseMode: ParseMode;
  llmProvider: LlmProviderId;
  llmModel: string;
  llmBaseUrl: string | null;
  hasStoredApiKey: boolean;
  storedApiKeyHint: string | null;
  effectiveHasApiKey: boolean;
  effectiveParseMode: ParseMode;
  updatedAtMs: number | null;
  providerOptions: Array<{ id: LlmProviderId; label: string }>;
};

export async function getParseSettings(token: string) {
  return await json<ParseSettingsResponse>('/me/parse-settings', {
    headers: { authorization: `Bearer ${token}` }
  });
}

export async function putParseSettings(
  token: string,
  body: {
    parseMode: ParseMode;
    llmProvider: LlmProviderId;
    llmModel: string;
    llmBaseUrl?: string | null;
    apiKey?: string;
    clearApiKey?: boolean;
  }
) {
  return await json<{ ok: boolean }>('/me/parse-settings', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
}

export async function testParseSettingsLlm(
  token: string,
  body?: {
    apiKey?: string;
    llmProvider?: LlmProviderId;
    llmModel?: string;
    llmBaseUrl?: string | null;
  }
) {
  const payload: Record<string, unknown> = {};
  if (body?.apiKey?.trim()) payload.apiKey = body.apiKey.trim();
  if (body?.llmProvider) payload.llmProvider = body.llmProvider;
  if (body?.llmModel?.trim()) payload.llmModel = body.llmModel.trim();
  if (body?.llmBaseUrl !== undefined) payload.llmBaseUrl = body.llmBaseUrl;
  return await json<{ ok: boolean }>('/me/parse-settings/test', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
}
