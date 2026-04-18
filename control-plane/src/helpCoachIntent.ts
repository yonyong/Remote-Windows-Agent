/**
 * 用户以「求助」或「help …」开头时走「教你怎么下指令」通道（见 commandResolver）。
 * help 后须有空格或冒号形式，避免匹配到 helpful 等词。
 */
export function parseHelpCoachGoal(raw: string): { goal: string } | null {
  const t = raw.trim();
  if (!t) return null;
  if (/^求助/.test(t)) {
    const m = t.match(/^求助\s*[:：]?\s*(.*)$/s);
    return { goal: (m?.[1] ?? '').trim() };
  }
  if (/^help$/i.test(t)) return { goal: '' };
  const mEn = t.match(/^help(?:\s+|\s*[:：]\s*)(.*)$/is);
  if (mEn) return { goal: (mEn[1] ?? '').trim() };
  return null;
}

/** 未配置大模型 Key 时的固定引导（不调用上游） */
export function helpCoachFallbackNoLlm(goal: string): string {
  const examples = [
    '截图',
    '打开 Chrome',
    '切换到浏览器',
    '打开 https://www.youtube.com',
    '输入：你好（需目标窗口已在前台并获得焦点）',
    '等待 2 秒'
  ].join('\n· ');

  const head =
    '【使用说明】本控制台把你说的话发给已绑定的 Windows 电脑去执行。能力主要包括：截图、打开/切换 Chrome/Edge/Firefox、打开网址、在**前台窗口**里输入文字、快捷键类组合（由解析模型拆成 sendkeys）、音量、锁屏、等待等；复杂排版类软件（如 Word）更适合在电脑上本地操作或用专用自动化方案。\n\n';

  if (!goal) {
    return (
      head +
      '你在「求助」后还没有写具体想做什么。请补一句目标（例如：想在浏览器里搜周杰伦的晴天）。\n\n' +
      '可直接复制尝试的示例：\n· ' +
      examples +
      '\n\n在网页「解析设置」里配置大模型 API Key 后，再以「求助 …」提问可获得更贴合的示例指令。'
    );
  }

  return (
    head +
    '已理解你的诉求（简述）：「' +
    goal.slice(0, 400) +
    (goal.length > 400 ? '…' : '') +
    '」。\n\n' +
    '在未配置大模型时，可先试下面这些说法（按需改写括号里的内容）：\n· ' +
    examples +
    '\n· 打开 https://www.youtube.com/results?search_query=周杰伦+晴天（用浏览器搜索）\n' +
    '\n配置 API Key 后，用「求助」+ 同一句话可让模型按你的场景写出多条更贴切的示例指令。'
  );
}
