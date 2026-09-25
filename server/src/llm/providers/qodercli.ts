import type { LlmProvider } from '../provider.js';
import { isBatchShim, locateBin, modelFromArgs, runCli, type CliSpec } from '../cli.js';
import { llmSettings } from '../settings.js';

/**
 * 实测可用形态（见 memo.md 2026-09-19 的环境探测记录）：
 *   `qodercli -p --tools "" --output-format text "<prompt>"`
 * - `-p/--print` 非交互；
 * - `--tools ""` 关掉全部内置工具 → 评分过程拿不到文件读写，不会误改项目（配合 cwd 空临时目录双保险）；
 * - `--output-format text` 只要正文，便于剥 fence 后解析 JSON；
 * - prompt 作为**最后一个 argv**，绝不拼进 shell 字符串。
 *
 * CLI 版本会换参数，所以整条模板可由 `config.llm.qoderArgs`（或 `ARENA_QODER_ARGS` JSON 数组）覆盖，
 * 无需改代码。
 */
export const QODER_ARGS_TEMPLATE: readonly string[] = ['-p', '--tools', '', '--output-format', 'text', '%PROMPT%'];

export function qoderArgs(): string[] {
  return [...(llmSettings().qoderArgs ?? QODER_ARGS_TEMPLATE)];
}

function currentSpec(): CliSpec {
  const s = llmSettings();
  return {
    kind: 'qodercli',
    bin: s.qoderBin,
    argsTemplate: s.qoderArgs ?? QODER_ARGS_TEMPLATE,
    timeoutMs: s.timeoutMs,
  };
}

export function createQoderCliProvider(overrides: Partial<CliSpec> = {}): LlmProvider {
  const spec = (): CliSpec => ({ ...currentSpec(), ...overrides });
  return {
    kind: 'qodercli',
    get model() {
      return modelFromArgs(spec().argsTemplate);
    },
    async available() {
      // 只判"装了没 + 能不能不经过 shell 直接跑"：qodercli 一次真实调用要 10-20s，
      // 不该为健康检查付这笔钱；登录态失效/参数被新版本吃掉会由 complete() 抛错 → rubric.ts 降级到 copilot。
      const resolved = await locateBin(spec().bin);
      return resolved !== null && !isBatchShim(resolved);
    },
    async complete(prompt: string) {
      const s = spec();
      const res = await runCli(s, prompt);
      return res.text;
    },
  };
}

