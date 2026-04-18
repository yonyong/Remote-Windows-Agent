import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { z } from 'zod';
import { loadState, saveState } from './state.js';
import { executeCommand } from './executor.js';
const AGENT_SRC_DIR = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(AGENT_SRC_DIR, '..');
const DEFAULT_STATE_FILE = resolve(AGENT_DIR, 'agent-state.json');
const PAIRING_CODE_FILE = resolve(AGENT_DIR, 'pairing-code.txt');
const STATE_PATH = process.env.AGENT_STATE_PATH ?? DEFAULT_STATE_FILE;
function initialStateFile() {
    if (process.env.AGENT_STATE_PATH)
        return STATE_PATH;
    if (existsSync(DEFAULT_STATE_FILE))
        return DEFAULT_STATE_FILE;
    const legacy = resolve(process.cwd(), 'agent-state.json');
    if (existsSync(legacy))
        return legacy;
    return DEFAULT_STATE_FILE;
}
let state = loadState(initialStateFile());
function preferIpv4LoopbackWs(url) {
    try {
        const asHttp = url.replace(/^ws/i, 'http').replace(/^wss/i, 'https');
        const u = new URL(asHttp);
        if (u.hostname.toLowerCase() === 'localhost') {
            u.hostname = '127.0.0.1';
            const back = u.toString().replace(/^http/i, 'ws').replace(/^https/i, 'wss');
            return back;
        }
    }
    catch {
        /* keep original */
    }
    return url;
}
state = { ...state, serverUrl: preferIpv4LoopbackWs(state.serverUrl) };
function newPairingCode() {
    return 'PAIR_' + Math.random().toString(36).slice(2, 8).toUpperCase();
}
function clearStaleDeviceBinding(reason) {
    state = {
        ...state,
        deviceToken: undefined,
        deviceId: undefined,
        pairingCode: newPairingCode()
    };
    saveState(STATE_PATH, state);
    writePairingCodeFile();
    console.warn(`[agent] Cleared saved device binding (${reason}). New pairingCode=${state.pairingCode}`);
}
function writePairingCodeFile() {
    if (state.deviceToken)
        return;
    mkdirSync(AGENT_DIR, { recursive: true });
    const lines = [
        'Copy the line below into the web UI (device pairing field):',
        '',
        state.pairingCode,
        '',
        `File: ${PAIRING_CODE_FILE}`,
        'Delete this file after pairing. It is rewritten while not paired.'
    ];
    writeFileSync(PAIRING_CODE_FILE, lines.join('\r\n'), 'utf8');
}
const serverBase = state.serverUrl.replace(/^http/, 'ws').replace(/\/$/, '');
function agentWsUrl() {
    const u = new URL(serverBase + '/ws/agent');
    if (state.deviceToken)
        u.searchParams.set('deviceToken', state.deviceToken);
    else
        u.searchParams.set('pairingCode', state.pairingCode);
    return u.toString();
}
function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}
function emitEvent(ws, commandId, level, message) {
    send(ws, { type: 'event', commandId, level, message, atMs: Date.now() });
}
function emitScreenshot(ws, commandId, pngBase64) {
    send(ws, { type: 'screenshot', commandId, pngBase64, atMs: Date.now() });
}
function connect() {
    console.log(`[agent] serverUrl=${state.serverUrl}`);
    if (state.deviceToken) {
        console.log('[agent] deviceToken is present: pairing-code.txt is not written. If you reset control-plane DB, the next connection may clear the token automatically.');
    }
    if (!state.deviceToken) {
        writePairingCodeFile();
        console.log('');
        console.log('========== Device pairing code (paste in web UI) ==========');
        console.log(state.pairingCode);
        console.log(`Also written to: ${PAIRING_CODE_FILE}`);
        console.log('===========================================================');
        console.log('');
    }
    if (state.deviceId)
        console.log(`[agent] deviceId=${state.deviceId}`);
    const ws = new WebSocket(agentWsUrl());
    ws.on('open', () => {
        console.log('[agent] connected');
    });
    ws.on('message', async (raw) => {
        const text = raw.toString();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            console.warn('[agent] bad message', text);
            return;
        }
        if (parsed && typeof parsed === 'object' && 'type' in parsed && parsed.type === 'error') {
            const err = parsed.error;
            if (err === 'invalid_device_token') {
                clearStaleDeviceBinding('server rejected deviceToken (DB reset or revoke)');
                ws.close();
                return;
            }
            console.warn('[agent] server error message', parsed);
            return;
        }
        const msg = parsed;
        if (msg.type === 'paired') {
            state = { ...state, deviceToken: msg.deviceToken, deviceId: msg.deviceId };
            saveState(STATE_PATH, state);
            try {
                unlinkSync(PAIRING_CODE_FILE);
            }
            catch {
                /* ignore */
            }
            console.log(`[agent] paired deviceId=${msg.deviceId}. reconnecting with deviceToken...`);
            ws.close();
            return;
        }
        if (msg.type === 'command') {
            const spec = msg.command;
            const commandId = spec.command_id;
            console.log(`[agent] command received ${commandId}`);
            try {
                emitEvent(ws, commandId, 'info', `Starting execution (${spec.steps.length} steps)`);
                await executeCommand({
                    spec,
                    emit: ({ level, message }) => emitEvent(ws, commandId, level, message),
                    emitScreenshot: (b64) => emitScreenshot(ws, commandId, b64)
                });
                send(ws, { type: 'result', commandId, status: 'succeeded', finishedAtMs: Date.now() });
            }
            catch (e) {
                const err = e?.message ? String(e.message) : String(e);
                emitEvent(ws, commandId, 'error', `Execution failed: ${err}`);
                send(ws, { type: 'result', commandId, status: 'failed', finishedAtMs: Date.now(), error: err });
            }
        }
    });
    ws.on('close', () => {
        console.log('[agent] disconnected, retry in 2s');
        setTimeout(connect, 2000);
    });
    ws.on('error', (e) => {
        console.warn('[agent] ws error', e);
    });
}
// Validate persisted state shape
const stateSchema = z.object({
    serverUrl: z.string().min(1),
    pairingCode: z.string().min(1),
    deviceToken: z.string().optional(),
    deviceId: z.string().optional()
});
state = stateSchema.parse(state);
saveState(STATE_PATH, state);
writePairingCodeFile();
connect();
