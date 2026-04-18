import type { AgentCatalogRow } from './api'

const PREFS_KEY = 'rwa_agent_prefs_v1'
const MSGS_KEY = 'rwa_agent_messages_v1'

export type AgentWallpaper = AgentCatalogRow['wallpaper']

export type AgentPrefs = {
  personaAddon?: string
  wallpaper?: AgentWallpaper
}

export function loadAgentPrefs(): Record<string, AgentPrefs> {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return {}
    const o = JSON.parse(raw) as unknown
    if (!o || typeof o !== 'object') return {}
    return o as Record<string, AgentPrefs>
  } catch {
    return {}
  }
}

export function saveAgentPrefs(prefs: Record<string, AgentPrefs>) {
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
}

export type AgentLocalMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  created_at_ms: number
}

export function loadAgentMessages(agentId: string): AgentLocalMessage[] {
  try {
    const raw = localStorage.getItem(MSGS_KEY)
    if (!raw) return []
    const all = JSON.parse(raw) as Record<string, AgentLocalMessage[]>
    const arr = all?.[agentId]
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export function saveAgentMessages(agentId: string, messages: AgentLocalMessage[]) {
  try {
    const raw = localStorage.getItem(MSGS_KEY)
    const all: Record<string, AgentLocalMessage[]> = raw ? (JSON.parse(raw) as Record<string, AgentLocalMessage[]>) : {}
    all[agentId] = messages
    localStorage.setItem(MSGS_KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}
