/**
 * 开发模式编排：先编 shared+server，然后并行跑后端（--watch 重启）与 vite dev server。
 * 不引 concurrently/pm2 —— 两个子进程 + 信号转发就够了。
 */
import { spawn, spawnSync } from 'node:child_process';

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];

function start(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: false });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} 退出（${code}）`);
    if (name === 'api' && code !== 0) shutdown(code ?? 1);
  });
  children.push(child);
  console.log(`[dev] ${name}: ${command} ${args.join(' ')}`);
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const built = spawnSync(NPM, ['run', 'build', '-w', '@arena/shared', '-w', '@arena/server'], {
  stdio: 'inherit',
  shell: false,
});
if (built.status !== 0) {
  console.error('[dev] 构建失败，先修编译错误再跑 dev');
  process.exit(built.status ?? 1);
}

start('api', NPM, ['run', 'dev', '-w', '@arena/server']);
start('web', NPM, ['run', 'dev', '-w', '@arena/web']);
console.log('[dev] 前端 http://localhost:5173 ，后端 http://localhost:7788');
