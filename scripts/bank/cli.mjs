#!/usr/bin/env node
/**
 * 本地 CLI 出题桥（需求 9：后续依赖本地 CLI 新增题目，优先 qodercli，其次 copilot）。
 *
 * provider 顺序（可用 ARENA_LLM_PROVIDERS=qodercli,bridge,copilot 覆盖）：
 *   1) qodercli —— 直接 spawn：`qodercli -p --tools '' --output-format text <prompt>`（argv 数组，不走 shell）
 *   2) bridge   —— 读 ARENA_LLM_BRIDGE_URL + ARENA_LLM_BRIDGE_TOKEN 调宿主 scripts/llm-bridge.mjs
 *   3) copilot  —— `copilot -p <prompt>`
 * 三者全失败时抛错，并说明如何改用离线模式（content/jd-cache/drafts/<category>.json）。
 */
import { spawn } from 'node:child_process';
import { isMain, which } from '../jd/lib.mjs';

const DEFAULT_TIMEOUT_MS = Number(process.env.ARENA_LLM_TIMEOUT_MS ?? 180_000);
const PROVIDERS = (process.env.ARENA_LLM_PROVIDERS ?? 'qodercli,bridge,copilot')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export class LlmUnavailableError extends Error {
  constructor(message, { attempts = [] } = {}) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.attempts = attempts;
  }
}

function runProcess(bin, args, { timeoutMs, label }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      rejectPromise(new Error(`${label} 启动失败：${err.message}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      rejectPromise(new Error(`${label} 超时 ${timeoutMs}ms（已杀掉子进程；可用 --timeout-ms 调大）`));
    }, timeoutMs);
    child.stdout?.on('data', (buf) => {
      if (stdout.length < 500_000) stdout += buf.toString('utf8');
    });
    child.stderr?.on('data', (buf) => {
      if (stderr.length < 40_000) stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      rejectPromise(new Error(`${label} 进程错误：${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${label} 退出码 ${code}：${(stderr || stdout).slice(0, 600).trim()}`));
    });
  });
}

async function viaQodercli(prompt, { timeoutMs }) {
  const bin = process.env.ARENA_QODER_BIN ?? which('qodercli');
  if (!bin) throw new Error('没找到 qodercli（PATH 里没有；可设 ARENA_QODER_BIN=/abs/path/qodercli.exe）');
  const out = await runProcess(bin, ['-p', '--tools', '', '--output-format', 'text', prompt], {
    timeoutMs,
    label: `qodercli(${bin})`,
  });
  if (!out.trim()) throw new Error('qodercli 返回空输出（可能未登录，跑一次 qodercli login）');
  return out;
}

async function viaBridge(prompt, { timeoutMs }) {
  const url = (process.env.ARENA_LLM_BRIDGE_URL ?? '').replace(/\/$/, '');
  const token = process.env.ARENA_LLM_BRIDGE_TOKEN ?? '';
  if (!url) throw new Error('未设置 ARENA_LLM_BRIDGE_URL（容器内跑时指向宿主 http://host.docker.internal:7799）');
  if (!token) throw new Error('设置了 ARENA_LLM_BRIDGE_URL 但没设 ARENA_LLM_BRIDGE_TOKEN');
  const res = await fetch(`${url}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-arena-token': token },
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`bridge HTTP ${res.status}：${text.slice(0, 300)}`);
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`bridge 返回非 JSON：${text.slice(0, 200)}`);
  }
  if (!payload.text?.trim()) throw new Error('bridge 返回空 text');
  return payload.text;
}

async function viaCopilot(prompt, { timeoutMs }) {
  const bin = process.env.ARENA_COPILOT_BIN ?? which('copilot');
  if (!bin) throw new Error('没找到 copilot CLI（PATH 里没有；可设 ARENA_COPILOT_BIN）');
  const out = await runProcess(bin, ['-p', prompt], { timeoutMs, label: `copilot(${bin})` });
  if (!out.trim()) throw new Error('copilot 返回空输出（可能未登录，跑一次 copilot login）');
  return out;
}

const PROVIDER_IMPLS = {
  qodercli: viaQodercli,
  bridge: viaBridge,
  copilot: viaCopilot,
};

