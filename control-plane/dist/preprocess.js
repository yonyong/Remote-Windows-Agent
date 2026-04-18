import { looksLikeImplicitAppOnlyCommand } from './commandParser.js';
const FILLER_LEAD = /^(请|麻烦|帮我|能不能|是否可以|可否|想请你|辛苦你|劳烦|能否)([，,\s]+)?/g;
const FILLER_TAIL = /([，,\s]+)?(谢谢|感谢|多谢|麻烦了|辛苦啦)([。.!！?？\s]*)$/gi;
const EXTRA_SPACES = /\s{2,}/g;
/** 全角 ASCII 与常见全角符号转半角（仅常见区间） */
function toHalfWidthAscii(s) {
    return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, ' ');
}
/**
 * @param raw 原始用户输入
 * @param maxForLlm 送入大模型的最大字符数（超长截断，省 token）
 */
export function preprocessUserCommand(raw, maxForLlm = 900) {
    let t = raw.trim();
    let trimmedFiller = false;
    if (!t) {
        return { normalized: '', compact: '', spaced: '', trimmedFiller: false, truncated: false };
    }
    try {
        t = t.normalize('NFKC');
    }
    catch {
        /* ignore */
    }
    t = toHalfWidthAscii(t);
    const beforeFill = t;
    t = t.replace(FILLER_LEAD, '').trim();
    t = t.replace(FILLER_TAIL, '').trim();
    if (t !== beforeFill)
        trimmedFiller = true;
    t = t.replace(EXTRA_SPACES, ' ').trim();
    let truncated = false;
    if (t.length > maxForLlm) {
        t = t.slice(0, maxForLlm);
        truncated = true;
    }
    const spaced = t.replace(/\s+/g, ' ').trim();
    const compact = spaced.replace(/\s+/g, '');
    return {
        normalized: spaced,
        compact,
        spaced,
        trimmedFiller,
        truncated
    };
}
/** 命中时无需调用 GLM：固定走规则即可（省 token + 行为确定） */
export function shouldSkipLlmForCheapRules(spaced) {
    if (!spaced)
        return true;
    if (/(有什么功能|哪些功能|能做什么|你会什么|支持什么|怎么用|使用说明|帮助|help|指令列表|命令列表)/i.test(spaced) ||
        /^你有什么功能[？?]?$/i.test(spaced)) {
        return true;
    }
    if (/(关机|关闭电脑|power\s*off|shutdown|重启|重新启动|reboot|注销|log\s*off|sign\s*out|格式化|格盘|fdisk|diskpart)/i.test(spaced)) {
        return true;
    }
    if (/^(截屏|截图|截个图|截一张图|拍个屏|screen\s*shot|screenshot)[。.!！?？\s]*$/i.test(spaced) ||
        (/^(只要|仅|只)(截屏|截图)/.test(spaced) && spaced.length < 28)) {
        return true;
    }
    return false;
}
/** 若用户指「当前/活动/前台」窗口，给大模型追加短附注（不写入聊天记录） */
const FOREGROUND_CUE = /(当前窗口|活动窗口|前台窗口|前台应用|当前应用|这个窗口|这个程序|这款软件|当前界面|正在用的|焦点窗口|当前页|当前软件|当前打开的)/;
export function augmentLlmUserTextForForegroundHint(spaced) {
    if (!spaced || !FOREGROUND_CUE.test(spaced))
        return spaced;
    return `${spaced}\n\n[系统附注：用户指对当前前台活动窗口/应用操作；请生成针对已聚焦应用界面的步骤，勿无故新开无关程序。]`;
}
/** 明确「操控电脑」类动词/句式（否则在 llm/hybrid 下按闲聊处理；帮助/危险/纯截图等仍由 shouldSkipLlmForCheapRules 优先走规则） */
const OP_VERB = /(?:打开|开启|启动|运行|执行|操作|点击|双击|右键|长按|按下|松开|切换|切到|换到|切回|关闭|关掉|退出|最小化|最大化|全屏|还原|锁屏|截图|截屏|截个图|拍屏|拍照|静音|大声|小声|音量|调大|调小|调亮|调暗|亮度|滚动|拖拽|滑动|输入|键入|打字|粘贴|复制|剪切|全选|撤销|重做|保存|搜索|查找|播放|暂停|继续|下一曲|上一曲|快进|快退|显示桌面|回到桌面|息屏|唤醒|休眠|睡眠|等待|关机|重启|注销)/i;
const OP_IN_APP = /在\s*(计算器|记事本|画图|cmd|命令提示符|powershell|终端|terminal)\s*(?:里|中)?\s*(?:输入|键入|打入|打字)/i;
/**
 * 用户是否在表达「要在这台电脑上做事」：默认 false；仅命中操控语义、单应用快捷词、链接或典型算式场景时为 true。
 */
export function isExplicitRemoteOperationIntent(spaced, rawTrimmed) {
    if (!spaced)
        return false;
    if (looksLikeImplicitAppOnlyCommand(rawTrimmed, spaced))
        return true;
    if (/^https?:\/\//i.test(spaced))
        return true;
    if (/\bwww\.\S+/i.test(spaced))
        return true;
    if (OP_IN_APP.test(spaced))
        return true;
    if (/等待\s*\d/.test(spaced))
        return true;
    const compact = spaced.replace(/\s+/g, '');
    if (/(计算器|calc)/i.test(spaced) && /[+\-*/=（(]?\d/.test(compact))
        return true;
    if (OP_VERB.test(spaced))
        return true;
    return false;
}
/**
 * 用户是否**显式**要截屏（含「并截图」、纯截图句、看看桌面等）；用于过滤模型/规则里多余的 screenshot 步骤。
 */
export function userWantsScreenshotInText(rawTrimmed, spaced) {
    const t = (spaced || rawTrimmed.replace(/\s+/g, ' ')).trim();
    if (!t)
        return false;
    if (/(不要|别|无需|不用|禁止|请勿).{0,8}(截图|截屏)/i.test(t))
        return false;
    const raw = rawTrimmed.trim();
    if (/^(截屏|截图|截个图|截一张图|拍个屏|screen\s*shot|screenshot)[。.!！?？\s]*$/i.test(raw))
        return true;
    if (/(只要|仅|只)(截屏|截图)/.test(t) && t.length < 40)
        return true;
    if (/(看看桌面|看下桌面|看一下桌面|当前画面|桌面发我|发张图|发一下截图|给我截个图|帮我截个图)/i.test(t) &&
        t.length < 48) {
        return true;
    }
    if (/(截图|截屏|screenshot|screen\s*shot|拍屏|截个图)/i.test(t))
        return true;
    return false;
}
