import { nanoid } from 'nanoid';
import type { CommandSpec, RiskLevel, Step } from './types.js';

const HELP_MESSAGE = [
  '【说明】当前为规则分支命中：仅按关键词与句式匹配生成步骤。若启用 llm/hybrid（环境变量或网页「解析设置」），可按所选厂商大模型生成；帮助类说明为省 token 仍走规则。',
  '',
  '常用示例：',
  '· 截图：截屏 / 截图 / screenshot',
  '· 音量：音量加大、音量减小、静音',
  '· 锁屏：锁屏 / lock',
  '· 显示桌面：显示桌面 / 全部最小化',
  '· 媒体：播放暂停 / 下一曲 / 上一曲',
  '· 打开应用：打开记事本、计算器、画图、任务管理器、cmd、powershell、资源管理器、设置、Edge、Chrome、控制面板、声音设置 等',
  '· 打开网址：打开 https://…',
  '· 输入文字：输入：你好 或 输入「内容」（需目标窗口在前台）',
  '· 计算器算式：打开计算器并输入 1+2（或包含「计算器」与算式）',
  '· 等待：等待 2 秒',
  '· 组合：在记事本里输入 hello',
  '· 不知怎么组织说法：以「求助」或「help 」开头描述你想做的事，会教你可复制的示例指令（需已配置大模型 Key；未配置时也有固定示例）',
  '',
  '出于安全，关机/重启/注销等不会自动执行，仅提示说明。'
].join('\n');

