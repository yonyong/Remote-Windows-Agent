import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  approveCommand,
  claimDevice,
  completeAgentChat,
  completeCustomAgentChat,
  getApiBase,
  getCommand,
  getParseSettings,
  listAgentChats,
  listDeviceChat,
  listDevices,
  login,
  changePassword,
  normalizeControlPlaneBase,
  putParseSettings,
  register,
  revokeDevice,
  sendCommand,
  setApiBase,
  testParseSettingsLlm,
  type AgentCatalogRow,
  type Device,
  type LlmParseStats,
  type LlmProviderId,
  type DeviceChatMessage,
  type ParseMode
} from './api'
import {
  loadAgentMessages,
  loadAgentPrefs,
  saveAgentMessages,
  saveAgentPrefs,
  type AgentLocalMessage,
  type AgentPrefs,
  type AgentWallpaper
} from './agentLocal'
import { addCustomAgent, customAgentStorageKey, loadCustomAgents, removeCustomAgent, type CustomAgentRecord } from './customAgents'
import { groupByLetter, INDEX_LETTERS } from './pinyinGroup'
import './App.css'

const QUICK_COMMANDS: Array<{ label: string; text: string }> = [
  { label: '截图', text: '截图' },
  { label: '锁屏', text: '锁屏' },
  { label: '记事本', text: '记事本' },
  { label: '计算器', text: '计算器' },
  { label: '大声点', text: '大声点' },
  { label: '静音', text: '静音' },
  { label: '显示桌面', text: '显示桌面' }
]

function validateControlPlaneUrl(u: string): string | null {
  const t = u.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/.+/i.test(t)) return '控制面地址需以 http:// 或 https:// 开头，例如 http://192.168.1.5:8787'
  try {
    new URL(normalizeControlPlaneBase(t))
  } catch {
    return '地址格式不正确'
  }
  return null
}

function chatKindLabel(kind: string): string | null {
  if (kind === 'interpretation') return '解析'
  if (kind === 'result') return '执行结果'
  if (kind === 'notice') return '提示'
  if (kind === 'screenshot') return '截图'
  if (kind === 'conversation') return null
  return null
}

