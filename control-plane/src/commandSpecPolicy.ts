import type { CommandSpec, Step } from './types.js';
import { userWantsScreenshotInText } from './preprocess.js';

/**
 * 去掉「非用户显式要截屏」的 screenshot 步骤，避免规则/模型默认带一张运行截图。
 * 用户句子里出现截图意图（含「并截图」等）时保留原 steps。
 */
export function stripImplicitScreenshotSteps(spec: CommandSpec, rawUserText: string): CommandSpec {
  const spaced = rawUserText.trim().replace(/\s+/g, ' ');
  if (userWantsScreenshotInText(rawUserText.trim(), spaced)) return spec;
  const next: Step[] = [];
  for (const s of spec.steps) {
    if (s.type === 'screenshot') continue;
    next.push(s);
  }
  if (next.length === spec.steps.length) return spec;
  if (next.length === 0) {
    return {
      ...spec,
      steps: [{ type: 'notify', message: '原指令仅含截屏步骤，已按策略跳过自动截屏。' }]
    };
  }
  return { ...spec, steps: next };
}
