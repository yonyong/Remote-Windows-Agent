const LS = 'rwa_custom_agents_v1'

function newCustomId(): string {
  return `cus_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export type CustomAgentRecord = {
  id: string
  name: string
  created_at_ms: number
}

export function customAgentStorageKey(id: string): string {
  return `custom_${id}`
}

export function loadCustomAgents(): CustomAgentRecord[] {
  try {
    const raw = localStorage.getItem(LS)
    if (!raw) return []
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return []
    return arr.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string') as CustomAgentRecord[]
  } catch {
    return []
  }
}

function saveAll(list: CustomAgentRecord[]) {
  localStorage.setItem(LS, JSON.stringify(list))
}

export function addCustomAgent(name: string): CustomAgentRecord | null {
  const n = name.trim().slice(0, 32)
  if (!n) return null
  const list = loadCustomAgents()
  if (list.some((x) => x.name.toLowerCase() === n.toLowerCase())) return null
  const rec: CustomAgentRecord = { id: newCustomId(), name: n, created_at_ms: Date.now() }
  saveAll([...list, rec])
  return rec
}

export function removeCustomAgent(id: string) {
  const list = loadCustomAgents().filter((x) => x.id !== id)
  saveAll(list)
}
