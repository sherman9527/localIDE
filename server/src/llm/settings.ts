import { config } from '../config.js';

/**
 * LLM 相关配置的**唯一读取口**。
 *
 * 为什么要有这一层：`server/src/config.ts` 是别人的文件（本次改动禁止修改），而它目前只有
 * `providers / qoderBin / copilotBin / timeoutMs` 四个字段，**没有** 规格要求的
 * `qoderArgs / copilotArgs`（args 模板可覆盖 = CLI 版本升级时唯一的生路）。
 * 所以这里做三件事：
 * 1. 兼容读取（config 里哪天加上这两个字段就自动生效，不需要改本文件）；
 * 2. 环境变量兜底 `ARENA_QODER_ARGS` / `ARENA_COPILOT_ARGS`（JSON 数组字符串）；
 * 3. 每次调用现取，测试与运行期都能覆盖，而不是在模块加载时抓快照。
 */
export interface LlmSettings {
  providers: string[];
  qoderBin: string;
  copilotBin: string;
  timeoutMs: number;
  /** args 模板，含 %PROMPT% 占位符；undefined = 用 provider 自带默认模板 */
  qoderArgs?: string[];
  copilotArgs?: string[];
  dataDir: string;
}

type LlmConfigWithArgs = {
  providers: readonly string[];
  qoderBin: string;
  copilotBin: string;
  timeoutMs: number;
  qoderArgs?: readonly string[] | string;
  copilotArgs?: readonly string[] | string;
};

function parseArgsOverride(value: readonly string[] | string | undefined, envJson: string | undefined): string[] | undefined {
  if (Array.isArray(value)) return [...value].map(String);
  if (typeof value === 'string' && value.trim()) return [value];
  if (envJson?.trim()) {
    try {
      const parsed: unknown = JSON.parse(envJson);
      if (Array.isArray(parsed) && parsed.every((a) => typeof a === 'string')) return parsed as string[];
      // 也允许直接给一个空格分隔的串（人肉临时改配置更省事）
      if (typeof parsed === 'string') return parsed.split(' ').filter(Boolean);
    } catch {
      /* 坏配置当作没配，走默认模板 */
    }
  }
  return undefined;
}

/**
 * 超时必须是"正的有限数"：`Number('5m')=NaN` 会让 `AbortSignal.timeout(NaN)` 同步抛 RangeError，
 * 上层把它吞成"这一档不可用"，日志里只剩一句含糊的跳过（review agent 实测到）。
 * 默认 180s 必须 **大于** 宿主桥的 CLI 超时（`scripts/llm-bridge.mjs` 默认 150s）：
 * 反过来的话慢答案会被客户端先掐掉，而桥那边还在白烧一次 CLI 调用。
 */
export const LLM_DEFAULT_TIMEOUT_MS = 180_000;

export function sanitizeTimeoutMs(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : LLM_DEFAULT_TIMEOUT_MS;
}

export function llmSettings(): LlmSettings {
  const llm = config.llm as LlmConfigWithArgs;
  const timeoutMs = sanitizeTimeoutMs(llm.timeoutMs);
  return {
    providers: llm.providers.map((s) => String(s).trim()).filter(Boolean),
    qoderBin: llm.qoderBin,
    copilotBin: llm.copilotBin,
    timeoutMs,
    qoderArgs: parseArgsOverride(llm.qoderArgs, process.env.ARENA_QODER_ARGS),
    copilotArgs: parseArgsOverride(llm.copilotArgs, process.env.ARENA_COPILOT_ARGS),
    dataDir: config.dataDir,
  };
}
