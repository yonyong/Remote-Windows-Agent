import { readFileSync, writeFileSync } from 'node:fs';
const DEFAULT_STATE = {
    serverUrl: process.env.CONTROL_PLANE_URL ?? 'ws://127.0.0.1:8787',
    pairingCode: process.env.PAIRING_CODE ?? 'PAIR_' + Math.random().toString(36).slice(2, 8).toUpperCase()
};
export function loadState(path) {
    try {
        const raw = readFileSync(path, 'utf8');
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_STATE, ...parsed };
    }
    catch {
        return { ...DEFAULT_STATE };
    }
}
export function saveState(path, state) {
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}
