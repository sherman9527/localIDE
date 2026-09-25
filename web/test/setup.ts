/**
 * 用 `npm test -w @arena/web`（走 web/vitest.config.ts）时的全局准备。
 * 从仓库根跑 `npx vitest run web/test` 不会加载本文件，所以各测试文件里也各自 import 了 dom-shim。
 */
import './dom-shim';
