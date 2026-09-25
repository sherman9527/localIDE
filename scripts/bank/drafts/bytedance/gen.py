#!/usr/bin/env python3
"""
字节跳动（ByteDance）方向题目草稿生成器（30 题：18 道可机器判 + 12 道主观题）。

取材纪律：只出在
  content/knowledge/hot-interviews/bytedance-backend-and-infrastructure.md
  content/knowledge/hot-interviews/bytedance-data-and-recommendation.md
里能落到 **官方文档原文的机制/约束/状态机** 上的考点。两份素材都明确写了
"没有官方来源就不许写进题面"（各自的 §7），所以：
  * 题面里的量级数字一律显式标注为本题假设；
  * 素材标【推】的部分（半开恢复判据、灰度回滚、Feed 推拉成本）在题面里
    写成"本题设定的契约"，不写成"字节官方这么说"；
  * 两份素材都主动放弃 `react-vitest`（§7 说前端/客户端 SDK 无可核查机制文档）。
    本批的 frontend 题**不碰前端框架与 SDK 内部实现**，只把 DataFinder/A/B 文档里
    可核查的**产品状态语义**（事件验收态、T-1 读数口径、SRM 告警）做成视图模型 ——
    出处是产品文档，不是"字节前端栈"。

代码题的 expected **全部由本文件里的 Python 模型算出**，不手算；
`precheck.py` 用另一份独立重写跑同一批用例；`probe_naive.py` 把答案里写死的数字
从**已入库**的文案里用正则抠出来再和数据比。三道闸门分工见 docs/ADD_QUESTIONS.md。

用法：
    python scripts/bank/drafts/bytedance/gen.py            # 生成到 data/drafts-bd/out/
    python scripts/bank/drafts/bytedance/gen.py --list     # 只列已登记的题目标识
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-bd', 'out')

INFRA = 'content/knowledge/hot-interviews/bytedance-backend-and-infrastructure.md'
DATA = 'content/knowledge/hot-interviews/bytedance-data-and-recommendation.md'

DRAFTS = {}


def draft(key):
    def deco(fn):
        DRAFTS[key] = fn
        return fn
    return deco


def base(category, difficulty, title, statement, judge_kind, tags, source, **extra):
    q = {
        'category': category,
        'difficulty': difficulty,
        'title': title,
        'statement': statement,
        'judgeKind': judge_kind,
        'tags': tags,
        'source': source,
    }
    # 主观题的 rubric 允许写成 [(label, weight, criteria), ...] + notes=…，在这里统一折叠。
    # Question 是 .strict() 的，顶层多一个 notes 会被 zod 直接拒 ⇒ 必须在进 q 之前收掉。
    notes = extra.pop('notes', None)
    rb = extra.get('rubric')
    if isinstance(rb, list):
        extra['rubric'] = rubric(rb, notes)
    elif rb is not None and notes:
        rb['notes'] = notes
    q.update(extra)
    return q


def rubric(points, notes=None):
    out = {'maxScore': 10, 'points': [
        {'label': label, 'weight': weight, 'criteria': criteria} for label, weight, criteria in points]}
    if notes:
        out['notes'] = notes
    return out


def src(role, ref):
    return {
        'company': 'ByteDance',
        'role': role,
        'location': 'beijing',
        'origin': 'manual',
        'jds': [],
        'era': '2026',
        'knowledgeRef': ref,
        'addedBy': 'arena-company-expansion',
    }


class ModelError(Exception):
    """模型层的"必须抛错"。message 就是契约型用例要断言的那句话。"""

    def __init__(self, message):
        super().__init__(message)
        self.message = message


def jcase(name, args, model, throws=None, throws_message=None, note=None):
    """java-junit 用例助手。

    **`throws` 是声明，不是推断**（WI-63）：跑一遍模型，
    抛了却没声明 ⇒ 当场炸；声明了却没抛 ⇒ 同样炸；消息不等 ⇒ 也炸。
    """
    if throws is None:
        try:
            got = model(*args)
        except ModelError as exc:
            raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc.message}') from exc
        out = {'name': name, 'input': list(args), 'expected': got}
    else:
        try:
            got = model(*args)
        except ModelError as exc:
            if exc.message != throws_message:
                raise AssertionError(
                    f'用例「{name}」期望消息 "{throws_message}"，实际 "{exc.message}"')
            out = {'name': name, 'input': list(args), 'expected': None,
                   'expectThrow': throws, 'throwMessage': throws_message}
        else:
            raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
    if note:
        out['note'] = note
    return out


# =================================================================== A1 熔断器状态机
@draft('alg-bd-circuitbreaker')
def q_circuitbreaker():
    CLOSED, OPEN, HALF = 0, 1, 2

    def breaker(min_sample, threshold_bps, cooldown_steps, probe_sample, outcomes):
        if min_sample <= 0:
            raise ModelError('minSample must be positive')
        if threshold_bps <= 0 or threshold_bps > 10000:
            raise ModelError('thresholdBps out of range')
        if cooldown_steps < 0:
            raise ModelError('cooldownSteps must be non-negative')
        if probe_sample < min_sample:
            raise ModelError('probeSample must be >= minSample')
        if outcomes is None:
            raise ModelError('outcomes must not be null')
        for o in outcomes:
            if o not in (0, 1):
                raise ModelError('outcome must be 0 or 1')

        state = CLOSED
        samples = errors = 0
        allowed = rejected = open_events = 0
        cooldown_left = probe_left = 0
        for o in outcomes:
            if state == OPEN:
                rejected += 1
                cooldown_left -= 1
                if cooldown_left <= 0:
                    state = HALF
                    samples = errors = 0
                    probe_left = probe_sample
                continue
            allowed += 1
            samples += 1
            errors += o
            if samples >= min_sample and errors * 10000 >= threshold_bps * samples:
                open_events += 1
                samples = errors = 0
                if cooldown_steps <= 0:
                    state = HALF
                    probe_left = probe_sample
                else:
                    state = OPEN
                    cooldown_left = cooldown_steps
                continue
            if state == HALF:
                probe_left -= 1
                if probe_left <= 0:
                    state = CLOSED
                    samples = errors = 0
        return [allowed, rejected, open_events, state]

    cases = [
        jcase('基线：满样本 + 错误率过半 ⇒ 打开，冷却后转半开',
              [4, 5000, 2, 4, [1, 1, 1, 1, 0, 0, 0, 0]], breaker),
        jcase('边界：样本数不足 minSample 时阈值不生效（低峰期不许误熔断）',
              [200, 5000, 2, 200, [1, 1, 1, 1, 1]], breaker,
              note='官方默认阈值是 0.5 / 200，且"样本不足 200 时配置不生效"——'
                   '5 条全错也不该打开'),
        jcase('阈值恰好相等即打开（判定用 >= 不是 >）',
              [4, 5000, 0, 4, [1, 1, 0, 0, 0, 0, 0, 0]], breaker),
        jcase('退化：冷却为 0 ⇒ 打开后下一条就是半开探测，不产生拒绝',
              [2, 5000, 0, 2, [1, 1, 0, 0]], breaker),
        jcase('半开窗口内再次越界 ⇒ 二次打开（openEvents 记 2）',
              [2, 5000, 2, 2, [1, 1, 0, 0, 1, 1, 0]], breaker),
        jcase('边界：空事件流 ⇒ 一个都没放过也没拒，终态关闭',
              [4, 5000, 2, 4, []], breaker),
        jcase('整段全对 ⇒ 从不打开，终态仍是关闭',
              [3, 5000, 2, 3, [0, 0, 0, 0, 0, 0]], breaker),
        jcase('非法：probeSample 小于 minSample（半开窗口永远判不出结果）',
              [10, 5000, 2, 4, [0]], breaker, throws='IllegalArgumentException',
              throws_message='probeSample must be >= minSample'),
        jcase('非法：冷却步数为负',
              [4, 5000, -1, 4, [0]], breaker, throws='IllegalArgumentException',
              throws_message='cooldownSteps must be non-negative'),
        jcase('非法：阈值万分比越界',
              [4, 10001, 2, 4, [0]], breaker, throws='IllegalArgumentException',
              throws_message='thresholdBps out of range'),
        jcase('非法：事件值不是 0/1',
              [4, 5000, 2, 4, [0, 2]], breaker, throws='IllegalArgumentException',
              throws_message='outcome must be 0 or 1'),
    ]

    reference = """public class Solution {
  private static final int CLOSED = 0, OPEN = 1, HALF = 2;

  public static int[] breakerSimulate(int minSample, int thresholdBps, int cooldownSteps,
                                      int probeSample, int[] outcomes) {
    if (minSample <= 0) throw new IllegalArgumentException("minSample must be positive");
    if (thresholdBps <= 0 || thresholdBps > 10000)
      throw new IllegalArgumentException("thresholdBps out of range");
    if (cooldownSteps < 0) throw new IllegalArgumentException("cooldownSteps must be non-negative");
    if (probeSample < minSample) throw new IllegalArgumentException("probeSample must be >= minSample");
    if (outcomes == null) throw new IllegalArgumentException("outcomes must not be null");
    for (int o : outcomes) if (o != 0 && o != 1) throw new IllegalArgumentException("outcome must be 0 or 1");

    int state = CLOSED, samples = 0, errors = 0;
    int allowed = 0, rejected = 0, openEvents = 0, cooldownLeft = 0, probeLeft = 0;
    for (int o : outcomes) {
      if (state == OPEN) {
        rejected++;
        if (--cooldownLeft <= 0) { state = HALF; samples = 0; errors = 0; probeLeft = probeSample; }
        continue;
      }
      allowed++;
      samples++;
      errors += o;
      if (samples >= minSample && (long) errors * 10000L >= (long) thresholdBps * samples) {
        openEvents++;
        samples = 0;
        errors = 0;
        if (cooldownSteps <= 0) { state = HALF; probeLeft = probeSample; }
        else { state = OPEN; cooldownLeft = cooldownSteps; }
        continue;
      }
      if (state == HALF && --probeLeft <= 0) { state = CLOSED; samples = 0; errors = 0; }
    }
    return new int[] {allowed, rejected, openEvents, state};
  }
}"""

    naive = """public class Solution {
  // "错误率一超标就短路"版：没有最小样本门槛、打开之后永远打开（没有半开），
  // 且被拒的请求也算进样本 —— 低峰期一条失败就能把整个 key 锁死。
  public static int[] breakerSimulate(int minSample, int thresholdBps, int cooldownSteps,
                                      int probeSample, int[] outcomes) {
    if (minSample <= 0) throw new IllegalArgumentException("minSample must be positive");
    if (thresholdBps <= 0 || thresholdBps > 10000)
      throw new IllegalArgumentException("thresholdBps out of range");
    if (cooldownSteps < 0) throw new IllegalArgumentException("cooldownSteps must be non-negative");
    if (probeSample < minSample) throw new IllegalArgumentException("probeSample must be >= minSample");
    if (outcomes == null) throw new IllegalArgumentException("outcomes must not be null");
    for (int o : outcomes) if (o != 0 && o != 1) throw new IllegalArgumentException("outcome must be 0 or 1");

    int open = 0, allowed = 0, rejected = 0;
    int samples = 0, errors = 0;
    for (int o : outcomes) {
      samples++;
      errors += o;
      if (open > 0) { rejected++; continue; }
      allowed++;
      if (errors * 10000 >= thresholdBps * samples) { open = 1; }
    }
    return new int[] {allowed, rejected, open, open == 0 ? 0 : 1};
  }
}"""

    statement = """## 背景

Kitex 的熔断器文档给了三条可核查的硬信息【源 S2】：

1. 默认阈值是 `ErrRate: 0.5` + `MinSample: 200`，并且**样本不足 200 时阈值不生效**；
2. 熔断有**统计粒度**（服务粒度 key = `fromService/toService/method`，实例粒度另有配置），
   实例粒度熔断后框架会**自动重试换实例**；
3. 文档把"触发策略 / 冷却策略 / 半打开时策略"分成独立小节 —— 也就是
   **恢复判据要自己定**（本题把它写成契约，见下）。

这题不考"熔断就是短路请求"，考的是**状态机本身**：门槛、阈值边界、冷却、半开探测、
以及"探测期再次失败要回哪去"。低峰期误熔断是这类代码唯一的真实事故形态。

## 任务

实现 `public static int[] breakerSimulate(int minSample, int thresholdBps, int cooldownSteps, int probeSample, int[] outcomes)`。

`outcomes[i]` 是第 i 个**到达**的请求的结局：`1` = 失败，`0` = 成功。
返回四个整数：`{放行数, 拒绝数, 打开次数, 结束时的状态}`，状态取 `0=关闭 / 1=打开 / 2=半开`。

## 契约（**逐条实现，不要自己发挥**）

判定顺序对每个到达的请求执行一次：

| 当前状态 | 行为 |
| --- | --- |
| 关闭 / 半开 | **放行**，并把这次结局计入统计（`samples++`，失败则 `errors++`） |
| 打开 | **拒绝**。不产生统计（**被拒的请求不计入样本** —— 它根本没打到下游）。冷却计数 `cooldownLeft--`；减到 0 时转半开并重置统计，`probeLeft = probeSample` |

打开条件（放行并统计之后判）：

```
samples >= minSample  且  errors * 10000 >= thresholdBps * samples
```

- 用**万分比整数**比较，不许出现浮点：`thresholdBps = 5000` 就是官方的 0.5。
- 是 `>=` 不是 `>`：错误率**恰好等于**阈值就要打开。
- 一旦不满足 `samples >= minSample`，**阈值完全不参与判定**（哪怕错误率 100%）。

命中打开条件时：`openEvents++`，统计清零，`openEvents` 可多次累加（半开再犯就是二次打开）；
`cooldownSteps <= 0` ⇒ **直接进入半开**（不产生任何拒绝），否则进入打开并置 `cooldownLeft = cooldownSteps`。

半开的恢复判据（这一段是本题设定的规则，不是官方原文）：
半开放行 `probeSample` 个请求，其间任意时刻满足打开条件 ⇒ 回到打开；
否则**探测窗口跑满且没越界** ⇒ 回到关闭并清零统计。

## 参数合法性（抛 `IllegalArgumentException`，消息必须一字不差）

| 条件 | 消息 |
| --- | --- |
| `minSample <= 0` | `minSample must be positive` |
| `thresholdBps <= 0` 或 `> 10000` | `thresholdBps out of range` |
| `cooldownSteps < 0` | `cooldownSteps must be non-negative` |
| `probeSample < minSample` | `probeSample must be >= minSample` |
| `outcomes == null` | `outcomes must not be null` |
| 某个元素不是 0/1 | `outcome must be 0 or 1` |

`probeSample < minSample` 是**配置错误而不是钳制**：半开窗口比样本门槛还短，
打开条件永远不可能在窗口内被判定，熔断器会变成"探测一次就无条件恢复"的死循环。
钳制它等于悄悄改掉语义，所以必须拒绝。

## 这题真正考的东西

**`MinSample` 不是"性能优化"，是熔断器的第一道安全阀。**
低峰期 1 QPS 时 200 个样本要 3 分多钟才攒够，看起来"熔断变钝了"；
但去掉门槛之后，任何一次孤立失败都让错误率跳到 100%，
于是**一个实例的一次抖动 = 该 key 全量拒绝**。素材里那句
"阈值要和熔断后自动重试/降级链路一起算，别只说配 0.5"就是这个意思。

第二条：被拒的请求**不许计入统计**。否则打开状态会自我强化 ——
拒绝率越高、样本里失败越多、越不可能满足恢复条件，熔断器再也关不上。"""

    return base(
        'algorithms', 'senior',
        '熔断器状态机：最小样本门槛、万分比阈值、冷却与半开探测的完整迁移',
        statement, 'java-junit',
        ['circuit-breaker', 'min-sample-gate', 'state-machine', 'service-mesh',
         'modern:resilience-semantics'],
        src('服务端研发（Go 微服务治理与稳定性方向） 高级工程师',
            INFRA + '#4 考点 2（熔断器：粒度、阈值、半开与自动重试；'
            '默认 ErrRate 0.5 / MinSample 200 且"样本不足时不生效"；半开/冷却判据按【推】补全）'
            '＋ §5 题面草稿 A 第 1 条'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'int[] breakerSimulate(int minSample, int thresholdBps, int cooldownSteps, int probeSample, int[] outcomes)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案要点

状态机三态 + 一条"越界即打开"的判定，全整数比较：

```java
if (samples >= minSample && (long) errors * 10000L >= (long) thresholdBps * samples) { 打开 }
```

**基线用例 `minSample=4 / 阈值 5000 / 冷却 2 / 探测 4 / 事件 [1,1,1,1,0,0,0,0]` 走的是：**
前 4 条放行并统计，第 4 条结束时 `samples` 刚够门槛，且四条全错（万分比 10000）越过 5000 阈值
⇒ 第 1 次打开，`cooldownLeft=2`；第 5、6 条被拒（**不产生统计**），冷却减到 0 ⇒ 转半开、窗口 `probeLeft=4`；
第 7、8 条作为探测放行，全成功且不越界，但窗口只跑了 2/4 ⇒ 结束态仍是**半开**。
所以返回 `{6, 2, 1, 2}`：放行 6、拒绝 2、打开 1 次、终态半开。
"结束在半开"不是瑕疵 —— 它说明**恢复是一个需要样本的过程，不是一次定时器到点的动作**。

**边界用例（`minSample=200`、5 条全错）返回 `{5, 0, 0, 0}`**，这就是官方
"样本不足 200 时配置不生效"的实现形态：错误率 `100%` 却一个都没拒。
去掉 `samples >= minSample` 这一侧，`errors * 10000 >= threshold * samples` 在 1 条失败时就是
`10000 >= 5000` ⇒ 立刻打开，低峰期一次抖动锁死整个 key。

**阈值相等即打开**（用例「阈值恰好相等即打开（判定用 >= 不是 >）」）：
`minSample=4 / 冷却 0 / [1,1,0,0,...]` 在第 4 条结束时是 4 个样本里 2 个失败，
万分比恰好 5000 —— 判 `>=` 才打得开。写成 `>` 的实现整条用例少一次打开，且**线上表现为"该熔断时不熔断"**，
监控上极难归因。

**半开再犯要计第二次打开**：`openEvents` 是"这个 key 被打开了几次"的 SLO 计数，
把半开失败并回打开算作"没发生"，就等于把抖动从故障统计里抹掉。

**为什么被拒的请求不许进统计**：进了就会形成正反馈 —— 打开 ⇒ 全是"失败样本" ⇒
错误率永远 100% ⇒ 永远关不上。这是自锁型熔断器的经典实现错误，
和"降级后按降级结果上报监控"是同一类污染（本题的 A/B 面：一个是把失败洗成成功，
一个是把成功洗成失败）。

**工程延伸（面试追问点）**

1. 实例级熔断打开后框架做什么？（自动重试换实例，前提是中间件用 `WithInstanceMW` 注册，
   因为它要在负载均衡**之后**执行 —— 重试要换实例，就必须先知道选的是哪个实例。
   顺序错了就变成"重试到同一个坏实例"。）
2. 冷却用"请求数"而不是"时间"的代价？（低峰期可能很久都不推进恢复、
   高峰期几毫秒就走完冷却；真实实现要挂时钟，但要能说出这是可测性换真实性的取舍 ——
   本题这么定就是为了让它可判分。）
3. 阈值怎么定？（要和服务粒度熔断阈值联动：重试停止策略 `CBPolicy` 默认 10%、
   合法域 (0,30%]，且**必须小于**服务粒度熔断阈值，否则重试统计会盖过熔断判定。）
4. 半开窗口该多大？（至少 `minSample`，否则判不出 —— 这就是参数校验里那条
   `probeSample must be >= minSample`。题面故意要求抛错而不是钳制：
   钳制会静默改变一个已经配好的熔断器的恢复速度。）""",
    )


# =================================================================== A2 重试决策函数
@draft('alg-bd-retry-decision')
def q_retry_decision():
    def decide(rpc_timeout, max_retries, max_duration, cb_policy_bps, breaker_threshold_bps,
               chain_stop, upstream_is_retry, retry_same_node, streaming, idempotent,
               elapsed_ms, attempts_done, error_type, last_node, candidate_node):
        if rpc_timeout <= 0:
            raise ModelError('rpcTimeout must be positive')
        if max_retries < 0 or max_retries > 5:
            raise ModelError('maxRetryTimes must be in [0,5]')
        if cb_policy_bps <= 0 or cb_policy_bps > 3000:
            raise ModelError('cbPolicyBps must be in (0,3000]')
        if breaker_threshold_bps <= 0 or breaker_threshold_bps > 10000:
            raise ModelError('breakerThresholdBps out of range')
        if cb_policy_bps >= breaker_threshold_bps:
            raise ModelError('cbPolicyBps must be below breaker threshold')
        if error_type is None:
            raise ModelError('errorType must not be null')
        if elapsed_ms < 0:
            raise ModelError('elapsed must be non-negative')
        if attempts_done < 0:
            raise ModelError('attemptsDone must be non-negative')

        ceiling = rpc_timeout * (max_retries + 1)
        clamped = False
        if max_duration <= 0:
            effective = ceiling
        elif max_duration < rpc_timeout + 1:
            effective, clamped = rpc_timeout + 1, True
        elif max_duration > ceiling:
            effective, clamped = ceiling, True
        else:
            effective = max_duration

        if streaming:
            d = 'STOP_STREAMING'
        elif error_type not in ('TIMEOUT', 'CONNECT_FAIL'):
            d = 'STOP_NOT_RETRYABLE'
        elif error_type == 'TIMEOUT' and not idempotent:
            d = 'STOP_NOT_IDEMPOTENT'
        elif chain_stop and upstream_is_retry:
            d = 'STOP_CHAIN'
        elif attempts_done >= max_retries:
            d = 'STOP_TRIES'
        elif elapsed_ms >= effective:
            d = 'STOP_BUDGET'
        elif not retry_same_node and candidate_node == last_node:
            d = 'STOP_SAME_NODE'
        else:
            d = 'RETRY'
        return ('CLAMPED|' + d) if clamped else d

    OK = dict(rpc=100, retries=2, dur=0, cbps=1000, bps=5000, cs=True, up=False,
              rsn=False, st=False, idem=True, el=0, ad=1, et='TIMEOUT', ln=1, cn=2)

    def mk(**kw):
        a = dict(OK)
        a.update(kw)
        return [a['rpc'], a['retries'], a['dur'], a['cbps'], a['bps'], a['cs'], a['up'],
                a['rsn'], a['st'], a['idem'], a['el'], a['ad'], a['et'], a['ln'], a['cn']]

    cases = [
        jcase('基线：超时 + 幂等 + 还有额度 + 换实例 ⇒ 重试', mk(), decide),
        jcase('非幂等接口超时不重试（官方"业务请求不具幂等性"正是它不默认开启的理由）',
              mk(idem=False), decide),
        jcase('建连失败不受幂等约束：请求没到达服务端，重放不会重复扣款',
              mk(et='CONNECT_FAIL', idem=False), decide),
        jcase('业务错误不是 RPC 失败：换多少个实例都会得到同一个错误',
              mk(et='BUSINESS'), decide),
        jcase('上游已经是重试请求 ⇒ ChainStop 不级联（重试风暴的第一层刹车）',
              mk(up=True), decide),
        jcase('边界：ChainStop 关掉时，上游的重试请求仍然可以继续重试',
              mk(up=True, cs=False), decide),
        jcase('边界：重试次数用完（attemptsDone 等于 maxRetryTimes 就停，不是超过才停）',
              mk(ad=2), decide),
        jcase('退化：maxRetryTimes=0 就是关掉重试，第一次失败即止',
              mk(ad=0, retries=0), decide),
        jcase('预算越界 ⇒ 停止（累计耗时含首次失败请求）', mk(el=301, dur=300), decide),
        jcase('边界：耗时恰好等于有效预算即停止（判定用 >=）', mk(el=300, dur=300), decide),
        jcase('配置钳制：maxDuration 小于单次超时 ⇒ 抬到 rpcTimeout+1 并标 CLAMPED',
              mk(dur=50, el=0, ad=1), decide),
        jcase('配置钳制：maxDuration 超过 rpcTimeout*(maxRetry+1) ⇒ 压到上界并标 CLAMPED',
              mk(dur=9999, el=250), decide),
        jcase('流式接口不支持重试（协议层就没有第二次机会）', mk(st=True, rsn=True), decide),
        jcase('RetrySameNode=false 时同一实例不许重试两次', mk(cn=1), decide),
        jcase('非法：重试次数超出官方合法域 0-5', mk(retries=6), decide,
              throws='IllegalArgumentException', throws_message='maxRetryTimes must be in [0,5]'),
        jcase('非法：重试停止阈值不小于熔断阈值（重试统计会盖过熔断判定）',
              mk(bps=1000), decide,
              throws='IllegalArgumentException',
              throws_message='cbPolicyBps must be below breaker threshold'),
        jcase('非法：cbPolicy 超过官方上限 30%', mk(cbps=3001), decide,
              throws='IllegalArgumentException', throws_message='cbPolicyBps must be in (0,3000]'),
        jcase('非法：单次超时为 0', mk(rpc=0), decide,
              throws='IllegalArgumentException', throws_message='rpcTimeout must be positive'),
        jcase('非法：已重试次数为负', mk(ad=-1), decide,
              throws='IllegalArgumentException', throws_message='attemptsDone must be non-negative'),
    ]

    reference = """public class Solution {
  public static String retryDecide(int rpcTimeoutMs, int maxRetryTimes, int maxDurationMs,
                                   int cbPolicyBps, int breakerThresholdBps, boolean chainStop,
                                   boolean upstreamIsRetry, boolean retrySameNode, boolean streaming,
                                   boolean idempotent, int elapsedMs, int attemptsDone,
                                   String errorType, int lastNode, int candidateNode) {
    if (rpcTimeoutMs <= 0) throw new IllegalArgumentException("rpcTimeout must be positive");
    if (maxRetryTimes < 0 || maxRetryTimes > 5)
      throw new IllegalArgumentException("maxRetryTimes must be in [0,5]");
    if (cbPolicyBps <= 0 || cbPolicyBps > 3000)
      throw new IllegalArgumentException("cbPolicyBps must be in (0,3000]");
    if (breakerThresholdBps <= 0 || breakerThresholdBps > 10000)
      throw new IllegalArgumentException("breakerThresholdBps out of range");
    if (cbPolicyBps >= breakerThresholdBps)
      throw new IllegalArgumentException("cbPolicyBps must be below breaker threshold");
    if (errorType == null) throw new IllegalArgumentException("errorType must not be null");
    if (elapsedMs < 0) throw new IllegalArgumentException("elapsed must be non-negative");
    if (attemptsDone < 0) throw new IllegalArgumentException("attemptsDone must be non-negative");

    int ceiling = rpcTimeoutMs * (maxRetryTimes + 1);
    boolean clamped = false;
    int effective;
    if (maxDurationMs <= 0) effective = ceiling;
    else if (maxDurationMs < rpcTimeoutMs + 1) { effective = rpcTimeoutMs + 1; clamped = true; }
    else if (maxDurationMs > ceiling) { effective = ceiling; clamped = true; }
    else effective = maxDurationMs;

    String d;
    if (streaming) d = "STOP_STREAMING";
    else if (!"TIMEOUT".equals(errorType) && !"CONNECT_FAIL".equals(errorType)) d = "STOP_NOT_RETRYABLE";
    else if ("TIMEOUT".equals(errorType) && !idempotent) d = "STOP_NOT_IDEMPOTENT";
    else if (chainStop && upstreamIsRetry) d = "STOP_CHAIN";
    else if (attemptsDone >= maxRetryTimes) d = "STOP_TRIES";
    else if (elapsedMs >= effective) d = "STOP_BUDGET";
    else if (!retrySameNode && candidateNode == lastNode) d = "STOP_SAME_NODE";
    else d = "RETRY";
    return clamped ? "CLAMPED|" + d : d;
  }
}"""

    naive = """public class Solution {
  // "重试配 3 次比较稳"版：不看预算、不看链路、不看幂等、不钳制配置，
  // 只要错误码像样就一直补到次数用完 —— 下游过载时被它自己的重试流量打死。
  public static String retryDecide(int rpcTimeoutMs, int maxRetryTimes, int maxDurationMs,
                                   int cbPolicyBps, int breakerThresholdBps, boolean chainStop,
                                   boolean upstreamIsRetry, boolean retrySameNode, boolean streaming,
                                   boolean idempotent, int elapsedMs, int attemptsDone,
                                   String errorType, int lastNode, int candidateNode) {
    if (rpcTimeoutMs <= 0) throw new IllegalArgumentException("rpcTimeout must be positive");
    if (maxRetryTimes < 0 || maxRetryTimes > 5)
      throw new IllegalArgumentException("maxRetryTimes must be in [0,5]");
    if (cbPolicyBps <= 0 || cbPolicyBps > 3000)
      throw new IllegalArgumentException("cbPolicyBps must be in (0,3000]");
    if (breakerThresholdBps <= 0 || breakerThresholdBps > 10000)
      throw new IllegalArgumentException("breakerThresholdBps out of range");
    if (cbPolicyBps >= breakerThresholdBps)
      throw new IllegalArgumentException("cbPolicyBps must be below breaker threshold");
    if (errorType == null) throw new IllegalArgumentException("errorType must not be null");
    if (elapsedMs < 0) throw new IllegalArgumentException("elapsed must be non-negative");
    if (attemptsDone < 0) throw new IllegalArgumentException("attemptsDone must be non-negative");
    if ("TIMEOUT".equals(errorType) || "CONNECT_FAIL".equals(errorType)) {
      if (attemptsDone < maxRetryTimes) return "RETRY";
    }
    return "STOP_TRIES";
  }
}"""

    statement = """## 背景

Kitex 的重试文档是这套题里约束最密集的一页【源 S4】，原文给的硬事实：

- 四类重试：异常重试 / Backup Request / Mixed / **建连失败默认重试**；
- **异常重试默认只对超时**；不做默认策略的官方理由是
  "因为很多业务请求不具有幂等性，这三类重试不会作为默认策略"；
- `MaxRetryTimes` 默认 2，**合法域 [0,5]**，0 即关闭；
- `MaxDurationMS` 若配置则**必须大于请求超时时间**，且
  **最大不超过 `RPCTimeout * (MaxRetryTimes + 1)`**；
- 停止策略 `CBPolicy` 默认 10%、合法域 `(0, 30%]`，且**须小于服务粒度的熔断阈值**；
- `ChainStop` 默认启用："如果上游请求是重试请求，不会重试"；
- `RetrySameNode` 默认 false；**流式接口不支持重试**。

## 任务

把上面那段文档实现成一个决策函数（一次调用判"**这一次失败之后还要不要再来一次**"）：

```java
public static String retryDecide(int rpcTimeoutMs, int maxRetryTimes, int maxDurationMs,
                                 int cbPolicyBps, int breakerThresholdBps, boolean chainStop,
                                 boolean upstreamIsRetry, boolean retrySameNode, boolean streaming,
                                 boolean idempotent, int elapsedMs, int attemptsDone,
                                 String errorType, int lastNode, int candidateNode)
```

## 决策顺序（**从上到下，命中即止**；返回值就是这一列的字符串）

| # | 条件 | 返回 | 文档依据 |
| --- | --- | --- | --- |
| 1 | `streaming == true` | `STOP_STREAMING` | 流式不支持重试 |
| 2 | `errorType` 不是 `TIMEOUT` 也不是 `CONNECT_FAIL` | `STOP_NOT_RETRYABLE` | 异常重试默认只对超时 |
| 3 | `errorType == TIMEOUT` 且 `idempotent == false` | `STOP_NOT_IDEMPOTENT` | 不幂等 ⇒ 不许默认重试 |
| 4 | `chainStop && upstreamIsRetry` | `STOP_CHAIN` | ChainStop 默认启用 |
| 5 | `attemptsDone >= maxRetryTimes` | `STOP_TRIES` | 次数用完 |
| 6 | `elapsedMs >= 有效预算` | `STOP_BUDGET` | 累计耗时（**含首次失败请求**） |
| 7 | `!retrySameNode && candidateNode == lastNode` | `STOP_SAME_NODE` | RetrySameNode 默认 false |
| 8 | 其余 | `RETRY` | — |

`errorType` 只接受 `TIMEOUT` / `CONNECT_FAIL` / `BUSINESS` / `FLOW_CONTROL` 四种取值。
**`CONNECT_FAIL` 不受第 3 条约束**：建连失败意味着请求根本没到达服务端，
重放不会产生第二次副作用 —— 这正是"建连失败默认重试"而超时不默认重试的原因。

## 有效预算与钳制

```
上界 ceiling = rpcTimeoutMs * (maxRetryTimes + 1)
maxDurationMs <= 0        ⇒ 未配置，有效预算 = ceiling，不算钳制
maxDurationMs <  rpcTimeoutMs + 1 ⇒ 抬到 rpcTimeoutMs + 1，算钳制
maxDurationMs >  ceiling            ⇒ 压到 ceiling，算钳制
```

发生钳制时，在正常返回值前面加 `"CLAMPED|"`（例如 `CLAMPED|STOP_BUDGET`）。
**配置越界要钳制而不是报错**：它的两个边界都是"保守化"方向
（往下限抬 = 少重试；往上限压 = 少重试），不改变任何人的意图。

反过来，`cbPolicyBps >= breakerThresholdBps` 必须**抛异常**：
这是**两个模块之间**的关系约束，把它钳制掉等于悄悄改掉了服务粒度熔断器的行为，
而熔断器的主人根本不知道自己被改了。

## 参数合法性（`IllegalArgumentException`，消息一字不差）

`rpcTimeout must be positive` / `maxRetryTimes must be in [0,5]` /
`cbPolicyBps must be in (0,3000]` / `breakerThresholdBps out of range` /
`cbPolicyBps must be below breaker threshold` / `errorType must not be null` /
`elapsed must be non-negative` / `attemptsDone must be non-negative`

## 这题真正考的东西

素材里那句"**重试风暴的三层刹车**"就是第 4、5、6 条：单次耗时上限、链路不级联、
重试占比不盖过熔断。少任何一层，"下游抖动 5%"都会变成"下游收到 3 倍流量"——
因为**每一跳都独立重试**，放大是乘法不是加法。

第二条分水岭是**优化哪个分位数**：异常重试提高的是整体成功率（均值），
Backup Request 降低的是尾延迟（p99）—— 两者代价完全不同，
后者是"明知第一次大概率会成功，仍然主动多打一份流量"。"""

    return base(
        'algorithms', 'senior',
        '重试决策函数：0-5 合法域、MaxDuration 上下界钳制、ChainStop 与幂等前置',
        statement, 'java-junit',
        ['retry-policy', 'timeout-budget', 'idempotency', 'retry-storm-brake',
         'modern:resilience-semantics'],
        src('服务端研发（Go 微服务治理与稳定性方向） 高级工程师',
            INFRA + '#4 考点 4（重试策略与幂等契约：四类重试、默认只对超时、MaxRetryTimes 2 与 [0-5]、'
            'MaxDurationMS 上下界、CBPolicy (0,30%] 且须小于熔断阈值、ChainStop、RetrySameNode、'
            '流式不支持）＋ §1.2 重试风暴的三层刹车'
            '（"钳制 vs 拒绝"的区分是【推】，题面按本题契约给出）'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'String retryDecide(int rpcTimeoutMs, int maxRetryTimes, int maxDurationMs, int cbPolicyBps, int breakerThresholdBps, boolean chainStop, boolean upstreamIsRetry, boolean retrySameNode, boolean streaming, boolean idempotent, int elapsedMs, int attemptsDone, String errorType, int lastNode, int candidateNode)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer="""## 参考答案要点

**顺序不是风格问题，是可判定性问题。**
`STOP_STREAMING` 必须排在 `STOP_NOT_RETRYABLE` 之前：流式接口拿不到"这一次的错误类型"
这种离散结论（它是帧序列），先判流式才能解释"为什么协议层就没有第二次机会"。
把第 4 条（ChainStop）放到第 5、6 条之后，用例「上游已经是重试请求」就会返回
`STOP_TRIES` 而不是 `STOP_CHAIN` —— 数字上都是"不重试"，
但**归因错了**：运维看到 `STOP_TRIES` 会去调大 `maxRetryTimes`，那正好放大风暴。
这就是"返回值要带原因"的全部理由。

**钳制用例「配置钳制：maxDuration 超过 rpcTimeout*(maxRetry+1)」算的是：**
`rpc=100, retries=2` ⇒ `ceiling = 100 * 3 = 300`；配的 `maxDuration=9999` 越界 ⇒
有效预算压到 300，`elapsed=250 < 300` ⇒ 仍走满整条链，最后返回
`CLAMPED|RETRY`。若不钳制而直接用 9999，这一条会**永远不会因预算停下**，
一次调用最坏占用 9.99 秒 —— 上游的超时早就到了，下游还在为它干活。

**第 6 条用 `>=`**：用例「耗时恰好等于有效预算即停止」里 `elapsed=300, 有效预算=300` ⇒
`STOP_BUDGET`。用 `>` 的实现在边界上多放一次请求，单次看起来无害，
但"预算"的定义就是**上游愿意为这条链路等的总时间**，超一秒就是违约。

**非幂等 + 超时 ⇒ 必须停**（用例「非幂等接口超时不重试」）。
注意超时是**结果未知**而不是"肯定失败"：服务端可能已经扣款成功、只是响应没回来。
不幂等时重试的代价是重复扣款，收益是一次大概率无用的重试 ——
不对称，所以文档把它做成默认关闭。
真要重试，缺的不是开关而是**幂等键**：`requestId` 落到写路径的唯一索引上，
让第二次请求在服务端被判成 no-op。**幂等键必须覆盖"重试"这条路径本身**，
否则重试请求会生成一个新的 requestId，等于什么都没做。

**朴素解为什么错**（参考 `naiveSolution`）：它只查次数，
于是 `STOP_CHAIN` / `STOP_BUDGET` / `STOP_SAME_NODE` / `STOP_NOT_IDEMPOTENT`
四条全被判成 `RETRY`。矩阵里它会挂在这四条上 —— 挂的原因不是"结果不对"而是
"该刹车的时候没刹车"，这正是重试风暴的成因。

**工程延伸（面试追问点）**

1. `DDLStop` 呢？（框架**未内置**，要 `retry.RegisterDDLStop(func)` 自己注册，
   官方建议"基于上游发起调用的时间戳和超时时间判断"。也就是说
   `elapsedMs` 这个参数在真实链路里不是本地计时器能给的，
   它要求**上游把发起时间与剩余预算随请求传下来**（RPC header / metadata）。
   没做这件事的系统，每一跳都只知道自己的超时，端到端超时是乘出来的。）
2. 配置优先级？（`Call Option > Client Option > TimeoutProvider`（动态），
   且超时错误**默认不重试**。优先级表要能背，因为"我明明配了 500ms"最常见的答案是
   "被上一层的 Call Option 覆盖了"。）
3. `ConnTimeout` 与 `RPCTimeout` 的区别？（默认 50ms / 0；**0 是不限时**，
   这是文档里最容易被忽略的默认值 —— 不显式配超时的服务，
   一次调用的上界是 TCP 层的 keepalive，而不是任何业务能理解的量。）
4. Backup Request 和异常重试能同时开吗？（可以（Mixed），但要重算放大倍数：
   Backup 是"未失败也补一发"，它给**每一次**调用都追加一份流量，
   而异常重试只在失败时追加。两者叠在 5 跳链路上时，
   最坏倍数是每跳 `(1 + retries)` 的乘积，不是加法。）""",
    )


# =================================================================== A3 服务端限流：令牌桶 + 连接数
@draft('alg-bd-server-limiter')
def q_server_limiter():
    UNIT = 1000000

    def simulate(qps, burst, max_conn, arrivals, holds, grpc):
        if qps <= 0:
            raise ModelError('qps must be positive')
        if burst < 1:
            raise ModelError('burst must be at least 1')
        if max_conn < 1:
            raise ModelError('maxConnections must be positive')
        if arrivals is None or holds is None or grpc is None:
            raise ModelError('input arrays must not be null')
        if not (len(arrivals) == len(holds) == len(grpc)):
            raise ModelError('input arrays must have the same length')
        for i, a in enumerate(arrivals):
            if i > 0 and a < arrivals[i - 1]:
                raise ModelError('arrivals must be non-decreasing')
            if holds[i] < 0:
                raise ModelError('hold must be non-negative')
            if grpc[i] not in (0, 1):
                raise ModelError('grpc must be 0 or 1')

        cap = burst * UNIT
        credit = cap
        last = arrivals[0] if arrivals else 0
        allowed = rejected_qps = rejected_conn = 0
        ends = []
        for i, a in enumerate(arrivals):
            now = a
            gain = (now - last) * 1000 * qps
            if gain > 0:
                credit = min(cap, credit + gain)
                last = now
            ends = [e for e in ends if e > now]
            if len(ends) >= max_conn:
                rejected_conn += 1
                continue
            if grpc[i] == 0:
                if credit < UNIT:
                    rejected_qps += 1
                    continue
                credit -= UNIT
            allowed += 1
            ends.append(now + holds[i])
        return [allowed, rejected_qps, rejected_conn, credit // UNIT]

    cases = [
        jcase('基线：令牌桶与连接数各拒一次',
              [10, 2, 2, [0, 20, 40, 120, 140], [100, 100, 100, 10, 10], [0, 0, 0, 0, 0]], simulate),
        jcase('协议盲区：gRPC 请求绕不过连接数限流，但 QPS 桶管不到它',
              [10, 2, 2, [0, 20, 40, 120, 140], [100, 100, 100, 10, 10], [0, 0, 0, 0, 1]], simulate,
              note='最后一条 grpc=1 ⇒ 不扣令牌，于是它的放行与 QPS 无关，'
                   '这正是"QPS 限流对 gRPC 不生效"的建模'),
        jcase('边界：桶容量 1 时同一毫秒只放一条，其余按 QPS 拒',
              [1000, 1, 100, [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]], simulate),
        jcase('边界：连接数先于 QPS 拒绝（检查顺序是可观测的）',
              [10, 5, 1, [0, 10, 20, 30], [100, 100, 100, 100], [0, 0, 0, 0]], simulate,
              note='末位是 4 而不是 1 ⇒ 被连接数拒的那 3 条**没有**扣令牌。'
                   '顺序颠倒或"先扣再退"都会把这一位算成 1'),
        jcase('退化：空到达序列 ⇒ 一个都没拒，令牌原封不动是 burst',
              [50, 3, 4, [], [], []], simulate),
        jcase('桶有上限：长时间空闲不会攒出超过 burst 的突发额度',
              [10, 2, 5, [0, 100000], [10, 10], [0, 0]], simulate,
              note='100 秒只补到 2 个令牌 ⇒ 最后剩余仍是 2，不是 1002'),
        jcase('非法：qps 为 0',
              [0, 2, 2, [0], [1], [0]], simulate,
              throws='IllegalArgumentException', throws_message='qps must be positive'),
        jcase('非法：三条数组长度不一致',
              [10, 2, 2, [0, 10], [5], [0]], simulate,
              throws='IllegalArgumentException',
              throws_message='input arrays must have the same length'),
        jcase('非法：到达时间倒流',
              [10, 2, 2, [100, 50], [5, 5], [0, 0]], simulate,
              throws='IllegalArgumentException',
              throws_message='arrivals must be non-decreasing'),
        jcase('非法：突发容量小于 1',
              [10, 0, 2, [0], [5], [0]], simulate,
              throws='IllegalArgumentException', throws_message='burst must be at least 1'),
        jcase('非法：连接标志不是 0/1',
              [10, 2, 2, [0], [5], [2]], simulate,
              throws='IllegalArgumentException', throws_message='grpc must be 0 or 1'),
    ]

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  private static final long UNIT = 1000000L;

  public static int[] limiterSimulate(int qps, int burst, int maxConnections,
                                      int[] arrivalsMs, int[] holdMs, int[] grpc) {
    if (qps <= 0) throw new IllegalArgumentException("qps must be positive");
    if (burst < 1) throw new IllegalArgumentException("burst must be at least 1");
    if (maxConnections < 1) throw new IllegalArgumentException("maxConnections must be positive");
    if (arrivalsMs == null || holdMs == null || grpc == null)
      throw new IllegalArgumentException("input arrays must not be null");
    if (arrivalsMs.length != holdMs.length || arrivalsMs.length != grpc.length)
      throw new IllegalArgumentException("input arrays must have the same length");
    for (int i = 0; i < arrivalsMs.length; i++) {
      if (i > 0 && arrivalsMs[i] < arrivalsMs[i - 1])
        throw new IllegalArgumentException("arrivals must be non-decreasing");
      if (holdMs[i] < 0) throw new IllegalArgumentException("hold must be non-negative");
      if (grpc[i] != 0 && grpc[i] != 1) throw new IllegalArgumentException("grpc must be 0 or 1");
    }

    long cap = (long) burst * UNIT;
    long credit = cap;
    long last = arrivalsMs.length == 0 ? 0L : arrivalsMs[0];
    int allowed = 0, rejectedQps = 0, rejectedConn = 0;
    List<Long> ends = new ArrayList<>();
    for (int i = 0; i < arrivalsMs.length; i++) {
      long now = arrivalsMs[i];
      long gain = (now - last) * 1000L * qps;
      if (gain > 0) { credit = Math.min(cap, credit + gain); last = now; }
      List<Long> live = new ArrayList<>();
      for (Long e : ends) if (e > now) live.add(e);
      ends = live;
      if (ends.size() >= maxConnections) { rejectedConn++; continue; }
      if (grpc[i] == 0) {
        if (credit < UNIT) { rejectedQps++; continue; }
        credit -= UNIT;
      }
      allowed++;
      ends.add(now + holdMs[i]);
    }
    return new int[] {allowed, rejectedQps, rejectedConn, (int) (credit / UNIT)};
  }
}"""

    naive = """public class Solution {
  // "限流就是配个 QPS"版：只有秒级计数、没有桶、没有连接数维度，
  // 于是一秒钟边界上能放 2 倍流量，且 gRPC 与 Thrift 被同一把尺子量。
  public static int[] limiterSimulate(int qps, int burst, int maxConnections,
                                      int[] arrivalsMs, int[] holdMs, int[] grpc) {
    if (qps <= 0) throw new IllegalArgumentException("qps must be positive");
    if (burst < 1) throw new IllegalArgumentException("burst must be at least 1");
    if (maxConnections < 1) throw new IllegalArgumentException("maxConnections must be positive");
    if (arrivalsMs == null || holdMs == null || grpc == null)
      throw new IllegalArgumentException("input arrays must not be null");
    if (arrivalsMs.length != holdMs.length || arrivalsMs.length != grpc.length)
      throw new IllegalArgumentException("input arrays must have the same length");
    for (int i = 0; i < arrivalsMs.length; i++) {
      if (i > 0 && arrivalsMs[i] < arrivalsMs[i - 1])
        throw new IllegalArgumentException("arrivals must be non-decreasing");
      if (holdMs[i] < 0) throw new IllegalArgumentException("hold must be non-negative");
      if (grpc[i] != 0 && grpc[i] != 1) throw new IllegalArgumentException("grpc must be 0 or 1");
    }
    int allowed = 0, rejected = 0;
    long windowSec = -1, inWindow = 0;
    for (int i = 0; i < arrivalsMs.length; i++) {
      long sec = arrivalsMs[i] / 1000;
      if (sec != windowSec) { windowSec = sec; inWindow = 0; }
      if (inWindow >= qps) { rejected++; continue; }
      inWindow++;
      allowed++;
    }
    return new int[] {allowed, rejected, 0, qps};
  }
}"""

    statement = """## 背景

Kitex 的服务端限流文档给了四件可核查的事实【源 S3】：

1. 限流有**两个独立维度**：`MaxConnections`（连接数）与 `MaxQPS`，
   默认实现分别是**计数器**与**令牌桶**；
2. `WithLimit` 与 `WithQPSLimiter/WithConnectionLimiter` 同时配置时**只有后者生效**（覆盖规则）；
3. 默认 QPS 限流在非多路复用下挂在 **OnRead**（省掉反序列化开销），
   多路复用或自定义限流器才放 **OnMessage**（要拿到 method 才能按方法限流）；
4. **只对 Thrift 与 Kitex Protobuf 协议生效，对 gRPC 暂不生效** ——
   gRPC 要靠 HTTP/2 流控窗口（`WithGRPCInitialWindowSize` / `WithGRPCInitialConnWindowSize`）。

## 任务

```java
public static int[] limiterSimulate(int qps, int burst, int maxConnections,
                                    int[] arrivalsMs, int[] holdMs, int[] grpc)
```

第 i 个请求在 `arrivalsMs[i]` 毫秒到达，若被放行则占用连接 `holdMs[i]` 毫秒
（`grpc[i] == 1` 表示这条流量走 gRPC）。
返回 `{放行数, 被 QPS 拒数, 被连接数拒数, 结束时剩余令牌数(向下取整)}`。

## 契约

**令牌桶**：容量 `burst` 个令牌，速率 `qps` 个/秒。初始**满桶**（`burst` 个），
从**第一个到达时刻**开始计时（不许把 1970 年到现在的时间也算成补给）。
每个令牌拆成 `1_000_000` 微信用量做**整数**运算：

```
本次补给（微信用量） = (now - last) * 1000 * qps
credit = min(burst * 1_000_000, credit + 补给)
```

只有"确实有补给"时才推进 `last`（同一毫秒内的多条请求不许把 `last` 挪来挪去）。
放行一个非 gRPC 请求消耗 `1_000_000`；不足则**按 QPS 拒**。

**判定顺序：先连接数，再令牌桶。** 三条理由，都要能说出来：
连接数是**资源**维度（拒绝是免费的，不用反序列化），
QPS 是**吞吐**维度；先查便宜的那个。
被任一维度拒绝的请求**既不占连接也不消耗令牌**
（它当场就返回限流错误了）。

**连接数**：某请求在 `now` 时刻算"活跃"，当且仅当它被放行且
`arrival + hold > now`（**严格大于**：同一毫秒正好释放的连接不再占用名额）。
活跃数 `>= maxConnections` ⇒ 按连接数拒。

**gRPC 是协议盲区**：`grpc[i] == 1` 时**跳过令牌桶判定**（不扣令牌、也不会因令牌不足被拒），
但**仍然受连接数限制**。这条建模的意义：限流器挂在解码之前，
gRPC 的流量走的是另一条传输路径，框架的 QPS 计数器根本看不到它 ——
而连接是共享的，所以连接维度仍然有效。

## 合法性（`IllegalArgumentException`，消息一字不差）

`qps must be positive` / `burst must be at least 1` / `maxConnections must be positive` /
`input arrays must not be null` / `input arrays must have the same length` /
`arrivals must be non-decreasing` / `hold must be non-negative` / `grpc must be 0 or 1`

## 这题真正考的东西

**"限流就是配个 QPS"漏掉的是另一半：谁在占着你的进程。**
QPS 桶只约束"每秒进来多少"，不约束"同时在跑多少"。
下游 RT 从 20ms 恶化到 2s 时，100 QPS 的限制仍然放行 100 条/秒，
同时在途的请求从 2 个变成 200 个 —— 线程、连接、堆全部被拖走，
**限流器自己成了压死服务的最后一根稻草**。
连接数（并发数）维度是唯一能拦住这一类的。

第二件：**令牌桶与秒级计数器的差别就在桶边界。**
秒级计数器在 `t=0.99s` 和 `t=1.01s` 各放满一秒的量 ⇒ 20ms 内 2 倍突发。
朴素实现挂在这里（`naiveSolution` 就是这个写法），
而用例「边界：桶容量 1 时同一毫秒只放一条」正是它和令牌桶分岔的那一条。"""

    return base(
        'algorithms', 'senior',
        '服务端限流两个维度：令牌桶与连接数配额，以及 gRPC 这个协议盲区',
        statement, 'java-junit',
        ['rate-limiting', 'token-bucket', 'connection-quota', 'protocol-blindspot',
         'modern:resilience-semantics'],
        src('服务端研发（Go 微服务治理与稳定性方向） 高级工程师',
            INFRA + '#4 考点 3（服务端限流：QPS、连接数与协议盲区：令牌桶与计数器、'
            'OnRead vs OnMessage、gRPC 不生效、UpdateLimit、LimitReporter）'
            '＋ §1.1 服务端"连接数限流 + QPS 限流"'
            '（"先连接数后 QPS"与"gRPC 仍受连接数约束"是【推】，题面已标明为本题建模）'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'int[] limiterSimulate(int qps, int burst, int maxConnections, int[] arrivalsMs, int[] holdMs, int[] grpc)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer="""## 参考答案要点

**基线用例 `{10, 2, 2, [0,20,40,120,140], [100,100,100,10,10], 全 Thrift}` 逐步算**
（credit 以"令牌"为单位，`1 令牌 = 1_000_000` 微信用量；`qps=10` ⇒ 每 100ms 补一个）：

| 到达 | 补给后 credit | 活跃连接 | 判定 |
| --- | --- | --- | --- |
| 0 | 2.0（初始满桶） | 0 | 放行 ⇒ 占连接至 100，之后 credit 1.0 |
| 20 | 1.0 + 0.2 = 1.2 | 1 | 放行 ⇒ 占至 120，之后 credit 0.2 |
| 40 | 0.2 + 0.2 = 0.4 | 2 | **连接数已满 ⇒ 拒**（不扣令牌） |
| 120 | 0.4 + 0.8 = 1.2 | 0（两条都在 120 释放，判据是严格大于） | 放行，之后 credit 0.2 |
| 140 | 0.2 + 0.2 = 0.4 | 1 | **令牌不足 ⇒ 拒** |

⇒ `{3, 1, 1, 0}`。两个拒因各出现一次，而且**判定顺序是可观测的**：
第 3 条（40ms）到达时桶里只剩 `0.4` 个令牌，若把两个检查颠倒成"先 QPS 后连接数"，
它会被算成 QPS 拒；同理最后一条也会 ⇒ 基线用例变成 `{3, 2, 0, 0}`，
`rejectedConn` 直接归零 —— **"该扩并发还是该压速率"这个决策就建立在最后两个数的分布上**。
真正钉死"被拒的请求不许扣令牌"的是用例
「边界：连接数先于 QPS 拒绝（检查顺序是可观测的）」：
`qps=10 / burst=5 / maxConn=1`，四条请求都落在 30ms 内 ⇒
只放行 1 条、3 条全被连接数拒，剩余令牌是 `4`（4.3 向下取整：只被扣过一次，加 0.3 个补给），
任何"先扣再退"的实现都会把它算成 `1`。

**gRPC 那条与基线只差最后一位标志 ⇒ `{4, 0, 1, 0}`**：
最后一条走 gRPC，跳过令牌判定，于是"桶里没有令牌"这件事完全不拦它。
**这就是协议盲区的全部含义 —— 不是"限流更严"，是那一路流量根本不计数。**
答"给 gRPC 也配一个 QPS 限制"是错的：真实系统里要配的是 HTTP/2 流控窗口
（`InitialWindowSize` / `InitialConnWindowSize`），那是**字节配额**不是**请求速率**，
两者不可互换 —— 前者防的是慢消费者占满连接，后者防的是过载。

**"长时间空闲不许攒出超过 burst 的突发"**（用例「桶有上限」）：
`qps=10 / burst=2`，两条请求之间隔了 100 秒 —— 按速率补给早就超过整桶容量，
所以 `min(cap, credit + 补给)` 把它截回 2 个令牌；放行第二条之后剩 1 ⇒ `{2, 0, 0, 1}`。
**桶的意义就是给突发限额**：没有那个 `min`，
一个空闲十分钟的实例会在下一秒被打进十分钟总量级别的请求 ——
那是最典型的"限流器自己放大故障"。

**朴素解为什么必挂**：它按秒切片计数、不看桶、不看连接数、也不区分协议。
在基线用例上它对第 3 条给出"按 QPS 拒"而不是"按连接数拒"，
在「边界：桶容量 1」上它会把 5 条全放行（`qps=1000` 一秒内远没到 1000），
第 4 位返回写死的 `qps` 更是必然与真实剩余令牌不符。

**工程延伸（面试追问点）**

1. 为什么默认放 OnRead？（省一次反序列化；代价是**看不到 method**，
   所以"按接口分档限流"必须挪到 OnMessage —— 这是性能与信息量的显式取舍，
   素材 §2 追问 4 原问题。）
2. 多实例怎么共享桶？（单机桶在 N 个实例下等效于 `N × qps`。共享要么走 Redis
   （一次往返、且**桶服务挂了要决定放行还是拒绝** —— 放行是保吞吐、拒绝是保下游，
   必须显式选一个并把降级率打点），要么走"总配额 / 实例数 + 定期再平衡"，
   后者会瞬时超限但零依赖。详见本批的 redis 题。）
3. 动态改阈值要不要重置桶？（不该。`Updater.UpdateLimit` 换的是速率与容量参数，
   **已积累的 credit 属于旧配置的时间轴**：把桶清空会让刚放宽的限流照样拒一批，
   把桶填满则等于给新限制开了一张空票。）
4. 可观测？（`LimitReporter` 的 `ConnOverloadReport` / `QPSOverloadReport` 两个回调，
   对应两个拒因 —— **拒因必须分开统计**，混成一个"被限流 N 次"就没法判断
   该扩并发还是该压速率。这也是本题返回四个数而不是一个数的原因。）""",
    )


# =================================================================== A4 平滑加权轮询的执行轨迹
@draft('alg-bd-weighted-round-robin')
def q_weighted_round_robin():
    GOLDEN = 0x9E3779B97F4A7C15

    def trace(weights, picks):
        if weights is None or len(weights) == 0:
            raise ModelError('weights must not be empty')
        for w in weights:
            if w <= 0:
                raise ModelError('weight must be positive')
        if picks <= 0:
            raise ModelError('picks must be positive')
        if picks > 1000:
            raise ModelError('picks too large')
        total = sum(weights)
        if total > 100000:
            raise ModelError('weights sum too large')
        cw = [0] * len(weights)
        seq = []
        counts = [0] * len(weights)
        for _ in range(picks):
            for i, w in enumerate(weights):
                cw[i] += w
            best = 0
            for i in range(1, len(cw)):
                if cw[i] > cw[best]:
                    best = i
            cw[best] -= total
            seq.append(best)
            counts[best] += 1
        return ','.join(str(s) for s in seq) + '|' + ','.join(str(c) for c in counts)

    cases = [
        jcase('基线：权重全相等 ⇒ 严格退化成纯轮询（文档明写这条优化）',
              [[1, 1, 1], 6], trace),
        jcase('计数正确但顺序不匀：权重 3:1 的前四次是 0,0,1,0',
              [[3, 1], 4], trace),
        jcase('边界：权重有公约数 2:4 ⇒ 周期是"权重和 / 最大公约数"而不是实例数',
              [[2, 4], 6], trace),
        jcase('极端：权重差 100 倍 ⇒ 连续 5 次全打同一个实例（inflight 均摊在这里失效）',
              [[100, 1], 5], trace),
        jcase('边界：只有一个实例 ⇒ 永远选它，权重值毫无意义',
              [[5], 3], trace),
        jcase('退化：只选一次 ⇒ 平局时取最小下标',
              [[7, 3], 1], trace),
        jcase('两实例等权重奇数次 ⇒ 先选的那个多一次',
              [[4, 4], 3], trace),
        jcase('非法：实例列表为空', [[], 3], trace,
              throws='IllegalArgumentException', throws_message='weights must not be empty'),
        jcase('非法：权重含 0（会永远选不中，形成静默下线）',
              [[2, 0], 3], trace,
              throws='IllegalArgumentException', throws_message='weight must be positive'),
        jcase('非法：选取次数为 0', [[1], 0], trace,
              throws='IllegalArgumentException', throws_message='picks must be positive'),
        jcase('非法：选取次数超过题面上限', [[1], 1001], trace,
              throws='IllegalArgumentException', throws_message='picks too large'),
        jcase('非法：权重总和超过题面上限', [[60000, 60000], 2], trace,
              throws='IllegalArgumentException', throws_message='weights sum too large'),
    ]

    reference = """public class Solution {
  public static String wrrTrace(int[] weights, int picks) {
    if (weights == null || weights.length == 0)
      throw new IllegalArgumentException("weights must not be empty");
    for (int w : weights) if (w <= 0) throw new IllegalArgumentException("weight must be positive");
    if (picks <= 0) throw new IllegalArgumentException("picks must be positive");
    if (picks > 1000) throw new IllegalArgumentException("picks too large");
    int total = 0;
    for (int w : weights) total += w;
    if (total > 100000) throw new IllegalArgumentException("weights sum too large");

    int n = weights.length;
    long[] cw = new long[n];
    int[] counts = new int[n];
    StringBuilder seq = new StringBuilder();
    for (int k = 0; k < picks; k++) {
      for (int i = 0; i < n; i++) cw[i] += weights[i];
      int best = 0;
      for (int i = 1; i < n; i++) if (cw[i] > cw[best]) best = i;
      cw[best] -= total;
      if (k > 0) seq.append(',');
      seq.append(best);
      counts[best]++;
    }
    StringBuilder cnt = new StringBuilder();
    for (int i = 0; i < counts.length; i++) {
      if (i > 0) cnt.append(',');
      cnt.append(counts[i]);
    }
    return seq + "|" + cnt;
  }
}"""

    naive = """public class Solution {
  // "加权随机"版：每次都选权重最大的那个 —— 比例长期是对的，
  // 但短期内把同一个实例打死，正是文档要避免的 inflight 堆积。
  public static String wrrTrace(int[] weights, int picks) {
    if (weights == null || weights.length == 0)
      throw new IllegalArgumentException("weights must not be empty");
    for (int w : weights) if (w <= 0) throw new IllegalArgumentException("weight must be positive");
    if (picks <= 0) throw new IllegalArgumentException("picks must be positive");
    if (picks > 1000) throw new IllegalArgumentException("picks too large");
    int total = 0;
    for (int w : weights) total += w;
    if (total > 100000) throw new IllegalArgumentException("weights sum too large");
    int best = 0;
    for (int i = 1; i < weights.length; i++) if (weights[i] > weights[best]) best = i;
    int[] counts = new int[weights.length];
    StringBuilder seq = new StringBuilder();
    for (int k = 0; k < picks; k++) {
      if (k > 0) seq.append(',');
      seq.append(best);
      counts[best]++;
    }
    StringBuilder c = new StringBuilder();
    for (int i = 0; i < counts.length; i++) c.append(i == 0 ? "" : ",").append(counts[i]);
    return seq + "|" + c;
  }
}"""

    statement = """## 背景

Kitex 的负载均衡文档把"默认为什么是 `WeightedRoundRobin`"写得很具体【源 S5】：

- 目的是"**能让所有下游实例拥有最小的同时 inflight 请求数，以减少下游过载情况的发生**"；
- "**当权重全部相等时退化为纯轮询**，以节省开销"；
- `InterleavedWeightedRoundRobin` 解决的是空间复杂度：
  WRR 的空间是"最小正周期（权重和 / 权重最大公约数）"，interleaved 版是实例数，
  "在下游实例数权重总和非常大时更节省空间"；
- `Alias Method`（Vose's Alias）O(n) 建表、O(1) 选取，"选取效率比 WeightedRandom 更高"；
- 一致性哈希是**警告式**表述："如果你不了解什么是一致性哈希，或者不知道带来的副作用，请勿使用"。

## 任务

实现教科书式的**平滑加权轮询**（Nginx / Dubbo 同款），并输出可核对的执行轨迹：

```java
public static String wrrTrace(int[] weights, int picks)
```

`weights[i]` 是实例 i 的权重（正整数），要选 `picks` 次。返回：

```
"<每次选中的实例下标，逗号分隔>|<每个实例被选中的总次数，逗号分隔>"
```

## 算法（**照这个实现，不要自己发明**）

每个实例维护一个 `currentWeight`，初值 0。每一轮：

1. 所有实例 `currentWeight += weight`；
2. 选 `currentWeight` **最大**的那个实例；**并列时取下标最小者**；
3. 被选中的实例 `currentWeight -= totalWeight`（`totalWeight` 是所有权重之和，固定值）。

平局规则不是可有可无的细节：不定义它，"权重全相等 ⇒ 严格 0,1,2,0,1,2 轮转"这条
就无法断言（并列取最大下标会得到完全不同的序列）。

## 合法性（`IllegalArgumentException`，消息一字不差）

`weights must not be empty` / `weight must be positive` / `picks must be positive` /
`picks too large`（上限 1000）/ `weights sum too large`（权重和上限 100000）

后两条上限是本题为了"输出可读、判题可算"加的约束，不是框架限制。
真实框架里权重和可以很大 —— **那正是 `Interleaved` 版本存在的理由**：
朴素 WRR 想做到"每个周期内比例精确"需要维护最小正周期长度的表，
而周期长度是 `权重和 / gcd(权重)`，权重一大就爆。

## 这题真正考的东西

把序列和计数**分开输出**是本题的核心设计：只看计数，`{3,1}` 与 `{0,0,1,0}` 与
`{0,0,0,1}` 全都在 4 次里选中 3 次实例 0 —— **比例完全一样，过载风险天差地别**。
文档说 WRR 的目标是"最小的同时 inflight"，那是一句关于**序列**的断言，
不是关于比例的断言；只用比例验证负载均衡的实现，永远发现不了连续命中同一实例的问题。

用例「极端：权重差 100 倍」给出的是这条算法的**真实短板**：`[100,1]` 选 5 次得到
连续的 0 —— 平滑性只在权重接近时成立。要理解为什么字节系还要有
interleaved 版和"最快请求探测"这类权重来源，就得先看到朴素版的失败模式。"""

    return base(
        'algorithms', 'senior',
        '平滑加权轮询的执行轨迹：比例对了不等于 inflight 均摊，序列才是考点',
        statement, 'java-junit',
        ['load-balancer', 'weighted-round-robin', 'inflight', 'tie-breaking',
         'modern:service-governance'],
        src('服务端研发（Go 微服务治理方向） 高级工程师',
            INFRA + '#4 考点 5（负载均衡算法的取舍与代价：默认 WRR 与 inflight 目的、'
            '等权重退化轮询、Interleaved 空间复杂度、别名法 O(n)/O(1)、一致性哈希警告）'
            '＋ §1.3；"平局取下标最小"与两条上限是【推】（题面已写成本题契约）'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'String wrrTrace(int[] weights, int picks)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer="""## 参考答案要点

三步循环，关键是 `cw[best] -= total` 用的是**权重总和**而不是被选中者的权重 ——
写成后者会退化成"每次都选同一个"（这正是 `naiveSolution` 的行为：它连 `cw` 都不维护）。

**基线 `[1,1,1]` 选 6 次 ⇒ `"0,1,2,0,1,2|2,2,2"`**：
每轮 `cw` 都出现三方并列，"并列取下标最小"把序列钉成严格轮转。
这就是文档那句"权重全部相等时退化为纯轮询"的可断言形式。
**去掉平局规则的实现会给出别的顺序，但计数仍是 `2,2,2`** ——
所以返回值的左半边（序列）不是装饰，它是这条退化性质唯一的落点。

**`[3,1]` 选 4 次 ⇒ `"0,0,1,0|3,1"`**：
第 2 轮出现 `cw = [2, 2]` 的并列，取最小下标又选中 0 ⇒ 头两次连着打实例 0。
比例正确、**inflight 不匀**。这就是"序列与计数分开"的价值。

**边界 `[2,4]` 选 6 次 ⇒ `"1,0,1,1,0,1|2,4"`**：
权重和 6、gcd 2 ⇒ 最小正周期长度只有 3（`6 / 2`），
所以序列是 `1,0,1` 重复两遍 —— 第 3、4 次之间出现连续两次命中实例 1，
平滑性同样只在周期内成立。
把它和"朴素 WRR 需要维护周期长度的表"连起来看，就是 interleaved 版的动机。

**极端 `[100,1]` 选 5 次 ⇒ `"0,0,0,0,0|5,0"`**：
`cw` 永远追不上差距 ⇒ 实例 1 一次都没被选中。
**一个权重差两个数量级的配置，可以让小实例彻底闲置、大实例独自承压** ——
"平滑"这个词在权重悬殊时是不成立的，这是 WRR 类算法共同的失效模式，
也是"权重从哪来"（注册中心元数据 / 主动健康检查 / 最快请求探测）比算法本身
更值得追问的原因。

**退化与非法用例的作用**：`[5]` 选 3 次 ⇒ `"0,0,0|3"`（单实例时权重是噪声）；
`[7,3]` 选 1 次 ⇒ `"0|1,0"`（第一轮全是 0，靠平局规则取胜者）；
`[2, 0]` 必须抛错而不是"权重 0 就跳过"——
静默跳过会让一台机器**永远接不到流量却仍在注册中心里**，
这是比崩溃更贵的故障形态。

**工程延伸（面试追问点）**

1. 别名法在这里能换成什么？（O(1) 选取，代价是**每次选取互相独立** ⇒
   它是加权**随机**，短期分布会出现长连续段，比 WRR 更不利于 inflight 均摊。
   文档给它的定位是"选取效率比 WeightedRandom 更高"，不是"比 WRR 更平滑"。）
2. 实例上下线怎么办？（朴素 WRR 的状态只有 `cw` 数组，增删实例影响有限；
   一致性哈希则会发生**迁移放大** —— 见本批 A/B 分桶题与 hot 短题。）
3. 为什么还要 `IsActive` 类健康检查？（负载均衡只看权重，不知道实例是否已经卡死；
   权重来自注册中心 ⇒ 更新滞后一个心跳周期。素材 §2 追问"权重从哪来"就是这个。）""",
    )


# =================================================================== A5 两次哈希构造正交流量层
@draft('alg-bd-ab-orthogonal-buckets')
def q_ab_orthogonal():
    GOLDEN = 0x9E3779B97F4A7C15
    M64 = (1 << 64) - 1

    def mix(z):
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & M64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & M64
        return (z ^ (z >> 31)) & M64

    def bucket_of(uid, salt, buckets):
        return (mix(((uid * GOLDEN) + salt) & M64) >> 1) % buckets

    def joint(salt_a, salt_b, buckets, users):
        if salt_a < 0 or salt_b < 0:
            raise ModelError('salt must be non-negative')
        if buckets <= 0:
            raise ModelError('buckets must be positive')
        if buckets > 8:
            raise ModelError('buckets too large')
        if users < 0:
            raise ModelError('users must be non-negative')
        if users > 200000:
            raise ModelError('users too large')
        cells = [0] * (buckets * buckets)
        for u in range(users):
            cells[bucket_of(u, salt_a, buckets) * buckets + bucket_of(u, salt_b, buckets)] += 1
        bsq = buckets * buckets
        dev = 0
        if users > 0:
            for c in cells:
                d = abs(c * bsq - users) * 10000 // users
                dev = max(dev, d)
        return cells + [dev]

    cases = [
        jcase('基线：两个不同 salt ⇒ 联合分布接近均匀，最大偏差是万分比量级',
              [1, 2, 2, 4000], joint,
              note='前 4 个数是 2x2 联合列联表（按 A 层桶行优先），最后一个数是最大偏差万分比'),
        jcase('关键：salt 相同时两层流量完全重叠 ⇒ 正交性当场破产',
              [7, 7, 2, 4000], joint,
              note='非对角格子全是 0：命中 A1 的用户必然同时命中 B1，'
                   '"B1 组指标涨了"永远无法归因给 B1'),
        jcase('边界：桶数取 1 ⇒ 只有一个格子，偏差恒为 0（正交是空真命题）',
              [1, 9, 1, 500], joint),
        jcase('退化：零个用户 ⇒ 全零表且偏差记 0，不做除零',
              [1, 2, 2, 0], joint),
        jcase('边界：用户数少于格子数 ⇒ 必有空格子，偏差仍要如实报出来',
              [3, 4, 2, 3], joint),
        jcase('加细粒度：4 桶两层 8000 人 ⇒ 16 格 + 偏差',
              [11, 23, 4, 8000], joint),
        jcase('互斥域同 salt：换桶数后仍然完全重叠（同域=同哈希，这是定义不是巧合）',
              [5, 5, 4, 3200], joint),
        jcase('非法：桶数为 0', [1, 2, 0, 10], joint,
              throws='IllegalArgumentException', throws_message='buckets must be positive'),
        jcase('非法：salt 为负（salt 是盐不是有符号偏移）', [1, -2, 2, 10], joint,
              throws='IllegalArgumentException', throws_message='salt must be non-negative'),
        jcase('非法：用户数为负', [1, 2, 2, -1], joint,
              throws='IllegalArgumentException', throws_message='users must be non-negative'),
        jcase('非法：桶数超过题面上限', [1, 2, 9, 100], joint,
              throws='IllegalArgumentException', throws_message='buckets too large'),
    ]

    reference = """public class Solution {
  private static long mix(long z) {
    z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
    z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
    return z ^ (z >>> 31);
  }

  private static int bucketOf(long uid, int salt, int buckets) {
    long h = mix(uid * 0x9E3779B97F4A7C15L + salt);
    return (int) ((h >>> 1) % buckets);
  }

  public static int[] abJoint(int saltA, int saltB, int buckets, int users) {
    if (saltA < 0 || saltB < 0) throw new IllegalArgumentException("salt must be non-negative");
    if (buckets <= 0) throw new IllegalArgumentException("buckets must be positive");
    if (buckets > 8) throw new IllegalArgumentException("buckets too large");
    if (users < 0) throw new IllegalArgumentException("users must be non-negative");
    if (users > 200000) throw new IllegalArgumentException("users too large");

    int[] cells = new int[buckets * buckets];
    for (int u = 0; u < users; u++) {
      int a = bucketOf(u, saltA, buckets);
      int b = bucketOf(u, saltB, buckets);
      cells[a * buckets + b]++;
    }
    int bsq = buckets * buckets;
    long dev = 0;
    if (users > 0) {
      for (int c : cells) {
        long d = (long) c * bsq - users;
        if (d < 0) d = -d;
        d = d * 10000L / users;
        if (d > dev) dev = d;
      }
    }
    int[] out = new int[cells.length + 1];
    System.arraycopy(cells, 0, out, 0, cells.length);
    out[cells.length] = (int) dev;
    return out;
  }
}"""

    naive = """public class Solution {
  // "分层随机就行"版：两层共用同一个哈希（只是取模的桶数不同）。
  // 每一层各自的边际分布都完美均匀 —— 只有联合分布看得见它坏在哪。
  private static long mix(long z) {
    z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
    z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
    return z ^ (z >>> 31);
  }

  public static int[] abJoint(int saltA, int saltB, int buckets, int users) {
    if (saltA < 0 || saltB < 0) throw new IllegalArgumentException("salt must be non-negative");
    if (buckets <= 0) throw new IllegalArgumentException("buckets must be positive");
    if (buckets > 8) throw new IllegalArgumentException("buckets too large");
    if (users < 0) throw new IllegalArgumentException("users must be non-negative");
    if (users > 200000) throw new IllegalArgumentException("users too large");
    int[] cells = new int[buckets * buckets];
    for (int u = 0; u < users; u++) {
      long h = mix(u * 0x9E3779B97F4A7C15L + saltA) >>> 1;
      int a = (int) (h % buckets);
      int b = (int) ((h / buckets) % buckets);   // "错开一位"就当成正交
      cells[a * buckets + b]++;
    }
    int bsq = buckets * buckets;
    long dev = 0;
    if (users > 0) {
      for (int c : cells) {
        long d = (long) c * bsq - users;
        if (d < 0) d = -d;
        d = d * 10000L / users;
        if (d > dev) dev = d;
      }
    }
    int[] out = new int[cells.length + 1];
    System.arraycopy(cells, 0, out, 0, cells.length);
    out[cells.length] = (int) dev;
    return out;
  }
}"""

    statement = """## 背景

火山引擎 A/B 测试（DataTester）的《规划实验流量》一文里，
"正交"不是口号，是一句实现描述【源 S9】：

> "火山引擎 A/B 测试的分流服务通过**两次运算「哈希函数」**，使得不同互斥域的流量之间呈正交关系"

同一页还给了正交的反例推演：两个实验各占 100% 且互不处理时，
"一个用户被 A1 命中时，同时也会被 B1 命中" ⇒ "**B1 组指标涨了，真的是 B1 的策略生效了吗？**"
解法是"把 A1/A2 各切一半分别进 B1/B2，这种影响也均匀地分布在实验 B 的两个组之中"。

同一页的另外两条硬约束（本题不实现，但答题要能引用）：
**客户端实验只可添加客户端互斥域，服务端实验只可添加服务端互斥域**；
父子实验（流量继承）是**官方明写的"打破正交"特例**。

## 任务

把"两次哈希 ⇒ 正交"变成一个可以精确模拟的模型：

```java
public static int[] abJoint(int saltA, int saltB, int buckets, int users)
```

对 `uid = 0 .. users-1` 每个用户，用**同一个哈希函数、两个不同的 salt**
分别算出他在 A 层和 B 层的桶号（都是 `0 .. buckets-1`）。
返回 `buckets * buckets` 个格子的计数（**按 A 层桶行优先**）+ 最后一个数 `maxDeviationBps`。

## 哈希（**逐位照抄，不许换实现**）

```java
private static long mix(long z) {
  z = (z ^ (z >>> 30)) * 0xBF58476D1CE4E5B9L;
  z = (z ^ (z >>> 27)) * 0x94D049BB133111EBL;
  return z ^ (z >>> 31);
}
// bucketOf(uid, salt, buckets) = (mix(uid * 0x9E3779B97F4A7C15L + salt) >>> 1) % buckets
```

（这是 SplitMix64 的 finalizer，选它只有一个理由：**Java 的 long 溢出语义
与逐位定义一致，判题两端可以复现同一个数**。真实分流服务用的是 murmur 类哈希 +
实验号当盐，性质相同。）

## `maxDeviationBps`（正交性的可机器判定据）

"正交"在数据上的意思是**联合分布 = 两侧边际分布的乘积**；
每层都是均匀分桶，所以期望每个格子有 `users / buckets²` 个人。用纯整数写成：

```
每个格子：dev = |obs * buckets² - users| * 10000 / users     （整除，向下取整）
maxDeviationBps = 所有格子里最大的 dev                        （users == 0 时直接记 0）
```

含义：偏差 0 表示完全均匀；10000（即 100%）表示某个格子比期望多一倍或少一倍。
**不许在 `users == 0` 时抛异常** —— "没有用户"是一个合法状态，
此时列联表全零、偏差按 0 报（正交是空真命题）。

## 合法性（`IllegalArgumentException`，消息一字不差）

`salt must be non-negative` / `buckets must be positive` / `buckets too large`（> 8）/
`users must be non-negative` / `users too large`（> 200000）

## 这题真正考的东西

1. **边际分布均匀不等于正交。** 用同一个哈希、只是"取模时错开一位"的实现
   （见 `naiveSolution`），每层人数都完全均匀，只有**联合分布**看得见它坏在哪。
   这就是为什么答题要写"两次哈希"而不是"两次取模"。
2. **`saltA == saltB` 不是"参数配错了"，是"两个实验在同一互斥域里"。**
   官方语义里同域实验**必须**共用盐（这样它们才会真的互斥），
   所以"完全重叠"在这个配置下是**正确行为**。
   用例「互斥域同 salt」和用例「关键：salt 相同」给的是同一件事的两个说法 ——
   能把"正交破产"和"互斥生效"当成同一个机制的两种用途，才算读懂了流量模型。
3. **偏差判据要能在小样本上不撒谎。** 用户数少于格子数时必然有空格 ⇒
   偏差很大是样本太小，不是分流坏了。这就是为什么真实的 SRM/独立性检验要看
   **期望频数够不够**，而不是直接比占比。"""

    return base(
        'algorithms', 'principal',
        '两次哈希构造正交流量层：用列联表偏差把"边际均匀 ≠ 正交"判成分',
        statement, 'java-junit',
        ['ab-testing', 'orthogonal-traffic', 'hash-bucketing', 'contingency-table',
         'mutual-exclusion-domain', 'modern:experimentation'],
        src('数据研发（实验平台与指标方向） 高级工程师',
            DATA + '#4 考点 10（A/B 流量模型：流量层、互斥域与正交性；'
            '"通过两次运算哈希函数使不同互斥域的流量呈正交关系"、正交的反例推演、'
            '客户端/服务端互斥域不可混用）＋ 考点 11（父子实验打破正交）；'
            'SplitMix64 与整数偏差判据是【推】（题面已声明为本题选型）'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'int[] abJoint(int saltA, int saltB, int buckets, int users)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案要点

两次调用同一个 `bucketOf`，**只有 salt 不同**；把 `buckets²` 个格子摊平，
最后附一个偏差数。偏差用 `|obs * buckets² - users| * 10000 / users` 的整数形式，
是为了避开"期望值是小数时怎么比"的取模争议 ——
乘回去再比，两边都是整数，判题器和实现之间不会有第二种解读。

**基线 `[1, 2, 2, 4000]` 给出 2x2 列联表 + 偏差。** 期望每格 1000 人，
实测四格合计 4000、最大偏差在**千分位量级**（万分比几百）。
这个数量级才配得上"正交"两个字：它是**有限样本的随机误差**，
不是系统性偏置。

**`[7, 7, 2, 4000]`（同一个 salt）给出 `[2035, 0, 0, 1965]`，偏差 10350。**
期望每格 1000 人：对角两格吃掉全部 4000 人（2035 / 1965 ⇒ 偏差
`|2035 * 4 - 4000| * 10000 / 4000 = 10350`），非对角两格**恒为 0**
（偏差 `10000`，即"比期望少 100%"，不可能更少）。
两层的相关系数是 1，也就是说"命中 A1 必然命中 B1"——
官方那句反问"**B1 组指标涨了，真的是 B1 的策略生效了吗？**"在数据上就长这样。

注意这个判据的**盲区**：它只报最大偏离幅度、不报方向，
也不报形状。"两层完全正相关"（非对角为 0）与"两层完全互斥"（对角为 0）
给出**同一个偏差数**。所以真实的独立性检验要看的是**整个列联表的形状**
（卡方、或对角占比），单一标量只够做告警、不够做归因。
答题时能指出自己判据的盲区，比判据本身正确更值钱。

**`[3, 4, 2, 3]`（3 个人填 4 个格子）⇒ `[2, 1, 0, 0]`，偏差 16666。**
期望每格只有 `0.75` 人，于是"有人挤在一起、有人一格没有"是**必然**的。
这是**样本量不足**而不是分流缺陷 —— 判 SRM / 独立性时先看期望频数
（经验上每格至少 5），否则一个 3 人的实验会因为"必然有空格"被判成不正交。

**`[1, 9, 1, 500]`（一层只有一个桶）⇒ 偏差恒为 0。**
只有一层在分桶时，"跨层正交"这个命题没有内容。
边界用例存在的意义是：**判据在退化维度上不许自己造出信号**。

**朴素解为什么必挂**：它用 `h % buckets` 与 `(h / buckets) % buckets` 当作"两次哈希"。
第二次是**对同一个哈希值做移位**，不是独立的第二次哈希 ⇒
联合分布呈现确定性的锯齿（某些格子恒空），偏差远大于基线。
它同时解释了官方为什么强调"两次**运算哈希函数**"而不是"两次取模"。

**工程延伸（面试追问点）**

1. 50 个并行实验怎么分层分域？（同一互斥域内共享盐 ⇒ 互斥，
   合计占用不超过该域流量比例；不同互斥域各用自己的盐 ⇒ 正交，可各自吃满 100%。
   要保留：互斥域组的**保留对照组**与**全局保留对照组**
   —— 后者是"评估 3 个部门累加的提升效果"的唯一手段，
   不然每个团队各自的提升幅度加起来永远大于大盘观察到的变化。）
2. 桶数与哈希的关系？（先分桶再把桶段划给实验 ⇒ 桶数是分辨率上限；
   桶太少时"10% 流量"根本表示不出来。真实实现用 100 或 1000 桶。）
3. 为什么客户端与服务端不能共用互斥域？（分流**主体**不同：
   设备 ID 与用户 ID 不是同一个键，同一salt 在两个键空间里不构成同一个划分 ⇒
   "互斥"变成假象，两个人群还会互相串。）
4. 父子实验（流量继承）为什么危险？（子实验开在父实验某一组的流量之下 ⇒
   它测的是"父策略生效之后的人群上，子策略的增量"，
   结论**不能外推**到全量；且父组与子组完全重叠时，两者的效应无法分离。
   官方把它列成"打破正交"的特例，就是这个意思。）""",
    )


# =================================================================== A6 动态配置下发与灰度回滚
@draft('alg-bd-config-rollout')
def q_config_rollout():
    def rollout(threshold_bps, min_sample, pushes):
        if threshold_bps <= 0 or threshold_bps > 10000:
            raise ModelError('thresholdBps out of range')
        if min_sample <= 0:
            raise ModelError('minSample must be positive')
        if pushes is None:
            raise ModelError('pushes must not be null')
        for p in pushes:
            if p is None or len(p) != 6:
                raise ModelError('each push must be [version, hash, valid, applyPercent, fail, total]')
            v, h, valid, pct, fail, total = p
            if v < 0:
                raise ModelError('version must be non-negative')
            if h < 0:
                raise ModelError('hash must be non-negative')
            if valid not in (0, 1):
                raise ModelError('valid must be 0 or 1')
            if pct < 1 or pct > 100:
                raise ModelError('applyPercent must be in [1,100]')
            if fail < 0 or total < 0:
                raise ModelError('fail and total must be non-negative')
            if fail > total:
                raise ModelError('fail must not exceed total')

        cur_v, cur_h, stable_v, stable_h = 0, 0, 0, 0
        applied = partial = stale = invalid = no_diff = rolled = 0
        for v, h, valid, pct, fail, total in pushes:
            if cur_v != 0 and total >= min_sample and fail * 10000 >= threshold_bps * total:
                if stable_v != cur_v:
                    rolled += 1
                    cur_v, cur_h = stable_v, stable_h
            if valid == 0:
                invalid += 1
                continue
            if v <= cur_v:
                stale += 1
                continue
            if h == cur_h:
                no_diff += 1
                continue
            cur_v, cur_h = v, h
            applied += 1
            if pct < 100:
                partial += 1
            else:
                stable_v, stable_h = v, h
        return [applied, partial, stale, invalid, no_diff, rolled, cur_v, stable_v]

    P = lambda *a: list(a)

    cases = [
        jcase('基线：全量 → 灰度 → 灰度期越界回退 → 新内容继续生效',
              [5000, 10, [P(10, 1, 1, 100, 0, 0), P(20, 2, 1, 20, 1, 100),
                          P(30, 3, 1, 100, 8, 10), P(40, 4, 1, 100, 0, 50)]], rollout),
        jcase('边界：版本号递增但内容哈希没变 ⇒ 一次回调都不许发（只有差异才通知）',
              [5000, 10, [P(7, 3, 1, 100, 0, 0), P(8, 3, 1, 100, 0, 0)]], rollout,
              note='configmanager 的公开语义就是"周期性加载 → 比对两版差异 → '
                   '只有差异才通知 listener"'),
        jcase('非法配置要在比对之前挡掉：坏配置不生效也不进历史',
              [5000, 10, [P(5, 1, 0, 100, 0, 0)]], rollout),
        jcase('边界：没有可退的稳定版 ⇒ 越界也不许凭空造一次回退',
              [1000, 10, [P(9, 1, 1, 100, 0, 0), P(10, 2, 1, 100, 9, 10)]], rollout),
        jcase('灰度中的版本不是稳定版：回退要退到上一个全量版本',
              [5000, 10, [P(10, 1, 1, 100, 0, 0), P(20, 2, 1, 50, 0, 0),
                          P(15, 3, 1, 100, 8, 10)]], rollout),
        jcase('样本不足时不许回退（和熔断的 MinSample 是同一个教训）',
              [5000, 200, [P(10, 1, 1, 100, 0, 0), P(20, 2, 1, 100, 9, 20)]], rollout),
        jcase('边界：重放同一个版本号 ⇒ 忽略，旧配置不许把新配置顶掉',
              [5000, 10, [P(10, 1, 1, 100, 0, 0), P(10, 2, 1, 100, 0, 0)]], rollout),
        jcase('退化：一次推送都没有 ⇒ 八个计数全零，当前版本仍是 0',
              [5000, 10, []], rollout),
        jcase('非法：灰度比例为 0（等于悄悄关掉下发）',
              [5000, 10, [P(1, 1, 1, 0, 0, 0)]], rollout,
              throws='IllegalArgumentException',
              throws_message='applyPercent must be in [1,100]'),
        jcase('非法：推送行不是六个字段', [5000, 10, [P(1, 1, 1, 100, 0)]], rollout,
              throws='IllegalArgumentException',
              throws_message='each push must be [version, hash, valid, applyPercent, fail, total]'),
        jcase('非法：失败数大于总数', [5000, 10, [P(1, 1, 1, 100, 9, 8)]], rollout,
              throws='IllegalArgumentException', throws_message='fail must not exceed total'),
        jcase('非法：最小样本门槛为 0（会让单点噪声触发全局回退）',
              [5000, 0, [P(1, 1, 1, 100, 0, 0)]], rollout,
              throws='IllegalArgumentException', throws_message='minSample must be positive'),
    ]

    reference = """public class Solution {
  public static int[] configRollout(int thresholdBps, int minSample, int[][] pushes) {
    if (thresholdBps <= 0 || thresholdBps > 10000)
      throw new IllegalArgumentException("thresholdBps out of range");
    if (minSample <= 0) throw new IllegalArgumentException("minSample must be positive");
    if (pushes == null) throw new IllegalArgumentException("pushes must not be null");
    for (int[] p : pushes) {
      if (p == null || p.length != 6)
        throw new IllegalArgumentException(
            "each push must be [version, hash, valid, applyPercent, fail, total]");
      if (p[0] < 0) throw new IllegalArgumentException("version must be non-negative");
      if (p[1] < 0) throw new IllegalArgumentException("hash must be non-negative");
      if (p[2] != 0 && p[2] != 1) throw new IllegalArgumentException("valid must be 0 or 1");
      if (p[3] < 1 || p[3] > 100) throw new IllegalArgumentException("applyPercent must be in [1,100]");
      if (p[4] < 0 || p[5] < 0) throw new IllegalArgumentException("fail and total must be non-negative");
      if (p[4] > p[5]) throw new IllegalArgumentException("fail must not exceed total");
    }

    int curV = 0, curH = 0, stableV = 0, stableH = 0;
    int applied = 0, partial = 0, stale = 0, invalid = 0, noDiff = 0, rolled = 0;
    for (int[] p : pushes) {
      int v = p[0], h = p[1], valid = p[2], pct = p[3], fail = p[4], total = p[5];
      if (curV != 0 && total >= minSample
          && (long) fail * 10000L >= (long) thresholdBps * total
          && stableV != curV) {
        rolled++;
        curV = stableV;
        curH = stableH;
      }
      if (valid == 0) { invalid++; continue; }
      if (v <= curV) { stale++; continue; }
      if (h == curH) { noDiff++; continue; }
      curV = v;
      curH = h;
      applied++;
      if (pct < 100) { partial++; } else { stableV = v; stableH = h; }
    }
    return new int[] {applied, partial, stale, invalid, noDiff, rolled, curV, stableV};
  }
}"""

    naive = """public class Solution {
  // "配置中心就是 KV 存储"版：来一条改一条、每次都要回调 listener（不比内容）、
  // 不做坏配置拦截、更没有回滚 —— 一条坏配置会被下发到全部实例。
  public static int[] configRollout(int thresholdBps, int minSample, int[][] pushes) {
    if (thresholdBps <= 0 || thresholdBps > 10000)
      throw new IllegalArgumentException("thresholdBps out of range");
    if (minSample <= 0) throw new IllegalArgumentException("minSample must be positive");
    if (pushes == null) throw new IllegalArgumentException("pushes must not be null");
    for (int[] p : pushes) {
      if (p == null || p.length != 6)
        throw new IllegalArgumentException(
            "each push must be [version, hash, valid, applyPercent, fail, total]");
      if (p[0] < 0) throw new IllegalArgumentException("version must be non-negative");
      if (p[1] < 0) throw new IllegalArgumentException("hash must be non-negative");
      if (p[2] != 0 && p[2] != 1) throw new IllegalArgumentException("valid must be 0 or 1");
      if (p[3] < 1 || p[3] > 100) throw new IllegalArgumentException("applyPercent must be in [1,100]");
      if (p[4] < 0 || p[5] < 0) throw new IllegalArgumentException("fail and total must be non-negative");
      if (p[4] > p[5]) throw new IllegalArgumentException("fail must not exceed total");
    }
    int curV = 0, applied = 0;
    for (int[] p : pushes) {
      if (p[0] > curV) { curV = p[0]; applied++; }
    }
    return new int[] {applied, 0, 0, 0, 0, 0, curV, curV};
  }
}"""

    statement = """## 背景

CloudWeGo 的 configmanager 把动态配置下发的机制写清了三层【源 S12】：
**周期性加载 → 比对两个版本的差异 → 只有差异才通知注册的 listener**，
另有 `Refresh` / `RefreshAndWait` / dump。配合 Kitex 的配置中心扩展
（etcd / Apollo / Nacos / File / ZK / Consul）与
`Updater.UpdateLimit`、`UpdateServiceCBConfig` 完成阈值热更【源 S2/S3/S6】。

**灰度下发、schema 校验、失败自动回退这三件事官方文档没写**，
本文件把它们标成【推】—— 所以本题把全部规则**写成题面契约**，
不声称"字节官方这么做"。你要考的是：**能不能把一条配置变更通道
设计成"坏配置进不来、进来了能自己退回去、退了以后还能说清楚退到哪"。**

## 任务

```java
public static int[] configRollout(int thresholdBps, int minSample, int[][] pushes)
```

`pushes` 按到达顺序，每条是一个六元组
`[version, contentHash, valid, applyPercent, failCount, totalCount]`：

- `valid`：客户端侧 schema 校验结果（`0` = 不合格）；
- `applyPercent`：本次下发的生效比例（100 = 全量）；
- `failCount / totalCount`：**上一条已生效配置**在这个观测窗口里的失败计数
  （也就是"配置随轮询带回上一窗口的健康报告"这一常见形态）。

返回八个整数：
`{生效次数, 其中灰度生效次数, 因版本不递增被忽略次数, 因 schema 不合格被拒次数,
  因内容未变而跳过回调次数, 自动回退次数, 结束时的当前版本, 结束时的稳定版本}`。

## 每条推送按此顺序处理（**顺序就是考点**）

| 步 | 规则 | 计数 |
| --- | --- | --- |
| 1 | **先体检当前生效版本**：`curVersion != 0` 且 `totalCount >= minSample`
      且 `failCount * 10000 >= thresholdBps * totalCount` 且 `stableVersion != curVersion`
      ⇒ 回退到稳定版（连同内容哈希一起退） | `rolledBack++` |
| 2 | `valid == 0` ⇒ 拒绝，**不进入比对、不改任何状态** | `rejectedInvalid++` |
| 3 | `version <= curVersion` ⇒ 忽略（老配置重放不许把新配置顶掉） | `ignoredStale++` |
| 4 | `contentHash == curHash` ⇒ **不通知 listener**（只有差异才回调） | `skippedNoDiff++` |
| 5 | 生效：`curVersion/curHash` 更新；`applyPercent < 100` 记灰度 | `applied++`，另记 `partialApplied++` |
| 6 | **只有全量生效（`applyPercent == 100`）才把它设为新的稳定版** | 更新 `stableVersion` |

四条设计理由，答题必须命中：

- **schema 校验排在比对之前**：一条坏配置如果被记成 `ignoredStale`，
  监控上就看不出"有人在推坏东西"，而它是唯一能区分"网络重放"与"内容错误"的信号。
- **回退判据要 `minSample`**：理由和熔断器的 `MinSample=200` 一模一样 ——
  低峰期一个窗口只有几次调用，一次失败就是 100% 错误率 ⇒ 全局回退。
- **只有全量生效才算稳定版**：否则"灰度 A 没达标 → 退回 A"会变成
  把 A 认定为稳定基线，回退等于把灰度推成全量。
- **回退要连 contentHash 一起退**：只回版本号会让第 4 步把
  "重放同一个内容"判成"内容未变 ⇒ 不回调"，而 listener 手里的值其实已经是新的了。

## 合法性（`IllegalArgumentException`，消息一字不差）

`thresholdBps out of range` / `minSample must be positive` / `pushes must not be null` /
`each push must be [version, hash, valid, applyPercent, fail, total]` /
`version must be non-negative` / `hash must be non-negative` /
`valid must be 0 or 1` / `applyPercent must be in [1,100]` /
`fail and total must be non-negative` / `fail must not exceed total`

**整批推送先全部校验再开始改状态**：否则一条格式错的第 50 行会让前 49 行已经生效，
"解析失败 ⇒ 保持旧值"这条契约就破了。

## 这题真正考的东西

`skippedNoDiff` 那个计数是本题唯一"纯送分"的一格，也是**唯一没人答对的一格**：
配置通道每 30 秒拉一次，绝大多数轮次内容根本没变。
若"每次拉到都回调"，listener 里的 map 会被反复原地重写 ——
读侧看到的就是**读到一半被改掉**的配置（素材 §2 追问 9 的"撕裂读"）。
"只有差异才回调"不是为了省 CPU，是让回调成为一个**真的发生了变更**的事件。"""

    return base(
        'algorithms', 'senior',
        '动态配置下发：版本与内容双重比对、schema 前置拦截、灰度失败自动回退',
        statement, 'java-junit',
        ['config-distribution', 'version-diff', 'gray-release', 'auto-rollback',
         'modern:service-governance'],
        src('服务端研发（Go 微服务治理与基础架构方向） 高级工程师',
            INFRA + '#4 考点 8（动态配置下发的一致性与原子生效：周期刷新、两版本比对、'
            '仅差异回调 listener、Refresh/dump、Updater 热更接口；'
            '"回调里的旧对象是否还在被使用/撕裂读"与"坏配置拦截与回滚"标为【推】，'
            '题面已改写成本题设定的契约）'),
        language='java',
        cases=cases,
        runner={'className': 'Solution',
                'signature': 'int[] configRollout(int thresholdBps, int minSample, int[][] pushes)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案要点

**基线 `[5000, 10, 四条推送]` 逐步走：**

| 推送 | 第 1 步（体检当前版本） | 第 2~4 步 | 生效结果 |
| --- | --- | --- | --- |
| v10 全量 | `curV==0` ⇒ 跳过体检 | 通过 | applied=1，stable=10 |
| v20 灰度 20% | 窗口 `1/100` 未越界 | 通过 | applied=2，partial=1，stable 仍 10 |
| v30 全量 | 当前是 v20，`8/10 = 8000bps >= 5000bps` 且 `stable(10) != cur(20)` ⇒ **回退到 10** | v30 > 10 ⇒ 通过 | applied=3，rolled=1，stable=30 |
| v40 全量 | `0/50` 未越界 | 通过 | applied=4，stable=40 |

⇒ 返回 `{4, 1, 0, 0, 0, 1, 40, 40}`。
第三条推送到达时 `curV` 是灰度中的 20，窗口 `(8, 10)` 满足
"样本达标且失败率万分比 8000 越过阈值 5000"，且稳定版是 10 ≠ 20 ⇒ 先回退；
紧接着这条推送自己 `v30 > curV(10)`、内容哈希也不同 ⇒ 立刻又以全量身份生效。
这条序列是本题最有教育意义的一格：
**回退和采纳可以在同一个轮次里连续发生** —— 先退回稳定版，再接纳这次下发的新内容。
把它实现成"回退了就不再处理这条推送"的系统，会漏掉"下一次修复正是这次推送"的情况。

**用例「边界：版本号递增但内容哈希没变」⇒ `{1, 0, 0, 0, 1, 0, 7, 7}`**：
版本 7→8 递增、内容完全相同 ⇒ 生效 1 次、跳过回调 1 次、`curVersion` 停在 7。
**这是 `skippedNoDiff` 的全部意义**：版本号是"我重发了"，内容哈希才是"变了"。
只做版本比对的实现（configmanager 的第一层）会在这里回调 listener ——
而回调一次就是让所有 listener 原地重写一次自己正在被读的 map。

**用例「样本不足时不许回退」⇒ `{2, 0, 0, 0, 0, 0, 20, 20}`**：
`minSample=200` 而窗口只有 20 次 ⇒ 9 个失败（45% 错误率）也不回退。
看起来"该退没退"，但这与熔断器的 `MinSample=200` 是同一个判断：
**回退是自动动作，自动动作的前提是证据充分**。
小窗口要自动回退，等价于把整条链路的稳定性押在一次网络抖动上。

**用例「非法配置要在比对之前挡掉」⇒ `{0, 0, 0, 1, 0, 0, 0, 0}`**：
坏配置不进历史、不改 `curVersion`（仍是 0）——
这就是"schema 校验排在比对之前"的可断言形式。
若把它记成 `ignoredStale`，"有人推了个格式错的东西"和"网络重放"就共用一个指标。

**朴素解挂在哪**：它不比内容哈希、不拦坏配置、不回退，
于是基线用例给出 `{4, 0, 0, 0, 0, 0, 40, 40}` ——
`partial`/`invalid`/`noDiff`/`rolled` 四格全零。
**这是它最可怕的地方**：一个"看起来一直在正常工作"的配置通道，
指标上却完全无法区分"变更"与"重放"，也无法证明"出过事之后回到了哪里"。

**工程延伸（面试追问点）**

1. 回调里怎么改才不撕裂？（**换指针不换内容**：新配置构造成一个不可变对象，
   原子替换引用。原地改 map 会让读侧看到"一半新一半旧"，
   而两个阈值之间有大小关系约束时（例如重试阈值必须小于熔断阈值），
   撕裂读能直接构造出非法组合。）
2. `Refresh` 与 `RefreshAndWait` 的差别？（后者保证"返回时所有 listener 已生效"，
   适合发布前对齐；前者只触发一轮拉取，生效时机不确定。）
3. 坏配置的放大半径怎么控？（schema 校验只能挡格式，挡不了语义
   （"把限流阈值配成 1"格式完全合法）。所以要么加**取值域与变化幅度**约束
   （单次变更超过 N 倍 ⇒ 需人工确认），要么把灰度比例本身当成校验手段：
   本题的 `applyPercent` + 失败回退就是这条。）
4. 为什么 Fallback 不在可热更清单里？（Kitex 文档明写 Fallback
   "涉及业务逻辑，只支持代码配置"【源 S7】。
   **能热改的是阈值和开关，不能热改的是行为** —— 一条配置通道
   能改多少东西，取决于那些东西有没有代码路径。这题的 `valid` 位之所以够用，
   正是因为被下发的只是数值。）""",
    )


# =================================================================== B 公共底座（pyspark）
def pycase(name, schema, view, rows, model, columns_note=None):
    """pyspark 用例助手：expected 由模型算，input 就是那张表的行。"""
    out = {'name': name, 'input': {'view': view, 'schema': schema, 'rows': rows},
           'expected': model(rows)}
    if columns_note:
        out['note'] = columns_note
    return out


# =================================================================== B1 特征时点正确性（SCD2 + 可见集）
@draft('bd-bd-point-in-time-features')
def q_point_in_time():
    SCHEMA = ('row_id int, row_kind string, sample_id int, user_id string, event_ts int, '
              'version_no int, feature_value bigint, valid_from int, valid_to int, ingest_ts int')
    VIEW = 'feature_rows'
    T0 = 1_700_000_000  # 用一个固定纪元秒做基准，题面里只出现相对偏移

    def rel(*xs):
        return [x + T0 for x in xs]

    def sample(sid, user, t):
        return {'row_id': -sid, 'row_kind': 'sample', 'sample_id': sid, 'user_id': user,
                'event_ts': t + T0, 'version_no': None, 'feature_value': None,
                'valid_from': None, 'valid_to': None, 'ingest_ts': None}

    def version(vid, user, vno, value, vf, vt, ing):
        return {'row_id': vid, 'row_kind': 'version', 'sample_id': None, 'user_id': user,
                'event_ts': None, 'version_no': vno, 'feature_value': value,
                'valid_from': vf + T0, 'valid_to': vt + T0, 'ingest_ts': ing + T0}

    def pit(rows):
        out = []
        for s in sorted([r for r in rows if r['row_kind'] == 'sample'],
                        key=lambda r: r['sample_id']):
            t = s['event_ts']
            cands = [v for v in rows if v['row_kind'] == 'version' and v['user_id'] == s['user_id']]

            def rank(v):
                visible = v['ingest_ts'] <= t
                covering = v['valid_from'] <= t < v['valid_to']
                if visible and covering:
                    return 0
                if visible and v['valid_from'] <= t:
                    return 1
                if covering and not visible:
                    return 2
                return 3

            rk = {v['version_no']: rank(v) for v in cands}
            n0 = sum(1 for v in cands if rk[v['version_no']] == 0)
            n2 = sum(1 for v in cands if rk[v['version_no']] == 2)
            pool = [v for v in cands if rk[v['version_no']] < 2]
            if pool:
                best = min(rk[v['version_no']] for v in pool)
                same = sorted([v for v in pool if rk[v['version_no']] == best],
                              key=lambda v: (-v['valid_from'], -v['version_no']))
                win = same[0]
                value, vno = win['feature_value'], win['version_no']
                if best == 0:
                    leak = 'overlap' if n0 > 1 else 'none'
                else:
                    leak = 'future-value' if n2 > 0 else 'stale-value'
            else:
                value, vno = None, None
                leak = 'future-value' if n2 > 0 else 'no-coverage'
            out.append({'sample_id': s['sample_id'], 'user_id': s['user_id'],
                        'feature_value': value, 'version_no': vno, 'leak': leak})
        return out

    b1 = [sample(1, 'u1', 100), sample(2, 'u1', 160), sample(3, 'u2', 100), sample(4, 'u3', 100),
          sample(5, 'u4', 100), sample(6, 'u5', 100),
          version(11, 'u1', 1, 70, 0, 120, 10),
          version(12, 'u1', 2, 88, 120, 150, 130),
          version(13, 'u1', 3, 99, 150, 300, 155),
          version(21, 'u2', 1, 40, 0, 300, 5),
          version(22, 'u2', 2, 41, 90, 300, 95),
          version(31, 'u3', 1, 55, 0, 80, 5),
          version(41, 'u4', 9, 12, 100, 300, 100),
          version(42, 'u4', 7, 13, 100, 300, 100),
          version(43, 'u4', 8, 14, 60, 90, 60)]

    b2 = [sample(1, 'u6', 50),
          version(61, 'u6', 1, 200, 0, 100, 120)]

    b3 = [sample(1, 'u7', 10), version(71, 'u7', 1, 300, 0, 5, 1)]

    b4 = [sample(1, 'u8', 100), version(81, 'u8', 4, 66, 0, 50, 1),
          version(82, 'u8', 5, 77, 50, 90, 60)]

    b5 = [sample(1, 'u9', 100), version(91, 'u9', 1, 10, 0, 1000, 1),
          version(92, 'u9', 2, 20, 0, 1000, 2), version(93, 'u9', 3, 30, 0, 1000, 3)]

    cases = [
        pycase('基线：可见性与生效区间都要判，六条样本落在四类结局上（none 与 overlap 各两次）', SCHEMA, VIEW, b1, pit,
               columns_note='s1/s2 走 u1（覆盖且唯一 / 后继版本已生效）；s3 走 u2（区间重叠，取 valid_from 最大）；'
                            's4 走 u3（只剩过期版本）；s5 走 u4（三条完全并列，取 version_no 最大）；'
                            's6 走 u5（一个版本都没有）'),
        pycase('边界：唯一覆盖该区间的版本在打分之后才落库 ⇒ 不许用，且如实标 future-value',
               SCHEMA, VIEW, b2, pit,
               columns_note='valid_from=0/valid_to=100 覆盖 t=50，但 ingest_ts=120 > 50 ⇒ '
                            '这条在打分时刻根本不存在。值是 null，leak 是 future-value'),
        pycase('退化：只有过期版本（区间早已结束）⇒ stale-value，不许当成"没有特征"',
               SCHEMA, VIEW, b3, pit),
        pycase('边界：最新可见版本的 valid_to 已过、且没有覆盖当下的版本 ⇒ stale-value',
               SCHEMA, VIEW, b4, pit),
        pycase('重叠三条并列同 valid_from ⇒ 取 version_no 最大者，并标 overlap',
               SCHEMA, VIEW, b5, pit),
    ]

    reference = """import pyspark.sql.functions as F
from pyspark.sql import Window


def solve(spark):
    r = spark.table('feature_rows')
    t = F.col('event_ts')
    s = (r.filter(F.col('row_kind') == 'sample')
         .select('sample_id', 'user_id', t.alias('t')))
    v = (r.filter(F.col('row_kind') == 'version')
         .select('user_id', 'version_no', 'feature_value',
                 F.col('valid_from').alias('vf'), F.col('valid_to').alias('vt'),
                 F.col('ingest_ts').alias('ing')))
    base = s.join(v, 'user_id', 'left')
    visible = F.col('ing') <= F.col('t')
    covering = (F.col('vf') <= F.col('t')) & (F.col('vt') > F.col('t'))
    ranked = base.withColumn(
        'rk',
        F.when(visible & covering, F.lit(0))
         .when(visible & (F.col('vf') <= F.col('t')), F.lit(1))
         .when(covering & ~visible, F.lit(2))
         .otherwise(F.lit(3)))

    agg = ranked.groupBy('sample_id', 'user_id').agg(
        F.min(F.when(F.col('rk') < 2, F.col('rk'))).alias('min_rk'),
        F.count(F.when(F.col('rk') == 0, F.lit(1))).alias('n0'),
        F.count(F.when(F.col('rk') == 2, F.lit(1))).alias('n2'))

    w = Window.partitionBy('sample_id').orderBy(F.col('rk').asc(), F.col('vf').desc(),
                                                F.col('version_no').desc())
    picked = (ranked.filter(F.col('rk') < 2)
              .withColumn('rn', F.row_number().over(w))
              .filter(F.col('rn') == 1)
              .select('sample_id', 'version_no', 'feature_value'))

    leak = (F.when(agg['min_rk'].isNull() & (agg['n2'] > 0), F.lit('future-value'))
            .when(agg['min_rk'].isNull(), F.lit('no-coverage'))
            .when((agg['min_rk'] == 0) & (agg['n0'] > 1), F.lit('overlap'))
            .when(agg['min_rk'] == 0, F.lit('none'))
            .when((agg['min_rk'] == 1) & (agg['n2'] > 0), F.lit('future-value'))
            .otherwise(F.lit('stale-value')))

    return (agg.join(picked, 'sample_id', 'left')
            .select('sample_id', 'user_id',
                    F.when(agg['min_rk'].isNotNull(), F.col('feature_value'))
                     .alias('feature_value'),
                    F.when(agg['min_rk'].isNotNull(), F.col('version_no'))
                     .alias('version_no'),
                    leak.alias('leak'))
            .orderBy('sample_id', 'user_id'))"""

    naive = """import pyspark.sql.functions as F
from pyspark.sql import Window


def solve(spark):
    # "特征越新越好"版：按 ingest_ts 取该用户最新的一条就用。
    # 症状：打分时刻根本还没落库的值被写进训练样本 —— 离线 AUC 好看，上线就掉，
    # 而且离线复算永远复现不出来（它用了未来信息）。
    r = spark.table('feature_rows')
    s = (r.filter(F.col('row_kind') == 'sample').select('sample_id', 'user_id',
                                                        F.col('event_ts').alias('t')))
    v = (r.filter(F.col('row_kind') == 'version')
         .select('user_id', 'version_no', 'feature_value',
                 F.col('ingest_ts').alias('ing')))
    w = Window.partitionBy('sample_id').orderBy(F.col('ing').desc(), F.col('version_no').desc())
    return (s.join(v, 'user_id', 'left')
            .withColumn('rn', F.row_number().over(w))
            .filter(F.col('rn') == 1)
            .select('sample_id', 'user_id', 'feature_value', 'version_no',
                    F.when(F.col('feature_value').isNotNull(), F.lit('none'))
                     .otherwise(F.lit('no-coverage')).alias('leak'))
            .orderBy('sample_id', 'user_id'))"""

    statement = """## 背景

Monolith 论文的问题陈述里有一条对数据侧同样成立【源 S1/S2】：
批训与 serving 完全分离时"模型无法实时接受用户反馈"；而一旦把样本拼成
"曝光日志 join 行为流"，**第一个要回答的问题就是：这条样本的特征取哪个版本。**

素材 §2 追问 1 给的标准答案只有两个词：**打分时刻可见值** + **特征版本号**。
这题就是把它写成一段可以判分对的 Spark。

（SCD2、point-in-time join 这些是通用工程做法；本题的**规则**全部写在下面，
不声称是字节官方实现 —— 素材 §7 第 3 条明确写了"特征平台没有可核查的官方文档"。）

## 输入

PySpark 3.5（判题容器内）。已注册一张表 `feature_rows`：

```
feature_rows(
  row_id INT,
  row_kind STRING,        -- 'sample' | 'version'
  sample_id INT,          -- 仅 sample 行
  user_id STRING,
  event_ts INT,           -- 仅 sample 行：打分时刻（epoch 秒）
  version_no INT,         -- 仅 version 行
  feature_value BIGINT,   -- 仅 version 行
  valid_from INT,         -- 生效区间左端点（闭）
  valid_to INT,           -- 生效区间右端点（开）
  ingest_ts INT)          -- 这一行**落库**的时刻
```

**时间全部用整数 epoch 秒**，不要引入任何日期函数或时区。

## 任务

对每个 sample 输出一行，列固定为
`sample_id, user_id, feature_value, version_no, leak`，按 `sample_id` 升序、再按 `user_id` 升序。

## 规则

对该用户的所有 version 行，按下面的顺序给每条打一个"取用等级" `rk`
（`t` 是打分时刻，先判前面几条）：

| rk | 条件 | 含义 |
| --- | --- | --- |
| 0 | `ingest_ts <= t` 且 `valid_from <= t < valid_to` | **可见且正覆盖**：这就是打分时刻的答案 |
| 1 | `ingest_ts <= t` 且 `valid_from <= t`（但区间没覆盖 t） | 可见、但已过期：只能当"最后已知值" |
| 2 | 区间覆盖 t 但 `ingest_ts > t` | **打分时刻它还不存在** —— 未来信息，永远不许被选中 |
| 3 | 其余 | 与本样本无关 |

只能从 `rk ∈ {0,1}` 里选：取 `rk` 最小者；同级时取 `valid_from` 最大者；
再并列取 `version_no` 最大者。没有任何 `rk < 2` 的行时，`feature_value` 与 `version_no` 都输出 `null`
（**不许兜成 0** —— 0 是一个合法的特征值，null 才是"这一路没有可用值"）。

`leak` 按此表输出：

| 条件 | `leak` |
| --- | --- |
| 选了 rk=0 且 rk=0 的行**只有一条** | `none` |
| 选了 rk=0 且 rk=0 的行**不止一条** | `overlap` |
| 有 rk=2 的行存在，且选的是 rk=1 或什么都没选 | `future-value` |
| 选了 rk=1 且没有任何 rk=2 的行 | `stale-value` |
| rk 0/1/2 都没有 | `no-coverage` |

三条口径纪律，答不上来这题就白做了：

- **`ingest_ts > t` 的行不是"脏数据"，是"当时不可知"。**
  把它排除掉之后**仍然要输出结果**（用最后已知值），并把 `leak` 标成 `future-value`。
  直接把这行数据删掉是最错的做法 —— 维表本身没错，错的是取用时刻。
- **`rk=2` 存在会把 `stale-value` 升级成 `future-value`。**
  同样是"用了过期值"，但一种是维表确实只到那儿，另一种是**回填晚了一步**。
  后者的修法是补采集时序，前者的修法是加特征版本 —— 分不开就会去修错的东西。
- **`overlap` 是数据质量事故，不是并列可选项。**
  同一用户两段生效区间重叠 ⇒ 维表的 SCD2 闭合逻辑坏了；
  本题要求"照规则选一个并如实标记"，**不许静默挑一个**。

## 约束

不许 `collect()` 到驱动侧；不许用 UDF 把行拉到 Python 里算。

## 这题真正考的东西

在线训练（Monolith 式）把这件事的代价放大了：批训练里一次取错版本，
是"离线指标虚高、上线掉点、复算不出来"三件事同时发生；
在线训练里取错版本会**持续污染参数**，因为你没有第二次机会重放那份样本。
素材 §2 追问 2 那句"你说可靠性可以换实时性，具体牺牲什么"，
数据侧的答案就是这一条：**牺牲的是"样本可复算"这个前提。**"""

    return base(
        'big-data', 'senior',
        '特征时点正确性：SCD2 生效区间与"打分时刻可见集"的交集才是样本的答案',
        statement, 'pyspark',
        ['feature-store', 'point-in-time-join', 'scd2', 'label-leakage',
         'online-learning', 'modern:feature-consistency'],
        src('数据研发（推荐数据平台 / 实时特征方向） 高级工程师',
            DATA + '#4 考点 2（特征时点正确性与训练-服务一致性：pyspark 版建议'
            '"给定事件流 + 维表 SCD2 做 point-in-time join，考核维表生效区间边界、'
            '迟到记录不覆盖新值"；地基【源 S2】，规则细节按素材标注为【推】）'
            '＋ §2 追问 1/2'),
        language='python',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=35,
        answer="""## 参考答案要点

一次 `sample × version` 的等值 join（只 join `user_id`，区间条件留给 `when` 链），
然后**两路并行**：`groupBy` 算等级计数、`row_number` 选人，最后 join 回来贴标签。
之所以不能用一个 `row_number` 搞定，是因为 `overlap` / `future-value` 这两个标签
需要**总体计数**而不是"选中了哪一条"。

**基线用例六条样本按 `sample_id` 的 `leak` 依次是
`none / none / overlap / stale-value / overlap / no-coverage`。** 逐条：

- s1 `u1@t=100`：只有 v1(0,120,ing=10) 覆盖且可见 ⇒ rk=0 恰好一条 ⇒ `none`，值 70、版本 1。
- s2 `u1@t=160`：v2 的区间 (120,150) 在 160 已经关闭，v3(150,300,ing=155) 覆盖且可见
  ⇒ rk=0 一条 ⇒ `none`，值 99、版本 3。**注意 `valid_to` 是开区间**：
  t 恰好等于上一版右端点时上一版就已经不覆盖了，写成 `<=` 会多出一条 rk=0 ⇒ 假 `overlap`。
- s3 `u2@t=100`：v1(0,300,ing=5) 与 v2(90,300,ing=95) 都覆盖 ⇒ rk=0 两条 ⇒ `overlap`，
  取 `valid_from` 最大的 v2 ⇒ 值 41、版本 2。
- s4 `u3@t=100`：只有 (0,80) 且早已过期 ⇒ rk=1 ⇒ `stale-value`，值 55。
  **不输出 null**：最后已知值仍然是"打分时刻能给出的最好答案"，
  判成 null 会把"维表更新晚了"与"这个用户从来没有过特征"混成一类。
- s5 `u4@t=100`：版本 9 与版本 7 的 `valid_from/valid_to/ingest_ts` 完全相同 ⇒
  `overlap` 且要靠 `version_no` 决胜 ⇒ 值 12、版本 9。
  （第三条 (60,90) 不覆盖 t=100 ⇒ 它是 rk=1，被 rk=0 压住，不参与决胜。）
- s6 `u5@t=100`：u5 一行 version 都没有 ⇒ 左连接后等级 3 ⇒ `no-coverage`，值 null。

**边界用例（唯一覆盖者 `valid_from=0/valid_to=100/ingest_ts=120`，而 t=50）
⇒ `feature_value=null`、`version_no=null`、`leak='future-value'`。**
这是本题最重要的一条：**值必须是 null，标签必须是 `future-value`**。
把它算成 `no-coverage` 的实现说明它压根没统计 rk=2 ——
那在线上表现为"缺失率涨了"，而真实原因是"回填来晚了"，
两条排查路径完全不同。**朴素解在这条上给出 200 号值**（它按 ingest_ts 倒序取最新），
那就是把未来的值写进了过去的样本 —— 标签泄漏的标准形态。

**工程延伸（面试追问点）**

1. 为什么左连接 + 条件而不是把条件写进 join？（都可以；写进 join 里当 join key
   用非等值条件时 Spark 会退化成 broadcast nested loop join。
   本题只按 `user_id` 等值连接、区间判断放在投影里，是**可控**的形状。
   真正的大表要加 `dt` 分区裁剪，并保证"分区"不等于"生效区间" —— 这是两个东西。）
2. 特征版本号和模型版本要不要一起落日志？（必须。素材考点 2 那句
   "需要把特征版本 + 模型版本写进日志，否则线上 AUC 复算不出来"。
   本题的 `version_no` 就是这一列的工程形态。）
3. 批流双路怎么对拍？（同一份特征定义出两份实现 ⇒ 采样对拍 + 差异率阈值；
   上线前跑一次**未来信息检查**：把 t 之后的行喂进 t 的样本，正确实现的结果不许变化。
   这个自动化用例其实就是本题的 `future-value` 那条。）
4. 过期策略与参数版本怎么对齐？（Monolith 用"可过期 embedding + 低频过滤"压内存【源 S1】；
   如果特征的过期判定与 embedding 的过期判定用不同时钟，
   **缺失率会被过期策略放大**，而两边的日志都说自己没错 —— 素材考点 2 的最后一句。）""",
    )


# =================================================================== B2 消费位点与完整度门
@draft('bd-bd-consumer-lag-readiness')
def q_consumer_lag():
    SCHEMA = ('row_id int, ds string, topic string, consumer_group string, '
              'min_offset bigint, max_offset bigint, consumer_offset bigint, '
              'window_minutes int, sla_minutes int')
    VIEW = 'offset_rows'

    def readiness(rows):
        out = []
        for r in sorted(rows, key=lambda x: (x['ds'], x['topic'], x['consumer_group'])):
            span = r['max_offset'] - r['min_offset']
            consumed = r['consumer_offset'] - r['min_offset']
            backlog = r['max_offset'] - r['consumer_offset']
            invalid = (r['window_minutes'] <= 0 or consumed < 0 or consumed > span
                       or r['min_offset'] < 0 or r['max_offset'] < r['min_offset'])
            if invalid:
                eta, status = None, 'invalid-position'
            elif backlog == 0:
                eta, status = 0, 'complete'
            elif consumed == 0:
                eta, status = None, 'stalled'
            else:
                eta = -((-backlog * r['window_minutes']) // consumed)   # 向上取整
                status = 'healthy' if eta <= r['sla_minutes'] else 'sla-risk'
            out.append({'ds': r['ds'], 'topic': r['topic'],
                        'consumer_group': r['consumer_group'], 'backlog': backlog,
                        'consumed': consumed, 'total_span': span,
                        'eta_minutes': eta, 'status': status})
        return out

    def row(rid, ds, topic, grp, mn, mx, co, win, sla):
        return {'row_id': rid, 'ds': ds, 'topic': topic, 'consumer_group': grp,
                'min_offset': mn, 'max_offset': mx, 'consumer_offset': co,
                'window_minutes': win, 'sla_minutes': sla}

    b1 = [row(1, '2026-09-01', 'T1', 'g-fast', 1000, 2000, 1900, 10, 60),
          row(2, '2026-09-01', 'T1', 'g-slow', 1000, 2000, 1100, 10, 60),
          row(3, '2026-09-01', 'T1', 'g-done', 1000, 2000, 2000, 10, 60),
          row(4, '2026-09-01', 'T2', 'g-idle', 500, 900, 500, 20, 30),
          row(5, '2026-09-01', 'T2', 'g-bad', 500, 900, 950, 20, 30),
          row(6, '2026-09-01', 'T3', 'g-edge', 0, 100, 50, 5, 5)]

    b2 = [row(1, '2026-09-02', 'T9', 'g-zero', 0, 0, 0, 30, 60)]

    b3 = [row(1, '2026-09-03', 'TA', 'g1', 10, 20, 10, 100, 5),
          row(2, '2026-09-03', 'TA', 'g2', 10, 20, 10, 0, 5)]

    cases = [
        pycase('基线：六类状态各一次（健康 / SLA 违约 / 追平 / 停滞 / 位点越界 / 边界相等）',
               SCHEMA, VIEW, b1, readiness,
               columns_note='g-edge 是 eta 恰好等于 sla_minutes ⇒ healthy（判据用 <=）'),
        pycase('边界：分区全空（min==max==consumer==0）⇒ 追平，不许算成停滞',
               SCHEMA, VIEW, b2, readiness,
               columns_note='span=0 且 backlog=0 ⇒ complete；把它算成 stalled 的实现'
                            '会在"今天还没有数据"的凌晨误报'),
        pycase('退化：窗口分钟数为 0 ⇒ 位点越界一类，拒绝给 ETA',
               SCHEMA, VIEW, b3, readiness),
    ]

    reference = """import pyspark.sql.functions as F


def solve(spark):
    r = spark.table('offset_rows')
    span = F.col('max_offset') - F.col('min_offset')
    consumed = F.col('consumer_offset') - F.col('min_offset')
    backlog = F.col('max_offset') - F.col('consumer_offset')
    invalid = ((F.col('window_minutes') <= 0) | (consumed < 0) | (consumed > span)
               | (F.col('min_offset') < 0) | (span < 0))
    # 向上取整写成整数除法：(a + b - 1) / b 再截断，全程不碰浮点边界
    ceil_eta = ((backlog * F.col('window_minutes') + consumed - F.lit(1)) / consumed).cast('long')
    eta = (F.when(invalid, F.lit(None).cast('long'))
           .when(backlog == 0, F.lit(0).cast('long'))
           .when(consumed == 0, F.lit(None).cast('long'))
           .otherwise(ceil_eta))
    status = (F.when(invalid, F.lit('invalid-position'))
              .when(backlog == 0, F.lit('complete'))
              .when(consumed == 0, F.lit('stalled'))
              .when(eta <= F.col('sla_minutes'), F.lit('healthy'))
              .otherwise(F.lit('sla-risk')))
    return (r.select('ds', 'topic', 'consumer_group',
                     backlog.alias('backlog'), consumed.alias('consumed'),
                     span.alias('total_span'), eta.alias('eta_minutes'),
                     status.alias('status'))
            .orderBy('ds', 'topic', 'consumer_group'))"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    # "任务成功就是数据完整"版：把位点差直接除一下，不校验位点合法性、
    # 不把"零消费"单独分出来，ETA 还向下取整 —— 越接近追平越乐观。
    r = spark.table('offset_rows')
    backlog = F.col('max_offset') - F.col('consumer_offset')
    consumed = F.col('consumer_offset')
    return (r.select('ds', 'topic', 'consumer_group',
                     backlog.alias('backlog'), consumed.alias('consumed'),
                     (F.col('max_offset') - F.col('min_offset')).alias('total_span'),
                     F.when(consumed == 0, F.lit(0))
                      .otherwise((backlog / consumed).cast('long')).alias('eta_minutes'),
                     F.when(backlog == 0, F.lit('complete')).otherwise(F.lit('healthy'))
                      .alias('status'))
            .orderBy('ds', 'topic', 'consumer_group'))"""

    statement = """## 背景

火山引擎消息队列 RocketMQ 版的《相关概念》把"堆积"定义成了三个可查的数【源 S19】：
`MaxOffset`（分区总数）、`MinOffset`（起始）、`ConsumerOffset`（已消费条数）。
也就是说 —— **堆积不是一个"队列长度"，它是三个位点之间的差**。
素材 §1.5 那句"扇出的可观测指标就是位点差，不是队列长度这种笼统说法"就是这个意思。

同一页还给了集群消费与广播消费的语义差【源 S15/S19】：
集群消费"每条消息仅被消费一次"、广播消费"每条消息会被消费多次" ——
**同一个消费组的位点形状在两种语义下完全不同**，这也是为什么必须校验位点合法性而不是直接除。

## 任务

PySpark 3.5，已注册表：

```
offset_rows(
  row_id INT, ds STRING, topic STRING, consumer_group STRING,
  min_offset BIGINT, max_offset BIGINT, consumer_offset BIGINT,
  window_minutes INT,      -- 这批位点是跨多长分钟数采的两个快照之差
  sla_minutes INT)
```

每行是一个 `(ds, topic, consumer_group)` 的快照。输出列固定为

```
ds, topic, consumer_group, backlog, consumed, total_span, eta_minutes, status
```

按 `ds`、`topic`、`consumer_group` 升序。定义：

```
total_span = max_offset - min_offset
consumed   = consumer_offset - min_offset
backlog    = max_offset - consumer_offset
```

`eta_minutes`（还要多少分钟追平）**必须向上取整**：还剩一条没消费完就不许报 0 分钟。
不适用时输出 `null`。

## `status` 判定（优先级从上到下，命中即止）

| 顺序 | 条件 | status | 为什么排在这里 |
| --- | --- | --- | --- |
| 1 | 位点非法（见下） | `invalid-position` | 输入不可信时**任何派生数都不许输出** |
| 2 | `backlog == 0` | `complete` | 追平优先于"消费速率为 0" |
| 3 | `consumed == 0` | `stalled` | 一条都没往前走 ⇒ ETA 无定义，不许给一个数 |
| 4 | `eta_minutes <= sla_minutes` | `healthy` | **是 `<=`**：恰好卡在 SLA 上算达标 |
| 5 | 其余 | `sla-risk` | |

**位点非法**的判据（任一成立即是）：
`min_offset < 0`，或 `max_offset < min_offset`，或 `consumer_offset < min_offset`，
或 `consumer_offset > max_offset`，或 `window_minutes <= 0`。

## 三条口径纪律

- **`complete` 必须排在 `stalled` 前面。**
  空分区（`min == max == consumer == 0`）的两个条件同时成立，
  判成 `stalled` 的实现在每天凌晨给每个新 topic 报一次"消费停滞"，
  于是这条告警三个月后就没人看了 —— **误报的代价不是误报本身，是把真信号淹掉**。
- **`consumed == 0` 时不许输出 ETA 数字。**
  输出 0 是"马上就好"，输出一个巨大的数是"很久以后"，
  两者都比"无法预测"更确定，而确定的假数字会直接进 SLO 计算。
- **向上取整不是保守，是让 ETA 单调。**
  向下取整会让"还剩 1 条"和"还剩 0 条"报出同一个数，
  于是仪表盘上"堆积在减少"这件事**看不见最后一段**。

## 这题真正考的东西

素材考点 9 的原话是：放行判据是**完整度指标**（应到 vs 实到 + 位点差），
而不是"任务成功"。**任务成功只说明代码没抛异常，不说明数据到齐了。**
把"看板 8 点没数"这件事做成产品化标记（"数据尚未完整"而不是"报错"），
靠的就是这张表里的 `status` 分档 —— 现在说出你的第四档叫什么名字、
以及它该不该进 SLO 分母。"""

    return base(
        'big-data', 'senior',
        '位点差才是堆积：三类位点算追赶 ETA，并把"数据尚未完整"做成状态分档',
        statement, 'pyspark',
        ['consumer-lag', 'offset-model', 'completeness-gate', 'sla',
         'message-fanout', 'modern:streaming-reliability'],
        src('数据研发（实时链路与数据平台方向） 高级工程师',
            DATA + '#4 考点 9（离线/实时双链路的对账与完整度：放行判据是完整度指标'
            '而不是任务成功）＋ 后端篇 #4 考点 11（消息投递语义与扇出可观测：'
            '三类位点 Max/Min/ConsumerOffset 是堆积与追赶速度的定义基础）；'
            '状态分档与 ETA 取整规则是【推】，已在题面写成本题契约'),
        language='python',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=25,
        answer="""## 参考答案要点

整题是一串列表达式，没有 join、没有 UDF —— 难点全在**优先级**和**空值语义**上。
向上取整写成 `-((-a) // b)`（Python）或 `F.ceil(...)`（Spark）；
用浮点 `ceil` 时要把乘法放在整数域里再做，否则大位点数会先在 `double` 上丢精度。

**基线六行的 ETA 逐个算**（`consumed` 都是相对 `min_offset` 的差）：

| 组 | span | consumed | backlog | ETA | status |
| --- | --- | --- | --- | --- | --- |
| g-fast | 1000 | 900 | 100 | `ceil(100*10/900)` = 2 | healthy（2 ≤ 60） |
| g-slow | 1000 | 100 | 900 | `ceil(900*10/100)` = 90 | sla-risk（90 > 60） |
| g-done | 1000 | 1000 | 0 | 0 | complete |
| g-idle | 400 | 0 | 400 | null | stalled |
| g-bad | 400 | 450 | −50 | null | invalid-position（位点超过 max） |
| g-edge | 100 | 50 | 50 | `ceil(50*5/50)` = 5 | healthy（5 ≤ 5，判据是 `<=`） |

**g-bad 是唯一一行"负 backlog"，也是本题故意留的陷阱**：
`backlog = -50`，它既不等于 0 也不大于 0 ⇒ 如果不在第 1 档拦住，
后面所有分支都会拿着一个负堆积算出"已经追平"。
**位点越界在真实链路里的成因就是"消费组换过语义"**
（集群消费改成广播消费，或位点被人工重置过），
这时 `consumer_offset` 已经不是这个 topic 队列上的合法游标了 —— 素材 §1.5
把"广播消费：每条消息会被消费多次"列成官方定义，正是这条的根因。

**边界用例（三个 offset 全 0）**：`span=0`、`consumed=0`、`backlog=0` ⇒ 合法，
判第 2 档 ⇒ `complete`，ETA 是 0（不是 null）。
朴素解在这里给出 `stalled`/ETA 0 混合的错误形状。

**退化用例里第 2 行 `window_minutes=0`**：`eta` 的分子分母都有一个 0 ⇒
必须落进 `invalid-position`。注意它和第 1 行 (`g1`) 的对照：
`g1` 是 `consumed=0` 的正常停滞 ⇒ `stalled`；同一张表里两行状态不同，
考的就是"你有没有把'输入不可信'和'输入可信但没进展'分开"。

**工程延伸（面试追问点）**

1. 集群 vs 广播怎么影响这张表？（广播消费的 `ConsumerOffset` 是**每个消费者实例各自**的，
   聚合出来的位点差天然偏小甚至为负。真实系统要按 `(consumer_group, client_id)` 采，
   再取 min 做保守估计 —— 取 min 会高估堆积，但**高估堆积只是多等一会儿，
   低估堆积会把没算完的数据放行到看板**。）
2. 延时/定时消息在这里怎么体现？（官方边界是"毫秒级延迟，最长 3 天或保留时长的 3 倍取小"
   【源 S19】。一条 3 天延时消息会让 `backlog` 长期不归零 ⇒ 需要把
   "计划内未到" 从 `stalled` 里分出去，否则这一档永远在误报。）
3. 死信呢？（死信队列在订阅关系创建时**自动创建**【源 S19】，
   但它是**另一个 topic** ⇒ 本表按 topic 采时死信完全不可见。
   "消费成功率高"和"没有消息进死信"是两条独立 SLI，别把后者省掉。）
4. 这套状态怎么变成产品？（`invalid-position` 与 `stalled` 都该出"数据尚未完整"标记
   而不是报错；`sla-risk` 出预警、`healthy` 才允许下游看板刷新 ——
   这就是素材 §2 追问 12 "看板 8 点没数先做什么"的答案：
   先看这张表的 `status`，而不是先看任务日志。）""",
    )


# =================================================================== B3 埋点血缘与下线决策
@draft('bd-bd-tracking-lineage-retire')
def q_lineage_retire():
    SCHEMA = ('row_id int, event_name string, is_preset int, verified int, disabled int, '
              'direct_refs int, indirect_refs int, queries_30d int, storage_gb bigint')
    VIEW = 'event_rows'

    def classify(r):
        if r['is_preset'] == 1:
            return 'keep-preset'
        if r['verified'] == 0:
            return 'block-unverified'
        if r['disabled'] == 1:
            return 'already-disabled'
        if r['direct_refs'] == 0 and r['indirect_refs'] == 0 and r['queries_30d'] == 0:
            return 'retire'
        if r['direct_refs'] == 0 and r['indirect_refs'] > 0:
            return 'retire-indirect-only'
        return 'keep'

    def aggregate(rows):
        buckets = {}
        for r in rows:
            a = classify(r)
            b = buckets.setdefault(a, {'action': a, 'event_cnt': 0, 'total_storage_gb': 0,
                                       'total_queries': 0})
            b['event_cnt'] += 1
            b['total_storage_gb'] += r['storage_gb']
            b['total_queries'] += r['queries_30d']
        return [buckets[k] for k in sorted(buckets)]

    def row(rid, name, preset, verified, disabled, direct, indirect, q30, gb):
        return {'row_id': rid, 'event_name': name, 'is_preset': preset, 'verified': verified,
                'disabled': disabled, 'direct_refs': direct, 'indirect_refs': indirect,
                'queries_30d': q30, 'storage_gb': gb}

    b1 = [row(1, '$page_start', 1, 1, 0, 40, 12, 9000, 512),      # keep-preset
          row(2, 'pay_success', 0, 1, 0, 6, 3, 400, 128),         # keep
          row(3, 'old_banner_click', 0, 1, 0, 0, 2, 30, 64),      # retire-indirect-only
          row(4, 'abandoned_flow', 0, 1, 1, 0, 0, 0, 256),        # already-disabled
          row(5, 'debug_probe', 0, 1, 0, 0, 0, 0, 96),            # retire
          row(6, 'new_checkout', 0, 0, 0, 9, 4, 700, 80)]         # block-unverified

    b2 = [row(1, 'solo', 0, 1, 0, 0, 0, 1, 7)]

    b3 = [row(1, 'a', 0, 1, 0, 0, 0, 0, 5), row(2, 'b', 0, 1, 0, 0, 0, 0, 6),
          row(3, 'c', 0, 1, 1, 0, 0, 0, 7)]

    cases = [
        pycase('基线：六类决策各一次，按 action 聚合后输出四个计数列', SCHEMA, VIEW, b1, aggregate),
        pycase('边界：唯一引用是"近 30 天查询次数"而不是引用数 ⇒ 不许进 retire',
               SCHEMA, VIEW, b2, aggregate,
               columns_note='direct=0 且 indirect=0 但 queries_30d=1 ⇒ keep。'
                            '下线的判据是"间接闭包内消费为零 **且** 热度为零"'),
        pycase('退化：只有可下线的两条 ⇒ 结果里不许凭空出现其它 action 行',
               SCHEMA, VIEW, b3, aggregate),
    ]

    reference = """import pyspark.sql.functions as F


def solve(spark):
    r = spark.table('event_rows')
    action = (F.when(F.col('is_preset') == 1, F.lit('keep-preset'))
              .when(F.col('verified') == 0, F.lit('block-unverified'))
              .when(F.col('disabled') == 1, F.lit('already-disabled'))
              .when((F.col('direct_refs') == 0) & (F.col('indirect_refs') == 0)
                    & (F.col('queries_30d') == 0), F.lit('retire'))
              .when((F.col('direct_refs') == 0) & (F.col('indirect_refs') > 0),
                    F.lit('retire-indirect-only'))
              .otherwise(F.lit('keep')))
    return (r.withColumn('action', action)
            .groupBy('action')
            .agg(F.count(F.lit(1)).alias('event_cnt'),
                 F.sum('storage_gb').alias('total_storage_gb'),
                 F.sum('queries_30d').alias('total_queries'))
            .orderBy('action'))"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    # "没人引用就下线"版：只看 direct_refs，不看间接闭包、不看热度、不看验收态。
    # 真实后果是：把一个被三层派生表依赖的事件下线掉，第二天核心报表空一列。
    r = spark.table('event_rows')
    action = F.when(F.col('direct_refs') == 0, F.lit('retire')).otherwise(F.lit('keep'))
    return (r.withColumn('action', action)
            .groupBy('action')
            .agg(F.count(F.lit(1)).alias('event_cnt'),
                 F.sum('storage_gb').alias('total_storage_gb'),
                 F.sum('queries_30d').alias('total_queries'))
            .orderBy('action'))"""

    statement = """## 背景

火山引擎 DataFinder 的《一般事件》页把"埋点血缘"写成了产品对象【源 S7】：
血缘关系覆盖**图表 / 看板 / 用户分群**，并且**区分"直接引用"与"间接引用"**，
分群血缘还额外带两个消费热度信号：**最新分群用户数**与**近 30 天的查询次数**。
同一页还有两条必须用上的状态：
"**一般事件列表仅展示已验收的事件**"，以及"停止采集靠禁用事件或属性、无需改代码"。

DataFinder 的《全埋点》页则说明成本侧的事实【源 S8】：
"无差别全量采集，产生无效数据上报，**浪费流量/存储/计算资源**"。

素材 §4 考点 4 的【推】结论是本题要落地的东西：
**下线的判据应当是"间接闭包内消费为零 + 热度为零 + 保留期外"，而不是"没人认领"。**

## 任务

PySpark 3.5，已注册表：

```
event_rows(
  row_id INT, event_name STRING,
  is_preset INT,        -- 1 = 预置事件（SDK 自带、由系统统一配置上报时机）
  verified INT,         -- 1 = 已验收
  disabled INT,         -- 1 = 已在元数据管理里被禁用
  direct_refs INT,      -- 直接引用它的事件数（图表/看板/分群）
  indirect_refs INT,    -- 间接引用（派生链下游）它的事件数
  queries_30d INT,      -- 近 30 天被查询次数（消费热度）
  storage_gb BIGINT)
```

给每个事件判定一个 `action`，然后**按 `action` 聚合**，输出列固定为

```
action, event_cnt, total_storage_gb, total_queries
```

按 `action` 升序。**只输出实际出现过的 action**（没有该类事件就不要造一行）。

## `action` 判定（优先级从上到下，命中即止）

| 顺序 | 条件 | action | 依据 |
| --- | --- | --- | --- |
| 1 | `is_preset == 1` | `keep-preset` | 预置事件由系统统一配置，不在业务下线范围内 |
| 2 | `verified == 0` | `block-unverified` | 未验收的事件**不参与**下线评估：先补验收 |
| 3 | `disabled == 1` | `already-disabled` | 已经停止采集，成本问题已解决，别再报"可省多少 G" |
| 4 | `direct_refs == 0` 且 `indirect_refs == 0` 且 `queries_30d == 0` | `retire` | 闭包内消费为零 |
| 5 | `direct_refs == 0` 且 `indirect_refs > 0` | `retire-indirect-only` | 只有间接引用 ⇒ 真正被消费的是派生链 |
| 6 | 其余 | `keep` | |

四条口径纪律：

- **`block-unverified` 排在所有引用判断之前。**
  未验收事件的血缘**本身不可信**（没人对过口径），
  拿一份不可信的血缘去做下线决策，等于用猜测定生死。
- **`already-disabled` 排在引用判断之前。**
  禁用之后 `queries_30d` 会缓慢归零（缓存、报表还在读旧分区），
  把它算进"本次可省 GB"是把**过去已经省下的钱**再报一次成果。
- **`retire` 要求三个零同时成立。**
  只看两个引用数会漏掉"没人引用但天天被查"的事件
  （典型是自助分析里被 `SELECT *` 捞走的明细），
  而只看热度会漏掉"建了看板但半年没人看"的 —— 两个信号正交，缺一不可。
- **`retire-indirect-only` 不是"可以下线"，是"先断链再下线"。**
  素材 §4 考点 4 原话：*"下游派生链上的'间接'往往是真正被消费的那个"*。
  把它和 `retire` 合并成一档，就等于给一次事故开了绿灯。

## 这题真正考的东西

成本治理最容易做的事是"按采集量排序砍最大的"，
而**采集量最大的事件往往正是最常被查的那个**。
血缘 + 热度这两个信号的作用，是把"下线一件事"的依据从
*问一圈有没有人用* 变成 *闭包基数为 0*。
写出来之后请顺手回答：**这条判据要成为硬卡口，需要什么机制？**
（提示：DataLeap 给的答案是"数据标准 + 字段元数据对标 + 标准监控统计"【源 S6】
 —— 靠人遵守的规范会在三个月后退化。）"""

    return base(
        'big-data', 'senior',
        '埋点下线决策：直接/间接引用闭包 + 近 30 天热度，两笔账都不许算重',
        statement, 'pyspark',
        ['tracking-governance', 'data-lineage', 'cost-governance', 'priority-rules',
         'modern:metadata-workflow'],
        src('数据研发（埋点治理与元数据方向） 高级工程师',
            DATA + '#4 考点 4（埋点血缘与影响分析：区分直接/间接引用、'
            '分群血缘带"最新分群用户数、近 30 天查询次数"、'
            '下线判据应是"间接闭包内消费为零 + 热度为零 + 保留期外"，素材标【推】）'
            '＋ 考点 3（预置事件 / 验收态 / 禁用即停止上报）＋ 考点 5（全埋点成本劣势原文）'),
        language='python',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer="""## 参考答案要点

一条 `when` 链 + 一次 `groupBy`。分数的差别全在**优先级顺序**上：
把 `already-disabled` 放在第 4 条之后，`abandoned_flow`（disabled=1、三个引用都是 0）
就会被判成 `retire`，于是这份"下线可省 256 GB"的立项材料里，
**有一笔三年前就已经省下来的钱被重新报了一遍**。
治理项目的收益账最常见的两种虚高就是这种"重复计算"和下面的"口径漂移"。

**基线六行聚合成 6 个 action、各 1 条事件**：
`already-disabled`(1, 256, 0) / `block-unverified`(1, 80, 700) /
`keep`(1, 128, 400) / `keep-preset`(1, 512, 9000) /
`retire`(1, 96, 0) / `retire-indirect-only`(1, 64, 30)，按 action 升序。
注意 `total_queries` 这一列在 `retire` 档恒为 0（判据要求它必须为 0），
但在 `retire-indirect-only` 档**可以非零**（那条只约束 direct/indirect）——
30 次查询正是"先断链"这件事的成本：下线前要先给这 30 次查询的使用者发通知。

**边界用例（direct=0, indirect=0, queries_30d=1）⇒ `keep`，只出一行。**
这一条是本题的"最小可判分反例"：
如果实现写的是"两个引用数都为 0 就 retire"，它会把这行归进 `retire` ——
**存储只有 7 GB、却每天被查的事件，恰恰是自助分析在直接读明细。**

**退化用例（两条可下线 + 一条已禁用）⇒ 输出 2 行**，
不许为未出现的 action 补 0 行。
用 `spark.createDataFrame(pandas_df)` 或对固定枚举做 `pivot` 的实现最容易在这里多出行 ——
**多出来的那行 `event_cnt=0` 会让"下线了 N 类事件"这句话变成假话。**

**工程延伸（面试追问点）**

1. 只有事件级血缘够不够？（不够。字段级才是事故现场：
   事件还在上报、但某个属性没人写 ⇒ 属性缺填率异常。
   素材考点 3 建议的 mysql 版（"未录入上报 / 未验收 / 已禁用仍在上报 / 属性缺填率异常"
   四类违规）就是这一层的对账，本批另有该题。）
2. `queries_30d` 的时间窗为什么是 30 天？（它必须**长于业务节奏**：
   季度报表、大促复盘都在 30 天量级之外。窗口一短，
   低频但关键的事件就会在"看起来零消费"的状态下被下线。
   正确做法是"热度窗口"与"保留期"分开定义，并把窗口本身作为参数留痕。）
3. 下线之后怎么回滚？（禁用是元数据动作、不改代码【源 S8】，
   所以回滚同样是元数据动作 —— **这恰恰说明"禁用"不该被当成"删除"**。
   事件定义、属性、历史分区要按保留期留着，否则一次误判就变成永久丢数。）
4. 怎么防止判据退化？（把三条判据做成**上线闸**而不是报表：
   新事件必须绑定验收人与下游预期；旧事件下线必须自动跑一次闭包查询并附证据。
   素材考点 7 那句"出口一致是平台职责不是文档职责"在这里同样成立。）""",
    )


# =================================================================== F 公共底座（react-vitest）
def ts_case(name, args, model, throws_message=None, note=None):
    """react-vitest 用例助手。

    与 `jcase` 同一套纪律：**`throws_message` 是声明，不是推断** ——
    模型行为与声明不符就当场炸。
    额外一条：react 题的**判分事实来源是生成的测试文件**，所以这里同时把
    测试文件的断言也生成出来（`_assertions`），绝不手抄期望值。
    """
    if throws_message is None:
        try:
            got = model(*args)
        except ModelError as exc:
            raise AssertionError(f'用例「{name}」没声明抛错，但模型抛了 {exc.message}') from exc
        case = {'name': name, 'input': list(args), 'expected': got}
    else:
        try:
            got = model(*args)
        except ModelError as exc:
            if exc.message != throws_message:
                raise AssertionError(
                    f'用例「{name}」期望消息 "{throws_message}"，实际 "{exc.message}"')
            case = {'name': name, 'input': list(args), 'expected': None,
                    'expectThrow': 'Error', 'throwMessage': throws_message}
        else:
            raise AssertionError(f'用例「{name}」声明了抛错，但模型正常返回 {got}')
    if note:
        case['note'] = note
    return case


def ts_test_file(fn_name, describe_title, cases):
    """从**同一批模型输出**生成 vitest 断言文件（消息断言必须写进这里才参与判分）。"""
    lines = [
        "import { describe, expect, it } from 'vitest';",
        "import { %s } from './Solution';" % fn_name,
        '',
        '/**',
        ' * 断言由 gen.py 里同一个 Python 模型生成，不手抄 ——',
        ' * react-vitest 题的判分事实来源就是这份文件，抄错一次就永久错一次。',
        ' * 契约型用例断言到**消息**：只写 .toThrow() 会让几条"都该抛错"的用例收敛成同一条。',
        ' */',
        "describe('%s', () => {" % describe_title,
    ]
    for c in cases:
        call = '%s(%s)' % (fn_name, ', '.join(json.dumps(a, ensure_ascii=False) for a in c['input']))
        if c.get('expectThrow'):
            body = "expect(() => %s).toThrow(%s)" % (call, json.dumps(c['throwMessage'], ensure_ascii=False))
        else:
            body = "expect(%s).toEqual(%s)" % (call, json.dumps(c['expected'], ensure_ascii=False))
        lines.append("  it(%s, () => {" % json.dumps(c['name'], ensure_ascii=False))
        lines.append('    %s;' % body)
        lines.append('  });')
    lines.append('});')
    return '\n'.join(lines)


# =================================================================== F1 埋点元数据状态视图模型
@draft('fe-bd-event-metadata-view')
def q_event_metadata_view():
    STATUS = {'draft', 'pending', 'accepted', 'rejected', 'disabled'}
    SOURCE = {'preset', 'custom'}
    KIND = {'none', 'click', 'custom', 'heatmap', 'selector'}

    TEXT = {
        'disabled': ('已禁用 · 停止上报', 'danger'),
        'preset': ('预置事件', 'info'),
        'draft': ('草稿 · 未提交', 'muted'),
        'needs-accept': ('待验收 · 可验收', 'warn'),
        'pending-locked': ('待验收 · 只读', 'muted'),
        'rejected': ('验收未通过', 'danger'),
        'capability-gap': ('需开启全埋点', 'warn'),
        'live': ('可分析', 'ok'),
    }
    BUCKET = {
        'disabled': 'stopped', 'preset': 'preset-owned', 'draft': 'draft',
        'needs-accept': 'pending-acceptance', 'pending-locked': 'pending-acceptance',
        'rejected': 'rejected', 'capability-gap': 'capability-gap', 'live': 'live',
    }
    ACTION = {'disabled': 're-enable', 'preset': None, 'draft': 'submit',
              'needs-accept': 'accept', 'pending-locked': None, 'rejected': 'revise',
              'capability-gap': None, 'live': 'view'}

    def view(row):
        if not isinstance(row, dict):
            raise ModelError('row must be an object')
        status = row.get('status')
        source = row.get('source')
        kind = row.get('analysisKind')
        if status not in STATUS:
            raise ModelError('unknown event status')
        if source not in SOURCE:
            raise ModelError('unknown event source')
        if kind not in KIND:
            raise ModelError('unknown analysis kind')
        can_manage = bool(row.get('canManage'))
        auto = bool(row.get('autoTracking'))

        if status == 'disabled':
            state = 'disabled'
        elif source == 'preset':
            state = 'preset'
        elif status == 'draft':
            state = 'draft'
        elif status == 'pending':
            state = 'needs-accept' if can_manage else 'pending-locked'
        elif status == 'rejected':
            state = 'rejected'
        elif kind in ('heatmap', 'selector') and not auto:
            state = 'capability-gap'
        else:
            state = 'live'

        label, tone = TEXT[state]
        action = ACTION[state] if (state not in ('disabled', 'draft', 'rejected', 'needs-accept')
                                   or can_manage) else None
        if state in ('capability-gap', 'live'):
            action = ACTION[state]
        return {
            'state': state,
            'label': label,
            'tone': tone,
            'action': action,
            'tooltip': '事件 %s：%s' % (row.get('eventName', '?'), label),
            'governanceBucket': BUCKET[state],
            'countsInAcceptedList': state in ('preset', 'capability-gap', 'live'),
        }

    def ev(name, status, source='custom', kind='none', manage=True, auto=False):
        return {'eventName': name, 'status': status, 'source': source,
                'analysisKind': kind, 'canManage': manage, 'autoTracking': auto}

    cases = [
        ts_case('基线：已验收的自定义事件 ⇒ 可分析，且进"一般事件列表"',
                [ev('pay_success', 'accepted')], view),
        ts_case('预置事件即使还处于 pending 也不进验收队列（上报时机由系统统一配置）',
                [ev('$page_start', 'pending', source='preset')], view),
        ts_case('待验收 + 有"可管理"权限 ⇒ 渲染成可点的验收动作',
                [ev('new_checkout', 'pending')], view),
        ts_case('待验收 + 无权限 ⇒ 只读（官方口径："无权限只能看"）',
                [ev('new_checkout', 'pending', manage=False)], view),
        ts_case('边界：已验收但分析类型是热力图、全埋点未开 ⇒ 能力缺口，不算验收问题',
                [ev('banner_heat', 'accepted', kind='heatmap')], view,
                note='这一条 countsInAcceptedList 仍是 true：事件本身没问题，缺的是采集能力。'
                     '把它判成 pending 会让人去催验收人，而真正要开的是项目中心的全埋点开关'),
        ts_case('边界：被禁用的预置事件 ⇒ disabled 优先于 preset',
                [ev('$AppClick', 'disabled', source='preset')], view),
        ts_case('退化：草稿态不给任何"可分析"承诺',
                [ev('wip_event', 'draft', manage=False)], view),
        ts_case('边界：验收未通过 ⇒ danger 但不进"停止采集"桶',
                [ev('bad_event', 'rejected')], view),
        ts_case('非法：整行是 null', [None], view, throws_message='row must be an object'),
        ts_case('非法：未知事件状态',
                [ev('x', 'archived')], view, throws_message='unknown event status'),
        ts_case('非法：未知事件来源（预置与自定义之外没有第三种）',
                [ev('x', 'accepted', source='imported')], view,
                throws_message='unknown event source'),
        ts_case('非法：未知分析类型（它决定要不要全埋点，不许猜）',
                [ev('x', 'accepted', kind='funnel')], view,
                throws_message='unknown analysis kind'),
    ]

    reference = """export interface EventMetaInput {
  eventName: string;
  status: 'draft' | 'pending' | 'accepted' | 'rejected' | 'disabled';
  source: 'preset' | 'custom';
  analysisKind: 'none' | 'click' | 'custom' | 'heatmap' | 'selector';
  canManage: boolean;
  autoTracking: boolean;
}

export interface EventMetaView {
  state: string;
  label: string;
  tone: string;
  action: string | null;
  tooltip: string;
  governanceBucket: string;
  countsInAcceptedList: boolean;
}

const TEXT: Record<string, [string, string]> = {
  disabled: ['已禁用 · 停止上报', 'danger'],
  preset: ['预置事件', 'info'],
  draft: ['草稿 · 未提交', 'muted'],
  'needs-accept': ['待验收 · 可验收', 'warn'],
  'pending-locked': ['待验收 · 只读', 'muted'],
  rejected: ['验收未通过', 'danger'],
  'capability-gap': ['需开启全埋点', 'warn'],
  live: ['可分析', 'ok'],
};

const BUCKET: Record<string, string> = {
  disabled: 'stopped',
  preset: 'preset-owned',
  draft: 'draft',
  'needs-accept': 'pending-acceptance',
  'pending-locked': 'pending-acceptance',
  rejected: 'rejected',
  'capability-gap': 'capability-gap',
  live: 'live',
};

const ACTION: Record<string, string | null> = {
  disabled: 're-enable',
  preset: null,
  draft: 'submit',
  'needs-accept': 'accept',
  'pending-locked': null,
  rejected: 'revise',
  'capability-gap': null,
  live: 'view',
};

const STATUS = ['draft', 'pending', 'accepted', 'rejected', 'disabled'];
const SOURCE = ['preset', 'custom'];
const KIND = ['none', 'click', 'custom', 'heatmap', 'selector'];
const NEEDS_AUTO = ['heatmap', 'selector'];
// 只有"事件本身没问题"的三种形态才算进"一般事件列表（仅展示已验收的事件）"
const ACCEPTED_LIKE = ['preset', 'capability-gap', 'live'];

export function eventMetaView(row: EventMetaInput): EventMetaView {
  if (row === null || row === undefined || typeof row !== 'object') {
    throw new Error('row must be an object');
  }
  if (STATUS.indexOf(row.status) < 0) throw new Error('unknown event status');
  if (SOURCE.indexOf(row.source) < 0) throw new Error('unknown event source');
  if (KIND.indexOf(row.analysisKind) < 0) throw new Error('unknown analysis kind');

  let state: string;
  if (row.status === 'disabled') state = 'disabled';
  else if (row.source === 'preset') state = 'preset';
  else if (row.status === 'draft') state = 'draft';
  else if (row.status === 'pending') state = row.canManage ? 'needs-accept' : 'pending-locked';
  else if (row.status === 'rejected') state = 'rejected';
  else if (NEEDS_AUTO.indexOf(row.analysisKind) >= 0 && !row.autoTracking) state = 'capability-gap';
  else state = 'live';

  const managed = ['disabled', 'draft', 'rejected', 'needs-accept'].indexOf(state) >= 0;
  const action = managed ? (row.canManage ? ACTION[state] : null) : ACTION[state];
  const label = TEXT[state][0];
  return {
    state,
    label,
    tone: TEXT[state][1],
    action,
    tooltip: `事件 ${row.eventName ?? '?'}：${label}`,
    governanceBucket: BUCKET[state],
    countsInAcceptedList: ACCEPTED_LIKE.indexOf(state) >= 0,
  };
}"""

    naive = """export function eventMetaView(row: any): any {
  // "状态字段直接渲染"版：把 pending 一律显示成"待验收"、
  // 把"没开全埋点"和"没验收"混成同一句文案，也不区分有没有权限。
  // 症状：数据同学天天去催验收，其实要开的是项目中心的全埋点开关；
  // 而无权限的人看到一个点不动的"验收"按钮，报上来的单子是"按钮坏了"。
  const accepted = row.status === 'accepted';
  const label = accepted ? '可分析' : row.status === 'disabled' ? '已禁用' : '待验收';
  return {
    state: accepted ? 'live' : 'pending-locked',
    label,
    tone: accepted ? 'ok' : 'warn',
    action: accepted ? 'view' : 'accept',
    tooltip: '事件 ' + (row.eventName ?? '?') + '：' + label,
    governanceBucket: accepted ? 'live' : 'pending-acceptance',
    countsInAcceptedList: accepted,
  };
}"""

    statement = """## 背景

DataFinder 的《一般事件》页把埋点元数据写成了一组**产品状态与权限**，而不是一句"上报了就
有数据"【源 S7】。可核查的原文事实有五条：

1. 对象分三层：**事件**（用户动作，"主要通过应用内埋点实现"）、**事件属性**、
   以及**预置事件与预置属性**（"SDK 自带、由系统统一配置上报时机"）；
2. "**一般事件列表仅展示已验收的事件**，未验收事件可点击验收事件查看并完成验收"；
3. 建议"**先查看预置事件是否已满足业务需求，不满足再手动创建自定义事件**"；
4. 权限单独授予（"数据管理-一般事件-可管理"），**无权限只能看**；
5. 停止采集的动作是"在元数据管理中**禁用对应事件或属性**"或"项目中心关全埋点开关"，
   **无需改代码**【源 S8】。

《全埋点》页另给一条【源 S8】："**热力图、圈选事件功能需开启全埋点才可使用**"。

## 任务

把这五条做成一个前端**视图模型**（不要求渲染组件，只要求纯函数 ——
判题器用 vitest + jsdom 跑你提交的 `Solution.tsx`）：

```ts
export function eventMetaView(row: EventMetaInput): EventMetaView
```

输入：

```ts
{
  eventName: string;
  status: 'draft' | 'pending' | 'accepted' | 'rejected' | 'disabled';
  source: 'preset' | 'custom';
  analysisKind: 'none' | 'click' | 'custom' | 'heatmap' | 'selector';
  canManage: boolean;        // 是否有"数据管理-一般事件-可管理"权限
  autoTracking: boolean;     // 项目中心的全埋点开关是否已开
}
```

输出：

```ts
{
  state: string;
  label: string;
  tone: 'ok' | 'warn' | 'danger' | 'muted' | 'info';
  action: string | null;     // 行内主操作；null = 这一行不给动作
  tooltip: string;
  governanceBucket: string;  // 治理口径分桶（列表页的筛选与指标都按它统计）
  countsInAcceptedList: boolean;  // 是否该出现在"一般事件列表（仅展示已验收）"里
}
```

## 状态判定（**优先级从上到下，命中即止**）

| # | 条件 | `state` | `label` / `tone` | 进已验收列表？ |
| --- | --- | --- | --- | --- |
| 1 | `status === 'disabled'` | `disabled` | `已禁用 · 停止上报` / danger | 否 |
| 2 | `source === 'preset'` | `preset` | `预置事件` / info | **是** |
| 3 | `status === 'draft'` | `draft` | `草稿 · 未提交` / muted | 否 |
| 4 | `status === 'pending'` 且 `canManage` | `needs-accept` | `待验收 · 可验收` / warn | 否 |
| 5 | `status === 'pending'` 且无权限 | `pending-locked` | `待验收 · 只读` / muted | 否 |
| 6 | `status === 'rejected'` | `rejected` | `验收未通过` / danger | 否 |
| 7 | `analysisKind` 是 `heatmap`/`selector` 且 `!autoTracking` | `capability-gap` | `需开启全埋点` / warn | **是** |
| 8 | 其余 | `live` | `可分析` / ok | 是 |

`action` 规则：`needs-accept → 'accept'`、`draft → 'submit'`、`rejected → 'revise'`、
`disabled → 're-enable'`、`live → 'view'`，`preset` 与 `capability-gap` 与
`pending-locked` 一律 `null`；并且**前四种状态只在 `canManage` 为真时才给按钮**。
`tooltip` 固定是 ``事件 ${eventName}：${label}``（无权限时**不许**在 tooltip 里泄漏可操作文案）。
`governanceBucket` 与 state 同名（`needs-accept` 与 `pending-locked` 都归
`pending-acceptance` —— 它们是同一个治理待办的两种视图）。

## 校验（抛 `Error`，消息一字不差）

`row must be an object`（整行是 null/undefined）/ `unknown event status` /
`unknown event source` / `unknown analysis kind`

**`disabled` 必须排在 `preset` 之前**：被禁用的预置事件仍然是"停止采集"态，
把它渲染成"预置事件"就等于在一个已经不再产生数据的行上显示"正常"。
**`capability-gap` 必须算"已验收"**：事件本身验收过了，缺的是采集能力 ——
把它归进 `pending-acceptance` 会让催办单流向错误的人
（该去开项目中心的全埋点开关，而不是去找验收人）。

## 这题真正考的东西

素材 §3 那张"常见错误答案"表里有一条：**"埋点上线后有人反馈不对再改"**，
暴露点是"没有验收/变更历史/血缘三件套"。
一个把状态语义渲染正确的列表页，就是这三件套的**入口**：
按钮只给有权限的人、未验收的东西不许被当成可用、
"查不了"要区分"没验收"与"没采集能力"。

（注意：本题只把 DataFinder **文档里可核查的产品状态**做成视图模型。
素材 §7 明确写了字节的客户端/SDK 实现细节没有公开来源，
所以这里不考 SDK 上报时机、不考埋点代码怎么写。）"""

    return base(
        'frontend', 'senior',
        '埋点元数据列表的状态视图模型：预置/验收/禁用/全埋点能力四件事不许混成一个徽标',
        statement, 'react-vitest',
        ['tracking-metadata', 'state-view-model', 'permission-aware-rendering',
         'capability-gap', 'modern:data-governance-ui'],
        src('数据研发 / 数据平台前端（埋点与元数据控制台方向） 高级工程师',
            DATA + '#4 考点 3（埋点契约与元数据工作流：预置事件/属性、'
            '"一般事件列表仅展示已验收的事件"、"数据管理-一般事件-可管理"权限、'
            '禁用事件或属性即停止上报）＋ 考点 5（"热力图、圈选事件功能需开启全埋点才可使用"）。'
            '素材 §7 声明字节的前端/SDK 实现无官方来源，故本题只渲染产品文档里的状态语义'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 60000,
                'files': [{'path': 'eventMeta.test.ts',
                           'content': ts_test_file('eventMetaView',
                                                   'eventMetaView：埋点元数据状态语义',
                                                   cases)}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案要点

一张**优先级表**加两张映射表（文案/tone、action），判分点全在顺序与"谁不该看到按钮"上。

**最值钱的一条是 `capability-gap` 仍 `countsInAcceptedList: true`。**
用例「边界：已验收但分析类型是热力图、全埋点未开」的期望是
`state='capability-gap'`、`bucket='capability-gap'`、`action=null`、`countsInAcceptedList=true`。
它的理由是官方那句"热力图、圈选事件**功能**需开启全埋点才可使用"【源 S8】 ——
被限制的是**分析功能**，不是事件的验收状态。
把它并进 `pending-acceptance` 的后果很具体：控制台把两类待办混在一个筛选里，
于是有人去催验收人签一个已经签过的字，而真正该开的开关三年没人碰。

**`disabled` 压过 `preset`**（用例「边界：被禁用的预置事件」⇒ `state='disabled'`、
`action='re-enable'`）：顺序反过来会得到 `state='preset'` + `action=null`，
即"一个不再产生数据的行显示为正常的预置事件，而且不给恢复按钮" ——
这是**双重静默降级**（状态错 + 无路可走），也是这类列表页最常见的真实 bug。

**权限只能影响 `action`，不许影响 `label`。**
用例「待验收 + 无权限」期望 `tone='muted'` 而**不是** `'warn'`：
对一个没有权限的人标黄报警，等于让他为一件他做不了的事焦虑。
`tooltip` 也必须跟随 `label`，否则"只读"的行会 hover 出"点击完成验收"。

**朴素解挂在哪**：它只看 `status === 'accepted'` 二分。于是
预置事件被判成 `pending-locked`（明明不需要验收）、
被禁用的事件给出 `action='accept'`（一个"验收"按钮去恢复一个被禁用的事件）、
`capability-gap` 完全不存在。**四格里挂三格**，
而每一格都对应一类会真的发出来的工单。

**工程延伸（面试追问点）**

1. 为什么这些要放前端而不是后端返回一个字符串？（**必须**后端返回同一份语义，
   前端只做渲染 —— 但这题考的是"你有没有一份可测的映射"。
   正确工程是：状态机在服务端，前端有一张同样的 label/tone 表并被单测钉住，
   两边不一致时先红的是测试。把判定写在 JSX 里 = 每个调用点各猜一次。）
2. `governanceBucket` 与 `state` 为什么不同？（一个是**视图**、一个是**统计口径**。
   两者独立之后，改版式不会改变指标；反过来（用 state 当统计维度）
   每加一个徽标就会把"已验收事件数"这个指标挪一次。）
3. 为什么 `pending-locked` 与 `needs-accept` 要拆两个 state？（`action` 与 `tone` 都不同，
   合并会让"按钮只在有权限时出现"这件事变成散在各处的 `if`。）""",
    )


# =================================================================== F2 实验报告读数面板
@draft('fe-bd-ab-report-verdict')
def q_ab_report_verdict():
    DENOMS = {'cumulative-dedup', 'daily-active'}

    def verdict_of(inp):
        if not isinstance(inp, dict):
            raise ModelError('input must be an object')
        denom = inp.get('denominator')
        if denom not in DENOMS:
            raise ModelError('unknown denominator')
        exp = inp['expectedSplitBps']
        act = inp['actualSplitBps']
        if exp <= 0 or exp > 10000:
            raise ModelError('expectedSplitBps out of range')
        if act < 0 or act > 10000:
            raise ModelError('actualSplitBps out of range')
        if inp['daysRunning'] < 1:
            raise ModelError('daysRunning must be positive')
        if inp['samplePerGroup'] < 0:
            raise ModelError('samplePerGroup must be non-negative')
        if not isinstance(inp['updatedT1'], bool) or not isinstance(inp['significant'], bool):
            raise ModelError('flags must be booleans')

        dev = abs(act - exp) * 10000 // exp if exp else 0
        blockers = []
        if dev > 1000:
            blockers.append('SRM')
        if denom != 'cumulative-dedup':
            blockers.append('DENOMINATOR')
        if (not inp['updatedT1']) and inp['daysRunning'] > 1:
            blockers.append('STALE')
        if inp['samplePerGroup'] < 1000:
            blockers.append('LOW-SAMPLE')

        if 'SRM' in blockers:
            verdict, tone = 'invalid', 'danger'
            headline = '进组比例偏离预设 %.2f%%，结论不成立' % (dev / 100.0)
        elif 'DENOMINATOR' in blockers:
            verdict, tone = 'hold', 'warn'
            headline = '分母口径不是累计去重进组用户，先换回官方口径再判'
        elif 'STALE' in blockers:
            verdict, tone = 'hold', 'warn'
            headline = '数据未按 T-1 更新，今天的数字还不是结论'
        elif not inp['significant']:
            verdict, tone = 'not-significant', 'muted'
            headline = '未达显著，按预注册时长继续或加样本'
        elif 'LOW-SAMPLE' in blockers:
            verdict, tone = 'watch', 'warn'
            headline = '显著但样本偏少，只做观察不做放行'
        else:
            verdict, tone = 'ship-candidate', 'ok'
            headline = '可提交放行评审'
        return {
            'splitDeviationBps': dev,
            'blockers': blockers,
            'verdict': verdict,
            'tone': tone,
            'headline': headline,
            'canPublish': verdict == 'ship-candidate',
            'liftBps': inp['liftBps'],
        }

    def mk(**kw):
        base_in = {'daysRunning': 3, 'expectedSplitBps': 5000, 'actualSplitBps': 5000,
                   'samplePerGroup': 20000, 'updatedT1': True, 'denominator': 'cumulative-dedup',
                   'significant': True, 'liftBps': 410}
        base_in.update(kw)
        return base_in

    cases = [
        ts_case('基线：累计去重 + 比例均衡 + 已达显著 ⇒ 可提交放行评审', [mk()], verdict_of),
        ts_case('官方口径：进组 48.7% vs 预设 50% ⇒ 相对偏离 260 万分比，未越 1000 线',
                [mk(actualSplitBps=4870)], verdict_of,
                note='素材短题里"两组 51.3%/48.7%"看起来吓人，但相对偏离只有 2.6%；'
                     '判 SRM 看的是"偏离是否超出该样本量的随机波动"，不是"是不是刚好一半"'),
        ts_case('SRM 优先于一切解释：偏离超过 10% 就直接判废',
                [mk(actualSplitBps=4400, liftBps=900)], verdict_of,
                note='dev = |4400-5000|*10000/5000 = 1200 > 1000 ⇒ verdict=invalid，'
                     '此时 +9.00% 的 lift 一个字都不许出现在标题里'),
        ts_case('分母换成就"显著"了 ⇒ 先降级成 hold，不去解释业务',
                [mk(denominator='daily-active')], verdict_of),
        ts_case('边界：实验已开到第 4 天但数据没按 T-1 更新 ⇒ 今天的数不是结论',
                [mk(daysRunning=4, updatedT1=False)], verdict_of),
        ts_case('退化：实验第 1 天尚未 T-1（官方口径：开启当天按实时统计）⇒ 不算 STALE',
                [mk(daysRunning=1, updatedT1=False)], verdict_of),
        ts_case('显著但样本不足 ⇒ watch：能看不能放',
                [mk(samplePerGroup=999)], verdict_of),
        ts_case('边界：样本数恰好等于 1000 ⇒ 不再算 LOW-SAMPLE', [mk(samplePerGroup=1000)],
                verdict_of),
        ts_case('未达显著时不报 blockers 之外的坏消息（blockers 仍要如实列出）',
                [mk(significant=False, samplePerGroup=500)], verdict_of),
        ts_case('非法：整份入参是 null', [None], verdict_of,
                throws_message='input must be an object'),
        ts_case('非法：未知分母口径', [mk(denominator='all-users')], verdict_of,
                throws_message='unknown denominator'),
        ts_case('非法：预设分流比例越界', [mk(expectedSplitBps=0)], verdict_of,
                throws_message='expectedSplitBps out of range'),
        ts_case('非法：实际占比是负数', [mk(actualSplitBps=-1)], verdict_of,
                throws_message='actualSplitBps out of range'),
    ]

    reference = """export interface ReportInput {
  daysRunning: number;
  expectedSplitBps: number;
  actualSplitBps: number;
  samplePerGroup: number;
  updatedT1: boolean;
  denominator: string;
  significant: boolean;
  liftBps: number;
}

export interface ReportView {
  splitDeviationBps: number;
  blockers: string[];
  verdict: string;
  tone: string;
  headline: string;
  canPublish: boolean;
  liftBps: number;
}

const SRM_LIMIT_BPS = 1000;
const MIN_SAMPLE = 1000;

export function reportView(input: ReportInput): ReportView {
  if (input === null || input === undefined || typeof input !== 'object') {
    throw new Error('input must be an object');
  }
  if (input.denominator !== 'cumulative-dedup' && input.denominator !== 'daily-active') {
    throw new Error('unknown denominator');
  }
  if (input.expectedSplitBps <= 0 || input.expectedSplitBps > 10000) {
    throw new Error('expectedSplitBps out of range');
  }
  if (input.actualSplitBps < 0 || input.actualSplitBps > 10000) {
    throw new Error('actualSplitBps out of range');
  }
  if (input.daysRunning < 1) throw new Error('daysRunning must be positive');
  if (input.samplePerGroup < 0) throw new Error('samplePerGroup must be non-negative');
  if (typeof input.updatedT1 !== 'boolean' || typeof input.significant !== 'boolean') {
    throw new Error('flags must be booleans');
  }

  const dev = Math.floor(Math.abs(input.actualSplitBps - input.expectedSplitBps) * 10000
    / input.expectedSplitBps);
  const blockers: string[] = [];
  if (dev > SRM_LIMIT_BPS) blockers.push('SRM');
  if (input.denominator !== 'cumulative-dedup') blockers.push('DENOMINATOR');
  if (!input.updatedT1 && input.daysRunning > 1) blockers.push('STALE');
  if (input.samplePerGroup < MIN_SAMPLE) blockers.push('LOW-SAMPLE');

  let verdict: string;
  let tone: string;
  let headline: string;
  if (blockers.indexOf('SRM') >= 0) {
    verdict = 'invalid';
    tone = 'danger';
    headline = `进组比例偏离预设 ${(dev / 100).toFixed(2)}%，结论不成立`;
  } else if (blockers.indexOf('DENOMINATOR') >= 0) {
    verdict = 'hold';
    tone = 'warn';
    headline = '分母口径不是累计去重进组用户，先换回官方口径再判';
  } else if (blockers.indexOf('STALE') >= 0) {
    verdict = 'hold';
    tone = 'warn';
    headline = '数据未按 T-1 更新，今天的数字还不是结论';
  } else if (!input.significant) {
    verdict = 'not-significant';
    tone = 'muted';
    headline = '未达显著，按预注册时长继续或加样本';
  } else if (blockers.indexOf('LOW-SAMPLE') >= 0) {
    verdict = 'watch';
    tone = 'warn';
    headline = '显著但样本偏少，只做观察不做放行';
  } else {
    verdict = 'ship-candidate';
    tone = 'ok';
    headline = '可提交放行评审';
  }
  return {
    splitDeviationBps: dev,
    blockers,
    verdict,
    tone,
    headline,
    canPublish: verdict === 'ship-candidate',
    liftBps: input.liftBps,
  };
}"""

    naive = """export function reportView(input: any): any {
  // "把 lift 当标题"版：显著就报提升，不看分流是否均衡、不看分母口径、不看更新时点。
  // 这正是"用大盘骗过 SRE"的前端形态：结论区永远是绿的。
  const ok = !!input.significant;
  return {
    splitDeviationBps: 0,
    blockers: [],
    verdict: ok ? 'ship-candidate' : 'not-significant',
    tone: ok ? 'ok' : 'muted',
    headline: ok
      ? `实验组提升 ${(input.liftBps / 100).toFixed(2)}%，可提交放行评审`
      : '未达显著，按预注册时长继续或加样本',
    canPublish: ok,
    liftBps: input.liftBps,
  };
}"""

    statement = """## 背景

火山引擎 A/B 测试的《如何看懂实验报告》给了三条口径事实【源 S10】：

- 统计方式是**多天累计数据**："以进组用户数为例，多天累计的用户数，即是实验期间累计进组并
  **去重**后的用户数"；
- 官方对三种口径的评价："相比单天累计，多天累计更能保证各组的样本是「**同质可比**」的；
  相比多天平均，多天累计更易检验出受影响指标的**显著性**"；
- 更新时点："**实验开启当天按实时统计进组人数，开启第二天之后按 T-1 日天级更新，
  具体口径为截止当天 0 点的实验累计进组人数**"。

《实验报告概述》另给了报告页的形状：天级趋势图、概率分布图、箱型图，
指标分事件/留存/漏斗三类【源 S11】。

至于"进组比例偏离预设多少就该把实验判废"（SRM），**DataTester 的公开文档里没有这条**
（素材 §7 第 4 条明确说明），所以下面的阈值是**本题设定的契约**，
答题时请把它当成"你自己会怎么定这条线与为什么"。

## 任务

实现一个纯函数（实验报告页的**结论区视图模型**）：

```ts
export function reportView(input: ReportInput): ReportView
```

```ts
{
  daysRunning: number;        // 实验已开第几天，>= 1
  expectedSplitBps: number;   // 预设分流比例，万分比（50/50 => 5000）
  actualSplitBps: number;     // 实验组实际进组占比，万分比
  samplePerGroup: number;     // 每组样本数
  updatedT1: boolean;         // 本次读数是不是"截止当天 0 点的 T-1 累计"
  denominator: 'cumulative-dedup' | 'daily-active';
  significant: boolean;
  liftBps: number;            // 指标提升，万分比（410 = +4.10%）
}
```

```ts
{
  splitDeviationBps: number;  // |actual - expected| * 10000 / expected，**向下取整**
  blockers: string[];         // 按下面顺序收集，命中才 push（可以多个）
  verdict: 'invalid' | 'hold' | 'not-significant' | 'watch' | 'ship-candidate';
  tone: 'danger' | 'warn' | 'muted' | 'ok';
  headline: string;
  canPublish: boolean;
  liftBps: number;            // 原样透传（结论区不许改数字，只许改措辞）
}
```

## blockers 的收集顺序（**顺序即优先级**）

| 码 | 条件 |
| --- | --- |
| `SRM` | `splitDeviationBps > 1000`（相对偏离超过 10%） |
| `DENOMINATOR` | `denominator !== 'cumulative-dedup'` |
| `STALE` | `!updatedT1` **且** `daysRunning > 1` |
| `LOW-SAMPLE` | `samplePerGroup < 1000` |

`verdict` / `headline` / `tone` 按第一个命中的 blocker 决定（**从上到下，命中即止**）：

| 条件 | verdict | tone | headline |
| --- | --- | --- | --- |
| 有 `SRM` | `invalid` | danger | `进组比例偏离预设 X%，结论不成立`（X = dev/100，两位小数） |
| 有 `DENOMINATOR` | `hold` | warn | `分母口径不是累计去重进组用户，先换回官方口径再判` |
| 有 `STALE` | `hold` | warn | `数据未按 T-1 更新，今天的数字还不是结论` |
| 无 blocker 但 `!significant` | `not-significant` | muted | `未达显著，按预注册时长继续或加样本` |
| 有 `LOW-SAMPLE` | `watch` | warn | `显著但样本偏少，只做观察不做放行` |
| 其余 | `ship-candidate` | ok | `可提交放行评审` |

`canPublish` 只在 `ship-candidate` 时为 `true`。

四条口径纪律（这题的全部难点在这四条）：

- **`SRM` 压过一切，包括"已达显著"。**
  进组比例本身就是分流系统的输出，它偏了 ⇒ 两组的"同质可比"前提不成立，
  此时任何 p 值都是在错的总体上算的。**先作废、再解释**，顺序反了就是在编故事。
- **`STALE` 的判据是 `daysRunning > 1`，不是 `!updatedT1`。**
  官方口径就是"开启当天按实时统计"【源 S10】⇒ 第 1 天没有 T-1 是**正常**的。
  把它判成 stale，实验平台会在每次开新实验的那天自动报一条假警。
- **`LOW-SAMPLE` 排在"未达显著"之后。**
  都不显著的实验没有"能不能放行"的问题，先说结论再说样本；
  反过来会把"样本不足 ⇒ 当然不显著"这件事从待办列表里藏起来。
- **`blockers` 要全部列出，`headline` 只说一个。**
  只保留第一个 = 修掉 SRM 之后还得再进一轮才知道分母也错了。

## 校验（抛 `Error`，消息一字不差）

`input must be an object` / `unknown denominator` / `expectedSplitBps out of range` /
`actualSplitBps out of range` / `daysRunning must be positive` /
`samplePerGroup must be non-negative` / `flags must be booleans`

## 这题真正考的东西

素材 §3 的"常见错误答案"表里那条 **"实验开一天看不出显著就拉长"**，
和这条更接近：**"降级之后错误率为什么掉了"** ——
两者都是**读数面板替结论做了粉饰**。
结论区的职责不是给一个好看的答案，是**在证据不足时拒绝给出答案**。
所以本题把 `canPublish` 单独拉出来：它必须**只能**由 `ship-candidate` 得出。"""

    return base(
        'frontend', 'senior',
        '实验报告结论区：SRM 压过显著性，T-1 与分母口径不满足就不许给放行按钮',
        statement, 'react-vitest',
        ['ab-reading-caliber', 'srm-check', 'evidence-gate', 'permission-aware-rendering',
         'modern:experimentation'],
        src('数据研发 / 实验平台前端（A/B 测试方向） 高级工程师',
            DATA + '#4 考点 12（实验读数口径：多天累计、进组用户累计去重、'
            '"开启当天实时、次日起 T-1 且口径为截止当天 0 点"）＋ 考点 11/13'
            '（SRM 与样本量：素材 §7 第 4 条声明 DataTester 未公开 SRM 能力，'
            '故本题阈值写成【推】= 题面设定的契约）'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 60000,
                'files': [{'path': 'reportView.test.ts',
                           'content': ts_test_file('reportView',
                                                   'reportView：实验报告结论区读数口径',
                                                   cases)}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer="""## 参考答案要点

`splitDeviationBps` 用 `Math.abs(actual - expected) * 10000 / expected` 再 `Math.floor`
—— 注意分母是**预设值**而不是 10000：
"偏离多少"要相对"应该有多少"来度量，否则 50/50 与 1/99 的分流会用同一条线。

**官方那个"48.7% vs 50%"的例子算出来是 260 万分比（2.60%）⇒ 不触发 SRM。**
用例「官方口径：进组 48.7% vs 预设 50%」的期望是 `verdict='ship-candidate'`
且 `splitDeviationBps=260`。这条用例存在的全部理由就是**打脸"不是刚好一半就是有问题"**：
真实分流本来就是随机的，2.6% 的相对偏离在几万样本下完全在波动内。
阈值线该定在哪是【推】（素材 §7 第 4 条：DataTester 没公开 SRM 能力），
但"必须按**相对偏离**而不是绝对差判"这件事是确定的 ——
绝对差 130 万分比在 50/50 里是噪声，在 1/99 的分流里是天塌。

**`SRM` 命中时 `liftBps` 仍然原样透传，但 headline 里一个字都不提。**
用例「SRM 优先于一切解释」的 `liftBps=900`（+9.00%）出现在返回对象的
`liftBps` 字段里，而 `headline` 是"进组比例偏离预设 12.00%，结论不成立"。
**这就是"结论区只改措辞、不改数字"**：
数据一行都不许动（否则下游看板与报告对不上），
能动的只有"这一轮的结论允不允许被说出来"。
朴素解反过来 —— 它把 lift 写进标题、`blockers` 恒空、`canPublish` 直接等于 `significant`，
于是它在那条 +9% 的用例上给出 `ship-candidate`：一次可以被直接放行到线上的假结论。

**`STALE` 与第 1 天的关系**（用例「退化：实验第 1 天尚未 T-1」⇒ 不是 STALE）：
判据写成 `daysRunning > 1` 是因为官方口径就是"开启当天按实时统计进组人数"【源 S10】。
少了这个条件，每次开新实验当天都会亮一条黄警 ——
而**一条必然误报的告警等于没有告警**，这和熔断器 `MinSample` 是同一类问题。

**`LOW-SAMPLE` 排在"未达显著"之后**（用例「未达显著时不报 blockers 之外的坏消息」：
`significant=false, samplePerGroup=500` ⇒ `verdict='not-significant'`
但 `blockers=['LOW-SAMPLE']`）：
标题说"未达显著"，待办列表仍然要说"样本不足"。
两者不冲突，**缺哪一个都会让下一轮实验的样本量继续拍脑袋**。

**工程延伸（面试追问点）**

1. 这些判据该在前端还是后端？（**判定在后端，渲染在前端**。
   这题把它做成纯函数是为了可测；真实系统里 `verdict` 必须由服务端给出，
   否则"前端自己判能不能发布"是可以被 DevTools 绕过的。）
2. `canPublish` 与 `verdict` 为什么两个都要？（`verdict` 是给人看的结论，
   `canPublish` 是给按钮的开关。只留 `verdict` ⇒ 每个按钮各自 `verdict === '...'`，
   新增一个状态时一定有人忘；只留 `canPublish` ⇒ 界面说不出为什么不能点。）
3. 还要哪些 blocker？（同层互斥违例（同一批人被两个实验抢占）【源 S9】、
   父子继承（结论外推边界）【源 S9】、多重比较（同一天看 20 个指标必有显著）【推】、
   窥视（每天看一次显著就停）【推】。
   `blockers` 设计成**有序数组**正是为了往里加而不改 verdict 的语义。）""",
    )


# =================================================================== MySQL 公共底座
#
# 一条用例只描述一次"与基线的差异"：先改**内存行集**，再由同一份行集同时产出
# `runner.setup` / `cases[].input` 的变异 SQL 与 `cases[].expected`。
# 分两处写必然漂移（本仓库 price-grid 那题就是这么算错带 DELETE 的用例的）。
#
# **因此本题库禁止一种变异：`raw`（只发 SQL、不改内存行集）。**
# 第一版写过它，结果三条用例的 expected 悄悄等于基线（清空表的 SQL 只作用在数据库里），
# 用例名说"空集"、内容给七行 —— 而矩阵照样全绿（矩阵只比参考解与朴素解是否不同）。
# 现在只有 ins / del / set / clr 四种，每一种都必须留下内存行集的改动痕迹。
def sql_lit(value):
    if value is None:
        return 'NULL'
    if isinstance(value, bool):
        return '1' if value else '0'
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    return repr(value) if isinstance(value, float) else str(value)


def sql_seed(schema, seed):
    stmts = ['DROP TABLE IF EXISTS `%s`' % t for t in schema]
    for tbl, spec in schema.items():
        stmts.append('CREATE TABLE %s (%s) ENGINE=InnoDB' % (tbl, ', '.join(spec['ddl'])))
    for tbl, spec in schema.items():
        rows = seed[tbl]
        if rows:
            stmts.append('INSERT INTO %s VALUES %s' % (tbl, ', '.join(
                '(' + ', '.join(sql_lit(v) for v in row) + ')' for row in rows)))
    return stmts


def mut_case(name, schema, seed, mutations, columns, evaluate, note=None):
    """变异驱动的 MySQL 用例。写错主键、写未知变异都会当场炸。"""
    rows = {t: [list(r) for r in seed[t]] for t in schema}
    sqls = []
    for mut in mutations:
        kind = mut[0]
        if kind == 'ins':
            _, tbl, row = mut
            spec = schema[tbl]
            if len(row) != len(spec['cols']):
                raise AssertionError(f'用例「{name}」插进 {tbl} 的行有 {len(row)} 列，'
                                     f'表定义是 {len(spec["cols"])} 列')
            for cur in rows[tbl]:
                if cur[spec['pk_idx']] == row[spec['pk_idx']]:
                    raise AssertionError(f'用例「{name}」插入的主键重复：{tbl}.{row[spec["pk_idx"]]}')
            rows[tbl].append(list(row))
            sqls.append('INSERT INTO %s VALUES (%s)'
                        % (tbl, ', '.join(sql_lit(v) for v in row)))
        elif kind == 'del':
            _, tbl, pk = mut
            spec = schema[tbl]
            before = len(rows[tbl])
            rows[tbl] = [r for r in rows[tbl] if r[spec['pk_idx']] != pk]
            if len(rows[tbl]) == before:
                raise AssertionError(f'用例「{name}」删了不存在的主键 {tbl}.{pk}')
            sqls.append('DELETE FROM %s WHERE %s = %s' % (tbl, spec['pk'], sql_lit(pk)))
        elif kind == 'set':
            _, tbl, pk, changes = mut
            spec = schema[tbl]
            hit = False
            for row in rows[tbl]:
                if row[spec['pk_idx']] == pk:
                    for col, val in changes.items():
                        row[spec['cols'].index(col)] = val
                    hit = True
            if not hit:
                raise AssertionError(f'用例「{name}」改了不存在的主键 {tbl}.{pk}')
            sets = ', '.join('%s = %s' % (c, sql_lit(v)) for c, v in changes.items())
            sqls.append('UPDATE %s SET %s WHERE %s = %s'
                        % (tbl, sets, spec['pk'], sql_lit(pk)))
        elif kind == 'setcol':
            # 按等值条件批量改一列。内存行集与 SQL 语句仍然同源 ——
            # 这是为了写"把整个下游的降级标记抹掉"这类**跨行**变异，
            # 而不是退回只改数据库、不改期望值的 raw 语句。
            _, tbl, wcol, wval, col, val = mut
            spec = schema[tbl]
            hit = 0
            for row in rows[tbl]:
                if row[spec['cols'].index(wcol)] == wval:
                    row[spec['cols'].index(col)] = val
                    hit += 1
            if hit == 0:
                raise AssertionError(f'用例「{name}」的 setcol 没命中任何行：{tbl}.{wcol}={wval}')
            sqls.append('UPDATE %s SET %s = %s WHERE %s = %s'
                        % (tbl, col, sql_lit(val), wcol, sql_lit(wval)))
        elif kind == 'clr':
            _, tbl = mut
            spec = schema[tbl]
            if not rows[tbl]:
                raise AssertionError(f'用例「{name}」清空了一张本来就空的表 {tbl}')
            rows[tbl] = []
            sqls.append('DELETE FROM %s' % tbl)
        else:
            raise AssertionError(f'用例「{name}」用了未知变异 {kind}')
    computed = evaluate(rows)
    case = {'name': name, 'input': sqls}
    if computed:
        case['expected'] = {'columns': columns, 'rows': computed, 'orderSensitive': True}
    else:
        # 空结果集**必须**写裸 []：mysql --batch 在 0 行时连表头都不输出，
        # 带 columns 的期望值会报"列名不一致"——那是构造上判不了的（docs/JUDGING.md mysql 一节）。
        case['expected'] = []
    if note:
        case['note'] = note
    if computed and note and '空集' in name:
        raise AssertionError(f'用例「{name}」名字叫空集，模型却给出了 {len(computed)} 行')
    return case


def table_spec(pk, cols, ddl):
    return {'pk': pk, 'pk_idx': cols.index(pk), 'cols': cols, 'ddl': ddl}


def bps(num, den):
    """万分比（向下取整）。全整数域，避免 Python 与 MySQL 的取整规则两边漂移。"""
    if den == 0:
        return 0
    from decimal import Decimal, ROUND_FLOOR
    v = Decimal(num) * 10000 / Decimal(den)
    return int(v.to_integral_value(rounding=ROUND_FLOOR))


def round2(num, den):
    if den == 0:
        return 0.0
    from decimal import Decimal, ROUND_HALF_UP
    return float((Decimal(num) / Decimal(den)).quantize(Decimal('0.01'),
                                                        rounding=ROUND_HALF_UP))


# =================================================================== M1 埋点四类违规
@draft('sql-bd-tracking-violations')
def q_tracking_violations():
    META = [
        ['$page_start', 1, 0, 1, 0],       # 预置、不在业务录入清单、已验收 ⇒ 一律 ok
        ['pay_success', 0, 1, 1, 0],       # 正常
        ['ghost_event', 0, 0, 0, 0],       # 未录入却在上报
        ['new_checkout', 0, 1, 0, 0],      # 已录入未验收
        ['legacy_click', 0, 1, 1, 1],      # 已禁用仍在上报
        ['noisy_event', 0, 1, 1, 0],       # 属性缺填率 12% ⇒ 越线
        ['tiny_event', 0, 1, 1, 0],        # 缺填率越线但样本不足 ⇒ 不报
    ]
    STAT = [
        ['$page_start', 90000, 120, 90000],
        ['pay_success', 4200, 8, 4200],
        ['ghost_event', 300, 0, 300],
        ['new_checkout', 900, 40, 900],
        ['legacy_click', 17, 3, 17],
        ['noisy_event', 500, 60, 500],
        ['tiny_event', 40, 8, 40],
    ]
    SCHEMA = {
        'event_meta': table_spec(
            'event_name',
            ['event_name', 'is_preset', 'registered', 'verified', 'disabled'],
            ['event_name VARCHAR(64) NOT NULL PRIMARY KEY', 'is_preset TINYINT NOT NULL',
             'registered TINYINT NOT NULL', 'verified TINYINT NOT NULL',
             'disabled TINYINT NOT NULL']),
        'upload_stat': table_spec(
            'event_name',
            ['event_name', 'uploads', 'prop_null', 'prop_total'],
            ['event_name VARCHAR(64) NOT NULL PRIMARY KEY', 'uploads INT NOT NULL',
             'prop_null INT NOT NULL', 'prop_total INT NOT NULL']),
    }
    SEED = {'event_meta': META, 'upload_stat': STAT}

    def evaluate(rows):
        meta = {r[0]: r for r in rows['event_meta']}
        out = []
        for ev, uploads, pnull, ptotal in sorted(rows['upload_stat'], key=lambda r: r[0]):
            m = meta.get(ev)
            preset, registered, verified, disabled = (m[1], m[2], m[3], m[4]) if m else (0, 0, 0, 0)
            rate = bps(pnull, ptotal) if ptotal else 0
            if m is None or (registered == 0 and preset == 0):
                v = 'not-registered'
            elif verified == 0:
                v = 'unverified'
            elif disabled == 1 and uploads > 0:
                v = 'disabled-still-uploading'
            elif preset == 1:
                v = 'ok'
            elif uploads >= 100 and ptotal > 0 and rate >= 500:
                v = 'prop-missing-rate'
            else:
                v = 'ok'
            out.append([ev, uploads, v, rate])
        return out

    COLS = ['event_name', 'uploads', 'violation', 'missing_bps']

    cases = [
        mut_case('基线：四类违规各命中一次，另有一条"样本不足所以不报"和一条正常',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='$page_start 是预置事件 ⇒ ok；ghost_event 未录入上报；'
                      'new_checkout 未验收；legacy_click 已禁用仍在上报；'
                      'noisy_event 缺填率 1200 万分比越 500 线；tiny_event 同样越线'
                      '但 uploads=40 < 100 ⇒ 不报'),
        mut_case('边界：预置事件即使缺填率爆表也不走业务治理口径',
                 SCHEMA, SEED,
                 [('set', 'upload_stat', '$page_start', {'prop_null': 80000})],
                 COLS, evaluate,
                 note='8888 万分比的缺填率仍然输出 ok —— 预置属性的采集时机由系统统一配置，'
                      '把它混进业务违规清单会让人天天去催错误的团队'),
        mut_case('边界：验收状态修复之后，同一条上报才落到"属性缺填率"这一档',
                 SCHEMA, SEED,
                 [('set', 'event_meta', 'new_checkout', {'verified': 1})],
                 COLS, evaluate,
                 note='new_checkout 缺填率 444 万分比 < 500 ⇒ 变成 ok；'
                      '若把第 2 条（未验收）与第 5 条（缺填率）顺序写反，这条用例不变绿'),
        mut_case('边界：把禁用标记清掉 ⇒ 该事件立刻从"已禁用仍在上报"变成正常',
                 SCHEMA, SEED,
                 [('set', 'event_meta', 'legacy_click', {'disabled': 0})],
                 COLS, evaluate,
                 note='legacy_click 缺填率 1764 万分比，但 uploads=17 < 100 ⇒ 仍是 ok。'
                      '它之前被抓是因为"禁用后还在上报"，不是缺填'),
        mut_case('退化：没有任何上报统计 ⇒ 结果必须是空集',
                 SCHEMA, SEED, [('clr', 'upload_stat')], COLS, evaluate),
        mut_case('非法形态：上报里出现了元数据里根本不存在的事件（按未录入处理）',
                 SCHEMA, SEED,
                 [('ins', 'upload_stat', ['stray_event', 5000, 0, 5000])],
                 COLS, evaluate,
                 note='元数据缺行等价于"没录入过"：LEFT JOIN 之后 NULL 不许被 WHEN 漏掉，'
                      '否则这 5000 次上报在报表里彻底隐身'),
        mut_case('边界：已禁用且确实不再上报 ⇒ 不算违规（治理成功了）',
                 SCHEMA, SEED,
                 [('set', 'upload_stat', 'legacy_click', {'uploads': 0, 'prop_null': 0})],
                 COLS, evaluate),
    ]

    reference = """SELECT u.event_name                                   AS event_name,
       u.uploads                                        AS uploads,
       CASE
         WHEN m.event_name IS NULL THEN 'not-registered'
         WHEN m.registered = 0 AND m.is_preset = 0 THEN 'not-registered'
         WHEN m.verified = 0 THEN 'unverified'
         WHEN m.disabled = 1 AND u.uploads > 0 THEN 'disabled-still-uploading'
         WHEN m.is_preset = 1 THEN 'ok'
         WHEN u.uploads >= 100 AND u.prop_total > 0
              AND FLOOR(u.prop_null * 10000 / u.prop_total) >= 500 THEN 'prop-missing-rate'
         ELSE 'ok'
       END                                              AS violation,
       CASE WHEN u.prop_total > 0
            THEN FLOOR(u.prop_null * 10000 / u.prop_total) ELSE 0 END AS missing_bps
FROM upload_stat u
LEFT JOIN event_meta m ON m.event_name = u.event_name
ORDER BY u.event_name"""

    naive = """SELECT u.event_name AS event_name,
       u.uploads    AS uploads,
       CASE WHEN m.verified = 0 THEN 'unverified'
            WHEN FLOOR(u.prop_null * 10000 / u.prop_total) >= 500 THEN 'prop-missing-rate'
            ELSE 'ok' END AS violation,
       FLOOR(u.prop_null * 10000 / u.prop_total) AS missing_bps
FROM upload_stat u
JOIN event_meta m ON m.event_name = u.event_name
ORDER BY u.event_name"""

    statement = """## 背景

DataFinder 把埋点写成了一个**元数据工作流**，而不是一句"上报了就有数据"【源 S7/S8】。
可以直接核查的原文事实：

- 治理动作的顺序是"**先规划 → 在控制台录入埋点和属性（先落库）→ 集成 SDK 时配置上报**"，
  也就是"**控制台先落库，SDK 再上报**"；
- "**一般事件列表仅展示已验收的事件**，未验收事件可点击验收事件查看并完成验收"；
- 停止采集靠"数据管理 > 元数据管理中**禁用对应事件或属性**"，**无需改代码**；
- "**预置事件与预置属性**"是"SDK 自带、由系统统一配置上报时机"的一类，与业务自定义事件不同源。

"四类违规"这个归因框架是素材 §4 考点 3 标注的【推】—— 所以判据全部写在下面，
不要引用"字节内部怎么规定"。

## 表

```
event_meta(event_name VARCHAR(64) PK, is_preset TINYINT, registered TINYINT,
           verified TINYINT, disabled TINYINT)
upload_stat(event_name VARCHAR(64) PK, uploads INT, prop_null INT, prop_total INT)
```

`registered` = 是否已在控制台录入；`prop_null / prop_total` = 关键业务属性的缺填计数。

## 任务

只交**一条 SELECT**。对 `upload_stat` 里的**每一个事件**输出一行
（不要过滤掉正常的），列固定：

```
event_name, uploads, violation, missing_bps
```

`violation` 按**优先级从上到下，命中即止**：

| # | 条件 | violation |
| --- | --- | --- |
| 1 | 元数据里查不到这个事件，或 `registered = 0` 且 `is_preset = 0` | `not-registered` |
| 2 | `verified = 0` | `unverified` |
| 3 | `disabled = 1` 且 `uploads > 0` | `disabled-still-uploading` |
| 4 | `is_preset = 1` | `ok`（预置事件到此为止，不参与缺填率判定） |
| 5 | `uploads >= 100` 且 `prop_total > 0` 且 `FLOOR(prop_null*10000/prop_total) >= 500` | `prop-missing-rate` |
| 6 | 其余 | `ok` |

`missing_bps` = `FLOOR(prop_null * 10000 / prop_total)`；`prop_total = 0` 时输出 `0`。
按 `event_name` 升序。

## 判据为什么长这样

- **`is_preset` 要参与第 1 条**：预置事件本来就不在业务录入清单里，
  拿"未录入"去报它，等于把 SDK 自带的 `$page_start` 天天挂成违规。
- **第 4 条放在缺填率之前**：预置**属性**的采集时机由系统统一配置【源 S7】，
  缺填是 SDK 版本/接入方式的问题，不是业务方漏埋。
  但预置事件**仍然**会被第 2、3 条抓 —— 未验收与"禁用后仍在上报"是流程问题，与来源无关。
- **验收先于属性缺填率**：未验收事件的属性**还没人核对过**，
  缺填率算出来再高也不可信；顺序反了就会拿一份没验收的口径去立项。
- **缺填率要样本门槛（100 次）**：理由与熔断器的 `MinSample=200` 完全一致 ——
  10 次上报里 2 次没属性就是 20%，看着爆表实则噪声。
- **第 3 条要 `uploads > 0`**：已经禁用了、也确实没再上报，那是**治理成功了**，
  不该继续出现在违规清单里。

## 陷阱提示（判题器会专门测这几条）

`upload_stat` 里可能有 `event_meta` 中**不存在**的事件名（SDK 侧偷偷加了埋点）。
用 `JOIN` 而不是 `LEFT JOIN` 会把这类事件**整行丢掉** ——
而那恰恰是最该被看见的一类违规："控制台先落库"这条顺序被跳过了。
NULL 在第 1 条里必须显式判（`m.event_name IS NULL`），
别指望 `m.registered = 0` 会把 NULL 算成成立 —— SQL 的三值逻辑里它结果是 UNKNOWN。

只允许一条 `SELECT`（白名单会拒多语句）。"""

    return base(
        'sql', 'senior',
        '埋点四类违规体检：未录入上报 / 未验收 / 禁用仍在报 / 属性缺填率',
        statement, 'mysql',
        ['tracking-governance', 'metadata-workflow', 'priority-rules', 'left-join-null',
         'modern:data-governance'],
        src('数据研发（埋点治理与元数据方向） 高级工程师',
            DATA + '#4 考点 3（埋点契约与元数据工作流：mysql 版建议'
            '"给上报明细 + 元数据表，找未录入上报/未验收/已禁用仍在上报/属性缺填率异常'
            '四类违规并分类归因"，四类归因框架素材标【推】）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=25,
        answer="""## 参考答案

一条 `LEFT JOIN` + 一个六档 `CASE`。四个判分点，每一个都有对应的用例：

**基线七行输出**（`uploads` / `missing_bps` 都照表算）：
`$page_start` → `ok`（缺填率 13 万分比，走第 4 条短路）；`ghost_event` → `not-registered`；
`legacy_click` → `disabled-still-uploading`（缺填率 1764，但第 3 条先到）；
`new_checkout` → `unverified`；`noisy_event` → `prop-missing-rate`
（60/500 ⇒ 1200 万分比 ≥ 500）；`pay_success` → `ok`（19 万分比）；
`tiny_event` → `ok` —— **它的缺填率是 2000 万分比，比 noisy_event 还高一截，
唯一差别是 uploads=40 < 100。**

`tiny_event` 与 `noisy_event` 是刻意配成一对的：
**缺填率排序与违规排序是相反的。**
去掉 `uploads >= 100` 这一侧，违规清单会被长尾事件灌满，
于是这份清单在三个月后不再有人看 —— 与"误报的代价不是误报本身，是把真信号淹掉"同源。

**用例「边界：预置事件即使缺填率爆表也不走业务治理口径」把 `$page_start` 的缺填改成
80000/90000 ⇒ 8888 万分比，输出仍然必须是 `ok`。**
没有第 4 条的实现会把它报成 `prop-missing-rate`，
而这张表的使用者（业务数据 owner）对预置属性**什么都改不了** ——
一条指不出责任人的告警，就是噪音。
反过来，预置事件仍然会被第 2、3 条抓：`$page_start` 的 `verified` 若是 0，
它照样是 `unverified`（流程约束与来源无关）。

**新插入的 `stray_event` 在 `event_meta` 里没有行。**
`LEFT JOIN` 之后 `m.registered` 是 NULL，而三值逻辑里 `NULL = 0` **不为真**，
所以第 1 条必须写成 `m.event_name IS NULL OR (m.registered = 0 AND ...)`。
只写 `m.registered = 0` 的实现会一路落到 `ELSE 'ok'`：
**一条 5000 次上报、控制台从未登记过的埋点，在治理报表里显示为"正常"。**
（`naiveSolution` 更糟：它用 `JOIN`，这一行根本不出现在结果里。）

**`missing_bps` 单独成一列而不是塞进 violation 的理由**：
`prop-missing-rate` 只回答"这条越过了本次阈值"，
而治理看板要的是**分布** —— 多少事件落在 500~1000、多少在 3000 以上。
把数值压成枚举，下次改阈值就没有历史可比。

**`naiveSolution` 挂四处**：`JOIN` 丢掉未录入上报的那一行；
不判 `registered`；不判 `disabled`；缺填率没有样本门槛
（`tiny_event` 会被它报成违规，`legacy_click` 的 1764 也会被报成缺填率问题而不是禁用问题）。

**工程延伸（面试追问点）**

1. 为什么"未录入上报"排第一？（它破坏的是整条链路的**前提**
   —— "先落库再上报"。事件都不存在时，验收、禁用、血缘统统无从谈起，
   所以这一档要最先判、也要单独打点。）
2. 阈值 500 万分比与 100 次样本从哪来？（本题设定。**答题要给的是推导方法**：
   先看该属性在历史事件上的缺填率分布，把线画在 p99 之外；
   样本门槛要让"二项分布在阈值处的上界"仍然够不到线，否则全是抖动。）
3. 属性缺填和属性缺失是一回事吗？（不是。`prop_null` 是"没传"，
   还有一种是"传了空串"。SDK 里空串与 NULL 常常混用，
   所以真实实现要再加一列 `prop_empty`，并把两者分开统计 ——
   **用 `IS NULL` 算缺失率会漏掉一整类语义**，这与"地址字段返回空串却被算成缺失"
   是同一类口径事故。）
4. 这份清单怎么变成卡口？（素材考点 7 的答案是平台职责："数据标准 + 字段元数据对标 +
   标准监控统计"【源 S6】。也就是把第 1 条做成 CI 阻断（SDK 里出现未在控制台登记的事件名
   就构建失败），而不是每周出一张报表。）""",
    )


# =================================================================== M2 累计去重 vs 天级活跃
@draft('sql-bd-ab-cumulative-dedup')
def q_ab_cumulative_dedup():
    ASSIGN = [
        [1, 'E1', 'treat', 'u1', '2026-09-01'],
        [2, 'E1', 'treat', 'u2', '2026-09-01'],
        [3, 'E1', 'treat', 'u1', '2026-09-02'],    # 同一用户第二天又进组（必须去重）
        [4, 'E1', 'treat', 'u3', '2026-09-02'],
        [5, 'E1', 'treat', 'u2', '2026-09-03'],    # 又一次重复
        [6, 'E1', 'ctrl', 'u4', '2026-09-01'],
        [7, 'E1', 'ctrl', 'u5', '2026-09-02'],
        [8, 'E1', 'ctrl', 'u6', '2026-09-02'],
        [9, 'E2', 'treat', 'u1', '2026-09-01'],    # u1 同时被两个实验吃进去
        [10, 'E2', 'treat', 'u7', '2026-09-05'],
        [11, 'E2', 'ctrl', 'u8', '2026-09-05'],
        [12, 'E1', 'treat', 'u1', '2026-09-02'],   # 同一用户同一天两条流水（重复上报）
    ]
    CONV = [
        [1, 'u1', 30000],
        [2, 'u2', 12000],
        [3, 'u3', 8000],
        [4, 'u4', 5000],
        [5, 'u1', 2000],      # 同一用户两笔成交
        [6, 'u7', 99000],
        [7, 'u8', 100],
        [8, 'u9', 7700],      # 有成交但从没进过任何组
    ]
    SCHEMA = {
        'assignment': table_spec(
            'id',
            ['id', 'exp_id', 'group_name', 'user_id', 'assigned_date'],
            ['id INT NOT NULL PRIMARY KEY', 'exp_id VARCHAR(16) NOT NULL',
             'group_name VARCHAR(16) NOT NULL', 'user_id VARCHAR(16) NOT NULL',
             'assigned_date CHAR(10) NOT NULL']),
        'conversion': table_spec(
            'id',
            ['id', 'user_id', 'gmv_fen'],
            ['id INT NOT NULL PRIMARY KEY', 'user_id VARCHAR(16) NOT NULL',
             'gmv_fen BIGINT NOT NULL']),
    }
    SEED = {'assignment': ASSIGN, 'conversion': CONV}

    def evaluate(rows):
        import collections
        user_days = collections.defaultdict(set)
        cum = collections.defaultdict(set)
        days = collections.defaultdict(set)
        for _id, exp, grp, uid, ds in rows['assignment']:
            user_days[(exp, grp)].add((uid, ds))
            cum[(exp, grp)].add(uid)
            days[(exp, grp)].add(ds)
        gmv = collections.defaultdict(int)
        for conv in rows['conversion']:
            gmv[conv[1]] += conv[2]
        out = []
        for key in sorted(cum):
            exp, grp = key
            users = cum[key]
            dsum = len(user_days[key])
            n_days = len(days[key])
            money = sum(gmv.get(u, 0) for u in users)
            out.append([exp, grp, len(users), dsum, n_days, round2(dsum, n_days), money,
                        money // len(users)])
        return out

    COLS = ['exp_id', 'group_name', 'users_cum', 'users_daily_sum', 'days',
            'avg_daily_users', 'gmv_fen', 'arpu_cum_fen']

    cases = [
        mut_case('基线：跨天重复 + 同日重复流水都要吃掉，两种口径的人数与 ARPU 同时输出',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='E1/treat 有 6 条流水、3 个去重用户、5 个"用户-天" ⇒ '
                      'daily_sum=5、days=3、avg 1.67。COUNT(*) 会给出 6，'
                      '不去重的 users_cum 会给出 6'),
        mut_case('边界：同一用户被两个实验各吃进去一次，他的 GMV 在两个实验里各算一遍',
                 SCHEMA, SEED,
                 [('ins', 'assignment', [13, 'E2', 'treat', 'u2', '2026-09-05'])],
                 COLS, evaluate,
                 note='u2 的 12000 分同时进 E1/treat 与 E2/treat 的分子 ⇒ '
                      '把各实验的 GMV 加起来会大于真实总成交'),
        mut_case('把某用户那天的重复流水与原始流水一起删掉 ⇒ 去重人数不变、日均变小',
                 SCHEMA, SEED,
                 [('del', 'assignment', 3), ('del', 'assignment', 12)],
                 COLS, evaluate,
                 note='只删 id 3 不删 id 12 时"用户-天"仍是 5 —— 这正是同日重复的作用；'
                      '两条一起删才让 daily_sum 掉到 4 ⇒ avg 1.33'),
        mut_case('新增一个从未成交的用户 ⇒ 分母变大、ARPU 变小（这就是分母敏感）',
                 SCHEMA, SEED,
                 [('ins', 'assignment', [14, 'E1', 'treat', 'u99', '2026-09-03'])],
                 COLS, evaluate,
                 note='u99 没有任何成交 ⇒ gmv 不变而 users_cum 从 3 变 4，'
                      'E1/treat 的 arpu 从 17333 掉到 13000'),
        mut_case('边界：有成交但从未进过任何组的用户，一分都不许进实验分子',
                 SCHEMA, SEED, [('clr', 'assignment')], COLS, evaluate,
                 note='进组流水清空 ⇒ 结果必须是空集（连 u9 的 7700 分都不能出现）'),
        mut_case('清空成交表 ⇒ ARPU 与 GMV 归零，但进组人数与四个分组行都不许消失',
                 SCHEMA, SEED, [('clr', 'conversion')], COLS, evaluate),
    ]

    reference = """SELECT g.exp_id                                       AS exp_id,
       g.group_name                                     AS group_name,
       g.users_cum                                      AS users_cum,
       g.users_daily_sum                                AS users_daily_sum,
       dd.days                                          AS days,
       ROUND(g.users_daily_sum / dd.days, 2)            AS avg_daily_users,
       COALESCE(m.gmv_fen, 0)                           AS gmv_fen,
       FLOOR(COALESCE(m.gmv_fen, 0) / g.users_cum)      AS arpu_cum_fen
FROM (SELECT exp_id, group_name,
             COUNT(DISTINCT user_id) AS users_cum,
             COUNT(DISTINCT user_id, assigned_date) AS users_daily_sum
      FROM assignment
      GROUP BY exp_id, group_name) g
JOIN (SELECT exp_id, group_name, COUNT(DISTINCT assigned_date) AS days
      FROM assignment
      GROUP BY exp_id, group_name) dd
  ON dd.exp_id = g.exp_id AND dd.group_name = g.group_name
LEFT JOIN (SELECT a.exp_id                            AS exp_id,
                  a.group_name                        AS group_name,
                  SUM(c.gmv_fen)                      AS gmv_fen
           FROM (SELECT DISTINCT exp_id, group_name, user_id FROM assignment) a
           JOIN (SELECT user_id, SUM(gmv_fen) AS gmv_fen
                 FROM conversion GROUP BY user_id) c
             ON c.user_id = a.user_id
           GROUP BY a.exp_id, a.group_name) m
  ON m.exp_id = g.exp_id AND m.group_name = g.group_name
ORDER BY g.exp_id, g.group_name"""

    naive = """SELECT a.exp_id                                   AS exp_id,
       a.group_name                                 AS group_name,
       COUNT(*)                                     AS users_cum,
       COUNT(*)                                     AS users_daily_sum,
       COUNT(DISTINCT a.assigned_date)              AS days,
       ROUND(COUNT(*) / COUNT(DISTINCT a.assigned_date), 2) AS avg_daily_users,
       SUM(c.gmv_fen)                               AS gmv_fen,
       FLOOR(SUM(c.gmv_fen) / COUNT(*))             AS arpu_cum_fen
FROM assignment a
JOIN conversion c ON c.user_id = a.user_id
GROUP BY a.exp_id, a.group_name
ORDER BY a.exp_id, a.group_name"""

    statement = """## 背景

火山引擎 A/B《如何看懂实验报告》对统计口径的原文是【源 S10】：

> "以进组用户数为例，多天累计的用户数，即是实验期间**累计进组并去重**后的用户数"
> "相比单天累计，多天累计更能保证各组的样本是「**同质可比**」的；
> 相比多天平均，多天累计更易检验出受影响指标的**显著性**"

也就是说官方把**三种**口径摆在了一起：单天累计、多天累计（去重）、多天平均。
这题就是把三者同时算出来，并让"分母换一个、结论就翻"这件事变得可机器判。

（`users_daily_sum / days` 这个"多天平均"、以及 ARPU 的具体算法是本题设定。）

## 表

```
assignment(id INT PK, exp_id VARCHAR(16), group_name VARCHAR(16),
           user_id VARCHAR(16), assigned_date CHAR(10))     -- 'yyyy-MM-dd'
conversion(id INT PK, user_id VARCHAR(16), gmv_fen BIGINT)  -- 金额单位是**分**
```

`assignment` 是**进组流水**：同一用户会被反复记到（每天一条，偶发重复上报），
所以它不是"用户名单"。`conversion` 是全量成交，**包含从未进过任何实验的用户**。

## 任务

只交**一条 SELECT**。按 `(exp_id, group_name)` 输出，列固定为

```
exp_id, group_name, users_cum, users_daily_sum, days, avg_daily_users, gmv_fen, arpu_cum_fen
```

- `users_cum` = **累计去重**进组用户数
- `days` = 该组有进组记录的自然日数
- `users_daily_sum` = **每天各自去重**之后的人次之和
  （= "该组内不同的 `(user_id, assigned_date)` 组合数"。它**不等于**流水行数）
- `avg_daily_users` = `ROUND(users_daily_sum / days, 2)`
- `gmv_fen` = 该组**去重用户**的成交金额之和（单位分）
- `arpu_cum_fen` = `FLOOR(gmv_fen / users_cum)`
按 `exp_id`、`group_name` 升序。**没有进组记录的组不许出现在结果里。**

## 三条口径纪律

- **`gmv_fen` 的分子必须按去重用户聚合，分母也必须是去重用户数。**
  直接 `JOIN conversion` 再 `SUM` 会把 GMV 乘上"该用户的进组流水条数" ——
  u1 在 E1/treat 里有 3 条流水、两笔成交共 32000 分，
  那样算出来是 **96000 分**。**这是本仓库反复强调的那类"静默降级"：
  每一列都"有值"，只有量级是错的。**
- **一个用户同时属于两个实验时，他的 GMV 在两个实验里各算一次。**
  这不是重复计算错误：实验比的是"组内 vs 组内"。
  也正因此 —— **能把各实验 GMV 加回大盘的那个口径，不是实验口径。**
- **从未进组的用户一分都不许进分子。**
  `conversion` 里有一个只成交、从不进组的用户；
  任何"从成交表出发再关联实验"的写法都会把他的钱算进去。

## 陷阱提示

判题数据里包含：跨天重复进组、**同一用户同一天两条流水**、
有进组但无成交的用户、有成交但没进过任何组的用户、清空成交表、清空进组表。
**`SUM` 一个可能为 NULL 的列之前先想清楚 `COALESCE` 放在哪一侧** ——
把它写成 `WHERE c.user_id IS NOT NULL` 会把"整组无成交"这一组**整行删掉**，
于是报表显示"这个组不存在"，而不是"这个组 GMV 为 0"。

只允许一条 `SELECT`。"""

    return base(
        'sql', 'senior',
        '实验进组的三种口径：累计去重、天级去重之和、多天平均，一次算清并暴露 ARPU 漂移',
        statement, 'mysql',
        ['ab-reading-caliber', 'cumulative-dedup', 'fan-out-join', 'denominator-domain',
         'modern:experimentation'],
        src('数据研发（实验平台与指标方向） 高级工程师',
            DATA + '#4 考点 12（实验读数口径：官方"多天累计 + 进组用户累计去重"、'
            '"同质可比"、"多天平均"三种口径的对照）＋ 考点 7（同一指标多口径两两差异）；'
            'ARPU 与 avg_daily_users 的具体公式是【推】，已写成题面契约'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案

关键是**先压平、再聚合**，而且**三路各自算完才拼**：
`g` 算"去重人数 + 去重用户-天数"（`COUNT(DISTINCT user_id)` 与
`COUNT(DISTINCT user_id, assigned_date)`），`dd` 算自然日数，
`m` 单独把 GMV 聚合到**去重用户**粒度上（内层 `SELECT DISTINCT exp_id, group_name, user_id`
是唯一的防扇出屏障）。任何把这三路合并成一次 `JOIN` 的写法都会在某一列上被流水放大。

**基线四行：**

| exp | group | users_cum | users_daily_sum | days | avg | gmv_fen | arpu |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | ctrl | 3 | 3 | 2 | 1.50 | 5000 | 1666 |
| E1 | treat | 3 | 5 | 3 | 1.67 | 52000 | 17333 |
| E2 | ctrl | 1 | 1 | 1 | 1.00 | 100 | 100 |
| E2 | treat | 2 | 2 | 2 | 1.00 | 131000 | 65500 |

E1/treat 的 **6 条流水** ⇒ 3 个去重用户、**5 个用户-天**（u1 在 09-02 有两条流水）。
GMV = u1(30000+2000) + u2(12000) + u3(8000) = 52000 分 ⇒ `FLOOR(52000/3) = 17333`。

- 不去重 `users_cum` ⇒ 会得到 6、`arpu` 变成 8666；
- 不去重 `(user, day)` ⇒ `users_daily_sum` 变成 6、`avg` 变成 2.00；
- 让 GMV 被流水放大 ⇒ `gmv_fen` 变成 96000。
**三个错各自只动一列，而每一列都"看起来是个正常的数"** —— 这就是为什么这题要把六个数同时输出。

**用例「把某用户那天的重复流水与原始流水一起删掉」专门钉 `users_daily_sum` 的语义**：
只删 id 3 时 5 不变（id 12 还在），两条一起删才掉到 4 ⇒ `avg = ROUND(4/3,2) = 1.33`。
写成 `COUNT(*)` 的实现会跟着流水走，两个数都对不上。

**边界用例是"清空进组流水 ⇒ 空集"**，
而 `conversion` 里那个从未进组的用户（7700 分）**在基线里也一分都不出现**。
用例「新增一个从未成交的用户」是另一半：
u99 有进组无成交 ⇒ `users_cum` 从 3 变 4、GMV 仍是 52000 ⇒
`arpu` 从 17333 掉到 13000。**一个子都没多，只是分母大了。**
这就是官方为什么要写"同质可比"，也是为什么看板上必须
**同时**给 `users_cum` 与 `gmv_fen` —— 只给 ARPU 的报表一定会骗人。

**基线的双实验重叠**：四个分组的 `gmv_fen` 相加是
`5000 + 52000 + 100 + 131000 = 188100` 分，
而全部成交流水只有 163800 分。差额要拆成两半看：
其中 **7700 分属于从没进过任何实验的 u9**（他没被算进去，所以是"少加"），
**32000 分属于 u1 —— 他的两笔成交在 E1 与 E2 里各被记了一遍**（多加）。
用例「同一用户被两个实验各吃进去一次」再把 u2 塞进 E2/treat，
此时四组之和变成 `188100 + 12000 = 200100` 分（他的 12000 分同时进了 E1 与 E2 的分子）。
这条算式说明的不是"SQL 写错了"，而是
**实验口径天然不能横向求和成大盘**；想要大盘口径就必须有一个互斥的、
覆盖全量的分流层 —— 也就是官方文档里的"互斥域组保留对照组 / 全局保留对照组"【源 S9】。

**为什么 `naiveSolution` 一定挂**：它 `JOIN conversion` 因而把 GMV 按流水条数放大
（E1/treat 的 u1 有 3 条流水 ⇒ 32000 分被算成 96000 分）、
把 `COUNT(*)` 当去重人数（3 变 6）、并且用内连接**丢掉所有无成交的组**：
在「清空成交表」那条用例下它返回空集，而期望是**四行带 0**。
"整组消失"与"该组数值为 0"在报表上是两件完全不同的事 ——
前者会被读成"实验没跑"，后者会被读成"实验跑了但没带来成交"。

**工程延伸（面试追问点）**

1. 为什么"多天累计"更能保证显著？（累计使样本量随天数单调增长，检验灵敏度提高【源 S10】。
   但这**不等于可以天天看着显著就停**：多次窥视会抬高假阳性率（素材 §2 追问 13，标【推】）。
   正解是预注册时长 + 停线只对护栏指标。）
2. `assigned_date` 为什么用 CHAR(10) 而不是 DATE？（题面刻意如此：避免时区与"日归属"歧义。
   真实系统里"进组时间属于哪一天"必须由**平台统一口径**决定并写进指标定义，
   否则跨时区业务的 `days` 就不可比 —— 素材考点 7 那句"时间锚点"就是这一条。）
3. `COUNT(DISTINCT a, b)` 能移植吗？（MySQL 特有。换到 Spark/PG 要写
   `COUNT(DISTINCT CONCAT(...))` 或两级 `GROUP BY`。
   题面要求"先按 (用户,天) 去过重再计数"说的就是这个**形状**，
   而不是某个函数名 —— 判题只认结果，但人读你的 SQL 时要能看出你懂这一步在防什么。）""",
    )


# =================================================================== M3 分流均衡性检测
@draft('sql-bd-srm-check')
def q_srm_check():
    # 进组流水用生成器造：判 SRM 的样本门槛是 200，
    # 手搓 250 行字面量既读不动、也一定会和期望值漂移。
    rows = []
    nid = [1]
    extra_ids = {}

    def add(exp, layer, users, treat_names):
        for u in users:
            grp = 'treat' if u in treat_names else 'ctrl'
            rows.append([nid[0], exp, layer, grp, u])
            nid[0] += 1

    A = ['a%03d' % i for i in range(250)]
    add('EXP_A', 'L1', A, set(A[:150]))                       # 150/100 ⇒ 6000 vs 5000 ⇒ SRM
    B = ['b%03d' % i for i in range(240)]
    add('EXP_B', 'L1', B, set(B[:120]))                       # 5000 vs 5000 ⇒ OK
    C = ['c%03d' % i for i in range(220)]
    add('EXP_C', 'L2', C, set(C[:110]))
    conflict = []
    for u in ('c000', 'c001', 'c002'):                        # 三个用户被记进两个组 ⇒ 互斥违例
        rows.append([nid[0], 'EXP_C', 'L2', 'ctrl', u])
        conflict.append(nid[0])
        nid[0] += 1
    extra_ids['conflict'] = conflict
    D = ['d%03d' % i for i in range(210)]
    add('EXP_D', 'L3', D, set(D[:105]))                       # 字典里没有 EXP_D
    E = ['e%03d' % i for i in range(50)]
    add('EXP_E', 'L2', E, set(E[:40]))                        # 只有 50 人 ⇒ LOW-SAMPLE（优先于 SRM）
    F = ['f%03d' % i for i in range(200)]
    add('EXP_F', 'L3', F, set(F[:160]))                       # 恰好 200 人 ⇒ 有资格被判
    extra_ids['f_last'] = nid[0] - 1                          # 最后一条 EXP_F 流水

    ASSIGN = rows
    DICT = [['EXP_A', 5000], ['EXP_B', 5000], ['EXP_C', 5000], ['EXP_E', 5000], ['EXP_F', 5000]]
    SCHEMA = {
        'assignment': table_spec(
            'id', ['id', 'exp_id', 'layer_id', 'group_name', 'user_id'],
            ['id INT NOT NULL PRIMARY KEY', 'exp_id VARCHAR(16) NOT NULL',
             'layer_id VARCHAR(16) NOT NULL', 'group_name VARCHAR(16) NOT NULL',
             'user_id VARCHAR(16) NOT NULL']),
        'exp_dict': table_spec(
            'exp_id', ['exp_id', 'expected_treat_bps'],
            ['exp_id VARCHAR(16) NOT NULL PRIMARY KEY', 'expected_treat_bps INT NOT NULL']),
    }
    SEED = {'assignment': ASSIGN, 'exp_dict': DICT}

    def evaluate(rows):
        import collections
        users = collections.defaultdict(set)
        treats = collections.defaultdict(set)
        pair = collections.defaultdict(set)
        for _id, exp, _layer, grp, uid in rows['assignment']:
            users[exp].add(uid)
            pair[(exp, uid)].add(grp)
            if grp == 'treat':
                treats[exp].add(uid)
        multi = collections.defaultdict(int)
        for (exp, _uid), grps in pair.items():
            if len(grps) > 1:
                multi[exp] += 1
        expected = {r[0]: r[1] for r in rows['exp_dict']}
        out = []
        for exp in sorted(users):
            total = len(users[exp])
            treat = len(treats[exp])
            actual = bps(treat, total)
            exp_bps = expected.get(exp, 0)
            overlap = multi.get(exp, 0)
            if total < 200:
                flag = 'LOW-SAMPLE'
            elif overlap > 0:
                flag = 'MUTEX-VIOLATION'
            elif exp_bps <= 0:
                flag = 'NO-EXPECTED-RATIO'
            elif abs(actual - exp_bps) * 10000 >= 1000 * exp_bps:
                flag = 'SRM_RISK'
            else:
                flag = 'OK'
            out.append([exp, total, treat, actual, exp_bps, abs(actual - exp_bps),
                        overlap, flag])
        return out

    COLS = ['exp_id', 'exp_users', 'treat_users', 'actual_treat_bps', 'expected_treat_bps',
            'deviation_bps', 'multi_group_users', 'flag']

    cases = [
        mut_case('基线：五种 flag 各命中一次（样本不足优先于一切）',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='EXP_A 6000 vs 5000 ⇒ SRM_RISK；EXP_B 干净 ⇒ OK；'
                      'EXP_C 有 3 人被记进两个组 ⇒ MUTEX-VIOLATION；'
                      'EXP_D 不在字典里 ⇒ NO-EXPECTED-RATIO；EXP_E 只有 50 人 ⇒ LOW-SAMPLE；'
                      'EXP_F 恰好 200 人、8000 vs 5000 ⇒ SRM_RISK'),
        mut_case('边界：样本数恰好 200 才有资格被判，掉到 199 就只许说"样本不足"',
                 SCHEMA, SEED,
                 [('del', 'assignment', extra_ids['f_last'])], COLS, evaluate,
                 note='EXP_F 从 200 人变 199 人 ⇒ flag 从 SRM_RISK 退回 LOW-SAMPLE，'
                      '而 actual_treat_bps 仍然高得吓人 —— 数字没变，判断变了'),
        mut_case('先把预设比例核对清楚：字典改成 6000 之后 EXP_A 立刻从 SRM 变成 OK',
                 SCHEMA, SEED,
                 [('set', 'exp_dict', 'EXP_A', {'expected_treat_bps': 6000})],
                 COLS, evaluate,
                 note='"比例失衡"有三个成因：分流坏了、预设比例记错了、分母域不同。'
                      '排掉第二个只要一条 UPDATE，排第一个要一周'),
        mut_case('消除互斥违例（把三条重复进组记录删掉）⇒ EXP_C 才轮到看比例',
                 SCHEMA, SEED,
                 [('del', 'assignment', i) for i in extra_ids['conflict']],
                 COLS, evaluate),
        mut_case('边界：字典里有这个实验、但一条进组流水都没有 ⇒ 它不许出现在结果里',
                 SCHEMA, SEED,
                 [('ins', 'exp_dict', ['EXP_Z', 5000])],
                 COLS, evaluate,
                 note='以流水为主表 ⇒ 结果仍是六行、EXP_Z 不出现。'
                      '反过来（以字典为主表）会造出一行除零或 NULL 比例，'
                      '把"还没开跑"显示成"检测失败"'),
        mut_case('边界：预设比例是 6% 时，偏离达到预设的 9 倍 ⇒ 仍然要判 SRM',
                 SCHEMA, SEED,
                 [('set', 'exp_dict', 'EXP_F', {'expected_treat_bps': 8000}),
                  ('set', 'exp_dict', 'EXP_A', {'expected_treat_bps': 600})],
                 COLS, evaluate,
                 note='EXP_A 实际 6000、预设 600 ⇒ 偏离 5400 万分比，'
                      '相对判据 5400*10000 >= 1000*600 ⇒ SRM_RISK；'
                      '同一份数据里 EXP_D 偏 5000、EXP_E 偏 3000 也都越过 naive 的绝对阈值 > 100，'
                      '它们的真相却是"字典没配"与"样本不够"'),
        mut_case('退化：一条进组记录都没有 ⇒ 空集',
                 SCHEMA, SEED, [('clr', 'assignment')], COLS, evaluate),
    ]

    reference = """SELECT d.exp_id                                                  AS exp_id,
       d.exp_users                                                 AS exp_users,
       d.treat_users                                               AS treat_users,
       FLOOR(d.treat_users * 10000 / d.exp_users)                  AS actual_treat_bps,
       COALESCE(x.expected_treat_bps, 0)                           AS expected_treat_bps,
       ABS(FLOOR(d.treat_users * 10000 / d.exp_users)
           - COALESCE(x.expected_treat_bps, 0))                    AS deviation_bps,
       d.multi_group_users                                         AS multi_group_users,
       CASE
         WHEN d.exp_users < 200 THEN 'LOW-SAMPLE'
         WHEN d.multi_group_users > 0 THEN 'MUTEX-VIOLATION'
         WHEN COALESCE(x.expected_treat_bps, 0) <= 0 THEN 'NO-EXPECTED-RATIO'
         WHEN ABS(FLOOR(d.treat_users * 10000 / d.exp_users) - x.expected_treat_bps) * 10000
              >= 1000 * x.expected_treat_bps THEN 'SRM_RISK'
         ELSE 'OK'
       END                                                         AS flag
FROM (SELECT a.exp_id                                          AS exp_id,
             COUNT(DISTINCT a.user_id)                         AS exp_users,
             COUNT(DISTINCT CASE WHEN a.group_name = 'treat' THEN a.user_id END) AS treat_users,
             (SELECT COUNT(*)
                FROM (SELECT a2.user_id
                        FROM assignment a2
                       WHERE a2.exp_id = a.exp_id
                       GROUP BY a2.user_id
                      HAVING COUNT(DISTINCT a2.group_name) > 1) z) AS multi_group_users
      FROM assignment a
      GROUP BY a.exp_id) d
LEFT JOIN exp_dict x ON x.exp_id = d.exp_id
ORDER BY d.exp_id"""

    naive = """SELECT a.exp_id                                       AS exp_id,
       COUNT(*)                                         AS exp_users,
       SUM(CASE WHEN a.group_name = 'treat' THEN 1 ELSE 0 END) AS treat_users,
       FLOOR(SUM(CASE WHEN a.group_name = 'treat' THEN 1 ELSE 0 END) * 10000 / COUNT(*))
                                                        AS actual_treat_bps,
       x.expected_treat_bps                             AS expected_treat_bps,
       ABS(FLOOR(SUM(CASE WHEN a.group_name = 'treat' THEN 1 ELSE 0 END) * 10000 / COUNT(*))
           - x.expected_treat_bps)                      AS deviation_bps,
       0                                                AS multi_group_users,
       CASE WHEN ABS(FLOOR(SUM(CASE WHEN a.group_name = 'treat' THEN 1 ELSE 0 END) * 10000 / COUNT(*))
                     - x.expected_treat_bps) > 100
            THEN 'SRM_RISK' ELSE 'OK' END               AS flag
FROM assignment a
JOIN exp_dict x ON x.exp_id = a.exp_id
GROUP BY a.exp_id, x.expected_treat_bps
ORDER BY a.exp_id"""

    statement = """## 背景

素材 §4 考点 10/11 的底座是官方《规划实验流量》那一页【源 S9】：
"**通过两次运算「哈希函数」使不同互斥域的流量之间呈正交关系**"、
"**客户端实验只可添加客户端互斥域，服务端实验只可添加服务端互斥域**"、
"如果一个互斥域中已有运行中实验，则其他运行中实验不能再加入该互斥域"。

而"进组比例偏离预设多少就该判废"（行业里叫 SRM，sample ratio mismatch）
**在 DataTester 的公开文档里找不到**（素材 §7 第 4 条）。
所以本题把阈值与判据写成**本题设定的契约**：
答题时请顺带说明**你会把线画在哪、以及为什么是那里**。

## 表

```
assignment(id INT PK, exp_id VARCHAR(16), layer_id VARCHAR(16),
           group_name VARCHAR(16), user_id VARCHAR(16))     -- 进组流水
exp_dict(exp_id VARCHAR(16) PK, expected_treat_bps INT)      -- 预设实验组比例（万分比）
```

## 任务

只交**一条 SELECT**。按 `exp_id` 输出，列固定为

```
exp_id, exp_users, treat_users, actual_treat_bps, expected_treat_bps,
deviation_bps, multi_group_users, flag
```

- `exp_users` = 该实验**去重**用户数；`treat_users` = 其中 `group_name = 'treat'` 的去重用户数
- `actual_treat_bps` = `FLOOR(treat_users * 10000 / exp_users)`
- `expected_treat_bps` = 字典里的预设比例；**字典缺这个实验时输出 `0`**
- `deviation_bps` = `ABS(actual_treat_bps - expected_treat_bps)`
- `multi_group_users` = 该实验中**被记进两个及以上不同组**的去重用户数（互斥违例的人数）
- `flag` 按优先级从上到下：

| # | 条件 | flag |
| --- | --- | --- |
| 1 | `exp_users < 200` | `LOW-SAMPLE` |
| 2 | `multi_group_users > 0` | `MUTEX-VIOLATION` |
| 3 | 字典里查不到该实验（`expected_treat_bps` 为 0） | `NO-EXPECTED-RATIO` |
| 4 | `deviation_bps * 10000 >= 1000 * expected_treat_bps`（相对偏离 ≥ 10%） | `SRM_RISK` |
| 5 | 其余 | `OK` |

按 `exp_id` 升序。

## 三条判据为什么长这样

- **`LOW-SAMPLE` 必须排在 `SRM_RISK` 之前。**
  50 个人的实验里 40/10 分组的偏离是 3000 万分比 —— 看着和 250 人时的同偏离一模一样，
  但它只是几次抛硬币。**在小样本上判 SRM 会把随机波动读成系统性故障**，
  然后派一组人去查一个没坏的分流服务。素材考点 13 那句
  "低基线指标不适合做主指标"是同一个道理的另一种表述。
- **偏离是相对预设值算的，不是与 5000 比。**
  判据写成 `deviation * 10000 >= 1000 * expected` 就是为了这个：
  预设 600 万分比（6%）的实验实际到 6000，绝对差 5400、相对偏离 900% —— 是事故；
  预设 5000 的实际到 5100，绝对差 100，相对只有 2% —— 不是。
  **绝对阈值给不出这个区分**：同样是 100 万分比的绝对偏离，
  在预设 600 的实验上是 16.7% 的相对偏离（判据越线），
  在预设 5000 的实验上只有 2%（不越线）—— 一个阈值要同时管住两种量级。
- **`multi_group_users` 与 SRM 是两类问题，必须分开报。**
  比例失衡可能是哈希不均（要查分流服务）；
  同一用户进两个组则是**互斥关系被破坏**【源 S9】，
  后果更狠：两组不再是互斥总体，任何检验的前提都不成立。
  把它当成 SRM 的一种去查哈希，会漏掉真正要修的那段代码。

## 陷阱提示

- `treat_users` 要 `COUNT(DISTINCT CASE WHEN group_name = 'treat' THEN user_id END)`，
  写成 `SUM(CASE WHEN ...)` 会被流水条数放大（判题数据里有重复进组流水）。
- `exp_dict` 可能缺行 ⇒ 必须 `LEFT JOIN`，且**不许用 `COALESCE(expected, 5000)` 兜一个默认比例**
  —— 那是拿猜出来的分母去判一个真实存在的实验。
- 字典里出现的实验，`assignment` 里可能一行都没有（新建未开跑）⇒ 它**不该出现在结果里**
  （以进组流水为主表）。

只允许一条 `SELECT`。"""

    return base(
        'sql', 'senior',
        '分流均衡性检测：样本门槛优先、互斥违例与比例失衡分开报、偏离按相对值判',
        statement, 'mysql',
        ['srm-check', 'mutual-exclusion-domain', 'relative-deviation', 'left-join-dict',
         'modern:experimentation'],
        src('数据研发（实验平台方向） 高级工程师',
            DATA + '#4 考点 10/11/12/13（A/B 流量模型与父子实验：'
            '考点 11 建议 mysql 版"两张进组表做交叉污染检测——同一用户在不同层命中组合的分布"；'
            '考点 12 建议"实现进组比例偏离预设 > x% 即标记 SRM 风险"。'
            'SRM 本身素材 §7 第 4 条声明未找到官方能力描述 ⇒ 阈值写成【推】= 题面契约）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer="""## 参考答案

内层子查询按 `exp_id` 聚合去重人数；`multi_group_users` 用一条**相关子查询**
（按用户 `GROUP BY` + `HAVING COUNT(DISTINCT group_name) > 1`）数出违例人数；
外层再 `LEFT JOIN exp_dict` 打 flag。

**基线六行：**

| exp | users | treat | actual | expected | dev | multi | flag |
| --- | --- | --- | --- | --- | --- | --- | --- |
| EXP_A | 250 | 150 | 6000 | 5000 | 1000 | 0 | SRM_RISK |
| EXP_B | 240 | 120 | 5000 | 5000 | 0 | 0 | OK |
| EXP_C | 220 | 110 | 5000 | 5000 | 0 | 3 | MUTEX-VIOLATION |
| EXP_D | 210 | 105 | 5000 | 0 | 5000 | 0 | NO-EXPECTED-RATIO |
| EXP_E | 50 | 40 | 8000 | 5000 | 3000 | 0 | LOW-SAMPLE |
| EXP_F | 200 | 160 | 8000 | 5000 | 3000 | 0 | SRM_RISK |

EXP_A 的偏离正好是 1000 万分比 ⇒ 判据 `deviation * 10000 >= 1000 * expected`
即 `1000*10000 >= 1000*5000` 成立 ⇒ `SRM_RISK`。**这里必须写 `>=`**：
写成 `>` 会让"恰好偏 10%"这一类整片漏网，而现实里的哈希不均常常就卡在那附近。

**EXP_E 与 EXP_F 是这题的核心对照：两者的 `actual_treat_bps` 都是 8000、
`deviation_bps` 都是 3000，唯一差别是 50 人 vs 200 人。**
一个 `LOW-SAMPLE`、一个 `SRM_RISK`。
把 `exp_users < 200` 这条删掉，EXP_E 会立刻冒出一条看起来同样严重的告警 ——
而它只是 50 次抛硬币里出了 40 次正面（二项分布下这并不罕见）。
**"数字一样大就一样严重"是治理指标最常见的设计错误。**

用例「边界：样本数恰好 200 才有资格被判」删掉 EXP_F 的一条流水 ⇒
去重人数从 200 掉到 199、`treat_users` 仍是 160 ⇒ `actual` 反而**升到 8040**，
但 flag 退回 `LOW-SAMPLE`。**数字更极端了，判断却更保守了** ——
这才是优先级该有的样子。（`treat_users` 不变是因为被删掉的那条是 ctrl 流水。）

**EXP_D 的 `expected_treat_bps` 是 0、`deviation_bps` 是 5000。**
它既不是"OK"也不是"SRM_RISK"，而是单独一档 `NO-EXPECTED-RATIO`。
如果实现用 `COALESCE(x.expected, 5000)` 兜底，这一行会变成 `OK`（实际恰好 5000）——
**那就是用一个猜出来的分母，给一个真实的实验签了"没问题"。**
反过来如果直接 `deviation > 阈值` 而不拦 0，它会变成 `SRM_RISK` —— 同样是假告警。

**用例「边界：预设比例是 6% 时，偏离达到预设的 9 倍 ⇒ 仍然要判 SRM」把 EXP_A 的字典改成 600 万分比**：
`deviation = |6000 - 600| = 5400`，偏离是预设值的 9 倍（900%）⇒ `SRM_RISK` 仍然成立。
而 naive 那条绝对阈值 `> 100` 在**同一份数据**里还会把 EXP_D（偏 5000）与 EXP_E（偏 3000）
一起报成 SRM —— 那两行的真相是"字典没配"和"样本不够"，不是分流坏了。
**展示用绝对值（读者看得懂）、判定用相对值（不会被预设比例绑架），两件事都要有。**

**工程延伸（面试追问点）**

1. 200 这个门槛怎么定？（它不是统计意义上的最小样本量，而是"最小可判 SRM 的样本量"。
   正解是给一个二项检验：`P(偏离 ≥ 观测值 | 预设比例) < 0.001` 才报警 ——
   阈值小是故意的，SRM 报警处理的是**系统性**故障，不是尾部抖动。）
2. 为什么没用到 `layer_id`？（本题按 `exp_id` 出结论。`layer_id` 属于另一问：
   "同层多实验抢占同一批人"，判据是**两个实验的用户集合交集不为空**，
   需要自连接，是另一条查询 —— 素材题面草稿 A 第 3 条后半句。
   **别把"同层抢占"和"同实验内进两组"混成一档**：前者是流量规划问题，
   后者是分流实现 bug。）
3. 客户端/服务端实验怎么在同一张表里区分？（加 `unit` 列（device/user）并纳入 `exp_dict`；
   官方约束是"客户端实验只可添加客户端互斥域"【源 S9】，
   所以真正的检测是"同一个互斥域里出现两种 unit" —— 那是字典层的检查，不是数据层的。）""",
    )


# =================================================================== R1 拉流租约与配额
@draft('sql-bd-live-pull-lease-redis')
def q_live_pull_lease():
    setup = [
        'DEL live:d1:lease',
        'DEL live:d1:blocked',
        'HSET live:d1:quota total 4 reject 0',
        'ZADD live:d1:lease 8200 c-001',
        'ZADD live:d1:lease 6100 c-002',
        'ZADD live:d1:lease 10500 c-003',
    ]
    reference = """# 观测时刻 now = 10000，租约保留窗口 3600 ⇒ 回收边界是 6400
# E1 回收失效租约（必须在任何"数人数"的动作之前）
ZREMRANGEBYSCORE live:d1:lease -inf 6400
# E2 新客户端 c-100 拿到租约，到期 10300
ZADD live:d1:lease 10300 c-100
# E3 同一个客户端重放续期请求，但它算出的到期时间是 19999
#    ⇒ 必须 NX：不带上就会把租约无限期拉长，配额被一个重放包永久占住
ZADD live:d1:lease NX 19999 c-100
# E4 老客户端 c-001 正常续约到 10400 ⇒ 用 XX，不许给已被回收的客户端"复活"
ZADD live:d1:lease XX 10400 c-001
# E5 再来一个 c-101（到期 10600）⇒ 到这一步正好 4 个成员，触及路数上限
ZADD live:d1:lease 10600 c-101
# E6 c-999 鉴权失败 ⇒ 一条写入命令都不许发（上限已满 + 鉴权未过）
# E7 给配额服务记一次"超限拒绝"
HINCRBY live:d1:quota reject 1
# E8 主播被禁播：只下落准入标记，绝不删租约
SET live:d1:blocked 1"""

    naive = """# "计数器一把梭"版：路数靠 HSET 自己写、租约表整个删掉、禁用标记顺手清零计数。
HSET live:d1:quota total 4 reject 0
DEL live:d1:lease
SET live:d1:blocked 1"""

    statement = """## 背景

火山引擎《视频直播 · 功能特性》把"配额"和"流控"写成了产品能力【源 S18】：

- **限额管理**："支持管理**推流路数限额**和**拉流带宽限额**，支持配置限额告警阈值"；
- **流管理**："支持查询在线流、禁推流、历史流和流状态。支持对直播流执行**禁播、复播和断开**操作"；
- 安全侧："推拉流 URL 鉴权（自定义鉴权 Key）""IP 黑白名单""Referer 防盗链"。

**路数限额**是一个独立对象（与带宽限额并列），而"禁播"是一个**准入动作**
—— 这三句话合起来就决定了这题的数据结构。

## 环境

Redis 7.2.7。**禁止** `EVAL` / `EVALSHA` / `SCRIPT` / `FCALL` / `KEYS` / `FLUSHDB` /
`CONFIG` / `DEBUG` / `SORT` / `OBJECT` / `SELECT`（判题器直接拒）。
所以"用 Lua 做 if-else"不在解空间内 —— 一切条件都要靠命令自己（`NX` / `XX`）或数据形状表达。

## 判题方式（先读这段）

判题**不模拟并发、也不让时间流逝**。它做三件事：
1. 按下面的"初始状态"把 Redis 摆好；
2. 按顺序执行你提交的**这一份命令脚本**（每行一条，`#` 开头是注释）；
3. 逐条执行校验命令并比对最终状态。

本场景的**观测时刻 `now = 10000`，租约保留窗口 = 3600**（单位都是秒级逻辑时钟，
题面内自洽即可，不是真实时间戳）。

## 初始状态

```
HSET live:d1:quota total 4 reject 0                 -- 该域名最多 4 路并发拉流
ZADD live:d1:lease 8200 c-001  /  6100 c-002  /  10500 c-003
live:d1:blocked 不存在
```

`live:d1:lease` 的 **score = 该客户端租约的到期时刻**，member = 客户端 ID。

## 同一批到达的 8 个事件（必须全部处理）

| 事件 | 情况 | 必须 | 绝对不许 |
| --- | --- | --- | --- |
| E1 | 有租约已在 `now - 3600` 之前到期 | 把它们从集合里回收 | 留着占配额 |
| E2 | 新客户端 `c-100` 申请租约，到期 10300 | 写入 | 覆盖已有成员 |
| E3 | **同一个续期请求重放**，但客户端算出的到期时间是 19999 | 变成 no-op | 把 `c-100` 的到期改写成 9999 |
| E4 | 在线客户端 `c-001` 正常续约到 10400 | 更新它的到期 | 给一个**已不在集合里**的客户端凭空建租约 |
| E5 | 新客户端 `c-101` 到期 10600 ⇒ 正好到上限 4 路 | 写入 | 越过上限 |
| E6 | `c-999` 的 URL 鉴权没过，而且配额已满 | **什么都不发** | 出现第 5 个成员 |
| E7 | 给这次超限/鉴权失败记一笔 | `reject` 字段加 1 | 把 `total` 改掉 |
| E8 | 主播被禁播 | 落下准入标记 | 顺手把租约集合删掉 |

要求最终状态：`live:d1:lease` 恰好是
`c-001`(10400) / `c-003`(10500) / `c-100`(**10300**) / `c-101`(10600) 四个成员；
`live:d1:quota` 的 `total` 仍是 `4`、`reject` 是 `1`；`live:d1:blocked` 为 `1`；
`c-002`（已过期）与 `c-999`（被拒）都不存在。

## 这题真正考的东西

1. **E3 是本体的那条**：`ZADD key 19999 c-100`（不带 NX）对已存在成员是**改分数**。
   症状不是"人数不对"，而是**这个成员的租约永远不再到期** ——
   它永久占着一路配额，而 `ZCARD` 看起来完全正常。
   重放包永远存在（客户端重试、网关重试、CDN 边缘重试），
   所以"到期时间"这种**可被重放改写的字段**必须用 `NX` 落成"先到先得、后来无效"。
2. **E4 必须用 `XX` 而不是无条件写**：
   客户端掉线后租约已被回收，此时一个**迟到的续约包**如果无条件 `ZADD`，
   会给一个已经不存在的会话重建租约 —— 这叫"僵尸租约"，
   它是配额只涨不跌的经典成因。
3. **禁播不许删租约**（E8）：`DEL live:d1:lease` 同时毁掉三样东西 ——
   正在观看的会话状态、"这一场有多少人"的历史真相、以及"禁播之后是否真的停止增长"的举证链。
   官方把"禁播 / 复播 / 断开"列成三个**不同**动作【源 S18】，
   正说明"阻止新的"与"切断已有的"是两件事。
4. **`reject` 要 `HINCRBY` 而不是 `SET`**：配额服务是多实例共享的，
   `SET reject <自己看到的数>` 会把别的实例记的数覆盖掉（**丢更新方向是单向的：只少不多**）。

只交一段命令脚本，不需要写代码。"""

    return base(
        'sql', 'senior',
        '拉流路数配额的 Redis 落地：租约到期时间不许被重放改写，禁播不许删会话',
        statement, 'redis',
        ['live-streaming', 'lease-quota', 'idempotent-replay', 'data-shape-solves-it',
         'no-lua-constraint', 'modern:media-delivery'],
        src('服务端研发（直播与内容分发方向） 高级工程师',
            INFRA + '#4 考点 10（直播链路的分发、配额与降级标准件：'
            '"限额管理：推流路数限额与拉流带宽限额、可配告警阈值"、'
            '"流管理：禁推/禁播/复播/断开"、URL 鉴权；素材建议 judgeKind=redis'
            '"拉流带宽配额 + 鉴权 token 计数与超限拒绝"。'
            'NX/XX 与僵尸租约的推导是【推】，题面已写成契约）'),
        language='sql',
        cases=[
            {'name': '重放不许延长租约：c-100 的到期仍是首次的 10300',
             'input': ['ZSCORE live:d1:lease c-100'], 'expected': '10300',
             'note': '不带 NX 的 ZADD 会把它改成 19999 ⇒ 这一路永久不再到期，'
                     '而 ZCARD 看起来完全正常'},
            {'name': '在线客户端续约成功：c-001 的到期是 10400',
             'input': ['ZSCORE live:d1:lease c-001'], 'expected': '10400'},
            {'name': '并发路数恰好等于配额上限 4',
             'input': ['ZCARD live:d1:lease'], 'expected': 4},
            {'name': '边界：不许多出任何一路（到期时间晚于 10600 的成员数是 0）',
             'input': ['ZCOUNT live:d1:lease 10601 +inf'], 'expected': 0,
             'note': '把 9999 那次重放当成新会话就会在这里露馅'},
            {'name': '已过期的 c-002 必须真被回收（否则它永久占着 1/4 的配额）',
             'input': ['ZSCORE live:d1:lease c-002'], 'expected': None},
            {'name': '鉴权失败的 c-999 绝不许存在',
             'input': ['ZSCORE live:d1:lease c-999'], 'expected': None},
            {'name': '禁播只落下准入标记，不许回收已有会话',
             'input': ['EXISTS live:d1:lease'], 'expected': 1,
             'note': 'DEL 掉租约集合 = 一刀切断所有在线观众，'
                     '同时毁掉"这场一共多少人看过"的历史'},
            {'name': '禁播标记要落下', 'input': ['GET live:d1:blocked'], 'expected': '1'},
            {'name': '超限拒绝要计数', 'input': ['HGET live:d1:quota reject'],
             'expected': '1'},
            {'name': '配额上限不许被这个脚本改掉',
             'input': ['HGET live:d1:quota total'], 'expected': '4',
             'note': '改限额是运营动作，不在本场景里 ⇒ 动了就是越权'},
        ],
        runner={'setup': setup, 'entry': 'function', 'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer="""## 参考答案

```
ZREMRANGEBYSCORE live:d1:lease -inf 6400
ZADD live:d1:lease 10300 c-100
ZADD live:d1:lease NX 19999 c-100     # 重放 ⇒ no-op，到期保持 10300
ZADD live:d1:lease XX 10400 c-001
ZADD live:d1:lease 10600 c-101
# E6 鉴权失败且配额已满：一个命令都不发
HINCRBY live:d1:quota reject 1
SET live:d1:blocked 1
```

**E1 的回收边界是 6400，不是 10000。**
`now - 保留窗口 = 10000 - 3600 = 6400`：只有到期时刻**不晚于 6400** 的租约才算"早已失效"。
`c-002` 的 6100 被回收，而 `c-001` 的 8200 与 `c-003` 的 10500 **必须留下**
（回收只认 `now - 3600 = 6400` 这条线，不认 `now`；8200 是「还在播、但已经不到一小时」的那类会话）。
把回收写成 `ZREMRANGEBYSCORE live:d1:lease -inf 10000` 的实现会连带删掉 8200 那条**仍然活着**的租约，
而后面那句 `ZADD ... XX 10400 c-001` 因为成员已经没了而**空转**（`XX` 不许复活被回收的会话），
于是 `ZCARD` 从 4 变成 3、`ZSCORE live:d1:lease c-001` 变 nil —— **两条校验同时红**。
（它的线上症状是「配额没打满」被误读成「观众掉了」。）

**为什么三条初值要同时跨在两条线两侧**（6100 在回收边界之下、8200 落在 6400 与 10000 之间、10500 在 `now` 之上）：
第一版把它们写成了 800 / 1200 / 1500 —— 全部远小于 `now = 10000`，
意思是"三条租约早就全过期了"。那既是单位混乱（"到期时刻"比"当前时刻"小 8000 秒），
更要命的是：**它让"把边界写成 now"这个错法变得不可判** ——
初值全在边界之下时，回收 6400 与回收 10000 的输出完全一样，矩阵照样全绿。
这条是容器矩阵打回来的（`c-001` 的续约返回 null、`ZCARD` 只有 2）。
第二版把它们挪成 10200/10500 —— 确实跨过了 6400，但**全部落在 `now` 之上**，
于是 `-inf 6400` 与 `-inf 10000` 两种写法结果一模一样（探针量出来都是 4），这个错法**照样不可判**。
**要证伪一个错法，初值必须落在「那条错法自己的判定区间」里**，不是「比上一版大」就行。
**"数据形状能不能证伪一个错法"是用例设计的一部分，不是判题器的事。**

**为什么 `c-100` 的到期必须是 10300**：
`ZADD` 不带 `NX` 时对已存在成员是更新分数。
重放事件带的是一个**更晚**的到期时间 ⇒ 不但不报错，还把这一路变成"永不到期"。
症状是配额缓慢地、单调地被僵尸占满，而每一次 `ZCARD` 都不超限 ——
典型的"聚合数全对、只有状态错了"。

**`XX` 与 `NX` 是同一个数据结构上的两半**：
`NX` 保护"首次写入不被后来的改写"（E3），
`XX` 保护"迟到的续约不给已回收的会话重建租约"（E4）。
两者都用错成无条件 `ZADD` 时，本题基线状态恰好看不出来（`c-001` 还在），
但把 E1 的回收顺序挪到 E4 之后就会立刻显形 —— **这才是"顺序敏感"的真实含义。**

**禁播不许删集合**：官方把"禁播 / 复播 / 断开"列成三个不同动作【源 S18】。
禁播是**停止新的准入**，断开才是**切断已有会话**。
把它们实现成同一个 `DEL`，后果是"运营想停一个新主播的流，结果踢掉了全部观众"，
而且事后无法回答"这场看过多少人"。

**工程延伸（面试追问点）**

1. 配额服务不可用时该放行还是限？（素材把这条列为本题的追问点。**两边都有代价**：
   放行 = 可能超卖带宽；限 = 大面积看不了。可辩护的答案是
   "降级到**本地保守上限**（实例数 × 每实例配额）并打点降级率" ——
   关键是**必须让这个选择可观测**，否则线上表现为"有时能看有时不能"，永远查不出来。
   注意这与本仓库反复强调的"降级要留两套曲线"是同一件事。）
2. score 用逻辑时钟而不是真实时间戳？（判题要可复现。真实系统里
   多实例的本地时钟会漂，所以到期判定要用**同一个 Redis 的 TIME** 或
   直接给 key 加 TTL —— 但 `EXPIRE` 只能整键过期，不能按成员过期，
   这正是"用 ZSET 建模租约"的原因。）
3. 带宽限额怎么落？（路数是整数、带宽是连续量。同一个 ZSET 模型换 score 语义即可：
   score = 该会话的码率上限，`ZSUM` 用 `ZRANGE ... WITHSCORES` + 客户端累加，
   但那不是原子操作 —— 真实做法是把带宽按"档"离散化成路数，
   **把连续配额变成整数配额**，才有可判的不变量。）
4. 为什么不用 `EXPIRE` 做租约？（Redis 的 key 过期是**整键**的，
   而这里要的是"每个成员各自到期"。这是 ZSET-as-lease 这个模式的根因，
   也是限流类题反复用 ZSET 的理由。）""",
    )


# =================================================================== R2 消息幂等窗口与死信计数
@draft('sql-bd-message-idempotency-redis')
def q_message_idempotency():
    setup = [
        'DEL mq:g1:idem',
        'DEL mq:g1:paused',
        'ZADD mq:g1:idem 5000 m-001',       # 一条早已超出保留期的 msgId：E1 必须清掉它
        'HSET mq:g1:retry m-200 2',
        'ZADD mq:g1:slow 7000 clientA',
        'ZADD mq:g1:slow 6100 clientB',
        'SET mq:g1:dlq 0',
    ]
    reference = """# 观测时刻 now = 10000，幂等窗口 3600 ⇒ 窗口左边界 6400
# E1 把窗口外的 msgId 清掉（必须最先做，否则窗口只增不减）
ZREMRANGEBYSCORE mq:g1:idem -inf 6400
# E2 首次消费 m-100（到达时刻 8000）：记进幂等窗口
ZADD mq:g1:idem NX 8000 m-100
# E3 同一消息被**重复投递**（广播语义下每条消息会被消费多次），时间戳变成 8100
#    ⇒ 必须 NX：不带上就会把窗口边界往后推，且这条消息被下游处理两遍
ZADD mq:g1:idem NX 8100 m-100
# E4 消费 m-150（到达时刻 9000）⇒ 正常记入
ZADD mq:g1:idem 9000 m-150
# E5 m-200 第三次失败：重试计数从 2 加到 3 ⇒ 达到最大重试次数，落死信
HINCRBY mq:g1:retry m-200 1
INCR mq:g1:dlq
# E6 慢消费者水位：clientA 推进到 9500
ZADD mq:g1:slow XX 9500 clientA
# E7 clientB 落在窗口左边界之外（水位 6100 < 6400）⇒ 暂停它，别让它拖住整组
SET mq:g1:paused:clientB 1"""

    naive = """# "消费就完事"版：不去重、不记重试、发现慢消费者直接把整组水位清空。
DEL mq:g1:idem
DEL mq:g1:slow
HDEL mq:g1:retry m-200
INCR mq:g1:dlq
SET mq:g1:paused:clientA 1"""

    statement = """## 背景

火山引擎《消息队列 RocketMQ 版 · 相关概念》给出了这题全部的可核查地基【源 S19/S15】：

- **集群消费**："同一 Topic 的消息只需被集群内的任意一个消费者处理……每条消息仅被消费一次"；
  **广播消费**："同一 Topic 的消息会被**所有**订阅的消费者都消费一次……**每条消息会被消费多次**"；
- **三类位点**：`MaxOffset`（分区总数）、`MinOffset`（起始）、`ConsumerOffset`（已消费条数）；
- **死信**："达到最大重试次数后消费依然失败"，且"**订阅关系创建时自动创建死信队列**"；
- 延时消息："支持自定义毫秒级延迟，延迟时长最长为 3 天或消息保留时长的 3 倍（两者取较小值）"。

"重复投递如何做幂等、慢消费者如何隔离"素材明确标为【推】，
所以下面的规则是**本题设定的契约**。

## 环境

Redis 7.2.7。**禁止** `EVAL` / `EVALSHA` / `SCRIPT` / `FCALL` / `KEYS` / `FLUSHDB` /
`CONFIG` / `DEBUG` / `SORT` / `OBJECT` / `SELECT`（判题器直接拒）。

## 判题方式

与常规一致：摆好初始状态 ⇒ 顺序执行你提交的脚本 ⇒ 逐条读回校验最终状态。
**不模拟并发、不让时间流逝。** 本场景 `now = 10000`，幂等窗口 3600 ⇒ 窗口左边界 6400。

## 初始状态

```
HSET mq:g1:retry m-200 2                     -- m-200 已重试 2 次，上限是 3
ZADD mq:g1:slow 7000 clientA / 6100 clientB   -- 每个消费者的水位（已提交位点）
SET  mq:g1:dlq 0                              -- 死信条数计数
ZADD mq:g1:idem 5000 m-001                      -- 幂等窗口（member=msgId，score=到达时刻）
                                             -- 里面留一条已经超出保留期的 msgId，E1 必须清掉它
mq:g1:paused:clientB 不存在
```

## 八个事件

| 事件 | 情况 | 必须 | 绝对不许 |
| --- | --- | --- | --- |
| E1 | 窗口里有一条 `m-001`（到达 5000）已超出保留期 | 回收它 | 让它继续占位 |
| E2 | 首次消费 `m-100`（到达 8000） | 记入窗口 | 覆盖已有成员 |
| E3 | **`m-100` 被重复投递**，时间戳是 8100 | 变成 no-op | 把窗口边界推后 |
| E4 | 首次消费 `m-150`（到达 9000） | 记入窗口 | — |
| E5 | `m-200` 第三次失败 ⇒ 达到重试上限 | 计数加到 3，并让死信计数加 1 | 停在 2 |
| E6 | `clientA` 提交新水位 9500 | 更新（它必须还在集合里） | 给它重建水位 |
| E7 | `clientB` 水位 6100，落在窗口左边界之外 ⇒ 判定为慢消费者 | 落下暂停标记 | 动 clientA |
| E8 | — | — | 不许 `DEL` 幂等窗口或水位表 |

要求最终状态：`mq:g1:idem` 恰好两个成员 `m-100`(score **8000**) 与 `m-150`(9000)；
`HGET mq:g1:retry m-200` 为 `3`；`mq:g1:dlq` 为 `1`；
`mq:g1:slow` 仍是两个成员且 `clientA` 水位为 `9500`、`clientB` 为 `6100`；
`mq:g1:paused:clientB` 为 `1`；`clientA` 没有被暂停。

## 这题真正考的东西

1. **幂等窗口必须是"有界的集合"，不是"永久的集合"。**
   没有 E1 的回收，这个 ZSET 会随消息量单调增长 —— 于是"防重复投递"
   这个机制本身变成了一次内存泄漏。**任何去重方案的第一问都是"窗口边界在哪"。**
2. **E3 的 `NX`**：重复投递带的到达时刻比首次**更晚**。
   不带 NX ⇒ `m-100` 的 score 变成 8100 ⇒ 它在窗口里**多留 100 个时间单位**，
   于是"窗口"对每一条消息都不是同一个长度。
   而下游是否重复处理，取决于**这一次消费有没有真正执行**（脚本管不了），
   但至少窗口不能因为重放而漂移。
3. **E6 必须用 `XX`**：水位表是消费者的**存在性证明**。
   用无条件 `ZADD` 会让一个早已掉线、水位被清理过的客户端
   被一个迟到的提交**重建**出来 ⇒ 它重新进入 rebalance，
   而它其实已经不在了。**这和直播题的"僵尸租约"是同一个故障家族。**
4. **慢消费者只能被标记，不能被删除**（E7/E8）：
   `ZREM mq:g1:slow clientB` 看起来"解决了"，实际毁掉了三样东西 ——
   它的续传位点（恢复后要从头重放）、堆积统计的分母、
   以及"这个消费者到底慢在哪"的证据。
   官方把位点定义成 `ConsumerOffset`【源 S19】，正因为**它是事实，不是缓存**。

只交一段命令脚本。"""

    return base(
        'sql', 'senior',
        '消息幂等窗口的 Redis 落地：有界去重、重放走 NX、慢消费者只标记不删除',
        statement, 'redis',
        ['message-idempotency', 'bounded-window', 'dead-letter-count', 'consumer-lag',
         'no-lua-constraint', 'modern:streaming-reliability'],
        src('服务端研发（消息队列与数据链路方向） 高级工程师',
            INFRA + '#4 考点 11（消息投递语义与扇出可观测：素材建议 judgeKind=redis'
            '"按 (msgId, consumerGroup) 做有界窗口幂等 + 死信计数 + 慢消费者水位"；'
            '集群/广播语义、三类位点、死信定义均为【源 S19】，'
            '窗口边界与 XX/NX 的推导按【推】写成题面契约）'),
        language='sql',
        cases=[
            {'name': '重放不许把窗口边界推后：m-100 的 score 仍是首次的 8000',
             'input': ['ZSCORE mq:g1:idem m-100'], 'expected': '8000',
             'note': '不带 NX 会把它改成 8100 ⇒ 窗口长度对每条消息都不一样了'},
            {'name': '窗口里恰好两条：m-100 与 m-150（初值那条 m-001 必须已被回收）',
             'input': ['ZCARD mq:g1:idem'], 'expected': 2},
            {'name': '边界：窗口左边界之外不许留任何成员（score 小于等于 6400 的数量是 0）',
             'input': ['ZCOUNT mq:g1:idem -inf 6400'], 'expected': 0,
             'note': '没有 E1 的回收，这个集合会随消息量单调增长 ⇒ 去重变成内存泄漏'},
            {'name': '达到重试上限的那条要留痕（retry 计数是 3）',
             'input': ['HGET mq:g1:retry m-200'], 'expected': '3'},
            {'name': '死信计数加一', 'input': ['GET mq:g1:dlq'], 'expected': '1'},
            {'name': '正常消费者的水位要推进',
             'input': ['ZSCORE mq:g1:slow clientA'], 'expected': '9500'},
            {'name': '慢消费者不许被从水位表里删掉（它是事实，不是缓存）',
             'input': ['ZSCORE mq:g1:slow clientB'], 'expected': '6100'},
            {'name': '水位表仍是两个成员', 'input': ['ZCARD mq:g1:slow'], 'expected': 2},
            {'name': '慢消费者要被标记', 'input': ['GET mq:g1:paused:clientB'],
             'expected': '1'},
            {'name': '边界：不许把正常消费者一起暂停',
             'input': ['EXISTS mq:g1:paused:clientA'], 'expected': 0},
            {'name': '幂等窗口本身不许消失', 'input': ['EXISTS mq:g1:idem'], 'expected': 1},
        ],
        runner={'setup': setup, 'entry': 'function', 'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer="""## 参考答案

```
ZREMRANGEBYSCORE mq:g1:idem -inf 6400
ZADD mq:g1:idem NX 8000 m-100
ZADD mq:g1:idem NX 8100 m-100      # 重复投递 ⇒ no-op，score 保持 8000
ZADD mq:g1:idem 9000 m-150
HINCRBY mq:g1:retry m-200 1
INCR mq:g1:dlq
ZADD mq:g1:slow XX 9500 clientA
SET mq:g1:paused:clientB 1
```

**为什么 E1 的回收边界是 6400 而不是 10000**：
窗口长度 3600 ⇒ 只保留 `(now - 3600, now] = (6400, 10000]` 内到达的消息。
`m-100` 的 8000 与 `m-150` 的 9000 都在窗口内。
本题初值里故意留了一条已过保留期的 `m-001`(5000) ⇒ 漏写 E1 会当场被 「窗口里恰好两条：m-100 与 m-150」抓到（ZCARD 会是 3）。
**这条初值存在的唯一理由，是让"忘了写 E1"变成可判分的** —— 第一版这里是个空窗口，漏写回收的脚本照样全绿，而它上线之后就是只增不减的内存泄漏。
**判题器测的是"最终状态对不对"，你要写的是"线上每周都在跑的那段代码"；
两者之间差的永远是数据形状 —— 数据不给力，闸门就只是装饰。**

**`HINCRBY` 而不是 `HSET ... 3`**：
重试计数是多实例并发推进的，写死"3"会把别的实例已经记到的数覆盖掉
（和上一题的 `reject` 同理）。**"我知道最终应该是几"不是写成常量的理由 ——
脚本此刻看到的值才是唯一事实。**

**`INCR mq:g1:dlq` 与"死信队列"是两件事**：
官方说死信队列在**订阅关系创建时自动创建**【源 S19】，
所以这里记的不是"我建了个队列"，而是"我这边观测到多少条落进了死信"。
它必须是**计数器而不是 0/1 标记** —— 死信条数是重试风暴与
"某个消费者的某段逻辑坏了"的量表，标量只够做告警、不够做趋势。

**朴素解为什么挂得彻底**：它 `DEL` 掉幂等窗口与水位表（两个 EXISTS/ZCARD 校验直接失败）、
`HDEL` 掉重试计数（`HGET` 返回 nil 而不是 3）、还暂停错了人
（`clientA` 被暂停、`clientB` 没有 ⇒ 最后两条校验同时反向）。
**这五条一起挂，说明判题器确实在按用例粒度报失败** ——
如果只挂一条，反倒要怀疑用例写得不够分。

**工程延伸（面试追问点）**

1. 为什么幂等键是 `msgId` 而不是业务键？（`msgId` 防的是**投递层重放**，
   业务键防的是**同一业务动作被提交两次**。两者是不同的故障：
   网络重试会让同一个 msgId 到两次；而用户双击会让两个不同 msgId 承载同一个业务动作。
   真实系统两层都要 —— 投递层用这里的 ZSET，业务层用唯一索引 + 幂等键。）
2. 窗口要多长？（它必须 **≥ 最大重放跨度**。RocketMQ 的延时消息上限是
   "3 天或保留时长的 3 倍取小"【源 S19】，所以任何 > 3 天的重放都不可能发生 ⇒
   窗口按"保留期 + 最大重试跨度"取，而不是拍一个 3600。
   本题用 3600 只是为了让边界算得动。）
3. 慢消费者判定与恢复？（判定要看**水位与 MaxOffset 的差 + 增速**，
   只看水位会把"刚接进来的新消费者"误判成慢的；
   恢复要看它是否追上过某个滞回线，否则会在边界上反复暂停/恢复 ——
   和熔断器的半开是同一个问题形状。）
4. 广播消费下这套数据结构怎么改？（key 里必须带 **消费者实例 ID** 而不是消费组：
   广播语义下每条消息会被消费多次【源 S19】，
   用组级窗口会把"每个实例都该收一次"错判成重复投递。
   **这是本题最值钱的一句答：数据结构的粒度必须等于语义的粒度。**）""",
    )


# =================================================================== M4 降级后的两套监控口径
@draft('sql-bd-fallback-two-curves')
def q_fallback_two_curves():
    LOG = []
    _id = [1]
    degraded_ids = {}

    def add(service, n_ok, n_timeout, n_breaker, n_limited, n_biz_err, fb_saved=0):
        """一段计数生成一组日志：rpc_result / fallback_used / biz_success 由同一个
        helper 派生，绝不分别手写（分两处写必然漂移）。"""
        for _ in range(n_ok):
            LOG.append([_id[0], service, 'OK', 0, 1])
            _id[0] += 1
        for _ in range(n_timeout):
            LOG.append([_id[0], service, 'TIMEOUT', 0, 0])
            _id[0] += 1
        for _ in range(n_breaker):
            LOG.append([_id[0], service, 'BREAKER', 0, 0])
            _id[0] += 1
        for _ in range(n_limited):
            LOG.append([_id[0], service, 'LIMITED', 0, 0])
            _id[0] += 1
        for _ in range(n_biz_err):
            LOG.append([_id[0], service, 'BIZ_ERROR', 0, 0])
            _id[0] += 1
        got = []
        for _ in range(fb_saved):
            # 降级兜住了：RPC 层是失败的，但调用方拿到了一份"看起来成功"的响应
            LOG.append([_id[0], service, 'TIMEOUT', 1, 1])
            got.append(_id[0])
            _id[0] += 1
        degraded_ids[service] = got

    add('cart', 800, 40, 0, 0, 60, fb_saved=100)      # 降级洗掉了 10% 的失败
    add('search', 900, 20, 60, 20, 0, fb_saved=40)    # 失败率高、降级率不高 ⇒ 该报的是不健康
    add('order', 980, 8, 0, 12, 0)                    # 干净
    add('coupon', 10, 2, 0, 0, 0, fb_saved=1)         # 样本太少，什么都不能判

    SCHEMA = {
        'rpc_log': table_spec(
            'id', ['id', 'to_service', 'rpc_result', 'fallback_used', 'biz_success'],
            ['id INT NOT NULL PRIMARY KEY', 'to_service VARCHAR(32) NOT NULL',
             "rpc_result VARCHAR(16) NOT NULL", 'fallback_used TINYINT NOT NULL',
             'biz_success TINYINT NOT NULL']),
    }
    SEED = {'rpc_log': LOG}

    def evaluate(rows):
        import collections
        stat = collections.defaultdict(lambda: dict(total=0, rpc_ok=0, biz_ok=0, degraded=0))
        for _id, svc, res, fb, biz in rows['rpc_log']:
            s = stat[svc]
            s['total'] += 1
            if res == 'OK':
                s['rpc_ok'] += 1
            if biz == 1:
                s['biz_ok'] += 1
            if fb == 1 and res != 'OK':
                s['degraded'] += 1
        out = []
        for svc in sorted(stat):
            s = stat[svc]
            rpc_bps = bps(s['rpc_ok'], s['total'])
            biz_bps = bps(s['biz_ok'], s['total'])
            deg_bps = bps(s['degraded'], s['total'])
            gap = biz_bps - rpc_bps
            if s['total'] < 100:
                verdict = 'LOW-SAMPLE'
            elif gap >= 500:
                verdict = 'POLLUTED-METRIC'
            elif deg_bps >= 3000:
                verdict = 'DEGRADE-HEAVY'
            elif rpc_bps < 9000:
                verdict = 'UNHEALTHY'
            else:
                verdict = 'CLEAN'
            out.append([svc, s['total'], rpc_bps, biz_bps, deg_bps, gap, verdict])
        return out

    COLS = ['to_service', 'total', 'rpc_success_bps', 'biz_success_bps',
            'degrade_bps', 'gap_bps', 'verdict']

    cases = [
        mut_case('基线：四种结论各命中一次，两条成功率曲线的差就是被降级洗掉的那部分',
                 SCHEMA, SEED, [], COLS, evaluate,
                 note='cart 1000 行里 RPC 成功 800、业务成功 900 ⇒ gap 1000 万分比 ⇒ POLLUTED；'
                      'search 8653 / 9038 ⇒ gap 385 未越线，但 RPC 成功率低于 9000 ⇒ UNHEALTHY；'
                      'order CLEAN；coupon 只有 13 行 ⇒ LOW-SAMPLE'),
        mut_case('边界：降级没兜住一条 ⇒ gap 少 10 万分比，但结论仍然是污染',
                 SCHEMA, SEED,
                 [('set', 'rpc_log', degraded_ids['cart'][0], {'biz_success': 0})],
                 COLS, evaluate,
                 note='业务成功数 900 变 899 ⇒ biz 曲线从 9000 掉到 8990，'
                      'gap 从 1000 掉到 990，仍 >= 500 ⇒ 阈值不是踩线才报'),
        mut_case('关键：把降级标记全部抹掉 ⇒ degrade_bps 归零而 gap 一点没变，结论照样污染',
                 SCHEMA, SEED,
                 [('setcol', 'rpc_log', 'to_service', 'cart', 'fallback_used', 0)],
                 COLS, evaluate,
                 note='这就是"把降级从监控里藏起来"的形态：所有聚合数都变好看了，'
                      '而两条曲线的差还在 —— 所以 gap 必须独立算出来，不许用 degrade_bps 反推'),
        mut_case('退化：日志清空 ⇒ 空集（不许出现除零，也不许造一行全 NULL）',
                 SCHEMA, SEED, [('clr', 'rpc_log')], COLS, evaluate),
    ]

    reference = """SELECT s.to_service                                        AS to_service,
       s.total                                               AS total,
       FLOOR(s.rpc_ok * 10000 / s.total)                     AS rpc_success_bps,
       FLOOR(s.biz_ok * 10000 / s.total)                     AS biz_success_bps,
       FLOOR(s.degraded * 10000 / s.total)                   AS degrade_bps,
       FLOOR(s.biz_ok * 10000 / s.total)
         - FLOOR(s.rpc_ok * 10000 / s.total)                 AS gap_bps,
       CASE
         WHEN s.total < 100 THEN 'LOW-SAMPLE'
         WHEN FLOOR(s.biz_ok * 10000 / s.total)
              - FLOOR(s.rpc_ok * 10000 / s.total) >= 500 THEN 'POLLUTED-METRIC'
         WHEN FLOOR(s.degraded * 10000 / s.total) >= 3000 THEN 'DEGRADE-HEAVY'
         WHEN FLOOR(s.rpc_ok * 10000 / s.total) < 9000 THEN 'UNHEALTHY'
         ELSE 'CLEAN'
       END                                                   AS verdict
FROM (SELECT to_service                                    AS to_service,
             COUNT(*)                                      AS total,
             SUM(rpc_result = 'OK')                        AS rpc_ok,
             SUM(biz_success = 1)                          AS biz_ok,
             SUM(fallback_used = 1 AND rpc_result <> 'OK')  AS degraded
      FROM rpc_log
      GROUP BY to_service) s
ORDER BY s.to_service"""

    naive = """SELECT to_service                                        AS to_service,
       COUNT(*)                                            AS total,
       FLOOR(SUM(biz_success) * 10000 / COUNT(*))          AS rpc_success_bps,
       FLOOR(SUM(biz_success) * 10000 / COUNT(*))          AS biz_success_bps,
       FLOOR(SUM(fallback_used) * 10000 / COUNT(*))        AS degrade_bps,
       0                                                   AS gap_bps,
       CASE WHEN COUNT(*) < 100 THEN 'LOW-SAMPLE'
            WHEN FLOOR(SUM(biz_success) * 10000 / COUNT(*)) >= 9000 THEN 'CLEAN'
            ELSE 'UNHEALTHY' END                           AS verdict
FROM rpc_log
GROUP BY to_service
ORDER BY to_service"""

    statement = """## 背景

Kitex 的 Fallback 文档里有一句几乎可以直接当题面【源 S7】：

> "Fallback 后可能直接返回成功的 Resp，对用户而言是一次成功请求，
> 但 RPC 层面还是失败请求，**所以监控默认以原来的结果上报，
> 但支持配置化调整为以 Fallback 结果上报**"

同一页还有两条硬事实：可兜底的结果有三类（`RPC Error`：超时/熔断/限流/协议层、
`业务 Error`、`BaseResp` 里的错误码），并且 Fallback **"涉及业务逻辑，只支持代码配置"**。

素材 §3 的"常见错误答案"表里那条 **"降级返回默认值，监控就好了"**，
暴露点写的是"掩盖真实失败率；没有降级触发率这个指标"。这题就是把它变成一条 SQL。

## 表

```
rpc_log(id INT PK, to_service VARCHAR(32), rpc_result VARCHAR(16),
        fallback_used TINYINT, biz_success TINYINT)
-- rpc_result ∈ ('OK','TIMEOUT','BREAKER','LIMITED','BIZ_ERROR')
```

一次调用一行：`rpc_result` 是 **RPC 层的原始结果**，
`fallback_used` 标记这次是否走了兜底逻辑，`biz_success` 标记**调用方最终是否拿到了可用响应**。

## 任务

只交**一条 SELECT**。按 `to_service` 输出，列固定为

```
to_service, total, rpc_success_bps, biz_success_bps, degrade_bps, gap_bps, verdict
```

- `total` = 该下游的调用行数
- `rpc_success_bps` = `FLOOR(SUM(rpc_result = 'OK') * 10000 / total)`
- `biz_success_bps` = `FLOOR(SUM(biz_success = 1) * 10000 / total)`
- `degrade_bps` = `FLOOR(SUM(fallback_used = 1 AND rpc_result <> 'OK') * 10000 / total)`
  （**注意定义**："降级触发率"统计的是"RPC 本来失败了、靠兜底救回来"的比例。
  `rpc_result = 'OK'` 且 `fallback_used = 1` 的行**不算触发**，那是埋点错误）
- `gap_bps` = `biz_success_bps - rpc_success_bps`
- `verdict` 按优先级从上到下：

| # | 条件 | verdict |
| --- | --- | --- |
| 1 | `total < 100` | `LOW-SAMPLE` |
| 2 | `gap_bps >= 500` | `POLLUTED-METRIC` |
| 3 | `degrade_bps >= 3000` | `DEGRADE-HEAVY` |
| 4 | `rpc_success_bps < 9000` | `UNHEALTHY` |
| 5 | 其余 | `CLEAN` |

按 `to_service` 升序。

## 三条判据为什么长这样

- **`POLLUTED-METRIC` 排在最后两条之前。**
  gap 高说明**你看到的成功率是被降级洗出来的**，
  此时再谈"降级率高不高""下游健康不健康"都是在读一份被污染的表。
  这一档的作用不是描述故障，是**禁止下面两档给出结论**。
- **`degrade_bps` 只数 `rpc_result <> 'OK'` 的那部分。**
  把 `fallback_used = 1` 全算成触发，会让"正常调用顺带打了降级标记"
  这种埋点错误伪装成降级率 —— 而真正的降级率下降（= 兜底逻辑坏了）反而看不出来。
- **`LOW-SAMPLE` 优先，理由和熔断器的 `MinSample=200` 一模一样。**
  coupon 那 13 行里 1 行降级 ⇒ 万分比 769 的"降级率"，
  3 行 RPC 不 OK 就把 `rpc_success_bps` 打到 7692 ——
  看着是重大事故，实际是几次抛硬币。

## 陷阱提示

`SUM(布尔)` 在 MySQL 里把真当 1、假当 0 加，**但一行都没有时返回 NULL** ——
那会让 `FLOOR(NULL / NULL)` 一路变成 NULL。
分母是 `total`（调用行数），不是 `COUNT(DISTINCT ...)`：一行就是一次调用。

只允许一条 `SELECT`。"""

    return base(
        'sql', 'senior',
        '降级之后错误率为什么掉了：把业务成功率与 RPC 成功率算成两条独立曲线',
        statement, 'mysql',
        ['fallback-observability', 'metric-caliber', 'degrade-rate-sli', 'priority-rules',
         'modern:resilience-semantics'],
        src('服务端研发（Go 微服务治理与稳定性方向） 高级工程师',
            INFRA + '#4 考点 7（Fallback 降级与监控口径污染：三类可兜底结果、'
            '"监控默认以原来的结果上报，但支持配置化调整为以 Fallback 结果上报"、'
            '只能代码配置；素材建议 judgeKind=mysql '
            '"给定调用日志表，分别算业务成功率、RPC 成功率、降级率，暴露两者差异"）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=25,
        answer="""## 参考答案

一个内层 `GROUP BY` 把四个计数算完，外层再算三条万分比曲线与 verdict。
**四个计数必须来自同一次扫描**（`SUM(布尔)` 比四个 `SUM(CASE WHEN ...)` 短，
且不会因为 `CASE` 漏写 `ELSE 0` 而引入 NULL）。

**基线四行：**

| service | total | rpc_bps | biz_bps | degrade_bps | gap | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| cart | 1000 | 8000 | 9000 | 1000 | 1000 | POLLUTED-METRIC |
| coupon | 13 | 7692 | 8461 | 769 | 769 | LOW-SAMPLE |
| order | 1000 | 9800 | 9800 | 0 | 0 | CLEAN |
| search | 1040 | 8653 | 9038 | 384 | 385 | UNHEALTHY |

`search` 是这题最容易读错的一行：它的 gap 是 385，**不到 500 线**，
所以它*不是*指标污染，而是真的不健康（RPC 成功率 8653 低于 9000）。
它的 100 条失败里 60 条是熔断、20 条限流，降级只兜回 40 条。
**"两套曲线差得不多"与"系统健康"是两件事**：前者说明监控没被洗，
后者要看原始成功率本身。

**用例「把降级标记全部抹掉」是本题的核心**：cart 的 `degrade_bps` 从 1000 变 0，
但两条成功率曲线**一个都没变**（它们压根不看 `fallback_used`），
gap 仍是 1000 ⇒ verdict 仍是 `POLLUTED-METRIC`。
也就是说：**关掉降级埋点能让降级率指标变漂亮，但洗不掉两条曲线的差。**
这正是官方那句"监控默认以原来的结果上报"的价值 ——
原始口径留着，才有一个不被改动方污染的对照组。
反之，如果 gap 是由 `degrade_bps` 推出来的（`naiveSolution` 直接把 gap 写死成 0），
抹掉标记就同时抹掉了症状 —— 那才是"大盘骗过 SRE"。

**`naiveSolution` 挂得最狠的一条**：它用同一个 `SUM(biz_success)` 当两条曲线
⇒ cart 的 RPC 成功率被抬到 9000（真实是 8000），**一次真实的 10% 失败从报表上彻底消失**；
`gap_bps` 又写死成 0 ⇒ cart 在它手里是 `CLEAN`，而真实答案是 `POLLUTED-METRIC`。
search 是同一件事的隐蔽版：业务侧 940 成 ⇒ 万分比 9038 越过 9000 线，
它那份 CASE 只会输出 `CLEAN`，真实答案却是 `UNHEALTHY`（它是熔断/限流打的，不是降级打的）。

**而"把 `fallback_used = 1` 全算成触发"这条错法，在判题数据上恰好量不出来**：
种子里没有一行 `fallback_used = 1` 且 `rpc_result = 'OK'`，
于是两种口径对 search 都得到 384 万分比（40/1040），离 3000 线还差 2616。
`naiveSolution` 那份 CASE 里也压根没有 `DEGRADE-HEAVY` 这一档 ——
**它是留给埋点出错那一天的；这份种子证伪不了它。**

**工程延伸（面试追问点）**

1. 为什么降级响应必须带标记？（`gap_bps` 只能发现"有东西被兜住了"，
   发现不了"兜住的东西是三天前的"。素材考点 7 的延伸要求就是这个：
   降级响应要带**新鲜度 / 来源**标记，并规定它**不得进入对账**。
   SQL 侧的形状是再加两列 `fallback_source` / `data_age_seconds`，
   然后按标记分组看"被兜住的调用后来有没有变成资损"。）
2. 两套曲线的告警怎么配？（业务成功率对**用户**负责 ⇒ 进 SLO；
   RPC 成功率与降级触发率对**系统**负责 ⇒ 进变更回顾。
   素材的原话是把"降级比例"作为**一等 SLO 指标**，而不是一个 debug 用的次要计数。）
3. `fallback_used` 与 `rpc_result = 'OK'` 同时为真怎么办？（那正是本题把 `degrade_bps`
   定义成"`fallback_used=1` **且** `rpc_result <> 'OK'`"的原因。
   真实系统里它的含义是"埋点写错了"或"兜底逻辑被无条件调用"，
   应当另出一条 `mislabeled_fallback` 计数并告警 —— 别把它折进任何一条成功率。）
4. 熔断/限流要不要算失败？（本题算：它们都在 `rpc_result` 里，`biz_success` 才是真相。
   这正是"以原结果上报"的好处：**熔断触发率、限流拒绝率、降级触发率**是三条独立曲线，
   共享同一个分母。把它们合并成"错误率"，就等于放弃了
   "该扩容量还是该改代码"的判断依据 —— 参见本批的限流题，那里也是两个拒因分开统计。）""",
    )


# =================================================================== M5 埋点血缘闭包
@draft('sql-bd-lineage-closure')
def q_lineage_closure():
    NODE = [
        ['ev_pay', 'event', 0],
        ['ev_click', 'event', 0],
        ['dwd_order', 'table', 400],
        ['ads_gmv', 'report', 90],
        ['seg_vip', 'segment', 12],
        ['tmp_debug', 'table', 0],
        ['ads_funnel', 'report', 5],
    ]
    EDGE = [
        [1, 'ev_pay', 'dwd_order'],
        [2, 'dwd_order', 'ads_gmv'],
        [3, 'dwd_order', 'seg_vip'],
        [4, 'ev_click', 'ads_funnel'],
        [5, 'ev_click', 'tmp_debug'],
        [6, 'ads_gmv', 'ads_funnel'],        # 间接链：ev_pay → dwd_order → ads_gmv → ads_funnel
    ]
    SCHEMA = {
        'lineage_node': table_spec(
            'name', ['name', 'kind', 'queries_30d'],
            ['name VARCHAR(32) NOT NULL PRIMARY KEY', 'kind VARCHAR(16) NOT NULL',
             'queries_30d INT NOT NULL']),
        'lineage_edge': table_spec(
            'id', ['id', 'from_node', 'to_node'],
            ['id INT NOT NULL PRIMARY KEY', 'from_node VARCHAR(32) NOT NULL',
             'to_node VARCHAR(32) NOT NULL']),
    }
    SEED = {'lineage_node': NODE, 'lineage_edge': EDGE}

    def closure(rows):
        edges = rows['lineage_edge']
        queries = {r[0]: r[2] for r in rows['lineage_node']}
        kinds = {r[0]: r[1] for r in rows['lineage_node']}
        out = []
        for node in sorted(n for n in kinds if kinds[n] == 'event'):
            seen = set()
            frontier = [node]
            for _depth in range(6):          # 与 SQL 侧的 WHERE depth < 6 对齐
                nxt = []
                for cur in frontier:
                    for _id, frm, to in edges:
                        if frm == cur and to not in seen:
                            seen.add(to)
                            nxt.append(to)
                frontier = nxt
                if not frontier:
                    break
            direct = {to for _id, frm, to in edges if frm == node}
            indirect = seen - direct
            max_q = max([queries.get(n, 0) for n in seen], default=0)
            sum_q = sum(queries.get(n, 0) for n in seen)
            if not seen:
                prio = 'orphan'
            elif sum_q == 0:
                prio = 'low-usage'
            elif len(seen) > len(direct):
                prio = 'deep-dependency'
            else:
                prio = 'hot-direct'
            out.append([node, len(direct), len(indirect), len(seen), max_q, sum_q, prio])
        return out

    COLS = ['event_name', 'direct_consumers', 'indirect_consumers', 'closure_nodes',
            'max_queries_30d', 'total_queries_30d', 'retire_priority']

    cases = [
        mut_case('基线：直接引用与间接引用分开数，闭包必须沿链走到底',
                 SCHEMA, SEED, [], COLS, closure,
                 note='ev_pay 只有 dwd_order 一个直接下游，但闭包有四个节点 ⇒ indirect=3；'
                      'ev_click 两个直接下游、闭包也是两个 ⇒ 没有间接链'),
        mut_case('边界：断开中间那一跳 ⇒ 深层报表从闭包里消失，节点数与热度同时缩水',
                 SCHEMA, SEED,
                 [('del', 'lineage_edge', 2)], COLS, closure,
                 note='删掉 dwd_order→ads_gmv 之后 ads_gmv 与它下面的 ads_funnel '
                      '都从 ev_pay 的闭包里掉了出去 ⇒ 闭包从 4 个节点变 2 个、'
                      'total_queries 从 507 变 412。判定仍是 deep-dependency'
                      '（还剩 seg_vip 这一条间接链）'),
        mut_case('关键：只清掉中间层的查询数 ⇒ 闭包热度仍由最深处那张报表撑着，不许提前判下线',
                 SCHEMA, SEED,
                 [('set', 'lineage_node', 'ads_gmv', {'queries_30d': 0}),
                  ('set', 'lineage_node', 'seg_vip', {'queries_30d': 0}),
                  ('set', 'lineage_node', 'dwd_order', {'queries_30d': 0})],
                 COLS, closure,
                 note='ev_pay 的 total_queries 从 507 掉到 5，但那 5 次来自闭包最深处'
                      '的 ads_funnel ⇒ 仍然不是 low-usage。'
                      '这正是素材那句"下游派生链上的间接往往是真正被消费的那个"'),
        mut_case('边界：整条闭包一次查询都没有 ⇒ 才允许判 low-usage（它排在 deep-dependency 之前）',
                 SCHEMA, SEED,
                 [('set', 'lineage_node', 'ads_gmv', {'queries_30d': 0}),
                  ('set', 'lineage_node', 'seg_vip', {'queries_30d': 0}),
                  ('set', 'lineage_node', 'dwd_order', {'queries_30d': 0}),
                  ('set', 'lineage_node', 'ads_funnel', {'queries_30d': 0})],
                 COLS, closure,
                 note='ev_pay 有 3 个间接下游、闭包非空，但总热度为 0 ⇒ low-usage 而不是 '
                      'deep-dependency。ev_click 同时变成 low-usage（它闭包里的 '
                      'ads_funnel 与 tmp_debug 都归零了）⇒ 这一格抓的是"第 2 条必须先判"'),
        mut_case('退化：一条边都没有 ⇒ 两个事件都是孤儿，热度列必须是 0 而不是 NULL',
                 SCHEMA, SEED,
                 [('del', 'lineage_edge', 1), ('del', 'lineage_edge', 2),
                  ('del', 'lineage_edge', 3), ('del', 'lineage_edge', 4),
                  ('del', 'lineage_edge', 5), ('del', 'lineage_edge', 6)],
                 COLS, closure),
        mut_case('边界：中间节点自己就是最热的那个 ⇒ 通知要先发给它的所有者',
                 SCHEMA, SEED,
                 [('set', 'lineage_node', 'dwd_order', {'queries_30d': 5000})],
                 COLS, closure,
                 note='max_queries_30d 从 400 变 5000：只看直接下游的热度会低估影响面，'
                      '只看叶子会低估中间层的价值'),
        mut_case('边界：把叶子报表查热、中间表查冷 ⇒ 排序变了但闭包形状没变',
                 SCHEMA, SEED,
                 [('set', 'lineage_node', 'dwd_order', {'queries_30d': 0}),
                  ('set', 'lineage_node', 'ads_funnel', {'queries_30d': 3000})],
                 COLS, closure),
    ]

    reference = """WITH RECURSIVE clo(root, node, depth) AS (
    SELECT e.from_node, e.to_node, 1
      FROM lineage_edge e
      JOIN lineage_node n ON n.name = e.from_node AND n.kind = 'event'
    UNION ALL
    SELECT c.root, e.to_node, c.depth + 1
      FROM clo c
      JOIN lineage_edge e ON e.from_node = c.node
     WHERE c.depth < 6
),
agg AS (
    SELECT c.root                                    AS event_name,
           COUNT(DISTINCT c.node)                    AS closure_nodes,
           MAX(COALESCE(q.queries_30d, 0))           AS max_queries_30d,
           SUM(COALESCE(q.queries_30d, 0))           AS total_queries_30d
    FROM clo c
    LEFT JOIN lineage_node q ON q.name = c.node
    GROUP BY c.root
),
direct AS (
    SELECT from_node AS event_name, COUNT(DISTINCT to_node) AS direct_consumers
    FROM lineage_edge
    GROUP BY from_node
)
SELECT n.name                                                  AS event_name,
       COALESCE(d.direct_consumers, 0)                         AS direct_consumers,
       COALESCE(a.closure_nodes, 0) - COALESCE(d.direct_consumers, 0) AS indirect_consumers,
       COALESCE(a.closure_nodes, 0)                            AS closure_nodes,
       COALESCE(a.max_queries_30d, 0)                          AS max_queries_30d,
       COALESCE(a.total_queries_30d, 0)                        AS total_queries_30d,
       CASE
         WHEN COALESCE(a.closure_nodes, 0) = 0 THEN 'orphan'
         WHEN COALESCE(a.total_queries_30d, 0) = 0 THEN 'low-usage'
         WHEN COALESCE(a.closure_nodes, 0) > COALESCE(d.direct_consumers, 0)
             THEN 'deep-dependency'
         ELSE 'hot-direct'
       END                                                     AS retire_priority
FROM lineage_node n
LEFT JOIN direct d ON d.event_name = n.name
LEFT JOIN agg a ON a.event_name = n.name
WHERE n.kind = 'event'
ORDER BY n.name"""

    naive = """SELECT n.name                        AS event_name,
       COUNT(e.to_node)                AS direct_consumers,
       0                               AS indirect_consumers,
       COUNT(e.to_node)                AS closure_nodes,
       COALESCE(MAX(t.queries_30d), 0) AS max_queries_30d,
       COALESCE(SUM(t.queries_30d), 0) AS total_queries_30d,
       CASE WHEN COUNT(e.to_node) = 0 THEN 'orphan' ELSE 'hot-direct' END AS retire_priority
FROM lineage_node n
LEFT JOIN lineage_edge e ON e.from_node = n.name
LEFT JOIN lineage_node t ON t.name = e.to_node
WHERE n.kind = 'event'
GROUP BY n.name
ORDER BY n.name"""

    statement = """## 背景

DataFinder 的《一般事件》页里，"血缘关系"是**增值的埋点治理模块**，
文档明确区分两种引用【源 S7】：

> 图表 / 看板血缘 **区分"直接引用"与"间接引用"**；
> 用户分群血缘额外带 **最新分群用户数** 与 **近 30 天的查询次数**。

素材 §4 考点 4 的【推】结论是本题要落地的判据：
**下线判据应当是"间接闭包内消费为零 + 热度为零 + 保留期外"，而不是"没人认领"；
而且"下游派生链上的'间接'往往是真正被消费的那个"。**
递归展开这件事官方文档没写 ⇒ 深度上限与优先级枚举都是本题设定的契约。

## 表

```
lineage_node(name VARCHAR(32) PK, kind VARCHAR(16), queries_30d INT)
   -- kind ∈ ('event','table','report','segment')；queries_30d = 该节点近 30 天被查询次数
lineage_edge(id INT PK, from_node VARCHAR(32), to_node VARCHAR(32))
   -- 方向：from 被 to 消费（to 是下游）
```

## 任务

只交**一条查询**（允许以 `WITH RECURSIVE` 开头）。对**每个 `kind = 'event'` 的节点**输出

```
event_name, direct_consumers, indirect_consumers, closure_nodes,
max_queries_30d, total_queries_30d, retire_priority
```

定义：

- `direct_consumers` = `from_node = 该事件` 的**不同**下游数
- `closure_nodes` = 从该事件出发沿边**反复走**能到达的**不同节点**数（不含自己），
  **深度上限 6**（超过 6 层的链在本题里视为不存在）
- `indirect_consumers` = `closure_nodes - direct_consumers`
- `max_queries_30d` / `total_queries_30d` = 在**整个闭包**上取查询次数的最大值 / 求和
  （闭包为空时两者都是 `0`，**不许是 NULL**）
- `retire_priority` 按优先级从上到下：

| # | 条件 | 值 |
| --- | --- | --- |
| 1 | `closure_nodes = 0` | `orphan` |
| 2 | `total_queries_30d = 0` | `low-usage` |
| 3 | `closure_nodes > direct_consumers`（存在间接链） | `deep-dependency` |
| 4 | 其余 | `hot-direct` |

按 `event_name` 升序。**图中保证无环**（不需要做环检测）。

## 三条判据为什么长这样

- **`low-usage` 排在 `deep-dependency` 之前。**
  有间接链但整条链上**一次查询都没有** ⇒ 那条链是历史遗留，先按热度下线它；
  反过来如果链上有热度，就**先断链再下线**。顺序反了会拔断活着的报表。
- **热度要在整个闭包上求和，不是只对直接下游。**
  只数直接下游会得出"这张临时表 30 天被查 90 次 ⇒ 很热"，
  而它其实只是中间节点、真正在读的是它下游那个每天跑一次的定时报表。
- **`closure_nodes` 必须是去重的节点数。**
  多条链汇到同一个消费者时，用行数而不是去重数会把同一个消费者数两遍，
  于是 `indirect_consumers` 凭空变大、`deep-dependency` 误报。

## 陷阱提示

递归 CTE 的**锚点**必须限定 `kind = 'event'`，否则中间表节点也会成为自己的根，
结果里会冒出 `dwd_order` 这种根本不该出现的行。
深度上限要写成显式 `WHERE depth < 6`（`cte_max_recursion_depth` 是会话变量，
**考生提交里不许出现 `SET`**，所以递归必须自己收口）。

只允许一条查询。"""

    return base(
        'sql', 'senior',
        '埋点血缘闭包：直接/间接引用分开数，下线判定要在整个闭包上看热度',
        statement, 'mysql',
        ['data-lineage', 'recursive-cte', 'indirect-closure', 'retirement-decision',
         'modern:metadata-workflow'],
        src('数据研发（埋点治理与元数据方向） 高级工程师',
            DATA + '#4 考点 4（埋点血缘与影响分析：官方"图表/看板血缘区分直接引用与间接引用、'
            '分群血缘带最新分群用户数与近 30 天查询次数"；'
            '素材建议 mysql 版"递归 CTE 展开事件→报表/分群闭包并按热度输出下线优先级，'
            '题面注明直接/间接两种类型"；判据框架按【推】写成题面契约）'),
        language='sql',
        cases=cases,
        runner={'setup': sql_seed(SCHEMA, SEED), 'entry': 'function', 'timeoutMs': 20000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=35,
        answer="""## 参考答案

三段 CTE：`clo` 递归展开（锚点限定 `kind='event'`、`WHERE depth < 6` 收口）、
`agg` 在闭包上聚合、`direct` 数一层下游；最后以 `lineage_node` 里的事件为主表左连回来。

**基线两行：**

| event | direct | indirect | closure | max_q | sum_q | priority |
| --- | --- | --- | --- | --- | --- | --- |
| ev_click | 2 | 0 | 2 | 5 | 5 | hot-direct |
| ev_pay | 1 | 3 | 4 | 400 | 507 | deep-dependency |

`ev_pay` 的闭包是 `dwd_order → {ads_gmv, seg_vip} → ads_funnel` 共 4 个节点，
查询数分别是 400 / 90 / 12 / 5 ⇒ 求和 507、最大 400；其中只有 `dwd_order` 是直接下游
⇒ `indirect_consumers = 3` ⇒ 落 `deep-dependency`。
`ev_click` 的两个下游（`ads_funnel`、`tmp_debug`）都是直接的 ⇒
`closure_nodes = direct_consumers` ⇒ 判据第 3 条不成立 ⇒ `hot-direct`。

**这里藏着本题最值得说的一件事**：`ads_funnel` 既是 `ev_click` 的**直接**下游，
又是 `ev_pay` 的**间接**下游（经 `dwd_order → ads_gmv`）。
**同一个消费者在不同根的闭包里各出现一次，热度也各算一遍。**
所以"这张报表有没有人用"与"下线这张事件会不会打爆这张报表"是两个问题 ——
前者看节点，后者看闭包。

**用例「断开中间那一跳」**删掉 `dwd_order → ads_gmv` 那条边 ⇒
`ev_pay` 的闭包从 4 掉到 2（只剩 `dwd_order`、`seg_vip`）、`total_queries` 从 507 掉到 412。
只查一层血缘的人会读成"影响变小了"，
而真实情况是 **`ads_gmv` 从这张事件的下游里消失了** ——
如果那条边只是**漏登记**，这个查询就会把"登记缺失"读成"依赖消失"。
这是血缘系统特有的失效模式：**图不完整时，"没有依赖"和"查不到依赖"无法区分**。
素材 §3 那条"没有验收/变更历史/血缘三件套"讲的正是这件事。

**用例「关键：只清掉中间层的查询数」是本题最反直觉的一格。**
把 `dwd_order`(400)、`ads_gmv`(90)、`seg_vip`(12) 全归零之后，
`ev_pay` 的 `total_queries_30d` 从 507 掉到 **5** —— 但那 5 次来自闭包**最深处**的
`ads_funnel`，所以它**仍然不是** `low-usage`，判定照旧是 `deep-dependency`。
这就是素材那句话的可执行形式：*"下游派生链上的'间接'往往是真正被消费的那个"*。
按"直接下游热度"做决策的人会在这张事件上签"无人使用"，
而真正的消费者在两层之外、每天跑一次定时任务。

**只有再把 `ads_funnel` 也归零（用例「整条闭包一次查询都没有」），`ev_pay` 才落到
`low-usage`** —— 此时它的闭包依然是 4 个节点、依然有 3 个间接下游，
第 3 条 `closure_nodes > direct_consumers` 完全成立。
**如果第 2、3 条顺序写反，这一格会被判成 `deep-dependency`（"先断链再下线"），**
于是这张已经没人用的事件在待办列表里被排到三个月之后 ——
成本一分不省，还一直背着"高风险变更"的评审成本。
这两条用例合起来就是"优先级即结论"的字面证明：**同一份图、同一组数字，
只有换掉两条 `WHEN` 的先后，输出就完全不同。**

**用例「中间节点自己就是最热的那个」**把 `dwd_order` 提到 5000：
`max_queries` 从 400 变 5000、`total` 从 507 变 5107。
只看叶子会低估中间层的价值（它每天被大量扫描），
只看直接下游会低估影响面（真正在跑定时任务的是最深处那张报表）——
**所以 `max` 与 `sum` 两列都要出**：`max` 回答"最痛的一个是谁"，
`sum` 回答"这次变更的总影响有多大"。

**`naiveSolution` 挂在哪**：它不递归 ⇒ `indirect_consumers` 恒为 0、
`closure_nodes = direct_consumers`、`deep-dependency` 永不出现；
热度只算直接下游（`ev_pay` 的 sum 会从 507 变成 400）；
`ev_click` 恰好与正确答案同形（2/0/2/5/5/hot-direct）——
**这就是"只测基线会漏掉整个 bug 类"的教科书例子**：
要抓它必须有一条带间接链的用例，而基线里那条链是它唯一露馅的地方。

**工程延伸（面试追问点）**

1. 深度上限为什么不该是常量？（素材考点 4 的完整判据是
   "间接闭包内消费为零 + 热度为零 + **保留期外**"，
   所以真正的界是"这条链还活不活"，不是层数。
   工程做法：展开到"热度为 0 的叶子"为止，并把深度本身作为**证据**输出 ——
   一条 9 层深的链本身就是治理信号。）
2. 有环怎么办？（MySQL 递归 CTE 遇到环会一路加到深度上限，
   所以 `depth < 6` 顺带兜住了环。但更该做的是**登记时禁止成环**
   （DAG 校验），而不是查询时容忍它 ——
   有环的血缘图意味着"上游是谁"这个问题没有答案。）
3. 字段级血缘呢？（本题只有节点级。真实事故的形态是
   "事件还在上报、某个属性没人写" ⇒ 那需要 `event.attr → report.column` 级别的图。
   递归查询的形状完全一样，只是边表换一张 ——
   所以**把闭包查询写成可复用的视图**比写死在当前这张表上更有价值。）
4. 这份排序怎么变成卡口？（素材 §1.4 给的是 DataLeap 的形状：
   数据标准 + 字段元数据对标 + 标准监控统计【源 S6】。
   落到本题就是：下线工单必须**自动附带**这条闭包查询的结果（节点清单 + 热度），
   而不是让申请人手写"经确认无人使用"。）""",
    )


# ===================================================================
# 主观题 12 道（system-design 5 / agent-design 4 / hot-interviews 3）
#
# 纪律（两份素材各自的 §7 都写了"没有官方来源就不许写进题面"）：
#   * 题面里的机制、默认值、能力边界一律引开源框架/云产品文档的原文（素材里标【源】的部分）；
#   * 素材标【推】的结论（Feed 推拉成本、半开恢复判据、SRM/窥视、成本刀法）可以出题，
#     但题面写成"本题设定的契约 / 你的推断"，**不写成"字节官方这么说"**；
#   * 任何 QPS / 机器数 / p99 / 成本百分比都显式标注为**出题假设**并要候选人给测量方法
#     （素材 §7 第 1 条明写：公开渠道没有抖音/TikTok 线上量级，编数字是背题信号）。
# ===================================================================

# 14 道主观题共用的评分口径提示（进 rubric.notes，不给答题者看）
SUBJ_NOTES_INFRA = (
    '本题的机制与默认值都来自公开框架文档，可以引用；但"字节内部一定这么用"是不许出现的断言。'
    '所有 QPS / 时长 / 占比都是出题假设：当已知事实硬算具体容量不扣分，'
    '主动声明假设并给出测量方式才算满分（素材 §7 明写公开渠道没有任何官方量级）。')


@draft('sys-bd-timeout-budget-and-joint-thresholds')
def q_sys_timeout_budget():
    statement = """## 角色与时长

你正在面试**字节跳动 某中台服务端研发（Go，服务治理与稳定性方向）的 Senior**，45 分钟。
面试官不接受"加个熔断、配个重试"这类回答，只追问三件事：**默认是什么、谁负责、怎么量化**。

## 可核查事实（来自公开框架文档，不要质疑出处）

- 这套框架的**熔断、限流、重试都不是默认开启**；重试不作为默认策略的官方理由是
  "很多业务请求不具有幂等性"。
- 超时：`ConnTimeout` 默认 50ms；`RPCTimeout` 默认 **0（不限时）**；超时错误**默认不重试**；
  配置优先级 `Call Option（请求粒度）> Client Option > TimeoutProvider（动态）`；
  服务端 `ReadWriteTimeout` 文档明写"实际未被使用"。
- 重试：`MaxRetryTimes` 默认 2、合法域 0–5；若配置 `MaxDurationMS` 则**必须大于单次请求超时**，
  且**不超过 `RPCTimeout × (MaxRetryTimes + 1)`**；停止策略 `CBPolicy` 默认 10%、合法域
  (0, 30%]，且该阈值**须小于服务粒度的熔断阈值**；`ChainStop` 默认启用
  （"如果上游请求是重试请求，不会重试"）；`RetrySameNode` 默认 false；退避 None/Fixed/Random；
  **流式接口不支持重试**；按链路剩余预算判断是否重试的 `DDLStop` **框架未内置实现**，
  需要自己 `retry.RegisterDDLStop(...)`，官方建议"基于上游发起调用的时间戳和超时时间判断"。
- 熔断：服务粒度 key = `fromService/toService/method`；默认 `ErrRate 0.5 / MinSample 200`，
  且"样本不足 200 时配置不生效"；**实例粒度熔断后框架会自动重试**，
  前提是用 `WithInstanceMW` 注册中间件，因为它"会在负载均衡后执行"。
- 限流：`MaxConnections` 与 `MaxQPS` 是两个维度，默认实现是令牌桶 + 计数器；
  `WithLimit` 与 `WithQPSLimiter/WithConnectionLimiter` 同时配置时**只有后者生效**；
  默认 QPS 限流在非多路复用下于 **OnRead** 生效以省反序列化开销，要多路复用或按 method
  限流才放在 **OnMessage**；**对 gRPC 协议暂不生效**，要靠 HTTP/2 流控窗口
  （`WithGRPCInitialWindowSize` / `WithGRPCInitialConnWindowSize`）；阈值可 `Updater.UpdateLimit`
  热更；可观测靠 `LimitReporter` 的连接数/QPS 超限上报。
- 降级：Fallback 可对 `RPC Error`、`业务 Error`、`Resp(BaseResp)` 错误码三类结果兜底；
  文档明写"Fallback 后可能直接返回成功的 Resp，对用户而言是一次成功请求，但 RPC 层面还是失败
  请求，**所以监控默认以原来的结果上报，但支持配置化调整为以 Fallback 结果上报**"；
  并且 Fallback"涉及业务逻辑，**只支持代码配置**"（不能走配置中心热开关）。
- 配置下发：超时/重试/熔断/服务端限流阈值可由配置中心扩展下发；开源 configmanager 的语义是
  "周期性加载 → 比对两版差异 → **只有差异才通知注册的 listener**"，另有手动刷新与 dump。

## 待治理的现场（**下列数字全部是出题假设**，请把它们当假设并说明你怎么验证）

核心链路 `A → B → C → D → E`（5 跳，其中一跳是跨协议的 gRPC 调用），端到端 P99 目标 800ms，
高峰期 QPS 假设 3000。现状：每个服务都把 `RPCTimeout` 配成 1s、各自重试 2 次、
**没有任何一处配熔断**。上周 D 发生 GC 抖动，A 的用户投诉暴涨，
但**大盘上的"成功率"这条线一动没动**。

## 请给出（七问，逐条作答）

1. **超时预算与取消传播**：800ms 怎么切给五跳？"链路已经用了多久"这个信息由谁携带？
   框架不内置链路判据时你要自己实现什么？哪一跳的超时应该**直接放弃**而不是重试，判据是什么？
2. **联合阈值表**：给出"重试停止阈值 / 熔断阈值 / 限流阈值"三者的大小关系与理由，
   并给**低峰与高峰两套数**（含 `MinSample` 在不同时段怎么取）。
3. **重试风暴的刹车**：这套框架提供了哪几层刹车？最坏情况下一次用户请求会让 D 收到几个请求？
   写出你的算法与假设，并说明 `ChainStop` 把它削减到多少。
4. **gRPC 与 Thrift 混布**：QPS 限流对 gRPC 不生效这件事你怎么兜？谁 protect 谁？
   兜底件自己失效时放行还是拒？
5. **降级的可观测**：为什么上周"成功率没掉"？给出至少**三条互相独立的曲线**及告警优先级；
   降级响应体里要放什么字段，哪些下游必须禁止消费它？
6. **阈值热更**：坏配置（例如把熔断阈值下发成 0）怎么被拦住？"原子生效"具体指什么？
   回滚判据是什么？哪些治理项**不能**靠热改、为什么？
7. 一条你**主动要求默认关掉**的治理特性（含代价），以及一个能证明这套治理真的有效的量化指标。

## 约束

- 不许出现"我们线上 XX 万 QPS"这类编造量级；素材明确把它列为不可写项。
- 可以引用开源框架的机制与默认值，不许把它写成"字节内部一定这么用"。"""

    return base(
        'system-design', 'senior',
        '五跳链路的超时预算与联合阈值表：三层刹车、协议盲区，以及降级后那条没掉的曲线',
        statement, 'llm-rubric',
        ['timeout-budget', 'retry-amplification', 'threshold-coupling', 'fallback-observability',
         'config-hot-reload', 'modern:service-governance'],
        src('服务端研发（Go 微服务治理与稳定性方向） 高级工程师',
            INFRA + '#5 题面草稿 B（主推 10 分制长题：超时预算与取消传播、联合阈值表、gRPC 混布、'
            '降级可观测、阈值热更、主动关掉一项、量化指标）＋ #4 考点 6（超时预算与链路传播：'
            '四类超时、RPCTimeout 默认 0、DDLStop 需自行注册）＋ 考点 2/3/4/7/8 的交叉约束'
            '（阈值联动、协议盲区、监控口径、差异回调）＋ §1.2 重试风暴的三层刹车'),
        language='markdown',
        rubric=[
            ('超时预算与取消传播', 2,
             '必须给出"逐跳预算小于端到端目标并留收口余量"的切法（例：120+120+160+160+240=800 里'
             '最慢一跳要能被上游提前放弃），并明确链路已用时由调用方随请求头携带、'
             '框架未内置该判据时要自己注册按剩余预算裁决的组件；'
             '答"每跳都设 1s 就行"或把连接超时与调用超时混为一谈给 0'),
            ('三阈值的大小关系与分时段取值', 2,
             '硬判据：重试停止用的错误率阈值必须小于服务粒度熔断阈值（否则重试统计先撞熔断），'
             '限流阈值高于熔断所保护的容量；要给出低峰/高峰两套数并解释 '
             'MinSample 太小会让低峰期一次抖动就熔断、太大会让高峰期熔断长期不生效'),
            ('重试放大倍数与刹车', 2,
             '要能算出最坏放大倍数（单跳最多 1+2=3 次尝试 ⇒ 相邻两跳各自重试时下游收到 9 次）'
             '并点名至少三层刹车：单次累计耗时上限、ChainStop 不级联、重试占比阈值低于熔断阈值；'
             '再加分：RetrySameNode 默认 false 只防同实例不防同服务、流式接口不支持重试'),
            ('协议盲区的兜底', 1,
             '要指出该协议的 QPS 限流对 gRPC 不生效这一硬边界，并给出兜底位置（网关/服务端/连接数维度）；'
             '必须回答"兜底件自己失效时放行还是拒"并给理由；只会说"那就在网关限"不给盲区理由给 0'),
            ('降级曲线与响应契约', 2,
             '必须解释"监控默认按原始结果上报"⇒ 业务成功率可以因降级而虚高，'
             '并给出三条独立曲线（业务成功率 / RPC 成功率 / 降级触发率）与告警优先级；'
             '要写清降级响应带来源与数据新鲜度标记、对账与计费类下游禁止消费该字段；'
             '把"降级后错误率下降"当成果直接给 0'),
            ('热更原子生效与坏配置拦截', 1,
             '要包含：下发前的 schema 与取值域校验、按版本比对只对差异回调、'
             '读侧原子切换（不是原地改共享结构）、比例灰度 + 以降级率或错误率为回退判据；'
             '并明确降级逻辑涉及业务代码只能发布、不能热开关'),
        ],
        notes=SUBJ_NOTES_INFRA,
        estimatedMinutes=45,
        answer="""## 参考要点

**1. 预算与传播。** 端到端 800ms 不是"每跳 800ms"。切法要显式留三块：
最慢一跳的份额、收口与序列化的固定开销、以及**上游提前放弃的余量**（下游还在跑但上游已经不听了）。
"链路已用时"这个信息**只能由调用方携带**：入口生成 `deadline`（或起始时间戳 + 预算），
逐跳透传，每跳在发起前用 `剩余预算` 与 `单次 RPC 超时` 取小值。
框架没有内置这个判据（按链路剩余预算决定是否重试的策略要业务自己注册），
所以要自己实现两件事：① 一个从请求上下文取 `deadline` 的中间件；② 一个 `shouldRetry` 判定，
剩余预算小于"一次有意义的尝试"就返回放弃原因码，而不是硬超时。
**哪一跳该放弃**：幂等性未知或非幂等的写跳永不重试；
下游是"可降级读"（推荐位、封面、评论数）时该放弃并走兜底；
只有"这跳失败会让整条链路无意义"的关键依赖才值得把预算给它。

**2. 三阈值必须联动，不能各配各的。**
大小关系（这是本题唯一的硬判据）：
`重试停止用的错误率阈值 < 服务粒度熔断阈值`。
原因很机械：重试会把下游异常在**调用方统计里摊薄**（第一次失败、第二次成功），
如果重试阈值不低于熔断阈值，重试统计会先撞线，
于是"该熔断的服务没熔断，先被限住的是重试"，保护对象错位。
限流阈值则由容量决定：它要**高于**熔断所保护的异常水位（否则正常抖动被当成攻击限掉），
又低于压测出的单实例上限 × 实例数。
分时段：低峰样本天然少，`MinSample` 取大了熔断长期不生效、取小了误熔断 ——
正解是**低峰抬高样本门槛并降低阈值敏感度**（或按 QPS 归一化窗口），
高峰把阈值调紧。文档默认是错误率 0.5 / 样本 200，而"样本不足 200 时配置不生效"
这句就是低峰期"你以为开了熔断其实没开"的官方解释。

**3. 重试放大与刹车。**
单跳最坏尝试次数 = `1 + MaxRetryTimes`，默认即 1 + 2 = 3 次。
**链路放大是相乘的**：如果 A 和 B 各自配了重试 2 次，
一次用户请求最坏会让 D 收到 9 个请求。这条账是senior 与背题者的分水岭。
`ChainStop`（上游是重试请求则本跳不再重试）把它从"每跳相乘"降为"链路上最多一跳在重试"，
也就是 9 → 3；这一削减要能自己估出来。
其余刹车：单次累计耗时上限（必须 > 单次超时，且不超过 `RPCTimeout × (MaxRetryTimes+1)`）、
重试占比阈值低于熔断阈值、退避（Fixed/Random）、`RetrySameNode` 默认 false（换实例而非砸同一台）。
两个必须点名的边界：**流式接口不支持重试**；重试不改变幂等要求 ——
非幂等写要先补幂等键（唯一请求号 + 去重窗口），否则"重试安全"是幻觉。

**4. 协议盲区。** 服务端 QPS 限流只对部分协议生效，跨协议那一路是漏的。
兜底分三层：① 入口网关按**全局 QPS/并发**限（不依赖被调框架的协议支持）；
② 服务端把**连接数**维度用起来（这个维度不受协议限制，是最便宜的兜底）；
③ 该路径自己按 HTTP/2 流控窗口压住单连接内存与在途请求。
谁 protect 谁：网关 protect 服务进程不被打爆，连接数配额 protect 单机内存，
QPS 桶 protect 下游依赖容量。
**兜底件自己失效时**：这是【推】要考的判断 ——
限流器不可用时"放行"会把故障放大成雪崩，"全拒"会把可用率归零；
正解是**退到本地静态配额**（预先算好的保守值，不依赖外部配置），
并把"退到静态值"本身当一个告警事件，而不是一个静默分支。

**5. 降级的可观测。** 上周"成功率没掉"的原因就在框架语义里：
降级可以直接返回成功的 Resp，而**监控默认仍按原始结果上报**（可配置成按降级结果上报）。
也就是说，要么指标口径被污染、要么刻意保留了原始失败 —— 两者必居其一。
三条独立曲线：
① **业务成功率**（用户视角，含降级兜住的）；② **RPC 成功率**（框架视角，含被降级掩盖的失败）；
③ **降级触发率**（一等 SLO，配错误预算，超阈值自动回滚发布）。
告警优先级：② 与 ③ 的差值（= 掩盖率）优先，因为它代表"系统正在骗人"。
响应契约：降级响应必须带 `degraded` 标记、降级来源、**数据新鲜度/版本时间戳**；
对账、计费、风控、报表这类下游**禁止消费降级数据**（宁可缺一天，不可错一天），
并在消费侧写死断言：`degraded=true` 的行不进结算，进 `unreconciled` 桶。

**6. 热更的原子性与坏配置。** 三道闸：
① **下发前校验**：schema + 取值域（阈值 0 明显非法，域外直接拒绝生效并告警）；
② **生效方式**：构造**新对象**再原子换指针，绝不原地改共享 map
（开源配置组件的语义是"比对两版差异、只有差异才回调"，回调里改什么由你负责 ——
原地改会让并发读看到撕裂状态）；
③ **比例灰度 + 自动回退**：先放 1% 实例，观察窗口内降级率/错误率/p99 超阈值 ⇒
回退到上一版本并锁住自动下发。
**不能靠热改的**：降级逻辑（涉及业务代码，框架侧明确只支持代码配置）⇒
必须走发布，所以"降级开关"要设计成"代码里预先埋好、配置只决定比例与白名单"。
顺带一条易被忽略的：超时优先级里请求粒度 > 客户端选项 > 动态 provider，
**临时压测留下的请求粒度超时会让动态下发看起来"不生效"**，排查要先看有没有更高优先级的来源。

**7. 主动关掉什么。** 合格答案要"关掉一件 + 说代价"，例如：
关掉一致性哈希（扩缩容时迁移放大、本地缓存集体失效），代价是缓存命中率下降、要预热；
或关掉按 method 的细粒度限流（要拿到 method 就得在解码后限，反序列化开销换隔离性），
代价是大流量方法挤占小流量方法；或把 Backup Request 关掉
（它优化的是尾分位，代价是下游负载整体抬高）。
指标示例：下游过载导致的故障数/分钟、重试流量占比、降级触发率、
**以及"被降级掩盖的失败率 = RPC 失败率 − 业务失败率"**（这个数最能证明治理体系没有自欺）。

**常见错法**：把治理说成"开个开关"；三个阈值之间没有大小关系；
只说"重试三次熔断一半"而算不出放大倍数；答不出协议盲区；
用"降级之后错误率下降了"当成果；热更改成原地写 map；全程不提幂等；
给不出任何一个可量化指标；把 DDL/剩余预算传播当成框架自带能力。""",
    )


@draft('sys-bd-live-stream-capacity-and-guardrails')
def q_sys_live_capacity():
    statement = """## 角色与时长

你正在面试**字节跳动 直播与 IM 平台研发（服务端方向）的 Senior**，35 分钟。
题目只有一个场景：**头部主播开播后的前 5 分钟**。

## 可核查事实（来自公开云产品的功能特性文档，是"被产品化的能力"，不要质疑出处）

- **推流域名与拉流域名分离管理**，且支持修改二者关联关系；Web 拉流支持 **FLV / HLS / RTM**；
  `RTMPS` 推流用于解决 `RTMP` 明文推流的安全问题。
- **配额与限流是产品能力**："限额管理：支持管理**推流路数限额**和**拉流带宽限额**，
  支持配置**限额告警阈值**"。
- 安全件：推拉流 **URL 鉴权（自定义鉴权 Key）**、**IP 黑白名单**、**Referer 防盗链**、
  **HTTPS 安全加速**。
- **流控是运维动作**："流管理：支持查询在线流、禁推流、历史流和流状态。
  支持对直播流执行**禁播、复播和断开**操作"；另有"**截图审核**（按设定频率截图并审核，
  用于发现违规内容）"与 DRM / HLS 标准加密。
- **官方降级件**："**直播垫片**：支持在直播断流时自动切换至指定素材或最后一帧画面"、
  "**直播轮播**：支持配置多路直播流按顺序自动播放"、
  "**直播时移**：支持在直播流进行中回放任意时间的视频内容"、
  "**拉流转推**：支持拉取直播流或点播视频，并转推到您指定的目标地址"、
  "**云端混流**：支持将直播流、点播视频和图片等输入源重新布局混流后输出"。
- 转码边界："**视频超分：支持从 720x576 到 7680x4320 连续可调**"、码率控制 CBR/ABR、
  HDR10/HLG、色域 BT.601/709/2020、8/10bit、H.264/265/266 标准转码 + "极智超清/画质增强"。
- 服务端治理侧可交叉引用的硬事实：限流是**两个维度**（连接数与 QPS），
  降级"可能直接返回成功的 Resp……所以监控默认以原来的结果上报"。

## 现场（**数字全部是出题假设**，请当假设并说明你如何测量与验证）

某头部主播开播，粉丝推送后并发拉流人数在 3 分钟内冲到假设 **20 万**，
主推流码率假设 4Mbps、拉流侧三档清晰度（假设 800k / 1.5M / 4M）。
第 4 分钟，**源站回源带宽打满**，同时收到一条内容违规举报（截图审核命中标记）。
你手上的控制面只有：路数限额、带宽限额与各自告警阈值、URL 鉴权 Key、禁推/禁播/复播/断开、
垫片/轮播/时移/拉流转推/云端混流。

## 请回答（六问，逐条作答）

1. **两条限额分别保护谁**：推流路数限额与拉流带宽限额各自护的是哪一段、
   谁该先撞线？告警阈值怎么定（给出你的算法，不是"设 80%"）？
2. **鉴权与配额的位置**：签名 URL 的有效期长短与"被刷"的关系？
   拉流配额应该在**边缘**判还是**源站**判，各自的漏点是什么？
3. **断流兜底**：垫片 / 轮播 / 时移 / 拉流转推 / 云端混流 ——
   逐一说明适用场景与代价；并回答"播了一段垫片的用户算不算一次成功播放"，
   这个数进了哪个指标会被谁误用？
4. **违规处置的三个动作**："禁播""断开""禁推"语义差别是什么？
   举报命中到执行动作之间你要卡什么（误伤成本、复核、可撤销路径、留证）？
5. **配额服务自己挂了**：放行还是限？给出你的决策与补偿（软配额/硬配额两条线怎么分）。
6. **三刀成本**：清晰度档位、超分/HDR 转码、回源带宽 —— 各砍什么、
   用什么证据证明"砍掉的那部分真没人看"，副作用是什么。

## 约束

素材明确写了：**抖音直播/连麦的端到端延迟数字与内部架构没有可核查来源**，
所以本题不许引用任何延迟毫秒数、机器数、并发量官方值；上面所有数字都是假设。
点名"要用哪个标准件"是得分项，编"我们内部怎么实现的"是扣分项。"""

    return base(
        'system-design', 'senior',
        '头部主播开播 5 分钟：路数与带宽两条限额、垫片与禁播，以及配额服务自己挂了',
        statement, 'llm-rubric',
        ['live-streaming', 'quota-and-limiting', 'degradation-standard-parts',
         'content-moderation-actions', 'cost-governance', 'modern:media-delivery'],
        src('直播与 IM 平台研发（服务端方向） 高级工程师',
            INFRA + '#4 考点 10（直播链路的分发、配额与降级标准件：推拉流域名分离、'
            '推流路数与拉流带宽限额＋告警阈值、禁推/禁播/复播/断开、垫片/轮播/时移/拉流转推/云端混流、'
            '截图审核、URL 鉴权与防盗链、转码与超分边界）＋ §1.6 ＋ §2 追问 11'
            '（"产品上各有什么标准件"）；交叉引用 #4 考点 3（连接数与 QPS 两个限流维度）'
            '与考点 7（降级后的监控口径污染）；成本数字全部标注为假设，依据 §7 第 1/8 条'),
        language='markdown',
        rubric=[
            ('两条限额的保护对象与告警算法', 2,
             '必须分开：路数限额护的是"源站/转码并发路数"这类**固定资源**，'
             '带宽限额护的是**分发出口**；要说清本场景先撞的是回源带宽而不是路数；'
             '告警阈值要给出算法（按增长斜率或提前量设阶梯，而不是单点百分比），'
             '并说明限额命中后的动作是什么（拒新、降级还是只告警）'),
            ('鉴权有效期与配额判定位置', 2,
             '要答出签名 URL 有效期是"被转发复用窗口"的长度，'
             '与配额/防盗链联动（有效期越长越容易被摘出来批量拉）；'
             '配额必须在边缘判（源站判等于已经打穿回源），'
             '并指出各自的漏点：边缘判会被"同一 URL 大量分发"绕过、源站判会先丢带宽'),
            ('五个标准件的适用与代价', 2,
             '垫片=断流时切素材/最后一帧（保可用性但内容不是直播）、轮播=多路流按序播（无人值守）、'
             '时移=回放任意时间点（可看但非实时，且要求时移切片链路健康）、'
             '拉流转推=把流搬到第三方目标地址（可搬走带宽但引入一跳）、'
             '云端混流=多输入源重排（贵、常用于连麦）；'
             '必须回答"垫片期间的播放不算一次有效的直播观看"，'
             '并指出它会被算进在线人数/时长这类经营指标 —— 要单独打降级标记'),
            ('三个处置动作的语义与留证', 2,
             '禁播=拦分发（流还在推，观众看不到，可复播）；断开=拆连接（主播侧会重连，'
             '不解决"重连后立刻复活"）；禁推=从入口拒绝推流（唯一能真正止血的，但误判后主播损失最大）；'
             '必须给出复核链路与可撤销路径、截图与规则版本留证，'
             '以及"按设定频率截图"意味着两次截图之间有违规空窗——处置粒度要对齐这个事实'),
            ('配额服务失效的取向', 1,
             '要区分软配额（超限只告警、不拒服务）与硬配额（超限拒），'
             '配额中心不可用时要退到本地静态配额而不是"全放"或"全拒"，'
             '并把这次退化当一个必须告警的事件；只答"放行/拒绝"二选一不给补偿的给 0'),
            ('三刀成本的证据链', 1,
             '每刀都要有"真没人看"的证据形态（档位播放分布、清晰度切换后回退率、'
             '回源命中与预取浪费），并说副作用（砍档位伤弱网体验、砍超分伤大屏、'
             '砍回源冗余抬高首帧失败率）；不许出现"下线老任务"这种无证据答案'),
        ],
        notes='素材明确：抖音直播的端到端延迟与内部架构无可核查来源（§7 第 8 条），'
              '所以任何"延迟多少毫秒""多少机器"的断言都属编造，在标准件与证据两项直接降档。'
              '能点名官方标准件名称并说清代价是本题的天花板。',
        estimatedMinutes=35,
        answer="""## 参考要点

**1. 两条限额是两个不同的资源。**
路数限额护的是**并发处理槽位**（源站接纳、转码实例、录制任务数），它是"个数"，
超了就只能拒新推；带宽限额护的是**分发出口与回源管道**，它是"体积"，
超了会表现为首帧失败与卡顿而不是"拒绝"。本场景先撞的是回源带宽：
20 万并发 × 主推 4Mbps ≈ 800 Gbps 量级的原始流需求，
而源站回源带宽是**未预热的单点**，路数反而远未用满。
告警阈值不该是"80% 一个数"，而是**阶梯 + 斜率**：
① 提前量（开播瞬时斜率超阈值就在到达限额前 60 秒触发预案，因为带宽类故障从"满"到"雪崩"极快）；
② 命中后的动作要分级（先降级清晰度 ⇒ 再限新增观众 ⇒ 最后拒推流），
限额本身要能区分"只告警"和"会拒"。

**2. 鉴权与配额的位置。**
签名 URL 的有效期是**风险窗口**：有效期越长，被摘出来转卖/被脚本批量拉的收益越高，
而配额被打爆的形态正是"同一批 URL 被少数 IP 高频复用"。
所以有效期要按业务能接受的最短来定，并和 IP/Referer 黑名单、HTTPS 加速一起用。
配额判定**必须在边缘**：源站判意味着流量已经穿过回源链路，带宽已经被打满，
限流变成"事后统计"。
两侧漏点要能自己补：边缘判的漏洞是"URL 被分发出去后从别处拉"（要靠鉴权 + 单会话并发数），
源站判的漏洞是"根本来不及"（只能作为最后一道粗粒度闸门）。
交叉引用：服务端限流的两个维度在这里同样成立 —— 带宽是 QPS 类（请求速率），
**连接数是并发类**，直播拉流的实际压力更多在并发连接，只限速率会漏。

**3. 五个标准件各有各的"不是"**。
垫片：断流时自动切指定素材或最后一帧 —— 保的是**不黑屏**，代价是画面不是直播内容，
必须有明显标识，否则用户以为还在直播。
轮播：多路流按序自动播 —— 适合无人值守时段，不适合"主播还在讲只是链路断了"（会把人引到错内容）。
时移：能看任意时间点 —— 依赖时移切片链路健康，断流时切片也可能断，**不要把时移当实时兜底**。
拉流转推：可以把流搬到第三方目标地址 —— 能搬走带宽压力，但多一跳且受目标地址侧限额约束。
云端混流：多输入源重排输出 —— 连麦/多机位才值这个钱。
**口径污染**（这题的分水岭）：垫片期间用户确实"在播放"，
如果它被计入"直播观看人数/人均观看时长"，运营大盘会在故障期间显示"一切正常" ——
这与框架侧"Fallback 后直接返回成功的 Resp，监控默认按原始结果上报"是同一类陷阱。
正解：播放事件带 `source=live|pad|replay|carousel` 与新鲜度字段，
经营指标只统计 `live`，垫片量单独做成**降级触发率**类指标并参与告警。

**4. 三个动作是三种语义。**
禁播 = 拦分发（源流仍在推，观众看不到，可"复播"立即恢复）；
断开 = 拆掉现有连接（主播端会自动重连，单独用等于只创造了一次黑屏）；
禁推 = 在接纳入口拒绝该流（唯一真正止血，但对主播是"下播"级后果，误判代价最高）。
因此处置要按"证据强度 → 动作强度"映射：
单次模型命中标记 ⇒ 只禁播 + 加人工队列；人工确认 + 规则版本一致 ⇒ 才允许禁推；
所有动作都要有可撤销路径（复播/解除禁推）与**留证包**（命中的截图序号与频率、
规则版本、时间窗、操作人）——"按设定频率截图"意味着两次截图之间有违规空窗，
所以处置粒度必须写成"以最近一次命中截图为准"，不能宣称"零延迟发现"。

**5. 配额服务自己挂了。** 这题没有标准答案，只有取舍有没有想清楚。
软配额（只告警不拒）与硬配额（会拒）要分两条线：**准入类走硬**（会直接打穿资源的），
**已建会话类走软**（把正在看的人踢掉，代价高于收益）。
配额中心不可用时的正确动作是**退到本地静态配额**（预先按峰值算好的保守值），
并把这次退化本身做成高优告警 —— 既不能"全放"（放大故障），也不能"全拒"（自己制造事故）。
只答二选一、或答"重试三次"都是没想过失效路径。

**6. 三刀成本。**
① 清晰度档位：证据是**档位播放分布 + 切换行为**（有多少人真用过 4M 档、
切上去之后是否回退）；砍掉低使用档的副作用是弱网/大屏体验分化，
要配"按端与网络自动降级"的兜底并监控首帧失败率。
② 超分/HDR 转码：文档给了"720x576 到 7680x4320 连续可调"这种**能力边界**，
但能力不是理由 —— 要为每条增强链路绑定"服务了多少播放占比"，占比与成本不匹配就关。
③ 回源带宽：证据是回源命中率与预取浪费（预取了但没人拉），
副作用是首帧失败率上升，所以这刀要和垫片一起评估，不能只算带宽。
**共同的坏答案**："下线老任务"。素材里另一条口径同样适用：
成本治理的刀法要按**真实消费量**（下游引用/播放分布）来，而不是按采集或部署量。

**常见错法**：把两条限额当成一个数字；说"源站限流就够了"；
把垫片算成正常播放并在大盘上报告"成功率没有下降"；
用"断开"当止血（会立刻重连）或对单次模型命中就禁推；
配额中心失效时只答"放行"或"全拒"；砍成本时给不出"真没人看"的证据形态；
以及最危险的一条 —— 编一个官方延迟毫秒数。""",
    )


@draft('sys-bd-feed-fanout-cost-model')
def q_sys_feed_fanout():
    statement = """## 角色与时长

你正在面试**字节跳动 内容平台 / 社区方向的 Senior（principal 轮）**，45 分钟。
题目是那个被问烂的"Feed 流怎么设计"，但这一轮**不许背名词**，只算三件事：
**成本在哪、上限在哪、怎么证明没漏。**

## 关于出处的诚实声明（先读这段）

素材里明确写了：**没有找到任何字节官方（博客/论文/开源仓库）对抖音或 TikTok Feed
存储模型（收件箱、推拉结合、大 V 例外策略）的实现描述**，
所以"字节用的是写扩散/读扩散/推拉结合"这类句子**在本场面试里一律算编造**。
本题只给你三块**可核查的地基**，其余全部要求你**自己推导并标明是推断**：

1. 消息语义（公开云产品文档原文）：**集群消费**——"同一 Topic 的消息只需被集群内的
   任意一个消费者处理……每条消息仅被消费一次"；**广播消费**——"同一 Topic 的消息会被
   所有订阅的消费者都消费一次……每条消息会被消费多次"。
   位点被拆成三种：`MaxOffset`（分区总数）、`MinOffset`（起始）、`ConsumerOffset`（已消费条数）。
   顺序消息分**全局顺序**与**分区顺序（局部顺序）**；事务消息保证"分布式事务数据的最终一致性"；
   死信的定义是"达到最大重试次数后消费依然失败"，且**订阅关系创建时自动创建死信队列**；
   延时消息"支持自定义毫秒级延迟，延迟时长最长为 3 天或消息保留时长的 3 倍（两者取较小值）"。
2. RPC 侧存在 **`Oneway` 消息类型**（发完即返回，不等响应）。
3. 服务端限流是**两个维度**：连接数与 QPS（默认令牌桶 + 计数器）。

## 现场参数（**全部是出题假设**，请当假设并说明你缺哪个数据）

- 日发帖量假设 2000 万条；其中**大 V（粉丝 ≥ 100 万）贡献的发帖占 0.5%**，
  但被阅读次数占假设 60%。
- 长尾用户粉丝数中位数假设 12，P99 假设 3000。
- 读写比假设 20:1（每条"发布"对应 20 次首页刷新）。
- 首页只展示**最近 500 条**可下滑内容，更早的内容要求用户主动翻页。
- 关注关系基本不变（取关率很低），但**作者可以删帖、可以被封禁**。

## 请设计（六问，逐条作答）

1. **成本方程**：把"写扩散 / 读扩散 / 推拉结合"三者的成本项分别写成式子
   （明确每一项的含义与单位），然后用上面的假设量出三者的**量级**，
   并指出你的推导里**最脆弱的那个假设**是什么、怎么测。
2. **混合线的判据**：在粉丝数分布与读写比已知时，"哪些作者走写、哪些走读"的分界线怎么定？
   分界线本身要不要随时间变？给出你的算法与它的失效场景。
3. **截断的读延迟账**：收件箱只留 500 条 ⇒ 翻页要合并 N 路"在线拉取"。
   写出这一页的延迟构成（扇出度、每路取多少、合并代价），并给出"第 5 页明显变慢"的
   **两种以上**解释与区分方法。
4. **怎么证明没漏**：推拉结合下，"某条内容本该进某个用户的首页但没有"是最难的故障。
   给出你的不变量（不许只说"加对账任务"）：序号/位点怎么用、
   **堆积**如何从"队列长度"这种笼统说法改成可计算的量、漏推率怎么做成 SLI、
   死信与补拉怎么闭环。并说明 `Oneway` 在这里为什么是个陷阱。
5. **扇出通路的过载保护**：大 V 开播/发帖的瞬时洪峰最先打爆谁？
   限流该选**连接数**还是 **QPS** 维度、限谁不限谁？
   慢消费者（一个下游订阅组一直追不上）怎么隔离而不影响别人？
6. **降级与撤稿**：给出高峰与低峰两套降级形态；
   以及"作者删帖 / 作者被封"时，**已经写进几千万个收件箱**的那条怎么撤
   （墓碑、版本、黑名单过滤各自的代价与一致性窗口）。

## 评分时特别注意

- 你的每一条结论后面**必须能挂上一块可核查地基**，或者明确写"这是我的推断"。
- 出现"字节内部用的是 X 模型"这类句子，直接按编造处理。"""

    return base(
        'system-design', 'principal',
        '大 V 发帖那 30 秒：推拉结合的成本方程、收件箱截断的读延迟账，以及"少推了"怎么被发现',
        statement, 'llm-rubric',
        ['feed-fanout', 'push-pull-hybrid', 'cost-equation', 'offset-based-reconciliation',
         'tombstone-and-retract', 'modern:foundation-models'],
        src('内容平台 / 社区方向 首席工程师候选（Feed 与扇出）',
            INFRA + '#4 考点 12（Feed 流推拉模型与扩散成本：主体标【推】，'
            '可核查地基只有 Oneway、服务端连接数/QPS 双维度、广播/集群两种消费语义与三类位点；'
            '得分点是"成本方程 + 混合线判据 + 收件箱上限的降级形态"）'
            '＋ #4 考点 11（消息投递语义与扇出可观测：集群 vs 广播、三类位点=堆积定义、'
            '分区顺序、死信自动建队列、延时消息上限）＋ §1.5 ＋ §7 第 2 条'
            '（Feed 推拉实现没有官方来源 ⇒ 题面显式要求标注推断）'),
        language='markdown',
        rubric=[
            ('成本方程的项与量级', 3,
             '必须写出至少：写扩散 ≈ 日发帖 × 粉丝数 × 单条写放大（+ 存储副本系数）、'
             '读扩散 ≈ 日刷新次数 × 关注数（扇出度）× 单次合并代价、'
             '推拉结合 = 大 V 走读 + 长尾走写的加权和；要用假设量级算出"长尾走写、大 V 走读"'
             '的相对大小并指出最脆弱假设（粉丝分布长尾/读写比），给测量方法；'
             '只写"读扩散省存储、写扩散省延迟"不给式子与量级的最多给 1 分'),
            ('混合线判据与其失效', 2,
             '判据要能算：在粉丝数 f、读写比 r 下比较"每次发布的写成本 f×w"与'
             '"每次读的聚合成本 n×c×r 分摊"，交点即分界；要说明它必须随粉丝增长/衰减与'
             '读写比漂移而**重新划分**，并给出迁移期的双写/双读窗口；'
             '失效场景至少一个（分界线附近反复跨界造成抖动 ⇒ 需要滞回区间）'),
            ('截断读路径的延迟账', 1,
             '要拆出扇出度、每路取多少、归并/去重代价、尾延迟由最慢一路决定（扇出越多 P99 越差），'
             '并给出"第 5 页变慢"的两种以上解释（在线合并扇出过大 / 冷数据在远端存储或缓存已淘汰 / '
             '被截断后需要回源关注关系）与区分方法（分段计时 + 每路返回条数与耗时分布）'),
            ('漏推的不变量与可计算堆积', 2,
             '必须回答：给每个 (作者, 粉丝) 的投递流一个**单调序号**，粉丝侧留"已收到的最大连续序号"'
             '（水位线），缺口=期望序号−水位线，而不是"队列长度"；'
             '堆积要用三类位点定义成 `MaxOffset − ConsumerOffset` 并给出追赶速率（ETA）；'
             '漏推率作为 SLI；死信队列要能回流补拉并有幂等键（同一 msgId 不重复入收件箱）；'
             '点名 Oneway 的陷阱（发完即返回 ⇒ 服务端根本没机会知道丢没丢，只能靠序号/位点事后证明）'),
            ('扇出洪峰的保护与慢消费者隔离', 1,
             '要说清最先打爆的是**扇出生产者与写收件箱的存储**（不是读路径），'
             '限流维度选择要给理由（写扩散的瓶颈是并发写连接与批量写速率 ⇒ 两个维度都要，'
             '只限 QPS 会漏）；慢消费者隔离=独立订阅组/独立队列与配额、'
             '把它踢到重放通道而不是共享重试；并说明"广播 vs 集群"语义下重复与缺失的根因差异'),
            ('降级两套与撤稿语义', 1,
             '高峰降级要写"收件箱不够新就只发缓存版本 + 关闭翻页在线合并 + 首页退化为热度流"，'
             '低峰走全量重建；撤稿要给**双层**：短窗口用黑名单/版本墓碑在读路径过滤（秒级生效），'
             '长窗口用异步清理（并明确一致性窗口有多长、期间用户可能仍看到）；'
             '只答"删掉那 500 万条"而不谈窗口与代价的给 0'),
        ],
        notes='本题主体是【推】：素材明确写了字节没有任何公开的 Feed 推拉实现描述，'
              '因此评分只看推导链条与成本方程是否自洽、是否把结论挂回三块可核查地基。'
              '出现"字节官方用 X 模型"的断言，在"漏推不变量"与"成本方程"两项直接给 0 并整体降档。'
              '所有量级都是出题假设，候选人主动指出缺哪个数据并给测法算加分。',
        estimatedMinutes=45,
        answer="""## 参考要点

**先说这题的正确姿势。** 官方从没说过抖音 Feed 用什么模型，所以**能得分的答案一定是
"从成本推导出来的选择"，而不是"某个知名实现"**。三块地基的作用就是把推导钉住：
广播/集群语义决定"谁负责复制消息"，三类位点决定"堆积和追赶怎么算"，
`Oneway` 与服务端双维度限流决定"扇出通路的失败形态"。

**1. 成本方程。**
- 写扩散（发一条 ⇒ 往每个粉丝收件箱写一行）：
  `写成本 ≈ Σ_作者 粉丝数 × 每条写放大`，存储 `≈ 写成本 × 副本系数`；
  **它的钱花在"长尾作者的每条帖子也要复制几百万次"上，与有没有人看无关。**
  用假设量级看：普通用户发帖 × 中位粉丝 12 ⇒ 便宜；
  大 V 发帖 2000万 × 0.5% = 10 万条，每条复制 100 万+ ⇒ 单这一项就是 10^11 量级写放大，
  占掉日发帖总写量的绝大部分（这就是"大 V 不能写扩散"的算术理由）。
- 读扩散（打开首页 ⇒ 现拉 N 个关注对象的发件箱做归并）：
  `读成本 ≈ 日刷新次数 × 关注数（扇出度）× 单次归并代价`；
  存储几乎为零，但**尾延迟由最慢的一路决定**，扇出度越大越惨。
  读写比 20:1 意味着每次发布的复制成本要被 20 次读分摊 —— 比值越小越偏读、越大越偏写。
- 推拉结合 = 大 V 走读（订阅式在线合并 + 预热热门帖）+ 长尾走写（收件箱直投），
  代价是**两条读路径 + 一份合并**，复杂度是这项选择的真实成本，不是"免费的最优"。
- 最脆弱的假设：粉丝数分布（P99 与头部集中度），其次是读写比。
  测法：取关注关系直方图 + 首页请求日志算真实的"每条发布被多少次刷新读到"，
  而不是拍一个 20:1。

**2. 混合线。** 令某作者每次发布的粉丝复制成本 `f × w`、
在线合并的分摊成本 `r × c_f`（r=该作者的帖子被刷到的次数、c_f=每次读为它付出的合并代价），
分界就是 `f × w ≈ r × c_f`。用假设量级看：f > 10^5–10^6 且 r 不高的作者就该走读。
判据要**随时间重算**：账号涨粉、赛季性读写比变化、内容类型（视频/图文的合并代价不同）都会搬线。
失效场景：分界线附近的作者反复跨界 ⇒ 收件箱既有旧写入又有新拉取，出现重复与顺序错乱。
解法是**滞回区间 + 迁移窗口双写**（进入读模式后仍保留一段时间窗的写投递，读侧去重），
而不是"每周跑一次脚本重划分"。

**3. 截断的读延迟账。**
首页 500 条来自"本地收件箱 + 若干大 V 的在线拉取"，
翻页更深时本地已经空 ⇒ 扇出度上升、每路要取更多、归并内存变大。
延迟构成 = 关注关系读取 + 扇出到 K 路（取 max，不是取 avg）+ 归并去重 + 已读过滤 + 渲染。
"第 5 页明显变慢"的至少三种解释与区分：
① 在线合并扇出过大（证据：每路耗时分布右移、扇出度随页码增长）；
② 冷数据淘汰（证据：本地收件箱只留 500 条，深页必须回源；看回源命中率与远端读延迟）；
③ 已读/去重集合变大（证据：过滤阶段耗时与集合大小随页码上升，归并 CPU 占比升高）；
④ 被截断后需要重新读关注关系（证据：关注关系读 QPS 与页码相关）。
**没有分段计时的答案是背题**——这题考的就是会不会把"慢"拆成可归因的几段。

**4. 怎么证明没漏（本题天花板）。**
"队列长度"不可计算，必须换成**序号 + 水位线**：
给每个 `(作者, 粉丝)` 投递流（或每个粉丝的收件箱写入流）一个单调递增序号，
粉丝侧记录"**已收到的最大连续序号**"（水位线，不是最大值！），
缺口 = 期望序号 − 水位线，缺口存在即"漏推"，缺口持续时间即 SLI。
为什么不能用最大值：乱序与重试会让最大值跳过去，把真实的洞盖住。
生产者侧堆积按定义就是 `MaxOffset − ConsumerOffset`，
再配**追赶速率**（单位时间消化量）才能得到 ETA，光有堆积量没法定级。
死信要能回流：素材里的语义是"达最大重试次数后仍失败"才落死信、
且订阅关系创建时自动建死信队列 ⇒ 补拉要有幂等键（`msgId + 收件箱代次`），
否则重放会造成重复。
**`Oneway` 的陷阱**：发完即返回意味着调用方**没有失败信号可用**，
"没报错"不等于"投递成功"，所以一切正确性只能靠事后不变量（序号/水位线）证明 ——
这也是选 `Oneway` 前必须配套对账的原因。
顺序维度也要说清：分区顺序只在**同一分区内 FIFO**，跨分区不保证，
所以"按时间倒序的首页"不能用消息顺序保证，只能在读侧按发布时间重排。

**5. 扇出洪峰。** 最先打爆的不是读路径，而是**扇出生产者 + 收件箱写入存储**
（一条大 V 帖子要产生上百万次写）。所以保护顺序是：
先把大 V 帖子**从写扩散通路里摘出去**（改走读 + 预热），
再给扇出通路独立配额与削峰（分批写、可延后），
最后才是服务端限流兜底。
限流维度两个都要：写扩散的瓶颈常是**并发连接与批量写**（连接数维度）
与每秒写请求（QPS 维度）；只限 QPS 会漏掉"少量大请求把连接和内存吃满"这种形态。
慢消费者隔离：给每个下游订阅组独立队列/独立配额，
追不上时**把它踢到重放通道**（离线补数据）而不是让它占用共享重试预算；
并且要能区分"它真的在消费但慢"与"它没消费"——这正是三类位点能给的信息。
集群消费 vs 广播消费的语义差也要能点名：
集群消费是"每条只被集群内一个消费者处理"（复制由**平台**做），
广播消费是"每个订阅者都消费一次"（复制由**订阅方**做）——
扇出的"谁负责复制"这个问题，在消息层就有两种答案，选错了重试与幂等的归属就错了。

**6. 降级与撤稿。**
高峰降级：① 收件箱不够新 ⇒ 直接返回缓存版本并标注新鲜度；
② 关闭深页的在线合并（"只能往前翻 500 条"是产品可接受的降级，服务被打爆不是）；
③ 首页退化为热度/编辑流（读时聚合扇出降到常数）。
低峰走全量重建与顺序校准。
撤稿必须**双层**：
短窗口用**版本/黑名单过滤在读路径生效**（删帖号或作者封禁号进缓存，秒级不可见，
存储不动），长窗口用异步清理真正删数据；
一致性窗口要量化（缓存过期时间 + 过滤规则下发时间），并明确"这期间用户仍可能看到"是设计的一部分。
封禁作者要额外注意：**已进收件箱的历史内容**与"新发内容"是两条判定线
（前者由黑名单过滤，后者由准入拦截），只做一条会出现"封禁了但首页还在刷他的旧帖"。
"直接把 500 万行删掉"是坏答案：它把一次 O(1) 的语义变更变成一次 O(N) 的写风暴，
而且删完之前老数据仍然可能被读到。

**常见错法**：张口"写扩散，加机器就行"（算不出大 V 的 10^11 量级写放大）；
把"堆积"说成队列长度；用最大序号当水位线；
用消息顺序保证时间倒序；`Oneway` 用得很开心但没有对账；
撤稿只答"删掉"不谈一致性窗口；以及全程把推断说成官方实现。""",
    )


@draft('sys-bd-online-training-reliability-trade')
def q_sys_online_training():
    statement = """## 角色与时长

你正在面试**字节跳动 推荐数据平台 / 机器学习基础设施方向的 Senior**，40 分钟。
这一轮不问模型结构（那是另一件事），只问：**你敢不敢把"拿可靠性换实时性"这句话落成可运维的东西。**

## 可核查事实（来自公开论文与开源仓库，不要质疑出处）

- 这篇论文的问题陈述：通用深度学习框架"为推荐场景（动态稀疏特征）调优静态参数与稠密计算
  会损害模型质量"，且"batch-training stage and serving stage completely separated"，
  导致**模型无法实时接受用户反馈**。
- 它给出的三项设计：**collisionless embedding table（无冲突 embedding 表）**
  （"guarantees unique representation for different id features"），
  并用 **expirable embeddings（可过期）+ frequency filtering（低频过滤）** 控制内存；
  以及"production-ready online training architecture with **high fault-tolerance**"。
- 论文里有一句必须正面回答的原话：**"system reliability could be traded-off for real-time learning"**
  （系统可靠性可以拿来换实时学习）。
- 仓库 README：建立在 TensorFlow 之上，"supports **batch/real-time training and serving**"，
  实时训练用于"captures the latest hotspots"，并写明该框架"has successfully landed in the
  BytePlus Recommend product"。
- 上游数据侧的可核查事实：埋点采集有"**实时埋点检测**（实时检测、快速验证埋点是否正确及
  **数据上传情况**）"；消息链路的堆积由三类位点定义
  （`MaxOffset` / `MinOffset` / `ConsumerOffset`），死信的定义是
  "达到最大重试次数后消费依然失败"，且**订阅关系创建时自动创建死信队列**，
  延时消息"延迟时长最长为 3 天或消息保留时长的 3 倍（两者取较小值）"。
- 训练规模侧唯一可核查的数字（另一篇开源仓库）：通用分布式训练框架支持 TCP 或 RDMA，
  官方示例是"BERT-large 训练在 256 GPU 上达到 ~90% 扩展效率"。

## 素材明确列为**不可写**的内容（越线即按编造处理）

- 推荐模型的**结构**（双塔/序列建模/多目标融合权重）与**效果数字**：没有任何官方工程文档。
- 实时特征平台 / Feature Store 的**产品名与实现细节**：没有可核查文档。
- 任何"抖音内部日样本量 / 特征条数 / 线上指标提升"的数字。

## 现场参数（**全部是出题假设**，请当假设并说明你缺哪个数据）

在线打分服务与在线训练作业同集群部署。假设：日曝光样本 40 亿条、
行为回流到"能影响下一次打分"的目标延迟 P95 = 60 秒；
embedding 表常驻内存已到预算上限的 92%；每天做一次全量参数快照；
上游埋点 SDK 是**批量上报**（端上缓存后一次发出）。

## 请设计（六问，逐条作答）

1. **端到端延迟预算表**：从"用户做完一个动作"到"这个动作影响到的参数被下一次打分看见"，
   把链路拆成环节并给每个环节的预算。
   哪一个环节最容易被"看起来实时"骗过去？为什么"批量上报的 SDK"会让整条链的实时性变成假的？
2. **时点正确性与版本对齐**：一条训练样本要落地哪些字段才能事后复算？
   为什么"特征版本 + 参数版本 + 模型版本"三件缺一不可？
   在线取的是"打分时刻可见的特征值"，离线回填时按事件时间 join，
   这两件事在什么情况下会给出**不同**的样本（给出至少两种形态）。
3. **可靠性换实时性**：把论文那句话翻译成运维语言 ——
   你牺牲的到底是什么（用 RPO/RTO 说清）、故障后从哪个点恢复、
   样本流重放的幂等键放哪、死信与补采怎么闭环。
   **换到的收益怎么量化，代价由谁承担？**
4. **embedding 内存**：过期与低频过滤各自的副作用是什么？
   热点 item 被过期策略误杀后如何复活？过期策略与在线特征的时点正确性如何**对齐**
   （否则缺失率被谁放大）？
5. **评估口径**：在线训练之后"效果有没有变好"用什么口径判？
   离线指标涨、在线指标不涨时你先怀疑哪一环？
   为了防止标签泄漏，上线前必须有的自动化检查是什么？
6. **一条"不值得实时"的判据**（什么特征/什么业务用批式更好），
   以及一个你打算长期盯的、能证明这套在线链路真的在赚钱的指标。

## 约束

本题允许你引用上面论文/仓库的原句作为依据；
不许把机制说成"字节内部实现就是这样"，涉及未公开的部分请显式说"这是我的推断"。"""

    return base(
        'system-design', 'senior',
        '在线训练拿可靠性换实时性：延迟预算、参数版本对齐、故障恢复点，以及"换到了多少"要能算',
        statement, 'llm-rubric',
        ['online-learning', 'point-in-time-features', 'reliability-tradeoff',
         'embedding-memory-policy', 'training-serving-skew', 'modern:recommender-systems'],
        src('推荐数据平台 / 机器学习基础设施方向 高级工程师',
            DATA + '#4 考点 1（在线训练闭环与"可靠性换实时性"：设计在线训练链路——'
            '延迟预算、故障恢复、可回滚点、评估口径）＋ #4 考点 2（特征时点正确性与训练-服务一致性：'
            '"打分时刻可见值"与"按事件时间 join"、特征/模型版本落日志）'
            '＋ §1.1（论文三段论证与三项设计、"system reliability could be traded-off for '
            'real-time learning"、批/实时同一框架）＋ §2 追问 1/2/3'
            '（样本取哪个版本、牺牲什么怎么补、无冲突表如何避免 OOM）；'
            '跨端 #4 考点 11（三类位点/死信/延时上限）作为重放与补采的地基；'
            '模型结构与效果数字按 §7 第 1/3 条列为不可写项'),
        language='markdown',
        rubric=[
            ('延迟预算表与"假实时"识别', 2,
             '必须把链路拆开（端上缓存与批量上报 → 采集与校验 → 总线 → 明细/特征拼装 → '
             '样本 join → 在线训练参数更新 → 参数下发到打分服务），并指出'
             '"批量上报"与"参数下发周期"是两个最容易吞掉实时性的环节（前者让事件时间远早于到达时间、'
             '后者让训练再快也用不到）；给的是"端到端 P95 一个数"而没有分环节的最多 1 分'),
            ('三件版本缺一不可 + 两种不一致形态', 2,
             '要答出样本必须记事件时间与到达/落库时间、特征版本、参数（模型权重）版本、模型版本，'
             '并说明缺任一件都会让线上指标复算不出来；'
             '在线"打分时刻可见值"与离线"按事件时间 join"必须给出至少两种会不一致的形态'
             '（维表 SCD2 生效区间边界/迟到记录覆盖新值、晚到事件在离线被算进但在线当时不可见、'
             '特征过期策略把在线当时可见的值在离线补成缺失）'),
            ('可靠性换实时性的运维翻译', 3,
             '要落成具体机制：参数快照频率即 RPO、重放窗口长度与追赶速率即 RTO、'
             '重放幂等键（消息唯一键 + 参数代次）、死信回流与补采通道、'
             '节点失效后"从哪个版本重启才不破坏样本-参数一致性"；'
             '并且要正面回答"换到的收益怎么量化、代价谁承担"（实时性收益归业务方、'
             '一致性风险归平台方 ⇒ 必须写成可签署的 SLA/合同而不是口头）；'
             '只复述论文那句原话不给机制的给 0'),
            ('过期与频滤的副作用', 1,
             '要说出：过期会误杀"沉睡后复活的热 key"（需要预热/白名单/分级 TTL），'
             '低频过滤会让长尾 id 永远学不到（对新内容冷启动更差、伤害长尾而非头部）；'
             '并点出"特征过期策略与在线参数版本必须对齐，否则离线看到的缺失率被过期策略放大"'
             '——只答"加机器/加内存"视为没读过素材'),
            ('评估口径与防泄漏检查', 1,
             '在线训练后的判据必须是**同参数量级可比的离线口径 + 在线实验**两件事，'
             '且离线要用"当时可见特征"重放而不是用最新特征；'
             '离线涨在线不涨要先怀疑链路（特征不一致/版本错位/样本延迟/打分服务用的旧参数）'
             '而不是先怀疑模型；必须有自动化"未来信息检查"（特征时间戳晚于打分时刻即拦截）'),
            ('不值得实时的判据', 1,
             '合格答案给的是可计算判据（该特征的下游变化频率与观测窗内的信息增量、'
             '长周期标签如次日留存天然吃不到分钟级实时、实时链路的算力成本 > 折算收益），'
             '并给一个长期指标（例如"热点类 item 在曝光后 5 分钟内的转化率提升"或'
             '"参数代次与打分时刻特征代次的错配率"）；泛泛说"重要特征要实时"给 0'),
        ],
        notes='论文那句"用系统可靠性换实时学习"是本题唯一允许直接引用的"取舍声明"，'
              '候选人必须把它翻译成具体的 RPO/RTO、重放与幂等机制才算命中。'
              '出现模型结构、内部样本量、线上指标提升数字（素材 §7 第 1 条列为不可写）'
              '在"评估口径"项直接给 0 并整体降档。',
        estimatedMinutes=40,
        answer="""## 参考要点

**1. 延迟预算要按"信息什么时候真的可用"来拆。**
链路：① 端上采集与批量上报 → ② 接入与校验 → ③ 总线（位点） → ④ 明细落库/特征拼装 →
⑤ 曝光-行为 join 成样本 → ⑥ 在线训练消化并更新参数 → ⑦ **参数下发到打分服务** → ⑧ 下一次打分看见。
两头最容易被忽略：
- ① 是"假实时"的头号来源：SDK 批量上报意味着**事件时间**与**到达时间**之间有一个
  由端上策略决定的窗口（网络差、后台被杀、冷启动合并上报），
  这个窗口不可能靠"下游链路做到秒级"补回来。所以"60 秒 P95"必须是**按事件时间口径**统计的，
  按到达时间统计出来的数字是自欺。
- ⑦ 是另一半：在线训练每秒都在更新参数，但打分服务通常按周期拉参数版本 ——
  训练做到秒级、下发做到 10 分钟，端到端就是 10 分钟。
  **训练吞吐与参数新鲜度是两条独立的账**，只报前者是常见的偷换。
加分：把"实时性"定义成可运维的量（`事件时间 → 参数版本被线上服务加载` 的分布），
并给出每一段的监控与责任方。

**2. 样本要能复算，就得记全。**
必须落地的字段：事件时间、到达/落库时间、特征快照（或其可复原的引用 + **特征版本号**）、
**打分时用的参数版本（模型权重版本）与模型版本**、请求上下文（分流/实验组）。
三件版本缺一不可的原因很朴素：
"线上 AUC"是 `(模型版本, 参数版本, 特征版本) → 结果` 的函数，
少任何一维，你就无法把一次波动归因到"改了什么"。
素材里另一条同源：批与实时是**同一套框架的两种节奏**（batch/real-time training and serving），
所以差异不能靠两套代码消掉，只能靠"同一份定义 + 对拍"。
在线取"打分时刻可见值"与离线"按事件时间 join"**会不一致**的形态，至少要给出：
① 维表 SCD2 的**生效区间边界**：离线按 `事件时间 ∈ [valid_from, valid_to)` 命中新版本，
  而在线当时那条更新还没到 ⇒ 同一特征两个值；
② **迟到记录覆盖新值**：晚到的旧版本被当作最新写进维表 ⇒ 离线看到"修正后的事实"，
  在线当时看到的是被修正前的值（正确做法是"迟到不覆盖新值"并把差异分类记账）；
③ **过期策略不对称**：在线当时可见的值，离线重放时因为 embedding 已被过期/频滤清掉而变缺失 ⇒
  离线样本里凭空多出一批"缺失"，模型学到的分布和线上不一样。
④ 曝光与行为的时间窗错配：曝光日志 join 行为流时窗选宽了就会把**未来**的行为算进样本
（标签泄漏）。

**3. 把那句"换"翻译成运维语言（本题真正的分差）。**
- **牺牲什么**：牺牲的是"每条样本都被训练一次、每个参数更新都持久化"这两件事。
  在线训练为了低延迟通常**不把每次更新同步落盘**，于是故障时能回到的点是**上一次参数快照**
  ⇒ **RPO = 快照间隔**（假设每天一次 ⇒ 最坏丢一天在线学到的东西，
  这就是"用可靠性换实时性"的具体价格）。
  **RTO = 重放窗口能追上多少**，即从快照版本起，把这段时间的样本流重放一遍所需的时间；
  追赶速率由"重放吞吐 − 在线实时吞吐"决定，不是拍一个数。
- **恢复点必须与样本一致**：回到版本 `v` 就只能重放"`v` 之后产生、且当时特征版本 ≥ `v` 的样本"，
  否则会把两个参数代次的知识混进同一次训练。所以幂等键要含
  **参数代次**：`(样本唯一键, 基线参数版本)`，重放时同键不重复计入。
- **重放与补采**：位点模型给出可计算量 —— 堆积 = `MaxOffset − ConsumerOffset`，
  追赶 ETA = 堆积 / 净消费速率；重放要有预算上限（延时消息有硬边界：最长 3 天或保留时长 3 倍取小），
  **超出窗口的补不回来**，必须另走离线补采通道并给样本打"回填"标记。
  达最大重试次数仍失败的样本落死信（订阅关系创建时自动建死信队列），
  死信不是垃圾桶，是"待人工分类的漏样本池"。
- **收益怎么量化、代价谁承担**：收益用"热点内容在曝光后短窗内的转化提升"这类
  **能被实时性改变的**指标测（并且要用实验测，不是同比）；
  代价要落成**合同**：数据完整度 SLA + 故障时可接受的重建窗口（素材里那句
  "SLA 在线化申报与签署"正是这个意思）——
  否则"换多少"永远由平台方一个人背。
坏答案的典型：把在线训练说成"把批训练改成流式微调"。

**4. embedding 内存的三项设计各有各的账。**
无冲突表保证"不同 id 特征的唯一表达"，代价是内存随 id 基数线性增长 ⇒
所以才需要 **可过期 + 低频过滤** 两项来压：
- 过期的副作用：**沉睡后复活的热 key**（一夜爆起来的旧 item、周期性复播的直播）被清成空白，
  表现为"新 item 的 AUC 突然变差"。对策：分级 TTL（按访问热度分层）、
  复活预热通道、以及**过期前落盘**（冷参数可加载而不是从零学）。
- 低频过滤的副作用：长尾 id 永远学不到 ⇒ 对**新内容与长尾作者**伤害最大，
  这与"实时训练捕捉热点"的收益刚好是同一枚硬币的两面（它强于头部、弱于长尾）。
- 与特征侧对齐：在线特征的过期与 embedding 的过期必须是**同一套时间语义**，
  否则离线重放时看到的缺失率被过期策略放大（第 2 问的形态③）。

**5. 评估口径。**
- 离线复算必须用"**当时可见特征**"重放（snapshot 或 point-in-time join），
  用最新特征算出来的离线指标没有任何可比性。
- 在线判"变好"要走实验（进组口径与分母要与看板口径分开），
  **离线涨在线不涨时先怀疑链路而不是先怀疑模型**：
  训练-服务特征不一致 → 参数版本下发滞后 → 样本延迟与乱序 → 打分服务负载导致的降级读旧值。
  这四条要能按顺序排（每条都有自己的观测指标）。
- 上线前的自动化检查：把**未来信息检查**做进发布流水线
  （样本里任何特征时间戳晚于打分时刻 ⇒ 阻断），
  以及批/实时双路特征的**采样对拍 + 差异率阈值**（同一份定义两种节奏跑，超阈值不放行）。

**6. "不值得实时"的判据。**
可计算的形式：`该特征在观测窗内的信息增量 × 受影响流量价值 > 实时链路的单位算力成本 + 一致性风险成本`。
落地上最典型的两类：**长周期标签**（次日留存、7 日 GMV）天然吃不到分钟级更新，
强行在线训练只会引入噪声与泄漏风险；**低频变化的画像类特征**（注册城市、设备档位）
用日批即可，实时链路的价值应该留给"热点、库存、价格、短时行为计数"。
长期指标示例：`参数代次与打分时刻特征代次的错配率`、
`热点 item 从首次曝光到被模型认识的延迟分布`、`重放窗内漏样本率`。

**常见错法**：把在线训练说成"流式微调"；特征只谈 Redis 不谈时点；
说"可靠性可以让业务方担着"却给不出 RPO/RTO 与合同；
把 embedding 内存问题当"加机器"问题；用最新特征算离线指标来证明在线效果；
引用任何"内部日样本量/线上提升百分比"（素材明确列为无官方来源）。""",
    )


@draft('sys-bd-olap-disaggregation-migration')
def q_sys_olap_migration():
    statement = """## 角色与时长

你正在面试**字节跳动 数据研发（数仓 / OLAP 平台方向）的 Senior**，35 分钟。
场景：有人提了个提案 —— "我们那套列存 OLAP 太慢了，换成存算分离的就行，案例里成本降了 50%"。
**你的任务是把这个提案评审掉或者救活。**

## 可核查事实（来自开源云原生数仓的官方公告与文档，不要质疑出处）

- 演进动因（公告原文要点）：该团队 2018 年就在内部使用 ClickHouse；业务增长后
  **Shared-Nothing**（各节点独立、不共享存储）架构带来三类痛点：
  ① **扩缩容**："scaling the system incurred higher costs and involved **data migration**"，
  做不到实时按需伸缩、资源利用率低；
  ② **多租户 / 共享集群**：读写在同一节点上执行，"often **interfered with each other**,
  impacting overall performance"；
  ③ **性能**："support for complex queries, such as **multi-table join** operations,
  was not optimal"。
- 于是 2020 年内部立项改造，2023 年 1 月 Beta、5 月底开源；架构是**存算分离**
  （统一的全集群数据管理 + 分布式存储 ⇒ **计算节点无状态**），
  能力清单：弹性伸缩、读写分离、**租户资源隔离**、**读写数据强一致性**，
  并复用列存、向量化、MPP、查询优化、代码生成、索引、压缩等技术；
  场景定位为交互式查询、实时看板、实时数仓（另有行为日志分析与营销效果分析等列举）。
- 第三方落地案例（**注意：作者不是字节员工，是用户侧自述**）：
  该案例在生产环境**全量替换** ClickHouse 后"资源成本降低超 50%"；
  其 OLAP 平台是**双链路**："离线（DataX 把 Kafka 数据集成到 Hive 数仓，再生成 BI 报表，
  用 Superset 展示）+ 实时（GoSink→ClickHouse、CnchKafka→ByConity）"，
  功能含事件分析、转化分析、自定义留存、用户分群、行为流分析，需求里明确要
  "对小部分人群做 AB 实验"。
- 治理侧可交叉引用的公开模块清单：数据地图（收集展示**全链路元数据**）、
  数据标准（标准代码、**命名词典**、用于数仓数据表**字段元数据对标**、**标准监控统计**、
  "消除数据的不一致性"）、指标平台（维度建模、划分业务线/指标/数据模型、
  "**消除指标二义性，保证指标数据出口一致性**"）、数据质量（**探查 / 监控 / 对比**）、
  **SLA 在线化申报与签署**。
- 实时链路的投递语义（可交叉引用）：集群消费"每条消息仅被消费一次"、
  广播消费"每条消息会被消费多次"；顺序消息分全局顺序与**分区顺序**；
  事务消息保证"最终一致性"；死信=达最大重试次数仍失败；堆积由三类位点决定。

## 素材明确列为不可写的内容

公告与文档**没有**给出任何表数量、分区数、p95 查询延迟、成本账；
案例里的"成本降超 50%"是**用户自述**。所以：本题所有数字都是出题假设，
引用那个 50% 时必须注明它是用户侧自述、不能当你的预算依据。

## 现场参数（**出题假设**）

现网：单集群 24 个节点、共享同一份本地盘；最大的 3 张明细表按天分区，
单表日均新增假设 12 亿行；查询形态混杂 —— BI 看板的高频短聚合、
分析师的 ad-hoc 多表 join、以及给业务 API 用的点查。
症状：① 每次扩容要迁数据、当天不能完成；② 夜里批任务和白天看板互相拖慢；
③ 三条表一 join 就跑不完；④ 有一次实时看板和离线报表差了 3.4%，
结论是"延迟不一样所以正常"。

## 请给出（六问，逐条作答）

1. **可行性判据**：这个提案里的三类症状，哪些是 shared-nothing 的**结构性**问题、
   哪些换引擎也不会好？"我们的查询慢"要先分成哪三类原因再谈选型？
2. **赔掉的东西**：存算分离换来四项能力的同时至少会带来哪些新成本/新瓶颈？
   **每一项给一个可观测指标**（不许只说"会有延迟"）。
3. **影子跑与灰度**：给出你的迁移验证方案 —— 双写/双查怎么做、
   结果集比对要**归一**掉什么才算"等价"、放量判据、回滚点放在哪一层。
4. **成本账**：把成本拆开（存储、计算、缓存、扫描量、跨可用区/回源、compaction），
   说明"降 50%"要复现需要哪些最小证据集；为什么直接拿别人的百分比做预算是错的。
5. **双链路对账**：那 3.4% 的差异怎么归因？给出差异分类（至少四类）、
   **完整度门**的定义（放行判据不许是"任务成功"）、
   以及"谁是一次真相"应该怎么定 —— 注意集群消费与广播消费的语义差会让同一批数据
   在两条链路上天然不等。
6. **卡口与组织**：口径谁签字？"字段元数据对标"当上线闸意味着什么具体动作？
   SLA 签署带来的违约成本如何落进排班与预算？给出三条**机器可判**的卡口。

## 约束

不许把 ByConity 之外的任何内部系统名当事实引用；不许编内部量级。
把案例数字当"用户侧自述"来引用是加分，当"官方承诺"来引用是扣分。"""

    return base(
        'system-design', 'senior',
        '从 shared-nothing 列存迁到存算分离：换来什么、赔什么、影子跑怎么设计、双链路谁是一次真相',
        statement, 'llm-rubric',
        ['olap-architecture', 'disaggregated-storage', 'shadow-migration',
         'batch-stream-reconciliation', 'sla-as-contract', 'modern:cloud-native-dw'],
        src('数据研发（数仓 / OLAP 平台方向） 高级工程师',
            DATA + '#4 考点 6（OLAP 引擎演进：存算分离换到了什么、赔了什么；'
            '题面草稿建议"从 ClickHouse 迁到存算分离引擎的可行性与验证方案：'
            '影子跑、性能与成本基线、回滚点"）＋ §1.3（三类痛点原文与能力清单、'
            'MetaApp 案例及其"作者非字节员工"的限定）＋ #4 考点 9（离线/实时双链路对账与完整度：'
            '差异分类、完整度门、幂等重跑）＋ #4 考点 8（分层与治理：SLA 在线化申报与签署、'
            '字段元数据对标）＋ §2 追问 10/11/12；投递语义交叉引用 #4 考点 9 所引的消息语义'),
        language='markdown',
        rubric=[
            ('结构性问题与非结构性问题的分离', 2,
             '必须把"扩容要迁数据""共享集群读写互扰"归为 shared-nothing 的结构性问题'
             '（存算分离确实解），把"多表 join 弱"归为**换引擎不自动解决**的一类'
             '（还取决于优化器与分布键设计），并指出点查类负载可能反而变差；'
             '"查询慢"要先分成 扫描量/并发争抢/计划与分布 三类；只复述痛点清单不做判断的最多 1 分'),
            ('赔掉的东西要带观测指标', 2,
             '至少四项且各带指标：远端存储读延迟与扫描成本（单查询冷/热缓存读字节数、p99 首字节）、'
             '缓存命中率与失效（本地缓存命中字节占比、重缓存风暴次数）、'
             '元数据与事务层成为新瓶颈（元数据 QPS、事务/锁等待、DDL 排队）、'
             '小文件与 compaction 预算（每日合并量与放大率、写后合并延迟）、'
             '跨可用区/回源流量费用。只说"有网络延迟"给 0'),
            ('影子跑的等价判据', 2,
             '要给出双写/双查的具体形态与**归一清单**（浮点精度与舍入、NULL 与空串、'
             '行序、时区与日期归属、去重语义、字符集/大小写），'
             '比对差异要分桶而不是只报"有 diff"；放量判据要基于结果正确率 + 双侧性能分布 + 成本；'
             '回滚点要落到能执行的层（写路径可切回、读路径按查询类型分流、老链路保留多久），'
             '"跑一天看看"给 0'),
            ('成本账的可复现证据', 1,
             '必须列出成本构成并给"最小证据集"（同查询集在两套引擎的扫描字节、CPU 秒、'
             '内存峰值、实例时长、存储量与冷副本比例、compaction 消耗），'
             '并明确说别人的百分比来自不同负载画像与计价口径 ⇒ 不能当预算；'
             '能把"缓存命中率差异"列为最大混淆项的加分'),
            ('双链路差异四类归因与完整度门', 2,
             '差异分类至少四类且互相可区分（晚到与回补 / 重复（含集群 vs 广播语义造成的天然不等） / '
             '乱序与时间桶归属（分区顺序只在同分区内 FIFO） / 口径变更）；'
             '放行判据必须是完整度（应到 vs 实到 + 位点差 + 水位线连续）而不是"任务成功"，'
             '并且要能解释"为什么今天实时比离线多"；一次真相层要明确并让所有读数打它的标记；'
             '答"延迟不一样所以正常"直接给 0'),
            ('三条机器可判的卡口', 1,
             '卡口要能拦：未通过字段元数据对标的表不许被上层任务引用；'
             '对外指标必须来自指标平台定义（自定义 SQL 出口需登记才放行）；'
             '看板在"数据尚未完整"状态下只能渲染降级样式并显示水位线；'
             'SLA 签署 ⇒ 违约要有责任人与赔付口径，不许是口号。'
             '"加强 review / 写文档"不算'),
        ],
        notes='本题的分水岭是"敢不敢说这个提案哪里不成立"：能指出'
              '多表 join 与点查不是换引擎白得的、以及那 3.4% 是治理事故而不是延迟问题，才算 senior 以上。'
              '案例里的"降 50%"若被当成官方承诺引用，在成本项直接给 0（素材注明它是用户侧自述）。',
        estimatedMinutes=35,
        answer="""## 参考要点

**1. 先分"结构性"与"非结构性"。**
公告给的三类痛点不是一个层次：
- **扩容要迁数据**（shared-nothing 的存储与计算绑在节点上）与
  **共享集群读写互扰**（同一节点既吃写吞吐又吃扫描）是**结构性**的 ⇒
  存算分离 + 无状态计算节点 + 读写分离 + 租户隔离确实解。
- **多表 join 弱**是**引擎能力**问题（优化器、分布/排序键、join 策略），
  换架构不会自动变好；而且**点查**在存算分离上常常**变差**
  （远端存储 + 缓存未命中 ⇒ 单次读延迟抬高）。现场里那三条 join 跑不完，
  先要问的是"有没有按 join key 做分布、有没有预聚合"，而不是先换引擎。
"查询慢"必须先分成三类再谈选型：① **扫描量**（缺分区裁剪/排序键/物化）、
② **并发与争抢**（读写互扰、租户没隔离、夜里批任务抢白天看板）、
③ **计划与分布**（join 策略、数据倾斜、单点）。
只有第 ② 类是存算分离直接对症的。**这就是评审该问的第一句话。**

**2. 赔掉的每一项都要有观测指标。**
① **远端存储的读延迟与扫描成本**：指标 = 单查询读字节数（冷/热分开）、首字节 p99、
   单位扫描量的账单。
② **缓存一致性与命中率**：指标 = 本地缓存命中字节占比、缓存失效后的重缓存风暴次数、
   命中率随分区热度的分布。这是最容易被低估的一项 ——
   存算分离的性能故事**几乎全部建立在"热数据在缓存里"**之上。
③ **元数据与事务层成为新瓶颈**：指标 = 元数据服务 QPS 与延迟、DDL 排队时长、
   事务/锁等待、单表分区数增长曲线。全集群统一数据管理意味着**元数据是新的集中点**
   （"要扩大单集群，元数据/状态信息的存储是核心扩展点之一"这句是同一个道理的另一侧）。
④ **小文件与 compaction 预算**：指标 = 写后合并延迟、每日合并输入输出字节比（放大率）、
   小文件数。实时写入越多，这项越贵 —— 它是"实时数仓"场景的真实税。
⑤ 跨可用区/回源流量、读写分离带来的**一致性窗口误解**（公告说的是"读写数据强一致性"，
   但租户隔离与共享缓存会让"一致"的成本转成延迟）。

**3. 影子跑：等价要先定义清楚。**
做法：**双写**（同一份上游分别灌进老/新引擎，新引擎用独立租户配额跑，避免抢生产）+
**双查**（把生产真实查询日志回放成新引擎的负载，而不是手挑几条"代表性查询"）。
比对结果集前必须先**归一**，否则 diff 全是噪声：
浮点精度与舍入方式、`NULL` 与空串、行序（默认不敏感，但 top-N/百分比要按稳定次序比）、
时区与**日期归属**（跨天边界是重灾区）、去重语义、字符集与大小写。
归一之后**分桶报告**：只有某几个桶有差异才叫可解释的差异，
"diff 0.3%"不叫结论、叫没做完。
放量判据（三条一起满足）：结果等价率达标 + 新引擎在回放负载上的 p95/p99 不差于基线 +
单位查询成本不高于基线。
回滚点要放在**读写路径可切回**这一层：
写路径保留双写、读路径按查询类型分流（先切看板、再切 ad-hoc、最后切 API 点查），
老链路保留到"能重放任意一天的查询"为止，而不是"迁移完成后立刻下线"。

**4. 成本账：那个 50% 为什么不能抄。**
成本要拆成：存储（含副本与冷层）、计算（实例时长 × 规格）、缓存、扫描量、
跨可用区/回源流量、compaction/合并消耗、以及**运维与迁移本身的一次性投入**。
要**复现**"降 50%"，最小证据集是：同一份查询集在两套引擎上的
读字节数、CPU 秒、内存峰值、实例计费时长、存储量与冷副本比例、合并消耗，
以及计价口径（按量 vs 包年包月、是否含缓存与流量费）。
别人的数字来自别人的负载画像与别人的计价方式；
**存算分离在"低并发 + 热数据全在本地"的负载上甚至可能更贵**（多了一层远端读）。
引用案例数字必须带"用户侧自述"这个限定 —— 素材特意写了作者不是字节员工。

**5. 那 3.4% 是治理事故，不是延迟。**
差异必须**分类**，至少四类，且每类有自己的判别方法：
① **晚到/回补**：同一事件键在离线被后补进来 ⇒ 看事件时间与到达时间差分布；
② **重复**：实时链路常因**广播/重试/至少一次**语义重复计数
  （集群消费"每条仅被消费一次" vs 广播消费"每条会被消费多次"是天然的口径分水岭），
  要看 `msgId + 消费组` 去重后的差；
③ **乱序与时间桶归属**：分区顺序只在同一分区内保证 FIFO，跨分区不保证 ⇒
  跨小时/跨天的事件会落错桶（离线通常按日重算、实时按到达分钟聚合 ⇒ 边界必然不等）；
④ **口径变更**：新口径上线后重算了历史、或只有增量走新口径 ⇒
  这会造成**阶跃**而不是抖动，是最好认也最常被误诊为"延迟"的一类。
**完整度门**：放行判据不是"任务成功"，而是
"应到 vs 实到 + 位点差 + 水位线连续"（`MaxOffset − ConsumerOffset` 在阈值内、
事件时间水位线连续推进到 `T − δ`），不满足时看板要显示
**"数据尚未完整"** 这种产品化状态，而不是把半截数当完整数报出去。
**一次真相**要明确定义（通常是离线明细 + 口径版本），
所有读数带"来源链路 + 完整度状态"标记，对账层作为第三方记录差异分布；
"谁是一次真相"没定义，才会出现"实时和离线吵不起来就说延迟正常"。

**6. 卡口与组织。**
- 口径签字：指标平台的定义是出口（"消除指标二义性、保证指标数据出口一致"是**平台职责**），
  签字人是指标 owner 而不是"取数的人自己注意"。
- **字段元数据对标当上线闸**：具体动作是"命名词典 + 标准代码"做规则，
  建表/改表时自动比对，**未对标通过的字段不许被上层任务引用**（可被 CI 拦），
  并用"标准监控统计"持续扫出绕过面积。
- SLA 签署 ⇒ 违约有成本：责任方、赔付口径（内部结算或降级服务）、以及**排班含义**
  （谁的夜里起来跑补数、补数消耗算谁的预算）。
- 三条机器可判卡口示例：① 未对标字段 ⇒ 阻断发布；
  ② 对外指标未走指标平台定义 ⇒ 取数网关拒绝生成 SQL；
  ③ 完整度门未过 ⇒ 看板只能渲染降级样式并显示水位线（前端不许显示"最新"字样）。

**常见错法**："ClickHouse 不行就换 ByConity"（讲不出撞墙的是 shared-nothing 的
读写互扰与迁移，以及存算分离赔什么）；把多表 join 弱当架构问题；
把案例的成本百分比当预算；对账结论"延迟不一样所以正常"；
影子跑只比几条 SQL；卡口写"加进 code review"。""",
    )


@draft('ag-bd-tracking-contract-review-agent')
def q_ag_tracking_contract_agent():
    statement = """## 角色与时长

你要为**字节跳动 数据治理方向**设计一个 **埋点契约评审 Agent**（Senior 轮，35 分钟）。
它不是聊天机器人：它的产出是"这个埋点需求能不能上线"的一条**决策**，
而这条决策会直接影响下游几百张报表和分群。

## 可核查事实（公开产品文档里的机制与原文，不要质疑出处）

- 对象模型：**事件**（用户动作，"主要通过应用内埋点实现，因此也称为埋点数据"）、
  **事件属性**（描述事件的信息：设备侧的操作系统/软件版本/渠道/IP，
  业务侧的视频 ID/名称/分类/标签）、**预置事件与预置属性**（SDK 自带、由系统统一配置上报时机）。
- 官方给出的治理顺序是**硬约束**："先规划 → **在控制台录入埋点和属性（先落库）** →
  集成 SDK 时配置上报 → 打开全埋点开关"。
- 验收态："**一般事件列表仅展示已验收的事件**，未验收事件可点击验收事件并完成验收"；
  元数据管理里可"新增事件、编辑事件、**设置事件状态**、验收埋点"。
- 权限粒度是独立的："数据管理-一般事件-**可管理**"，无权限只能看。
- 官方建议："**先查看预置事件是否已满足业务需求，不满足再手动创建自定义事件**"。
- 校验与影响面："**实时埋点检测**"（实时检测、快速验证埋点是否正确及**数据上传情况**，
  支持 Android/iOS/微信小程序等多端）；"**变更历史**"（事件级变更日志）；
  "**血缘关系**"（图表/看板 + 用户分群，且区分"**直接引用**"与"**间接引用**"，
  分群血缘还带"最新分群用户数、近 30 天的查询次数"）——
  文档同时说明变更历史与血缘属于增值的"**埋点治理模块**"。
- 停止采集不需要改代码："数据管理 > 元数据管理中**禁用对应事件或属性**"
  或项目中心关全埋点开关；另有"热力图、圈选事件功能**需开启全埋点才可使用**"。
- 全埋点的官方劣势清单："无差别全量采集，产生无效数据上报，**浪费流量/存储/计算资源**"、
  "**无法采集业务相关属性**"、"版本上线后埋点内容迭代灵活性低"、"对开发框架有一定限制"；
  代码埋点的不可替代性："尤其是一些**非点击的、不可视**的行为，非代码埋点实现不可
  —— 例如：搜索结果返回、注册结果返回、Banner、楼层、**个性化推荐/千人千面页面**"。

## 组织现场（**数字是出题假设**，请当假设并说明你如何测量）

每周新增埋点需求假设 120 条，其中假设 35% 与已有事件名重名或语义不同；
数据治理小组只有 **1.5 个人力**在做上线前评审；
上个月出过一次事故：某客户端把"支付成功"事件的属性 `amount` 从"元"改成"分"，
未走评审，下游 12 张报表连续 6 天口径错，且其中 3 张是**间接引用**（分群 → 投放）。

## 请设计（七问，逐条作答）

1. **三分规则**：给出"自动驳回 / 转人工 / 自动放行"三档的判据与阈值来源
   （阈值不许是拍脑袋，要说明你用什么历史数据算出来的）。
2. **工具面**：列出这个 Agent 需要的**只读工具**与**写工具**清单。
   特别回答：**"禁用某个事件"这个动作为什么必须留给人**
   （提示：禁用 = 停止上报，且不需要改代码）。
3. **校验规则集**：一条埋点需求的"契约"包含哪些字段？
   给出可机器判的规则（含"未录入先上报""未验收""已禁用仍在上报""属性缺填率异常"四类违规的
   分类与归因），以及"**同一事件名跨端语义不一致**"这类规则为什么最难自动化。
4. **影响面推理**：怎么用"直接引用 / 间接引用 + 最新分群用户数 + 近 30 天查询次数"
   构造一个**变更风险分**？为什么只看直接引用会漏掉最贵的那部分（用上面那起事故说明）。
5. **可复算与留痕**：一条"驳回"要能复算到什么程度？给字段清单
   （含规则版本、模型版本、输入快照、人工改判与理由），并说明人工改判的审计要求。
6. **容量方程**：把 Agent 的自动驳回率、误拦率与那 1.5 个人力写成方程 ——
   误拦率上升会先压垮什么？灰度期对新业务线的豁免策略与**退出条件**怎么定？
7. 一条你**主动放弃自动化**的校验，并说明为什么不值得（这题必须真放弃一件）。

## 约束

素材明确写了：字节的**前端/客户端埋点 SDK 没有可核查的机制文档**（只抓到导航条目），
所以不许出现"SDK 内部如何队列重试/如何合并上报"这类断言，也不许把本题判成代码题。
不许把产品文档里的能力说成"字节内部流程就是这样"。"""

    return base(
        'agent-design', 'senior',
        '把埋点上线前拦截做成 Agent：验收态、先落库再上报、四类违规，以及不许它自己禁用事件',
        statement, 'llm-rubric',
        ['tracking-contract', 'metadata-workflow', 'human-review-boundary',
         'lineage-risk-score', 'decision-reproducibility', 'modern:data-governance-agent'],
        src('数据治理 / 元数据平台方向 AI 工程师（Agent 设计）',
            DATA + '#4 考点 3（埋点契约与元数据工作流：rubric 版建议"埋点契约评审与上线卡口"；'
            '先录入落库→SDK 再上报的顺序、仅展示已验收事件、验收动作、权限粒度、'
            '禁用事件或属性即停止采集、优先复用预置事件、同一事件名跨端语义不一致的深问）'
            '＋ #4 考点 4（埋点血缘与影响分析：直接/间接引用、最新分群用户数与近 30 天查询次数、'
            '下线判据应是间接闭包内消费为零＋热度为零＋保留期外）＋ §1.2（全埋点 vs 代码埋点取舍）'
            '＋ §2 追问 8/9；SDK 内部实现按 §7 第 5 条列为不可写'),
        language='markdown',
        rubric=[
            ('三分规则与阈值来源', 2,
             '三档判据要能落到机器输入（重名/语义相似、属性字典命中、契约字段完整度、影响面风险分），'
             '阈值必须给来源：用历史 12 周的评审结论做 precision/recall 曲线 + 1.5 人力的日处理量反推'
             '"可自动驳回的上限比例"；把高置信但不可逆的动作（禁上报）交给自动 ⇒ 直接扣分'),
            ('工具面与"禁用"必须留人', 2,
             '只读清单要含元数据查询、命名词典/标准代码比对、血缘闭包（直接+间接）、消费热度、'
             '变更历史、实时埋点检测结果；写清单只能到"草稿态/打回/加人工队列/生成评审意见"这一档；'
             '必须说清"禁用事件=停止上报且不需改代码"是**生产级不可逆动作**（会静默切断下游、'
             '且现象要几天后才暴露），因此必须人工审批 + 双人 + 有效期，且要能一键撤销并通知闭包内 owner'),
            ('契约字段与四类违规可判', 2,
             '契约要含事件名/属性集与类型单位/上报时机/生效版本与端/验收人/owner/保留期；'
             '四类违规的区分要说清"证据来自哪两张表比对"（未录入先上报=上报明细左连元数据为空、'
             '未验收=有元数据但状态未验收仍在上报、已禁用仍在上报=状态禁用但仍有量、'
             '属性缺填率异常=必填属性空值率超阈值）；'
             '跨端语义不一致要说"最难自动化的原因"（同名不同单位/不同触发条件，'
             '需要业务语义与抽样数据双向校验，规则只能查单位声明查不出真实分布）'),
            ('风险分与间接引用', 2,
             '风险分要乘上"间接闭包"而不是只看直接下游，并用事故举例：'
             '分群 → 投放是间接引用，直接引用数为 0 但真实消费在最贵那一头；'
             '热度信号（最新分群用户数、近 30 天查询次数）要进公式；'
             '还要给出**闭包深度上限如何定**（素材给的完整判据是间接闭包消费为零＋热度为零＋保留期外）'),
            ('留痕与改判审计', 1,
             '字段清单要含输入快照（需求原文＋解析结果）、规则集版本、模型版本、阈值版本、'
             '风险分各因子取值、结论与理由、人工改判（谁、依据、第二人复核）、时间戳；'
             '"同输入＋同版本 ⇒ 同结论"是复算的定义；改判不可抵赖'),
            ('容量方程与豁免退出', 1,
             '要写成方程：人工队列 ≈ 未自动决出数 + 误拦数 + 申诉数，'
             '而误拦的申诉处理成本高于首次审核（要指出先被压垮的是**申诉通道**不是评审队列）；'
             '新业务线豁免必须有退出条件（低置信不自动驳回但强制抽检比例），否则成为绕过口子'),
        ],
        notes='本题红线：把"禁用事件/改状态"这类生产动作写成 Agent 可自动执行，'
              '或把 SDK 内部机制当事实编造（素材 §7 第 5 条）。'
              '第 7 问若一条都没真放弃（全是"都能自动化"），在容量方程项扣分。',
        estimatedMinutes=35,
        answer="""## 参考要点

**1. 三分规则。**
判据要能由机器输入直接算出来，四件事最值钱：
① **重名/语义相似**（事件名与已有事件名的编辑距离 + 属性集合 Jaccard + 触发描述嵌入相似度）；
② **属性字典命中**（单位、类型、枚举值是否在标准代码/命名词典里）；
③ **契约完整度**（缺上报时机、缺生效端、缺 owner、缺保留期 ⇒ 直接驳回，这是零成本规则）；
④ **影响面风险分**（见第 4 问）。
分档：`高置信违规 ⇒ 自动驳回`（可重提，动作可逆）；
`高置信合规 + 低风险 ⇒ 自动放行`（打"机器放行"标记，进事后抽检池）；
`其余 ⇒ 转人工`。
阈值来源不是感觉：拿过去 12 周的评审结论回算 precision/recall，
再用"1.5 人力 × 每人日处理量 × 可接受等待时长"反解**允许自动决出的最大比例**。
关键纪律：**自动化的只能是"驳回"和"放行"这两类可逆动作**，
凡是"改生产状态"的一律不自动。

**2. 工具面。**
只读：元数据查询（事件/属性/状态/预置清单）、命名词典与标准代码比对、
**血缘闭包（直接 + 间接）**、消费热度（最新分群用户数、近 30 天查询次数）、
变更历史、实时埋点检测结果、抽样上报数据。
可写（且只到这一档）：创建/修改**草稿态**元数据、打回需求并附证据、加人工评审队列、
生成评审意见文档、发起验收（人点确认才生效）。
**"禁用事件"必须留给人**，理由要说到机制层：产品文档明写停止采集
"禁用对应事件或属性"即可、**无需改代码** ——
这意味着一次点击就能**静默切断**上报，而后果只在几天后的报表空洞里才暴露；
它同时是"热图/圈选"等依赖全埋点功能的开关。
所以：人工审批 + 双人复核 + 有效期（默认自动恢复）+ 一键撤销 +
**通知范围按间接闭包计算**（不是按"谁认领了这张表"）。

**3. 契约字段与四类违规。**
契约 = 事件名 + 属性集（含**类型与单位**）+ 上报时机 + 生效版本/生效端 + 验收人 + owner + 保留期。
四类违规的分类价值在于"归因不同、责任方不同"：
- **未录入先上报**：上报明细左连元数据为空 ⇒ 开发绕过流程先上线（责任在流程卡口缺失）；
- **未验收**：有元数据但状态不是"已验收"仍在上报 ⇒ 测试数据污染生产（责任在验收动作）；
- **已禁用仍在上报**：状态为禁用但仍有量 ⇒ 端上版本滞后或缓存重传（责任在版本收敛/有效期设计）；
- **属性缺填率异常**：必填属性空值率超阈值 ⇒ 采集端实现与契约不符（责任在实现）。
**最难自动化的是"跨端语义不一致"**：
文档给的属性例子里同时混着"操作系统/软件版本/渠道/IP"（设备侧、变更频率低、责任人明确）与
"视频 ID/名称/分类/标签"（业务侧、随业务演进、责任人不唯一）。
同名的 `amount` 在 iOS 是"元"、在 Android 是"分"，**规则只能校验声明的单位，
校验不了实际上报的分布**；要做对必须有"抽样数据反推单位量级 + 跨端一致性比对"这条**离线**链路，
并且最终仍需要人判断"哪个是对的"。这是第 7 问的好答案之一。

**4. 风险分。**
`风险 ≈ Σ_{闭包内节点} 消费热度权重 × 关键度权重`，闭包必须是**间接闭包**，
热度用"最新分群用户数 + 近 30 天查询次数"，关键度区分"事件分析/留存/分群/对外报表"。
用事故讲最直观：`amount` 改单位那次，**直接引用只有 12 张报表里的 9 张**，
最贵的是"分群 → 投放"这三条**间接**链 —— 只看直接引用会把它评成低风险。
闭包深度上限不能是常量：素材给的完整判据是"间接闭包内消费为零 + 热度为零 + 保留期外"，
所以真正的界是"这条链还活不活"；工程上展开到"热度为 0 的叶子"为止，
并把**深度本身当证据输出**（一条 5 层深的引用链就是治理信号）。
反向卡口也要有：**新增字段未登记 ⇒ 采集侧告警**，否则违规只能事后发现。

**5. 可复算。**
留痕字段：需求原文与解析结果快照、规则集版本、模型版本、**阈值版本**、
风险分各因子取值（不是只存总分）、结论与命中规则列表、人工改判记录（谁、依据、第二人复核）、
时间戳。复算的定义是"**同一输入 + 同一版本 ⇒ 同一结论**"；
做不到就说明版本没留痕，也就是审计拿不到证据。
配套动作：规则/模型升级要**影子跑**并输出**决策差异清单** ——
驳回对提需求方是真金白银的排期损失，差异清单是申诉的依据。

**6. 容量方程。**
设周需求 `N=120`，自动决出比例 `a`，误拦率 `f`，申诉处理成本约首次评审的 2–3 倍。
人工队列 ≈ `N(1−a) + N·a·f·k`（k 为申诉放大系数，取 2–3）。
**先压垮的是申诉通道，不是评审队列**：
自动驳回越多，被驳回的人会来申诉，而申诉要看的证据比首次评审更多（要复算），
所以 `a` 有一个"越高越糟"的拐点。
灰度期对新业务线可以给豁免（低置信不自动驳回），但**必须有退出条件**：
豁免期内强制抽检比例 ≥ x%、连续两周违规率不高于全局均值即退出，
否则豁免变成刷流程的口子。

**7. 必须真放弃的一件。**
合格示例：放弃"语义正确性"的自动判定（同名不同义只能标记 + 转人），
或放弃"跨端属性一致性"的自动裁决（能发现、不能定谁对），
或放弃"这个埋点该不该存在"的业务价值判断（这是需求评审的事，不是契约评审的事）。
理由是"自动化只能判**可声明的形式约束**，判不了**意图**"。

**常见错法**：把 Agent 做成"用大模型读需求打分"而没有工具与证据面；
让 Agent 直接禁用事件或改事件状态；只查直接引用；
风险分不带热度；没有版本留痕却说"可复算"；答不出容量方程；
以及最危险的一条 —— 因为"SDK 应该怎么做"是编的，就把整条规则建立在想象出来的端上行为上。""",
    )


@draft('ag-bd-metric-semantic-query-agent')
def q_ag_metric_query_agent():
    statement = """## 角色与时长

你要为**字节跳动 数据平台方向**设计一个**问数 Agent**（自然语言 → 指标读数），Senior 轮，35 分钟。
业务方的原话是："让 AI 直接写 SQL 不就行了？我们数据库权限都给它了。"
**你的工作是把这句话拆开。**

## 可核查事实（公开产品文档的模块与口径原文，不要质疑出处）

- 指标平台："以**维度建模**为理论基础，划分并定义**业务线、指标、数据模型**，
  支持导入多种数据源构建模型，提供多样指标构建方式，
  **消除指标二义性，保证指标数据出口一致性**。"
- 数据标准："提供数据标准、标准代码、**命名词典**管理能力，并且将数据标准用于数仓数据表
  **字段元数据对标**，通过**标准监控统计**推动数仓规范数据建设，**消除数据的不一致性**。"
- 数据地图："收集和展示**全链路元数据**，帮助数据消费者查找、理解、应用数据"；
  数据质量："通过数据**探查**、数据**监控**与数据**对比**"。
- 血缘可核查形态：图表/看板与用户分群的血缘区分"**直接引用**"与"**间接引用**"，
  分群血缘带"最新分群用户数、近 30 天的查询次数"。
- 埋点侧的口径事实：一般事件列表"**仅展示已验收的事件**"；
  推荐做法是"**先查看预置事件是否已满足业务需求**，不满足再手动创建自定义事件"。
- 实验侧的读数口径（公开 A/B 文档原文）："以进组用户数为例，多天累计的用户数，
  即是实验期间累计进组并**去重**后的用户数"；"相比单天累计，多天累计更能保证各组的
  样本是「**同质可比**」的"；"**实验开启当天按实时统计进组人数，开启第二天之后按 T-1 日天级更新，
  具体口径为截止当天 0 点的实验累计进组人数**"；指标类型分**事件指标 / 留存指标 / 漏斗指标**三类。
- 治理侧："**SLA 在线化申报与签署**"。

## 素材明确列为不可写的内容

数仓分层的官方命名（ODS/DWD/DWS/ADS 之类）在本次抓到的文档里**没有出现**，
那是行业通用（官方分层页来自别家云厂商）；
也不许引用任何内部表数量、任务数、数据团队规模。
所以本题里"分层"只作为【推】的工程选择出现，不许写成"字节官方分层标准"。

## 现场（**数字是出题假设**）

假设接入 30 个业务线、登记的指标定义假设 4200 条、语义层可查询表假设 1800 张。
业务方日均提问假设 3000 次，其中约三分之一是"上周 XX 指标多少"这种直接读数，
另有相当比例是"为什么涨了/跌了"的归因追问。
现网已经发生过两起事故：
① 有人把**实验平台的"累计去重进组用户"**当分母、把**看板的"日活跃用户"**当分子算出"人均 GMV"，
和实验报告差了 3 倍；
② 某口径半年前变更（剔除一类无效流量），但"同比"仍然拿新口径除老口径。

## 请设计（七问，逐条作答）

1. **必经路径**：从"自然语言问题"到"一个数"，你的流程里有哪几步是**不可绕过**的？
   什么时候必须反问而不是回答？给出反问的判据（不许是"没把握就问"）。
2. **硬约束与拦法**：哪两类量之间禁止相除、禁止同图？
   用上面那两起事故说明"为什么这类错误不是靠 prompt 能防住的"，
   并给出**机器可判**的拦法（在语义层/取数网关哪一层、拦什么）。
3. **分母与去重主体**：事故 ① 里两个分母分别属于哪个域？
   实验结论为什么必须用"累计去重"而不能用"日活"？Agent 回答时**必须**把哪些字段写全才算合规？
4. **口径版本化与可比区间**：新口径上线后历史怎么办（重算 / 冻结 / 截断标注三选一并给理由）？
   Agent 被问"同比"时的正确行为是什么？T-1 与"截止当天 0 点"这个口径对"今天的数据"意味着什么？
5. **权限与审计**：行级权限在哪一层生效才对（模型层还是查询层）？
   每次问答要留哪些字段？"保证指标数据出口一致"这件事会怎么被 Agent 破坏？
6. **可信度工程**：怎么发现 Agent **绕过语义层自己去拼表**？
   给出你的影子评测集与"错误答案召回"机制；什么时候宁可回答"我不知道，去找 XX 口径 owner"。
7. **成本与延迟**：一次问答的扫描量与 token 预算怎么控？
   哪些该缓存（给出键的组成）、哪些必须现算？归因类追问要不要给自动答案？

## 约束

不许写"接个大模型 + Text2SQL 就行"；不许引用任何内部表名/系统名当事实。
凡涉及未公开的实现细节，请显式标注"这是我的推断"。"""

    return base(
        'agent-design', 'senior',
        '问数 Agent 必须走语义层：分母、口径版本、可比区间，以及不许它把两个锚点相除',
        statement, 'llm-rubric',
        ['metric-semantic-layer', 'text-to-sql-guardrail', 'denominator-declaration',
         'caliber-versioning', 'answer-provenance', 'modern:agent-retrieval'],
        src('数据平台（指标与语义层方向） AI 工程师（Agent 设计）',
            DATA + '#4 考点 7（指标口径与语义层：rubric 版建议"语义层强制与绕过检测"；'
            '指标平台消除二义性与出口一致是平台职责、口径卡字段、'
            '命名词典＋字段元数据对标＋标准监控统计可当上线闸；'
            '高频陷阱"进组用户累计去重"与"活跃用户"混用作分母）'
            '＋ #4 考点 12（实验读数口径：多天累计、累计去重、同质可比、当天实时/次日起 T-1 '
            '且口径为截止当天 0 点）＋ §1.4 ＋ §2 追问 4/14 ＋ §1.5；'
            '数仓分层命名按 §7 第 2 条列为不可冒充项'),
        language='markdown',
        rubric=[
            ('必经路径与反问判据', 2,
             '必经步骤要含：意图→指标候选（只从指标平台的定义里选）→口径卡解析（触发事件、'
             '度量对象、去重主体、时间锚点、是否回溯、排除集）→可比性检查→语义层生成 SQL→执行；'
             '反问判据要具体到"两个及以上指标定义都匹配且分母/时间锚点不同"'
             '"问句里的时间跨越口径变更点""需要的维度不在该指标登记的维度模型里"——'
             '答"不确定就问"给 0'),
            ('禁止组合与机器拦法', 2,
             '必须答出：时间锚点不同的量禁止相除、去重域不同的量禁止同图/相除（事故①）；'
             '并说明"这不能靠 prompt 防"——因为模型每次都可能生成看起来合理的除法，'
             '防线必须在语义层登记的**可比性约束**上、由取数网关对不允许的比值组合'
             '**拒绝生成 SQL**；事故②的防线是口径版本 + 可比区间（超出即拒答或强制标注）'),
            ('分母域与必须写全的字段', 2,
             '要说清"累计去重进组用户"是实验域、"日活"是看板域，两者不同质 ⇒ '
             '实验结论只能用登记的进组口径（理由：各组同质可比，分母不同会引入构成差异）；'
             'Agent 每次回答必须带分母定义、时间锚点、排除集、口径版本、数据完整度/T-1 状态、'
             '指标 owner；只给一个数的答案按不合规处理'),
            ('口径版本化与 T-1 语义', 2,
             '三选一必须给理由与配套：重算（成本与历史快照风险）、'
             '冻结可比区间（新口径只从生效日算起，跨点禁同比）、'
             '截断标注（保留可读但显著标记）；'
             '要点出"实时/次日起 T-1 且截止当天 0 点"意味着'
             '"看板上今天的人数变化不等于今天的增量"，Agent 若把 T-1 当实时答就是错答'),
            ('权限层与留痕', 1,
             '权限必须在**查询层**生效（行级策略/视图/查询改写），'
             '靠 prompt 约束模型"别看那张表"等于没有；留痕要含问句、命中定义版本、'
             '生成的 SQL、扫描量、返回行数、是否触发反问、用户对结果的后续动作；'
             '要指出"出口一致"被破坏的形态是 Agent 直接从明细表现算指标'),
            ('绕过检测与召回', 1,
             '给出可执行的检测：SQL 表引用白名单（不在登记模型内的表 ⇒ 拦截并计数）、'
             '与语义层同问题的**影子评测集**（固定问题 + 期望值回归）、'
             '错误答案要能按指标 owner 召回并在下次回答前撤下缓存；'
             '明确"不知道"的边界（新指标未登记、跨口径变更区间、超保留期）'),
        ],
        notes='这题真正的分差在第 2 与第 6 问：能不能说清"prompt 不是防线、语义层才是"，'
              '以及能不能给出"绕过语义层"的可检测方法。'
              '把数仓分层命名当成字节官方标准（素材 §7 第 2 条明写不是）在版本化项直接给 0。',
        estimatedMinutes=35,
        answer="""## 参考要点

**1. 必经路径（顺序本身就是答案）。**
`问句 → 意图与维度识别 → 指标候选（**只允许从指标平台的登记定义里取**）→ 口径卡解析
（触发事件 / 度量对象 / 去重主体 / 时间锚点 / 是否回溯 / 排除集）→ 可比性与权限检查 →
语义层生成 SQL → 执行 → 带元信息作答`。
"让模型直接写 SQL"的问题不在 SQL 写得好不好，而在**它选的是哪个口径**——
库里同名指标往往有多个定义，模型挑哪个都像对的。
**必须反问的三条判据**（可机器判）：
① 候选指标 ≥ 2 且它们的**分母域或时间锚点不同**；
② 问句的时间范围**跨越了口径变更点**（新口径生效日之前）；
③ 需要的维度不在该指标登记的维度模型里（要跨表拼 ⇒ 已越过语义层边界）。
第四条可选加分：完整度门未过还问"今天"的数。

**2. 两类禁止组合，以及为什么 prompt 防不住。**
- **时间锚点不同**的两个量禁止相除：事故①里分子是"当日活跃用户当日 GMV"（支付时刻）、
  分母若是"累计去重进组用户"（进组时刻）就是跨锚点相除，得到的不是比率而是账期噪声。
- **去重域不同**的两个量禁止同图/相除：实验域（进组累计去重）与看板域（日活）是两个 universe，
  交集与差集都非空 ⇒ 任何直接比较都可能被构成差异解释掉。
为什么不能靠 prompt：模型生成的是**语法正确、语义随机**的除法，
同一次提问换一种措辞就换一条防线；"禁止不可比相除"必须是**登记在语义层的可比性约束**
（每个指标声明能与哪些指标做比值、时间锚点与去重域标签），
由**取数网关拒绝生成 SQL**（不是"回答时提醒用户注意"）。
事故②（跨口径变更点做同比）同理：可比区间是口径版本的属性，
超出区间就**拒答或强制标注**，不能靠模型"记得"半年前改过口径。

**3. 分母域。**
"累计去重进组用户"属于**实验域**：它的意义是"这段时间进过组的这些人"，
实验要求两组**同质可比**（官方原话），换成分母就换掉了 universe，
两组之间的差异可能来自"谁进了组"而不是"策略起了什么作用"。
"日活跃用户"属于**看板域**：它是按天重新定义的集合，会随 DAU 波动，
和实验期累计人群没有稳定关系。
所以事故①差 3 倍不是"算错了"，是**在回答两个不同的问题**。
Agent 合规回答必须带的字段：指标定义名 + 版本、**分母定义与去重主体**、
时间锚点（事件时间/落库时间）、排除集（测试单/无效流量/风控单）、
数据完整度与 T-1 状态、owner 与口径文档入口。
少任何一条，答案就变成了"没有分母的结论"。

**4. 口径版本化。**
三选一都要能辩护，但**必须选一个并落实**：
① **重算历史**：可比性最好，代价是历史快照被改写（已经对外报过的数会"变"），
   必须先固定一份"当时快照"供审计，否则追溯断裂；
② **冻结可比区间**（多数场景的正解）：新口径从生效日起算，
   跨生效点的同比/环比由语义层**直接拒绝**，需要跨点时用"口径桥接表"给换算说明；
③ **截断标注**：保留可读但显著标记"该区间口径不同"，适合内部诊断，不适合对外。
**T-1 的语义**：公开口径是"开启当天按实时统计，第二天之后按 T-1 天级更新，
口径为**截止当天 0 点的累计进组人数**"。
这句话对 Agent 的硬约束是：**"今天"没有完整答案**。
看板今天的数变化 ≠ 今天的增量，所以问"今天涨了吗"必须回答"今天的数据截止 0 点，
只能回答到昨天"，而不是给一个实时数当结论。

**5. 权限与审计。**
权限必须在**查询层**生效（行级策略、按角色改写的视图、查询网关强制注入谓词）。
理由很直接：模型是**不可信的执行者**，把"别看那张表"写进 prompt
等于把权限交给一个会幻觉的组件。
留痕字段：原问句、会话上下文、命中的指标定义与版本、生成的 SQL、
扫描字节与耗时、返回行数、是否触发反问、用户后续动作（导出/追问/纠错）。
"保证指标数据出口一致"被 Agent 破坏的典型形态就是
**它从明细表现算了一个看起来对的指标**（出口就变成 N 个），
所以留痕里必须有"是否走语义层"这个布尔值 —— 它是第 6 问的检测基础。

**6. 绕过检测与召回。**
三条可执行手段：
① **表引用白名单**：SQL 解析出引用表，凡不在登记维度模型内的 ⇒ 执行前拦截 + 计数
   （这个计数就是"绕过面积"的治理指标，素材里"标准监控统计"是同一种思路）；
② **影子评测集**：固定一批"问题 → 期望数值"的黄金集（覆盖跨口径边界、
   T-1、分母切换、空结果、保留期外），每次模型/提示/语义层变更前跑回归；
③ **错误召回**：被 owner 标记为错的答案，其缓存条目必须**按指标维度批量失效**并在页面上撤下，
   同时把该问题加进评测集（错误只发生一次才算闭环）。
"宁可说不知道"的边界要写成规则：指标未登记、跨口径变更点、超出保留期、
完整度门未过、需要跨域拼接 ——
回答"我不知道，请找 XX 指标 owner"比给一个数更有价值。

**7. 成本。**
控制手段：强制分区裁剪（无时间范围 ⇒ 反问而不是全扫）、
扫描量预算与超限拒绝、高频维度组合预聚合/物化（**按真实查询模式设计**，
判据来自留痕里的维度组合分布）、归因类追问走"预计算贡献度分解"而不是让模型自由写 SQL。
缓存键至少要含 `(指标定义版本, 时间锚点, 维度组合, 权限角色, 数据水位线)` ——
少任一维都会把不同口径的缓存串给用户，那是最贵的一种错。
归因类追问要不要自动答：可以答**结构化的候选解释**（哪几个维度贡献了多少），
但必须同时给出"这些解释各自需要什么证据"，
因为"为什么涨"的真实答案往往在链路上（口径变更、回补、活动）而不在数据里。

**常见错法**：把 Agent 做成 Text2SQL + 全库读权限；
声称"在 prompt 里写清楚禁止不可比相除"；答案不给分母；
把 T-1 当实时答；用日活当实验分母；权限靠模型自觉；
没有"是否走语义层"的检测就说"出口一致"；缓存键不带口径版本；
以及把行业通用的分层命名当成"字节官方标准"。""",
    )


@draft('ag-bd-oncall-resilience-diagnostic-agent')
def q_ag_oncall_diagnostic():
    statement = """## 角色与时长

你要为**字节跳动 基础架构 / SRE 方向**设计一个**值班诊断 Agent**（principal 轮，40 分钟）。
它跑在夜里，接手告警；它的输出要么是一条**诊断结论**，要么是一次**动作请求**。
设计评审只问一句：**它错的时候会发生什么。**

## 可核查事实（公开框架文档与开源仓库的机制、默认值与能力边界，不要质疑出处）

- 治理开关的默认状态：**熔断、限流、重试都不是默认开启**；
  重试不作为默认策略的官方理由是"很多业务请求不具有幂等性"。
- 重试：`MaxRetryTimes` 默认 2（合法域 0–5）；`MaxDurationMS` 若配置**必须大于单次请求超时**
  且**不超过 `RPCTimeout × (MaxRetryTimes + 1)`**；停止策略阈值默认 10%（合法域 (0,30%]）且
  **须小于服务粒度的熔断阈值**；`ChainStop` 默认启用（上游是重试请求则不再重试）；
  `RetrySameNode` 默认 false；**流式接口不支持重试**；
  按链路剩余预算决定是否重试的策略**框架未内置实现**，需要业务自己注册，
  官方建议"基于上游发起调用的时间戳和超时时间判断"。
- 超时：`ConnTimeout` 默认 50ms、`RPCTimeout` 默认 **0（不限时）**；超时错误**默认不重试**；
  配置优先级 `Call Option > Client Option > TimeoutProvider（动态）`；
  服务端 `ReadWriteTimeout` 文档明写"实际未被使用"。
- 熔断：默认 `ErrRate 0.5 / MinSample 200`，且"样本不足 200 时配置不生效"；
  **实例粒度熔断后框架会自动重试**（要求中间件用"在负载均衡后执行"的方式注册）；
  服务粒度 key = `fromService/toService/method`。
- 限流：`MaxConnections` 与 `MaxQPS` 两个维度；默认 QPS 限流在非多路复用下于 **OnRead** 生效、
  按 method 限流才在 **OnMessage**；**对 gRPC 协议暂不生效**（要靠 HTTP/2 流控窗口）；
  阈值可热更；超限有连接数/QPS 两类上报。
- 降级：Fallback 可对 `RPC Error` / `业务 Error` / `Resp(BaseResp)` 三类结果兜底；
  "Fallback 后可能直接返回成功的 Resp，对用户而言是一次成功请求，但 RPC 层面还是失败请求，
  **所以监控默认以原来的结果上报，但支持配置化调整为以 Fallback 结果上报**"；
  并且 Fallback "**涉及业务逻辑，只支持代码配置**"。
- 配置下发：开源配置组件的语义是"周期性加载 → 比对两版差异 → **只有差异才通知 listener**"，
  支持手动刷新与 dump；超时/重试/熔断/服务端限流阈值可由配置中心扩展下发。
- 负载均衡：默认带权轮询，文档写明目的是"让所有下游实例拥有最小的同时 inflight 请求数"；
  权重全相等时退化为纯轮询；一致性哈希的官方态度是警告式的
  （"如果你不了解什么是一致性哈希，或者不知道带来的副作用，请勿使用"），
  适用场景是"对上下文（如实例本地缓存）依赖程度高的场景"。
- 网络库的问题陈述：Go 标准 `net` 是阻塞 API ⇒ "One Conn One Goroutine"；
  且 `net.Conn` 没有"是否存活"的 API ⇒ "难以做出高效的连接池，因为池子里可能有大量失效连接"。
- 集群与调度侧可交叉引用：开源组织自我定位是 "million-scale container infrastructure"；
  控制面锚点——"Kubernetes 官方稳定运行规模限制在 5K 节点"，
  扩单集群时"元数据/状态信息的存储是核心扩展点之一"；
  混部组件做 "QoS 资源模型 + 水平与垂直弹性 + NUMA/设备拓扑感知"，
  超卖策略"through auto-tuned workload profiling"；
  统一调度器集成 quota 管理、用乐观并发优化最耗时的 filter/score。
- 素材明确列为**不可写**：内部注册中心/配置中心的真实选型（文档只证明"可扩展"，
  不证明"内部用什么"）、服务网格与 sidecar 路线、任何内部量级数字。

## 现场（**数字是出题假设**）

夜间值班 Agent 面对三类告警，各自都要它在 10 分钟内给出结论：
① "**服务 A 成功率 99.9%，无告警**，但用户投诉量涨 4 倍"；
② "**下游 D 的 p99 涨 3 倍，D 自己没有任何报警**"（D 最近做过扩缩容）；
③ "**熔断阈值热更后 5 分钟，重试流量占比从 3% 涨到 22%**"。
Agent 目前可挂载的工具：查指标、查日志、查配置（含版本历史）、
查发布/变更记录、热更治理阈值、摘流量/重启实例、改降级逻辑代码。

## 请设计（七问，逐条作答）

1. **三条告警各自的第一步**：分别说出你的**判据**（看哪两个数的差、看哪条曲线），
   以及为什么这一步比"看监控大盘"有效。
2. **工具面与只读/写分级**：上面那份工具清单里，哪些该给它、哪些不该？
   特别回答：**为什么"热更治理阈值"可以是写工具，而"改降级逻辑代码"必须不是** ——
   依据是什么（不许回答"因为改代码风险大"）。
3. **动作分级**：给出"自动执行 / 需人批准 / 禁止"三级与判据
   （可逆性、影响半径、是否改变指标口径这三条都要用到）。
4. **预算归因**：告警 ③ 里，Agent 要怎么证明"是这次热更导致的"而不是自己臆断？
   给出因果链上要断言的每一环与对应证据；
   顺带回答：阈值之间原本应满足什么大小关系，谁先撞线说明保护对象错位。
5. **误诊与幻觉的防线**：结论必须挂什么才算数？
   怎么防止它把"开源组件的能力边界"说成"你们内部一定这么实现"？
   错误结论如何召回、如何影子跑、如何输出决策差异清单。
6. **噪声与产能方程**：把告警噪声、Agent 自动决出率、值班人工产能写成方程，
   说明"什么情况下这个 Agent 应该闭嘴"（给出可计算判据），
   以及它自己挂了谁兜。
7. **可复算留痕**：一次"建议摘流量"的决策要留哪些字段？
   6 个月后复盘"当时该不该摘"，你靠什么复算？

## 约束

不许出现"字节内部就是用 XX 做的"这类断言；不许编任何内部量级（QPS/机器数/p99 官方值）。
可以引用上面这些机制与默认值，引用时要说清它是**公开框架的默认行为**，不是"我们的现状"。"""

    return base(
        'agent-design', 'principal',
        '值班诊断 Agent：只读工具、动作分级、不许它热改 Fallback，以及"曲线变好了"必须被它自己抓出来',
        statement, 'llm-rubric',
        ['oncall-agent', 'action-tiering', 'observability-caliber', 'hallucination-guardrail',
         'decision-reproducibility', 'modern:sre-agent'],
        src('基础架构 / SRE 方向 AI 工程师（Agent 设计） 首席工程师候选',
            INFRA + '#4 考点 7（Fallback 与监控口径污染：默认按原始结果上报、只支持代码配置）'
            '＋ 考点 6（超时预算与链路传播：RPCTimeout 默认 0、链路判据需自行注册）'
            '＋ 考点 2/3/4（熔断默认阈值与样本门槛、限流两维度与 gRPC 盲区、重试三层刹车）'
            '＋ 考点 8（配置差异才回调、阈值热更接口）＋ 考点 5（一致性哈希警告与 inflight 均摊）'
            '＋ 考点 13/14（QoS 画像与超卖、quota 与控制面扩展点）＋ §2 追问 3/6/8/9/12/13；'
            '§7 第 4/5 条（内部栈选型不可写）作为红线依据'),
        language='markdown',
        rubric=[
            ('三条告警的第一步与判据', 2,
             '①必须答"业务成功率与 RPC 成功率的差值=被降级掩盖的失败率"（默认按原始结果上报 ⇒ '
             '业务侧看不出来），并看降级触发率曲线；②必须答"扩缩容后 key 重排→本地缓存集体 miss→'
             '下游被瞬时打高但每次调用不超时，所以 D 不报警"，判据看 inflight/连接数与缓存命中率'
             '而不是 CPU；③必须先看配置版本时间线与重试占比曲线的对齐，再看是否撞破了'
             '"重试阈值须小于熔断阈值"的关系。给"看大盘/看日志"这类无判据动作给 0'),
            ('工具分级的依据要引机制', 2,
             '必须落到那条硬约束：**降级涉及业务逻辑、框架侧只支持代码配置** ⇒ '
             '热更有配置中心这条合法通道（可灰度、可回滚、有版本），'
             '而改降级逻辑要走发布，Agent 不该有"绕过发布改行为"的能力；'
             '只读工具应全开，写工具只能开"可逆且有版本"的那几个；'
             '摘流量/重启属高影响半径 ⇒ 需人批准。答"因为改代码风险大"而不引这条约束，最多 1 分'),
            ('三级动作与判据', 2,
             '三级要给出可计算判据（可逆性：有无原子回滚；影响半径：单元/实例/服务/集群；'
             '是否改变指标口径：改口径的动作一律禁止自动，因为它会让下一次诊断读到被污染的数据）；'
             '并明确"改监控上报配置（按 Fallback 结果上报）"就是改口径 ⇒ 禁止'),
            ('因果链断言与阈值关系', 2,
             '要能逐环给证据：配置版本号与下发时间、生效实例集合、重试占比/熔断触发次数/下游 QPS '
             '三条曲线的同时刻变化、ChainStop 与 RetrySameNode 是否被改动、'
             '以及"重试阈值 ≥ 熔断阈值"这条大小关系被破坏（谁先撞线说明保护对象错位）；'
             '还要给出反证（同版本未生效的实例是否也异常）'),
            ('幻觉防线与召回', 1,
             '结论必须挂"机制锚点 + 观测证据"两类，缺一即降级为"假设待验证"；'
             '要显式禁止把开源组件默认行为写成"内部实现"（素材 §7 明写可扩展≠内部用）；'
             '错误结论召回 = 按规则/模型版本批量标记受影响的诊断记录；'
             '升级要影子跑并输出决策差异清单'),
            ('噪声方程与自我失效', 1,
             '方程要含告警噪声、自动决出率、误报放大到申诉/复核的系数，并给出"该闭嘴"的可计算判据'
             '（例：某类告警的结论准确率低于某阈值、或同窗口并发告警数超过复核产能时退化为'
             '只做信息聚合不给动作建议）；Agent 自身故障域与兜底（它挂了值班流程照常）'),
        ],
        notes='这题的天花板在第 2 问：能不能用"降级只能代码配置"这条框架约束来解释工具分级，'
              '而不是泛泛说"改代码危险"。第 1 问的三条判据只要有一条是"看大盘"就降档。'
              '凡出现"字节内部一定这么实现"或编造内部量级，在第 5 问直接给 0。',
        estimatedMinutes=40,
        answer="""## 参考要点

**1. 三条告警的第一步是三个不同的差值。**
① "成功率没掉但投诉涨 4 倍"：**先算两条曲线的差**。
框架语义写得很清楚 —— 降级后可能直接返回成功 Resp，
而**监控默认按原始结果上报**（可配置成按降级结果上报）。
于是"业务成功率 − RPC 成功率 = 被掩盖的失败率"，
这个差值本身才是告警；单看任何一条都会说"一切正常"。
第一步动作：把降级触发率拉出来、并看响应里 `degraded` 标记的比例。
② "D 的 p99 涨 3 倍但 D 没报警"：**先假设问题在调用方形态而不是被调方负载**。
D 刚做过扩缩容 ⇒ 如果它用了"一致性哈希 + 实例本地缓存"，扩缩容导致 key 重排、
缓存集体 miss、D 每个请求都变贵但**每个请求都不超时**，
所以 D 自己的告警（按错误率/超时率算）不动。
判据要看：inflight 请求数、连接数、缓存命中率、以及"调用方是否从轮询换成了哈希"。
这里有个官方理由可引：默认带权轮询的目的正是"让所有下游实例拥有最小的同时 inflight 请求数"，
换成哈希就失去了这个性质；而文档对哈希的态度本来就是警告式的。
③ "热更后重试占比 3% → 22%"：**先把配置版本时间线叠到曲线上**，
再看"重试停止阈值 vs 熔断阈值"的大小关系是否被破坏
（重试的阈值必须小于服务粒度熔断阈值）。
如果热更把熔断阈值调低到低于重试阈值，结果就是**重试先撞线、熔断抢不到决定权**，
保护对象错位，放大成 22% 的重试流量。

**2. 工具分级要按"框架给了什么合法通道"来分，不是按"感觉危险"。**
可以给 Agent 的只读：指标、日志、配置（含版本历史与 diff）、发布/变更记录、
负载均衡策略与实例权重、链路预算配置来源。
**可以有条件给的写工具**：热更治理阈值（超时/重试/熔断/服务端限流）——
因为这类阈值**本来就有配置中心下发通道**，具备三个特征：
有版本号、可只对部分实例生效（灰度）、可原子回退。
**必须禁止的写工具**：改降级逻辑。
依据不是"改代码风险大"这种空话，而是文档那条硬约束：
Fallback "**涉及业务逻辑，只支持代码配置**" ——
也就是说 Agent 若要有这个能力，只能绕过发布流程（手改线上产物或直接下发不支持的配置），
那等于让它做一个**没有版本、没有灰度、没有回滚**的变更。
同理必须禁止：**修改降级开关**与**修改监控上报口径配置**（后者会污染下一次诊断读到的数据）。
摘流量/重启实例：影响半径大但**可逆**，所以是"需人批准"而不是"禁止"。

**3. 动作三级的判据（三条都用到）。**
- **可逆性**：有没有原子回滚点（配置有版本 = 可逆；数据写入/删除 = 不可逆）。
- **影响半径**：单请求 < 单实例 < 单服务 < 单集群；跨集群的一律人工。
- **是否改变指标口径**：只要会让"成功率/延迟"的定义变化（切上报口径、开降级、
  改统计粒度 key），**一律不许自动**，因为它会让后续诊断建立在被污染的数据上 ——
  这是本条最容易被忽略的判据，也是 SRE Agent 与"运维脚本"的区别。

**4. 因果链要逐环断言，并给出反证。**
证据链：配置 `version=v42 → 下发时刻 t0 → 生效实例集合 S（不是全部）` ；
`t0±ε` 内三条曲线同时刻变化（重试占比、熔断触发次数、下游 D 的 QPS/连接数）；
关键约束被破坏的**静态检查**（`重试停止阈值 ≥ 熔断阈值`，从 v42 的 diff 里直接读出来）；
`ChainStop` / `RetrySameNode` 是否同时被改（前者关了就会级联重试，后者开了会砸同一台）；
**反证**：`S` 之外的实例（同版本未生效）是否也异常 —— 若也异常则这次归因不成立。
还有一条常被漏掉：超时配置有优先级（请求粒度 > 客户端选项 > 动态 provider），
**压测时留下的请求粒度超时会让"热更不生效"看起来像 bug**，
所以断言之前要先确认没有更高优先级的来源。
放大倍数要能算：单跳最坏尝试次数是 `1 + 2 = 3`（默认重试 2 次），
相邻两跳各自重试就是 9 次打到同一下游；`ChainStop` 的作用是把它压回 3 次。

**5. 幻觉防线。**
一条结论要成立，必须同时挂两类东西：**机制锚点**（哪条框架行为/默认值/能力边界支持它）
与**观测证据**（哪两条曲线/哪条日志/哪个配置版本）。缺一即降级为"假设，待验证"，
不许出现在"建议动作"里。
特别地，素材里有一条现成的红线：文档给出的"支持哪些注册中心/配置中心扩展"
是**可扩展性**证据，不是"内部用什么"的证据 ——
Agent 若输出"你们内部用的是 XX"就是幻觉，必须被规则拦掉（黑名单式表述检测 + 引用来源校验）。
错误召回：结论落库时带 `规则版本 + 模型版本 + 引用证据 ID`，
发现某条规则错了 ⇒ 可按版本**批量标记受影响的历史诊断**并通知当事人（否则错过一次就一直错）。
升级流程：**影子跑**（新策略只出结论不执行），产出**决策差异清单**，
人评审差异后才放量 —— 和"自动拦截对商家是真金白银"是同一个道理，
这里"自动动作对线上是真金白银"。

**6. 噪声与产能。**
设夜间告警 `N`、噪声比例 `q`、Agent 自动决出率 `a`、误报放大系数 `k`
（一次误报要消耗的人工复核时间通常是处理一条真告警的 2–3 倍）。
人工真实负担 ≈ `N(1−q)(1−a) + N·a·q·k`（没决出的 + 被错误决出的）。
所以**存在一个"不该自动"的区间**：当某类告警的历史结论准确率低于阈值，
或同窗口并发告警数超过复核产能时，Agent 应退化为**只做信息聚合、不给动作建议**
（"闭嘴"是可计算的状态，不是性格）。
它自己的故障域也要说：Agent 挂掉时值班流程必须照常（它不是告警链路的必经节点），
并且它的写工具通道要能被一键禁用（否则"诊断器"变成新的故障源）。
控制面类的判断可以引一句锚点：单集群做大的核心扩展点是**元数据/状态存储**，
所以 Agent 看容量健康度时应盯元数据 QPS/写放大，而不是节点数 —— 这一条最能区分
"读过开源仓库 README" 和"只会背 K8s 名词"。

**7. 可复算留痕。**
一次"建议摘流量"要留：触发告警 ID 与时间、Agent 读到的**指标快照**（不是只读结论，
要能把当时那几个数原样取回）、配置版本与生效实例集合、命中的规则/模型版本、
候选假设与被排除项及各自证据、最终建议与置信、人工是否批准与改判理由、执行动作与回滚点、
时间戳。复盘"该不该摘"的判据是**同一份输入快照 + 同一版本能否得到同一决策**，
并且能把"摘流量之后的曲线"与"没摘的对照组"放在一起比 ——
没有留输入快照，6 个月后连"当时那个数是多少"都无法复现，
这类 Agent 就只能靠人记忆复盘，等于没有可复算性。

**常见错法**：把"成功率没掉"当成没问题；只看被调方负载不想缓存重排；
说"改代码危险"却引不出那条"只支持代码配置"的约束；
让 Agent 改降级或改上报口径；因果链没有反证环节；
结论不挂机制锚点、把开源默认行为说成内部实现；
答不出"该闭嘴"的判据；留痕只存结论不存输入快照；编一个内部 QPS 数字。""",
    )


@draft('ag-bd-colocation-capacity-agent')
def q_ag_colocation_capacity():
    statement = """## 角色与时长

你要为**字节跳动 基础架构 / 资源效率方向**设计一个**混部与容量治理 Agent**（Senior 轮，35 分钟）。
它的目标很具体：把一批在线业务集群的**空闲资源**卖给离线与训练任务，
并且**不能让在线业务出事**。

## 可核查事实（来自开源组织与各项目 README 的官方表述，不要质疑出处）

- 该开源组织的自我定位："open source organization from ByteDance"，
  目标是 "**million-scale container infrastructure**" 的效率、扩展性与可靠性。
- **混部组件**：提供 QoS 资源模型、水平与垂直弹性伸缩、
  **NUMA/设备拓扑感知调度与分配**，以及"real-time and fine-grained resource
  over-commitment, allocation and isolation strategies for each QoS through
  **auto-tuned workload profiling**"；定位是 "workload colocation"（在离线混部），
  并说明其依赖"KubeWharf enhanced kubernetes"。
- **统一调度器**：一个"集成 quota 管理 + 单一资源池"的调度器；
  用**乐观并发**优化最耗时的 filter/score 匹配以提高大规模集群调度吞吐；
  两级抽象 **Unit / Pod** 提供 "batch" 调度能力；明确面向
  "online, offline (batch, stream), and training" 的统一调度；
  可作为 K8s scheduler 的替代品，"框架接口与上游略有差异但保留插件扩展"。
- **控制面规模锚点**：官方 README 直接给了行业锚点 ——
  "Kubernetes 官方稳定运行规模限制在 **5K 节点**"；
  百万级要走**水平（管 N 个集群）**与**垂直（把单集群做大）**两条路，
  而"要扩大单集群，**元数据/状态信息的存储是核心扩展点之一**"。
- 同组织还有：面向 kube-apiserver 的 Layer7 网关、轻量多租户网关、
  多集群分发（含调度框架、override policy、依赖自动传播与 follower 调度、状态聚合，
  且**支持的 K8s 版本窗口只有 1.16–1.24**，生产部署需自行加认证），
  以及控制面全链路 tracing 组件。
- 训练侧唯一可核查的数字（另一个开源仓库）：通用分布式训练框架支持 TCP 或 **RDMA**，
  官方示例是"BERT-large 训练在 256 GPU 上达到 ~90% 扩展效率"。
- 素材明确列为**不可写**：任何内部集群节点数、机器数、成本账、组织规模。

## 现场参数（**全部是出题假设**，请当假设并说明你要怎么量）

某业务组一个假设 10000 核的集群：各组**已分配（quota）**合计 6000 核，
在线业务近 30 天**画像峰值**假设 3200 核（口径待定，见第 1 问）。
现在有 3 类待安置负载：离线批（可重跑）、流式（不可乱序、有状态）、
以及一个假设 512 卡的训练任务（**成组调度，缺一张卡就不起**）。
Agent 被允许的候选动作：给离线任务放量、下调某组超卖比例、
**驱逐**部分离线实例、发起重排（rebalance）、修改组间 quota 借还参数。

## 请设计（七问，逐条作答）

1. **收益方程**：省多少核怎么算？画像口径（峰值/均值/P99/加权、观察窗多长、
   是否含系统占用）怎么定？给出你算出的**可售核数量级**，
   并说明**这笔账在什么情况下会赔回去**（至少三种形态）。
2. **Agent 的三件事分别给谁**：画像异常检测、超卖比例建议、**驱逐决策** ——
   哪一件可以自动、哪一件必须有人？判据是什么？
   为什么"在线业务的 QoS 等级"不能由 Agent 自己下调？
3. **驱逐优先级与成组任务**：给出你的驱逐排序判据；
   512 卡成组任务被驱逐掉 3 张卡时该怎么办（三种处置与各自代价）；
   "驱逐后在线业务的抖动"这条因果怎么证明，而不是事后归因。
4. **quota 借还与饿死**：给出借还规则（谁优先还、借多久要还、什么情况下强制收回），
   以及**饿死**如何被检测到（信号与阈值方向）。
   为什么"单一资源池 + 集成 quota"会让饿死更容易发生？
5. **控制面风险**：这个集群做大之后，**先崩的是哪里**？
   Agent 该盯哪些指标（不许是"节点数/CPU 使用率"），
   以及"水平扩（多集群）vs 垂直扩（做大单集群）"这条决策 Agent 该不该参与、参与到哪一步。
6. **Agent 自己的开销与故障域**：它的画像与重排计算要占多少资源？
   它挂了谁兜？它的建议如果形成"羊群效应"（多个集群的同一个 Agent 同时给同一结论）怎么办？
7. **可复算**：一次驱逐决策要留哪些字段，
   6 个月后复盘"这次该不该驱"你靠什么算？

## 约束

不许编任何内部集群规模/成本数字（上面给的都是假设，请标注为假设）；
组件名可以引用，但不许把开源 README 的描述当成"你们内部一定这么跑"。"""

    return base(
        'agent-design', 'senior',
        '混部治理 Agent：画像→超卖→驱逐的闭环里谁能按按钮，省下的核要能算出来',
        statement, 'llm-rubric',
        ['colocation-qos', 'resource-overcommitment', 'eviction-policy',
         'quota-fairness', 'control-plane-scale', 'modern:scheduling-efficiency'],
        src('基础架构 / 资源效率方向 AI 工程师（Agent 设计）',
            INFRA + '#4 考点 13（在离线混部与 QoS 资源模型：题面草稿建议'
            '"一个混部方案的收益与风险量化：省多少核、什么情况下赔"；'
            'Katalyst 四件套与 auto-tuned profiling）＋ 考点 14（统一调度、quota 与控制面规模：'
            '"训练任务的成组调度与配额设计，含失败与抢占的处置"；Gödel 三点与 KubeBrain 的'
            '5K 节点锚点、元数据是核心扩展点）＋ §1.7 与其后【推】的"画像→超卖→驱逐"闭环结论'
            '＋ §2 追问 12/13；量级数字按 §7 第 1 条全部标注为假设'),
        language='markdown',
        rubric=[
            ('收益方程与画像口径', 2,
             '必须显式选画像口径并说明后果（用峰值保守、用均值激进、P99 介于两者），'
             '要给出可算的数（示例口径下可售 ≈ 已分配 6000 − 在线画像峰值 3200 = 2800 核量级）'
             '并说明这是"已分配未使用"还是"真实空闲"两个不同的钱；'
             '至少三种赔回去的形态（画像滞后于业务阶跃、驱逐风暴、'
             'NUMA/拓扑约束导致碎片、系统组件占用与预留不足）'),
            ('三件事的归属与 QoS 不许自降', 2,
             '画像异常检测可自动（只读+建议）；超卖比例建议可自动但需人批（影响半径大且改的是策略）；'
             '**驱逐必须有人或强约束的自动**（不可逆地伤别人的任务）；'
             'QoS 等级不能由 Agent 下调的理由要说到位：QoS 等级是**隔离与驱逐顺序的前提**，'
             '降等级等于自己改自己判据（把"我保护不了在线"变成合规），'
             '也直接抵消 auto-tuned profiling 的反馈环'),
            ('驱逐排序与成组任务处置', 2,
             '排序判据要多因子（剩余可重跑代价、已运行时长、组内配额违约度、是否关键路径、'
             '是否可迁移）而不是"挑最小的"；'
             '成组任务被拆必须有第三种以上处置（整体重启并归还资源池 / '
             '预留换卡窗口成组迁移 / 标记不可驱逐并给更高优先级），'
             '并说明"只驱 3 张卡"会让 512 卡任务整组报废这一事实；'
             '因果证明要给出对照与时间线（被驱组与未驱组同窗对比），不许事后讲故事'),
            ('借还规则与饿死信号', 2,
             '借还要有期限与强制收回（"先借先还/按等级收回"任一种自洽规则都行，'
             '但必须回答"什么时候硬收"）；饿死信号要具体'
             '（某组等待时长分位数持续增长、配额使用率长期低于份额、被抢占次数单调上升）；'
             '并解释单一池 + 集成 quota 为什么让饿死更易发生（全局最优放置消除了'
             '资源分区的天然隔离，竞争面从"组内"变成"全局"）'),
            ('控制面视角与观测指标', 1,
             '必须答到"先崩的是控制面元数据/apiserver 链路而不是单机"，'
             '指标要落在调度吞吐与元数据侧（filter/score 队列与调度延迟分位、'
             '元数据存储的 QPS/延迟/写放大、组件间消息堆积、watch 连接与内存），'
             '不许只说节点数与 CPU；对"水平 vs 垂直"要给出 Agent 只给建议、不自动改拓扑'),
            ('Agent 自身故障域与羊群', 1,
             '要量化自身开销并给上限（画像与重排扫描的 CPU/内存预算、采样频率），'
             '挂掉时系统必须能维持最后一次稳定策略（不能因为 Agent 失联就退回"全驱"或"全放"）；'
             '羊群效应要有对策（决策加抖动/分批、跨集群全局并发上限、集中式仲裁而不是各自判）'),
        ],
        notes='本题允许引用开源 README 的定位与机制（含"官方稳定规模 5K 节点""元数据是核心扩展点"'
              '这两句锚点），但集群核数、成本、任务数一律是出题假设。'
              '把"Agent 可以自动下调在线业务 QoS 等级"当成合理设计的，在第 2 问直接给 0。',
        estimatedMinutes=35,
        answer="""## 参考要点

**1. 收益方程：先说清"省的是哪一种钱"。**
可售核数取决于画像口径：
按"已分配 6000 核 − 在线近 30 天画像峰值 3200 核"这种保守口径，
可腾出来的约 2800 核是**已分配但没在用**的钱（配额层面的浪费）；
而"物理 10000 核 − 在线真实峰值 3200 核"是另一笔更大的钱，
里面混着**系统组件占用、碎片、以及为故障预留的容量**，
直接拿去卖就是裸奔。
口径选择要显式辩护：峰值最保守但收益最小；
均值会把"周期性尖峰"当成空闲（**这是混部事故的第一大来源**）；
P99 是常见折中，但窗口要长到覆盖业务周期（30 天里含大促/周末/发版日）。
还要能说清三个补充项：预留余量（故障域内要承接迁移的量）、
NUMA/拓扑约束造成的**不可售碎片**、超卖后的隔离成本（cache/内存带宽/IO 优先级）。
**赔回去的形态**至少三种：
① 画像滞后于**阶跃变化**（新功能上线、活动），画像说闲、实际要打满；
② **驱逐风暴**（一次决策波及过多任务，重跑把资源再次吃满）；
③ 拓扑碎片（腾出来的核不能拼成可用规格，收益兑现不了）；
④ 隔离不彻底导致在线业务被挤占（超卖收益全部赔进 p99）。

**2. 三件事分给三种权限。**
- **画像异常检测**：Agent 全自动（只读 + 打标），判据是"当前实时用量偏离画像分布"。
- **超卖比例建议**：自动出建议 + **人批**，因为它改的是全局策略，影响半径是整个集群，
  而且是**改变后续所有判据的分母**（比例一动，画像与收益账都要重算）。
- **驱逐决策**：默认**需人批准**；只有"可重跑 + 无成组约束 + 已运行时长低于阈值"
  这一类才允许自动，且必须有并发上限与冷却窗。
**为什么 QoS 等级不能让 Agent 下调**：QoS 等级是"谁先被驱、谁先被满足、
隔离强度多大"的**前提**。Agent 若能把在线业务降一档，
它就自动获得了"在线业务被挤占是符合策略的"这个结论 ——
**自己改自己的判据**，闭环失效。
同理，开源组件那句 "auto-tuned workload profiling" 说的是**画像要自动调**，
不是**保护等级自动降**，这两件事混起来就是事故。

**3. 驱逐排序与成组任务。**
排序判据（多因子，要能解释每一次）：
可重跑代价（有没有 checkpoint、已跑多久、是否关键路径上的阻塞者）、
配额违约度（该组是不是本来就借多了）、
业务时段敏感度（夜里批任务的价值 vs 白天）、
**以及"驱掉它能否真的解决当前挤占"**（很多驱逐是无用功，只制造重跑）。
512 卡成组任务缺一张卡就不起 ⇒ 驱 3 张等于报废 512 张的进度。三种处置各有代价：
① 整体重启并归还资源池：最干净，代价是全损进度（要求有 checkpoint 频率这个前置约束）；
② 预留**换卡窗口**做整组迁移：代价是要预留一段"占着但不干活"的资源；
③ 标记为不可驱逐（受保护组）并改驱别的：代价是牺牲部分超卖收益，
   并引入"谁有资格被保护"的公平性问题。
正确的答案一定包含"**成组任务是驱逐的原子单位**"这条建模
（开源调度器把它做成 Unit/Pod 两级抽象、Unit 承载 batch 语义，正是为此）。
**因果证明不能靠事后归因**：驱逐时同时记录
"被驱组"与"同窗未被驱的对照组"的在线业务指标，
时间线上先有挤占上升、后有驱逐、再回到基线，三段齐全才算证据；
否则你只是在讲故事。

**4. 借还规则与饿死。**
规则要三件齐：
① **借出上限**（不超过空闲量的某个比例，给突发留余量）；
② **有期限的借**（到期自动进入"待收回"队列，强制收回触发条件是**所有权方需求回升**）；
③ **收回顺序**（按等级优先收回低优先级借用，而不是按"谁好说话"）。
**饿死的信号**要能扫出来：某组等待时长分位数持续单调增长、
配额使用率长期显著低于其份额、被抢占次数递增、
"借出后一直不还是否被计入它的可用量"（会计口径错误会造成**隐性饿死**）。
为什么"单一资源池 + 集成 quota"让饿死更易发生：
分区式资源池里，一组被饿死是因为它的分区满了 —— **看得见**；
单一池 + 全局配额下，任何一组都可能被"全局最优放置"持续挤到后面，
**竞争面从组内变成全局**，天然缺少隔离边界，所以公平性必须靠显式策略（队列上限、
最大/最小份额、老化加权）来补 —— 这也正是这类调度器把 quota 管理**集成进调度器**的原因。

**5. 控制面视角。**
先崩的不是单机 CPU，是**控制面**：apiserver 与它背后的**元数据/状态存储**
（README 给的两句话就是答案："官方稳定规模限制在 5K 节点"、
"要扩大单集群，元数据/状态信息的存储是核心扩展点之一"）。
Agent 该盯的指标：
调度侧 —— 单位时间调度成功数、filter/score 队列长度与调度延迟分位、
调度重试率（乐观并发的代价就是冲突重试）；
元数据侧 —— 存储的读写 QPS 与延迟、watch 连接数与内存、事件积压、
大对象（含 status 的集合）体积；
组件侧 —— 多集群分发链路的下发积压与状态聚合延迟。
**不许用"节点数/CPU 使用率"当容量健康度**。
水平（多集群）vs 垂直（做大单集群）是**拓扑级决策**：
Agent 只给证据与建议（并列出多集群方案的运维代价，
例如版本窗口约束、跨集群放置与故障域、多集群组件需自行补认证），
切换必须人做。

**6. Agent 自己的开销与羊群。**
画像与重排扫描要**有预算上限**并纳入监控（它跑在哪个 QoS 档？
它自己会不会因为画像扫描把在线业务挤了 —— 混部治理 Agent 挤占在线业务是个真实的自指问题）。
它挂掉时系统必须**保持最后一次稳定策略**（既不自动全驱也不自动全放），
并把"Agent 失联"当一个独立告警。
**羊群效应**：多集群部署同一个策略模型 ⇒ 同一时刻给出同一结论
（例如都把某个离线组驱干净，重跑潮同时发生）。
对策：决策加**随机抖动与分批**、跨集群的全局并发上限、
把"改变全局策略"的动作放到**集中式仲裁**而不是每个 Agent 各判各的。

**7. 可复算。**
一次驱逐决策要留：决策时点的**资源快照**
（物理/已分配/实时用量三方、按 NUMA 与规格拆分的碎片情况）、
画像版本与窗口、超卖比例与隔离配置版本、候选集与各自评分及被排除原因、
最终选择与执行动作、被驱任务标识与其后的重跑代价（跑了多久、烧了多少核）、
在线业务同窗指标与对照组。
复盘"该不该驱"的算法是：拿当时的输入快照重放决策器（同输入 + 同版本 ⇒ 同输出），
再用"**不驱**的反事实"对比（同窗未驱的对照组的在线 p99 与重跑成本）；
重跑代价 / 避免的在线损失 就是这次决策的净值。
没有留输入快照，6 个月后连"当时到底闲不闲"都无法复现，收益账也就无从审计。

**常见错法**：用均值画像（把周期尖峰当空闲）；
让 Agent 自己下调在线 QoS；把驱逐当"挑最小的杀"；
成组任务当成可以逐台驱；只盯节点数与 CPU 当健康度；
水平/垂直扩缩让 Agent 自动切；没有并发上限导致羊群；
答不出饿死的信号；收益账只算"省多少核"而不算兑现率。""",
    )


@draft('hot-bd-consistent-hash-p99-triad')
def q_hot_consistent_hash_p99():
    statement = """## 现场判读（Senior 轮，15 分钟，短题）

线上一致性哈希 + 实例本地缓存的服务，**大促扩缩容之后 p99 涨 3 倍，下游没有任何报警**。
你只有 15 分钟，面试官要你报**前三个动作**和**三种可能结论**。

## 可核查事实（公开框架文档原文，不要质疑出处）

- 默认负载均衡是**带权轮询**，文档写明它的目的："能让所有下游实例拥有**最小的同时 inflight
  请求数**，以减少下游过载情况的发生"；权重全部相等时退化为纯轮询以省开销。
- 另有 `InterleavedWeightedRoundRobin`（把空间复杂度从"最小正周期"降到实例数）与
  **别名法**（O(n) 建表、O(1) 选取）。
- **一致性哈希**的官方态度是警告式的："如果你不了解什么是一致性哈希，或者不知道带来的副作用，
  **请勿使用**"；适用场景是"对上下文（如**实例本地缓存**）依赖程度高的场景"。
- 服务端限流是**两个维度**：连接数与 QPS（默认令牌桶 + 计数器；
  默认 QPS 限流在非多路复用下于 OnRead 生效，按 method 限流才在 OnMessage；
  该限流对 gRPC 协议暂不生效）。
- 网络库的官方问题陈述：标准 `net` 是阻塞 API ⇒ 框架只能 follow "One Conn One Goroutine"；
  且 `net.Conn` 没有"是否存活"的 API ⇒ "难以做出高效的连接池，因为**池子里可能有大量失效连接**"。
- 熔断的默认阈值是错误率 0.5、**最小样本 200**，且"样本不足 200 时配置不生效"。

## 请回答（五问，逐条）

1. "**下游没报警**"这件事本身就是线索。它至少排除了什么、又指向什么？
2. 你的**前三个动作**（按顺序）。每个动作要看到哪个数字才算"排除"或"确认"？
   不许出现"看下监控"这种无法判定的动作。
3. 给出**三种**可能结论，各自的判据与修复动作（其中至少一种要能在 5 分钟内止血）。
4. 为什么"换回轮询"是止血而不是解决？什么场景下一致性哈希**仍然值得用**、
   用了之后必须配套什么？
5. 一个能**提前**抓到这类问题的指标或演练（这次是扩缩容触发的，
   下次可能是健康检查抖动触发的 —— 你要在哪个环节设卡）。"""

    return base(
        'hot-interviews', 'senior',
        '一致性哈希 + 本地缓存：扩缩容后 p99 涨 3 倍而下游没报警，你的三个动作与三种结论',
        statement, 'llm-rubric',
        ['consistent-hashing', 'cache-migration-storm', 'load-balancer-choice',
         'inflight-observability', 'modern:service-governance'],
        src('服务端研发（Go 微服务方向） 高级工程师高频真题',
            INFRA + '#5 题面草稿 C（短题原文："一致性哈希 + 本地缓存的服务，在大促扩缩容后 '
            'p99 涨了 3 倍，下游没报警。你的前三个动作和三种可能结论？"）'
            '＋ #4 考点 5（负载均衡：WRR 的 inflight 目的、等权重退化轮询、'
            '一致性哈希的官方警告与适用场景）＋ 考点 3（连接数与 QPS 两个限流维度）'
            '＋ 考点 2（熔断 MinSample 200 与"样本不足不生效"）＋ §1.3 ＋ §2 追问 7'
            '（"什么时候一定别用"）；连接池失效连接的问题陈述来自 §1.8'),
        language='markdown',
        rubric=[
            ('"没报警"的信息量', 2,
             '必须说出：报警按错误率/超时率算，而"每个请求都变贵但没有失败"不会触发；'
             '因此排除的是"下游被打挂"，指向的是"延迟来源在链路形态变了"'
             '（缓存失效、扇出变大、连接重建）。能补一句"低峰样本不足会让熔断也不生效，'
             '所以连保护都没有触发"算命中更深一层。只答"下游健康"给 0'),
            ('三个动作各自带判据', 4,
             '动作必须是可判定的观测动作并给出数字方向，例如：① 看本地缓存命中率与'
             'key 分布迁移度（命中率断崖 + 重排比例 ⇒ 确认迁移风暴）；'
             '② 看 inflight/连接数与实例间均匀度（换过哈希就失去了 WRR 的 inflight 均摊，'
             '出现倾斜即确认热点）；③ 看每请求的下游调用次数与扇出度是否上升'
             '（本地缓存 miss 后回源放大）。'
             '三个动作里没有一条给"看到什么数字算确认"的最多给 1 分'),
            ('三种结论与止血路径', 2,
             '合格组合：重排风暴（扩缩容导致 key 重排）、热点 key（分布本身不均）、'
             '缓存亲和被健康检查/权重抖动破坏（反复重排循环）；'
             '至少一种给出 5 分钟内可执行动作（切回轮询、预热、分批扩缩容/调虚拟节点数），'
             '并说清副作用；只会"回滚发布"视为没读懂题'),
            ('止血的边界与配套', 1,
             '要说清切回轮询为什么只是止血（本地缓存亲和是这个服务的设计前提，'
             '切回去命中率会继续掉），以及"什么时候仍值得用哈希"（本地缓存/连接亲和收益极大）'
             '与必须配套什么（预热、分批迁移/双读、虚拟节点数、扩缩容窗口冻结策略变更）'),
            ('前置防线', 1,
             '给出可提前的信号：把"实例数变化时的 key 迁移比例"做成扩缩容流水线的卡口或'
             '上线前演练（预发做同规模扩缩容回放并盯命中率曲线），'
             '或在 LB 层把"权重/健康检查抖动导致的重排次数"当指标暴露；'
             '"以后多加注意"不算'),
        ],
        notes='这是素材里现成的 10 分钟短题，判分点在"动作是否可判定"与'
              '"能不能把默认轮询的设计目的（inflight 均摊）讲对"。'
              '引用官方那句"不了解副作用请勿使用一致性哈希"算加分，但不许把它说成"字节内部规定"。',
        estimatedMinutes=15,
        answer="""## 参考要点

**1. "下游没报警"是最强的一条线索。**
报警通常按**错误率/超时率**算。这次的现象是"每个请求都变贵、但没有失败"，
所以下游的可用性指标天然不会动。
它排除了"下游被打挂"，指向的是**链路形态变了**：
每请求的工作量或路径长度上升（缓存 miss、扇出放大、连接重建），而不是容量崩溃。
更深一层：如果同期 QPS 不高，`MinSample 200` 这个门槛会让熔断配置**根本不生效**，
于是"你以为有保护"也没有 —— 这条能说出来说明真读过默认值。

**2. 前三个动作（每个都要有"看到什么算确认"）。**
① **看本地缓存命中率与 key 归属迁移度**：
命中率从常态断崖式下跌、且"扩缩容后 key 落在非原实例"的比例高 ⇒ **确认重排风暴**；
命中率没跌 ⇒ 这条排除，转去查扇出。
② **看 inflight 与实例间均匀度、以及连接数**：
默认带权轮询的设计目的正是"让所有下游实例拥有最小的同时 inflight 请求数"，
换成一致性哈希就**失去了这个性质**；
若出现少数实例 inflight/连接数显著高于其余 ⇒ **确认热点或哈希倾斜**。
③ **看每请求的下游调用次数（扇出度）与回源 QPS**：
缓存 miss 后一次请求要打多次下游 ⇒ 下游"每请求耗时"上升但"错误率"不变，
正好对应现象。顺带看连接层：`net.Conn` 没有存活探测那类 API 的世界里，
扩缩容后池子里会残留**失效连接**，表现为建连/重试开销上升。

**3. 三种结论（各配判据与修复）。**
- **重排风暴**（本次最可能）：扩缩容改变节点环 ⇒ key 大面积重排 ⇒ 缓存集体 miss ⇒
  回源把每请求成本抬高。判据 = ①的命中率断崖 + 迁移度。
  修复：先**切回轮询**（5 分钟内可执行，止血）；或做**预热**（新实例先按 key 分布拉数据再进流量）；
  根治是把扩缩容做成**分批 + 限流迁移**（控制单位时间重排的 key 数）。
- **热点 key**：分布本来就不均，哈希只是把它固定在某几台。
  判据 = 实例级 inflight/连接数倾斜，且倾斜的实例集合在扩缩容前后**换了但仍有**。
  修复：热点打散（多副本 + 随机选、key 加后缀分片）、把热 key 从亲和策略里排除。
- **亲和被健康检查/权重抖动破坏**：健康检查一抖，实例上下线，环反复重排 ⇒
  命中率长时间回不来、CPU 大量花在重建缓存上。
  判据 = 实例上下线事件次数与命中率恢复曲线同步抖动，且没有真实扩容。
  修复：放宽健康检查灵敏度/加抖动容忍、冻结该服务的自动摘除、把实例生命周期与哈希环版本解耦。

**4. 为什么切回轮询是止血。**
切回轮询会把请求打散到**没有缓存的实例**上 ⇒ 命中率短期内继续走低，
但它恢复了 inflight 均摊、并且**打断重排循环**（轮询对实例集合变化的敏感度远低于哈希），
所以它的价值是"让系统停下来呼吸"，不是"修好了"。
**什么时候仍该用哈希**：本地缓存/连接亲和的收益确实极大
（大对象、重计算、必须命中本地才扛得住的场景）—— 官方给的适用场景就是这个。
用了就必须配套：**预热通道、分批迁移或双读、足够的虚拟节点数、
扩缩容窗口内冻结策略变更、以及把"迁移比例"当一等指标**。
只配"我们用了很先进的哈希"没有配套，等于没读那句警告。

**5. 前置防线（该设卡的环节）。**
把 **key 迁移比例**做成扩缩容流水线上的**卡口**：
变更前预估"这次扩缩容会重排多少比例的 key"，超阈值 ⇒ 阻断并要求改成分批；
或者在预发做**同规模扩缩容回放**、盯缓存命中率曲线是否断崖（这类问题完全可演练出来）。
另一条是把"权重/健康检查抖动导致的重排次数"在 LB 层暴露成指标并告警。
只答"以后 code review 注意"是没读懂这题 —— 素材里对短题的期待是**动作 + 结论 + 可提前**。

**常见错法**："重启一下就好了"；"下游没报警说明不是我们的问题"；
只会说"命中率下降"而不给"看到多少算确认"；
不知道默认轮询的设计目的（说不清哈希失去了什么性质）；
建议"以后都用轮询"却不谈本地缓存这个设计前提；把编造的 QPS/实例数当依据。""",
    )


@draft('hot-bd-ab-reading-verdict')
def q_hot_ab_verdict():
    statement = """## 口径评审（Senior 轮，20 分钟）

某实验第 3 天的报告：**实验组人均 GMV +4.1%、标注"显著"**。
把分母从"累计进组去重用户"换成"当日进组用户"之后，变成 **+1.2% 且不显著**。
同期两组的进组人数占比是 **51.3% / 48.7%**（预设分流比例 50/50）。
**这份报告你签不签？按什么顺序判？**

## 可核查事实（公开 A/B 产品文档原文，不要质疑出处）

- 统计方式："以进组用户数为例，多天累计的用户数，即是实验期间**累计进组并去重**后的用户数"。
- 官方对三种口径的评价："相比单天累计，多天累计更能保证各组的样本是「**同质可比**」的；
  相比多天平均，多天累计更易检验出受影响指标的**显著性**，
  因为多天累计使得实验获得了更多样本，这意味着随着实验的进行，
  **实验的检验灵敏度在不断提高**"。
- 更新时点："**实验开启当天按实时统计进组人数，开启第二天之后按 T-1 日天级更新，
  具体口径为截止当天 0 点的实验累计进组人数**"。
- 报告形态：基于假设检验做结论推断；提供**天级趋势图、概率分布图与箱型图**；
  指标类型分**事件指标 / 留存指标 / 漏斗指标**三类；进组用户 ID 可下载
  （"最多可以下载 500 万条数据"）。
- 流量模型：**流量层**（单层内可按比例把 100% 流量分给多个实验，实验内再分多个实验组）与
  **互斥域**（可嵌套子互斥域）；**客户端实验只可添加客户端互斥域，
  服务端实验只可添加服务端互斥域**；"运行中的实验，不支持移除互斥域"；
  "如果一个互斥域中已有运行中实验，则其他运行中实验不能再加入该互斥域，
  但可添加草稿箱及调试中的实验"；选择绑定已创建的流量层时，不支持绑定已关联实验的流量层。
- **正交的机理**（官方例子）：两实验各占 100% 且互不处理时，"一个用户被 A1 命中时，
  同时也会被 B1 命中"→"**B1 组指标涨了，真的是 B1 的策略生效了吗？**"；
  解法是把 A1/A2 各切一半分别进 B1/B2，"这种影响也均匀地分布在实验 B 的两个组之中"；
  实现上"分流服务通过**两次运算「哈希函数」**，使得不同互斥域的流量之间呈正交关系"。
- **打破正交的特例**：父子实验（dependent experiment）—— 流量继承：
  "选择某个正在运行的实验作为『父实验』，从中选择某一组，并将新的实验开设在这组流量之下"。
- 组织级评估：互斥域组可有**保留对照组**，另有**全局保留对照组**
  "评估 3 个部门累加的提升效果，例如评估 APP 的用户生命周期、停留时长、总人均 GMV
  这类大盘级业务指标"，并用于"评估各个团队的实际绩效"。
- 样本量（公开技术文章，署名来自该实验平台团队）：痛点是
  "每次实验需要多少流量""实验时间开多长没有概念"，
  推导路径是"总体/样本/统计量 → 抽样分布 → 参数估计 → 置信区间与置信水平"。

## 素材明确列为**不可写**的内容

该平台的公开文档能核到的是"假设检验、置信区间、显著性、不显著怎么办"与"两次哈希正交"；
**没有**任何页面把"样本比例失配（SRM）检测""多重比较校正""CUPED 类方差缩减""自动停线"
描述成它的官方能力。所以下面第 2、5 问要求你给的是**你自己的判据**，
请标成推断，不许写成"平台官方就是这么规定的"。

## 请回答（七问，逐条作答）

1. 你的**判断顺序**是什么（不是清单，是顺序）？为什么第一眼看的是分母而不是 p 值？
2. 51.3% / 48.7% 在什么样本量下才算"异常"？
   给出你的**检验思路**（含"多大才算显著偏离"从哪来），而不是一个背下来的阈值。
   如果确实异常，为什么"实验作废"优先于"解释业务"？
3. 两种分母各自属于什么域、回答的是什么问题？
   哪一个才能用于实验结论？为什么？
4. 如果这个实验其实是个**父子实验**（开在某个父实验的某一组流量之下），
   你的结论外推边界要改写成什么样？如果它与另一个实验在同一批人身上重叠，你怎么自证清白？
5. "每天看一眼、显著就停"为什么错？给出**三条**你会写进团队规范的替代规则。
6. **缺哪张图 / 哪个数你就拒绝签字**？（至少列三项，并说明各自拦的是哪一类错误）
7. 什么情况下你会要求用**全局保留对照组**而不是实验内对照来做这个决策？
   代价是什么？"""

    return base(
        'hot-interviews', 'senior',
        '第 3 天 +4.1% 显著、换分母变 +1.2% 不显著、进组 51.3/48.7：这份实验报告你签不签',
        statement, 'llm-rubric',
        ['ab-reading-caliber', 'denominator-domain', 'srm-reasoning',
         'parent-child-extrapolation', 'peeking-control', 'modern:experimentation'],
        src('数据研发 / 增长分析方向 高级工程师高频真题',
            DATA + '#5 题面草稿 C（短题原文："某实验第 3 天报告：实验组人均 GMV +4.1% 显著；'
            '但把分母从『累计进组去重用户』换成『当日进组用户』后变成 +1.2% 且不显著。'
            '同时进组人数在两组分别是 51.3% / 48.7%（预设 50/50）。你怎么判？"）'
            '＋ #4 考点 12（实验读数口径：累计去重、同质可比、灵敏度随样本提高、当天实时/次日起 T-1 '
            '截止当天 0 点、三类指标与三张图）＋ 考点 10/11（两次哈希正交、'
            '父子实验打破正交、端/服互斥域不可混用、保留对照组与全局保留对照组）'
            '＋ 考点 13（样本量与时长；窥视与停线按素材 §7 第 4 条只能标【推】）＋ §2 追问 6/7/13'),
        language='markdown',
        rubric=[
            ('判断顺序（分母优先于 p 值）', 2,
             '顺序必须是：① 分母/去重域语义 → ② 进组比例是否失衡 → ③ 流量模型是否被破坏'
             '（同层抢占、父子继承、端/服混用）→ ④ 才看指标本身（分布、极值、趋势）。'
             '理由要说到"分母换了 universe，两组不再同质可比，此时显著性检验的假设已不成立"；'
             '先看 p 值或先解释业务的顺序判 0'),
            ('比例偏离的检验思路', 2,
             '要给出可推导的思路（把 51.3/48.7 看作二项/卡方拟合优度问题、'
             '偏离是否超出该样本量下的随机波动、进组人数越大越敏感），'
             '并明确"多小算异常取决于样本量与累计口径"而不是背一个阈值；'
             '要说明为什么该按**累计进组**而不是按天算；'
             '"实验作废优先"要说理由：分组已经不等价时，任何解释都在解释一个不存在的实验'),
            ('两个分母的域与可用性', 2,
             '要区分"累计去重进组用户"（实验域、官方统计口径、保证同质可比）与'
             '"当日进组用户"（按天重新定义的集合，会随进组节奏与人群构成漂移）；'
             '实验结论只能用前者；并能解释 +4.1% 变 +1.2% 说明提升里混了'
             '**进组节奏/人群构成**的贡献而不是策略效应'),
            ('父子实验的外推边界与自证', 2,
             '必须说"结论只对该人群成立"（子实验开在父实验某组流量之下 ⇒ 外推域被缩小，'
             '官方明写这类继承会打破正交）；自证清白要给出可执行动作：'
             '查另两个实验是否与它共享同一批人、按官方正交思路验证'
             '（同一用户在两个实验的命中组合分布应呈独立、可用联立表看占比偏差），'
             '并检查客户端/服务端实验是否混用了互斥域'),
            ('窥视与停线规则', 1,
             '要说清"检验灵敏度随累计样本提高"是官方事实，但"每天看每天停"会抬高假阳性'
             '（多次检验/最优停止的问题，标注为推断），'
             '替代规则三条且可执行：预注册主指标与时长/样本量、'
             '固定读数时点或带校正的多阶段、停线只对护栏指标随时生效'),
            ('拒签缺项', 1,
             '至少三项且各自拦一类错：概率分布图/箱型图（拦极值与分布偏移）、'
             '天级趋势图（拦新奇效应与分天异动）、分母与去重口径声明（拦 universe 漂移）、'
             '进组人数按组的累计曲线（拦失衡）、数据更新时间点 T-1 声明（拦"把当天当完整")、'
             '实验时长与样本量依据（拦功效不足）。'
             '"缺 p 值"不算缺项'),
        ],
        notes='SRM 检测、多重比较校正、CUPED、自动停线在素材里被明确列为"没有官方能力描述"（§7 第 4 条），'
              '所以候选人把它们写成"字节官方的做法"时，在第 5、6 项扣分；当成自己的工程判据则不扣。'
              '本题的地板是"知道两个分母不是一个东西"，天花板是"能说清为什么显著性在这种情况下已经失去意义"。',
        estimatedMinutes=20,
        answer="""## 参考要点

**1. 顺序：先问"这个数是谁的数"，再问"它显不显著"。**
正确顺序是 ① 分母/去重域 → ② 进组比例 → ③ 流量模型是否被破坏 → ④ 指标本身。
理由不是"口径更重要"这种价值判断，而是**技术性的**：
显著性检验的前提是两组样本来自可比的抽样过程；
分母一换，两组的 universe 就变了，检验假设先不成立，
p 值再小也是在算一个没有意义的量。
所以第一眼看的是"+4.1% 是除以谁"。

**2. 51.3 / 48.7 怎么办。**
把它当**拟合优度**问题：预设 50/50 时，实际进组数的偏离是否超出该样本量下的随机波动
（二项检验或卡方检验，自由度 1）。
关键是**它依赖样本量**：进组各 5000 人时 51.3/48.7 完全可能是噪声；
进组各 500 万人时这是明确的异常（这也说明"背一个 1% 阈值"是错的）。
必须按**累计进组去重**算，而不是按天算 —— 官方统计口径就是"实验期间累计进组并去重"。
（素材里没有把这套检测写成平台官方能力，所以这是"你作为评审人应当补的检验"，答题时标成推断。）
**一旦确认失衡，"实验作废"优先于"解释业务"**：
因为失衡意味着分组过程有问题（分流实现、过滤规则、埋点缺失、某组里混了别的实验的流量），
此时"实验组更好"这句话的主语已经不存在了 ——
先修分组，再谈效应。硬要解释业务，等于给一个坏掉的仪器编读数。

**3. 两个分母是两个不同的问题。**
"累计进组去重用户"属于**实验域**：这半年里进过组的这些人，是一个固定人群，
官方口径评价它"更能保证各组的样本是同质可比的"。
"当日进组用户"属于**当天新进入的人群**：它随进组节奏变化（第 3 天进组的人和第 1 天不一样），
也随当天活跃构成变化。
换分母后从 +4.1% 掉到 +1.2% 且不显著，最合理的读法是：
**原提升里有一大块来自"谁在今天进了组"，而不是"策略改变了谁的行为"** ——
例如实验策略影响了进组本身（入口变更、加载更快导致更多用户完成进组条件）。
实验结论只能用累计去重口径；
另一个数可以留作诊断，但不能进决策表。

**4. 如果它是父子实验。**
官方对父子实验的定位是"**打破正交**"的流量继承：子实验开在父实验某一组流量之下。
那么结论必须改写成："该策略在**父实验 A1 组人群**内 +4.1%"，
**不许外推到全量**（A1 本身就是被上一层策略筛过的人群）。
若它与另一个实验完全重叠在同一批人身上，就无法区分两个策略的贡献 ——
这正是官方那句反问"**真的是 B1 的策略生效了吗？**"的形态。
自证清白的动作：
① 查这两个实验是否在同一互斥域（有运行中实验的互斥域不能再进其他运行中实验）；
② 查是否一个绑了同一个流量层；
③ 用两次哈希的**含义**去验：正交时，同一用户在两个实验的命中组合应近似独立
（联立表里各组合占比 ≈ 两侧占比的乘积；明显偏离就不独立）；
④ 检查端/服互斥域有没有混用（客户端实验只能加客户端互斥域，分流主体不同，混用会让互斥关系失效）。

**5. "每天看一眼、显著就停"。**
"检验灵敏度随累计样本提高"是官方事实 —— 但它说的是**样本越多越容易检出真实效应**，
不等于"可以反复检验然后挑一次显著的"。
反复窥视会把整体假阳性率抬到远超名义水平（多次比较的累积；这一条素材明确标为【推】，
答题时不要写成平台官方规定）。
替代规则（写进规范、可执行）：
① **预注册**：开实验前固定主指标、护栏指标、MDE、所需样本量与运行时长，写进实验单；
② **固定读数**：只在预定天数/样本点做正式判定，需要中途判定就改成带校正的多阶段设计；
③ **停线只对护栏**：安全类指标（崩溃率、投诉、留存断崖）可随时触发停线，
   主指标不许"提前收割"；
④ 时长要覆盖完整周期（周内效应），一天看不出显著就拉长 ≠ 结论。

**6. 缺哪些图/数就拒签。**
- **概率分布图 + 箱型图**（官方报告页就有）：拦"均值被极值拉动"和分布形状变化；
- **天级趋势图**：拦新奇效应（前高后低）与某一天数据断点（口径/埋点事故）；
- **分母与去重主体声明**：拦 universe 漂移（第 3 问那类）；
- **按组累计进人数曲线**：拦分流失衡（第 2 问），并看两组增长节奏是否同步；
- **数据更新时间点声明**：官方口径是"当天实时、次日起 T-1 且截止当天 0 点" ⇒
  第 3 天的报告里"今天"根本不是一个完整日，拿它当结论是错的；
- **样本量/时长依据**：拦功效不足（该平台的公开文章痛点正是"每次实验需要多少流量"
  "实验时间开多长没有概念"）。
指标类型也要看清：事件/留存/漏斗三类的分母与判读方式不同，混着报是常见手法。

**7. 全局保留对照组什么时候必须用。**
当决策对象是"**累加效应**"时 —— 例如"这个季度三个部门的改动合起来让大盘 GMV 涨了多少"，
或"要评估各团队的实际绩效"。
单个实验的对照只能给出**该策略相对当时基线**的增量，
多个实验的增量相加会漏掉交互与重复计算，而全局保留组提供"什么都不改"的那条线。
代价要主动说：它牺牲一组用户的最优体验（对这家公司是真实的收入/体验成本）、
规模必须够大否则测不出大盘级指标、以及**它一旦被污染就永久失去**（不能拿它做实验）。

**常见错法**：先解释"为什么涨 4.1%"；把 51.3/48.7 说成"差不多"或"差 1.3% 没关系"
而不给检验思路；换分母后仍说"两个都对"；
把 SRM/停线写成"字节官方就是这么要求的"；
父子实验结论直接外推全量；第 3 天用"今天"的数下结论；
以及"缺 p 值"当成缺项（p 值这份报告一点都不缺）。""",
    )


@draft('hot-bd-autotracking-cost-attribution')
def q_hot_autotracking_cost():
    statement = """## 归因判读（Senior 轮，20 分钟，短题）

某团队一个季度把**埋点采集量砍了 42%**（关掉全埋点、下线一批"看起来没人用"的事件），
账单很好看。半年后的复盘会上，同一条曲线暴露出下面这组事实：

- 采集量降 **42%**、上报**请求条数**降 40%；
- 但下游**查询量只降了 0.5%**，分析师提的"数据取不到"工单从假设 3 涨到假设 27；
- 同期一次大促的活动复盘，因为某个"非点击行为"没有埋点，只能用一份**估算值**交差。

**问题：这 42% 到底省了什么、赔了什么？谁的功劳、谁的锅？**
不许回答"要看具体情况"，要给出**可判定的分支**。

## 可核查事实（公开产品文档的官方优劣清单，不要质疑出处）

- 全埋点的官方优势："部署 SDK 后即会**自动且持续地收集**……即使最初并未明确指定要分析哪些
  特定事件……因此**可支持数据回溯**——即可以在任何时候对过去的数据进行查询和分析"。
- 全埋点的官方劣势（原文列举）："无差别全量采集，产生无效数据上报，
  **浪费流量/存储/计算资源**"、"**无法采集业务相关属性**"、
  "版本上线后埋点内容迭代灵活性低"、"对开发框架有一定限制"。
- 代码埋点的不可替代性（原文）："尤其是一些**非点击的、不可视**的行为，非代码埋点实现不可
  —— 例如：搜索结果返回、注册结果返回、Banner、楼层、**个性化推荐/千人千面页面**"。
- 官方给出的治理顺序："先规划 → **在控制台录入埋点和属性（先落库）** → 集成 SDK 时配置上报 →
  打开全埋点开关"；停止采集"**无需改代码**"：在元数据管理中**禁用对应事件或属性**，
  或在项目中心关闭全埋点开关；另有"热力图、圈选事件功能**需开启全埋点才可使用**"。
- 影响面可核查信号：事件的"**变更历史**"与"**血缘关系**"
  （图表/看板与用户分群，区分"**直接引用**"与"**间接引用**"，
  分群血缘带"最新分群用户数、**近 30 天的查询次数**"）；
  另有"**实时埋点检测**"用于验证埋点是否正确及数据上传情况。
- 元数据侧的既有状态语义："一般事件列表**仅展示已验收的事件**"；
  建议"**先查看预置事件是否已满足业务需求**，不满足再手动创建自定义事件"。
- 素材里给出的一条【推】结论，你可以引用但要标明是推断：
  埋点是**契约**（名称/属性/上报时机/生效版本/验收人），
  "可回溯"决定了"**全埋点买的是覆盖，代码埋点买的是语义**"，
  因此成本治理的刀法应是"**按下游引用量（血缘）下线事件**"，而不是按采集量。

## 请回答（六问，逐条作答）

1. 这组事实下，"采集量降 42% 而查询量降 0.5%"**至少有三种解释**。
   逐一给出各自的**机制**与**需要什么证据来确认或排除**（不许只说"缓存变好了"）。
2. 两类埋点的分工判据：给出你的分层规则（哪些走代码、哪些走全埋点），
   并明确指出**哪些行为必须代码埋点**（引官方理由）。
3. 为什么"**可回溯**"是全埋点唯一的硬收益？给它算一笔钱：
   你需要哪些量才能估出"这次砍掉到底损失了多少期权价值"？
4. **采样率与开关状态为什么要作为字段随行**？
   不这么做，半年后哪一类分析会**永久不可比**（给两个具体形态）？
5. 三条护栏指标（覆盖、质量、成本各一条），并说明各自的**告警方向**
   （哪个方向涨才是坏消息 —— 有一两项是"越低越坏"的，别搞错）。
6. 下线一个事件的**依据**为什么必须是"间接闭包内消费为零 + 热度为零 + 保留期外"，
   而不是"没人认领"？给出你的执行流程与回滚窗口。
   顺带回答：**这条 42% 的降本曲线，你会不会在半年后的预算里继续承诺？**"""

    return base(
        'hot-interviews', 'senior',
        '全埋点砍掉 42% 之后：采集量、查询量与那份估算值——这条降本曲线有没有骗人',
        statement, 'llm-rubric',
        ['autotracking-tradeoff', 'cost-attribution', 'sampling-version-fields',
         'guardrail-metrics', 'lineage-based-retirement', 'modern:data-governance'],
        src('数据研发（埋点治理与成本方向） 高级工程师高频真题',
            DATA + '#4 考点 5（全埋点 vs 代码埋点的成本-覆盖取舍：官方优劣原文清单、'
            '"非点击不可视行为非代码埋点不可"、题面草稿建议'
            '"给定采集量/存储单价/需求结构，决定两类埋点比例并给三条护栏指标"）'
            '＋ #4 考点 4（血缘与下线判据：直接/间接引用 + 近 30 天查询次数 + 保留期）'
            '＋ #4 考点 3（治理顺序"先落库再上报"、禁用即停止上报、验收态、预置事件优先）'
            '＋ §1.2 末段的【推】契约结论（"全埋点买的是覆盖，代码埋点买的是语义"、'
            '按下游引用量下线）＋ §2 追问 8/9'),
        language='markdown',
        rubric=[
            ('三种解释各自带证据', 3,
             '至少三种且机制不同：① 砍掉的是**冷数据**（低频分区/长尾事件），'
             '查询集中在热数据 ⇒ 成本不随采集量线性下降，证据=存储分层账单与查询的分区命中分布；'
             '② 采集与查询**不是同一把账**（一次采集被 N 次查询复用 ⇒ 砍采集不砍查询），'
             '证据=查询数几乎没动这件事本身就是证据，再给扫描字节/查询的分布；'
             '③ 砍掉的数据被**重定向**到临时表/手工导入/日志捞取 ⇒ 成本转移而非消失，'
             '证据=工单量涨 27 倍方向 + 非标准表存储增长 + 分析师侧临时脚本数量；'
             '④（可选）时间混淆：大促带来的自然增长被平均掉了，证据=分月趋势而非首尾两点。'
             '只答"缓存变好/口径变了"而不给确认方法的给 0'),
            ('分层规则与必须代码埋点的清单', 2,
             '规则要能落到判定（转化漏斗骨架/交易与留存关键节点/需要业务属性的 ⇒ 代码埋点；'
             '页面与控件级长尾交互 ⇒ 全埋点 + 采样），'
             '并明确"搜索结果返回、注册结果返回、Banner、楼层、个性化推荐/千人千面"这类'
             '**非点击不可视行为**必须代码埋点（引官方理由：全埋点无差别采集无法采到业务属性）'),
            ('可回溯的期权价值算法', 2,
             '要说清全埋点买的是"**半年后还能问当时没规划的问题**"这份期权，'
             '并列出估价需要的量：过去 12 个月里"临时起意"的分析需求占比、'
             '这些需求里有多少只能靠全量历史回答、'
             '补采一次的历史成本与可补窗口（补不到就是硬损失）、'
             '以及一次错误决策的业务代价（用大促那份估算值举例）；'
             '只说"留着保险"不给量的最多 1 分'),
            ('采样/开关状态随行的后果', 1,
             '必须给出两个"永久不可比"的具体形态：'
             '① 采样率变了但数据里没有 ⇒ 同比时新旧期被当成同口径，'
             '率的绝对值漂移被解释成业务波动；'
             '② 全埋点开关关掉的那段区间 ⇒ 控件级/未规划事件在那段区间**根本不存在**，'
             '热力图与圈选功能（官方明写需开启全埋点）出现空洞，'
             '跨该区间的人群对比失效'),
            ('三条护栏与告警方向', 1,
             '覆盖：下游引用覆盖率或未登记上报占比（越低越坏）；'
             '质量：必填属性缺填率、跨端同名属性一致率（越高越坏）；'
             '成本：单位有效查询的采集成本或无效上报占比（越高越坏）。'
             '必须明确方向，尤其"覆盖率下降是坏消息"这一条常被搞反'),
            ('下线依据与回滚，以及对预算的态度', 1,
             '要说清"没人认领"为什么不够（间接引用链上的消费看不见、分群→投放最贵）、'
             '流程要含"先禁用可恢复、后清理不可恢复"两级 + 回滚窗口（覆盖报表重跑周期），'
             '并明确这条降本曲线**不可线性外推**（越往后砍掉的越接近有用数据，边际收益递减、'
             '风险递增），在预算里承诺同一斜率是错'),
        ],
        notes='素材把"成本治理应按下线依据=间接闭包+热度"标为【推】，所以候选人这么说是加分而非违规；'
              '但把"字节的埋点流程就是这样"当官方事实陈述要扣分。'
              '本题真正的分差在第 1 问：能不能给出"成本转移"这一类解释并给确认方法。',
        estimatedMinutes=20,
        answer="""## 参考要点

**1. 三种以上解释，且每种都能被判真/判假。**
先摆一个事实：**采集量、查询量、账单是三本不同的账**。采集是"写侧流量"，
查询是"读侧作业"，账单是"分层存储 + 计算 + 传输的组合"。
所以"采集降 42%、查询只降 0.5%"本身**不是矛盾**，而是提示我们砍错了地方。
- **解释 A：砍掉的是冷数据。** 采集量的大头落在低频访问分区与长尾事件上，
  而查询集中在最近 N 天与少数高频事件 ⇒ 账单降得多、查询量不动。
  确认方法：看存储分层账单变化 + **查询命中的分区分布**
  （如果查询本来就只扫最近 7 天，砍 6 个月前的历史当然不影响查询）。
- **解释 B：一次采集被多次查询复用。** 采集是 O(1)，查询是 O(N)，
  砍采集只是把"写入次数"降下来，读侧一份查询都没省。
  证据其实已经摆在题面上（查询量 0.5%），进一步要看**扫描字节/查询**是否变化。
- **解释 C：成本被转移，没有被消灭。** 事件下线后需求没消失 ⇒
  变成临时表、手工导入、从原始日志捞、或者那份"估算值"。
  确认方法：非标准表存储增长曲线、"数据取不到"工单 3 → 27、
  分析师侧临时脚本/调度任务数量、以及临时查询任务的算力账单。
  **工单量涨这个方向，几乎可以单独确认 C。**
- **解释 D：时间混淆。** 单季首尾对比会把大促与季节性平均掉。
  确认方法：看**分月**趋势与同比基线，而不是取两个端点。
坏答案的共同点是"应该是缓存变好了吧"——不可判定。

**2. 分层规则。**
可判定的分工：
- **代码埋点**：转化漏斗骨架、交易与留存关键节点、任何**需要业务属性**的事件、
  以及官方点名的"**非点击、不可视**"行为 —— 搜索结果返回、注册结果返回、Banner、楼层、
  个性化推荐/千人千面页面。
  理由要引官方那条：全埋点"**无法采集业务相关属性**"、无差别采集 ⇒
  那些"没有点击动作但有业务含义"的事件，全埋点**结构上采不到**。
- **全埋点 + 采样**：页面/控件级长尾交互、探索期需求、热力图与圈选分析
  （官方明写这两个功能**需要开启全埋点**才可用 —— 砍掉等于砍功能，不是砍成本）。
顺序也别搞反：官方流程是"**先规划 → 控制台录入落库 → 集成 SDK 配置上报 → 打开全埋点开关**"，
"先看预置事件是否已满足需求"，最后才是新建自定义事件。
把"关全埋点开关"当第一刀，是典型的**用倒序做治理**。

**3. "可回溯"值多少钱。**
全埋点买的不是"数据多"，是**期权**：半年后还能问当时没规划的问题
（官方原话："即使最初并未明确指定要分析哪些特定事件……可以在任何时候对过去的数据进行查询和分析"）。
要估这份期权的价，需要的量：
① 过去 12 个月里"**临时起意**"的分析需求占比（不是规划内的）；
② 其中有多少**只能靠全量历史**回答（能靠补采回答的不算损失）；
③ **补采窗口**：关掉之后能补多久的历史？（补不到才是硬损失；
  且延时/回溯能力在链路上有硬边界，比如消息侧延迟上限就明确写着"最长 3 天或保留时长的 3 倍取小"）；
④ 一次错误决策的业务代价 —— 大促那份"估算值"就是这次的行权价，
  拿它和这季度省下的账单比，才是这笔交易的**净收益**。
只说"留着当保险"不给这四个量，等于没算。

**4. 采样率与开关状态必须随行。**
不这么做会造成**永久性**不可比（不是"有噪声"，是"没法修"）：
- 形态①：采样率从 20% 调到 5% 而数据里没有标记 ⇒
  同比时率的绝对值整体漂移，被解释成"用户行为变了"。
  事后**无法反推**当期采样率，除非去翻发布记录（而发布记录不是数据）。
- 形态②：全埋点关闭的那段区间，控件级/未规划事件**根本不存在** ⇒
  跨这段区间做任何"人群/路径"对比都会出现空洞，
  热力图与圈选在那段区间直接不可用。
所以要做的是把 **采集开关状态 + 采样率 + SDK/端版本 + 生效时间**作为维度落在数据里
（素材里那句"两层都要把采样与开关状态作为字段随行，否则历史不可比"是【推】，
但它是"先落库再上报 + 禁用即停止采集"这两个官方动作的自然结论）。
另一层含义：**停止采集不需要改代码** ⇒ 状态变化的成本极低、频率极高，
不留字段就会频繁出现"无人记得改过"的断层。

**5. 三条护栏与方向。**
- **覆盖**：下游有引用但已不可用的事件数（应为 0，>0 即坏）、
  或未登记上报占比（"未录入先上报"，越低越好）。**注意"采集覆盖率下降"是坏消息。**
- **质量**：必填属性缺填率、跨端同名属性的单位一致率（前者越高越坏、后者越低越坏）。
- **成本**：单位**有效查询**的采集成本（分子是账单、分母是被引用的数据量），
  或"无效上报占比"（越低越好）。
方向搞反是最常见的失分点：如果护栏只有"采集量"，那这次 42% 看起来是满分。

**6. 下线依据与预算态度。**
"没人认领"不够，因为**真正的消费往往在间接引用上**：
事件 → 明细表 → 报表 → **用户分群 → 投放/触达**，
分群那一层没人"认领"这个事件，但它带着"最新分群用户数、近 30 天查询次数"。
所以判据是**间接闭包内消费为零 + 热度为零 + 保留期外**三条同时成立
（素材明确把这条标为【推】的完整判据；且深度上限不该是常量，
要看"这条链还活不活"）。
执行流程：登记候选 → 拉间接闭包与热度 → 通知**闭包内所有节点 owner**（不是"问一圈"）→
**先禁用（可恢复）**并观察一个完整报表周期 + 一个同比周期 →
无异常再清理存储（不可恢复操作单独审批）→ 全程留痕（事件级变更历史本来就存在）。
回滚窗口至少要覆盖"月度报表 + 大促复盘"，否则你会在下次大促时发现砍错了。
**关于预算**：这条曲线**不可线性外推** ——
前 42% 砍掉的是明显的噪声，越往后砍掉的越接近有用数据，
**边际收益递减、边际风险递增**。
所以半年后的预算里不该再承诺同一斜率；
正确姿态是"把降本从砍采集改成按真实查询模式设计（物化、分区与生命周期分级）"，
并用第 1 问那三类证据证明省下的钱是真的。

**常见错法**：把"查询量没降"说成缓存的功劳；
只按采集量排序下线；认为全埋点可以替代代码埋点（采不到业务属性与不可视行为）；
护栏只设成本不设覆盖；砍开关时不留采样率/开关状态字段；
说"以后需要再补采"却不检查补采窗口；
以及把这次 42% 当成明年可以承诺的基线。""",
    )


if __name__ == '__main__':

    os.makedirs(OUT_DIR, exist_ok=True)
    if '--list' in sys.argv:
        for k in sorted(DRAFTS):
            print(k)
        raise SystemExit(0)
    for key, fn in sorted(DRAFTS.items()):
        path = os.path.join(OUT_DIR, f'{key}.json')
        payload = fn()
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'wrote {os.path.relpath(path, ROOT)}')
    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.json'):
            json.load(open(os.path.join(OUT_DIR, name), encoding='utf-8'))
    print(f'全部 {len(DRAFTS)} 份草稿 JSON 可解析')