function newLocalMsgId(): string {
  return `loc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

const LOGIN_EMAIL_KEY = 'rwa_login_email'

function formatLlmStatsLine(u: LlmParseStats | null | undefined): string | null {
  if (!u || typeof u.durationMs !== 'number') return null
  const bits: string[] = [`耗时 ${u.durationMs}ms`]
  if (typeof u.totalTokens === 'number') bits.push(`tokens 合计 ${u.totalTokens}`)
  else {
    if (typeof u.promptTokens === 'number') bits.push(`prompt ${u.promptTokens}`)
    if (typeof u.completionTokens === 'number') bits.push(`completion ${u.completionTokens}`)
  }
  return `大模型：${bits.join(' · ')}`
}

function DeviceChatFeed(props: {
  chatLoadError: string | null
  chatMessages: DeviceChatMessage[]
  setLightboxSrc: (s: string | null) => void
  setLlmRawModal: (v: { title: string; text: string } | null) => void
}) {
  const { chatLoadError, chatMessages, setLightboxSrc, setLlmRawModal } = props
  return (
    <>
      {chatLoadError ? <div className="wxChatErr">{chatLoadError}</div> : null}
      <div className="wxChatFeed">
        {chatMessages.length === 0 ? (
          <div className="wxChatEmpty">尚无消息。在底部输入指令发送即可；解析与执行结果会出现在对话里。</div>
        ) : null}
        {chatMessages.map((m) => {
          const isUser = m.role === 'user'
          const kind = chatKindLabel(m.kind)
          if (isUser) {
            return (
              <div key={m.id} className="wxMsg wxMsg--user">
                <div className="wxMsgCol">
                  <div className="wxBubble wxBubble--user">{m.content}</div>
                  <div className="wxMeta wxMeta--user">{new Date(m.created_at_ms).toLocaleTimeString()}</div>
                </div>
                <div className="wxAvatar wxAvatar--user" aria-hidden>
                  我
                </div>
              </div>
            )
          }
          const shot =
            m.kind === 'screenshot' && m.attachment_base64 && String(m.attachment_base64).trim().length > 0
              ? `data:image/png;base64,${m.attachment_base64}`
              : null
          const llmRaw = m.llm_parse_raw && String(m.llm_parse_raw).trim() ? String(m.llm_parse_raw) : null
          return (
            <div key={m.id} className="wxMsg wxMsg--assistant">
              <div className="wxAvatar wxAvatar--assistant" aria-hidden>
                助
              </div>
              <div className="wxMsgCol">
                <div className="wxBubble wxBubble--assistant">
                  {shot ? (
                    <>
                      <button
                        type="button"
                        className="wxBubbleShotBtn"
                        title="点击查看大图"
                        aria-label="查看截图大图"
                        onClick={() => setLightboxSrc(shot)}
                      >
                        <img className="wxBubbleShot" alt={m.content || '运行截图'} src={shot} />
                      </button>
                      {m.content ? <div className="wxBubbleShotCaption">{m.content}</div> : null}
                    </>
                  ) : (
                    m.content
                  )}
                </div>
                {llmRaw ? (
                  <div className="wxLlmRawErrRow">
                    <button
                      type="button"
                      className="wxLlmRawErrBtn"
                      aria-label="查看大模型返回内容"
                      title="查看大模型返回内容"
                      onClick={() => setLlmRawModal({ title: '大模型返回内容', text: llmRaw })}
                    >
                      !
                    </button>
                  </div>
                ) : null}
                <div className="wxMeta">
                  {new Date(m.created_at_ms).toLocaleTimeString()}
                  {kind ? ` · ${kind}` : ''}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

function AgentChatFeed(props: { messages: AgentLocalMessage[] }) {
  const { messages } = props
  if (messages.length === 0) {
    return <div className="wxChatEmpty">仅对话，不会操作远程电脑。直接输入开始聊天。</div>
  }
  return (
    <div className="wxChatFeed">
      {messages.map((m) =>
        m.role === 'user' ? (
          <div key={m.id} className="wxMsg wxMsg--user">
            <div className="wxMsgCol">
              <div className="wxBubble wxBubble--user">{m.content}</div>
              <div className="wxMeta wxMeta--user">{new Date(m.created_at_ms).toLocaleTimeString()}</div>
            </div>
            <div className="wxAvatar wxAvatar--user" aria-hidden>
              我
            </div>
          </div>
        ) : (
          <div key={m.id} className="wxMsg wxMsg--assistant">
            <div className="wxAvatar wxAvatar--agent" aria-hidden>
              A
            </div>
            <div className="wxMsgCol">
              <div className="wxBubble wxBubble--assistant wxBubble--agent">{m.content}</div>
              <div className="wxMeta">{new Date(m.created_at_ms).toLocaleTimeString()}</div>
            </div>
          </div>
        )
      )}
    </div>
  )
}

function App() {
  const [apiBaseDraft, setApiBaseDraft] = useState(() => getApiBase())
  const [token, setToken] = useState<string>(() => localStorage.getItem('token') ?? '')
  const authed = Boolean(token)

  const [email, setEmail] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem(LOGIN_EMAIL_KEY) ?? '' : ''
  )
  const [loginEmail, setLoginEmail] = useState(() =>
    typeof window !== 'undefined' ? localStorage.getItem(LOGIN_EMAIL_KEY) ?? '' : ''
  )
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authError, setAuthError] = useState<string | null>(null)

  const [devices, setDevices] = useState<Device[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('')

  const [pairingCode, setPairingCode] = useState('')
  const [deviceName, setDeviceName] = useState('我的设备')

  const [commandText, setCommandText] = useState('')
  const [commandId, setCommandId] = useState<string>('')
  const [commandDetail, setCommandDetail] = useState<any>(null)
  const [commandPollError, setCommandPollError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const [apiNotice, setApiNotice] = useState<string | null>(null)
  const [lastLlmParse, setLastLlmParse] = useState<LlmParseStats | null>(null)
  const [chatMessages, setChatMessages] = useState<DeviceChatMessage[]>([])
  const [chatLoadError, setChatLoadError] = useState<string | null>(null)
  const chatViewportRef = useRef<HTMLDivElement>(null)
  const lastTerminalChatRefreshRef = useRef<string>('')
  const lastScreenshotB64Ref = useRef<string>('')

  const displayedLlmStats = useMemo(() => {
    const raw = commandDetail?.command?.llm_parse_json
    if (typeof raw === 'string' && raw.trim()) {
      try {
        return JSON.parse(raw) as LlmParseStats
      } catch {
        return null
      }
    }
    return lastLlmParse
  }, [commandDetail?.command?.llm_parse_json, lastLlmParse])

  const [parseMode, setParseMode] = useState<ParseMode>('rule')
  const [llmProvider, setLlmProvider] = useState<LlmProviderId>('zhipu')
  const [llmModel, setLlmModel] = useState('glm-4-flash')
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [llmApiKeyDraft, setLlmApiKeyDraft] = useState('')
  const [clearLlmApiKey, setClearLlmApiKey] = useState(false)
  const [parseMeta, setParseMeta] = useState<{
    hasStoredApiKey: boolean
    storedApiKeyHint: string | null
    effectiveHasApiKey: boolean
    providerOptions: Array<{ id: LlmProviderId; label: string }>
  } | null>(null)
  const [parseLoadError, setParseLoadError] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [llmRawModal, setLlmRawModal] = useState<{ title: string; text: string } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  type MainTab = 'wx' | 'contacts' | 'discover' | 'me'
  type ChatSession =
    | { kind: 'device'; deviceId: string }
    | { kind: 'agent'; agentId: string }
    | { kind: 'custom_agent'; localId: string }
  type ContactDetail =
    | { kind: 'builtin_agent'; id: string }
    | { kind: 'custom_agent'; id: string }
    | { kind: 'device'; deviceId: string }
  const [mainTab, setMainTab] = useState<MainTab>('wx')
  const [session, setSession] = useState<ChatSession | null>(null)
  const [contactDetail, setContactDetail] = useState<ContactDetail | null>(null)
  const [agents, setAgents] = useState<AgentCatalogRow[]>([])
  const [customAgents, setCustomAgents] = useState<CustomAgentRecord[]>(() => loadCustomAgents())
  const [addFriendOpen, setAddFriendOpen] = useState(false)
  const [addFriendName, setAddFriendName] = useState('')
  const [addFriendErr, setAddFriendErr] = useState<string | null>(null)
  const [addDeviceOpen, setAddDeviceOpen] = useState(false)

  type MeSubView = 'home' | 'api' | 'parse' | 'model' | 'profile'
  const [meSubView, setMeSubView] = useState<MeSubView>('home')
  type DangerConfirmState =
    | null
    | { kind: 'revoke_device'; deviceId: string; deviceLabel: string; step: 1 | 2 }
    | { kind: 'remove_custom_agent'; localId: string; displayName: string; step: 1 | 2 }
  const [dangerConfirm, setDangerConfirm] = useState<DangerConfirmState>(null)
  const [pwdCurrent, setPwdCurrent] = useState('')
  const [pwdNew, setPwdNew] = useState('')
  const [pwdNew2, setPwdNew2] = useState('')
  const [pwdErr, setPwdErr] = useState<string | null>(null)
  const [pwdBusy, setPwdBusy] = useState(false)
  const [agentPrefs, setAgentPrefs] = useState<Record<string, AgentPrefs>>(() => loadAgentPrefs())
  const [agentThreadMessages, setAgentThreadMessages] = useState<AgentLocalMessage[]>([])
  const [devicePreview, setDevicePreview] = useState<Record<string, { text: string; at: number }>>({})

  type ContactAgentRow =
    | { source: 'builtin'; id: string; name: string; description: string; wallpaper: AgentCatalogRow['wallpaper'] }
    | { source: 'custom'; id: string; name: string }

  const contactAgentRows: ContactAgentRow[] = useMemo(() => {
    const builtins = agents.map((a) => ({
      source: 'builtin' as const,
      id: a.id,
      name: a.name,
      description: a.description,
      wallpaper: a.wallpaper
    }))
    const customs = customAgents.map((c) => ({ source: 'custom' as const, id: c.id, name: c.name }))
    return [...builtins, ...customs]
  }, [agents, customAgents])

  const contactAgentGroups = useMemo(() => groupByLetter(contactAgentRows), [contactAgentRows])
  const railLetters = useMemo(
    () => INDEX_LETTERS.filter((L) => (contactAgentGroups.get(L)?.length ?? 0) > 0),
    [contactAgentGroups]
  )

  useEffect(() => {
    if (!addFriendOpen && !addDeviceOpen && !dangerConfirm) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (dangerConfirm) {
        if (!busy) setDangerConfirm(null)
        return
      }
      if (addFriendOpen) {
        setAddFriendOpen(false)
        setAddFriendName('')
        setAddFriendErr(null)
      }
      if (addDeviceOpen) setAddDeviceOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addFriendOpen, addDeviceOpen, dangerConfirm, busy])

  useEffect(() => {
    localStorage.setItem('token', token)
  }, [token])

  useEffect(() => {
    if (!authed) setApiBaseDraft(getApiBase())
  }, [authed])

  async function refreshDevices() {
    if (!token) return
    try {
      const res = await listDevices(token)
      setDevices(res.devices)
    } catch (e: any) {
      setApiError(e?.message ?? 'Failed to load devices')
    }
  }

  useEffect(() => {
    if (!authed) return
    refreshDevices().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed])

  const refreshChat = useCallback(async () => {
    if (!token || !selectedDeviceId) return
    try {
      const r = await listDeviceChat(token, selectedDeviceId, 500)
      setChatMessages(r.messages)
      setChatLoadError(null)
    } catch (e: any) {
      setChatLoadError(e?.message ?? 'chat_load_failed')
    }
  }, [token, selectedDeviceId])

  useEffect(() => {
    lastTerminalChatRefreshRef.current = ''
    if (!token || !selectedDeviceId) {
      setChatMessages([])
      setChatLoadError(null)
      return
    }
    void refreshChat()
  }, [token, selectedDeviceId, refreshChat])

  useEffect(() => {
    const el = chatViewportRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [chatMessages, agentThreadMessages])

  useEffect(() => {
    const id = commandDetail?.command?.id as string | undefined
    const s = commandDetail?.command?.status as string | undefined
    if (!id || !token || !selectedDeviceId) return
    if (s !== 'succeeded' && s !== 'failed') return
    const sig = `${id}:${s}`
    if (lastTerminalChatRefreshRef.current === sig) return
    lastTerminalChatRefreshRef.current = sig
    void refreshChat()
  }, [commandDetail?.command?.id, commandDetail?.command?.status, token, selectedDeviceId, refreshChat])

  useEffect(() => {
    lastScreenshotB64Ref.current = ''
  }, [commandId])

  useEffect(() => {
    const b64 = commandDetail?.command?.last_screenshot_base64
    if (typeof b64 !== 'string' || !b64.trim() || !token || !selectedDeviceId) return
    if (lastScreenshotB64Ref.current === b64) return
    lastScreenshotB64Ref.current = b64
    void refreshChat()
  }, [commandDetail?.command?.last_screenshot_base64, token, selectedDeviceId, refreshChat])

  async function refreshParseSettings() {
    if (!token) return
    setParseLoadError(null)
    try {
      const s = await getParseSettings(token)
      setParseMode(s.parseMode)
      setLlmProvider(s.llmProvider)
      setLlmModel(s.llmModel)
      setLlmBaseUrl(s.llmBaseUrl ?? '')
      setLlmApiKeyDraft('')
      setClearLlmApiKey(false)
      setParseMeta({
        hasStoredApiKey: s.hasStoredApiKey,
        storedApiKeyHint: s.storedApiKeyHint,
        effectiveHasApiKey: s.effectiveHasApiKey,
        providerOptions: s.providerOptions
      })
    } catch (e: any) {
      setParseLoadError(e?.message ?? 'parse_settings_load_failed')
    }
  }

  useEffect(() => {
    if (!authed) return
    refreshParseSettings().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed])

  useEffect(() => {
    if (mainTab !== 'me') setMeSubView('home')
  }, [mainTab])

  useEffect(() => {
    if (!lightboxSrc) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightboxSrc(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightboxSrc])

  useEffect(() => {
    if (!llmRawModal) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLlmRawModal(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [llmRawModal])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen])

  useEffect(() => {
    if (menuOpen && token) void refreshDevices()
  }, [menuOpen, token])

  useEffect(() => {
    if (!authed || !token) return
    void (async () => {
      try {
        const r = await listAgentChats(token)
        setAgents(r.agents)
      } catch {
        setAgents([])
      }
    })()
  }, [authed, token])

  useEffect(() => {
    if (!session) return
    if (session.kind === 'device') {
      setSelectedDeviceId(session.deviceId)
      return
    }
    setSelectedDeviceId('')
    setCommandId('')
    setCommandDetail(null)
    setCommandPollError(null)
    if (session.kind === 'agent') {
      setAgentThreadMessages(loadAgentMessages(session.agentId))
    } else {
      setAgentThreadMessages(loadAgentMessages(customAgentStorageKey(session.localId)))
    }
  }, [session])

  useEffect(() => {
    setMenuOpen(false)
  }, [session])

  useEffect(() => {
    if (mainTab !== 'contacts') setContactDetail(null)
  }, [mainTab])

  useEffect(() => {
    if (!token || !authed || devices.length === 0) return
    let cancelled = false
    void (async () => {
      const next: Record<string, { text: string; at: number }> = {}
      await Promise.all(
        devices.map(async (d) => {
          try {
            const r = await listDeviceChat(token, d.id, 1)
            const m = r.messages[r.messages.length - 1]
            if (m) next[d.id] = { text: (m.content ?? '').slice(0, 72), at: m.created_at_ms }
          } catch {
            /* skip */
          }
        })
      )
      if (!cancelled) setDevicePreview((prev) => ({ ...prev, ...next }))
    })()
    return () => {
      cancelled = true
    }
  }, [token, authed, devices])

  useEffect(() => {
    if (!token || !commandId) return
    setCommandPollError(null)
    const t = window.setInterval(async () => {
      try {
        const detail = await getCommand(token, commandId)
        setCommandDetail(detail)
      } catch (e: any) {
        setCommandPollError(e?.message ?? 'poll_failed')
      }
    }, 800)
    return () => window.clearInterval(t)
  }, [token, commandId])

  async function handleAuth() {
    setAuthError(null)
    const errUrl = validateControlPlaneUrl(apiBaseDraft)
    if (errUrl) {
      setAuthError(errUrl)
      return
    }
    setApiBase(apiBaseDraft.trim())
    setApiBaseDraft(getApiBase())
    setBusy(true)
    try {
      const emailTrim = email.trim()
      if (authMode === 'register') await register(emailTrim, password)
      const res = await login(emailTrim, password)
      setToken(res.token)
      localStorage.setItem(LOGIN_EMAIL_KEY, emailTrim)
      setLoginEmail(emailTrim)
    } catch (e: any) {
      setAuthError(e?.message ?? 'auth_failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleClaim() {
    setApiError(null)
    setBusy(true)
    try {
      await claimDevice(token, pairingCode.trim(), deviceName.trim() || '我的设备')
      setPairingCode('')
      setDeviceName('我的设备')
      setAddDeviceOpen(false)
      await refreshDevices()
    } catch (e: any) {
      setApiError(e?.message ?? 'claim_failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleSend() {
    if (!selectedDeviceId) return
    setApiError(null)
    setLightboxSrc(null)
    setLastLlmParse(null)
    setBusy(true)
    try {
      const res = await sendCommand(token, selectedDeviceId, commandText)
      if (res.conversationOnly) {
        setCommandId('')
        setCommandDetail(null)
      } else if (res.commandId) {
        setCommandId(res.commandId)
        setCommandDetail(null)
      }
      if (res.llmParse) setLastLlmParse(res.llmParse)
      await refreshChat()
      setCommandText('')
    } catch (e: any) {
      setApiError(e?.message ?? 'send_failed')
    } finally {
      setBusy(false)
    }
  }

  function openRevokeDeviceConfirm(deviceId: string, deviceLabel: string) {
    setDangerConfirm({ kind: 'revoke_device', deviceId, deviceLabel, step: 1 })
  }

  async function runRevokeDevice(deviceId: string): Promise<boolean> {
    setApiError(null)
    setBusy(true)
    try {
      await revokeDevice(token, deviceId)
      await refreshDevices()
      setContactDetail((prev) => (prev?.kind === 'device' && prev.deviceId === deviceId ? null : prev))
      if (session?.kind === 'device' && session.deviceId === deviceId) {
        setSession(null)
        setMenuOpen(false)
      }
      return true
    } catch (e: any) {
      setApiError(e?.message ?? 'revoke_failed')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function finalizeDangerConfirm() {
    if (!dangerConfirm || dangerConfirm.step !== 2) return
    if (dangerConfirm.kind === 'revoke_device') {
      const ok = await runRevokeDevice(dangerConfirm.deviceId)
      if (ok) setDangerConfirm(null)
      return
    }
    removeCustomAgent(dangerConfirm.localId)
    setCustomAgents(loadCustomAgents())
    setMenuOpen(false)
    setSession(null)
    setContactDetail((prev) =>
      prev?.kind === 'custom_agent' && prev.id === dangerConfirm.localId ? null : prev
    )
    setDangerConfirm(null)
  }

  async function saveParseSettingsFromState() {
    setApiError(null)
    setBusy(true)
    try {
      await putParseSettings(token, {
        parseMode,
        llmProvider,
        llmModel: llmModel.trim() || (llmProvider === 'gemini' ? 'gemini-2.0-flash' : 'glm-4-flash'),
        llmBaseUrl: llmBaseUrl.trim() || null,
        apiKey: llmApiKeyDraft.trim() || undefined,
        clearApiKey: clearLlmApiKey || undefined
      })
      await refreshParseSettings()
      setApiNotice('已保存')
      window.setTimeout(() => setApiNotice(null), 2200)
    } catch (e: any) {
      setApiError(e?.message ?? 'parse_settings_save_failed')
    } finally {
      setBusy(false)
    }
  }

  async function submitPasswordChange() {
    setPwdErr(null)
    if (pwdNew.length < 8) {
      setPwdErr('新密码至少 8 位。')
      return
    }
    if (pwdNew !== pwdNew2) {
      setPwdErr('两次输入的新密码不一致。')
      return
    }
    setPwdBusy(true)
    try {
      await changePassword(token, pwdCurrent, pwdNew)
      setPwdCurrent('')
      setPwdNew('')
      setPwdNew2('')
      setApiNotice('密码已更新')
      window.setTimeout(() => setApiNotice(null), 2200)
    } catch (e: any) {
      setPwdErr(e?.message ?? 'change_password_failed')
    } finally {
      setPwdBusy(false)
    }
  }

  async function handleApprove() {
    if (!commandId) return
    setApiError(null)
    setBusy(true)
    try {
      const res = await approveCommand(token, commandId)
      if (res.llmParse) setLastLlmParse(res.llmParse)
      await refreshChat()
    } catch (e: any) {
      setApiError(e?.message ?? 'approve_failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleAgentLikeSend() {
    if (!token || (session?.kind !== 'agent' && session?.kind !== 'custom_agent')) return
    const text = commandText.trim()
    if (!text) return
    const storageKey = session.kind === 'agent' ? session.agentId : customAgentStorageKey(session.localId)
    setApiError(null)
    setBusy(true)
    const now = Date.now()
    const userMsg: AgentLocalMessage = { id: newLocalMsgId(), role: 'user', content: text, created_at_ms: now }
    const hist = [...agentThreadMessages, userMsg].map((m) => ({ role: m.role, content: m.content }))
    setAgentThreadMessages((prev) => [...prev, userMsg])
    setCommandText('')
    try {
      const addon = agentPrefs[storageKey]?.personaAddon?.trim()
      const res =
        session.kind === 'agent'
          ? await completeAgentChat(token, session.agentId, {
              text,
              history: hist.slice(0, -1),
              personaAddon: addon || undefined
            })
          : await completeCustomAgentChat(token, {
              displayName: customAgents.find((c) => c.id === session.localId)?.name ?? '助手',
              text,
              history: hist.slice(0, -1),
              personaAddon: addon || undefined
            })
      const asst: AgentLocalMessage = {
        id: newLocalMsgId(),
        role: 'assistant',
        content: res.reply,
        created_at_ms: Date.now()
      }
      setAgentThreadMessages((prev) => {
        const next = [...prev, asst]
        saveAgentMessages(storageKey, next)
        return next
      })
      if (res.llmParse) setLastLlmParse(res.llmParse)
    } catch (e: any) {
      setApiError(e?.message ?? 'agent_chat_failed')
      setAgentThreadMessages((prev) => {
        const next = prev.filter((m) => m.id !== userMsg.id)
        saveAgentMessages(storageKey, next)
        return next
      })
      setCommandText(text)
    } finally {
      setBusy(false)
    }
  }

  function patchAgentPref(agentId: string, patch: Partial<AgentPrefs>) {
    setAgentPrefs((p) => {
      const n = { ...p, [agentId]: { ...p[agentId], ...patch } }
      saveAgentPrefs(n)
      return n
    })
  }

  if (!authed) {
    return (
      <div className="page wxLoginPage">
        <div className="wxLoginCard">
          <div className="wxLoginMark" aria-hidden="true">
            RWA
          </div>
          <h1 className="wxLoginTitle">{authMode === 'register' ? '注册账号' : '登录'}</h1>
          <p className="wxLoginSub">Remote Windows Agent</p>

          <label className="wxLoginField">
            <span className="wxLoginLabel">{authMode === 'register' ? '邮箱' : '用户名'}</span>
            <input
              className="wxLoginInput"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={authMode === 'register' ? 'you@example.com' : '如 admin 或 admin@qq.com'}
              autoComplete={authMode === 'register' ? 'email' : 'username'}
              inputMode={authMode === 'register' ? 'email' : 'text'}
            />
          </label>

          <label className="wxLoginField">
            <span className="wxLoginLabel">密码</span>
            <input
              className="wxLoginInput"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder={authMode === 'register' ? '至少 8 位' : '密码'}
              autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
            />
          </label>

          <details className="wxLoginMore">
            <summary>网络与 API 地址</summary>
            <p className="wxLoginHint">
              手机访问时请填运行控制面电脑的 IP，例如 <code>http://192.168.1.5:8787</code>；勿用手机上的 localhost。防火墙放行 TCP 8787。
            </p>
            <input
              className="wxLoginInput"
              value={apiBaseDraft}
              onChange={(e) => setApiBaseDraft(e.target.value)}
              placeholder="http://192.168.x.x:8787"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
            />
          </details>

          {authError ? <div className="wxLoginError">{authError}</div> : null}
          {apiNotice ? <div className="wxLoginNotice">{apiNotice}</div> : null}

          <button type="button" className="wxLoginPrimary" disabled={busy} onClick={handleAuth}>
            {busy ? '请稍候…' : authMode === 'register' ? '注册并登录' : '登录'}
          </button>

          <button
            type="button"
            className="wxLoginLinkBtn"
            onClick={() => {
              setAuthMode(authMode === 'login' ? 'register' : 'login')
              setAuthError(null)
            }}
          >
            {authMode === 'login' ? '注册新账号' : '已有账号，去登录'}
          </button>
        </div>
      </div>
    )
  }

  const cmdStatus = commandDetail?.command?.status as string | undefined
  const sessionDevice = session?.kind === 'device' ? devices.find((d) => d.id === session.deviceId) ?? null : null
  const currentAgentDef = session?.kind === 'agent' ? agents.find((a) => a.id === session.agentId) ?? null : null
  const currentCustomAgent =
    session?.kind === 'custom_agent' ? customAgents.find((c) => c.id === session.localId) ?? null : null
  const chatWallpaper =
    session?.kind === 'agent'
      ? agentPrefs[session.agentId]?.wallpaper ?? currentAgentDef?.wallpaper ?? 'slate'
      : session?.kind === 'custom_agent'
        ? agentPrefs[customAgentStorageKey(session.localId)]?.wallpaper ?? 'slate'
        : 'slate'
  const tabTitles: Record<'wx' | 'contacts' | 'discover' | 'me', string> = {
    wx: '消息',
    contacts: '通讯录',
    discover: '发现',
    me: '我'
  }

  return (
    <div className={`page appPage wxAppShell${session ? ' wxAppShell--session' : ''}`}>
      {apiError ? (
        <div className="wxToast" role="alert">
          <span>{apiError}</span>
          <button type="button" className="btn" onClick={() => setApiError(null)}>
            关闭
          </button>
        </div>
      ) : null}

      {session ? (
        <>
          <header className="wxHeader">
            <button
              type="button"
              className="wxHeaderBack"
              aria-label="返回消息列表"
              onClick={() => {
                setSession(null)
                setMenuOpen(false)
              }}
            >
              ‹
            </button>
            <div className="wxHeaderMain">
              <h1 className="wxHeaderTitle">
                {session.kind === 'device'
                  ? sessionDevice?.name ?? '设备'
                  : session.kind === 'agent'
                    ? currentAgentDef?.name ?? 'Agent'
                    : currentCustomAgent?.name ?? 'Agent'}
              </h1>
              {session.kind === 'device' && sessionDevice ? (
                <span
                  className={sessionDevice.online ? 'wxOnlineDot ok' : 'wxOnlineDot'}
                  title={sessionDevice.online ? '设备在线' : '设备离线'}
                />
              ) : null}
            </div>
            <button
              type="button"
              className="wxHeaderMore"
              aria-label="更多"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              ···
            </button>
          </header>

          <main className={`wxChatMain${session.kind !== 'device' ? ` wxChatWall--${chatWallpaper}` : ''}`}>
            <div className="wxChatScroll" ref={chatViewportRef} role="log" aria-label="对话记录">
              {session.kind === 'device' ? (
                <DeviceChatFeed
                  chatLoadError={chatLoadError}
                  chatMessages={chatMessages}
                  setLightboxSrc={setLightboxSrc}
                  setLlmRawModal={setLlmRawModal}
                />
              ) : (
                <AgentChatFeed messages={agentThreadMessages} />
              )}
              {session.kind === 'device' ? (
                <details className="wxExecFold">
                  <summary>快捷填入、解析与执行</summary>
                  <div className="wxExecFoldBody">
                    <div className="wxChipRowMenu chipRow">
                      {QUICK_COMMANDS.map((c) => (
                        <button key={c.label} type="button" className="btn chip" onClick={() => setCommandText(c.text)}>
                          {c.label}
                        </button>
                      ))}
                    </div>
                    {commandDetail?.command?.status === 'needs_approval' ? (
                      <div className="row wrap" style={{ marginTop: 10 }}>
                        <button type="button" className="btn primary" disabled={busy} onClick={handleApprove}>
                          批准执行（高风险）
                        </button>
                      </div>
                    ) : null}
                    {commandId ? <p className="muted small wxMenuHint">当前命令 {commandId}{cmdStatus ? ` · ${cmdStatus}` : ''}</p> : null}
                    {commandPollError ? <div className="error">拉取失败：{commandPollError}</div> : null}
                    {displayedLlmStats && formatLlmStatsLine(displayedLlmStats) ? (
                      <div className="llmStatsBanner" style={{ marginTop: 8 }}>
                        {formatLlmStatsLine(displayedLlmStats)}
                      </div>
                    ) : null}
                    {commandDetail?.command ? (
                      <>
                        {commandDetail.command.last_error ? <div className="error">{commandDetail.command.last_error}</div> : null}
                        {commandDetail.command.last_screenshot_base64 ? (
                          <button
                            type="button"
                            className="shotWrap shotWrap--clickable"
                            title="点击查看大图"
                            aria-label="查看截图大图"
                            onClick={() =>
                              setLightboxSrc(`data:image/png;base64,${commandDetail.command.last_screenshot_base64}`)
                            }
                          >
                            <img
                              className="shot"
                              alt="执行结果截图"
                              src={`data:image/png;base64,${commandDetail.command.last_screenshot_base64}`}
                            />
                          </button>
                        ) : (
                          <div className="muted small">暂无截图</div>
                        )}
                        <div className="events">
                          {(commandDetail.events ?? []).map((e: any, idx: number) => (
                            <div key={idx} className={`evt ${e.level}`}>
                              <span className="ts">{new Date(e.at_ms).toLocaleTimeString()}</span>
                              <span className="msg">{e.message}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : commandId ? (
                      <div className="muted small">正在拉取命令详情…</div>
                    ) : null}
                  </div>
                </details>
              ) : null}
            </div>
          </main>

          <footer className="wxInputBar">
            <textarea
              className="wxInput"
              value={commandText}
              onChange={(e) => setCommandText(e.target.value)}
              rows={1}
              placeholder={session.kind === 'device' ? '发消息…（远程指令）' : '发消息…（仅对话，不控机）'}
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                if (e.shiftKey) return
                if (e.nativeEvent.isComposing) return
                e.preventDefault()
                if (busy) return
                if (session.kind === 'device') void handleSend()
                else void handleAgentLikeSend()
              }}
            />
            <button
              type="button"
              className="wxSend"
              disabled={busy || (session.kind === 'device' ? !selectedDeviceId : false)}
              onClick={() => (session.kind === 'device' ? void handleSend() : void handleAgentLikeSend())}
            >
              发送
            </button>
          </footer>
        </>
      ) : (
        <>
          {!(mainTab === 'contacts' && contactDetail) && !(mainTab === 'me' && meSubView !== 'home') ? (
            <header className="wxHeader">
              <div className="wxHeaderSpacer" aria-hidden="true" />
              <div className="wxHeaderMain">
                <h1 className="wxHeaderTitle">{tabTitles[mainTab]}</h1>
              </div>
              <div className="wxHeaderSpacer" aria-hidden="true" />
            </header>
          ) : null}

          <div className="wxTabBody">
            {mainTab === 'contacts' && contactDetail ? (
              <div className="wxContactDetail">
                <header className="wxHeader">
                  <button
                    type="button"
                    className="wxHeaderBack"
                    aria-label="返回通讯录"
                    onClick={() => setContactDetail(null)}
                  >
                    ‹
                  </button>
                  <div className="wxHeaderMain">
                    <h1 className="wxHeaderTitle">详细资料</h1>
                  </div>
                  <div className="wxHeaderSpacer" aria-hidden="true" />
                </header>
                <div className="wxContactDetailBody">
                  {contactDetail.kind === 'device' ? (
                    (() => {
                      const d = devices.find((x) => x.id === contactDetail.deviceId)
                      if (!d) return <div className="wxChatEmpty">设备不存在</div>
                      return (
                        <>
                          <div className="wxDetailHero">
                            <div className={`wxDetailAvatar wxAv--${d.online ? 'deviceOn' : 'deviceOff'}`}>设</div>
                            <div className="wxDetailNames">
                              <div className="wxDetailTitle">{d.name}</div>
                              <div className="wxDetailSub mono">设备 ID：{d.id}</div>
                              <div className="wxDetailSub">{d.online ? '在线' : '离线'}</div>
                            </div>
                          </div>
                          <div className="wxDetailRows">
                            <div className="wxDetailRow">
                              <span className="wxDetailRowK">类型</span>
                              <span className="wxDetailRowV">远程 Windows 设备</span>
                            </div>
                          </div>
                          <div className="wxDetailActions">
                            <button type="button" className="wxDetailPrimaryBtn" onClick={() => {
                              setSession({ kind: 'device', deviceId: d.id })
                              setContactDetail(null)
                              setMainTab('wx')
                            }}>去聊天</button>
                            <button type="button" className="wxDetailGhostBtn" onClick={() => openRevokeDeviceConfirm(d.id, d.name)}>吊销设备</button>
                          </div>
                        </>
                      )
                    })()
                  ) : null}
                  {contactDetail.kind === 'builtin_agent' ? (
                    (() => {
                      const a = agents.find((x) => x.id === contactDetail.id)
                      if (!a) return <div className="wxChatEmpty">Agent 不存在</div>
                      const av = agentPrefs[a.id]?.wallpaper ?? a.wallpaper
                      return (
                        <>
                          <div className="wxDetailHero">
                            <div className={`wxDetailAvatar wxAv--${av}`}>{a.name.slice(0, 1)}</div>
                            <div className="wxDetailNames">
                              <div className="wxDetailTitle">{a.name}</div>
                              <div className="wxDetailSub mono">内置 Agent · {a.id}</div>
                            </div>
                          </div>
                          <div className="wxDetailRows">
                            <div className="wxDetailRow">
                              <span className="wxDetailRowK">简介</span>
                              <span className="wxDetailRowV">{a.description}</span>
                            </div>
                          </div>
                          <div className="wxDetailActions">
                            <button type="button" className="wxDetailPrimaryBtn" onClick={() => {
                              setSession({ kind: 'agent', agentId: a.id })
                              setContactDetail(null)
                              setMainTab('wx')
                            }}>去聊天</button>
                          </div>
                        </>
                      )
                    })()
                  ) : null}
                  {contactDetail.kind === 'custom_agent' ? (
                    (() => {
                      const c = customAgents.find((x) => x.id === contactDetail.id)
                      if (!c) return <div className="wxChatEmpty">联系人不存在</div>
                      const av = agentPrefs[customAgentStorageKey(c.id)]?.wallpaper ?? 'slate'
                      return (
                        <>
                          <div className="wxDetailHero">
                            <div className={`wxDetailAvatar wxAv--${av}`}>{c.name.slice(0, 1)}</div>
                            <div className="wxDetailNames">
                              <div className="wxDetailTitle">{c.name}</div>
                              <div className="wxDetailSub mono">自定义 Agent</div>
                            </div>
                          </div>
                          <div className="wxDetailRows">
                            <div className="wxDetailRow">
                              <span className="wxDetailRowK">说明</span>
                              <span className="wxDetailRowV">仅对话，不操作电脑；人设可在聊天页右上角「···」中配置。</span>
                            </div>
                          </div>
                          <div className="wxDetailActions">
                            <button type="button" className="wxDetailPrimaryBtn" onClick={() => {
                              setSession({ kind: 'custom_agent', localId: c.id })
                              setContactDetail(null)
                              setMainTab('wx')
                            }}>去聊天</button>
                          </div>
                        </>
                      )
                    })()
                  ) : null}
                </div>
              </div>
            ) : null}

            {mainTab === 'wx' ? (
              <div className="wxSessionListWrap">
                <div className="wxSearchBar">
                  <div className="wxSearchFake">搜索</div>
                </div>
                <div className="wxSessionList">
                  {(() => {
                    type SortRow =
                      | { kind: 'agent'; id: string; at: number }
                      | { kind: 'custom_agent'; id: string; at: number }
                      | { kind: 'device'; id: string; at: number }
                    const rows: SortRow[] = []
                    for (const a of agents) {
                      const last = loadAgentMessages(a.id).at(-1)
                      rows.push({ kind: 'agent', id: a.id, at: last?.created_at_ms ?? 0 })
                    }
                    for (const c of customAgents) {
                      const last = loadAgentMessages(customAgentStorageKey(c.id)).at(-1)
                      rows.push({ kind: 'custom_agent', id: c.id, at: last?.created_at_ms ?? 0 })
                    }
                    for (const d of devices) {
                      const pv = devicePreview[d.id]
                      rows.push({ kind: 'device', id: d.id, at: pv?.at ?? 0 })
                    }
                    rows.sort((a, b) => b.at - a.at)
                    return rows.map((row) => {
                      if (row.kind === 'agent') {
                        const a = agents.find((x) => x.id === row.id)
                        if (!a) return null
                        const last = loadAgentMessages(a.id).at(-1)
                        const av = agentPrefs[a.id]?.wallpaper ?? a.wallpaper
                        const preview = last ? last.content : a.description
                        return (
                          <button key={`a-${a.id}`} type="button" className="wxSessionRow" onClick={() => setSession({ kind: 'agent', agentId: a.id })}>
                            <div className={`wxSessionAvatar wxAv--${av}`}>{a.name.slice(0, 1)}</div>
                            <div className="wxSessionMain">
                              <div className="wxSessionRowTop">
                                <span className="wxSessionTitle">{a.name}</span>
                                <span className="wxSessionTime">
                                  {last ? new Date(last.created_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                </span>
                              </div>
                              <div className="wxSessionSub">{preview}</div>
                            </div>
                          </button>
                        )
                      }
                      if (row.kind === 'custom_agent') {
                        const c = customAgents.find((x) => x.id === row.id)
                        if (!c) return null
                        const key = customAgentStorageKey(c.id)
                        const last = loadAgentMessages(key).at(-1)
                        const av = agentPrefs[key]?.wallpaper ?? 'slate'
                        const preview = last ? last.content : '自定义 Agent · 通讯录添加'
                        return (
                          <button key={`c-${c.id}`} type="button" className="wxSessionRow" onClick={() => setSession({ kind: 'custom_agent', localId: c.id })}>
                            <div className={`wxSessionAvatar wxAv--${av}`}>{c.name.slice(0, 1)}</div>
                            <div className="wxSessionMain">
                              <div className="wxSessionRowTop">
                                <span className="wxSessionTitle">{c.name}</span>
                                <span className="wxSessionTime">
                                  {last ? new Date(last.created_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                                </span>
                              </div>
                              <div className="wxSessionSub">{preview}</div>
                            </div>
                          </button>
                        )
                      }
                      const d = devices.find((x) => x.id === row.id)
                      if (!d) return null
                      const pv = devicePreview[d.id]
                      const preview = pv?.text ?? (d.online ? '在线 · 点击远程对话' : '离线 · 可查看历史')
                      return (
                        <button key={`d-${d.id}`} type="button" className="wxSessionRow" onClick={() => setSession({ kind: 'device', deviceId: d.id })}>
                          <div className={`wxSessionAvatar wxAv--${d.online ? 'deviceOn' : 'deviceOff'}`}>设</div>
                          <div className="wxSessionMain">
                            <div className="wxSessionRowTop">
                              <span className="wxSessionTitle">{d.name}</span>
                              <span className="wxSessionTime">
                                {pv ? new Date(pv.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                              </span>
                            </div>
                            <div className="wxSessionSub">{preview}</div>
                          </div>
                        </button>
                      )
                    })
                  })()}
                  {agents.length === 0 && customAgents.length === 0 && devices.length === 0 ? (
                    <div className="wxChatEmpty" style={{ padding: 24 }}>
                      暂无会话。在「通讯录」可绑定设备或添加 Agent 朋友；内置对话 Agent 由服务器提供。
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {mainTab === 'contacts' && !contactDetail ? (
              <div className="wxTabPane wxContactsMainPane">
                <button
                  type="button"
                  className="wxAddFriendRow"
                  onClick={() => {
                    setAddFriendErr(null)
                    setAddFriendOpen(true)
                  }}
                >
                  <span className="wxAddFriendIcon" aria-hidden>
                    +
                  </span>
                  <span className="wxAddFriendLabel">添加朋友</span>
                </button>

                <button
                  type="button"
                  className="wxAddFriendRow wxAddDeviceRow"
                  onClick={() => setAddDeviceOpen(true)}
                >
                  <span className="wxAddDeviceIcon" aria-hidden>
                    💻
                  </span>
                  <span className="wxAddFriendLabel">添加设备</span>
                </button>

                <div className="wxContactsBlock">
                  <div className="wxContactsBlockTitle">我的设备</div>
                  <div className="wxContactsDeviceList">
                    {devices.length === 0 ? <div className="muted small wxContactsEmptyNote">暂无设备</div> : null}
                    {devices.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className="wxContactsTapRow"
                        onClick={() => setContactDetail({ kind: 'device', deviceId: d.id })}
                      >
                        <div className={`wxSessionAvatar wxAv--${d.online ? 'deviceOn' : 'deviceOff'}`}>设</div>
                        <div className="wxSessionMain">
                          <div className="wxSessionRowTop">
                            <span className="wxSessionTitle">{d.name}</span>
                            {d.online ? <span className="badge ok">在线</span> : <span className="badge">离线</span>}
                          </div>
                          <div className="wxSessionSub mono">{d.id}</div>
                        </div>
                        <span className="wxChev" aria-hidden>
                          ›
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="wxContactsBlock wxContactsBlock--agents">
                  <div className="wxContactsBlockTitle">Agent</div>
                  <div className="wxContactsWithRail">
                    <div className="wxContactsListScroll">
                      {INDEX_LETTERS.map((L) => {
                        const rows = contactAgentGroups.get(L)
                        if (!rows?.length) return null
                        return (
                          <div key={L} id={`wx-idx-${L}`} className="wxAlphaGroup">
                            <div className="wxAlphaLetter">{L}</div>
                            {rows.map((row) => {
                              const av =
                                row.source === 'builtin'
                                  ? (agentPrefs[row.id]?.wallpaper ?? row.wallpaper)
                                  : (agentPrefs[customAgentStorageKey(row.id)]?.wallpaper ?? 'slate')
                              return (
                                <button
                                  key={`${row.source}-${row.id}`}
                                  type="button"
                                  className="wxAlphaRow"
                                  onClick={() =>
                                    setContactDetail(
                                      row.source === 'builtin'
                                        ? { kind: 'builtin_agent', id: row.id }
                                        : { kind: 'custom_agent', id: row.id }
                                    )
                                  }
                                >
                                  <div className={`wxSessionAvatar wxAv--${av}`}>{row.name.slice(0, 1)}</div>
                                  <div className="wxAlphaRowText">
                                    <div className="wxAlphaName">{row.name}</div>
                                    {row.source === 'builtin' ? (
                                      <div className="wxAlphaSub muted small">{row.description}</div>
                                    ) : (
                                      <div className="wxAlphaSub muted small">自定义 Agent</div>
                                    )}
                                  </div>
                                  <span className="wxChev" aria-hidden>
                                    ›
                                  </span>
                                </button>
                              )
                            })}
                          </div>
                        )
                      })}
                    </div>
                    {railLetters.length ? (
                      <aside className="wxPinyinRail" aria-label="按拼音首字母跳转">
                        {railLetters.map((L) => (
                          <button
                            key={L}
                            type="button"
                            className="wxPinyinRailBtn"
                            onClick={() =>
                              document.getElementById(`wx-idx-${L}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                            }
                          >
                            {L}
                          </button>
                        ))}
                      </aside>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {mainTab === 'discover' ? (
              <div className="wxTabPane wxTabPane--pad">
                <p className="wxDiscoverHint">更多能力陆续开放。</p>
              </div>
            ) : null}

            {mainTab === 'me' ? (
              <div className={`wxTabPane wxMePane${meSubView !== 'home' ? ' wxMePane--sub' : ''}`}>
                {meSubView === 'home' ? (
                  <>
                    <div className="wxMeHero">
                      <div className="wxMeAvatar" aria-hidden>
                        {(loginEmail.trim().slice(0, 1) || '用').toUpperCase()}
                      </div>
                      <button
                        type="button"
                        className="wxMeNameBtn"
                        onClick={() => {
                          setPwdErr(null)
                          setMeSubView('profile')
                        }}
                      >
                        {loginEmail.trim() || '账号'}
                      </button>
                      <p className="muted small wxMeNameHint">点击查看资料与修改密码</p>
                    </div>
                    {apiNotice ? <div className="apiNotice wxMeNotice">{apiNotice}</div> : null}
                    <nav className="wxMeMenu" aria-label="设置入口">
                      <button type="button" className="wxMeMenuRow" onClick={() => setMeSubView('api')}>
                        <span>控制面 API</span>
                        <span className="wxChev" aria-hidden>
                          ›
                        </span>
                      </button>
                      <button type="button" className="wxMeMenuRow" onClick={() => setMeSubView('parse')}>
                        <span>解析配置</span>
                        <span className="wxChev" aria-hidden>
                          ›
                        </span>
                      </button>
                      <button type="button" className="wxMeMenuRow" onClick={() => setMeSubView('model')}>
                        <span>模型配置</span>
                        <span className="wxChev" aria-hidden>
                          ›
                        </span>
                      </button>
                    </nav>
                    <section className="wxMeSection wxMeLogoutSection">
                      <button
                        type="button"
                        className="btn danger"
                        style={{ width: '100%' }}
                        onClick={() => {
                          setToken('')
                          localStorage.removeItem(LOGIN_EMAIL_KEY)
                          setLoginEmail('')
                          setEmail('')
                          setDevices([])
                          setSelectedDeviceId('')
                          setSession(null)
                          setMainTab('wx')
                          setCommandId('')
                          setCommandDetail(null)
                          setApiError(null)
                          setLastLlmParse(null)
                          setChatMessages([])
                          setLightboxSrc(null)
                          setLlmRawModal(null)
                          setMenuOpen(false)
                          setMeSubView('home')
                        }}
                      >
                        退出登录
                      </button>
                    </section>
                  </>
                ) : null}

                {meSubView === 'api' ? (
                  <>
                    <header className="wxHeader wxMeInnerHeader">
                      <button type="button" className="wxHeaderBack" aria-label="返回" onClick={() => setMeSubView('home')}>
                        ‹
                      </button>
                      <div className="wxHeaderMain">
                        <h1 className="wxHeaderTitle">控制面 API</h1>
                      </div>
                      <div className="wxHeaderSpacer" aria-hidden="true" />
                    </header>
                    <div className="wxMeSubScroll">
                      <section className="wxMeSection">
                        <p className="muted small">浏览器访问的控制面地址，需与运行控制面的机器一致（手机请填电脑局域网 IP）。</p>
                        <input
                          className="wxLoginInput"
                          value={apiBaseDraft}
                          onChange={(e) => setApiBaseDraft(e.target.value)}
                          placeholder="http://192.168.x.x:8787"
                          autoComplete="off"
                          spellCheck={false}
                          inputMode="url"
                        />
                        <div className="row wrap" style={{ marginTop: 10, gap: 8 }}>
                          <button
                            type="button"
                            className="btn primary"
                            onClick={() => {
                              const err = validateControlPlaneUrl(apiBaseDraft)
                              if (err) {
                                setApiError(err)
                                return
                              }
                              setApiBase(apiBaseDraft.trim())
                              setApiBaseDraft(getApiBase())
                              setApiError(null)
                              setApiNotice('已保存')
                              window.setTimeout(() => setApiNotice(null), 2200)
                            }}
                          >
                            保存地址
                          </button>
                          <span className="muted small">当前：{getApiBase()}</span>
                        </div>
                        {apiNotice ? <div className="apiNotice" style={{ marginTop: 8 }}>{apiNotice}</div> : null}
                      </section>
                    </div>
                  </>
                ) : null}

                {meSubView === 'parse' ? (
                  <>
                    <header className="wxHeader wxMeInnerHeader">
                      <button type="button" className="wxHeaderBack" aria-label="返回" onClick={() => setMeSubView('home')}>
                        ‹
                      </button>
                      <div className="wxHeaderMain">
                        <h1 className="wxHeaderTitle">解析配置</h1>
                      </div>
                      <div className="wxHeaderSpacer" aria-hidden="true" />
                    </header>
                    <div className="wxMeSubScroll">
                      <section className="wxMeSection">
                        <p className="muted small">远程指令如何解析为可执行步骤（规则 / 混合 / 大模型）。保存时会一并提交当前「模型配置」中的选项。</p>
                        {parseLoadError ? <div className="error">{parseLoadError}</div> : null}
                        {apiNotice ? <div className="apiNotice">{apiNotice}</div> : null}
                        <div className="parseStatusLine muted small" style={{ marginTop: 8 }}>
                          {parseMeta ? (
                            <>
                              当前生效：{parseMode === 'rule' ? '仅规则' : parseMode === 'hybrid' ? '混合' : '大模型'}
                              <span aria-hidden="true"> · </span>
                              {parseMeta.effectiveHasApiKey ? <span className="parseStatusOk">密钥就绪</span> : <span className="parseStatusWarn">模型密钥未就绪</span>}
                            </>
                          ) : (
                            '加载中…'
                          )}
                        </div>
                        <label className="field" style={{ marginTop: 14 }}>
                          <div className="label">解析模式</div>
                          <select value={parseMode} onChange={(e) => setParseMode(e.target.value as ParseMode)}>
                            <option value="rule">仅规则</option>
                            <option value="hybrid">混合</option>
                            <option value="llm">大模型</option>
                          </select>
                        </label>
                        <button type="button" className="btn primary" style={{ marginTop: 16 }} disabled={busy} onClick={() => void saveParseSettingsFromState()}>
                          保存解析配置
                        </button>
                      </section>
                    </div>
                  </>
                ) : null}

                {meSubView === 'model' ? (
                  <>
                    <header className="wxHeader wxMeInnerHeader">
                      <button type="button" className="wxHeaderBack" aria-label="返回" onClick={() => setMeSubView('home')}>
                        ‹
                      </button>
                      <div className="wxHeaderMain">
                        <h1 className="wxHeaderTitle">模型配置</h1>
                      </div>
                      <div className="wxHeaderSpacer" aria-hidden="true" />
                    </header>
                    <div className="wxMeSubScroll">
                      <section className="wxMeSection">
                        <p className="muted small">大模型厂商、模型与 API 密钥；用于解析远程指令时的 LLM 调用。</p>
                        {parseLoadError ? <div className="error">{parseLoadError}</div> : null}
                        {apiNotice ? <div className="apiNotice">{apiNotice}</div> : null}
                        <label className="field">
                          <div className="label">API Key</div>
                          <input
                            value={llmApiKeyDraft}
                            onChange={(e) => setLlmApiKeyDraft(e.target.value)}
                            type="password"
                            placeholder="填写后保存"
                            autoComplete="off"
                            spellCheck={false}
                          />
                        </label>
                        {parseMeta ? <div className="muted small" style={{ marginTop: 8 }}>已存密钥：{parseMeta.hasStoredApiKey ? parseMeta.storedApiKeyHint ?? '有' : '无'}</div> : null}
                        <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
                          <button type="button" className="btn primary" disabled={busy} onClick={() => void saveParseSettingsFromState()}>
                            保存
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={busy}
                            onClick={async () => {
                              setApiError(null)
                              setBusy(true)
                              try {
                                await testParseSettingsLlm(token, {
                                  apiKey: llmApiKeyDraft.trim() || undefined,
                                  llmProvider,
                                  llmModel: llmModel.trim() || undefined,
                                  llmBaseUrl: llmProvider === 'gemini' ? undefined : llmBaseUrl.trim() ? llmBaseUrl.trim() : undefined
                                })
                                setApiNotice('连接正常')
                                window.setTimeout(() => setApiNotice(null), 2200)
                              } catch (e: any) {
                                setApiError(e?.message ?? 'llm_test_failed')
                              } finally {
                                setBusy(false)
                              }
                            }}
                          >
                            测试连接
                          </button>
                        </div>
                        <details className="parseNested" style={{ marginTop: 16 }}>
                          <summary>高级选项</summary>
                          <label className="field">
                            <div className="label">厂商</div>
                            <select value={llmProvider} onChange={(e) => setLlmProvider(e.target.value as LlmProviderId)}>
                              {(parseMeta?.providerOptions ?? [
                                { id: 'zhipu' as const, label: '智谱 GLM' },
                                { id: 'openai_compatible' as const, label: 'OpenAI 兼容' },
                                { id: 'gemini' as const, label: 'Gemini' }
                              ]).map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            <div className="label">模型 ID</div>
                            <input
                              value={llmModel}
                              onChange={(e) => setLlmModel(e.target.value)}
                              placeholder={llmProvider === 'gemini' ? 'gemini-2.0-flash' : llmProvider === 'zhipu' ? 'glm-4-flash' : 'gpt-4o-mini'}
                              spellCheck={false}
                              autoComplete="off"
                            />
                          </label>
                          {llmProvider !== 'gemini' ? (
                            <label className="field">
                              <div className="label">API Base URL</div>
                              <input
                                value={llmBaseUrl}
                                onChange={(e) => setLlmBaseUrl(e.target.value)}
                                placeholder={llmProvider === 'zhipu' ? 'https://open.bigmodel.cn/api/paas/v4' : 'https://api.openai.com/v1'}
                                spellCheck={false}
                                autoComplete="off"
                              />
                            </label>
                          ) : null}
                          <div className="parseCheckRow">
                            <input type="checkbox" checked={clearLlmApiKey} onChange={(e) => setClearLlmApiKey(e.target.checked)} id="clearLlmKeyModel" />
                            <label htmlFor="clearLlmKeyModel" className="muted small parseCheckLabel">
                              清除已保存的密钥
                            </label>
                          </div>
                        </details>
                      </section>
                    </div>
                  </>
                ) : null}

                {meSubView === 'profile' ? (
                  <>
                    <header className="wxHeader wxMeInnerHeader">
                      <button type="button" className="wxHeaderBack" aria-label="返回" onClick={() => setMeSubView('home')}>
                        ‹
                      </button>
                      <div className="wxHeaderMain">
                        <h1 className="wxHeaderTitle">账号资料</h1>
                      </div>
                      <div className="wxHeaderSpacer" aria-hidden="true" />
                    </header>
                    <div className="wxMeSubScroll">
                      <section className="wxMeSection">
                        <div className="wxMeProfileCard">
                          <div className="wxMeAvatar wxMeAvatar--lg" aria-hidden>
                            {(loginEmail.trim().slice(0, 1) || '用').toUpperCase()}
                          </div>
                          <div className="wxMeProfileEmail mono">{loginEmail.trim() || '（登录账号）'}</div>
                        </div>
                        <h3 className="wxMeSubTitle">修改密码</h3>
                        <label className="wxModalField">
                          <span>当前密码</span>
                          <input
                            className="wxLoginInput"
                            type="password"
                            value={pwdCurrent}
                            onChange={(e) => {
                              setPwdCurrent(e.target.value)
                              setPwdErr(null)
                            }}
                            autoComplete="current-password"
                          />
                        </label>
                        <label className="wxModalField">
                          <span>新密码（至少 8 位）</span>
                          <input
                            className="wxLoginInput"
                            type="password"
                            value={pwdNew}
                            onChange={(e) => {
                              setPwdNew(e.target.value)
                              setPwdErr(null)
                            }}
                            autoComplete="new-password"
                          />
                        </label>
                        <label className="wxModalField">
                          <span>确认新密码</span>
                          <input
                            className="wxLoginInput"
                            type="password"
                            value={pwdNew2}
                            onChange={(e) => {
                              setPwdNew2(e.target.value)
                              setPwdErr(null)
                            }}
                            autoComplete="new-password"
                          />
                        </label>
                        {pwdErr ? <div className="error wxModalErr">{pwdErr}</div> : null}
                        <button type="button" className="btn primary" style={{ marginTop: 16 }} disabled={pwdBusy} onClick={() => void submitPasswordChange()}>
                          {pwdBusy ? '提交中…' : '更新密码'}
                        </button>
                      </section>
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>

          <nav className="wxTabBar" aria-label="主导航">
            <button type="button" className={`wxTab ${mainTab === 'wx' ? 'wxTab--active' : ''}`} onClick={() => setMainTab('wx')}>
              <span className="wxTabIcon" aria-hidden>
                💬
              </span>
              <span className="wxTabLabel">消息</span>
            </button>
            <button type="button" className={`wxTab ${mainTab === 'contacts' ? 'wxTab--active' : ''}`} onClick={() => setMainTab('contacts')}>
              <span className="wxTabIcon" aria-hidden>
                👥
              </span>
              <span className="wxTabLabel">通讯录</span>
            </button>
            <button type="button" className={`wxTab ${mainTab === 'discover' ? 'wxTab--active' : ''}`} onClick={() => setMainTab('discover')}>
              <span className="wxTabIcon" aria-hidden>
                ✧
              </span>
              <span className="wxTabLabel">发现</span>
            </button>
            <button type="button" className={`wxTab ${mainTab === 'me' ? 'wxTab--active' : ''}`} onClick={() => setMainTab('me')}>
              <span className="wxTabIcon" aria-hidden>
                我
              </span>
              <span className="wxTabLabel">我</span>
            </button>
          </nav>
        </>
      )}

      {menuOpen && session ? (
        <>
          <div className="wxDrawerBackdrop" aria-hidden onClick={() => setMenuOpen(false)} />
          <div
            className="wxDrawerSheet"
            role="dialog"
            aria-modal="true"
            aria-label="会话设置"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="wxDrawerHead">
              <h2>{session.kind === 'device' ? '设备与快捷填入' : 'Agent 外观与人设'}</h2>
              <button type="button" className="btn" onClick={() => setMenuOpen(false)}>
                完成
              </button>
            </div>
            <div className="wxDrawerBody">
              {session.kind === 'device' ? (
                <>
                  <div className="wxDrawerSection">
                    <h3>当前设备</h3>
                    {sessionDevice ? (
                      <div className="wxDrawerDeviceCard">
                        <div className="wxDrawerDeviceTitle">{sessionDevice.name}</div>
                        <div className="mono muted small">{sessionDevice.id}</div>
                        <div className="muted small" style={{ marginTop: 6 }}>
                          {sessionDevice.online ? '当前在线' : '当前离线'}
                        </div>
                      </div>
                    ) : (
                      <p className="muted small">未找到该设备，请返回「通讯录」刷新列表。</p>
                    )}
                  </div>
                  <div className="wxDrawerSection">
                    <h3>快捷填入</h3>
                    <div className="wxChipRowMenu chipRow">
                      {QUICK_COMMANDS.map((c) => (
                        <button
                          key={c.label}
                          type="button"
                          className="btn chip"
                          onClick={() => {
                            setCommandText(c.text)
                            setMenuOpen(false)
                          }}
                        >
                          {c.label}
                        </button>
                      ))}
                    </div>
                    <p className="muted small" style={{ marginTop: 14 }}>
                      大模型解析、控制面地址、绑定设备与退出登录在底部「我」中配置。
                    </p>
                    <details className="composerHelpFold" style={{ marginTop: 12 }}>
                      <summary>规则与示例</summary>
                      <div className="composerHelpBody">
                        <ul>
                          <li>记事本、Edge、截图、锁屏等</li>
                          <li>单独一行 https://… 打开链接</li>
                        </ul>
                      </div>
                    </details>
                  </div>
                </>
              ) : null}

              {session.kind === 'agent' && currentAgentDef ? (
                <div className="wxDrawerSection">
                  <h3>{currentAgentDef.name}</h3>
                  <label className="wxAgentPrefField">
                    <span>聊天背景</span>
                    <select
                      value={agentPrefs[session.agentId]?.wallpaper ?? currentAgentDef.wallpaper}
                      onChange={(e) => patchAgentPref(session.agentId, { wallpaper: e.target.value as AgentWallpaper })}
                    >
                      <option value="slate">墨灰</option>
                      <option value="emerald">松绿</option>
                      <option value="violet">紫罗兰</option>
                      <option value="amber">琥珀</option>
                    </select>
                  </label>
                  <label className="wxAgentPrefField">
                    <span>追加人设 / prompt</span>
                    <textarea
                      rows={4}
                      value={agentPrefs[session.agentId]?.personaAddon ?? ''}
                      onChange={(e) => patchAgentPref(session.agentId, { personaAddon: e.target.value })}
                      placeholder="例如：回答尽量简短；用「你」称呼用户…"
                    />
                  </label>
                  <p className="muted small wxMenuHint">设置保存在本机浏览器；聊天历史也在本机。</p>
                </div>
              ) : null}

              {session.kind === 'custom_agent' && currentCustomAgent ? (
                <div className="wxDrawerSection">
                  <h3>{currentCustomAgent.name}</h3>
                  <label className="wxAgentPrefField">
                    <span>聊天背景</span>
                    <select
                      value={agentPrefs[customAgentStorageKey(session.localId)]?.wallpaper ?? 'slate'}
                      onChange={(e) =>
                        patchAgentPref(customAgentStorageKey(session.localId), { wallpaper: e.target.value as AgentWallpaper })
                      }
                    >
                      <option value="slate">墨灰</option>
                      <option value="emerald">松绿</option>
                      <option value="violet">紫罗兰</option>
                      <option value="amber">琥珀</option>
                    </select>
                  </label>
                  <label className="wxAgentPrefField">
                    <span>追加人设 / prompt</span>
                    <textarea
                      rows={4}
                      value={agentPrefs[customAgentStorageKey(session.localId)]?.personaAddon ?? ''}
                      onChange={(e) =>
                        patchAgentPref(customAgentStorageKey(session.localId), { personaAddon: e.target.value })
                      }
                      placeholder="例如：语气轻松；多用列表回答…"
                    />
                  </label>
                  <p className="muted small wxMenuHint">仅对话，不操作远程电脑。偏好保存在本机。</p>
                  <button
                    type="button"
                    className="btn danger wxDrawerRemoveBtn"
                    onClick={() =>
                      setDangerConfirm({
                        kind: 'remove_custom_agent',
                        localId: session.localId,
                        displayName: currentCustomAgent.name,
                        step: 1
                      })
                    }
                  >
                    从通讯录移除
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {dangerConfirm ? (
        <div className="wxModalBackdrop" role="presentation" onClick={() => !busy && setDangerConfirm(null)}>
          <div
            className="wxModalSheet wxDangerModal"
            role="dialog"
            aria-modal="true"
            aria-label="危险操作确认"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="wxModalHead">
              <span>{dangerConfirm.step === 1 ? '确认操作' : '再次确认'}</span>
              <button type="button" className="wxModalClose" aria-label="关闭" disabled={busy} onClick={() => setDangerConfirm(null)}>
                ×
              </button>
            </div>
            <div className="wxModalBody">
              {dangerConfirm.step === 1 ? (
                <>
                  {dangerConfirm.kind === 'revoke_device' ? (
                    <p className="wxDangerText">
                      第一步：将吊销设备「{dangerConfirm.deviceLabel}」，该设备上的 Agent 将无法使用当前令牌连接控制面。此操作不可撤销。
                    </p>
                  ) : (
                    <p className="wxDangerText">
                      第一步：将「{dangerConfirm.displayName}」从通讯录移除；本地聊天记录仍保留在浏览器中，可稍后自行清理站点数据。
                    </p>
                  )}
                  <div className="wxModalActions">
                    <button type="button" className="btn" disabled={busy} onClick={() => setDangerConfirm(null)}>
                      取消
                    </button>
                    <button type="button" className="btn primary" disabled={busy} onClick={() => setDangerConfirm({ ...dangerConfirm, step: 2 })}>
                      继续
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {dangerConfirm.kind === 'revoke_device' ? (
                    <p className="wxDangerText">第二步：请再次确认，确定要吊销该设备吗？</p>
                  ) : (
                    <p className="wxDangerText">第二步：请再次确认，从通讯录中移除此 Agent？</p>
                  )}
                  <div className="wxModalActions">
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() => setDangerConfirm({ ...dangerConfirm, step: 1 })}
                    >
                      返回上一步
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={busy}
                      onClick={() => void finalizeDangerConfirm()}
                    >
                      {dangerConfirm.kind === 'revoke_device' ? '确定吊销' : '确定移除'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {addFriendOpen ? (
        <div
          className="wxModalBackdrop"
          role="presentation"
          onClick={() => {
            setAddFriendOpen(false)
            setAddFriendName('')
            setAddFriendErr(null)
          }}
        >
          <div
            className="wxModalSheet"
            role="dialog"
            aria-modal="true"
            aria-label="添加朋友"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="wxModalHead">
              <span>添加朋友</span>
              <button
                type="button"
                className="wxModalClose"
                aria-label="关闭"
                onClick={() => {
                  setAddFriendOpen(false)
                  setAddFriendName('')
                  setAddFriendErr(null)
                }}
              >
                ×
              </button>
            </div>
            <div className="wxModalBody">
              <p className="muted small">输入要加入通讯录的 Agent 显示名称（最多 32 字）。</p>
              <input
                className="wxLoginInput"
                value={addFriendName}
                onChange={(e) => {
                  setAddFriendName(e.target.value)
                  setAddFriendErr(null)
                }}
                placeholder="例如：写作助手"
                maxLength={40}
                autoFocus
                autoComplete="off"
              />
              {addFriendErr ? <div className="error wxModalErr">{addFriendErr}</div> : null}
              <div className="wxModalActions">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setAddFriendOpen(false)
                    setAddFriendName('')
                    setAddFriendErr(null)
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    const rec = addCustomAgent(addFriendName)
                    if (!rec) {
                      setAddFriendErr('名称无效、与已有联系人重名，或未填写。')
                      return
                    }
                    setCustomAgents(loadCustomAgents())
                    setAddFriendOpen(false)
                    setAddFriendName('')
                    setAddFriendErr(null)
                  }}
                >
                  添加
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {addDeviceOpen ? (
        <div
          className="wxModalBackdrop"
          role="presentation"
          onClick={() => setAddDeviceOpen(false)}
        >
          <div
            className="wxModalSheet"
            role="dialog"
            aria-modal="true"
            aria-label="添加设备"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="wxModalHead">
              <span>添加设备</span>
              <button type="button" className="wxModalClose" aria-label="关闭" onClick={() => setAddDeviceOpen(false)}>
                ×
              </button>
            </div>
            <div className="wxModalBody">
              <p className="muted small">填写配对码与设备名称，绑定远程 Windows 设备。</p>
              <label className="wxModalField">
                <span>配对码</span>
                <input
                  className="wxLoginInput"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                  placeholder="PAIR_XXXXXX"
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <label className="wxModalField">
                <span>设备名称</span>
                <input
                  className="wxLoginInput"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="我的设备"
                  autoComplete="off"
                />
              </label>
              <details className="helpDetails wxHelpTight" style={{ marginTop: 12 }}>
                <summary>配对说明</summary>
                <div className="helpBody muted small">
                  配对码见 Agent 终端或 <code>agent/pairing-code.txt</code>。重新配对请删除 <code>agent/agent-state.json</code> 后重启 Agent。
                </div>
              </details>
              <div className="wxModalActions">
                <button type="button" className="btn" onClick={() => setAddDeviceOpen(false)}>
                  取消
                </button>
                <button type="button" className="btn primary" disabled={busy || !pairingCode.trim()} onClick={() => void handleClaim()}>
                  绑定
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {lightboxSrc ? (
        <div
          className="lightbox"
          role="presentation"
          onClick={() => setLightboxSrc(null)}
        >
          <div
            className="lightboxInner"
            role="dialog"
            aria-modal="true"
            aria-label="截图大图"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="lightboxClose" aria-label="关闭" onClick={() => setLightboxSrc(null)}>
              ×
            </button>
            <img src={lightboxSrc} alt="执行结果截图（大图）" />
          </div>
        </div>
      ) : null}

      {llmRawModal ? (
        <div className="rawTextModal" role="presentation" onClick={() => setLlmRawModal(null)}>
          <div
            className="rawTextModalInner"
            role="dialog"
            aria-modal="true"
            aria-label={llmRawModal.title}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="rawTextModalHead">
              <span>{llmRawModal.title}</span>
              <button type="button" className="rawTextModalClose" aria-label="关闭" onClick={() => setLlmRawModal(null)}>
                ×
              </button>
            </div>
            <pre className="rawTextModalBody">{llmRawModal.text}</pre>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
