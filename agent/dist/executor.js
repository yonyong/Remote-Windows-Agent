import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { psEscapeSingleQuoted, runPowerShell, runPowerShellFile } from './powershell.js';
/** 浏览器：优先激活已有窗口，避免 Start-Process 再开一个新实例 */
const BROWSER_FOCUS_KEYS = new Set(['chrome', 'edge', 'firefox']);
const BROWSER_PS_PROCESS = {
    chrome: 'chrome',
    edge: 'msedge',
    firefox: 'firefox'
};
const APP_LAUNCH = {
    calc: 'calc.exe',
    notepad: 'notepad.exe',
    explorer: 'explorer.exe',
    cmd: 'cmd.exe',
    powershell: 'powershell.exe',
    wt: 'wt.exe',
    settings: 'ms-settings:',
    edge: 'msedge',
    chrome: 'chrome',
    firefox: 'firefox',
    vscode: 'code',
    paint: 'mspaint.exe',
    taskmgr: 'taskmgr.exe',
    control: 'control.exe',
    mmsys: 'mmsys.cpl',
    ncpa: 'ncpa.cpl',
    regedit: 'regedit.exe',
    snip: 'SnippingTool.exe',
    wordpad: 'write.exe'
};
async function activateBrowserOrStart(key, launchArg, emit) {
    const proc = BROWSER_PS_PROCESS[key];
    if (!proc)
        return;
    const safeProc = proc.replace(/'/g, "''");
    const safeLaunch = launchArg.replace(/'/g, "''");
    const ps = [
        '$ErrorActionPreference = "SilentlyContinue"',
        'Add-Type @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class RwaFg {',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
        '}',
        '"@',
        `$p = Get-Process '${safeProc}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Sort-Object { $t = $_.MainWindowTitle; if ($null -eq $t) { 0 } else { $t.Length } } -Descending | Select-Object -First 1`,
        'if ($null -ne $p) {',
        '  [void][RwaFg]::ShowWindowAsync($p.MainWindowHandle, 9)',
        '  [void][RwaFg]::SetForegroundWindow($p.MainWindowHandle)',
        "  Write-Output 'RWA_ACTIVATED'",
        '} else {',
        `  Start-Process -FilePath '${safeLaunch}'`,
        "  Write-Output 'RWA_LAUNCHED'",
        '}'
    ].join('\r\n');
    const { stdout, stderr, code } = await runPowerShell(ps, 45_000);
    const out = (stdout + stderr).trim();
    if (code !== 0) {
        emit({ level: 'warn', message: `Browser focus/launch returned code ${code}: ${out.slice(0, 200)}` });
        return;
    }
    if (out.includes('RWA_ACTIVATED')) {
        emit({ level: 'info', message: `已切换到已运行的 ${key} 窗口` });
    }
    else {
        emit({ level: 'info', message: `未检测到 ${key} 主窗口，已启动进程` });
    }
}
export async function executeCommand(args) {
    for (const step of args.spec.steps) {
        await executeStep(step, args.emit, args.emitScreenshot);
    }
}
/**
 * 整桌虚拟屏 PNG Base64（多显示器 + 任务栏）。
 * 不用 PrimaryScreen.Bounds：高 DPI / 多屏时易只截到一块逻辑区域；改用 VirtualScreen + DPI 感知。
 */
export async function capturePrimaryScreenPngBase64() {
    const dpiCs = 'using System;using System.Runtime.InteropServices;public static class RwaDpi{' +
        '[DllImport("user32.dll",SetLastError=true)]public static extern bool SetProcessDpiAwarenessContext(IntPtr c);' +
        'public static readonly IntPtr V2=(IntPtr)(-4);' +
        '[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}';
    const ps = [
        `Add-Type -TypeDefinition '${dpiCs.replace(/'/g, "''")}'`,
        'try { [void][RwaDpi]::SetProcessDpiAwarenessContext([RwaDpi]::V2) } catch { try { [void][RwaDpi]::SetProcessDPIAware() } catch {} }',
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        'Add-Type -AssemblyName System.Drawing | Out-Null',
        '$v = [System.Windows.Forms.SystemInformation]::VirtualScreen',
        '$w = [int]$v.Width; $h = [int]$v.Height',
        'if ($w -lt 1 -or $h -lt 1) { throw "bad_virtual_screen" }',
        '$bmp = New-Object System.Drawing.Bitmap $w, $h',
        '$g = [System.Drawing.Graphics]::FromImage($bmp)',
        '$src = New-Object System.Drawing.Point([int]$v.X, [int]$v.Y)',
        '$g.CopyFromScreen($src, [System.Drawing.Point]::Empty, (New-Object System.Drawing.Size $w, $h))',
        '$ms = New-Object System.IO.MemoryStream',
        '$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
        '$g.Dispose(); $bmp.Dispose();',
        '[Convert]::ToBase64String($ms.ToArray())'
    ].join('; ');
    const { stdout, code } = await runPowerShell(ps, 60_000);
    if (code !== 0)
        return null;
    const b64 = stdout.trim();
    return b64 || null;
}
async function executeStep(step, emit, emitScreenshot) {
    if (step.type === 'sleep') {
        await new Promise((r) => setTimeout(r, step.ms));
        return;
    }
    if (step.type === 'notify') {
        emit({ level: 'info', message: step.message });
        return;
    }
    if (step.type === 'open_app') {
        const key = step.app.toLowerCase();
        const target = APP_LAUNCH[key];
        if (!target) {
            emit({ level: 'warn', message: `Unknown app key "${step.app}" (skipped)` });
            return;
        }
        if (BROWSER_FOCUS_KEYS.has(key) && !target.endsWith(':') && !target.endsWith('.cpl')) {
            emit({ level: 'info', message: `Browser ${key}: try focus existing window, else Start-Process` });
            await activateBrowserOrStart(key, target, emit);
            return;
        }
        emit({ level: 'info', message: `Starting app: ${key} -> ${target}` });
        if (target.endsWith(':')) {
            await runPowerShell(`Start-Process '${target.replace(/'/g, "''")}'`);
        }
        else if (target.endsWith('.cpl')) {
            const cpl = psEscapeSingleQuoted(target);
            await runPowerShell(`Start-Process -FilePath '${cpl}'`);
        }
        else {
            const t = psEscapeSingleQuoted(target);
            await runPowerShell(`Start-Process -FilePath '${t}'`);
        }
        return;
    }
    if (step.type === 'open_url') {
        const u = step.url.trim();
        if (!/^https?:\/\//i.test(u)) {
            emit({ level: 'warn', message: 'open_url rejected (only http/https)' });
            return;
        }
        const safe = psEscapeSingleQuoted(u);
        emit({ level: 'info', message: `Opening URL in default browser: ${u}` });
        await runPowerShell(`Start-Process '${safe}'`);
        return;
    }
    if (step.type === 'type_text') {
        await typeTextImeFriendly(step.text, emit);
        return;
    }
    if (step.type === 'sendkeys') {
        const seq = psEscapeSingleQuoted(step.sequence);
        emit({ level: 'info', message: `SendKeys: ${step.sequence}` });
        await runPowerShell(['Add-Type -AssemblyName System.Windows.Forms | Out-Null', `[System.Windows.Forms.SendKeys]::SendWait('${seq}')`].join('; '));
        return;
    }
    if (step.type === 'press_key') {
        const token = normalizePressKey(step.key);
        emit({ level: 'info', message: `Press key: ${step.key} -> ${token}` });
        const escaped = psEscapeSingleQuoted(token);
        await runPowerShell(['Add-Type -AssemblyName System.Windows.Forms | Out-Null', `[System.Windows.Forms.SendKeys]::SendWait('${escaped}')`].join('; '));
        return;
    }
    if (step.type === 'volume') {
        const vk = step.action === 'up' ? '0xAF' : step.action === 'down' ? '0xAE' : step.action === 'mute' ? '0xAD' : null;
        if (!vk)
            return;
        emit({ level: 'info', message: `Volume: ${step.action}` });
        await tapVirtualKey(vk);
        return;
    }
    if (step.type === 'media') {
        const vk = step.action === 'next' ? '0xB0' : step.action === 'prev' ? '0xB1' : step.action === 'play_pause' ? '0xB3' : null;
        if (!vk)
            return;
        emit({ level: 'info', message: `Media key: ${step.action}` });
        await tapVirtualKey(vk);
        return;
    }
    if (step.type === 'lock_screen') {
        emit({ level: 'info', message: 'Locking workstation' });
        await runPowerShell(`rundll32.exe user32.dll,LockWorkStation`);
        return;
    }
    if (step.type === 'show_desktop') {
        emit({ level: 'info', message: 'Show desktop (Shell.Application.MinimizeAll)' });
        await runPowerShell(`(New-Object -ComObject Shell.Application).MinimizeAll()`);
        return;
    }
    if (step.type === 'screenshot') {
        emit({ level: 'info', message: 'Taking screenshot' });
        const b64 = await capturePrimaryScreenPngBase64();
        if (b64)
            emitScreenshot(b64);
        return;
    }
}
function normalizePressKey(key) {
    const k = key.trim().toUpperCase();
    const named = {
        ENTER: '{ENTER}',
        RETURN: '{ENTER}',
        TAB: '{TAB}',
        ESC: '{ESC}',
        ESCAPE: '{ESC}',
        BACKSPACE: '{BACKSPACE}',
        BS: '{BACKSPACE}',
        SPACE: ' ',
        UP: '{UP}',
        DOWN: '{DOWN}',
        LEFT: '{LEFT}',
        RIGHT: '{RIGHT}',
        HOME: '{HOME}',
        END: '{END}',
        PGUP: '{PGUP}',
        PAGEUP: '{PGUP}',
        PGDN: '{PGDN}',
        PAGEDOWN: '{PGDN}',
        DELETE: '{DELETE}',
        INS: '{INSERT}',
        INSERT: '{INSERT}',
        F1: '{F1}',
        F2: '{F2}',
        F3: '{F3}',
        F4: '{F4}',
        F5: '{F5}',
        F6: '{F6}',
        F7: '{F7}',
        F8: '{F8}',
        F9: '{F9}',
        F10: '{F10}',
        F11: '{F11}',
        F12: '{F12}'
    };
    if (named[k])
        return named[k];
    const m = /^F(\d{1,2})$/i.exec(k);
    if (m)
        return `{F${m[1]}}`;
    if (k.length === 1)
        return k;
    return `{${k}}`;
}
/**
 * 通过剪贴板 + Ctrl+V 注入文本，避免中文输入法 composition 吞掉 SendKeys 逐键输入。
 * 会短暂改写系统剪贴板并尽量恢复。
 */
async function typeTextImeFriendly(text, emit) {
    if (!text)
        return;
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const ps1 = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Windows.Forms',
        `$b64 = @'
${b64}
'@`,
        '$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64.Trim()))',
        '$prev = $null',
        'try { $prev = [Windows.Forms.Clipboard]::GetText([Windows.Forms.TextDataFormat]::UnicodeText) } catch {}',
        '[Windows.Forms.Clipboard]::SetText($t, [Windows.Forms.TextDataFormat]::UnicodeText)',
        '[Windows.Forms.SendKeys]::SendWait("^v")',
        'Start-Sleep -Milliseconds 160',
        'try { if ($null -ne $prev) { [Windows.Forms.Clipboard]::SetText($prev, [Windows.Forms.TextDataFormat]::UnicodeText) } } catch {}'
    ].join('\r\n');
    const tmp = join(tmpdir(), `rwa-type-${randomBytes(10).toString('hex')}.ps1`);
    await writeFile(tmp, `\uFEFF${ps1}`, 'utf8');
    emit({
        level: 'info',
        message: `Typing text (${text.length} chars, clipboard+Ctrl+V for IME)`
    });
    try {
        const { stderr, code } = await runPowerShellFile(tmp, 45_000);
        if (code !== 0 && stderr.trim()) {
            emit({ level: 'warn', message: `Clipboard typing stderr: ${stderr.slice(0, 400)}` });
        }
    }
    finally {
        await unlink(tmp).catch(() => { });
    }
}
async function tapVirtualKey(vkHex) {
    const ps = [
        `Add-Type -TypeDefinition @'`,
        `using System;`,
        `using System.Runtime.InteropServices;`,
        `public class K {`,
        ` [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);`,
        `}`,
        `'@`,
        `$KEYEVENTF_KEYUP = 2`,
        `$vk = [byte]${vkHex}`,
        `[K]::keybd_event($vk,0,0,[UIntPtr]::Zero)`,
        `Start-Sleep -Milliseconds 45`,
        `[K]::keybd_event($vk,0,$KEYEVENTF_KEYUP,[UIntPtr]::Zero)`
    ].join('\r\n');
    await runPowerShell(ps);
}
