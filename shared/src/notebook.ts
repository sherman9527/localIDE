/**
 * Notebook（Jupyter 运行时，A1 档）的传输契约。
 *
 * 独立于题库/判题的类型：notebook 不产生 attempt、不计 XP、不出现在任何题目响应里
 * （与 `shared/src/ide.ts` 同一份纪律）。住在 shared 的理由也一样：服务端（Task 7/8）与页面
 * （Task 9）两头都要读同一形状，各抄一份就是"改了一边忘了另一边"的入口 ——
 * 本项目在桥 token 上撞过同一次漂移（WI-86），症状是"绿色的断言下一个静默降级的界面"。
 */

/**
 * 一个 kernel 现在能不能拿来跑。
 * `ready:false` 时 `reason` 必须写清楚**为什么**与**怎么办**：
 * 给一个点不动的下拉框、或只写"不可用"，用户读到的是"我的写法错了"，而后端事实是"镜像里没那个 kernelspec"。
 */
export interface NotebookKernel {
  id: string;
  label: string;
  ready: boolean;
  reason?: string;
}

export interface NotebookFile {
  /** 相对 notebook 工作区（`config.notebook.workDir`）的文件名，不带路径 —— 前端不猜目录 */
  file: string;
  /**
   * 「**这一次** seed 有没有把它复制进来」，不是「文件存不存在」。
   *
   * 区分开来是有意的：seed 的唯一硬规矩是"绝不覆盖用户改过的文件"（Task 6），
   * 于是"文件存在"这件事对结果毫无信息量 —— 用户半年前写的同名笔记也在，而它跟镜像里那份没关系。
   * 界面要说的是"这次给你铺了一份新示例"还是"那位置早有人了，我们没动它"，
   * 只有后者时用户看到的改动是自己上次留下的，不会以为被还原过。
   */
  seeded: boolean;
}

/**
 * `GET /api/notebook/status` 的响应。
 *
 * 语义与 start.sh 的 `report_notebook` 严格分层：那边只证明"7789 上有个进程在听 HTTP"，
 * 这里证明的是"那是 jupyter 且 token 对得上"。所以 running:false 必须带 `reason`，
 * 不许沉默 —— 沉默的降级（"点了没反应"）是本项目反复出现的那类缺陷。
 */
export interface NotebookStatusResponse {
  running: boolean;
  /** 带 token 的本机地址；非回环来源拿到的 url 不含 token */
  url?: string;
  /** running:false 时必填 */
  reason?: string;
  kernels: NotebookKernel[];
  notebooks: NotebookFile[];
  /**
   * 「**这一次**铺示例失败了」的原因；成功时这个键不出现（评审 I-1）。
   *
   * 为什么要单独一个字段，而不是让路由把 `seedNotebooks()` 的异常冒出去：
   * 那个函数是**故意**不吞 mkdir/copyFile 的异常的（`server/src/notebooks/seed.ts`），
   * 而它挂在只读的 GET 上 ⇒ 只读挂载 / ENOSPC / 权限坏掉 = 整个 `/api/notebook/status` 变 500
   * = 页面掉到"状态读不到"，**在 Jupyter 明明在跑的时候**把运行时卡片整块抹掉。
   * 所以运行时那一半必须活着返回（200），失败的那一半自己说一句话。
   * 也不许静默吞成 `notebooks: []`：「没有示例」与「铺不进去」修的是不同东西
   * （前者是示例目录本来就是空的，后者是磁盘/权限有问题）。
   * 存的是**给人读的一句话**，不是 Error 对象 —— 它是响应体的一部分，跨进程边界。
   */
  seedError?: string;
}

/**
 * `POST /api/notebook/prepare`（铺示例）的响应。
 * 与 IDE 那边 `IdeEnvResetResponse` 同一条纪律：`ok:false` 时 `reason` 必填，
 * "点了没反应"是最糟的反馈。
 */
export interface NotebookPrepareResponse {
  ok: boolean;
  reason?: string;
}

/**
 * kernel id 的唯一真相：镜像里的 kernelspec 目录名、entrypoint、后端探活、前端默认选择、
 * 测试断言全指向这里。写死字符串会漂移，而漂移的表现不是报错，是"下拉框里那个 kernel 永远 ready:false"。
 */
export const NOTEBOOK_KERNELS = { pyspark: 'arena-pyspark' } as const;
