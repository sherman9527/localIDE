#!/usr/bin/env bash
# 防 regression 总入口（需求 通用 3/4/5）。任一步失败立即退出并打印阶段名。
#   npm run verify:fast     只跑宿主机能跑的快子集（提交前用）
#   npm run verify          容器内跑全量（含判题矩阵与 E2E）
# 单独开关：SKIP_E2E=1 / SKIP_JUDGE=1（--fast 就是同时打开这两个）
set -uo pipefail
cd "$(dirname "$0")/.."

# 环境变量不能写在 npm script 里：Windows 的 cmd 不认 `FOO=1 cmd` 这种前缀赋值，
# 所以"快子集"必须是脚本自己的参数。
if [ "${1:-}" = "--fast" ]; then
  export SKIP_E2E=1 SKIP_JUDGE=1
fi

# 容器里跑 verify 时进程环境是 NODE_ENV=production（给服务端用的），
# 但 React 的 production 构建不含 act()，@testing-library/react 会整片失败 —— 测试必须用 test 环境。
export NODE_ENV=test

STAGE=""
run() {
  STAGE="$1"; shift
  printf '\n\033[36m=== [%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$STAGE"
  if ! "$@"; then
    printf '\n\033[31m✗ 阶段失败：%s\033[0m\n' "$STAGE" >&2
    exit 1
  fi
}

run "lint" npx eslint . --max-warnings=0
run "typecheck" npm run typecheck
# 先构建再量产物：拆包成果（首屏不许拖进 zod / CodeMirror）只有从 dist 才看得出真相。
# NODE_ENV 要显式 production：上面为 RTL 导出的 test 会让 vite 打进 dev 版 react-dom（多 ~60KB gzip），预算就量歪了。
run "前端构建" env NODE_ENV=production npm run build -w web
run "前端产物预算" node scripts/check-bundle.mjs
run "单元测试（shared + exec + regression + server 根级）" npx vitest run shared server/test/exec server/test/regression server/test/*.test.ts
run "题库只增不减（基线取 git 跟踪数）" node scripts/check-bank.mjs --count-only
# 整个 bank 目录都要在 FULL_GATE 下跑：只点名 content 的话，
# bank/provenance.test.ts（skipIf ARENA_FULL_GATE）就永远只是"被跑过"而从未真跑。
run "题库闸门（含覆盖度与出处审计）" env ARENA_FULL_GATE=1 npx vitest run server/test/bank
run "游戏后端与前端测试" npx vitest run server/test/game server/test/api server/test/llm web/test
run "网页 IDE（执行内核与解耦边界）" npx vitest run server/test/ide web/test/ide.test.tsx

if [ "${SKIP_JUDGE:-0}" != "1" ]; then
  # 判题套件在宿主机（无 JDK/MySQL/Redis/Spark）会整片 it.skip 且仍然 exit 0 ——
  # 所以除了 vitest 自己，还要断言"真的执行过用例"，否则"全绿"毫无意义。
  run "判题回归矩阵" npx vitest run server/test/judge server/test/regression --reporter=json --outputFile=data/verify-judge.json
  run "判题矩阵确实跑到了" node scripts/assert-ran.mjs data/verify-judge.json "判题矩阵"
else
  printf '\n\033[33m跳过判题矩阵（SKIP_JUDGE=1）——发布前必须在容器内补跑\033[0m\n'
fi

if [ "${SKIP_E2E:-0}" != "1" ]; then
  run "E2E（Playwright）" npx playwright test -c tests/playwright.config.ts
else
  printf '\n\033[33m跳过 E2E（SKIP_E2E=1）\033[0m\n'
fi

printf '\n\033[32m✓ verify 全部通过\033[0m\n'
