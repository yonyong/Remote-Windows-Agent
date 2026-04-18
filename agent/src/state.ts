import { readFileSync, writeFileSync } from 'node:fs';

export type AgentState = {
  serverUrl: string;
  pairingCode: string;
  deviceToken?: string;
  deviceId?: string;
};

const DEFAULT_STATE: AgentState = {
  serverUrl: process.env.CONTROL_PLANE_URL ?? 'ws://127.0.0.1:8787',
  pairingCode: process.env.PAIRING_CODE ?? 'PAIR_' + Math.random().toString(36).slice(2, 8).toUpperCase()
};

export function loadState(path: string): AgentState {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as AgentState;
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(path: string, state: AgentState) {
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