/** 纯规则解析（可先经过 preprocessUserCommand 再传入 text） */
export function parseWithRules(args: {
  deviceId: string;
  text: string;
  nowMs: number;
  commandId?: string;
}): { commandId: string; spec: CommandSpec; interpretation: string } {
  const commandId = args.commandId ?? `cmd_${nanoid(16)}`;
  const raw = args.text.trim();
  const compact = raw.replace(/\s+/g, '');
  const spaced = raw.replace(/\s+/g, ' ');

  let risk: RiskLevel = 'low';
  const steps: Step[] = [];

  const bump = (r: RiskLevel) => {
    if (r === 'high') risk = 'high';
    else if (r === 'medium' && risk === 'low') risk = 'medium';
  };

  const pushScreenshot = () => steps.push({ type: 'screenshot' });

  const refuseDanger = () => {
    steps.push({
      type: 'notify',
      message:
        '出于安全策略：关机、重启、注销、格式化磁盘等系统级危险操作不会通过本 Agent 自动执行。如需远程维护请在目标机器本地操作或使用企业级远程管理方案。'
    });
    bump('high');
    pushScreenshot();
  };

  // --- 1. 帮助 / 能力询问 ---
  if (
    /(有什么功能|哪些功能|能做什么|你会什么|支持什么|怎么用|使用说明|帮助|help|指令列表|命令列表)/i.test(spaced) ||
    /^你有什么功能[？?]?$/i.test(raw)
  ) {
    steps.push({ type: 'notify', message: HELP_MESSAGE });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 2. 明确拒绝的危险意图 ---
  if (
    /(关机|关闭电脑|power\s*off|shutdown|重启|重新启动|reboot|注销|log\s*off|sign\s*out|格式化|格盘|fdisk|diskpart)/i.test(
      spaced
    )
  ) {
    refuseDanger();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 3. 仅截图（无其它动作）---
  if (
    /^(截屏|截图|截个图|截一张图|拍个屏|screen\s*shot|screenshot)[。.!！?？\s]*$/i.test(raw) ||
    (/^(只要|仅|只)(截屏|截图)/.test(spaced) && spaced.length < 24)
  ) {
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 3b. 口语化「看一下桌面」等 → 仅截图 ---
  if (
    /(看看桌面|看下桌面|看一下桌面|当前画面|桌面发我|发张图|发一下截图|给我截个图|帮我截个图)/i.test(spaced) &&
    spaced.length < 36
  ) {
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 4. 打开 URL（整行只有链接时也识别）---
  const urlMatch = raw.match(/https?:\/\/[^\s<>"']{3,2000}/i);
  if (urlMatch) {
    const url = urlMatch[0];
    const soloUrl = /^\s*https?:\/\/[^\s]+\s*$/i.test(raw);
    if (soloUrl || /(打开|访问|跳转|browse|open)/i.test(spaced)) {
      steps.push({ type: 'open_url', url });
      steps.push({ type: 'sleep', ms: 1200 });
      bump('medium');
      pushScreenshot();
      return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
    }
  }

  // --- 4b. 切换到 / 激活 浏览器（无「打开」字样；用 open_app 置前，Chrome 多实例时由系统决定）---
  if (
    /(切换到|切到|换到|激活).{0,14}(浏览器|谷歌浏览器|谷歌|chrome|chromium|edge|微软浏览器|火狐|firefox)/i.test(
      spaced
    ) ||
    /(窗口).{0,6}(切换到|切到|换到|激活).{0,10}(浏览器|谷歌|chrome|edge|火狐|firefox)/i.test(spaced) ||
    /(互动|活动).{0,4}窗口.{0,10}(切换到|切到|换到).{0,10}(浏览器|谷歌|chrome)/i.test(spaced)
  ) {
    let appKey: 'chrome' | 'edge' | 'firefox' = 'edge';
    if (/chrome|chromium|谷歌/.test(spaced)) appKey = 'chrome';
    else if (/firefox|火狐/.test(spaced)) appKey = 'firefox';
    else if (/edge|微软浏览/.test(spaced)) appKey = 'edge';
    steps.push({ type: 'open_app', app: appKey });
    steps.push({ type: 'sleep', ms: 900 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 5. 音量 ---
  if (/(静音|mute)/i.test(spaced) && !/取消静音/.test(spaced)) {
    steps.push({ type: 'volume', action: 'mute' });
    steps.push({ type: 'sleep', ms: 200 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }
  if (/(音量加大|音量调高|声音大一点|调大音量|大点声|大声点|响一点|volume\s*up)/i.test(spaced)) {
    for (let i = 0; i < 5; i++) steps.push({ type: 'volume', action: 'up' });
    steps.push({ type: 'sleep', ms: 200 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }
  if (/(音量减小|音量调低|声音小一点|调小音量|小声点|轻一点|volume\s*down)/i.test(spaced)) {
    for (let i = 0; i < 5; i++) steps.push({ type: 'volume', action: 'down' });
    steps.push({ type: 'sleep', ms: 200 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 6. 锁屏 ---
  if (/(锁屏|锁定屏幕|lock\s*screen|win\s*\+\s*l)/i.test(spaced)) {
    steps.push({ type: 'lock_screen' });
    bump('medium');
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 7. 显示桌面 ---
  if (/(显示桌面|全部最小化|最小化所有|show\s*desktop)/i.test(spaced)) {
    steps.push({ type: 'show_desktop' });
    steps.push({ type: 'sleep', ms: 400 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 8. 媒体键 ---
  if (/(播放.?暂停|暂停播放|继续播放|play\s*pause|media\s*play)/i.test(spaced)) {
    steps.push({ type: 'media', action: 'play_pause' });
    steps.push({ type: 'sleep', ms: 300 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }
  if (/(下一曲|下一首|next\s*track)/i.test(spaced)) {
    steps.push({ type: 'media', action: 'next' });
    steps.push({ type: 'sleep', ms: 300 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }
  if (/(上一曲|上一首|prev(ious)?\s*track)/i.test(spaced)) {
    steps.push({ type: 'media', action: 'prev' });
    steps.push({ type: 'sleep', ms: 300 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 9. 等待 ---
  const waitM = spaced.match(/(?:等待|延时|停顿|sleep)\s*(\d+)\s*(?:秒|s|sec)/i);
  if (waitM) {
    const sec = Math.min(60, Math.max(1, parseInt(waitM[1], 10)));
    steps.push({ type: 'sleep', ms: sec * 1000 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 10. 关闭前台窗口 Alt+F4 ---
  if (/(关闭当前窗口|关闭窗口|alt\s*\+\s*f4|强制关闭)/i.test(spaced)) {
    steps.push({ type: 'sendkeys', sequence: '%{F4}' });
    steps.push({ type: 'sleep', ms: 400 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 11. 单独按键 ---
  if (/(按回车|按下回车|回车键)/i.test(spaced)) {
    steps.push({ type: 'press_key', key: 'ENTER' });
    steps.push({ type: 'sleep', ms: 200 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }
  if (/(按\s*esc|escape)/i.test(spaced)) {
    steps.push({ type: 'press_key', key: 'ESC' });
    steps.push({ type: 'sleep', ms: 200 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }
  if (/(按\s*tab)/i.test(spaced)) {
    steps.push({ type: 'press_key', key: 'TAB' });
    steps.push({ type: 'sleep', ms: 200 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 12. 在 X 里输入 Y ---
  const inAppInput = spaced.match(
    /在\s*(计算器|记事本|画图|cmd|命令提示符|powershell|终端|terminal)\s*(?:里|中)?\s*(?:输入|键入|打入)[:：]?\s*(.+)$/i
  );
  if (inAppInput) {
    const appZh = inAppInput[1];
    const rest = inAppInput[2].trim();
    const typed = extractTypedPayload(rest);
    if (typed) {
      const appKey = mapZhApp(appZh);
      steps.push({ type: 'open_app', app: appKey });
      steps.push({ type: 'sleep', ms: 900 });
      steps.push({ type: 'type_text', text: typed });
      steps.push({ type: 'sleep', ms: 400 });
      pushScreenshot();
      return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
    }
  }

  // --- 13. 打开应用（含计算器算式）---
  const looksCalc = /计算器|calc|calculator/i.test(spaced);
  if (looksCalc) {
    const expr = extractExpression(compact);
    steps.push({ type: 'open_app', app: 'calc' });
    steps.push({ type: 'sleep', ms: 800 });
    if (expr) {
      steps.push({ type: 'type_text', text: `${expr}=` });
      steps.push({ type: 'sleep', ms: 450 });
    }
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  const appHit = matchOpenApp(spaced);
  if (appHit) {
    if (appHit === 'regedit') bump('high');
    steps.push({ type: 'open_app', app: appHit });
    steps.push({ type: 'sleep', ms: 900 });
    const maybeType = extractTrailingTypeText(spaced, raw);
    if (maybeType) {
      steps.push({ type: 'type_text', text: maybeType });
      steps.push({ type: 'sleep', ms: 400 });
    }
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 13b. 超短句 / 口头开应用（不必写「打开」）---
  const implicitApp = matchImplicitApp(raw, spaced);
  if (implicitApp) {
    if (implicitApp === 'regedit') bump('high');
    steps.push({ type: 'open_app', app: implicitApp });
    steps.push({ type: 'sleep', ms: 900 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 14. 仅输入文字 ---
  const onlyType = extractTrailingTypeText(spaced, raw);
  if (onlyType && /(输入|键入|打字|type\b)/i.test(spaced)) {
    steps.push({ type: 'type_text', text: onlyType });
    steps.push({ type: 'sleep', ms: 350 });
    pushScreenshot();
    return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
  }

  // --- 15. 默认：不截屏（避免闲聊或未识别句误触截屏；需要桌面请显式说「截图」）---
  steps.push({
    type: 'notify',
    message:
      '未能把这句话匹配成可执行的远端步骤。请补充「打开、截图、锁屏、输入」等明确操作，或发送记事本、计算器、截图等快捷词。'
  });
  return assembleCommandSpec(commandId, args.deviceId, args.nowMs, risk, steps);
}

export function assembleCommandSpec(
  commandId: string,
  deviceId: string,
  nowMs: number,
  risk: RiskLevel,
  steps: Step[]
): { commandId: string; spec: CommandSpec; interpretation: string } {
  const spec: CommandSpec = {
    command_id: commandId,
    device_id: deviceId,
    created_at_ms: nowMs,
    timeout_ms: 120_000,
    risk_level: risk,
    steps
  };
  return { commandId, spec, interpretation: summarizeSpec(spec) };
}

function summarizeSpec(spec: CommandSpec): string {
  const parts = spec.steps.map(summarizeStep).filter((x): x is string => Boolean(x));
  const uniq = [...new Set(parts)];
  return `${uniq.join(' → ')} · 风险 ${spec.risk_level ?? 'low'}`;
}

function summarizeStep(s: Step): string | null {
  switch (s.type) {
    case 'open_app':
      return `打开「${s.app}」`;
    case 'open_url':
      return '打开链接';
    case 'type_text':
      return `键入（${s.text.length} 字）`;
    case 'press_key':
      return `按键 ${s.key}`;
    case 'sendkeys':
      return '组合键';
    case 'sleep':
      return `等待 ${Math.round(s.ms / 100) / 10}s`;
    case 'screenshot':
      return '截图';
    case 'notify':
      return '提示说明';
    case 'volume':
      return s.action === 'up' ? '音量+' : s.action === 'down' ? '音量−' : '静音';
    case 'lock_screen':
      return '锁屏';
    case 'media':
      return s.action === 'play_pause' ? '播放/暂停' : s.action === 'next' ? '下一曲' : '上一曲';
    case 'show_desktop':
      return '显示桌面';
    default:
      return null;
  }
}

/** 短句、口头前缀，不要求出现「打开」 */
function matchImplicitApp(raw: string, spaced: string): string | null {
  if (/(输入|键入|打字|type\b)/i.test(spaced)) return null;
  if (/(打开|启动|运行|开启|开一下|开下|帮我打开|给我打开)/i.test(spaced)) return null;
  let t = raw.trim().replace(/[。！!？?]+$/g, '');
  t = t.replace(/^(来个|我要|给我|麻烦|帮我|想|要)\s*/i, '').trim();
  if (t.length > 22) return null;
  const k = t.toLowerCase();
  const map: Array<[string, string]> = [
    ['记事本', 'notepad'],
    ['notepad', 'notepad'],
    ['计算器', 'calc'],
    ['calc', 'calc'],
    ['calculator', 'calc'],
    ['画图', 'paint'],
    ['paint', 'paint'],
    ['资源管理器', 'explorer'],
    ['文件管理器', 'explorer'],
    ['此电脑', 'explorer'],
    ['任务管理器', 'taskmgr'],
    ['cmd', 'cmd'],
    ['powershell', 'powershell'],
    ['终端', 'wt'],
    ['设置', 'settings'],
    ['控制面板', 'control'],
    ['edge', 'edge'],
    ['chrome', 'chrome'],
    ['记事簿', 'notepad']
  ];
  for (const [name, app] of map) {
    if (k === name) return app;
  }
  return null;
}

/** 供意图判定：整句是否为「单应用名」类快捷指令（与规则 13b 一致） */
export function looksLikeImplicitAppOnlyCommand(raw: string, spaced: string): boolean {
  return matchImplicitApp(raw, spaced) !== null;
}

function extractExpression(textNoSpaces: string): string | null {
  const m = textNoSpaces.match(/(\d+(?:[+\-*/]\d+)+)/);
  return m?.[1] ?? null;
}

function mapZhApp(zh: string): string {
  const z = zh.toLowerCase();
  if (/计算器/.test(z)) return 'calc';
  if (/记事本/.test(z)) return 'notepad';
  if (/画图/.test(z)) return 'paint';
  if (/cmd|命令提示/.test(z)) return 'cmd';
  if (/powershell|终端|terminal/.test(z)) return 'powershell';
  return 'notepad';
}

function extractTypedPayload(s: string): string | null {
  const m1 = s.match(/^「([^」]{1,500})」/);
  if (m1) return m1[1];
  const m2 = s.match(/^["“]([^"”]{1,500})["”]/);
  if (m2) return m2[1];
  const trimmed = s.trim();
  if (trimmed.length >= 1 && trimmed.length <= 500) return trimmed;
  return null;
}

function extractTrailingTypeText(spaced: string, raw: string): string | null {
  const mA = raw.match(/(?:输入|键入|打字|type)[:：]\s*(.+)$/i);
  if (mA) {
    const inner = mA[1].trim();
    return extractTypedPayload(inner) ?? (inner.length <= 500 ? inner : null);
  }
  const mB = raw.match(/(?:输入|键入)\s*「([^」]+)」/);
  if (mB) return mB[1].slice(0, 500);
  const mC = raw.match(/(?:输入|键入)\s*[""]([^""]+)[""]/);
  if (mC) return mC[1].slice(0, 500);
  return null;
}

function matchOpenApp(spaced: string): string | null {
  const mustOpen = /(帮我|给我)?\s*(打开|启动|运行|开启|开一下|开下)/.test(spaced);
  if (!mustOpen) return null;

  const rules: Array<{ re: RegExp; app: string }> = [
    { re: /(记事本|文本文件|文本文档|txt\s*文件|notepad)/i, app: 'notepad' },
    { re: /(画图|mspaint|paint)/i, app: 'paint' },
    { re: /(资源管理器|文件管理器|此电脑|我的电脑)/i, app: 'explorer' },
    { re: /(任务管理器|task\s*mgr|taskmgr)/i, app: 'taskmgr' },
    { re: /(\bwt\b|windows\s*terminal|终端(?!.*powershell))/i, app: 'wt' },
    { re: /(powershell|ps\s*控制台)/i, app: 'powershell' },
    { re: /(命令提示符|\bcmd\b)/i, app: 'cmd' },
    { re: /(设置|系统设置|ms-settings)/i, app: 'settings' },
    { re: /(控制面板)/i, app: 'control' },
    { re: /(声音设置|录音设备|播放设备|音量设置界面|mmsys)/i, app: 'mmsys' },
    { re: /(网络连接|ncpa)/i, app: 'ncpa' },
    { re: /(注册表|regedit)/i, app: 'regedit' },
    { re: /(截图工具|snipping|snip\s*sketch)/i, app: 'snip' },
    { re: /(写字板|wordpad)/i, app: 'wordpad' },
    { re: /(edge|微软浏览器)/i, app: 'edge' },
    { re: /(chrome|谷歌浏览器)/i, app: 'chrome' },
    { re: /(firefox|火狐)/i, app: 'firefox' },
    { re: /(vscode|visual\s*studio\s*code|代码编辑器)/i, app: 'vscode' },
    { re: /(计算器|calculator|\bcalc\b)/i, app: 'calc' }
  ];

  for (const { re, app } of rules) {
    if (re.test(spaced)) return app;
  }
  return null;
}
