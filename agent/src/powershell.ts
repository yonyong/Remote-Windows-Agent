import { spawn } from 'node:child_process';

/** `-Sta`：与 System.Windows.Forms 剪贴板/SendKeys 兼容（中文 IME 场景依赖）。 */
const PS_PREFIX = ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass'] as const;

export async function runPowerShell(script: string, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const ps = spawn('powershell', [...PS_PREFIX, '-Command', script], {
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {}
      resolve({ stdout, stderr: stderr + '\nTIMEOUT', code: null });
    }, timeoutMs);

    ps.stdout.on('data', (d) => (stdout += d.toString()));
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

export function psEscapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}

/** 执行本地 .ps1（用于较长脚本，避免命令行长度限制）。 */
export async function runPowerShellFile(scriptPath: string, timeoutMs = 60_000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const ps = spawn('powershell', [...PS_PREFIX, '-File', scriptPath], {
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        ps.kill();
      } catch {}
      resolve({ stdout, stderr: stderr + '\nTIMEOUT', code: null });
    }, timeoutMs);

    ps.stdout.on('data', (d) => (stdout += d.toString()));
    ps.stderr.on('data', (d) => (stderr += d.toString()));
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ps.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

