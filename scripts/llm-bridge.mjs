/**
 * 宿主机 CLI 桥（需求 场景 8：主观题由本机已登录的 CLI 判分）。
 * 容器是 linux 的，qodercli.exe / copilot.exe 在宿主的 Windows 上，进不去容器，
 * 所以在宿主起这个极小的 HTTP 服务，容器把 prompt POST 过来、桥代跑、回文本。
 *
 *   node scripts/llm-bridge.mjs            # 前台跑，Ctrl+C 停
 *   ARENA_LLM_BRIDGE_TOKEN=xxx node scripts/llm-bridge.mjs
 *
 * 安全：监听 0.0.0.0（Docker Desktop 从容器访问宿主需要它），因此强制要求 token；
 * 只接受 POST /complete 与 GET /health，prompt 一律以 argv 传给子进程（不拼 shell 字符串）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const PORT = Number(process.env.ARENA_BRIDGE_PORT ?? 7799);
const TOKEN = process.env.ARENA_LLM_BRIDGE_TOKEN ?? '';
// 必须 **小于** 容器侧的 HTTP 超时（server/src/llm/settings.ts 默认 180s）：
// 反过来的话慢答案会被客户端先掐掉，桥这边还在白烧一次 CLI 调用，且没人知道结果去哪了。
const TIMEOUT_MS = Number(process.env.ARENA_BRIDGE_TIMEOUT_MS ?? 150_000);

if (!TOKEN) {
  console.error('[llm-bridge] 必须设置 ARENA_LLM_BRIDGE_TOKEN（它会同时注入容器），否则拒绝启动。');
  process.exit(1);
}

const CANDIDATES = [
  { name: 'qodercli', args: (prompt) => ['-p', '--tools', '', '--output-format', 'text', prompt] },
  { name: 'copilot', args: (prompt) => ['-p', prompt] },
];

function resolveBin(name) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const found = spawnSync(checker, [name], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  const lines = found.stdout.split(/\r?\n/).filter(Boolean);
  // Windows 上 PATH 里常有两个同名垫片：优先真 .exe，避免经 cmd.exe 传长 prompt
  const preferred = lines.find((line) => line.toLowerCase().endsWith('.exe')) ?? lines[0];
  return preferred ?? null;
}

function available() {
  return CANDIDATES.map((candidate) => ({ ...candidate, bin: resolveBin(candidate.name) })).filter((c) => c.bin);
}

function runOnce(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const killer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${bin} 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (buf) => {
      if (stdout.length < 200_000) stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf) => {
      if (stderr.length < 20_000) stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(killer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`退出码 ${code}：${stderr.slice(0, 500)}`));
    });
  });
}

async function complete(prompt, clientTimeoutMs) {
  const usable = available();
  if (usable.length === 0) throw new Error('宿主机上没有可用的 qodercli / copilot（或都未登录）');
  // 由调用方（容器）决定"这次最多等多久"，再留 5s 给进程收尾 ——
  // 这样"桥 < 容器"是构造出来的，不靠两边各自记住一个魔法数字。
  const requested = Number(clientTimeoutMs) > 0 ? Math.min(Number(clientTimeoutMs), TIMEOUT_MS) : TIMEOUT_MS;
  const budget = Math.max(5_000, requested - 5_000);
  let lastError;
  for (const candidate of usable) {
    try {
      const text = await runOnce(candidate.bin, candidate.args(prompt), budget);
      if (text.trim()) return { text, provider: candidate.name };
      lastError = new Error(`${candidate.name} 返回空输出`);
    } catch (err) {
      lastError = err;
      console.warn(`[llm-bridge] ${candidate.name} 失败：${err.message}`);
    }
  }
  throw lastError ?? new Error('所有 CLI 都不可用');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const send = (status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };

  const url = new URL(req.url ?? '/', 'http://bridge.local');
  // token 先于 /health：否则"孤儿桥 + 新 token"这种配置漂移下，容器的 available() 探得到 200、
  // 真调 /complete 却全 401，/api/health 会谎报"评分链可用"（memo.md 里程碑 D 记过一次）
  if (req.headers['x-arena-token'] !== TOKEN) {
    send(401, { error: 'token 不匹配' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    send(200, { ok: true, runnable: available().map((c) => c.name) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/complete') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        send(400, { error: '缺少 prompt' });
        return;
      }
      const { text, provider } = await complete(body.prompt, body.timeoutMs);
      send(200, { text, provider });
    } catch (err) {
      send(502, { error: err.message ?? String(err) });
    }
    return;
  }
  send(404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  const runnable = available().map((c) => c.name);
  console.log(`[llm-bridge] 监听 :${PORT}，可用 CLI：${runnable.join(', ') || '(无)'}`);
  if (runnable.length === 0) console.warn('[llm-bridge] 没找到可跑的 CLI，容器侧会降级到 manual 自检表。');
});
