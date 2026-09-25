import type { LlmProviderKind } from '@arena/shared';
import { manualProvider } from './providers/manual.js';
import { bridgeProvider } from './providers/bridge.js';
import { createCopilotProvider } from './providers/copilot.js';
import { createQoderCliProvider } from './providers/qodercli.js';
import { llmSettings } from './settings.js';

/**
 * 一个 provider = "能拿到一段文本"。刻意不定义成"能产出评分结构"：
 * 评分语义（rubric、clamp、降级）集中在 rubric.ts，provider 只负责"怎么把 prompt 喂给本机 CLI"。
 */
export interface LlmProvider {
  kind: LlmProviderKind;
  /** 自检：这台机器上到底能不能用（装了没 / 登录了没 / 参数还被新版本吃不吃） */
  available(): Promise<boolean>;
  complete(prompt: string): Promise<string>;
  /** 附加字段（shared 的 RubricVerdict 有 model，但 LlmProvider 契约里原本没有）：评分结果要能溯源到模型 */
  readonly model?: string;
}

const FACTORIES: Record<LlmProviderKind, () => LlmProvider> = {
  qodercli: createQoderCliProvider,
  copilot: createCopilotProvider,
  bridge: () => bridgeProvider,
  manual: () => manualProvider,
};

function asKind(name: string): LlmProviderKind | null {
  return (Object.keys(FACTORIES) as string[]).includes(name) ? (name as LlmProviderKind) : null;
}

/**
 * 按配置顺序给出 provider 链（默认取 `config.llm.providers`，其默认值就是需求要的
 * `qodercli,copilot,manual`），语义：
 * - 未知名字忽略（配置文件写错不该让评分整条挂掉）；
 * - 重复名字去重；
 * - manual 永远排最后（它是终态兜底，写在中间会把 LLM 档短路掉）；
 * - 一个都没认出来时仍返回 `[manual]`——链子永不为空，接口层因此不会 5xx。
 */
export function resolveProviders(names: readonly string[] = llmSettings().providers): LlmProvider[] {
  const found = new Set<LlmProviderKind>();
  for (const raw of names) {
    const kind = asKind(String(raw).trim().toLowerCase());
    if (kind) found.add(kind);
  }
  const ordered: LlmProviderKind[] = [...found].filter((k) => k !== 'manual');
  ordered.push('manual');
  return ordered.map((kind) => FACTORIES[kind]());
}