/** 各 provider 的可用性预检（不实际提问），用于报错时给人类有用信息。 */
export function probeProviders() {
  return PROVIDERS.map((name) => {
    if (name === 'bridge') {
      return { name, ready: Boolean(process.env.ARENA_LLM_BRIDGE_URL && process.env.ARENA_LLM_BRIDGE_TOKEN) };
    }
    const bin = name === 'qodercli' ? (process.env.ARENA_QODER_BIN ?? which('qodercli')) : (process.env.ARENA_COPILOT_BIN ?? which('copilot'));
    return { name, ready: Boolean(bin), bin };
  });
}

/**
 * 问一次模型，拿纯文本。按 provider 顺序降级，每一步的失败原因都记下来。
 * @param {string} prompt
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ text: string, provider: string, attempts: {provider:string, ok:boolean, error?:string}[] }>}
 */
export async function askLlm(prompt, options = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('askLlm：prompt 为空');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const attempts = [];
  for (const name of PROVIDERS) {
    const impl = PROVIDER_IMPLS[name];
    if (!impl) {
      attempts.push({ provider: name, ok: false, error: `未知 provider（可用：${Object.keys(PROVIDER_IMPLS).join(', ')}）` });
      continue;
    }
    try {
      const text = await impl(prompt, { timeoutMs });
      attempts.push({ provider: name, ok: true });
      return { text, provider: name, attempts };
    } catch (err) {
      attempts.push({ provider: name, ok: false, error: err.message });
      console.warn(`  · provider ${name} 失败：${err.message}`);
    }
  }
  const detail = attempts.map((a) => `    - ${a.provider}: ${a.ok ? 'ok' : a.error}`).join('\n');
  throw new LlmUnavailableError(
    `所有 LLM provider 都不可用。\n${detail}\n  怎么办：\n` +
      `    1) 本机装了 qodercli 就直接跑（PATH 里要有它），或设 ARENA_QODER_BIN；\n` +
      `    2) 在容器里跑就起宿主桥：node scripts/llm-bridge.mjs，并设 ARENA_LLM_BRIDGE_URL/ARENA_LLM_BRIDGE_TOKEN；\n` +
      `    3) 完全离线：把草稿写进 content/jd-cache/drafts/<category>.json，然后用 node scripts/bank/generate-with-cli.mjs --offline。`,
    { attempts },
  );
}

/** 剥掉 ``` fence，取第一个"括号平衡"的 JSON 数组；返回 { value, error }。 */
export function findJsonArray(text) {
  const cleaned = stripFences(String(text ?? ''));
  const start = cleaned.indexOf('[');
  if (start < 0) return { value: null, error: '输出里没有 "[" —— 模型没按"只输出 JSON 数组"的要求来' };
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        const slice = cleaned.slice(start, i + 1);
        try {
          return { value: JSON.parse(slice), raw: slice };
        } catch (err) {
          return { value: null, error: `第一个 [...] 不是合法 JSON：${err.message}`, raw: slice };
        }
      }
    }
  }
  return { value: null, error: 'JSON 数组括号没闭合（模型输出被截断？把 --n 调小或 --timeout-ms 调大）' };
}

function stripFences(text) {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json|JSON)?\s*/g, '\n')
    .replace(/```/g, '\n')
    .trim();
}

/** 拿到 JSON 数组；失败时报错信息里带上模型输出的头尾片段，方便人类判断它到底吐了什么。 */
export function extractJsonArray(text) {
  const { value, error, raw } = findJsonArray(text);
  if (!Array.isArray(value)) {
    const head = String(text ?? '').slice(0, 200).replace(/\s+/g, ' ');
    const tail = String(text ?? '').slice(-160).replace(/\s+/g, ' ');
    throw new Error(
      `解析模型输出失败：${error}\n  输出开头：${head}\n  输出结尾：${tail}` + (raw ? `\n  截到的数组片段：${raw.slice(0, 160)}…` : ''),
    );
  }
  return value;
}

if (isMain(import.meta.url)) {
  console.log(`provider 链：${PROVIDERS.join(' → ')}`);
  for (const p of probeProviders()) console.log(`  ${p.name}: ${p.ready ? `ready${p.bin ? ` → ${p.bin}` : ''}` : 'unavailable'}`);
}
