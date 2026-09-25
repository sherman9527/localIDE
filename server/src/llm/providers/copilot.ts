import type { LlmProvider } from '../provider.js';
import { locateBin, isBatchShim, modelFromArgs, runCli, type CliSpec } from '../cli.js';
import { llmSettings } from '../settings.js';

/**
 * 第二档：GitHub Copilot CLI。
 * 本机 `copilot --help` 实测确认的参数：`-p/--prompt <text>`（非交互）、`--output-format text`、
 * `-s/--silent`（只输出回答）、`--model <model>`、`-C <dir>`；另有 `--deny-tool` 可禁工具（取值清单未实测，故不写进默认模板）。
 * 沙箱边界：默认**不给** `--allow-all-tools` / `--allow-all-paths` —— 非交互模式下改文件/跑命令需要授权，
 * 无人可批 → 只会输出文本不会动仓库；spawn 的 cwd 又是 `data/llm-tmp/` 下的空临时目录，双保险。
 * 参数若随版本失效：整条模板可由 `config.llm.copilotArgs` / `ARENA_COPILOT_ARGS` 覆盖，无需改代码。
 */
export const COPILOT_ARGS_TEMPLATE: readonly string[] = ['-p', '%PROMPT%', '--output-format', 'text', '-s'];

export const COPILOT_PROBE_PROMPT = 'Reply with exactly: ARENA_PROBE_OK';

function currentSpec(): CliSpec {
  const s = llmSettings();
  return {
    kind: 'copilot',
    bin: s.copilotBin,
    argsTemplate: s.copilotArgs ?? COPILOT_ARGS_TEMPLATE,
    timeoutMs: s.timeoutMs,
  };
}

export function createCopilotProvider(overrides: Partial<CliSpec> = {}): LlmProvider {
  const spec = (): CliSpec => ({ ...currentSpec(), ...overrides });
  const probeSpec = (): CliSpec => ({ ...spec(), timeoutMs: Math.min(spec().timeoutMs, 60_000) });
  return {
    kind: 'copilot',
    get model() {
      return modelFromArgs(spec().argsTemplate);
    },
    async available() {
      const s = spec();
      const resolved = await locateBin(s.bin);
      if (resolved === null || isBatchShim(resolved)) return false;
      // 极简调用探测：装没装、登录态、参数是否仍被接受，一次看清；任何失败即不可用。
      try {
        const res = await runCli(probeSpec(), COPILOT_PROBE_PROMPT);
        return res.text.trim().length > 0;
      } catch {
        return false;
      }
    },
    async complete(prompt: string) {
      const res = await runCli(spec(), prompt);
      return res.text;
    },
  };
}

