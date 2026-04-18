export type RiskLevel = 'low' | 'medium' | 'high';

export type Step =
  | { type: 'open_app'; app: string }
  | { type: 'open_url'; url: string }
  | { type: 'type_text'; text: string }
  | { type: 'press_key'; key: string }
  | { type: 'sendkeys'; sequence: string }
  | { type: 'sleep'; ms: number }
  | { type: 'screenshot' }
  | { type: 'notify'; message: string }
  | { type: 'volume'; action: 'up' | 'down' | 'mute' }
  | { type: 'lock_screen' }
  | { type: 'media'; action: 'play_pause' | 'next' | 'prev' }
  | { type: 'show_desktop' };

export type CommandSpec = {
  command_id: string;
  device_id: string;
  created_at_ms: number;
  timeout_ms?: number;
  risk_level?: RiskLevel;
  steps: Step[];
};

export type AgentToServer =
  | { type: 'event'; commandId: string; level: 'info' | 'warn' | 'error'; message: string; atMs: number }
  | { type: 'result'; commandId: string; status: 'succeeded' | 'failed' | 'cancelled'; finishedAtMs: number; error?: string }
  | { type: 'screenshot'; commandId: string; pngBase64: string; atMs: number };

export type ServerToAgent =
  | { type: 'paired'; deviceToken: string; deviceId: string }
  | { type: 'command'; command: CommandSpec }
  | { type: 'error'; error: string };
