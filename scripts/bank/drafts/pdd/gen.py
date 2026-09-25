#!/usr/bin/env python3
"""
PDD（拼多多）方向题目草稿生成器（30 题：18 道可机器判 + 12 道主观题）。

取材纪律：只出在 `content/knowledge/hot-interviews/pdd-transaction-and-inventory.md`
与 `pdd-data-and-recommendation.md` 里标了【源】的**官方字段枚举 / 状态机 / 接口约束**上 ——
那些地方天然有唯一正确答案，能机器判分。
凡素材标【推】或"未核实而放弃的方向"（成团时限、QPS、内部栈选型、百亿补贴规则、
Temu 托管模式）一律不进题面；题面里出现的量级数字都在题面内自证为假设。

代码题的 expected **全部由本文件里的 Python 模型算出**，不手算；
`precheck.py` 再用另一份独立重写跑同一批用例；`probe_naive.py` 负责把答案里
写死的数字从已入库的文案里抠出来跟数据对。三道闸门分工见 docs/ADD_QUESTIONS.md。

用法：
    python scripts/bank/drafts/pdd/gen.py            # 生成到 data/drafts-pdd/out/
    python scripts/bank/drafts/pdd/gen.py --list     # 只列已登记的题目标识
"""
import json
import os
import sys
from decimal import Decimal

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-pdd', 'out')

TXN = 'content/knowledge/hot-interviews/pdd-transaction-and-inventory.md'
DATA = 'content/knowledge/hot-interviews/pdd-data-and-recommendation.md'

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
    # 主观题的 rubric 允许写成 [(label, weight, criteria), ...] + notes=…，
    # 在这里统一折叠成 schema 要的形状：Question 是 .strict() 的，
    # 顶层多一个 notes 字段会被 zod 直接拒（所以在进入 q 之前就必须收进去）。
    notes = extra.pop('notes', None)
    rb = extra.get('rubric')
    if isinstance(rb, list):
        extra['rubric'] = rubric(rb, notes)
    elif rb is not None and notes:
        rb['notes'] = notes
    q.update(extra)
    return q


def src(role, ref):
    return {
        'company': 'PDD',
        'role': role,
        'location': 'shanghai',
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
    用例名说 A、内容做 B 这种事不许留到矩阵（矩阵只比参考解与朴素解的结果差异，看不见命名）。
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


# =================================================================== A1 投影库存的假有货
@draft('alg-pdd-phantom-stock')
def q_phantom_stock():
    """库存是商家系统的镜像：占用同步扣镜像，回补/下调走异步同步通道。
    两条时间线一旦错位，投影就会大于商家真库存 —— 那才是"假有货"的构造性定义。"""

    def phantom_stock(stock, lag, ops):
        if stock < 0:
            raise ModelError('negative initial stock')
        if lag < 0:
            raise ModelError('negative lag')
        pending = []            # (apply_index, kind, qty)
        real = stock
        proj = stock
        peak = 0
        oversold = 0
        rejected = 0

        def flush(i):
            nonlocal real, proj
            keep = []
            for (a, k, q) in pending:
                if a <= i:
                    if k == 2:
                        proj += q
                    elif k == 3:
                        proj -= q
                    else:
                        proj = q
                else:
                    keep.append((a, k, q))
            pending[:] = keep

        for i, op in enumerate(ops):
            if len(op) != 2:
                raise ModelError('op must be [kind, qty]')
            kind, qty = op[0], op[1]
            if kind not in (1, 2, 3, 4):
                raise ModelError('unknown op kind')
            if qty < 0:
                raise ModelError('negative qty')
            flush(i)
            if kind == 1:                       # 占用：同步，扣的是投影
                if proj < qty:
                    rejected += 1
                else:
                    backed = qty if real >= qty else (real if real > 0 else 0)
                    oversold += qty - backed
                    proj -= qty
                    real -= qty
            elif kind == 2:                     # 团失败回补：真库存立刻回来，投影等通道
                real += qty
                pending.append((i + lag, 2, qty))
            elif kind == 3:                     # 商家下调：真库存立刻掉，投影等通道
                real -= qty
                pending.append((i + lag, 3, qty))
            else:                               # 商家库存同步（绝对值）
                real = qty
                pending.append((i + lag, 4, qty))
            flush(i)                            # lag == 0 时同一事件内就要落地
            gap = proj - real
            if gap > peak:
                peak = gap
        return [peak, oversold, rejected]

    statement = """## 背景（这家公司的库存不是你的库存）

平台侧**不持有库存**：商品由第三方商家供货，商家随时可以通过开放平台接口改库存与价格。
所以平台扣的不是真库存，而是商家系统的一份**投影**。投影靠同步通道更新，同步通道有滞后。

于是有一类事故是构造性的：**占用走同步、回补与商家下调走异步**，两条时间线一错位，
投影就会大于商家真库存 —— 屏幕上是"有货"，货架上是没有的。这叫**假有货**，
它比假缺货贵得多：假缺货只是少卖，假有货是收了钱发不出货（还要按 48 小时发货承诺赔付）。

## 你要实现的入口

```java
public static int[] phantomStock(int stock, int lag, int[][] ops)
```

返回 `int[]{假有货峰值, 超卖件数, 被拒占用次数}`（按这个顺序，三个都是 `int`）。

## 模型（照这些算，别自己发明）

初始时刻商家真库存 `real` 与平台投影 `proj` 都等于 `stock`。
`ops[i] = [kind, qty]` 按数组下标 `i` 当作第 `i` 个事件时刻，四种事件：

| kind | 事件 | 对真库存 `real` | 对投影 `proj` |
| --- | --- | --- | --- |
| 1 | 下单占用 `qty` | 立刻 `-= qty` | **立刻** `-= qty`（同步扣镜像） |
| 2 | 团失败回补 `qty` | 立刻 `+= qty` | 在 `i + lag` 时刻才 `+= qty` |
| 3 | 商家下调 `qty` | 立刻 `-= qty` | 在 `i + lag` 时刻才 `-= qty` |
| 4 | 商家库存同步为 `qty` | 立刻 `= qty` | 在 `i + lag` 时刻才 `= qty` |

每个事件时刻 `i` 的处理顺序是固定的：

1. 先把所有 `apply_index <= i` 的**待落地异步更新**落到投影上；
2. 再执行本事件（真库存立刻变；kind=1 投影立刻变，其余排入 `i + lag`）；
3. 再落一次 `apply_index <= i`（这样 `lag == 0` 表示同步通道零延迟，同一时刻就落地）；
4. 用这一步结束后的 `proj - real` 更新峰值。

**只在这条事件流的时间线内统计**：`i + lag` 超出数组长度的异步更新不会落地，也不参与统计
（那就是"同步通道还没追上，作业先结束了"——真实系统里由下一轮对账兜底）。

三个输出的定义：

- **假有货峰值** = 所有事件时刻结束后的 `max(0, proj - real)` 的最大值；
- **超卖件数**：kind=1 只在 `proj >= qty` 时被接受。接受后，
  这笔里有 `qty - min(qty, max(real, 0))` 件是**真库存撑不住的**，累加进这个数
  （注意 `real` 可以为负 —— 那是"平台欠商家的货"，不许夹到 0）；
- **被拒占用次数** = 因为 `proj < qty` 而被挡下的 kind=1 事件条数。
  被拒的占用**不改**任何库存。

## 必须抛 `IllegalArgumentException` 的情况（消息文本要一致）

- `ops` 里某行不是恰好 2 列 ⇒ `op must be [kind, qty]`
- `kind` 不在 1..4 ⇒ `unknown op kind`
- `qty < 0` ⇒ `negative qty`
- `lag < 0` ⇒ `negative lag`
- `stock < 0` ⇒ `negative initial stock`

校验顺序就按上面这个先后（先列数、再 kind、再 qty）；`stock`/`lag` 在进循环之前查。

## 复杂度

`O(n + 事件数)`，不许嵌套扫描整个 pending（用"到期即落地"的过滤即可）。"""

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  public static int[] phantomStock(int stock, int lag, int[][] ops) {
    if (stock < 0) throw new IllegalArgumentException("negative initial stock");
    if (lag < 0) throw new IllegalArgumentException("negative lag");

    List<long[]> pending = new ArrayList<>();   // [applyIndex, kind, qty]
    long real = stock, proj = stock;
    long peak = 0, oversold = 0;
    int rejected = 0;

    for (int i = 0; i < ops.length; i++) {
      int[] op = ops[i];
      if (op == null || op.length != 2) throw new IllegalArgumentException("op must be [kind, qty]");
      int kind = op[0];
      long qty = op[1];
      if (kind < 1 || kind > 4) throw new IllegalArgumentException("unknown op kind");
      if (qty < 0) throw new IllegalArgumentException("negative qty");

      proj = flush(pending, i, proj);           // 1) 到期的异步更新先落到投影

      if (kind == 1) {                          // 2) 占用：同步扣镜像
        if (proj < qty) {
          rejected++;
        } else {
          long backed = Math.min(qty, Math.max(real, 0));
          oversold += qty - backed;
          proj -= qty;
          real -= qty;
        }
      } else {
        if (kind == 2) real += qty;
        else if (kind == 3) real -= qty;
        else real = qty;
        pending.add(new long[] {(long) i + lag, kind, qty});
      }

      proj = flush(pending, i, proj);           // 3) lag == 0 时同一时刻就要落地
      peak = Math.max(peak, proj - real);       // 4) 假有货峰值
    }
    return new int[] {(int) peak, (int) oversold, rejected};
  }

  /** 把 apply_index <= at 的异步更新落到投影上，返回新的 proj；没到期的留在队列里。 */
  private static long flush(List<long[]> pending, int at, long proj) {
    List<long[]> keep = new ArrayList<>();
    for (long[] p : pending) {
      if (p[0] <= at) {
        int kind = (int) p[1];
        long qty = p[2];
        if (kind == 2) proj += qty;
        else if (kind == 3) proj -= qty;
        else proj = qty;                        // kind == 4：绝对值覆盖
      } else {
        keep.add(p);
      }
    }
    pending.clear();
    pending.addAll(keep);
    return proj;
  }
}"""

    naive = """public class Solution {
  // "把投影当库存"版：只维护一个数，异步通道 = 不存在。
  // 症状是"我们库存扣得好好的，怎么会超卖"—— 因为屏幕上的数从来不是货架上的数。
  public static int[] phantomStock(int stock, int lag, int[][] ops) {
    long proj = stock;
    int rejected = 0;
    for (int[] op : ops) {
      long qty = op[1];
      if (op[0] == 1) {
        if (proj < qty) rejected++;
        else proj -= qty;
      } else if (op[0] == 2) {
        proj += qty;
      } else if (op[0] == 3) {
        proj -= qty;
      } else {
        proj = qty;
      }
    }
    return new int[] {0, 0, rejected};   // 假有货与超卖永远是 0：这道题根本没建模真库存
  }
}"""

    answer = """## 参考答案要点

两条账本 + 一个待落地队列。核心不是算术，是**承认投影和真库存是两个变量**：
占用打在投影上（同步），商家侧的变化打在真库存上（立刻）并排队等 `lag` 个事件才落到投影。
`proj - real` 的最大值就是要找的"假有货件数"。

**为什么 kind=3（商家下调）会造出假有货**：商家把真库存改小这一刻，真库存立刻掉，
但镜像要等同步通道。这段时间里投影比货架多，多出来的部分会被占用事件**当成真货卖掉** ——
`超卖件数` 这一列量的是同一件事的事后代价。
基线用例「基线：商家把库存同步成 0 而同步通道滞后 2 步」量的就是这条链：
`t1` 商家把库存同步成 0 ⇒ 真库存立刻归零、投影还要等 2 步 ⇒ `proj - real = 15` 成为峰值；
`t2` 那笔 4 件占用完全落在这 15 件假货上 ⇒ 超卖 4；
`t3` 同步终于落地（投影归 0）⇒ 这笔被挡下，被拒 1 条。**三个输出各自盯住事故的一环。**

**为什么 kind=2（团失败回补）单向造成假缺货**：回补让真库存立刻回来，投影滞后 ⇒ `proj < real`，
`proj - real` 不为正 ⇒ 峰值不涨。这是**安全方向**的误差（少卖），所以本题的峰值只对
kind=3/4 敏感。用例「全是团失败回补：只造成假缺货，假有货峰值必须是 0」专门钉这一点：
峰值 0，但被拒占用是 1 —— 那 1 条就是"假缺货"唯一的可见症状。

**`lag == 0` 不等于"没有异步通道"**（用例「边界：lag=0 表示通道同刻落地」）：它是"通道足够快，
同一事件时刻内就落地"。实现里必须在事件处理**之后再 flush 一次**，否则 `apply_index == i`
的更新永远等不到（因为下一轮 flush 只处理 `<= i+1`，看起来也落了 —— 但 kind=4 的覆盖顺序会不同步）。
这类"边界上少跑一次"的 bug 不会报错，只会让峰值偏小。

**被拒占用不改任何库存**（用例「边界：投影不足时占用被拒」）：`proj < qty` 时既不扣投影也不扣真库存，
只把计数器加一。实现里如果"先扣再判"就会把真库存扣成负的、还漏记一次拒绝 ——
这正好对应真实事故里最难查的一种：**下单失败率涨了，而库存对账说一切正常**。

**工程延伸（面试追问点）**

1. 为什么"宁可假缺货也不能假有货"？（假缺货的成本是少卖，可度量、可追回；
   假有货的成本是收钱不发货 ⇒ 触发 48 小时发货赔付 + 缺货处置流程 + 消费者投诉，
   且**发现时刻远晚于发生时刻**。所以投影的偏差要按方向分别设阈值。）
2. `lag` 怎么量出来？（它是同步通道的端到端滞后分布，不是常数：
   用"调整单受理时刻 → 投影生效时刻"的差值分位数，按商家分桶（大商家的队列更长）。
   题面把它写成一个常数**是出题假设**，真实系统里它必须是个分布 + 上界告警。）
3. 只有这两个账本够吗？（不够。还需要**第三条**：商家 ERP 的口径快照。
   两本账对不上只能知道"有偏差"，三本账才能定位是"同步没到"还是"商家改了没上报"。
   这就是官方为什么给调整单（`move_order_sn` 唯一）而不只给一个库存查询接口。）
4. 怎么在不放宽窗口的前提下把偏差压小？（把占用做成"预扣 + 最后一步确认前再校验一次真库存"：
   校验失败的单走缺货处置而不是硬发。代价是每单多一次读，收益是假有货被挡在支付前。）
5. 这个 SLI 该挂在哪？（挂成两个数：**投影准确率**（`|proj-real| / real` 的分布）
   与**发货前重算拦截率**。前者是通道健康度，后者是止损有效性 ——
   只看第一个会漏掉"偏差一直在但从来没被拦住"。）"""

    return base(
        'algorithms', 'senior',
        '库存是商家的镜像：占用同步、回补与商家下调异步，算出"假有货"峰值与超卖件数',
        statement, 'java-junit',
        ['inventory-projection', 'async-sync-lag', 'oversell-detection', 'dual-ledger',
         'modern:data-consistency'],
        src('服务端研发（交易/库存方向） 高级工程师',
            TXN + '#1 核心机制（"平台不控制商品，库存是商家系统的镜像"＋'
            '`pdd.stock.ware.move` 的 `move_direction=3 库存同步` 官方枚举＋'
            '考点 1「投影落后于真库存时宁可假缺货不能假有货」；素材只给结论，未给可判分的双账本模型）'),
        language='java',
        cases=[
            jcase('基线：商家把库存同步成 0 而同步通道滞后 2 步 ⇒ 假有货峰值 15',
                  [20, 2, [[1, 5], [4, 0], [1, 4], [1, 3]]], phantom_stock,
                  note='t1 商家改库存为 0：真库存立刻归零，投影还要等 2 步 ⇒ proj-real=15 就是峰值；'
                       't2 那笔 4 件没有真库存支撑 ⇒ 超卖 4；'
                       't3 时同步终于落地（proj 归 0）⇒ 这笔被挡下，被拒 1 条'),
            jcase('全是团失败回补：只造成假缺货，假有货峰值必须是 0',
                  [10, 3, [[1, 6], [2, 4], [1, 5]]], phantom_stock,
                  note='回补让 real 立刻回来、proj 滞后 ⇒ proj-real 不为正。'
                       '"异步一定会超卖"在这里被证伪；被拒的那 1 条就是假缺货的症状'),
            jcase('边界：lag=0 表示通道同刻落地，下调当场就反映到投影 ⇒ 峰值 0',
                  [20, 0, [[3, 15], [1, 5]]], phantom_stock),
            jcase('边界：投影不足时占用被拒，且不许改动任何库存',
                  [5, 2, [[1, 6], [1, 5]]], phantom_stock,
                  note='第一笔 proj(5) < 6 ⇒ 拒绝且不扣；第二笔正好扣光 ⇒ 峰值 0、超卖 0'),
            jcase('退化：没有任何事件 ⇒ 三个数都是 0', [100, 2, []], phantom_stock),
            jcase('商家绝对值同步（kind=4）把投影拉回真值，之后放行不再造成超卖',
                  [30, 1, [[1, 10], [3, 12], [1, 8], [4, 10], [1, 6]]], phantom_stock,
                  note='滞后期内峰值 12；同步落地后投影从 0 回到 10 ⇒ 最后那笔 6 件有真货撑着'),
            jcase('非法：事件不是 [kind, qty] 两列', [10, 1, [[1]]], phantom_stock,
                  throws='IllegalArgumentException', throws_message='op must be [kind, qty]'),
            jcase('非法：未知事件类型', [10, 1, [[7, 3]]], phantom_stock,
                  throws='IllegalArgumentException', throws_message='unknown op kind'),
            jcase('非法：数量为负', [10, 1, [[1, -2]]], phantom_stock,
                  throws='IllegalArgumentException', throws_message='negative qty'),
            jcase('非法：滞后期数为负', [10, -1, [[1, 2]]], phantom_stock,
                  throws='IllegalArgumentException', throws_message='negative lag'),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] phantomStock(int stock, int lag, int[][] ops)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== A2 官方金额口径
@draft('alg-pdd-pay-amount')
def q_pay_amount():
    """pay_amount 有官方加法构成；promotion_type=30 的注释写着"已包含在平台优惠里" ——
    重复相加就是双计。把公式与"已包含"做成纯函数，是唯一能机器判分的口径考法。"""

    def settle_amount(base_amt, promotions):
        if len(base_amt) != 11:
            raise ModelError('base must have 11 fields')
        (unit_price, qty, change_discount, post_fee, service_fee, platform_discount,
         seller_discount, captain_free, declared_pay, national_subsidy, subsidy_type) = base_amt
        if qty < 0:
            raise ModelError('negative qty')
        if subsidy_type not in (0, 1, 2):
            raise ModelError('unknown subsidy type')
        extra = 0
        for promo in promotions:
            if len(promo) != 2:
                raise ModelError('promotion must be [type, amount]')
            ptype, amount = promo[0], promo[1]
            if amount < 0:
                raise ModelError('negative promotion amount')
            if ptype != 30:
                extra += amount
        goods = unit_price * qty - change_discount
        discount = platform_discount + seller_discount + captain_free
        pay = goods - discount + post_fee + service_fee
        subsidy = platform_discount + extra
        if subsidy_type == 1:
            subsidy -= national_subsidy
        if subsidy < 0:
            raise ModelError('negative platform subsidy')
        return [goods, discount, pay, declared_pay - pay, subsidy]

    statement = """## 背景

拼多多开放平台的订单对象里金额字段有**官方口径公式**，面试里自己另写一套 GMV 公式是硬伤。
官方给的是三条：

```
pay_amount     = 商品金额 − 折扣金额 + 邮费 + 服务费
goods_amount   = 商品销售价格 × 商品数量 − 订单改价折扣金额
discount_amount = 平台优惠 + 商家优惠 + 团长免单优惠金额
```

还有一个专门写在字段注释里的坑：**`promotion_type = 30`（以旧换新优惠）——"优惠金额已包含平台优惠金额里"**。
也就是说把它再加一次就是**双计**。另一层是国补：
`trade_in_national_subsidy_amount_type` 取 `1 支付优惠 / 2 商家优惠`，
出资方不同 ⇒ 算不算"平台真实让利"就不同。

## 你要实现的入口

```java
public static long[] settleAmount(long[] base, int[][] promotions)
```

`base` 是**定长 11 列**（顺序写死，钱一律以**分**为单位）：

| 下标 | 字段 |
| --- | --- |
| 0 | `unitPrice` 商品销售价格 |
| 1 | `qty` 商品数量 |
| 2 | `changeDiscount` 订单改价折扣金额 |
| 3 | `postFee` 邮费 |
| 4 | `serviceFee` 服务费 |
| 5 | `platformDiscount` 平台优惠金额 |
| 6 | `sellerDiscount` 商家优惠金额 |
| 7 | `captainFreeDiscount` 团长免单优惠金额 |
| 8 | `declaredPayAmount` 订单上**记着的** `pay_amount` |
| 9 | `nationalSubsidyAmount` 以旧换新国补金额 |
| 10 | `subsidyType` 国补出资分型：0 无国补 / 1 支付优惠 / 2 商家优惠 |

`promotions[i] = [promotion_type, promotion_amount]` 是这笔订单的优惠明细行（分单位）。

返回 `long[]{goods_amount, discount_amount, pay_amount_formula, identity_diff, platform_subsidy}`。

## 口径（逐条都是判分点）

1. `goods_amount = unitPrice × qty − changeDiscount`。
2. `discount_amount = platformDiscount + sellerDiscount + captainFreeDiscount`。
   **国补金额不许再加**：`subsidyType = 1` 时它是支付渠道出的钱，
   `subsidyType = 2` 时它已经含在 `sellerDiscount` 里 —— 两种情况都不是官方三项之和的第四项。
3. `pay_amount_formula = goods_amount − discount_amount + postFee + serviceFee`。
   邮费与服务费是**加项**（很多人按"实付 = 货款减优惠"漏掉它们）。
4. `identity_diff = declaredPayAmount − pay_amount_formula`。
   0 表示恒等式成立；不为 0 就是要被拉出来对账的行。**符号有意义**：正数 = 订单表多收了钱。
5. `platform_subsidy`（平台真实让利）`= platformDiscount + Σ(promotion_amount where promotion_type != 30)`；
   当 `subsidyType == 1` 时再减去 `nationalSubsidyAmount`（那笔是支付渠道出的，不是平台出的）。
   **`promotion_type = 30` 的明细行一律不加** —— 官方注释说它已包含在 `platformDiscount` 里。

## 必须抛 `IllegalArgumentException` 的情况（消息文本要一致）

- `base` 不是 11 列 ⇒ `base must have 11 fields`
- `qty < 0` ⇒ `negative qty`
- `subsidyType` 不在 {0,1,2} ⇒ `unknown subsidy type`
- 明细行不是 2 列 ⇒ `promotion must be [type, amount]`
- 明细金额为负 ⇒ `negative promotion amount`
- 算出的 `platform_subsidy < 0` ⇒ `negative platform subsidy`
  （这不是防御性编程：它意味着"`subsidyType=1` 的国补金额比平台优惠还大"，
  即**数据自相矛盾**，静默夹到 0 会让一笔出资认定错误变成一条看不出来的正常记录。）

校验顺序按上面列出的先后。明细行内部先查列数再查金额。

## 为什么必须是 `long`

`unitPrice × qty` 在分单位下很容易超过 `int`（单价 1 万元 × 10 万件 = 10¹⁰ 分）。
本题有专门的用例会打到这个点上。"""

    reference = """public class Solution {
  public static long[] settleAmount(long[] base, int[][] promotions) {
    if (base == null || base.length != 11) throw new IllegalArgumentException("base must have 11 fields");
    long unitPrice = base[0], qty = base[1], changeDiscount = base[2], postFee = base[3];
    long serviceFee = base[4], platformDiscount = base[5], sellerDiscount = base[6];
    long captainFree = base[7], declaredPay = base[8], nationalSubsidy = base[9];
    int subsidyType = (int) base[10];
    if (qty < 0) throw new IllegalArgumentException("negative qty");
    if (subsidyType < 0 || subsidyType > 2) throw new IllegalArgumentException("unknown subsidy type");

    long extra = 0;
    for (int[] promo : promotions) {
      if (promo == null || promo.length != 2) throw new IllegalArgumentException("promotion must be [type, amount]");
      int type = promo[0];
      long amount = promo[1];
      if (amount < 0) throw new IllegalArgumentException("negative promotion amount");
      // promotion_type == 30（以旧换新）官方注释：金额已包含在平台优惠里 ⇒ 再加就是双计
      if (type != 30) extra += amount;
    }

    long goods = unitPrice * qty - changeDiscount;                       // 必须整体在 long 域里算
    long discount = platformDiscount + sellerDiscount + captainFree;      // 国补不是第四项
    long pay = goods - discount + postFee + serviceFee;
    long subsidy = platformDiscount + extra;
    if (subsidyType == 1) subsidy -= nationalSubsidy;                     // 支付渠道出的钱
    if (subsidy < 0) throw new IllegalArgumentException("negative platform subsidy");
    return new long[] {goods, discount, pay, declaredPay - pay, subsidy};
  }
}"""

    naive = """public class Solution {
  // "所有优惠都加一遍才保险"版：把"已包含"当注释没写，并且漏掉邮费与服务费。
  public static long[] settleAmount(long[] base, int[][] promotions) {
    int unitPrice = (int) base[0];
    int qty = (int) base[1];
    int platform = (int) base[5];
    int discount = platform + (int) base[6] + (int) base[7];
    int goods = unitPrice * qty - (int) base[2];
    int subsidy = platform;
    for (int[] promo : promotions) {
      discount += promo[1];     // 错：连 promotion_type=30 也加进折扣
      subsidy += promo[1];      // 错：双计"已包含"的那笔
    }
    int pay = goods - discount; // 错：邮费与服务费没加
    return new long[] {goods, discount, pay, base[8] - pay, subsidy};
  }
}"""

    answer = """## 参考答案要点

五个数都是**同一套公式的不同投影**，写出来才是"背过官方口径"，写不出来就是"自己发明过一套"。
判分集中在三处：`promotion_type = 30` 只进一次、邮费与服务费是加项、国补按出资分型决定归不归平台。

**基线那笔的手算**（用例「基线：恒等式差 2600」，用来核对 expected 是不是真的对）：
`goods_amount = 10000 × 3 − 500 = 29500`；
折扣三项相加 `2000 + 800 + 200 = 3000`；
实付 `29500 - 3000 = 26500`，再加邮费与服务费 `26500 + 600 + 300 = 27400`；
恒等式差 `30000 - 27400 = 2600` ⇒ 这一行本身就是要被拉出来对账的问题行；
平台让利 `2000 + 500 = 2500` —— 那笔 `type=30` 的 1200 分**不加**，
因为官方注释说它已含在 `platformDiscount` 里。

**"已包含"三个字的杀伤力**：把明细表当成独立事实再累加一次，平台让利就变成 `2500 + 1200 = 3700`。
在营销复盘里这意味着"平台多掏了 1200 分"，而真实是同一笔钱被记了两次 ——
**双计不会报错，只会让复盘数字变好看**，所以它活得很久。

**国补出资分型为什么必须单独一列**：`type=1 支付优惠` 的钱是支付渠道出的、
`type=2 商家优惠` 的钱已含在 `sellerDiscount` 里。两者都**不该**进"平台真实让利"，
但原因不同：前者是"不是平台出的"，后者是"已经算过了"。
把它们合并成一个布尔值，下一次新增第 3 种出资方时就会静默算错 ——
这也是官方为什么要单独开一个 `trade_in_national_subsidy_amount_type` 字段。

**`platform_subsidy < 0` 必须抛而不是夹到 0**：出现负数只有一种可能 ——
`subsidyType=1` 的国补金额比 `platformDiscount` 还大，即两个字段在互相矛盾。
夹到 0 会产出一条"平台零让利"的正常记录，之后谁也查不到这笔账；
抛错则是把**数据契约破坏**留在原地。这类"报错换静默"的取舍，senior 必须能主动说清是哪一类
（本题属于"错了没人能发现"那一类，所以必须抛）。

**必须用 `long`**：单价 20 亿分 × 5 件 = 10¹⁰，`int` 会绕成负数。
朴素解把 `unitPrice`/`qty` 强转 `int` 再相乘，于是它在"极大"用例上直接给出荒谬的 `goods_amount`。

**工程延伸（面试追问点）**

1. 为什么"买家实付 ≠ 商家应收 ≠ 平台收入"？（实付含邮费与服务费；商家应收要扣平台佣金与
   商家承担的优惠；平台收入只有佣金那一段。三个数各自有各自的分母，混起来就是"GMV 争议"。）
2. 退款怎么摊？（按**分摊比例**回冲而不是按面额：一笔优惠由三方出资时，
   退 1 件要按 `各出资额 / goods_amount` 拆，否则会出现"退款额 > 实付额"。）
3. 开票按哪个金额？（按买家实付扣除服务费/邮费归属之后的货款部分，且平台优惠与商家优惠的
   开票主体不同 —— 这正是"出资方必须是一等属性"的现实版本。）
4. 恒等式校验放在哪一层？（写入时强校验会挡业务（改价、赔付都会临时破坏恒等式），
   所以正确做法是**落库照常、校验做成指标**：`identity_diff != 0` 的行数与金额分布
   进 DQC，超阈值阻断结算而不是阻断下单。）
5. 这套公式变了怎么办？（官方字段口径变更必须**显式公告 + 冻结可比区间**，
   历史数据用当期口径重算会同时改掉同比环比 —— 这是口径治理，不是算术。）"""

    return base(
        'algorithms', 'senior',
        '官方金额口径：pay_amount 的加法构成与 promotion_type=30 的"已包含"双计陷阱',
        statement, 'java-junit',
        ['amount-caliber', 'double-counting', 'subsidy-attribution', 'money-precision',
         'modern:finance-consistency'],
        src('服务端研发（交易/营销方向） 高级工程师',
            TXN + '#1 核心机制 2（`pay_amount`/`goods_amount`/`discount_amount` 三条官方公式、'
            '`promotion_type=30 已包含在平台优惠里`、`trade_in_national_subsidy_amount_type` 出资分型）'
            '＋ §5 题面草稿 A 第 1、2 问；素材只给了字段清单，未做成可判分函数'),
        language='java',
        cases=[
            jcase('基线：恒等式差 2600 的问题行，type=30 那笔不许多加',
                  [[10000, 3, 500, 600, 300, 2000, 800, 200, 30000, 1200, 0],
                   [[30, 1200], [10, 500]]], settle_amount,
                  note='goods 29500 / discount 3000 / pay 27400 / diff 2600 / 平台让利 2500；'
                       '把 1200 那笔再加就变 3700（双计）'),
            jcase('国补归属支付渠道（type=1）：平台让利要把国补剔出去',
                  [[5000, 2, 0, 0, 0, 3000, 0, 0, 7000, 1000, 1], [[30, 1000]]], settle_amount,
                  note='goods 10000、discount 3000 ⇒ pay 7000、diff 0；让利 = 3000 − 1000 = 2000'),
            jcase('国补归属商家（type=2）：已含在 sellerDiscount，不再减也不再加',
                  [[5000, 2, 0, 0, 0, 1000, 1500, 0, 8500, 1000, 2], []], settle_amount),
            jcase('没有优惠明细行：让利就等于平台优惠本身',
                  [[100, 1, 0, 0, 0, 0, 0, 0, 100, 0, 0], []], settle_amount),
            jcase('退化：零数量订单 ⇒ goods 只剩负的改价折扣',
                  [[9999, 0, 300, 0, 0, 0, 300, 0, -300, 0, 0], []], settle_amount,
                  note='goods = −300、discount = 300 ⇒ pay = −600，diff = 300 —— '
                       '口径题必须能诚实输出负数，而不是"看起来正常"'),
            jcase('极大：单价 20 亿分 × 5 件，int 会绕成负数',
                  [[2000000000, 5, 0, 0, 0, 0, 0, 0, 10000000000, 0, 0], []], settle_amount),
            jcase('非法：base 少了列',
                  [[100, 1, 0, 0, 0, 0, 0, 0, 100], []], settle_amount,
                  throws='IllegalArgumentException', throws_message='base must have 11 fields'),
            jcase('非法：数量为负',
                  [[100, -1, 0, 0, 0, 0, 0, 0, 100, 0, 0], []], settle_amount,
                  throws='IllegalArgumentException', throws_message='negative qty'),
            jcase('非法：未知出资分型（3 不在 0/1/2 里）',
                  [[100, 1, 0, 0, 0, 0, 0, 0, 100, 0, 3], []], settle_amount,
                  throws='IllegalArgumentException', throws_message='unknown subsidy type'),
            jcase('非法：优惠明细行不是两列',
                  [[100, 1, 0, 0, 0, 0, 0, 0, 100, 0, 0], [[7]]], settle_amount,
                  throws='IllegalArgumentException', throws_message='promotion must be [type, amount]'),
            jcase('非法：优惠金额为负',
                  [[100, 1, 0, 0, 0, 0, 0, 0, 100, 0, 0], [[10, -5]]], settle_amount,
                  throws='IllegalArgumentException', throws_message='negative promotion amount'),
            jcase('非法：国补比平台优惠还大 ⇒ 出资认定自相矛盾，不许夹到 0',
                  [[10000, 1, 0, 0, 0, 500, 0, 0, 9500, 800, 1], []], settle_amount,
                  throws='IllegalArgumentException', throws_message='negative platform subsidy'),
        ],
        runner={'className': 'Solution',
                'signature': 'long[] settleAmount(long[] base, int[][] promotions)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer=answer,
    )


# =================================================================== A3 倒序分页的漏单模型
@draft('alg-pdd-increment-paging')
def q_increment_paging():
    """官方把增量拉单限制成"窗口 ≤30 分钟 + 按 updated_at + 必须倒序分页"。
    这三句合起来是一个可模拟的模型：窗口左边界在推进 ⇒ 正序翻页会跳过还在窗口里的行。"""

    def window_miss(window_seconds, initial_rows, page_size, total_steps, drift):
        if window_seconds <= 0:
            raise ModelError('window must be positive')
        if window_seconds > 1800:
            raise ModelError('window exceeds 1800 seconds')
        if initial_rows < 0:
            raise ModelError('negative initial rows')
        if page_size <= 0:
            raise ModelError('page size must be positive')
        if total_steps < 0:
            raise ModelError('negative steps')
        if len(drift) != total_steps:
            raise ModelError('drift length must equal steps')
        for d in drift:
            if len(d) != 2:
                raise ModelError('drift must be [dropFront, addTail]')
            if d[0] < 0 or d[1] < 0:
                raise ModelError('negative drift')

        rows = list(range(initial_rows))
        responsibility = list(range(initial_rows))
        nxt = initial_rows
        seen = {'f': set(), 'r': set()}
        final_list = list(rows)
        for s in range(total_steps):
            drop, add = drift[s][0], drift[s][1]
            del rows[:min(drop, len(rows))]
            for _ in range(add):
                rows.append(nxt)
                responsibility.append(nxt)
                nxt += 1
            final_list = list(rows)
            for tag in ('f', 'r'):
                n = len(rows)
                if tag == 'f':
                    lo, hi = s * page_size, (s + 1) * page_size
                else:
                    lo, hi = max(0, n - (s + 1) * page_size), max(0, n - s * page_size)
                seen[tag].update(rows[lo:hi])
        in_window = set(final_list)
        safe = {'f': 0, 'r': 0}
        for tag in ('f', 'r'):
            for rid in final_list:
                if rid in seen[tag]:
                    safe[tag] += 1
                else:
                    break
        missed = {tag: sum(1 for rid in in_window if rid not in seen[tag]) for tag in ('f', 'r')}
        return [missed['f'], missed['r'], safe['f'], safe['r']]

    statement = """## 背景

`pdd.order.number.list.increment.get` 的参数注释里写着三句话：

1. 按**最后更新时间**（`updated_at`）切片，**开始时间结束时间间距不超过 30 分钟**；
2. 注释原文：**"必须采用倒序的分页方式（从最后一页往回取）才能避免漏单问题"**；
3. `order_status` 只有 `1 待发货 / 2 已发货待签收 / 3 已签收 / 5 全部`。

前两句话合起来就是一道题：**为什么正序会漏单，倒序又解决了什么、没解决什么。**
这题把那三句话变成一个可以精确模拟的模型，跑一遍你就知道两种翻页各漏几条。

## 你要实现的入口

```java
public static int[] windowMiss(int windowSeconds, int initialRows, int pageSize,
                               int totalSteps, int[][] drift)
```

返回 `int[]{正序漏单数, 倒序漏单数, 正序安全前缀, 倒序安全前缀}`。

## 模型（照这些算）

- 窗口里的行按 `updated_at` **升序**排列。行的身份就是它在作业开始时刻的位置编号
  `0 .. initialRows-1`；运行中新进窗口的行拿到递增的新编号（新 `updated_at` 一定更大 ⇒ 排在**队尾**）。
- 作业一共跑 `totalSteps` 步，每步只做两件事：
  1. **先施加这一步的漂移** `drift[s] = [dropFront, addTail]`：
     从**队头**丢掉 `dropFront` 行（窗口左边界向前推进 ⇒ 这些行掉出窗口，本次作业再也查不到它们），
     再在**队尾**加入 `addTail` 行（有新的 `updated_at` 落进窗口右半边）。
  2. **再读一页**：
     - 正序：读当前列表的下标区间 `[s × pageSize, (s+1) × pageSize)`；
     - 倒序：读**从队尾数第 `s` 页**，即下标区间
       `[max(0, n − (s+1) × pageSize), max(0, n − s × pageSize))`，`n` 是**当前**列表长度。
- 一页读了几行算几行；同一行被读到多次只算"读到过"。
- `totalSteps == 0` 时不施加任何漂移也不读页，列表保持初始状态。

两个输出列的定义（**都只针对作业结束时仍在窗口里的那批行**）：

- **漏单数** = 结束时还在窗口内、但整个作业一次都没读到的行数；
- **安全前缀** = 从结束时的**队头**开始，连续被读到过的行数（遇到第一个没读到的就停）。
  它是"水位线能推到哪儿"：只有安全前缀覆盖到的那段，才允许把 `updated_at` 推过去。

掉出窗口的那些行**不计入漏单数**（它们不该由这次作业负责 —— 但也不会凭空消失：
真实系统必须靠"按成交时间的全量集合差集"补拉，这题只量化翻页方式本身造成的差别）。

## 必须抛 `IllegalArgumentException` 的情况（消息文本要一致）

- `windowSeconds <= 0` ⇒ `window must be positive`
- `windowSeconds > 1800` ⇒ `window exceeds 1800 seconds`（**官方 30 分钟硬上限**）
- `initialRows < 0` ⇒ `negative initial rows`
- `pageSize <= 0` ⇒ `page size must be positive`
- `totalSteps < 0` ⇒ `negative steps`
- `drift.length != totalSteps` ⇒ `drift length must equal steps`
- `drift[s]` 不是 2 列 ⇒ `drift must be [dropFront, addTail]`
- 漂移值为负 ⇒ `negative drift`

参数校验就按这个顺序，先标量、再 `drift` 的长度、最后逐行。

## 这题真正考的东西

想清楚"为什么倒序不跳过"只需要一个不变量：**队头掉行时，每一行"从队尾数的位置"不变，
而从队头数的位置全体左移。** 正序用的坐标会漂，倒序用的坐标不漂 —— 就这么简单。
反过来，倒序会把风险挪到**窗口左边界**上：等你读到队头时它可能已经掉出去了。
所以官方那三句话必须一起用（窗口不能宽、必须倒序、还要有差集补拉），少一条都不成立。"""

    reference = """import java.util.LinkedHashSet;
import java.util.Set;

public class Solution {
  public static int[] windowMiss(int windowSeconds, int initialRows, int pageSize,
                                 int totalSteps, int[][] drift) {
    if (windowSeconds <= 0) throw new IllegalArgumentException("window must be positive");
    if (windowSeconds > 1800) throw new IllegalArgumentException("window exceeds 1800 seconds");
    if (initialRows < 0) throw new IllegalArgumentException("negative initial rows");
    if (pageSize <= 0) throw new IllegalArgumentException("page size must be positive");
    if (totalSteps < 0) throw new IllegalArgumentException("negative steps");
    if (drift == null || drift.length != totalSteps) {
      throw new IllegalArgumentException("drift length must equal steps");
    }
    for (int[] d : drift) {
      if (d == null || d.length != 2) throw new IllegalArgumentException("drift must be [dropFront, addTail]");
      if (d[0] < 0 || d[1] < 0) throw new IllegalArgumentException("negative drift");
    }

    java.util.List<Integer> rows = new java.util.ArrayList<>();
    for (int i = 0; i < initialRows; i++) rows.add(i);
    int next = initialRows;

    Set<Integer> seenF = new LinkedHashSet<>();
    Set<Integer> seenR = new LinkedHashSet<>();
    java.util.List<Integer> last = new java.util.ArrayList<>(rows);

    for (int s = 0; s < totalSteps; s++) {
      int drop = Math.min(drift[s][0], rows.size());
      for (int k = 0; k < drop; k++) rows.remove(0);       // 队头：掉出窗口
      for (int k = 0; k < drift[s][1]; k++) rows.add(next++);  // 队尾：新 updated_at 落进窗口
      last = new java.util.ArrayList<>(rows);

      int n = rows.size();
      addAll(seenF, rows, s * pageSize, Math.min(n, (s + 1) * pageSize));
      int lo = Math.max(0, n - (s + 1) * pageSize);
      int hi = Math.max(0, n - s * pageSize);
      addAll(seenR, rows, lo, hi);
    }

    int missF = 0, missR = 0;
    for (Integer id : last) {
      if (!seenF.contains(id)) missF++;
      if (!seenR.contains(id)) missR++;
    }
    return new int[] {missF, missR, prefix(seenF, last), prefix(seenR, last)};
  }

  private static void addAll(Set<Integer> to, java.util.List<Integer> rows, int lo, int hi) {
    for (int i = Math.max(0, lo); i < Math.min(hi, rows.size()); i++) to.add(rows.get(i));
  }

  /** 从窗口队头起连续已读的行数 = 水位线可安全推进的位置。 */
  private static int prefix(Set<Integer> seen, java.util.List<Integer> last) {
    int k = 0;
    while (k < last.size() && seen.contains(last.get(k))) k++;
    return k;
  }
}"""

    naive = """public class Solution {
  // "步数 × 页大小 ≥ 总行数就一定读全"版：完全不模拟窗口漂移，
  // 于是两种翻页给出同一个答案，漏单永远报 0 —— 这正是线上"我们不可能漏单"的说法。
  public static int[] windowMiss(int windowSeconds, int initialRows, int pageSize,
                                 int totalSteps, int[][] drift) {
    int covered = 0;
    for (int s = 0; s < totalSteps; s++) {
      int lo = s * pageSize;
      int hi = Math.min(initialRows, (s + 1) * pageSize);
      covered += Math.max(0, hi - lo);
    }
    int missed = Math.max(0, initialRows - covered);
    return new int[] {missed, missed, initialRows - missed, initialRows - missed};
  }
}"""

    answer = """## 参考答案要点

模型只有三行：施加漂移 ⇒ 按各自坐标取一页 ⇒ 结束时对着窗口算两个数。
真正要想清楚的是**倒序为什么不跳过**：

> 队头掉行时，每行"从队尾数的位置"不变；而"从队头数的位置"全体左移。

正序用的坐标会漂，所以第 `s` 页取到的永远是"比预期靠后 `已掉出行数` 行"的内容 ——
被跨过去的那几行既没被读到，也不会再出现在任何后续页里。倒序用的坐标不漂，
所以窗口内一定读全，代价是队头那些行可能在轮到它之前就掉出去了（不计入漏单，但必须补拉）。

**基线（用例「基线：窗口左边界每步推进」）手算**：6 行、页大小 2、3 步、漂移 `[[0,0],[1,0],[1,0]]`。

| 步 | 施加漂移后的窗口 | 正序读 | 倒序读 |
| --- | --- | --- | --- |
| 0 | 0 1 2 3 4 5 | 0 1 | 4 5 |
| 1 | 1 2 3 4 5 | 3 4 | 2 3 |
| 2 | 2 3 4 5 | （越界，空） | 2 3 |

结束时窗口 = 2 3 4 5。正序读到 {0,1,3,4} ⇒ 漏 2 条（2 和 5）；
倒序读到 {2,3,4,5} ⇒ **漏 0 条**。安全前缀同理是 0 对 4。
**同样是"读了 3 页"，一个漏一半，一个一条不漏** —— 差别全在坐标会不会漂。

**倒序不是万能的（用例「反方向：每步往队尾加一行」）**：把漂移换成"每步往队尾加一行"，
正序反而更好（漏 2 对漏 4）。
因为新增行出现在队尾，倒序从队尾读会反复读到同一批新行，把队头的老行饿死。
这就是"倒序分页解决跳过问题、但解决不了窗口右扩的问题"——
**所以官方还要求窗口 ≤30 分钟**：窗口足够窄时，右扩的量在一个作业周期内是有界的。

**窗口越界必须显式失败（用例「非法：窗口超过官方 30 分钟上限」）**：传 31 分钟就抛
`window exceeds 1800 seconds`。
"参数越界 ⇒ 悄悄截断到 30 分钟"会造出一个更坏的系统：调用方的水位线是按 31 分钟推的，
而平台每次只给它 30 分钟的数据 ⇒ **每个周期都稳定漏掉一分钟的窗口**，
而两边日志都说自己没错。宁可拒绝服务，也不许静默少给。

**水位线为什么只能推到安全前缀**（第 3、4 个输出）：
把水位线推到"本次请求的最大 `updated_at`"是错的 —— 你根本没读完。
正确判据是"从队头起连续已读"。
用例「边界：步数刚好覆盖初始行数且窗口不动」里窗口不漂移，两种翻页的安全前缀都等于整个窗口，
所以都可以放心推水位线；而基线用例里正序即使"看起来把 3 页都读完了"，安全前缀仍是 0。

**工程延伸（面试追问点）**

1. 只靠倒序够吗？（不够。倒序保证的是"这次查询不漏读"，不保证"该被这次查询看见的行真的在窗口里"
   —— 更新把 `updated_at` 推到窗口之外、或上游把时间写成未来值，都会绕过这个保证。
   所以标准解法是三通道：分钟级增量 + 按成交时间的全量校对 + **订单号集合差集补拉**。）
2. 怎么**证明**没漏单？（漏单率本身做成 SLI：全量集合基数 − 已拉取留痕基数 = 缺口。
   "和商家对一下"不是证明，是甩锅。）
3. 大商家单窗口几十万行怎么办？（窗口分片倾斜：按商家维度二次分桶，
   同一个 30 分钟窗口拆成多个子作业，但**水位线必须整体推进**，
   否则某个子桶失败会把整条链的水位线卡住 —— 那是最容易做成"看起来在跑其实在原地"的地方。）
4. `order_status=5 全部` 这个取值为什么危险？（它是**筛选值**混进了**枚举值**同一列语义。
   按状态做分桶统计时如果没排除 5，同一批行会被数两遍。
   这题不判它，但面试里能主动点出来才是真做过口径治理。）
5. 上游把 `updated_at` 写成未来时间怎么办？（不能推进水位线，也不能直接丢弃：
   进"未来时间隔离区"+ 不参与水位线 + 告警。丢弃等于承认"这条订单不存在"，
   而它只是时间戳坏了。）"""

    return base(
        'algorithms', 'senior',
        '倒序分页为什么防漏单：把官方"窗口≤30 分钟 + 按 updated_at + 必须倒序"跑成一次模拟',
        statement, 'java-junit',
        ['incremental-sync', 'reverse-pagination', 'watermark', 'missed-record',
         'modern:data-consistency'],
        src('服务端研发（交易/开放平台方向） 高级工程师',
            TXN + '#1 核心机制 3（`pdd.order.number.list.increment.get` 的三条官方约束原文）'
            '＋ §2 追问 3「正序为什么会漏单」＋ §5 题面草稿 C；素材只给了结论，未给可判分的模拟模型'),
        language='java',
        cases=[
            jcase('基线：窗口左边界每步推进，正序漏 2 条、倒序一条不漏',
                  [1800, 6, 2, 3, [[0, 0], [1, 0], [1, 0]]], window_miss,
                  note='正序漏单 2 / 安全前缀 0；倒序漏单 0 / 安全前缀 4（结束时窗口只剩 4 行）'),
            jcase('反方向：每步往队尾加一行，正序漏 2 条、倒序漏 4 条',
                  [1800, 6, 2, 3, [[0, 0], [0, 1], [0, 1]]], window_miss,
                  note='倒序从队尾读，反复读到刚进来的新行，把队头的老行饿死'),
            jcase('非法：窗口超过官方 30 分钟上限，必须拒绝而不是截断',
                  [1860, 6, 2, 1, [[0, 0]]], window_miss,
                  throws='IllegalArgumentException', throws_message='window exceeds 1800 seconds'),
            jcase('退化：一步都不跑 ⇒ 一行都没读到，漏单数等于结束时窗口行数',
                  [1800, 3, 1, 0, []], window_miss,
                  note='totalSteps=0 ⇒ 不读任何页；漏单 3 对 3、安全前缀 0 对 0'),
            jcase('边界：步数刚好覆盖初始行数且窗口不动 ⇒ 两种翻页都不漏',
                  [1800, 4, 2, 2, [[0, 0], [0, 0]]], window_miss),
            jcase('边界：掉出窗口的行不计入漏单（它们该由差集补拉负责）',
                  [1800, 5, 2, 2, [[3, 0], [0, 0]]], window_miss),
            jcase('非法：drift 条数与步数不一致',
                  [1800, 5, 2, 3, [[0, 0]]], window_miss,
                  throws='IllegalArgumentException', throws_message='drift length must equal steps'),
            jcase('非法：漂移不是 [dropFront, addTail] 两列',
                  [1800, 5, 2, 1, [[1]]], window_miss,
                  throws='IllegalArgumentException', throws_message='drift must be [dropFront, addTail]'),
            jcase('非法：负漂移值',
                  [1800, 5, 2, 1, [[-1, 0]]], window_miss,
                  throws='IllegalArgumentException', throws_message='negative drift'),
            jcase('非法：页大小为 0',
                  [1800, 5, 0, 1, [[0, 0]]], window_miss,
                  throws='IllegalArgumentException', throws_message='page size must be positive'),
            jcase('非法：窗口秒数为 0',
                  [0, 5, 2, 1, [[0, 0]]], window_miss,
                  throws='IllegalArgumentException', throws_message='window must be positive'),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] windowMiss(int windowSeconds, int initialRows, int pageSize, '
                             'int totalSteps, int[][] drift)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer=answer,
    )


# =================================================================== A4 收件人字段三态可见性
@draft('alg-pdd-receiver-visibility')
def q_receiver_visibility():
    """官方注释把 receiver_* 写成三态：密文 / 空串 / 不返回，且由"状态 + 风控"共同决定。
    把它做成纯函数并跑满状态组合，是这条事实唯一能机器判分的考法。"""

    STORED = ('cipher', 'plain', 'absent')

    def one(order_status, risk, stored):
        if order_status not in (1, 2, 3, 5):
            raise ModelError('unknown order status')
        if order_status == 5:
            raise ModelError('filter value 5 is not a real status')
        if risk not in (0, 1):
            raise ModelError('unknown risk control status')
        if stored not in STORED:
            raise ModelError('unknown stored form')
        # 优先级：字段根本没返回 > 状态不该给 > 风控压着 > 值没加密 > 正常
        if stored == 'absent':
            return 'empty:no-column'
        if order_status != 1:
            return 'empty:not-awaiting-shipment'
        if risk == 1:
            return 'empty:risk-hold'
        if stored == 'plain':
            return 'empty:not-ciphered'
        return 'cipher:ok'

    def resolve_receiver_all(statuses, risks, stored):
        if not (len(statuses) == len(risks) == len(stored)):
            raise ModelError('length mismatch')
        return [one(statuses[i], risks[i], stored[i]) for i in range(len(statuses))]

    matrix_s = [s for s in (1, 2, 3) for _ in range(6)]
    matrix_r = [r for _s in (1, 2, 3) for r in (0, 0, 0, 1, 1, 1)]
    matrix_f = [f for _s in (1, 2, 3) for _r in (0, 1) for f in STORED]

    statement = """## 背景

拼多多开放平台的订单收件人字段（`receiver_address` / `receiver_name` / `receiver_phone`）
官方注释原文是：

> 订单状态为待发货状态，**且订单未被风控打标的情况下返回密文数据；其余情况返回空字符串**

再加上 `risk_control_status`＝`0 正常订单 / 1 审核中订单`，这个字段实际上有**三种语义**：

1. **密文** —— 有权看、也确实在；
2. **空串** —— 数据在，但规则不让你看（状态不对，或风控压着）；
3. **根本没有这一列** —— 上游没给。

把它们统一成"空值"就丢信息。真实系统里"空串"通常是**权限/风控结果**而不是数据缺失；
下游一旦拿空串参与 join 或 `count(distinct)`，就会把"审核中的单"统计成"地址缺失率上升"。

## 你要实现的入口

```java
public static String[] resolveReceiverAll(int[] orderStatuses, int[] riskFlags, String[] storedForms)
```

三个数组**等长**，第 `i` 行是一次判定；返回 `String[]`，每格是 `value + ":" + reason`。

## 输入取值

- `orderStatuses[i]` ∈ `{1 待发货, 2 已发货待签收, 3 已签收}`；
- `riskFlags[i]` ∈ `{0 正常, 1 审核中}`；
- `storedForms[i]` ∈ `"cipher"`（库里存的是密文） / `"plain"`（存的是明文） / `"absent"`（这一列没返回）。

## 判定与优先级（这张表就是判分点）

按顺序命中即止：

| 顺序 | 条件 | `value` | `reason` |
| --- | --- | --- | --- |
| 1 | `storedForms[i] == "absent"` | `empty` | `no-column` |
| 2 | `orderStatuses[i] != 1` | `empty` | `not-awaiting-shipment` |
| 3 | `riskFlags[i] == 1` | `empty` | `risk-hold` |
| 4 | `storedForms[i] == "plain"` | `empty` | `not-ciphered` |
| 5 | 其余（待发货 + 未打标 + 密文） | `cipher` | `ok` |

为什么是这个优先级：`no-column` 是**管道故障**（最该被单独看见，压过一切业务原因）；
状态与风控是**该不该给**，值没加密是**给了也不能用**。
把 2/3 的顺序换一下，"审核中且已发货"的单就会被归成不同的桶 —— 本题按表判分。

## 必须抛 `IllegalArgumentException` 的情况（消息文本要一致）

- 三个数组长度不一致 ⇒ `length mismatch`
- `orderStatuses[i] == 5` ⇒ `filter value 5 is not a real status`
  （官方增量接口的 `order_status` 里 **5 = 全部是筛选值**，它不是订单的真实状态；
  落到存储层里说明有人把查询条件写进了数据，必须先炸出来）
- `orderStatuses[i]` 不是 1/2/3/5 ⇒ `unknown order status`
- `riskFlags[i]` 不是 0/1 ⇒ `unknown risk control status`
- `storedForms[i]` 不在三种形态里 ⇒ `unknown stored form`

单行内的校验顺序就按上面列出的先后。

## 复杂度

`O(n)`；不许为了查表把整个输入拷两遍。"""

    reference = """import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class Solution {
  private static final Set<String> STORED = new HashSet<>(Arrays.asList("cipher", "plain", "absent"));

  public static String[] resolveReceiverAll(int[] orderStatuses, int[] riskFlags, String[] storedForms) {
    if (orderStatuses.length != riskFlags.length || orderStatuses.length != storedForms.length) {
      throw new IllegalArgumentException("length mismatch");
    }
    String[] out = new String[orderStatuses.length];
    for (int i = 0; i < orderStatuses.length; i++) {
      int status = orderStatuses[i];
      int risk = riskFlags[i];
      String stored = storedForms[i];
      if (status != 1 && status != 2 && status != 3 && status != 5) {
        throw new IllegalArgumentException("unknown order status");
      }
      if (status == 5) throw new IllegalArgumentException("filter value 5 is not a real status");
      if (risk != 0 && risk != 1) throw new IllegalArgumentException("unknown risk control status");
      if (!STORED.contains(stored)) throw new IllegalArgumentException("unknown stored form");
      // 优先级：管道没给 > 状态不该给 > 风控压着 > 值没加密 > 正常
      if ("absent".equals(stored)) out[i] = "empty:no-column";
      else if (status != 1) out[i] = "empty:not-awaiting-shipment";
      else if (risk == 1) out[i] = "empty:risk-hold";
      else if ("plain".equals(stored)) out[i] = "empty:not-ciphered";
      else out[i] = "cipher:ok";
    }
    return out;
  }
}"""

    naive = """public class Solution {
  // "空值就是没有数据"版：三种语义压成一个布尔，reason 一律是 missing。
  // 症状是"地址缺失率一周涨 40%"被当成采集故障查了三天，而真相是风控打标比例变了。
  public static String[] resolveReceiverAll(int[] orderStatuses, int[] riskFlags, String[] storedForms) {
    String[] out = new String[orderStatuses.length];
    for (int i = 0; i < orderStatuses.length; i++) {
      boolean has = !"absent".equals(storedForms[i]);
      out[i] = (has ? "cipher" : "empty") + ":missing";
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

一个五行的优先级表加一次线性扫描 —— 题不难，**难在承认"空"有三种**。
朴素解把三态压成"有没有值"，于是 `reason` 全变成同一个词，
下游那条"地址缺失率"指标就把管道故障、状态变化、风控收紧三件事混成了一个数。

**基线四种输入各打一条分支**：
`1/0/cipher` ⇒ `cipher:ok`（唯一能看见密文的那一种组合）；
`1/1/cipher` ⇒ `empty:risk-hold`（数据在、状态也对，是风控压着）；
`2/0/cipher` ⇒ `empty:not-awaiting-shipment`（已发货就不该再给收件人信息）；
`1/0/absent` ⇒ `empty:no-column`（**这一列根本没回来**，和上面三种是不同性质的问题）。

**边界用例是 18 条全组合**（3 状态 × 2 风控 × 3 存储形态）。它考两件事：
① 分支覆盖有没有漏（"已发货 + 审核中 + 明文"这种现实中少见的组合，
   写 `switch` 漏 default 的实现会在这里翻出来）；
② 优先级是否真的按表实现，而不是"碰巧在每个单例上都对"。

**为什么 `order_status = 5` 必须炸而不是判成"非待发货"**：
官方的 `order_status` 枚举里 `5 = 全部` 是**筛选值**，它和 1/2/3 这些**枚举值**混在同一列语义里
（素材把这条列为"新增枚举把报表打穿"的教科书场景）。
如果库里真出现 5，说明有人把查询条件写成了数据 —— 那是脏数据，
把它静默判成 `not-awaiting-shipment` 就等于替这次污染背书。

**明文为什么也不许下发**（`not-ciphered`）：官方语义是"返回**密文**数据"。
库里躺着明文本身就是合规事故（PIPL 下的个人敏感信息），
"能解密"与"该下发"是两件事，把明文当密文发出去，泄露发生在出口而不是存储。

**工程延伸（面试追问点）**

1. 数仓侧怎么落地？（在 DWD 就把它拆成两列：`receiver_value` + `visibility_reason`。
   下游所有"缺失率"必须引用 reason 而不是猜值，否则永远查不清。）
2. 解密动作本身呢？（要作为**字段级权限 + 审计对象**：谁、什么时候、为哪个订单解了密。
   监管取证要求逐单可举证，"我们没泄露"得拿得出访问记录。）
3. 为什么状态会影响可见性？（发货之后平台不再持有投递必需的个人信息，
   这是最小必要原则的工程实现。理解这一层才不会想着"绕过它把地址补全"。）
4. 这套语义变了怎么通知下游？（`visibility_reason` 是**枚举**，新增取值必须版本化，
   并要求下游"未知值显式落到 unmapped 桶 + 告警"，而不是 `ELSE` 分支吞掉。）"""

    return base(
        'algorithms', 'senior',
        '收件人字段的三态语义：密文 / 空串 / 没返回，按"状态 + 风控"判定并跑满状态组合',
        statement, 'java-junit',
        ['field-visibility', 'pii-handling', 'state-machine-coverage', 'data-lineage',
         'modern:privacy-engineering'],
        src('服务端研发（交易/隐私与合规方向） 高级工程师',
            TXN + '#1 核心机制 4（`receiver_*` 官方注释"待发货且未被风控打标返回密文，其余返回空串"、'
            '`risk_control_status` 0/1、`order_status` 含筛选值 5）＋ 考点 5'
            '（素材建议"可见性判定函数的状态组合覆盖"为 java-junit 题，未给判定表）'),
        language='java',
        cases=[
            jcase('基线：唯一能看见密文的那一种组合', [[1], [0], ['cipher']], resolve_receiver_all,
                  note='待发货 + 未打标 + 密文 ⇒ cipher:ok'),
            jcase('风控审核中：数据在、状态对，就是不给看', [[1], [1], ['cipher']], resolve_receiver_all,
                  note='必须与"没有数据"分得开，否则下游把审核中单算成地址缺失'),
            jcase('已发货待签收：状态本身就不该返回收件人', [[2], [0], ['cipher']], resolve_receiver_all),
            jcase('这一列根本没返回：管道问题优先于一切业务原因',
                  [[1], [0], ['absent']], resolve_receiver_all),
            jcase('库里是明文：能取到也不许当密文下发', [[1], [0], ['plain']], resolve_receiver_all,
                  note='"能解密"与"该下发"是两件事'),
            jcase('边界：18 条全组合（3 状态 × 2 风控 × 3 存储形态）逐条判定',
                  [matrix_s, matrix_r, matrix_f], resolve_receiver_all,
                  note='分支覆盖 + 优先级是否真按表实现，单例过了不代表组合过'),
            jcase('非法：筛选值 5 出现在数据里（有人把查询条件写成了状态）',
                  [[5], [0], ['cipher']], resolve_receiver_all,
                  throws='IllegalArgumentException', throws_message='filter value 5 is not a real status'),
            jcase('非法：未知订单状态', [[9], [0], ['cipher']], resolve_receiver_all,
                  throws='IllegalArgumentException', throws_message='unknown order status'),
            jcase('非法：未知风控标记', [[1], [2], ['cipher']], resolve_receiver_all,
                  throws='IllegalArgumentException', throws_message='unknown risk control status'),
            jcase('非法：未知存储形态', [[1], [0], ['hashed']], resolve_receiver_all,
                  throws='IllegalArgumentException', throws_message='unknown stored form'),
            jcase('非法：三个数组长度不一致', [[1, 2], [0], ['cipher']], resolve_receiver_all,
                  throws='IllegalArgumentException', throws_message='length mismatch'),
        ],
        runner={'className': 'Solution',
                'signature': 'String[] resolveReceiverAll(int[] orderStatuses, int[] riskFlags, '
                             'String[] storedForms)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


# =================================================================== A5 券批次额度与商品库存
@draft('alg-pdd-coupon-quota')
def q_coupon_quota():
    """批次是"额度对象"（可加量、可关闭），与商品库存是两套池子。
    事故发生在两套池子的乘积区：券够货不够 / 货够券不够。"""

    def coupon_quota(issue_total, stock, ops):
        if issue_total < 0:
            raise ModelError('negative initial issue total')
        if stock < 0:
            raise ModelError('negative initial stock')
        quota_left = issue_total
        stock_left = stock
        issued = 0
        redeemed = 0
        rejected_quota = 0
        rejected_stock = 0
        rejected_closed = 0
        closed = False
        for op in ops:
            if len(op) != 2:
                raise ModelError('op must be [kind, qty]')
            kind, qty = op[0], op[1]
            if kind not in (1, 2, 3, 4):
                raise ModelError('unknown op kind')
            if qty < 0:
                raise ModelError('negative qty')
            if kind == 4 and qty != 0:
                raise ModelError('close must carry qty 0')
            if kind == 1:                              # 领券：只动发行额度
                if closed:
                    rejected_closed += 1
                elif quota_left < qty:
                    rejected_quota += 1
                else:
                    quota_left -= qty
                    issued += qty
            elif kind == 2:                            # 核销：先要券，再要货
                if issued - redeemed < qty:
                    rejected_quota += 1
                elif stock_left < qty:
                    rejected_stock += 1                # 券留着，下次有货还能兑
                else:
                    redeemed += qty
                    stock_left -= qty
            elif kind == 3:                            # 追加发行量：批次关了就没有"再加"
                if closed:
                    raise ModelError('closed batch cannot be extended')
                quota_left += qty
            else:                                      # 关闭批次
                if closed:
                    raise ModelError('batch already closed')
                closed = True
        unbacked = (issued - redeemed) - stock_left
        return [issued, redeemed, rejected_quota, rejected_stock, rejected_closed,
                unbacked if unbacked > 0 else 0]

    statement = """## 背景

拼多多的优惠券是**批次**模型，官方接口就三个动作：
`pdd.promotion.goods.coupon.create`（创建无门槛商品券批次）、
`pdd.promotion.coupon.quantity.add`（**增加优惠券发行数量**）、`pdd.promotion.coupon.close`（**关闭批次**）。

"发行数量可加、批次可关"这两件事的存在说明：**券的发行额度与商品库存是两套独立额度**。
事故几乎都发生在两套额度的**乘积区**：券够货不够（消费者抢到券下不了单），
或货够券被加超（商家被履约义务套住）。
而且**已发出去的券不可回收** —— 兑现承诺只能由保证金兜底，所以关掉批次不等于止损结束。

## 你要实现的入口

```java
public static int[] couponQuota(int issueTotal, int stock, int[][] ops)
```

返回 `int[]{已发放, 已核销, 因额度不足被拒, 因缺货被拒, 因批次已关闭被拒, 无货可兑的券数}`。

## 模型

初始：发行额度 `quotaLeft = issueTotal`、可售库存 `stockLeft = stock`、`issued = redeemed = 0`、批次未关闭。
`ops[i] = [kind, qty]` 按顺序执行：

| kind | 事件 | 规则 |
| --- | --- | --- |
| 1 | 领券 `qty` 张 | 批次已关闭 ⇒ **因关闭被拒** +1，不占用任何额度；否则 `quotaLeft < qty` ⇒ **因额度不足被拒** +1；否则 `quotaLeft -= qty`、`issued += qty` |
| 2 | 核销 `qty` 张（下单用券，一件货一张券） | 先要券：`issued - redeemed < qty` ⇒ **因额度不足被拒** +1；再要货：`stockLeft < qty` ⇒ **因缺货被拒** +1，**券保持未用**（有货了还能兑）；两者都够 ⇒ `redeemed += qty`、`stockLeft -= qty` |
| 3 | 追加发行量 `qty` | 批次**已关闭 ⇒ 抛错**；否则 `quotaLeft += qty`（`issued` 不变） |
| 4 | 关闭批次（`qty` 必须是 0） | 已经关闭过 ⇒ **抛错**；否则置为已关闭 |

三个"被拒"计数器统计的是**事件条数**，不是张数。
被拒的事件一律**不改动任何额度**（不许"先扣再判"）。

最后一个输出 `无货可兑的券数 = max(0, (issued − redeemed) − stockLeft)`，在**全部事件跑完之后**算。
它就是"乘积区"的度量：已发未用的券比剩下的货还多 ⇒ 这批券里注定有一部分兑不出去。

## 必须抛 `IllegalArgumentException` 的情况（消息文本要一致）

- `ops[i]` 不是恰好 2 列 ⇒ `op must be [kind, qty]`
- `kind` 不在 1..4 ⇒ `unknown op kind`
- `qty < 0` ⇒ `negative qty`
- kind=4 且 `qty != 0` ⇒ `close must carry qty 0`
- 对**已关闭**的批次执行 kind=3 ⇒ `closed batch cannot be extended`
- 重复执行 kind=4 ⇒ `batch already closed`
- `issueTotal < 0` ⇒ `negative initial issue total`
- `stock < 0` ⇒ `negative initial stock`

初始值（`issueTotal` / `stock`）在进循环之前查；事件内部的校验顺序就按上面列出的先后，
其中"关闭批次/追加发行量"这两个业务错误发生在**通过格式校验之后**。

## 这题真正考的东西

三个"被拒"必须**分开计**：合成一个数就只能知道"有人失败了"，
而这三类失败的**责任人与止损动作完全不同**（额度不足 ⇒ 追加发行量或限领；
缺货 ⇒ 补货或改期；批次关闭 ⇒ 前端还挂着入口，那是配置问题）。
最后的"乘积区"是这题唯一要求你**主动建模**的地方。"""

    reference = """public class Solution {
  public static int[] couponQuota(int issueTotal, int stock, int[][] ops) {
    if (issueTotal < 0) throw new IllegalArgumentException("negative initial issue total");
    if (stock < 0) throw new IllegalArgumentException("negative initial stock");
    long quotaLeft = issueTotal, stockLeft = stock;
    long issued = 0, redeemed = 0;
    int rejectedQuota = 0, rejectedStock = 0, rejectedClosed = 0;
    boolean closed = false;

    for (int[] op : ops) {
      if (op == null || op.length != 2) throw new IllegalArgumentException("op must be [kind, qty]");
      int kind = op[0];
      long qty = op[1];
      if (kind < 1 || kind > 4) throw new IllegalArgumentException("unknown op kind");
      if (qty < 0) throw new IllegalArgumentException("negative qty");
      if (kind == 4 && qty != 0) throw new IllegalArgumentException("close must carry qty 0");

      if (kind == 1) {                                   // 领券：只动发行额度
        if (closed) rejectedClosed++;
        else if (quotaLeft < qty) rejectedQuota++;
        else { quotaLeft -= qty; issued += qty; }
      } else if (kind == 2) {                            // 核销：先要券，再要货
        if (issued - redeemed < qty) rejectedQuota++;
        else if (stockLeft < qty) rejectedStock++;       // 券保持未用
        else { redeemed += qty; stockLeft -= qty; }
      } else if (kind == 3) {                            // 追加发行量
        if (closed) throw new IllegalArgumentException("closed batch cannot be extended");
        quotaLeft += qty;
      } else {                                           // 关闭批次
        if (closed) throw new IllegalArgumentException("batch already closed");
        closed = true;
      }
    }
    long unbacked = (issued - redeemed) - stockLeft;
    return new int[] {(int) issued, (int) redeemed, rejectedQuota, rejectedStock, rejectedClosed,
                      (int) Math.max(0, unbacked)};
  }
}"""

    naive = """public class Solution {
  // "券和库存是同一个东西"版：一个池子扣两次，于是永远不会出现"乘积区"。
  // 症状是运营看板说"券还剩很多"，消费者却在下不了单 —— 因为货早就没了。
  public static int[] couponQuota(int issueTotal, int stock, int[][] ops) {
    long left = Math.min(issueTotal, stock);
    long issued = 0, redeemed = 0, rejected = 0;
    for (int[] op : ops) {
      if (op[0] == 1) {
        if (left < op[1]) rejected++;
        else { left -= op[1]; issued += op[1]; }
      } else if (op[0] == 2) {
        if (issued - redeemed < op[1]) rejected++;
        else { redeemed += op[1]; issued -= op[1]; }     // 错：核销把额度也"还"了回去
      } else if (op[0] == 3) {
        left += op[1];
      }
    }
    return new int[] {(int) issued, (int) redeemed, (int) rejected, 0, 0, 0};
  }
}"""

    answer = """## 参考答案要点

两套额度 + 一个"已发未用"的中间量。真正要建模的是最后那个数：
`无货可兑的券数 = max(0, (issued − redeemed) − stockLeft)`。
它是**乘积区**的度量 —— 前五个数各自只说一件事，只有这个数把两套池子放在一起看。

**基线用例的手算**（用例「基线：券够货不够」）：
发行额度 5、库存 3；领 5 张 ⇒ `issued=5`、额度归零；核销 3 张成功 ⇒ `redeemed=3`、库存归零；
再核销 2 张 ⇒ 券够但货不够 ⇒ **因缺货被拒 1 条**（券保持未用）；
此时"已发未用 = 5 − 3 = 2"而库存 0 ⇒ `无货可兑 = 2`。
**这个 2 就是商家被套住的那部分履约义务**，只能由保证金兜底。

**券留着是对的（这是本题最容易写反的一条）**：
核销因缺货被拒时**不许把券消耗掉**。券消耗了却没发货，等于把"额度问题"升级成"资金问题"
（要退款、要赔付、要客服）。素材里 `stock_out_handle_status` 之所以是显式三态状态机，
就是因为这条链必须走正式流程而不是靠扣券止血。

**批次关闭 ≠ 停止兑现**：`close` 之后领券一律被拒（`因批次已关闭被拒`），
但已发未用的券仍然可以核销 —— 用例「批次关闭后已发未用的券仍可核销」专门钉这条。
把 close 实现成"整批失效"是最危险的错误：它看起来在止损，实际是**单方面撕掉承诺**，
换来的是投诉与商家纠纷，而且不可回滚。

**追加发行量与关闭批次必须抛错**（而不是计入"被拒"）：
`quantity.add` 打在已关闭的批次上，说明**调用方以为自己还能发券** —— 这是配置或代码错误，
计入业务拒绝就等于把它藏进正常流量里。重复 `close` 同理。
这条"报错换静默"的判据值得在面试里主动说：**能自愈的是业务，不能自愈的是契约。**

**三个被拒计数器不许合并**：额度不足 ⇒ 追加发行量或限购；缺货 ⇒ 补货/改期/走缺货赔付；
批次关闭还在被调用 ⇒ 前端入口没摘干净（配置问题）。
合成一个数的看板只能得出"有人在失败"，得不出该派谁去处理。

**工程延伸（面试追问点）**

1. 为什么发行量要能加？（活动加码是常态。但加量必须与"已发未用券的兑现承诺"一起看，
   所以 `无货可兑` 应该是加量接口的**前置校验**，而不是事后指标。）
2. 高并发领券怎么实现不超发？（Redis 侧用集合而不是计数器：`ZADD batch:codes <seq> <code>`
   天然幂等，`ZCARD` 就是已发数，超发在数据结构层不可能发生；
   `DECR` 计数器 + 判负是另一条路，但它依赖"读到负数后回滚"，中断就会漏。
   这题是模型层，那题（`sql-redis-*`）是落地层，正好配成一对。）
3. 券的钱算谁的？（官方收入确认段给了判据：是否存在**替商家履行的明示或默示义务** ⇒
   收入抵减 / 代商家负债 / 市场费用三种落点。所以"出资方 + 义务性质"必须是批次的一等属性，
   否则商家账单里的 `platform_discount` 与 `seller_discount` 分不干净。）
4. 可提现红包能走同一个池子吗？（不能。官方写明部分激励可以 "to redeem for cash from us"，
   它必须与下单抵扣券分属两套资产账户，混用直接开出套现通道。）"""

    return base(
        'algorithms', 'senior',
        '券批次发行量与商品库存是两套池子：分开计数，算出"券够货不够"的乘积区',
        statement, 'java-junit',
        ['coupon-batch', 'quota-governance', 'two-ledger', 'oversell-liability',
         'modern:marketing-integrity'],
        src('服务端研发（营销/券与活动方向） 高级工程师',
            TXN + '#1 核心机制 7（`pdd.promotion.goods.coupon.create` / `.quantity.add` / `.close` '
            '三个官方动作＝批次是独立额度对象）＋ 考点 7「事故发生在两套额度的乘积区」；'
            '素材只给了结论，未给可判分的双池模型'),
        language='java',
        cases=[
            jcase('基线：券够货不够 ⇒ 2 张已发未用的券注定无货可兑',
                  [5, 3, [[1, 5], [2, 3], [2, 2]]], coupon_quota,
                  note='issued 5、redeemed 3、缺货被拒 1 条；已发未用 2 而库存 0 ⇒ 乘积区 2'),
            jcase('货够券不够 ⇒ 追加发行量解开瓶颈（先被拒一次，再加量）',
                  [2, 10, [[1, 2], [2, 2], [1, 3], [3, 3], [1, 3], [2, 3]]], coupon_quota,
                  note='额度只剩 0 时那笔 3 张的领券被拒 1 条；quantity.add 之后才发得出去。'
                       '最终 5 张全部核销、库存还剩 5 ⇒ 乘积区归零'),
            jcase('批次关闭后已发未用的券仍可核销（承诺不可回收）',
                  [4, 4, [[1, 4], [4, 0], [1, 2], [2, 4]]], coupon_quota,
                  note='关闭之后那次领券被拒 1 条，但已发的 4 张照样兑得掉 —— close 不是作废'),
            jcase('边界：正好把发行额度领光，下一张就被拒',
                  [3, 9, [[1, 3], [1, 1]]], coupon_quota),
            jcase('退化：没有任何操作 ⇒ 六个数都是 0',
                  [10, 10, []], coupon_quota),
            jcase('核销被缺货挡下时券必须留着，之后还能兑',
                  [6, 1, [[1, 6], [2, 2], [2, 1]]], coupon_quota,
                  note='第二次核销因缺货被拒 ⇒ 券仍是未用状态；这条钉住"不许先扣再判"'),
            jcase('非法：对已关闭批次追加发行量（调用方以为自己还能发券）',
                  [5, 5, [[4, 0], [3, 5]]], coupon_quota,
                  throws='IllegalArgumentException', throws_message='closed batch cannot be extended'),
            jcase('非法：重复关闭批次', [5, 5, [[4, 0], [4, 0]]], coupon_quota,
                  throws='IllegalArgumentException', throws_message='batch already closed'),
            jcase('非法：关闭批次却带了数量', [5, 5, [[4, 3]]], coupon_quota,
                  throws='IllegalArgumentException', throws_message='close must carry qty 0'),
            jcase('非法：事件不是 [kind, qty] 两列', [5, 5, [[1]]], coupon_quota,
                  throws='IllegalArgumentException', throws_message='op must be [kind, qty]'),
            jcase('非法：未知操作类型', [5, 5, [[9, 1]]], coupon_quota,
                  throws='IllegalArgumentException', throws_message='unknown op kind'),
            jcase('非法：数量为负', [5, 5, [[1, -2]]], coupon_quota,
                  throws='IllegalArgumentException', throws_message='negative qty'),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] couponQuota(int issueTotal, int stock, int[][] ops)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer=answer,
    )


# =================================================================== A6 万分比流量分配
@draft('alg-pdd-ad-flow-buckets')
def q_ad_flow_buckets():
    """官方接口的流量分配比例单位是**万分比**；桶数必须与报表分组同构 ⇒ 整数分配必须用最大余数法。"""

    def allocate_flow(rates, buckets):
        if buckets < 0:
            raise ModelError('negative buckets')
        for r in rates:
            if r < 0 or r > 10000:
                raise ModelError('rate out of range')
        if sum(rates) != 10000:
            raise ModelError('flow rates must sum to 10000')
        floors = []
        remainders = []
        for r in rates:
            product = r * buckets
            floors.append(product // 10000)
            remainders.append(product % 10000)
        extra = buckets - sum(floors)
        order = sorted(range(len(rates)), key=lambda i: (-remainders[i], i))
        out = list(floors)
        for i in range(extra):
            out[order[i]] += 1
        return out

    statement = """## 背景

拼多多广告开放平台里有这么一对接口：

- `pdd.ad.api.unit.creative.distribute.flow.rate`（设置智能创意**流量比例分配**）
- `pdd.ad.api.unit.creative.query.flow.rate`（查询智能创意流量分配比例，**单位：万分比**）

"万分比"这个精度单位本身就是事实：**分流桶数量级至少 10⁴**，
而且实验分桶与报表分组必须**同构** —— 桶分不平，报表就没法对齐。

于是有一个纯工程问题必须先解决：**给定的万分比要落成整数个桶，怎么落？**
逐条四舍五入会让桶数之和 ≠ 总桶数（分母一变，所有比率全错）；
直接向下取整会长期少分给小流量创意。正确解只有一个：**最大余数法**（Hamilton apportionment）。

## 你要实现的入口

```java
public static int[] allocateFlow(int[] ratePerTenThousand, int buckets)
```

返回每个创意分到的桶数，**长度与输入一致，且元素之和必须等于 `buckets`**。

## 规则

1. `ratePerTenThousand[i]` 是第 `i` 个创意的万分比，取值 `0 .. 10000`；**总和必须正好等于 10000**。
2. 先给每行 `floor(rate[i] × buckets / 10000)` 个桶，记下余数 `rate[i] × buckets mod 10000`。
3. 剩下的 `buckets − Σfloor` 个桶，按**余数从大到小**依次加一；
   **余数相同时下标小的先拿**（tie-break 必须是下标，否则同一份输入两次跑出不同结果，
   而分桶不稳定意味着同一个用户在不同批次里被分到不同实验组）。
4. `buckets == 0` ⇒ 返回全 0（长度仍要等于输入长度）。
5. 中间乘积 `rate[i] × buckets` 可能超出 `int`（见下面那条极大用例），**必须在 `long` 域里算**。

## 必须抛 `IllegalArgumentException` 的情况（消息文本要一致）

- `buckets < 0` ⇒ `negative buckets`
- 某个万分比不在 `0..10000` 内 ⇒ `rate out of range`
- 万分比之和 `!= 10000` ⇒ `flow rates must sum to 10000`

校验顺序：先 `buckets`，再逐行的取值范围，最后才是总和。

## 为什么不许用"逐条四舍五入"

四舍五入的和不等于 `buckets`，于是**分母本身是错的**：
所有基于"桶数"算出来的比率、置信区间、A/B 对照都会偏，
而且偏多少取决于有多少条被进位 —— 没有任何一处会报错。
这正是"报表分层"那道题里"谁是一次真相"的具体体现。"""

    reference = """import java.util.Arrays;

public class Solution {
  public static int[] allocateFlow(int[] ratePerTenThousand, int buckets) {
    if (buckets < 0) throw new IllegalArgumentException("negative buckets");
    long total = 0;
    for (int r : ratePerTenThousand) {
      if (r < 0 || r > 10000) throw new IllegalArgumentException("rate out of range");
      total += r;
    }
    if (total != 10000) throw new IllegalArgumentException("flow rates must sum to 10000");

    int n = ratePerTenThousand.length;
    int[] out = new int[n];
    long[] rem = new long[n];
    Integer[] idx = new Integer[n];
    long used = 0;
    for (int i = 0; i < n; i++) {
      // rate × buckets 可以大到 10^4 × 2×10^9 ⇒ 必须整体在 long 域里算
      long product = ratePerTenThousand[i] * (long) buckets;
      out[i] = (int) (product / 10000);
      rem[i] = product % 10000;
      used += out[i];
      idx[i] = i;
    }
    long extra = buckets - used;                       // 一定 < n，最大余数法的性质
    // 余数从大到小；并列时下标小的先拿（分桶必须可重放，不能有第二个答案）
    Arrays.sort(idx, (a, b) -> rem[a] != rem[b] ? Long.compare(rem[b], rem[a]) : Integer.compare(a, b));
    for (int k = 0; k < extra; k++) out[idx[k]]++;
    return out;
  }
}"""

    naive = """public class Solution {
  // "逐条四舍五入就完事"版：和不等于总桶数，于是所有比率的分母从第一步就是错的。
  public static int[] allocateFlow(int[] ratePerTenThousand, int buckets) {
    int[] out = new int[ratePerTenThousand.length];
    for (int i = 0; i < out.length; i++) {
      out[i] = (int) Math.round(ratePerTenThousand[i] * buckets / 10000.0);  // int 先乘，会溢出
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

三步：向下取整 ⇒ 记余数 ⇒ 剩下的按余数从大到小补。
`Σfloor` 与 `buckets` 的差一定小于行数，所以补桶的循环最多 `n-1` 次 ——
这也是最大余数法比"逐条四舍五入"贵不了多少却**保证了和等于总桶数**的原因。

**基线那组是整除的**（万分比 5000/3000/2000 × 1000 桶 ⇒ 500/300/200），
整除的用例只能证明你没写错，证明不了你写对了 —— 判分点全在下面三条。

**余数不为零时才需要最大余数法**（用例「需要最大余数法」）：
万分比 3333/3333/3334 对 100 个桶，三条的乘积分别是 333300/333300/333400，
向下取整都是 33（和为 99），余数分别 3300/3300/4000 ⇒ 剩下那 1 个桶给余数最大的第三条 ⇒ 33/33/34。
逐条四舍五入在这里给 33/33/33（三条都舍），**和是 99 而不是 100** ——
少的那个桶不会报错，只会让后面所有比率的分母偏 1%。

**并列必须由下标定序**（用例「并列：余数相同时下标小的先拿」）：
万分比 5000/5000/0 对 3 个桶 ⇒ 向下取整 1/1/0，余数 5000/5000/0，还剩 1 个桶。
两条并列，规则说"下标小的先拿" ⇒ 2/1/0。
如果 tie-break 用了排序的不稳定顺序、或者用了随机，同一份输入会给出 2/1/0 或 1/2/0 ——
**分桶不可重放意味着实验数据作废**：A 组和 B 组的用户成员在两次运行里换了人，
而这个变化在分析时完全看不出来。这是本题最贵的一条。

**极大用例是这题唯一的溢出陷阱**（用例「极大」）：
`rate × buckets` 达到 1.3×10¹⁰，`int` 会绕成负数，于是桶数直接错、和也不等于总桶数。
朴素解写的是 `ratePerTenThousand[i] * buckets / 10000.0` —— 除法确实是浮点，
但**乘法先发生在 int 域里**，所以它在"极大"用例上照样溢出；
再加上逐条 `Math.round` 让和不等于 `buckets`，它在并列用例上给 `2/2/0`（和 4 ≠ 3）。
参考解里 `ratePerTenThousand[i] * (long) buckets` 这个强转位置很关键 —— 先乘再转会先溢出。

**工程延伸（面试追问点）**

1. 为什么官方单位是万分比而不是百分比？（因为分流桶数量级至少 10⁴：
   单位精度与桶空间同构，才能让"设置值"与"实际桶数"一一对应。
   反过来说，**如果桶数小于 10⁴，万分比就有表达不出来的分配** —— 那才是真正的设计约束。）
2. 桶数怎么定？（要同时满足：≥ 最大公共分母的精度需求、实验并行数、以及
   "一个实验最多能占多少桶"的隔离要求。报表分组必须按同一套桶聚合，
   否则小时报表与分天报表的分母不是同一批人 —— 那就是"两套数对不上"的根因之一。）
3. 万一个数为奇数怎么办？（最大余数法天然处理：多出来的桶给余数最大的那条。
   但要在**配置层**声明"允许 ±1 桶的偏差"，否则运营会以为设了 5000 万分比就是精确一半。）
4. 要不要做"连续两次分配之间尽量少改动"的稳定分配？（要。桶的重排会打断进行中的实验。
   标准做法是按 `hash(creativeId, bucketSeed) %% 10000 < rate` 做**阈值式**分桶，
   这样调 rate 只影响边界附近的一小段桶，中间段完全不动 ——
   那才是"实验可长跑"的前提。本题的枚举式分配是它的等价特例。）"""

    return base(
        'algorithms', 'senior',
        '万分比流量分配必须落成整数桶：最大余数法 + 并列按下标定序，桶数之和不许偏',
        statement, 'java-junit',
        ['apportionment', 'flow-bucketing', 'integer-overflow', 'experiment-integrity',
         'modern:ad-billing'],
        src('算法工程（广告/实验平台方向） 高级工程师',
            TXN + '#1 核心机制 8（`unit.creative.distribute.flow.rate` / `.query.flow.rate` '
            '官方注释"单位：万分比"）＋ 考点 13「精度到万分比 ⇒ 桶数量级至少 10⁴、'
            '分流桶与报表分组必须同构」；素材给了事实未给可判分的分配算法'),
        language='java',
        cases=[
            jcase('基线：整除的万分比 5000/3000/2000 对 1000 个桶',
                  [[5000, 3000, 2000], 1000], allocate_flow),
            jcase('需要最大余数法：3333/3333/3334 对 100 桶 ⇒ 33/33/34',
                  [[3333, 3333, 3334], 100], allocate_flow,
                  note='向下取整和只有 99，剩下 1 桶给余数最大的第三条；逐条四舍五入会给出和=99'),
            jcase('并列：余数相同时下标小的先拿（分桶必须可重放）',
                  [[5000, 5000, 0], 3], allocate_flow,
                  note='1/1/0 余 5000/5000/0 ⇒ 多出的 1 桶给下标 0；并列不定序就有两个正确答案'),
            jcase('边界：万分比为 0 的创意一个桶都拿不到',
                  [[10000, 0], 7], allocate_flow),
            jcase('退化：桶数为 0 ⇒ 返回全 0 但长度不变',
                  [[2500, 7500], 0], allocate_flow),
            jcase('极大：rate × buckets 超出 int，必须整体在 long 域里算',
                  [[6667, 3333], 2000000], allocate_flow,
                  note='6667 × 2000000 = 13334000000，int 直接绕成负数'),
            jcase('边界：单个创意拿走全部流量',
                  [[10000], 5], allocate_flow),
            jcase('非法：万分比之和不是 10000', [[5000, 4000], 10], allocate_flow,
                  throws='IllegalArgumentException', throws_message='flow rates must sum to 10000'),
            jcase('非法：单个万分比越界（12000 大于 10000）',
                  [[12000, -2000], 10], allocate_flow,
                  throws='IllegalArgumentException', throws_message='rate out of range'),
            jcase('非法：桶数为负', [[10000], -1], allocate_flow,
                  throws='IllegalArgumentException', throws_message='negative buckets'),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] allocateFlow(int[] ratePerTenThousand, int buckets)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=20,
        answer=answer,
    )


# =================================================================== MySQL 公共底座
#
# 一条用例只描述一次"与基线的差异"：先改**内存行集**，再由同一份行集同时产出
# `runner.setup`/`cases[].input` 的变异 SQL 与 `cases[].expected`。
# 分两处写必然漂移（本仓库 price-grid 那题就是这么算错带 DELETE 的用例的）。
def sql_lit(value):
    if value is None:
        return 'NULL'
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    if isinstance(value, bool):
        return '1' if value else '0'
    return repr(value) if isinstance(value, float) else str(value)


def sql_seed(schema, seed):
    stmts = [f'DROP TABLE IF EXISTS {t}' for t in schema]
    for tbl, spec in schema.items():
        stmts.append('CREATE TABLE ' + tbl + ' (' + ', '.join(spec['ddl']) + ') ENGINE=InnoDB')
    for tbl, spec in schema.items():
        rows = seed[tbl]
        if rows:
            stmts.append('INSERT INTO ' + tbl + ' VALUES ' + ', '.join(
                '(' + ', '.join(sql_lit(v) for v in row) + ')' for row in rows))
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
                raise AssertionError(f'用例「{name}」插进 {tbl} 的行有 {len(row)} 列，表定义是 {len(spec["cols"])} 列')
            rows[tbl].append(list(row))
            sqls.append(f'INSERT INTO {tbl} VALUES (' + ', '.join(sql_lit(v) for v in row) + ')')
        elif kind == 'del':
            _, tbl, pk = mut
            spec = schema[tbl]
            before = len(rows[tbl])
            rows[tbl] = [r for r in rows[tbl] if r[spec['pk_idx']] != pk]
            if len(rows[tbl]) == before:
                raise AssertionError(f'用例「{name}」删了不存在的主键 {tbl}.{pk}')
            sqls.append(f'DELETE FROM {tbl} WHERE {spec["pk"]} = {sql_lit(pk)}')
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
            sets = ', '.join(f'{c} = {sql_lit(v)}' for c, v in changes.items())
            sqls.append(f'UPDATE {tbl} SET {sets} WHERE {spec["pk"]} = {sql_lit(pk)}')
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
    return case


def table_spec(pk, cols, ddl):
    return {'pk': pk, 'pk_idx': cols.index(pk), 'cols': cols, 'ddl': ddl}


def dec(x):
    from decimal import Decimal
    return Decimal(str(x))


def bp(numerator, denominator):
    """万分比 + **HALF_UP** 取整。刻意不用 Python 的 round()：
    它是银行家舍入（.5 往偶数走），而 Spark 的 round() 是 HALF_UP ——
    两边取整规则不一致时，precheck 会与容器矩阵给出不同的数。"""
    from decimal import ROUND_HALF_UP
    if denominator == 0:
        return 0
    exact = (Decimal(numerator) * 10000 / Decimal(denominator)).quantize(Decimal('0.000001'))
    return int(exact.to_integral_value(rounding=ROUND_HALF_UP))


# =================================================================== M1 金额口径与三口径成交
@draft('sql-pdd-amount-caliber')
def q_amount_caliber():
    ORDERS_COLS = ['order_sn', 'goods_amount', 'discount_amount', 'post_amount', 'service_fee',
                   'pay_amount', 'platform_discount', 'seller_discount', 'capital_free_discount',
                   'confirm_status', 'group_status', 'is_lucky_flag', 'mkt_biz_type',
                   'risk_control_status', 'stock_out_handle_status']
    ORDERS = [
        [1, '100.00', '20.00', '6.00', '3.00', '89.00', '12.00', '6.00', '2.00', 1, 1, 1, 0, 0, -1],
        [2, '50.00', '10.00', '0.00', '1.00', '41.00', '4.00', '6.00', '0.00', 1, 2, 1, 0, 0, -1],
        [3, '30.00', '5.00', '5.00', '0.00', '30.00', '5.00', '0.00', '0.00', 0, 0, 2, 0, 0, -1],
        [4, '80.00', '15.00', '0.00', '2.00', '67.00', '9.00', '6.00', '0.00', 1, 1, 1, 1, 0, -1],
        [5, '20.00', '5.00', '2.00', '1.00', '17.99', '3.00', '2.00', '0.00', 1, 1, 1, 0, 0, 0],
        [6, '40.00', '8.00', '0.00', '0.00', '32.00', '8.00', '0.00', '0.00', 1, 1, 1, 0, 1, -1],
        [7, '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00', 2, 2, 1, 0, 0, -1],
        [8, '999.99', '999.98', '0.00', '0.00', '0.01', '999.98', '0.00', '0.00', 1, 1, 1, 0, 0, -1],
    ]
    PROMOS_COLS = ['order_sn', 'promotion_type', 'promotion_amount']
    PROMOS = [
        [1, 30, '5.00'],      # 已包含在 platform_discount 里 ⇒ 再加就是双计
        [2, 10, '3.00'],      # 普通促销 ⇒ 算平台出资
        [4, 30, '9.00'],
        [6, 20, '2.50'],
        [8, 30, '999.98'],
    ]
    schema = {
        'orders': table_spec('order_sn', ORDERS_COLS, [
            'order_sn INT PRIMARY KEY', 'goods_amount DECIMAL(12,2) NOT NULL',
            'discount_amount DECIMAL(12,2) NOT NULL', 'post_amount DECIMAL(12,2) NOT NULL',
            'service_fee DECIMAL(12,2) NOT NULL', 'pay_amount DECIMAL(12,2) NOT NULL',
            'platform_discount DECIMAL(12,2) NOT NULL', 'seller_discount DECIMAL(12,2) NOT NULL',
            'capital_free_discount DECIMAL(12,2) NOT NULL', 'confirm_status TINYINT NOT NULL',
            'group_status TINYINT NOT NULL', 'is_lucky_flag TINYINT NOT NULL',
            'mkt_biz_type TINYINT NOT NULL', 'risk_control_status TINYINT NOT NULL',
            'stock_out_handle_status TINYINT NOT NULL']),
        'order_promotions': table_spec('order_sn', PROMOS_COLS, [
            'order_sn INT', 'promotion_type INT NOT NULL', 'promotion_amount DECIMAL(12,2) NOT NULL']),
    }
    seed = {'orders': ORDERS, 'order_promotions': PROMOS}
    COLUMNS = ['seq', 'caliber', 'order_cnt', 'pay_sum', 'platform_subsidy_sum',
               'broken_identity_cnt', 'risk_hold_cnt']

    def evaluate(rows):
        promos_by_order = {}
        for p in rows['order_promotions']:
            promos_by_order.setdefault(p[0], []).append(p)
        tagged = []
        for o in rows['orders']:
            order_sn = o[0]
            extra = sum((dec(x[2]) for x in promos_by_order.get(order_sn, []) if x[1] != 30),
                        Decimal('0'))
            subsidy = dec(o[6]) + extra
            formula = dec(o[1]) - dec(o[2]) + dec(o[3]) + dec(o[4])
            broken = 1 if abs(dec(o[5]) - formula) >= Decimal('0.01') else 0
            in_main = 1 if (o[11] != 2 and o[12] != 1) else 0
            tagged.append({'sn': order_sn, 'in_main': in_main, 'confirm': o[9], 'group': o[10],
                           'pay': dec(o[5]), 'subsidy': subsidy, 'broken': broken,
                           'risk': 1 if o[13] == 1 else 0})

        def bucket(pred):
            sel = [t for t in tagged if pred(t)]
            return [len(sel),
                  float(sum((t['pay'] for t in sel), Decimal('0'))),
                  float(sum((t['subsidy'] for t in sel), Decimal('0'))),
                  sum(t['broken'] for t in sel),
                  sum(t['risk'] for t in sel)]

        specs = [
            (1, 'main-all', lambda t: t['in_main'] == 1),
            (2, 'main-confirmed', lambda t: t['in_main'] == 1 and t['confirm'] == 1),
            (3, 'main-group-confirmed',
             lambda t: t['in_main'] == 1 and t['confirm'] == 1 and t['group'] == 1),
            (4, 'excluded-lucky-or-inner', lambda t: t['in_main'] == 0),
        ]
        return [[seq, name] + bucket(pred) for seq, name, pred in specs]

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。字段语义按拼多多开放平台官方文档。

```
orders(order_sn INT PK, goods_amount, discount_amount, post_amount, service_fee, pay_amount,
       platform_discount, seller_discount, capital_free_discount,      -- 以下均 DECIMAL(12,2)
       confirm_status,          -- 0 未成交 / 1 已成交 / 2 已取消
       group_status,            -- 0 拼团中 / 1 已成团 / 2 团失败
       is_lucky_flag,           -- 1 非抽奖订单 / 2 抽奖订单
       mkt_biz_type,            -- 0 普通订单 / 1 拼内购订单
       risk_control_status,     -- 0 正常 / 1 审核中
       stock_out_handle_status) -- -1 无缺货处理 / 0 缺货待处理 / 1 已处理
order_promotions(order_sn INT, promotion_type INT, promotion_amount DECIMAL(12,2))
```

## 任务

输出**四行口径卡**，按 `seq` 升序，列名与顺序必须是：

```
seq, caliber, order_cnt, pay_sum, platform_subsidy_sum, broken_identity_cnt, risk_hold_cnt
```

| seq | `caliber`（字符串必须一字不差） | 成员 |
| --- | --- | --- |
| 1 | `main-all` | 主口径全集（见下方"排除集"） |
| 2 | `main-confirmed` | 主口径 ∩ `confirm_status = 1` |
| 3 | `main-group-confirmed` | 主口径 ∩ `confirm_status = 1 AND group_status = 1` |
| 4 | `excluded-lucky-or-inner` | `is_lucky_flag = 2` **或** `mkt_biz_type = 1` |

## 口径（这张表就是判分点）

1. **排除集**：抽奖订单（`is_lucky_flag = 2`）与拼内购订单（`mkt_biz_type = 1`）
   **不进前三条主口径**，它们单独成第 4 行。
   这条设计的可验证后果：`第 1 行 order_cnt + 第 4 行 order_cnt = 全表行数`。
2. `pay_sum` = 该口径内 `pay_amount` 之和（`pay_amount` 官方含邮费与服务费）。
3. `platform_subsidy_sum` = 该口径内每单的**平台真实让利**之和，每单算法：
   `platform_discount + Σ(promotion_amount WHERE promotion_type <> 30)`。
   **`promotion_type = 30`（以旧换新优惠）一律不加** —— 官方字段注释写明
   "优惠金额已包含平台优惠金额里"，再加一次就是双计。
4. `broken_identity_cnt` = 该口径内**不满足官方恒等式**的单数：
   `ABS(pay_amount − (goods_amount − discount_amount + post_amount + service_fee)) >= 0.01`。
   容差 `0.01` 是本题给的，不要自己收紧到 0（分位差就是这么来的），也不要放宽到"看起来差不多"。
5. `risk_hold_cnt` = 该口径内 `risk_control_status = 1` 的单数。
   **审核中单不剔除、不额外处理，只要求被单列出来** ——
   它会改变数据可见性（收件人字段变空串），所以是"要盯的量"而不是"要扔的量"。

只提交**一条** `SELECT` / `WITH` 查询。

## 这题真正考的东西

- 会不会把 `promotion_type = 30` 加两遍（双计不会报错，只会让补贴复盘数字变好看）；
- 有没有**显式声明分母**：`main-confirmed` 与 `main-group-confirmed` 的差就是"已支付但没成团"，
  说不清这一条等于没做过交易口径；
- 恒等式校验是**指标**而不是**闸门**：改价、赔付都会临时破坏恒等式，
  写入时强校验会挡业务，所以要输出"坏了几单 + 涉及金额"，而不是让查询失败。"""

    reference = """WITH promo_extra AS (
  SELECT p.order_sn, SUM(p.promotion_amount) AS extra_amount
  FROM order_promotions p
  WHERE p.promotion_type <> 30          -- 30 = 以旧换新，官方注释：已包含在平台优惠里
  GROUP BY p.order_sn
), tagged AS (
  SELECT o.order_sn,
         o.pay_amount,
         o.risk_control_status,
         o.confirm_status,
         o.group_status,
         CASE WHEN o.is_lucky_flag <> 2 AND o.mkt_biz_type <> 1 THEN 1 ELSE 0 END AS in_main,
         o.platform_discount + COALESCE(e.extra_amount, 0) AS platform_subsidy,
         CASE WHEN ABS(o.pay_amount - (o.goods_amount - o.discount_amount
                                       + o.post_amount + o.service_fee)) >= 0.01
              THEN 1 ELSE 0 END AS broken
  FROM orders o
  LEFT JOIN promo_extra e ON e.order_sn = o.order_sn
), calibers AS (
  SELECT 1 AS seq, 'main-all' AS caliber
  UNION ALL SELECT 2, 'main-confirmed'
  UNION ALL SELECT 3, 'main-group-confirmed'
  UNION ALL SELECT 4, 'excluded-lucky-or-inner'
)
SELECT c.seq,
       c.caliber,
       COUNT(t.order_sn) AS order_cnt,
       COALESCE(SUM(t.pay_amount), 0) AS pay_sum,
       COALESCE(SUM(t.platform_subsidy), 0) AS platform_subsidy_sum,
       COALESCE(SUM(t.broken), 0) AS broken_identity_cnt,
       COALESCE(SUM(t.risk_control_status = 1), 0) AS risk_hold_cnt
FROM calibers c
LEFT JOIN tagged t
  ON (c.seq = 1 AND t.in_main = 1)
  OR (c.seq = 2 AND t.in_main = 1 AND t.confirm_status = 1)
  OR (c.seq = 3 AND t.in_main = 1 AND t.confirm_status = 1 AND t.group_status = 1)
  OR (c.seq = 4 AND t.in_main = 0)
GROUP BY c.seq, c.caliber
ORDER BY c.seq"""

    naive = """-- "所有优惠都要加一遍才保险"版：把"已包含"当注释没写，
-- 并且把抽奖单/拼内购混进主口径 —— 三个错误同时犯。
WITH tagged AS (
  SELECT o.order_sn, o.pay_amount, o.confirm_status, o.group_status, o.risk_control_status,
         o.platform_discount + COALESCE((SELECT SUM(p.promotion_amount) FROM order_promotions p
                                         WHERE p.order_sn = o.order_sn), 0) AS platform_subsidy,
         0 AS broken
  FROM orders o
)
SELECT 1 AS seq, 'main-all' AS caliber, COUNT(*) AS order_cnt, SUM(pay_amount) AS pay_sum,
       SUM(platform_subsidy) AS platform_subsidy_sum, 0 AS broken_identity_cnt,
       SUM(risk_control_status = 1) AS risk_hold_cnt
FROM tagged
UNION ALL
SELECT 2, 'main-confirmed', COUNT(*), SUM(pay_amount), SUM(platform_subsidy), 0,
       SUM(risk_control_status = 1)
FROM tagged WHERE confirm_status = 1
ORDER BY seq"""

    answer = """## 参考答案要点

一个 `tagged` CTE 把每单的四个属性（属不属于主口径、平台让利、恒等式是否成立、是否审核中）
算完，再对着四行口径卡做**一次**条件聚合。这样四条口径看的是同一批行、同一套让利算法 ——
和"每条口径各写一段 SQL 再 UNION"相比，后者迟早在不同段里漂移。

**基线四行对得上账**（用来核对 expected 是不是真的对）：
主口径 6 单、排除集 2 单，合计 8 = 全表行数（这条不变量是最省事的自检）。
主口径全集 `pay_sum` = 89.00 + 41.00 + 17.99 + 32.00 + 0.00 + 0.01 = 180.00。
平台让利：`order_sn=1` 是 12.00（那笔 `type=30` 的 5.00 **不加**），
`order_sn=2` 是 4.00 + 3.00 = 7.00（`type=10` 才加），
`order_sn=8` 是 999.98（同样不加那笔 999.98 的 `type=30`）。
恒等式只坏在 `order_sn=5`：公式给 18.00、表上记 17.99，差 0.01 ⇒ 正好落在 `>= 0.01` 这一侧。

**双计为什么最难发现**：把 `type=30` 加进去，`platform_subsidy_sum` 只会**变大**，
而"平台让利变大"在复盘会上通常是好消息 —— 没有任何一方有动力去质疑它。
这正是官方要把"已包含"写进字段注释的原因：**这不是提示，是约束**。

**容差 0.01 的两侧都要有用例**（用例「容差边界」）：
差 0.01 判坏、差 0.00 判好。写成 `> 0.01` 的实现会漏掉真实存在的分位差
（改价与分摊回冲都会产生恰好一分的差），写成 `<> 0` 又会把 `DECIMAL` 显示差异算成事故。

**"已成交"与"已成团"是两个维度**（`main-confirmed` 与 `main-group-confirmed` 的差）：
基线上差的是 `order_sn=2` —— 它 `confirm_status=1`（钱付了）但 `group_status=2`（团失败）。
这一格在财务上是"已收未成交"，在客服口径里是"要退款或要补团"，在供给侧是"占掉的库存要回补"。
**说不清这一格有多少钱，就等于没在这家公司做过交易口径。**

**审核中只列不剔**：`risk_control_status=1` 不改变成交额口径，
但它改变**数据可见性**（收件人字段返回空串），所以要单独出一个数。
把它顺手 `WHERE` 掉是常见的错：之后"地址缺失率"上升就永远查不到原因（见同方向另一道题）。

**工程延伸（面试追问点）**

1. 为什么恒等式做成指标而不是约束？（改价、赔付、分摊回冲都会**临时**破坏它；
   写入时强校验会挡正常业务。正确做法是照写不误 + 把 `broken` 做成 DQC 指标，
   超阈值阻断**结算**而不是阻断下单。）
2. 退款怎么摊？（按出资比例摊，不按面额：一笔优惠由三方出时，退一件要按
   `各出资额 / goods_amount` 拆，否则会出现"退款额 > 实付额"。）
3. 抽奖单为什么要排除？（`is_lucky_flag=2` 的单不代表一次真实的商品成交
   —— 它的"客单价/转化率/补贴效率"全部失真。混进主口径会让这些指标长期偏低，
   而偏低的方向恰好与"活动效果好"相反，所以很容易长期没人查。）
4. 第 4 行为什么也要出金额？（排除集本身要有规模感：如果它从 2 单变成 2000 单，
   前三条口径的分母其实已经被换掉了 —— 这是"新增枚举把报表打穿"的同一家族。）
5. 口径变更怎么办？（四行口径卡的 `caliber` 字符串是**契约**：改名等于让所有下游看板失配。
   新增口径要加 seq，不许改老 seq 的含义。）"""

    return base(
        'sql', 'principal',
        '四行口径卡：pay_amount 恒等式体检、promotion_type=30 不双计、抽奖与拼内购单列',
        statement, 'mysql',
        ['amount-caliber', 'metric-denominator', 'double-counting', 'identity-check',
         'modern:finance-consistency'],
        src('服务端研发（交易/结算方向） 高级工程师',
            TXN + '#5 题面草稿 A 第 1–3 问（`pay_amount`/`discount_amount` 官方公式、'
            '`promotion_type=30 已包含`、三口径成交与抽奖/拼内购分桶、缺货赔付敞口）＋ 考点 5'),
        language='sql',
        cases=[
            mut_case('基线：主口径 6 单、排除集 2 单，恒等式坏 1 单',
                     schema, seed, [], COLUMNS, evaluate,
                     note='main-all 与 excluded 的 order_cnt 相加 = 8 = 全表行数（自检不变量）'),
            mut_case('双计陷阱：给 order_sn=2 再加一条 type=30 的明细，平台让利不许变',
                     schema, seed, [('ins', 'order_promotions', [2, 30, '7.00'])], COLUMNS, evaluate,
                     note='加进来的是"已包含在平台优惠里"的那一类 ⇒ 正确实现结果与基线完全相同；'
                          '把明细全加起来会凭空多出 7.00'),
            mut_case('容差边界：把坏单修到一分不差，broken 归零',
                     schema, seed, [('set', 'orders', 5, {'pay_amount': '18.00'})], COLUMNS, evaluate),
            mut_case('团失败但已支付：删掉它只影响 main-confirmed，不影响成团口径',
                     schema, seed, [('del', 'orders', 2)], COLUMNS, evaluate,
                     note='order_sn=2 是 confirm_status=1 且 group_status=2 —— 它只在第 2 行里，'
                          '所以第 2 行少 1 单、第 3 行一分不变。这两行之差就是"已收未成交"'),
            mut_case('边界：审核中占比升高只改 risk_hold_cnt，不改任何金额',
                     schema, seed, [('set', 'orders', 1, {'risk_control_status': 1}),
                                    ('set', 'orders', 8, {'risk_control_status': 1})], COLUMNS, evaluate),
            mut_case('排除集扩张：再来一条抽奖单，三条主口径一律不动',
                     schema, seed, [('ins', 'orders', [9, '10.00', '0.00', '0.00', '0.00', '10.00',
                                                      '0.00', '0.00', '0.00', 1, 1, 2, 0, 0, -1])],
                     COLUMNS, evaluate,
                     note='is_lucky_flag=2 ⇒ 落进第 4 行。主口径三条若跟着变了，说明排除集没做对'),
            mut_case('零金额订单只进数量不进金额，且不能把 SUM 变成 NULL',
                     schema, seed, [('del', 'orders', 1), ('del', 'orders', 2),
                                    ('del', 'orders', 5), ('del', 'orders', 6),
                                    ('del', 'orders', 8)], COLUMNS, evaluate,
                     note='主口径只剩 order_sn=7（0.00 已取消）⇒ pay_sum 必须是 0 而不是 NULL；'
                          '空集时 SUM 返回 NULL，不兜住就会让看板整列变空'),
        ],
        runner={'setup': sql_seed(schema, seed), 'orderSensitive': True, 'timeoutMs': 9000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=32,
        answer=answer,
    )


# =================================================================== M2 增量拉单的漏单与错窗
@draft('sql-pdd-increment-recon')
def q_increment_recon():
    ORD_COLS = ['order_sn', 'updated_at', 'confirm_status']
    ORDERS = [
        [101, '2026-05-01 09:05:00', 1],
        [102, '2026-05-01 09:20:00', 1],
        [103, '2026-05-01 09:31:00', 1],
        [104, '2026-05-01 09:40:00', 0],
        [105, '2026-05-01 09:55:00', 1],
        [106, '2026-05-01 10:10:00', 1],
        [107, '2026-05-01 10:25:00', 2],
    ]
    LOG_COLS = ['id', 'snapshot_id', 'order_sn', 'window_start', 'window_end']
    LOG = [
        [1, 'S1', 101, '2026-05-01 09:00:00', '2026-05-01 09:30:00'],
        [2, 'S1', 102, '2026-05-01 09:00:00', '2026-05-01 09:30:00'],
        [3, 'S2', 103, '2026-05-01 09:30:00', '2026-05-01 09:59:00'],
        [4, 'S2', 102, '2026-05-01 09:30:00', '2026-05-01 09:59:00'],
        [5, 'S3', 107, '2026-05-01 10:00:00', '2026-05-01 10:30:00'],
        [6, 'S3', 106, '2026-05-01 10:00:00', '2026-05-01 10:30:00'],
    ]
    WM_COLS = ['id', 'watermark_end']
    WM = [[1, '2026-05-01 10:30:00']]

    schema = {
        'orders': table_spec('order_sn', ORD_COLS, [
            'order_sn INT PRIMARY KEY', 'updated_at DATETIME NOT NULL',
            'confirm_status TINYINT NOT NULL']),
        'pull_log': table_spec('id', LOG_COLS, [
            'id INT PRIMARY KEY', 'snapshot_id VARCHAR(8) NOT NULL', 'order_sn INT NOT NULL',
            'window_start DATETIME NOT NULL', 'window_end DATETIME NOT NULL']),
        'watermark': table_spec('id', WM_COLS, [
            'id INT PRIMARY KEY', 'watermark_end DATETIME NOT NULL']),
    }
    seed = {'orders': ORDERS, 'pull_log': LOG, 'watermark': WM}
    COLUMNS = ['order_sn', 'issue']

    def evaluate(rows):
        wm = rows['watermark'][0][1]
        updated = {o[0]: o[1] for o in rows['orders']}
        pulled = {}
        outside = set()
        for entry in rows['pull_log']:
            sn = entry[2]
            pulled[sn] = pulled.get(sn, 0) + 1
            u = updated.get(sn)
            if u is None or not (entry[3] <= u <= entry[4]):
                outside.add(sn)          # 留痕指向不存在的订单 ⇒ 同样按错窗处理
        issues = []
        for sn, u in updated.items():
            if u > wm:
                continue                 # 还没到水位线，本次作业不负责
            if sn not in pulled:
                issues.append([sn, 'missed'])
            if sn in outside:
                issues.append([sn, 'out-of-window'])
            if pulled.get(sn, 0) >= 2:
                issues.append([sn, 'pulled-twice'])
        for sn in outside:               # 孤儿留痕：主表里根本没有这单
            if sn not in updated:
                issues.append([sn, 'out-of-window'])
        return sorted(issues, key=lambda x: (int(x[0]), x[1]))

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

拼多多官方增量拉单接口 `pdd.order.number.list.increment.get` 有三条硬约束：
**按最后更新时间切片**、**窗口跨度不超过 30 分钟**、**必须倒序分页（从最后一页往回取）才能避免漏单**。
本题不考翻页算法（那是算法题），考的是**事后取证**：给定订单表与拉取留痕，
找出"哪些单出了问题、分别属于哪一类"。

```
orders    (order_sn INT PK, updated_at DATETIME, confirm_status TINYINT)
pull_log  (id INT PK, snapshot_id VARCHAR(8), order_sn INT,
           window_start DATETIME, window_end DATETIME)   -- 每一次"确实把这单拉回去了"的留痕
watermark (id INT PK, watermark_end DATETIME)            -- 作业声称已处理到的位置
```

## 任务

输出**所有有问题的订单**，每行两列 `order_sn, issue`，按 `order_sn` 升序、再按 `issue` 升序。
一个订单可以同时有多个问题 ⇒ 出多行。没有任何问题时返回**空结果集**。

## 三种 issue 的定义（这张表就是判分点）

设 `W` = `watermark.watermark_end`，`u(订单)` = 它的 `updated_at`。
**作业职责范围** = `u <= W` 的订单（`u > W` 的还不归这次作业管，一律不出问题）。

| `issue` | 判据 |
| --- | --- |
| `missed` | 在职责范围内，但 `pull_log` 里**一条都没有**引用到这个 `order_sn` |
| `out-of-window` | `pull_log` 引用了它，但那条记录的窗口**没包住**它的 `updated_at`：即 `window_start > u` 或 `window_end < u`。窗口边界**闭区间**（`window_start <= u <= window_end` 算包住） |
| `pulled-twice` | 同一个 `order_sn` 在 `pull_log` 里出现 **≥ 2 条**（跨快照重叠窗口也算 —— 幂等合并是消费方的义务，但"被拉过两次"必须被看见） |

另外三条口径：

1. `pull_log` 里引用了**不存在的 `order_sn`** 时，按"错窗"处理
   （它说明留痕与主表已经对不上，这是比漏单更严重的问题）。
2. `missed` 与 `out-of-window` **互斥**吗？不互斥 —— 同一单可以既被漏、又被别的快照错窗引用。
3. 水位线 `W` 之后的订单一律不判（**不许**把它们算成漏单，那是把"还没到时候"读成"丢了"）。

只提交**一条** `SELECT` / `WITH` 查询。

## 这题真正考的东西

- **"没人拉过"和"拉了但窗口不对"是两类问题**，责任人与修法完全不同：
  前者是翻页/分页丢了行（要改翻页方式 + 补拉），后者是窗口算错或时钟漂移（要修窗口与水位线）。
  合成一个 `anomaly` 的实现在告警出来之后什么也做不了。
- **职责范围必须由水位线定义，而不是由"今天有没有数据"定义。**
  把 `u > W` 的单也算成漏单，是这类系统最典型的滥报 —— 它会永久存在，于是很快没人看。"""

    reference = """WITH scope AS (
  SELECT o.order_sn, o.updated_at FROM orders o
  WHERE o.updated_at <= (SELECT MAX(w.watermark_end) FROM watermark w)
), pulled AS (
  SELECT p.order_sn,
         COUNT(*) AS times,
         MAX(o.updated_at) AS upd_at,
         SUM(CASE WHEN o.order_sn IS NULL
                    OR p.window_start > o.updated_at
                    OR p.window_end < o.updated_at
                  THEN 1 ELSE 0 END) AS outside
  FROM pull_log p
  LEFT JOIN orders o ON o.order_sn = p.order_sn
  GROUP BY p.order_sn
)
SELECT s.order_sn, 'missed' AS issue
FROM scope s
LEFT JOIN pulled p ON p.order_sn = s.order_sn
WHERE p.order_sn IS NULL
UNION ALL
SELECT p.order_sn, 'out-of-window'
FROM pulled p
WHERE p.outside > 0
  AND (p.upd_at IS NULL OR p.upd_at <= (SELECT MAX(w.watermark_end) FROM watermark w))
UNION ALL
SELECT p.order_sn, 'pulled-twice'
FROM pulled p
WHERE p.times >= 2
  AND p.upd_at <= (SELECT MAX(w.watermark_end) FROM watermark w)
ORDER BY order_sn, issue"""

    naive = """-- "有留痕就算拉走过"版：只看 pull_log 里有没有出现过，
-- 于是错窗与重单永远查不出来；并且把水位线之后的单也算成漏单（滥报）。
SELECT o.order_sn, 'missed' AS issue
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM pull_log p WHERE p.order_sn = o.order_sn)
ORDER BY o.order_sn"""

    answer = """## 参考答案要点

三类问题各自一条 `UNION ALL`，共用一个 `pulled` 聚合（每个 `order_sn` 一条，
带 `times` 与 `outside` 两个计数）。这样"漏单"是 `pulled` 里查不到的差集，
"错窗/重单"是它的两个条件投影 —— 三件事看的是同一份留痕。

**基线报出的四条**（用来核对 expected 是不是真的对，`W = 10:30`）：
`102` 同时中两条 —— 它在 S1 `[09:00,09:30]` 里（`updated_at = 09:20` 被包住），
又在 S2 `[09:30,09:59]` 里（09:20 落在 `window_start` 之前 ⇒ **没被包住**）
⇒ `out-of-window` + `pulled-twice`。
`104`（09:40）与 `105`（09:55）在职责范围内但 `pull_log` 里一条都没有 ⇒ 各自 `missed`。
`103` 被 S2 的窗口正常包住、`106/107` 被 S3 包住 ⇒ 干净，不出现。
**四类判据各自只命中该命中的行**：`102` 不能被算成 `missed`（它明明有留痕），
`107` 也不能因为"团已取消"而被跳过（职责范围只看 `updated_at` 与水位线）。

**为什么"错窗"要单独一类**：漏单是"没拉到"，错窗是"拉到了但那次查询根本不该返回它"。
后者的典型成因是 `updated_at` 被上游写成未来时间、或窗口边界用成了开区间。
它比漏单更阴：**数据在 `pull_log` 里看起来被处理过，所以差集补拉不会把它捞回来**。

**为什么 `pulled-twice` 也要报**：重叠窗口 + 倒序分页**必然**造成重复拉取，
这是设计的一部分（宁可重、不可漏）。但"重"要求消费方按 `order_sn` 幂等合并 ——
报出来是为了给幂等合并留一个可对账的证据链，而不是为了当故障处理。

**水位线之外的单不许算漏单**（用例「职责边界」）：
朴素解那句 `WHERE NOT EXISTS(...)` 没有 `updated_at <= W` 的限制，
于是"刚进来还没来得及拉"的单被永久判成漏单。
**滥报的代价不是吵，是这条告警再也没有人处理** —— 于是真正的漏单跟着一起被忽略。

**工程延伸（面试追问点）**

1. 这题的判据能不能实时跑？（可以，但窗口要留安全滞后：
   正在被更新的单会短暂处于"留痕未落"的状态，实时判会把它们读成漏单。
   标准做法是只判 `updated_at < now − 滞后` 的部分。）
2. 留痕为什么要带 `window_start/window_end` 而不是只带 `pulled_at`？
   （只有带着窗口边界才能区分"漏"与"错窗"。只记时间戳的留痕
   在取证时只能回答"拉过没有"，回答不了"这次拉取有没有资格说它拉过"。）
3. 怎么证明没漏？（周期性拿"按成交时间的全量集合"与 `pull_log` 的 `order_sn` 集合做差集，
   差集基数就是漏单率的分子。**漏单率本身是 SLI**，不是事后复盘的产物。）
4. `order_status` 的 `5 = 全部` 在这里是个坑吗？（是，但属于另一道题：
   它是筛选值混进枚举值，`pull_log` 的筛选条件与订单表的实际状态列语义不同。
   留痕表要存**筛选条件的原样**（`order_status` 参数值），而不是只存结果。）"""

    return base(
        'sql', 'senior',
        '增量拉单取证：漏单、错窗、重单是三件事，职责范围由水位线而不是由"今天"定义',
        statement, 'mysql',
        ['incremental-sync', 'audit-trail', 'watermark', 'missed-record',
         'modern:data-consistency'],
        src('数据平台（同步与对账方向） 高级工程师',
            TXN + '#1 核心机制 3（30 分钟窗口 + 倒序分页防漏单的官方原文）＋ 考点 4'
            '「素材建议 judgeKind=mysql：给定多次快照算漏单/重单、水位线推进」，未给判据表'),
        language='sql',
        cases=[
            mut_case('基线：漏单与错窗同时存在',
                     schema, seed, [], COLUMNS, evaluate,
                     note='三类 issue 各自的条件都要能命中；expected 由行集算出，不手算'),
            mut_case('补齐留痕：把漏掉的单都记上，missed 归零',
                     schema, seed, [('ins', 'pull_log', [7, 'S2', 104,
                                                         '2026-05-01 09:30:00', '2026-05-01 09:59:00']),
                                    ('ins', 'pull_log', [8, 'S2', 105,
                                                         '2026-05-01 09:30:00', '2026-05-01 09:59:00'])],
                     COLUMNS, evaluate),
            mut_case('职责边界：水位线推到 09:30，之后的单一律不判',
                     schema, seed, [('set', 'watermark', 1, {'watermark_end': '2026-05-01 09:30:00'})],
                     COLUMNS, evaluate,
                     note='只有 updated_at <= 09:30 的单在职责范围内；把晚到的算成漏单是滥报'),
            mut_case('错窗：上游把订单的 updated_at 写成未来时间，窗口再也包不住它',
                     schema, seed, [('set', 'orders', 106, {'updated_at': '2026-05-01 11:00:00'}),
                                    ('set', 'watermark', 1, {'watermark_end': '2026-05-01 12:00:00'})],
                     COLUMNS, evaluate,
                     note='S3 那条留痕的窗口是 [10:00,10:30]，而订单已经变成 11:00 ⇒ out-of-window。'
                          '未来时间还会被下一轮水位线吞掉，所以必须隔离而不是丢弃'),
            mut_case('重单：同一单被两个快照都拉过，只出一条 pulled-twice',
                     schema, seed, [('ins', 'pull_log', [9, 'S4', 101, '2026-05-01 09:00:00',
                                                        '2026-05-01 09:30:00'])], COLUMNS, evaluate,
                     note='101 出现 2 次 ⇒ 一条 pulled-twice；重复是设计使然，但要被看见'),
            mut_case('退化：订单与留痕都清空 ⇒ 空结果集（不是返回一行 0）',
                     schema, seed, [('del', 'pull_log', i) for i in [1, 2, 3, 4, 5, 6]]
                     + [('del', 'orders', s) for s in [101, 102, 103, 104, 105, 106, 107]],
                     COLUMNS, evaluate,
                     note='两边都空 ⇒ 零行。只删订单会让留痕全变孤儿，那是一堆 out-of-window，'
                          '不是空结果 —— 空结果集在 mysql 判题里必须写成裸 []'),
            mut_case('孤儿留痕：pull_log 引用了不存在的订单，按错窗处理',
                     schema, seed, [('ins', 'pull_log', [10, 'S5', 999, '2026-05-01 09:00:00',
                                                        '2026-05-01 09:30:00'])], COLUMNS, evaluate),
        ],
        runner={'setup': sql_seed(schema, seed), 'orderSensitive': True, 'timeoutMs': 9000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer=answer,
    )


# =================================================================== M3 官方"活跃商家"定义
@draft('sql-pdd-active-merchant')
def q_active_merchant():
    PERIODS = [
        ['2026-W18', '2026-04-27 00:00:00', '2026-05-03 23:59:59'],
        ['2026-W19', '2026-05-04 00:00:00', '2026-05-10 23:59:59'],
    ]
    ORDERS = [
        [1, 1, '2026-04-28 10:00:00', '2026-04-29 09:00:00', '100.00'],
        [2, 1, '2026-05-03 23:00:00', '2026-05-03 23:30:00', '50.00'],
        [3, 2, '2026-04-27 00:00:00', '2026-04-27 00:00:00', '20.00'],
        [4, 3, '2026-05-05 08:00:00', '2026-05-06 12:00:00', '30.00'],
        [5, 4, '2026-05-06 08:00:00', '2026-05-07 12:00:00', '40.00'],
        [6, 8, '2026-05-08 08:00:00', '2026-05-09 12:00:00', '60.00'],
        [7, 5, '2026-04-30 08:00:00', None, '70.00'],
        [8, 6, '2026-04-25 08:00:00', '2026-04-26 08:00:00', '80.00'],
        [9, 3, '2026-05-09 08:00:00', '2026-05-10 23:59:59', '15.00'],
        [10, 7, '2026-05-02 08:00:00', '2026-05-11 08:00:00', '25.00'],
    ]
    REFUND = [[5, '40.00', 1], [6, '10.00', 0]]
    SHOP = [[1, 100], [2, 100], [3, 200], [4, 300], [5, 400], [6, 500], [7, 100], [8, 300]]

    schema = {
        'period_calendar': table_spec('period_tag', ['period_tag', 'start_ts', 'end_ts'], [
            'period_tag VARCHAR(12) PRIMARY KEY', 'start_ts DATETIME NOT NULL',
            'end_ts DATETIME NOT NULL']),
        'orders': table_spec('order_sn',
                             ['order_sn', 'merchant_account_id', 'pay_time', 'shipped_time',
                              'pay_amount'],
                             ['order_sn INT PRIMARY KEY', 'merchant_account_id INT NOT NULL',
                              'pay_time DATETIME NULL', 'shipped_time DATETIME NULL',
                              'pay_amount DECIMAL(12,2) NOT NULL']),
        'order_refund': table_spec('order_sn', ['order_sn', 'refund_amount', 'is_full'], [
            'order_sn INT PRIMARY KEY', 'refund_amount DECIMAL(12,2) NOT NULL',
            'is_full TINYINT NOT NULL']),
        'merchant_shop': table_spec('merchant_account_id',
                                    ['merchant_account_id', 'subject_id'],
                                    ['merchant_account_id INT PRIMARY KEY',
                                     'subject_id INT NOT NULL']),
    }
    seed = {'period_calendar': PERIODS, 'orders': ORDERS, 'order_refund': REFUND,
            'merchant_shop': SHOP}
    COLUMNS = ['period_tag', 'active_accounts_official', 'active_accounts_after_refund',
               'gap_after_refund', 'active_subjects', 'shipped_order_cnt']

    def evaluate(rows):
        refund = {r[0]: r for r in rows['order_refund']}
        subject = {m[0]: m[1] for m in rows['merchant_shop']}
        out = []
        for tag, start, end in sorted(rows['period_calendar']):
            shipped = [o for o in rows['orders']
                       if o[3] is not None and start <= o[3] <= end]
            official = sorted({o[1] for o in shipped})
            kept = {}
            for o in shipped:
                rf = refund.get(o[0])
                full = rf is not None and rf[2] == 1
                kept[o[1]] = kept.get(o[1], False) or (not full)
            after = [a for a in official if kept.get(a)]
            subjects = {subject[a] for a in official if a in subject}
            out.append([tag, len(official), len(after), len(official) - len(after),
                        len(subjects), len(shipped)])
        return out

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

拼多多 20-F 里对"活跃商家（active merchants）"给了**官方定义**原文：

> merchant accounts that had **one or more orders shipped to a buyer** on our platforms
> in that period, **regardless of whether the buyer returns the merchandise or the merchant
> refunds the purchase price**

这句话里有三个考点：① 触发事件是**已发货（shipped）**，不是支付、也不是成交；
② **不扣退款/退货**；③ 主体是**账号（account）**，不是店铺或经营主体
（同一个人开 3 个账号就算 3 个）。

```
period_calendar(period_tag VARCHAR(12) PK, start_ts DATETIME, end_ts DATETIME)
orders(order_sn INT PK, merchant_account_id INT, pay_time DATETIME NULL,
       shipped_time DATETIME NULL, pay_amount DECIMAL(12,2))
order_refund(order_sn INT PK, refund_amount DECIMAL(12,2), is_full TINYINT)  -- 1 全额 / 0 部分
merchant_shop(merchant_account_id INT PK, subject_id INT)                    -- 账号 → 经营主体
```

## 任务

每个周期输出一行，按 `period_tag` 升序，列名与顺序必须是：

```
period_tag, active_accounts_official, active_accounts_after_refund,
gap_after_refund, active_subjects, shipped_order_cnt
```

## 口径（这张表就是判分点）

1. **周期内的"发货单"集合**：`shipped_time` 非空且
   `shipped_time BETWEEN start_ts AND end_ts`（**两端都是闭区间**）。
   窗口边界**恰好等于** `start_ts` 或 `end_ts` 的那一条必须算进来。
2. `active_accounts_official` = 上述集合里 `COUNT(DISTINCT merchant_account_id)`。
   **不扣退款** —— 这是官方定义，不是疏忽。
3. `shipped_order_cnt` = 上述集合的**行数**（不是账号数；一个账号发 3 单算 3）。
4. `active_accounts_after_refund` = **另一个口径**（题面要求一起出，用来量差异）：
   账号内**至少有一单**不是"全额退款"就算活跃
   （"全额退款" = 该单在 `order_refund` 里有行且 `is_full = 1`；部分退款 `is_full = 0` **不**扣）。
   即：一个账号在周期内只发了 1 单且那单全额退款 ⇒ 它从这一列里消失。
5. `gap_after_refund` = `active_accounts_official − active_accounts_after_refund`。
6. `active_subjects` = 第 2 列那批账号所对应的 `COUNT(DISTINCT subject_id)`
   （**主体维度**：同主体多账号只算一个；维表里没配到主体的账号不贡献 subject）。

只提交**一条** `SELECT` / `WITH` 查询。

## 这题真正考的东西

- **时间锚点选错，整列都错**：用 `pay_time` 算出来的是"有支付行为的商家"，
  与财报口径不是一回事，且差额无法解释（发货在周期末、支付在周期初的单会两边跳）。
- **把"不扣退款"当 bug 修掉**是最典型的错误：官方**刻意**让它不扣，
  因为它服务的是**供给侧健康度**（这个账号还在不在卖），不是成交质量。
  本题的解法是**两列都出**并给出 `gap_after_refund`，而不是挑一个。
- **账号 ≠ 主体**：算成主体会让"一个主体批量注册账号"看起来没有增长，
  而供给侧指标恰恰要暴露这件事（虚假交易抬高的就是账号级销量）。"""

    reference = """WITH shipped AS (
  SELECT p.period_tag, o.merchant_account_id AS acct, o.order_sn
  FROM period_calendar p
  JOIN orders o ON o.shipped_time BETWEEN p.start_ts AND p.end_ts
), per_order AS (
  SELECT s.period_tag, s.acct,
         CASE WHEN r.order_sn IS NOT NULL AND r.is_full = 1 THEN 0 ELSE 1 END AS kept
  FROM shipped s
  LEFT JOIN order_refund r ON r.order_sn = s.order_sn
), per_account AS (
  SELECT period_tag, acct, MAX(kept) AS any_kept
  FROM per_order
  GROUP BY period_tag, acct
), order_cnt AS (
  SELECT period_tag, COUNT(*) AS cnt FROM shipped GROUP BY period_tag
)
SELECT p.period_tag,
       COUNT(DISTINCT a.acct) AS active_accounts_official,
       COUNT(DISTINCT CASE WHEN a.any_kept = 1 THEN a.acct END) AS active_accounts_after_refund,
       COUNT(DISTINCT a.acct)
         - COUNT(DISTINCT CASE WHEN a.any_kept = 1 THEN a.acct END) AS gap_after_refund,
       COUNT(DISTINCT m.subject_id) AS active_subjects,
       COALESCE(MAX(c.cnt), 0) AS shipped_order_cnt
FROM period_calendar p
LEFT JOIN per_account a ON a.period_tag = p.period_tag
LEFT JOIN merchant_shop m ON m.merchant_account_id = a.acct
LEFT JOIN order_cnt c ON c.period_tag = p.period_tag
GROUP BY p.period_tag
ORDER BY p.period_tag"""

    naive = """-- "把官方定义当没读过"版：时间锚点用 pay_time、去重主体用 subject_id、
-- 并且主动扣掉全额退款（以为官方那句 regardless 是疏漏）。三个方向全错。
SELECT p.period_tag,
       COUNT(DISTINCT m.subject_id) AS active_accounts_official,
       COUNT(DISTINCT m.subject_id) AS active_accounts_after_refund,
       0 AS gap_after_refund,
       COUNT(DISTINCT m.subject_id) AS active_subjects,
       COUNT(o.order_sn) AS shipped_order_cnt
FROM period_calendar p
LEFT JOIN orders o
  ON o.pay_time BETWEEN p.start_ts AND p.end_ts
LEFT JOIN order_refund r ON r.order_sn = o.order_sn AND r.is_full = 1
LEFT JOIN merchant_shop m ON m.merchant_account_id = o.merchant_account_id
WHERE r.order_sn IS NULL
GROUP BY p.period_tag
ORDER BY p.period_tag"""

    answer = """## 参考答案要点

`shipped` 这个 CTE 是唯一的"事实"：把周期与订单做一次区间连接，锚点是 `shipped_time`。
后面几列都从它出发 —— 账号数、行数、以及"扣掉全额退款之后还剩几个账号"。
**关键是先固定集合，再算不同的投影**，而不是每个指标各连一次表（那样时间锚点迟早漂移）。

**两行口径卡**（W18 / W19）：
W18 周期内发货 3 单（order 1、2、3），账号 {1, 2} ⇒ `active_accounts_official` = 2；
这两个账号同属主体 100 ⇒ `active_subjects` = 1；没有退款 ⇒ `gap_after_refund` = 0。
W19 周期内发货 4 单（order 4、5、6、9），账号 {3, 4, 8} ⇒ 官方口径 3；
扣退款口径下账号 4 唯一那单（order 5）是全额退款 ⇒ 只剩 {3, 8} = 2 ⇒ **gap = 1**；
主体是 {200, 300} = 2（账号 4 与 8 同属主体 300）。

**边界用例都在钉时间锚点**：
`order 3` 的 `shipped_time` 正好等于 W18 的 `start_ts`，`order 9` 正好等于 W19 的 `end_ts`
⇒ 闭区间下它们都必须被算进来；把 `BETWEEN` 写成 `>` / `<` 的实现会两边各少一条，
而这种"少一条"在周环比上表现为"上周少一个、这周少一个"，很容易被当成正常波动。
另一条边界是 `order 10`：钱在 W18 付、货在 W19 发 —— **它只属于 W19**（锚点是发货）。
用 `pay_time` 的实现在这里必然给出不同的数。

**`shipped_time IS NULL` 的单永远不参与**（用例「所有发货时间清空」）：
只付款没发货是"待履约"，不是"活跃"。官方定义里 `shipped` 是**必要条件**。
把 NULL 也算进来的实现会给出"支付即活跃"，那正是素材里
"你若答按支付商家数，会被追问那和财报口径差多少"的那一步。

**"扣退款"那一列存在的意义**：不是给出第二个真相，而是**把差异量化成可讨论的数**。
供给侧指标（不扣）与成交质量指标（要扣）时间锚点天然不同，直接对比就是错的；
但同时出两列，业务方就能看到"这个周期有多少活跃靠退款撑住"。
只出一列、或把两列混成一个平均数，都算没做过指标治理。

**工程延伸（面试追问点）**

1. 为什么主体数要一起出？（"同主体批量注册账号"是虚假交易的典型形态之一，
   官方自列风险里就有"虚假交易可能使关键指标虚高"。
   账号数涨而主体数不涨 ⇒ 供给增长是注册出来的，不是招商招来的。）
2. 跨周期的退款怎么算？（`order_refund` 没有退款时间列是**有意的简化**：
   真实系统要记 `refund_time`，然后声明"扣退款口径按退款发生周期归属"还是
   "按原订单周期回溯" —— 两种都有人用，但**必须选一种并写进指标卡**，
   否则同一份数据能算出两个"活跃商家数"。）
3. 指标卡上该写哪五项？（触发事件、去重主体、时间归属、是否回溯、排除集。
   这题的官方定义五项齐全：shipped / 账号 / 发货时间落周期 / 不回溯 / 不扣退款。）
4. 为什么不用 `confirm_status`？（素材里活跃商家锚在"已发货"，而成交/结算锚在
   `confirm_status = 1 AND group_status = 1` —— 两组指标的时间锚点不同，
   混用会让"活跃商家涨、结算金额不涨"这类正常现象看起来像 bug。）"""

    return base(
        'sql', 'senior',
        '按财报原文算活跃商家：已发货触发、不扣退款、去重到账号，再并排出扣退款版本',
        statement, 'mysql',
        ['metric-definition', 'active-merchant', 'time-anchor', 'entity-granularity',
         'modern:metric-governance'],
        src('数据研发（指标与口径平台方向） 高级工程师',
            DATA + '#1 核心机制 5（20-F 对 active merchants 的定义原文：shipped / 不扣退款 / '
            '主体是账号）＋ 考点 2「素材建议 judgeKind=mysql，用例含发货后全额退款、'
            '同主体多账号、窗口边界跨天」；素材未给判据表'),
        language='sql',
        cases=[
            mut_case('基线：两个周期、账号数与主体数分岔、gap 只在 W19 出现',
                     schema, seed, [], COLUMNS, evaluate,
                     note='W18：2 个账号 / 1 个主体 / gap 0；W19：3 个账号 / 2 个主体 / gap 1'),
            mut_case('边界：把全额退款改成部分退款，官方口径与扣退款口径合流',
                     schema, seed, [('set', 'order_refund', 5, {'is_full': 0})], COLUMNS, evaluate,
                     note='账号 4 那单不再是"全额退款" ⇒ 两列相等、gap 归零；'
                          '官方那一列本来就没动过'),
            mut_case('删掉同主体另一账号唯一的发货单：账号数降一格，主体数不动',
                     schema, seed, [('del', 'orders', 6)], COLUMNS, evaluate),
            mut_case('时间锚点陷阱：把 W18 末那单的发货时间挪过界，它归属 W19',
                     schema, seed, [('set', 'orders', 2, {'shipped_time': '2026-05-04 00:00:00'})],
                     COLUMNS, evaluate,
                     note='W18 少 1 单、W19 多 1 单；用 pay_time 的实现看不到这次移动'),
            mut_case('退化：所有发货时间清空 ⇒ 六列全 0，而不是返回 NULL 或整行消失',
                     schema, seed, [('set', 'orders', sn, {'shipped_time': None})
                                    for sn in [1, 2, 3, 4, 5, 6, 8, 9, 10]], COLUMNS, evaluate,
                     note='没有任何发货 ⇒ 官方 0、扣退款 0、主体 0、行数 0；'
                          '周期卡本身仍要各出一行（"没数据"和"没这个周期"是两件事）'),
            mut_case('同主体再开一个账号：账号数变 3，主体数还是 1',
                     schema, seed, [('ins', 'merchant_shop', [9, 100]),
                                    ('ins', 'orders', [11, 9, '2026-04-28 09:00:00',
                                                       '2026-04-30 09:00:00', '12.00'])],
                     COLUMNS, evaluate,
                     note='W18 的 official 从 2 变 3，而 active_subjects 纹丝不动 —— '
                          '这就是"注册出来的增长"被可见化'),
            mut_case('边界：维表缺一个账号，主体数少一格而账号数不变',
                     schema, seed, [('del', 'merchant_shop', 3)], COLUMNS, evaluate,
                     note='COUNT(DISTINCT subject_id) 忽略没配到主体的账号 ⇒ 掉行不报错，'
                          '但两列的差会变大，这正是要盯的信号'),
        ],
        runner={'setup': sql_seed(schema, seed), 'orderSensitive': True, 'timeoutMs': 9000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer=answer,
    )


# =================================================================== M4 日账单对账
@draft('sql-pdd-bill-recon')
def q_bill_recon():
    CFG = [[1, '2026-05-15', '0.01']]
    ORDERS = [
        [2001, 1, 1, 0, '2026-05-10', '100.00', '5.00'],
        [2002, 1, 1, 0, '2026-05-11', '200.00', '10.00'],
        [2003, 1, 1, 0, '2026-05-20', '60.00', '3.00'],
        [2004, 1, 1, 1, '2026-05-09', '45.00', '2.00'],
        [2005, 1, 1, 0, '2026-05-09', '50.00', '2.50'],
        [2006, 1, 1, 0, '2026-05-09', '70.00', '3.50'],
        [2007, 0, 1, 0, '2026-05-09', '20.00', '1.00'],
        [2008, 1, 1, 0, '2026-05-08', '80.00', '4.00'],
        [2009, 1, 2, 0, '2026-05-09', '35.00', '1.50'],
    ]
    BILL = [['2026-05-12', 2001, '95.00'], ['2026-05-13', 2002, '189.99'],
            ['2026-05-11', 2008, '56.00']]
    REFUND = [[2005, '50.00'], [2008, '20.00']]

    schema = {
        'run_config': table_spec('id', ['id', 'as_of_date', 'tolerance'], [
            'id INT PRIMARY KEY', 'as_of_date DATE NOT NULL',
            'tolerance DECIMAL(12,2) NOT NULL']),
        'orders': table_spec('order_sn',
                             ['order_sn', 'confirm_status', 'group_status', 'risk_control_status',
                              'settle_due_date', 'pay_amount', 'service_fee'],
                             ['order_sn INT PRIMARY KEY', 'confirm_status TINYINT NOT NULL',
                              'group_status TINYINT NOT NULL',
                              'risk_control_status TINYINT NOT NULL',
                              'settle_due_date DATE NOT NULL',
                              'pay_amount DECIMAL(12,2) NOT NULL',
                              'service_fee DECIMAL(12,2) NOT NULL']),
        'bill_daily': table_spec('order_sn', ['bill_date', 'order_sn', 'settle_amount'], [
            'bill_date DATE NOT NULL', 'order_sn INT PRIMARY KEY',
            'settle_amount DECIMAL(12,2) NOT NULL']),
        'order_refund': table_spec('order_sn', ['order_sn', 'refund_amount'], [
            'order_sn INT PRIMARY KEY', 'refund_amount DECIMAL(12,2) NOT NULL']),
    }
    seed = {'run_config': CFG, 'orders': ORDERS, 'bill_daily': BILL, 'order_refund': REFUND}
    COLUMNS = ['order_sn', 'issue']

    def evaluate(rows):
        as_of, tol = rows['run_config'][0][1], dec(rows['run_config'][0][2])
        bill = {b[1]: dec(b[2]) for b in rows['bill_daily']}
        refund = {r[0]: dec(r[1]) for r in rows['order_refund']}
        out = []
        for o in rows['orders']:
            sn, confirm, group, risk, due, pay, fee = o
            if confirm != 1 or group != 1:
                continue                       # 不在"应结算"集合内，一律不判
            expected = dec(pay) - dec(fee) - refund.get(sn, Decimal('0'))
            if sn in bill:
                if abs(bill[sn] - expected) >= tol:
                    out.append([sn, 'amount-mismatch'])
                continue
            if due > as_of:
                out.append([sn, 'not-yet-due'])
            elif risk == 1:
                out.append([sn, 'risk-hold'])
            elif refund.get(sn, Decimal('0')) >= dec(pay):
                out.append([sn, 'refund-offset'])
            else:
                out.append([sn, 'real-gap'])
        return sorted(out, key=lambda x: int(x[0]))

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

平台给商家 / ISV 的资金对账通道是**"商家货款日账单下载链接"**
（`pdd.finance.balance.daily.bill.url.get`）—— 也就是说，**对账以"日账单文件"为一次真相，
不是实时接口**。实时接口只用来定位差异。

```
run_config  (id INT PK, as_of_date DATE, tolerance DECIMAL(12,2))   -- 单行参数表
orders      (order_sn INT PK, confirm_status, group_status, risk_control_status,
             settle_due_date DATE, pay_amount DECIMAL(12,2), service_fee DECIMAL(12,2))
bill_daily  (bill_date DATE, order_sn INT PK, settle_amount DECIMAL(12,2))  -- 日账单入库
order_refund(order_sn INT PK, refund_amount DECIMAL(12,2))
```

## 任务

输出**所有有问题的订单**，两列 `order_sn, issue`，按 `order_sn` 升序。
完全对得上的（`settled`）**不要输出**；没有任何问题时返回**空结果集**。

## 判据（按顺序命中即止，这张表就是判分点）

**应结算集合**：`confirm_status = 1 AND group_status = 1`。
不在这个集合里的订单（未成交、已取消、团失败）**一律不判** ——
注意"钱付了但团失败"（`confirm_status = 1 AND group_status = 2`）也**不在**应结算集合里。

**期望结算额** `expected = pay_amount − service_fee − COALESCE(refund_amount, 0)`。
（服务费是平台收入、不参与给商家的结算；退款要回冲。）

| 顺序 | 条件 | `issue` |
| --- | --- | --- |
| 1 | 账单里有这单，且 `ABS(settle_amount − expected) >= tolerance` | `amount-mismatch` |
| 2 | 账单里有这单且差额在容差内 | `settled`（**不输出**） |
| 3 | 账单里没有，且 `settle_due_date > as_of_date` | `not-yet-due` |
| 4 | 账单里没有、已到账期，且 `risk_control_status = 1` | `risk-hold` |
| 5 | 账单里没有、已到账期、非审核中，且 `refund_amount >= pay_amount`（全额退款） | `refund-offset` |
| 6 | 其余（账单里没有、已到账期、无上述任何理由） | `real-gap` |

`tolerance` 从 `run_config` 里读（**不要写死**），比较用 `>=`：
正好差一分（`0.01`）在默认容差 `0.01` 下**算差异**。

只提交**一条** `SELECT` / `WITH` 查询。

## 这题真正考的东西

- **第 6 类才是要报警的那一个**，前五类都是"可以解释的缺席"。
  只查"账单里多出来的"实现对，永远不会产出第 6 类，因为**少给钱**这个方向根本没被扫描。
- **风控审核中不是止损终点**：它解释的是"这一期为什么没结"，不是"这单可以不给"。
  所以 `risk-hold` 必须与 `real-gap` 分开，并且一旦 `risk_control_status` 被解除，
  同一行就要从前者变成后者。
- **容差是口径不是风格**：写成 `> 0` 会把 DECIMAL 显示差异当事故，
  写成 `>= 1` 会把真实的一分钱差错吞掉。"""

    reference = """WITH cfg AS (
  SELECT r.as_of_date, r.tolerance FROM run_config r
), universe AS (
  SELECT o.* FROM orders o WHERE o.confirm_status = 1 AND o.group_status = 1
), expected AS (
  SELECT u.order_sn, u.risk_control_status, u.settle_due_date, u.pay_amount,
         u.pay_amount - u.service_fee - COALESCE(rf.refund_amount, 0) AS expected_amount
  FROM universe u
  LEFT JOIN order_refund rf ON rf.order_sn = u.order_sn
)
SELECT e.order_sn,
       CASE WHEN b.order_sn IS NOT NULL THEN 'amount-mismatch'
            WHEN e.settle_due_date > c.as_of_date THEN 'not-yet-due'
            WHEN e.risk_control_status = 1 THEN 'risk-hold'
            WHEN COALESCE(rf2.refund_amount, 0) >= e.pay_amount THEN 'refund-offset'
            ELSE 'real-gap' END AS issue
FROM expected e
CROSS JOIN cfg c
LEFT JOIN bill_daily b ON b.order_sn = e.order_sn
LEFT JOIN order_refund rf2 ON rf2.order_sn = e.order_sn
WHERE b.order_sn IS NULL
   OR ABS(b.settle_amount - e.expected_amount) >= c.tolerance
ORDER BY e.order_sn"""

    naive = """-- "只查账单里多出来的 + 把风控当免单"版：
-- 该结没结的方向只报一个笼统的 missing，而审核中的单被直接跳过 —— 那笔钱就永久沉没。
SELECT b.order_sn, 'bill-only' AS issue
FROM bill_daily b
LEFT JOIN orders o ON o.order_sn = b.order_sn
WHERE o.order_sn IS NULL
UNION ALL
SELECT o.order_sn, 'missing'
FROM orders o
LEFT JOIN bill_daily b ON b.order_sn = o.order_sn
WHERE b.order_sn IS NULL AND o.confirm_status = 1 AND o.risk_control_status = 0
ORDER BY order_sn"""

    answer = """## 参考答案要点

先固定"应结算集合"（`confirm_status = 1 AND group_status = 1`）与期望额，
再对着账单做**一次** LEFT JOIN，用一个 `CASE` 按表里的顺序落类。
顺序不能换：`not-yet-due` 必须早于 `risk-hold`，
否则"未到账期且恰好在审核中"的单会被解释成"被风控扣住"，而真相是"还没到时候"。

**基线报出的五条**（用来核对 expected 是不是真的对）：
`2002 → amount-mismatch`：期望 `200.00 − 10.00 = 190.00`，账单给 189.99，
差 `0.01` 正好落在 `>= tolerance` 这一侧 —— **这条就是容差边界**。
`2003 → not-yet-due`（账期 05-20 晚于基准日 05-15）；
`2004 → risk-hold`；`2005 → refund-offset`（退款 50.00 ≥ 实付 50.00）；
`2006 → real-gap` —— **全题唯一需要人去做事的一条**。
`2001` 与 `2008` 对上了不输出（`2008` 是"扣服务费再扣部分退款"：
`80.00 − 4.00 − 20.00 = 56.00`，与账单一致）。
`2007`（未成交）与 `2009`（团失败）压根不在应结算集合里，
**哪怕它们也没进账单，也不许报成漏结** —— 这就是"钱付了不等于成交"在结算侧的体现。

**为什么 `risk-hold` 不能并进 `real-gap`**：两者的处置责任人不同。
审核中要问风控（什么时候解开、要不要止付），真差异要问结算（是账单生成漏了还是金额算错）。
合成一类之后，看板上的"对账异常数"会随风控动作起伏，
于是结算团队可以永远声称"这是风控的事"。

**风控解除之后同一行必须改类别**（用例「解除风控」）：
`risk_control_status` 从 1 变 0，那一行就从 `risk-hold` 变成 `real-gap`。
这条变化的意义是：**风控是延迟理由，不是免单理由**。
实现里如果把 `risk-hold` 做成"直接跳过不输出"，解除之后就什么记录都没有了 ——
那笔钱永久沉没，而这正是官方自列风险里的 "failure to manage funds accurately or loss of funds"
的日常形态。

**空结果集要真的是空**（用例「全部结清」）：
补齐账单、把没到账期的单挪到账期之外之后，查询返回零行。
判题侧注意：`mysql --batch` 在零行时连表头都不发，所以期望值必须是**裸空数组**
（`docs/JUDGING.md` 里的纪律，本仓库已经有题踩过一次）。

**工程延伸（面试追问点）**

1. 为什么以日账单为一次真相？（官方给外部的就是"日账单文件下载"。
   实时接口没有账期概念、也不保证补录；用它做终态对账会出现
   "两边都实时、谁也说不清哪边对"的死循环。）
2. 容差怎么定？（按**最小结算单位**定，不按感觉定：DECIMAL(12,2) 的系统里容差就是 0.01，
   比它小的差是显示/精度问题。跨币种才需要放大，
   而且要写成"容差 = 汇率换算步长"而不是一个拍出来的百分比。）
3. 服务费与佣金什么时候入账？（把服务费写进 `expected` 是**有意的简化**：
   真实系统要区分"账单口径的应结"与"订单口径的实付"，
   并把退款/赔付/服务费的**入账时点差**做成显式账期字段，否则 `amount-mismatch`
   会被时点差永久占据，真正的金额错误反而看不见。）
4. 只跑一个方向行不行？（不行。本查询是"订单侧有、账单侧无（或金额不对）"，
   反向还要有一条"账单侧有、订单侧不该有" —— 那是多付/重复结算，
   方向相反但同样是资损。只查一半的对账等于没做。）"""

    return base(
        'sql', 'senior',
        '日账单为一次真相：把"该结没结"拆成账期未到/风控/退款冲销/真差异四类',
        statement, 'mysql',
        ['settlement-recon', 'bill-of-record', 'risk-control', 'refund-offset',
         'modern:finance-consistency'],
        src('服务端研发（结算与资金方向） 高级工程师',
            TXN + '#1 核心机制 6（`pdd.finance.balance.daily.bill.url.get`：对账以日账单文件为'
            '一次真相）＋ 考点 10「素材建议 judgeKind=mysql：账单文件 vs 订单表差异定位」'
            '＋ §2 追问 7；素材给了通道与方向，未给可判分的四类判据表'),
        language='sql',
        cases=[
            mut_case('基线：四类缺席各中一条，真差异只有一条',
                     schema, seed, [], COLUMNS, evaluate,
                     note='2001/2008 对上不出；2007 未成交与 2009 团失败压根不在应结算集合里'),
            mut_case('容差边界：把账单补到一分不差，amount-mismatch 消失',
                     schema, seed, [('set', 'bill_daily', 2002, {'settle_amount': '190.00'})],
                     COLUMNS, evaluate),
            mut_case('容差放宽一分：同一笔分位差不再算差异（tolerance 必须从表里读）',
                     schema, seed, [('set', 'run_config', 1, {'tolerance': '0.02'})], COLUMNS, evaluate,
                     note='写死 0.01 的实现这里不会变，仍然把 2002 报出来 ⇒ 与期望不符'),
            mut_case('解除风控：同一行必须从 risk-hold 变成 real-gap',
                     schema, seed, [('set', 'orders', 2004, {'risk_control_status': 0})],
                     COLUMNS, evaluate,
                     note='风控是延迟理由不是免单理由；实现若直接跳过审核中单，这里会少一行'),
            mut_case('团失败但已支付：一旦变成"成交且成团"就进应结算集合',
                     schema, seed, [('set', 'orders', 2009,
                                     {'confirm_status': 1, 'group_status': 1})],
                     COLUMNS, evaluate,
                     note='基线里 2009 没进账单也不算问题（不在应结算集合）；'
                          '把应结算集合写成只看 confirm_status 的实现，基线就会多出一行'),
            mut_case('退款没到全额：refund-offset 不成立，落到 real-gap',
                     schema, seed, [('set', 'order_refund', 2005, {'refund_amount': '49.99'})],
                     COLUMNS, evaluate,
                     note='49.99 < 50.00 实付 ⇒ 不是全额冲销；期望额同时变成 50.00 − 2.50 − 49.99'),
            mut_case('全部结清：每一单都有账单且金额都对上 ⇒ 返回空结果集（裸 []）',
                     schema, seed, [('set', 'bill_daily', 2002, {'settle_amount': '190.00'}),
                                    ('del', 'order_refund', 2005),
                                    ('ins', 'bill_daily', ['2026-05-14', 2003, '57.00']),
                                    ('ins', 'bill_daily', ['2026-05-14', 2004, '43.00']),
                                    ('ins', 'bill_daily', ['2026-05-14', 2005, '47.50']),
                                    ('ins', 'bill_daily', ['2026-05-14', 2006, '66.50'])],
                     COLUMNS, evaluate,
                     note='2005 的退款先撤掉才能用 50.00 − 2.50 = 47.50 结清；'
                          '零行结果在 mysql 判题里必须写成裸 []，带 columns 会因没有表头而判不了'),
        ],
        runner={'setup': sql_seed(schema, seed), 'orderSensitive': True, 'timeoutMs': 9000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer=answer,
    )


# =================================================================== M5 差异定价体检
@draft('sql-pdd-price-consistency')
def q_price_consistency():
    LOG = [
        [1, 10, 'new', 'view', '99.00', None, None],
        [2, 10, 'old', 'view', '89.00', None, None],
        [3, 10, 'new', 'trade', '99.00', '89.00', '10.00'],
        [4, 10, 'old', 'trade', '89.00', '99.00', None],
        [5, 11, 'new', 'view', '59.00', None, None],
        [6, 11, 'old', 'view', '58.00', None, None],
        [7, 11, 'new', 'trade', '59.00', '90.00', '0.00'],
        [8, 11, 'old', 'trade', '58.00', '80.00', None],
        [9, 12, 'new', 'view', '10.00', None, None],
        [10, 12, 'old', 'view', '12.00', None, None],
        [11, 13, 'new', 'trade', '20.00', '20.00', '2.00'],
        [12, 13, 'new', 'view', '20.00', None, None],
    ]
    BASE = [[10, '99.00'], [11, '59.00'], [12, '11.00'], [13, '18.00'], [14, '7.00']]

    schema = {
        'price_log': table_spec('id', ['id', 'sku_id', 'user_bucket', 'row_type', 'show_price',
                                       'trade_price', 'coupon_deduct'],
                                ['id INT PRIMARY KEY', 'sku_id INT NOT NULL',
                                 'user_bucket VARCHAR(8) NOT NULL',
                                 'row_type VARCHAR(5) NOT NULL',
                                 'show_price DECIMAL(12,2) NOT NULL',
                                 'trade_price DECIMAL(12,2) NULL',
                                 'coupon_deduct DECIMAL(12,2) NULL']),
        'sku_base': table_spec('sku_id', ['sku_id', 'list_price'], [
            'sku_id INT PRIMARY KEY', 'list_price DECIMAL(12,2) NOT NULL']),
    }
    seed = {'price_log': LOG, 'sku_base': BASE}
    COLUMNS = ['sku_id', 'view_variants', 'trade_rows', 'effective_trade_variants',
               'max_trade_spread', 'risk_flag']

    def evaluate(rows):
        out = []
        for sku, _list_price in sorted(rows['sku_base']):
            mine = [l for l in rows['price_log'] if l[1] == sku]
            views = {dec(l[4]) for l in mine if l[3] == 'view'}
            trades = [l for l in mine if l[3] == 'trade']
            eff = [dec(l[5]) + dec(l[6] or '0') for l in trades]
            spread = (max(eff) - min(eff)) if eff else None
            out.append([sku, len(views), len(trades), len(set(eff)),
                        None if spread is None else float(spread),
                        1 if len(set(eff)) > 1 else 0])
        return out

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

两条硬合规边界（拼多多 20-F 原文引用）：
《平台经济领域的反垄断指南》禁止 "deploying big data analytics to set **discriminatory terms**
for merchandise prices or other transaction terms"；
PIPL 亦禁止基于个人信息自动分析从事 "**price discrimination**"。
由此得到的工程结论是：**个性化可以作用于排序 / 展示 / 发券，不可以作用于"同一商品、
同一交易条件下的定价"**。这条要能落成可验证的卡口才叫卡口 —— 本题就是那条卡口的体检版。

```
price_log(id INT PK, sku_id INT, user_bucket VARCHAR(8), row_type VARCHAR(5),
          show_price DECIMAL(12,2), trade_price DECIMAL(12,2) NULL,
          coupon_deduct DECIMAL(12,2) NULL)     -- row_type: 'view' | 'trade'
sku_base (sku_id INT PK, list_price DECIMAL(12,2))
```

- `row_type = 'view'`：一次曝光，只有 `show_price`（`trade_price` 为 NULL）；
- `row_type = 'trade'`：一笔成交，`trade_price` 是**买家这一件商品的实付价**，
  `coupon_deduct` 是这笔用的券抵扣（NULL = 没用券）。

## 任务

对 `sku_base` 里**每一个** SKU 输出一行（没有任何日志的 SKU 也要出），
按 `sku_id` 升序，列名与顺序必须是：

```
sku_id, view_variants, trade_rows, effective_trade_variants, max_trade_spread, risk_flag
```

## 口径（这张表就是判分点）

1. `view_variants` = 该 SKU **曝光行**里 `COUNT(DISTINCT show_price)`。
   **展示价多几种不是红旗** —— 个性化允许作用于展示。
2. `trade_rows` = 该 SKU 的成交行数。
3. **有效成交价** `effective = trade_price + COALESCE(coupon_deduct, 0)`，只算成交行。
   比较价格必须**先把券加回去**：两个桶实付不同、但加回券之后相等，
   那是"券的发放不同"（允许），不是"定价不同"（禁止）。
4. `effective_trade_variants` = 该 SKU 成交行上的 `COUNT(DISTINCT effective)`。
5. `max_trade_spread` = `MAX(effective) − MIN(effective)`；
   **没有任何成交行时输出 NULL**（不是 0 —— "没卖过"与"卖得很一致"是两件事）。
6. `risk_flag` = 1 当且仅当 `effective_trade_variants > 1`。
   即：**同一 SKU 的成交价在加回券之后仍然不一致**才算差异定价红旗。

只提交**一条** `SELECT` / `WITH` 查询。

## 这题真正考的东西

- **判错方向就是判错性质**：拿 `show_price` 去比 ⇒ 一片假阳性
  （平台允许展示个性化，越报越没人看）；拿 `trade_price` 直接比 ⇒ 漏报
  （真正的差异定价被券掩盖）。两种错误在同一个报表上还会互相"印证"。
- **NULL 与 0 的分界**（第 5 列）：把"没成交"输出成 0 极差，
  报告上就出现"这个 SKU 定价完全一致"的假结论。
- **没有日志的 SKU 也必须出一行**：漏掉它们，等于对"从来没被买过的商品"
  做免检 —— 而差异定价最常藏在新品的头几笔里。"""

    reference = """WITH trades AS (
  SELECT p.sku_id,
         p.trade_price + COALESCE(p.coupon_deduct, 0) AS effective
  FROM price_log p
  WHERE p.row_type = 'trade'
), view_variants AS (
  SELECT p.sku_id, COUNT(DISTINCT p.show_price) AS variants
  FROM price_log p
  WHERE p.row_type = 'view'
  GROUP BY p.sku_id
), agg AS (
  SELECT t.sku_id,
         COUNT(*) AS trade_rows,
         COUNT(DISTINCT t.effective) AS eff_variants,
         MAX(t.effective) - MIN(t.effective) AS spread
  FROM trades t
  GROUP BY t.sku_id
)
SELECT b.sku_id,
       COALESCE(v.variants, 0) AS view_variants,
       COALESCE(a.trade_rows, 0) AS trade_rows,
       COALESCE(a.eff_variants, 0) AS effective_trade_variants,
       a.spread AS max_trade_spread,
       CASE WHEN COALESCE(a.eff_variants, 0) > 1 THEN 1 ELSE 0 END AS risk_flag
FROM sku_base b
LEFT JOIN view_variants v ON v.sku_id = b.sku_id
LEFT JOIN agg a ON a.sku_id = b.sku_id
ORDER BY b.sku_id"""

    naive = """-- "看展示价就行"版：拿 show_price 算差异 ⇒ 假阳性一片；
-- 而 trade_price 加回券之后真正不一致的那个 SKU 反而没被抓出来。
SELECT b.sku_id,
       COUNT(DISTINCT p.show_price) AS view_variants,
       COUNT(p.id) AS trade_rows,
       COUNT(DISTINCT p.show_price) AS effective_trade_variants,
       COALESCE(MAX(p.show_price) - MIN(p.show_price), 0) AS max_trade_spread,
       CASE WHEN COUNT(DISTINCT p.show_price) > 1 THEN 1 ELSE 0 END AS risk_flag
FROM sku_base b
LEFT JOIN price_log p ON p.sku_id = b.sku_id
GROUP BY b.sku_id
ORDER BY b.sku_id"""

    answer = """## 参考答案要点

先把成交行的 `effective = trade_price + COALESCE(coupon_deduct, 0)` 算出来
（**一个 CTE 只做这一件事**），曝光行单独聚一个 `view_variants`，
最后以 `sku_base` 为驱动表做两次 LEFT JOIN。
驱动表是 SKU 目录而不是日志，这是"没日志也要出一行"的唯一写法。

**基线五行的关键分岔**（用来核对 expected 是不是真的对）：
`sku 10`：两个桶曝光价 99.00 / 89.00（两种展示价），
成交实付 89.00（带 10.00 的券）与 99.00（没券）⇒ 有效价都是 99.00 ⇒
`effective_trade_variants = 1`、极差 0.00、**risk_flag = 0**。
这是全题最重要的一行：**展示价不同、实付不同，但定价相同** —— 差异只在发券。
`sku 11`：实付 90.00（券 0.00）与 80.00（没券）⇒ 有效价 90.00 / 80.00 ⇒
`effective_trade_variants = 2`、极差 10.00、**risk_flag = 1**。
`sku 12`：只有曝光没有成交 ⇒ `trade_rows = 0`、有效价种类 0、极差 **NULL**、risk_flag 0。
`sku 13`：一笔成交，有效价 `20.00 + 2.00 = 22.00` ⇒ 一种、极差 0.00、不报。
`sku 14`：完全没日志 ⇒ 四个数是 0/0/0/NULL、risk_flag 0，**但这一行必须存在**。

**"先加回券再比"为什么是判分点**：券的发放本来就是允许的个性化维度。
直接比 `trade_price`，`sku 10` 会被误报成差异定价 —— 而它的曝光价与实付价都"看起来不同"，
所以这个误报特别可信。**误报的代价不是吵，是把唯一那条真红旗（`sku 11`）埋起来。**

**极差为 NULL 的两行**（`sku 12`、`sku 14`）：
`MAX/MIN` 在空集上是 NULL，兜成 0 就得到"这个 SKU 定价完全一致"。
体检报告里"一致"和"没数据"必须能区分 —— 这与本仓库 DQC 那道题里
"分母为 0 时比率输出 NULL 而不是 0%"是同一条纪律：**判不了就不要装作判过了。**

**为什么以 SKU 目录为驱动表**（用例「某 SKU 日志全删」）：
以日志为驱动表时，日志被清空的商品会**整行消失**，
报告上看不出任何异常，而实际上它对体检彻底免疫。

**工程延伸（面试追问点）**

1. 这个查询能当上线卡口吗？（不能，它只能事后体检。上线卡口要落在**价格决策日志**上：
   每次出价记录 `(sku_id, user_bucket, 决策依据版本, 输出价)`，
   灰度阶段跑同样的"加回券再比"，不一致就阻断发布。）
2. 什么情况下有效价不同是合法的？（限时限量购、活动批次、券批次过期、
   `pdd.order_change_amount`（订单改价）都会让有效价不同 —— 所以真实系统里
   `risk_flag` 只是**待复核**标记，必须再挂一层"能否用活动/改价解释"的白名单，
   否则误杀量会把人工复核队列压满。）
3. `user_bucket` 应该怎么设计才不会自证清白？（不能用价格模型自己的分桶作为检查维度 ——
   那等于让被测系统提供观测口径。检查要用**独立分桶**（按账号哈希重切一遍）。
   这与广告那道题"分流桶与报表分组必须同构"是一对镜像：
   对齐时同构，检查时必须不同构才能发现漂移。）
4. 曝光多样性要不要监控？（要，但作为**另一个指标**：曝光价方差反映的是发券与展示策略，
   把它和差异定价混在一列里，等于把两个责任人不同的东西塞进同一个告警。）"""

    return base(
        'sql', 'senior',
        '差异定价体检：先把券加回成交价再比，展示价多几种不是红旗、没成交必须输出 NULL',
        statement, 'mysql',
        ['price-consistency', 'compliance-check', 'null-vs-zero', 'coupon-attribution',
         'modern:pricing-governance'],
        src('服务端研发（商品与价格链路方向） 高级工程师',
            TXN + '#4 考点 6（`pdd.goods.price.check` / `pdd.goods.advice.price.get` / '
            '`pdd.order_change_amount` 三个官方接口 + 20-F 引用的反垄断指南 '
            '"discriminatory terms" 与 PIPL "price discrimination" 原文；'
            '素材建议 judgeKind=mysql「同一 SKU 多次展示价方差/差异定价体检」，未给判据表'),
        language='sql',
        cases=[
            mut_case('基线：曝光价不同的合法行 vs 加回券仍不同的红旗行',
                     schema, seed, [], COLUMNS, evaluate,
                     note='sku 10 有效价两边都是 99.00 ⇒ 不报；sku 11 是 90.00 vs 80.00 ⇒ 报'),
            mut_case('把券加回去就一致了：给红旗行补一张 10.00 的券，risk_flag 归零',
                     schema, seed, [('set', 'price_log', 8, {'coupon_deduct': '10.00'})],
                     COLUMNS, evaluate,
                     note='80.00 + 10.00 = 90.00 与另一桶一致 ⇒ 差异变成"发券不同"，合规允许'),
            mut_case('反向陷阱：让本来一致的 sku 10 出现两种有效价',
                     schema, seed, [('ins', 'price_log', [13, 10, 'old', 'trade', '99.00',
                                                          '95.00', '2.00'])], COLUMNS, evaluate,
                     note='有效价 97.00 vs 99.00 ⇒ 极差 2.00、risk_flag 1；'
                          '只看 show_price 的实现看不到这次变化（新行的曝光价与已有的一种相同）'),
            mut_case('退化：某 SKU 日志全删 ⇒ 行还在，四个数归零而极差必须是 NULL',
                     schema, seed, [('del', 'price_log', 9), ('del', 'price_log', 10)],
                     COLUMNS, evaluate,
                     note='sku 12 只剩零条日志 ⇒ trade_rows 0、有效价种类 0、极差 NULL；'
                          '以日志为驱动表的实现会让这一行整条消失'),
            mut_case('边界：只剩一笔成交时极差是 0.00 而不是 NULL',
                     schema, seed, [('del', 'price_log', 3)], COLUMNS, evaluate,
                     note='sku 10 剩一条成交（实付 99.00、没券）⇒ 一种有效价、极差 0.00、不报；'
                          '"空集兜成 0"与"只有一条时该给 0"是两件事，两条用例各钉一边'),
            mut_case('曝光多样性上升，红旗数纹丝不动（判错方向就会报出一堆假阳性）',
                     schema, seed, [('ins', 'price_log', [14, 11, 'vip', 'view', '57.00',
                                                          None, None]),
                                    ('ins', 'price_log', [15, 11, 'new', 'view', '61.00',
                                                          None, None])], COLUMNS, evaluate,
                     note='只加曝光行 ⇒ sku 11 的 view_variants 从 2 变 4，'
                          '而 effective_trade_variants 与 risk_flag 不许动'),
        ],
        runner={'setup': sql_seed(schema, seed), 'orderSensitive': True, 'timeoutMs': 9000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== R1 券额度的 Redis 落地
@draft('sql-pdd-coupon-quota-redis')
def q_coupon_quota_redis():
    """批次额度落到 Redis：用 ZSET 的"成员唯一性"把超发变成结构上不可能，
    用 ZADD NX 把重放变成 no-op。EVAL 被白名单禁掉，所以只能靠数据形状解。"""

    setup = [
        'DEL coupon:B1:codes',
        'DEL coupon:B1:closed',
        'HSET coupon:B1:cap total 5 issued 3',
        'ZADD coupon:B1:codes 1 c-001',
        'ZADD coupon:B1:codes 2 c-002',
        'ZADD coupon:B1:codes 3 c-003',
    ]
    reference = """# E1 新领一张券 c-004（seq 4）
ZADD coupon:B1:codes 4 c-004
# E2 同一个领取请求重放，但客户端拿到的 seq 变了（6）
#    ⇒ 必须 NX：不加 NX 会把 c-004 的 seq 改写成 6，重放就不是 no-op 了
ZADD coupon:B1:codes NX 6 c-004
# E3 再领一张 c-005（seq 5）⇒ 发行量到此正好 5 张，触及上限
ZADD coupon:B1:codes 5 c-005
# E4 又有请求要领 c-006，但批次额度已满 ⇒ 一条写入命令都不许发。
#    本脚本已经写了 5 个成员，超发在这个数据结构里不可能发生。
# E5 关单退回 c-002
ZREM coupon:B1:codes c-002
# E6 关闭批次：只挡新领，绝不回收已发出去的券
SET coupon:B1:closed 1"""

    naive = """# "计数器一把梭"版：容量靠 INCR/DECR 自己数，
# 于是重放会多加、超发要事后才发现、关闭批次顺手把整个 key 删掉。
INCR coupon:B1:cap_total_x
SET coupon:B1:cap 6
DEL coupon:B1:codes
SET coupon:B1:closed 1"""

    statement = """## 背景

拼多多的优惠券是**批次**模型，官方三个动作说明"发行量"是一个独立额度对象：
`pdd.promotion.goods.coupon.create`（创建批次）、`pdd.promotion.coupon.quantity.add`
（**增加发行数量**）、`pdd.promotion.coupon.close`（**关闭批次**）。
而且**已发出去的券不可回收** —— 关闭批次只停新领，不撕已发的承诺。

算法课里已经有一道同方向的双池子模型题（券额度 vs 商品库存）；
**这题是它的落地版：只用 Redis 命令，把"超发"和"重放"变成结构上不可能发生的事。**

## 环境

Redis 7.2.7。**禁止** `EVAL` / `EVALSHA` / `SCRIPT` / `FCALL` / `KEYS` / `FLUSHDB` /
`CONFIG` / `DEBUG` / `SORT` / `OBJECT` / `SELECT`（判题器直接拒）。
所以"用 Lua 做 owner 校验 / 做 if-else 分支"不在解空间内。

## 判题方式（先读这段）

判题**不模拟并发、也不让时间流逝**。它做三件事：
1. 按下面的"初始状态"把 Redis 摆好；
2. 按顺序执行你提交的**这一份命令脚本**（每行一条，`#` 开头是注释）；
3. 逐条执行校验命令并比对最终状态。

所以你写的是"针对这个已知场景的一段安全脚本"。
脚本里**没有分支可用** —— 一切条件都要靠命令自己（`NX` / `XX`）或数据形状来表达。

## 初始状态

```
HSET coupon:B1:cap total 5 issued 3            -- 批次发行上限 5，已发 3
ZADD coupon:B1:codes 1 c-001 / 2 c-002 / 3 c-003   -- 已发的券码集合（score = 领取序号）
coupon:B1:closed 不存在                          -- 批次未关闭
```

## 同一批到达的 6 个事件（必须全部处理）

| 事件 | 情况 | 必须 | 绝对不许 |
| --- | --- | --- | --- |
| E1 | 领一张新券 `c-004`，seq 4 | 写进券码集合 | 覆盖已有成员 |
| E2 | **同一个领取请求重放**，但 seq 生成器给了 6 | 变成 no-op | 把 `c-004` 的 seq 改写成 6 |
| E3 | 领 `c-005`，seq 5 | 写入 ⇒ 发行量正好到 5 | 越过上限 |
| E4 | 还想领 `c-006`，但额度已满 | **什么都不发** | 造出第 6 个成员 |
| E5 | 关单退回 `c-002` | 把它从集合里移掉 | 留在集合里（额度永远还不回来） |
| E6 | 关闭批次 | 落下关闭标记 | 顺手把已发券的集合删掉 |

要求最终状态（校验命令会读这些）：`coupon:B1:codes` 里恰好是
`c-001`(1) / `c-003`(3) / `c-004`(**4**) / `c-005`(5) 四个成员；`coupon:B1:closed` 为 `1`；
`coupon:B1:cap` 这个 HASH 的 `total` 字段仍然是 `5`。

## 这题真正考的东西

1. **额度不能是计数器**：`DECR`/`INCR` 的语义是"先改再说"，
   中断、重放、并发都会把它推离真相，而**偏移方向是双向的**
   （多加 ⇒ 超发资损；少加 ⇒ 券发不出去被投诉）。
   用**集合成员**表示"一张已发出的券"，超发就只能是"多一个成员"，
   而成员数量与上限的核对是一次 `ZCARD` 就能做完的断言。
2. **重放必须落到同一个成员**：`ZADD key 6 c-004`（不带 NX）会把 seq 改掉 ——
   看起来"还是那 5 张"，但**领取顺序被重放事件改写了**，
   于是"先领先得"的公平性失效，而且事后从数据上完全看不出来。
3. **关闭批次只改变准入，不改变承诺**：`SET closed 1` 是对的，
   `DEL coupon:B1:codes` 是**单方面撕券** —— 那才是素材里"超发风险由保证金兜底"的兑现形态。

只交一段命令脚本，不需要写代码。"""

    answer = """## 参考答案

```
ZADD coupon:B1:codes 4 c-004
ZADD coupon:B1:codes NX 6 c-004     # 重放 ⇒ no-op，seq 保持 4
ZADD coupon:B1:codes 5 c-005
# E4 额度已满：一个命令都不发
ZREM coupon:B1:codes c-002
SET coupon:B1:closed 1
```

**为什么 `c-004` 的 score 必须是 4 而不是 6**：
`ZADD` 不带 `NX` 时对已存在成员是**更新分数**。
重放事件带来的是一个"更晚生成的 seq"，它比原值大 ⇒ 不但不报错，
还会把 `c-004` 从领取顺序的第 4 位推到第 6 位。
症状是"先发券的用户排队排到后面去了"，而**发行总量看起来完全正确** ——
这是本仓库反复强调的那类"静默降级"：所有聚合数都对，只有顺序错了。
`NX` 的语义恰好是"只在成员不存在时写入"，它把重放变成真正的 no-op。

**为什么"什么都不发"是 E4 的正确实现**：
脚本没有分支，所以只能靠**写脚本的人已经知道额度已满**这一事实。
判题矩阵证明的是"这份脚本在这个初始状态下产出的最终状态是对的"。
线上不能这么写 —— 线上有三条路：
① `EVAL` 里判 `ZCARD >= total`（**被白名单禁掉，本题就是考你知道该禁**）；
② 把额度做成**分桶预占**：`ZADD bucket:<i> …`，桶数 × 每桶上限 = 总发行量，
   超发在结构上不可能，代价是分配不均时会有空桶；
③ 用队列 + 单一写入者（把"要不要发"这个决策集中到一个进程里），
   写路径变成幂等的 `ZADD`。
第 ② 条是这套题里最值得答出来的：它把"额度校验"从流程问题变成了**数据建模**问题。

**关闭批次不许删集合**（校验里那条"被撕掉的券不能再回来"）：
`DEL coupon:B1:codes` 会把 5 张已发券一并抹掉 ——
它同时毁掉了三样东西：消费者的兑现承诺、额度的历史真相（事后无法回答
"这个批次一共发出去多少"）、以及审计举证链（素材里"一店一处罚"要求逐单可复原）。
正确形态是**只加一个准入标记**，让 `closed` 参与读路径的判断，而不是参与写路径的清理。

**工程延伸（面试追问点）**

1. 为什么 score 用领取序号而不是时间戳？（时间戳在同一毫秒内会撞，撞了就退化成"按 member
   字典序"，于是"先领先得"变成随机；单调 seq 需要 `INCR` 发号，
   那是一次额外往返，但是**唯一能保证顺序的写法**。）
2. `ZCARD` 与 `HSET cap issued` 两个数不一致怎么办？（这正是本题把"已发"做成集合的理由：
   集合并**不需要**与 issued 一致，它才是真相。真实系统里 issued 是缓存、集合是事实，
   对账任务要拿集合去修 issued，而不是反过来。）
3. 退回一张券算不算"额度还回来"？（要分业务：`ZREM` 之后 `ZCARD` 变小 ⇒ 可以再发。
   但如果这张券还没过期且允许再次核销，正确做法是**保留成员 + 标记未用**
   （再加一个 `ZSET coupon:B1:unused`），否则"退回额度"和"退给消费者"会被混成一件事。）
4. 商品库存那一半呢？（券够货不够是乘积区事故。落地时必须把
   `ZCARD codes` 与剩余可售库存放在**同一个决策点**上比较 ——
   那就是算法题「券批次发行量与商品库存是两套池子」里最后那个 `无货可兑` 的数。）"""

    return base(
        'sql', 'senior',
        '券批次额度的 Redis 落地：集合成员才是发行量，重放必须 NX，关批次不许撕券',
        statement, 'redis',
        ['coupon-quota', 'idempotent-replay', 'data-shape-solves-it', 'no-lua-constraint',
         'modern:marketing-integrity'],
        src('服务端研发（营销/券与活动方向） 高级工程师',
            TXN + '#4 考点 7（券批次三动作 create / quantity.add / close 是官方接口；'
            '素材建议 judgeKind=redis「批次额度预占/回滚 + 关闭批次的并发语义 + 防超发」，'
            '并限定"owner 校验只能靠数据形状解"因为 EVAL 被禁）'),
        language='sql',
        cases=[
            {'name': '重放不许改写领取顺序：c-004 的 score 仍是首次的 4',
             'input': ['ZSCORE coupon:B1:codes c-004'], 'expected': '4',
             'note': '不带 NX 的 ZADD 会把它改成 6 —— 发行总量看着对，只有顺序错了'},
            {'name': '已发券集合基数是 4（发了 5 张、退回 1 张）',
             'input': ['ZCARD coupon:B1:codes'], 'expected': 4},
            {'name': '边界：额度到顶时不许多出成员（score > 5 的成员数是 0）',
             'input': ['ZCOUNT coupon:B1:codes 6 +inf'], 'expected': 0,
             'note': '用 ZCARD 判超发在并发下会赢者通吃；这一条断的是"根本没有第 6 张"'},
            {'name': '退回的那张必须真被移掉',
             'input': ['ZSCORE coupon:B1:codes c-002'], 'expected': None,
             'note': '没 ZREM 的话这 1 个额度永久还不回来，实际可售券只剩 4 张'},
            {'name': '关闭批次只挡新领，不许回收已发券：集合还在',
             'input': ['EXISTS coupon:B1:codes'], 'expected': 1,
             'note': 'DEL 掉集合 = 单方面撕券，同时毁掉额度历史与审计举证链'},
            {'name': '关闭标记要落下', 'input': ['GET coupon:B1:closed'], 'expected': '1'},
            {'name': '发行上限不许被这个脚本改掉',
             'input': ['HGET coupon:B1:cap total'], 'expected': '5',
             'note': '加发行量是另一个动作（quantity.add），不在本场景里 ⇒ 动了就是越权'},
            {'name': '被拒的那张 c-006 绝不许存在',
             'input': ['ZSCORE coupon:B1:codes c-006'], 'expected': None},
        ],
        runner={'setup': setup, 'entry': 'function', 'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


# =================================================================== R2 库存投影的版本化写入
@draft('sql-pdd-inventory-projection-redis')
def q_inventory_projection_redis():
    """调整单会乱序、会重放。投影存"版本化绝对值"而不是"增量"，
    于是乱序无害、重放天然幂等、历史可逐单举证。"""

    setup = [
        'DEL stock:hist:SKU9:whA',
        'DEL stock:hist:SKU9:whB',
        'DEL stock:proj:SKU9',
        'HSET stock:prio:SKU9 whA 1 whB 2',
        'ZADD stock:hist:SKU9:whA 18 18|50',
    ]
    reference = """# M1（seq 30）whA 同步为 28
ZADD stock:hist:SKU9:whA 30 30|28
# M2（seq 25）一条**乱序到达的旧消息**：它带来的是过时的值 40
#    记进历史无害 —— 读路径取 max score，所以它覆盖不了当前值
ZADD stock:hist:SKU9:whA 25 25|40
# M3 重放 M1 那一张调整单（move_order_sn 相同 ⇒ 内容与 seq 都相同）
#    同一个 member + 同一个 score ⇒ ZADD 是 no-op，历史不会多出一条
ZADD stock:hist:SKU9:whA 30 30|28
# M4（seq 31）另一个仓 whB 同步为 7
ZADD stock:hist:SKU9:whB 31 31|7
# M5（seq 32）商家把 whA 改成 0
ZADD stock:hist:SKU9:whA 32 32|0
# 不许 HSET stock:proj:SKU9 …：那是"最后写入赢"，乱序消息会把 40 写回当前值
# 也不许 DEL 任何历史：一店一处罚要求逐单可复原"""

    naive = """# "投影就是一个 HASH 字段"版：谁后到谁赢。
# 乱序重放的旧消息会把过时的 40 写成当前值 —— 而且没有任何痕迹。
HSET stock:proj:SKU9 whA 40
HSET stock:proj:SKU9 whA 28
HSET stock:proj:SKU9 whB 7
HSET stock:proj:SKU9 whA 0"""

    statement = """## 背景

平台侧不持有库存，商家随时可以通过开放平台接口改；同步通道走的是**调整单**语义
（`pdd.stock.ware.move`：`move_direction` 有 `1 入库 / 2 出库 / 3 库存同步`，
`business_type` 有 `… / 6 库存同步`，`move_order_sn` 天然唯一）。
消息会**乱序**、会**重放**、单批还有大小上限。

于是"投影怎么落库"就是一道真题：**用什么数据形状，才能让乱序与重放都无害？**

## 环境

Redis 7.2.7。**禁止** `EVAL` / `EVALSHA` / `SCRIPT` / `KEYS` / `FLUSHDB` / `CONFIG` /
`DEBUG` / `SORT` / `OBJECT` / `SELECT`（判题器直接拒）。

## 判题方式（先读这段）

判题**不模拟并发、也不让时间流逝**：摆好初始状态 ⇒ 按顺序执行你提交的一段命令脚本 ⇒
逐条执行校验命令比对最终状态。
脚本里没有分支，条件只能靠命令（`NX` / `XX`）或**数据形状**表达。

## 初始状态

```
HSET stock:prio:SKU9 whA 1 whB 2          -- 多仓优先级由**商家**配置（pdd.stock.depot.priority.update）
ZADD stock:hist:SKU9:whA 18 18|50          -- 每个仓一条版本化历史：score = seq，member = "seq|qty"
```

## 按到达顺序执行的五条调整单

| 事件 | seq | 仓 | 同步到的绝对值 | 备注 |
| --- | --- | --- | --- | --- |
| M1 | 30 | whA | 28 | 正常 |
| M2 | **25** | whA | 40 | **乱序到达的旧消息**（网络重传），值已过时 |
| M3 | 30 | whA | 28 | **重放 M1 同一张调整单**（`move_order_sn` 相同 ⇒ seq 与内容都相同） |
| M4 | 31 | whB | 7 | 另一个仓 |
| M5 | 32 | whA | 0 | 商家把 whA 改成 0 |

## 要求（校验命令会读这些）

- 每个仓一条 ZSET：`stock:hist:SKU9:<仓>`，`score = seq`，`member = "<seq>|<qty>"`。
- **当前值 = 分数最大的那一条**（`ZREVRANGE key 0 0`），所以：
  `whA` 当前是 `32|0`、`whB` 当前是 `31|7`；`25|40` 这条**必须留在历史里但不许当当前值**。
- `whA` 的历史条数恰好是 4（`18|50`、`25|40`、`30|28`、`32|0`）——
  **重放 M3 不许多出一条**。
- `30|28` 这条的分数仍然是 30。
- `stock:prio:SKU9` 的 `whA` 仍然是 `1`（**优先级由商家配置，同步通道不许改它**）。
- 任何一条历史都不许被 `DEL` 掉（哪怕值是 0）—— 素材里"一店一处罚"要求逐单可复原。

## 这题真正考的东西

1. **"最后写入赢"与"最新版本赢"是两件事**。
   `HSET` 按到达顺序决定当前值，于是重传的旧消息会把过时数值写成当前值 ——
   它**不报任何错**，只是把投影拉回三天前。
2. **绝对值 + 版本号**是这道题唯一的解形状：写路径不需要读、不需要比较、不需要分支，
   因此乱序与重放都无害；而"当前值"是读路径上的一次 `max(score)`。
3. **历史不是垃圾**：`ZADD` 让旧版本留在集合里是有意的 ——
   它同时给出"可逐单举证"的审计链与"投影准确率"这个 SLI 的数据源。

只交一段命令脚本，不需要写代码。"""

    answer = """## 参考答案

```
ZADD stock:hist:SKU9:whA 30 30|28
ZADD stock:hist:SKU9:whA 25 25|40     # 乱序旧消息：记录无害，读的是 max score
ZADD stock:hist:SKU9:whA 30 30|28     # 重放同一张调整单：同 member 同 score ⇒ no-op
ZADD stock:hist:SKU9:whB 31 31|7
ZADD stock:hist:SKU9:whA 32 32|0
```

**为什么重放天然幂等**：member 是 `"<seq>|<qty>"`，score 是 `seq`。
同一张调整单（同一个 `move_order_sn`）必然带来同一个 seq 与同一个数量 ⇒
`ZADD` 写进去的是**同一个成员**，集合基数不变。
这就是"幂等"从流程问题变成数据建模问题的标准形态：
不需要"先查是否见过"（那是竞态），也不需要 `SETNX` 记请求号（那要额外 TTL 治理）。
校验里 `whA` 历史条数是 4 就是这一条的断言 —— 实现如果用 `HSET stock:proj:SKU9 whA <seq>`
（只有版本没有值，或者反过来）都到不了 4。

**乱序旧消息为什么必须"记下来但不生效"**：
`25|40` 的 seq 比当前值 32 小 ⇒ `ZREVRANGE … 0 0` 永远不会选中它，
而它留在历史里带来两件事：
① 审计可以回答"这条消息到过、它带的是什么值"（素材里监管取证要的就是这种逐单可复原）；
② 可以算**乱序率**这个 SLI（"到达顺序 ≠ seq 顺序"的比例），
   它是同步通道健康度最直接的信号，而"最后写入赢"的实现**算不出这个数**
   —— 因为它已经把顺序信息覆盖掉了。

**为什么不许 `DEL`**：`whA` 变成 0 之后，最"干净"的写法是
`ZREM`/`DEL` 掉这个仓的所有历史。这在成本上是对的，在合规上是错的：
素材里"一店一处罚""6 万多个具体案件不能批量认定"意味着
**必须能按单还原任意时刻的状态**。删除历史等于把可举证期从"数据保留期"
压缩成"你还没删之前"，而 30 天滚动日志在监管取证时等于没有。

**多仓优先级为什么单独一张 HASH**：
`pdd.stock.depot.priority.update` 说明**优先级是商家配的**，与库存同步是两条独立写路径。
把它们塞进同一个 key（例如 member 写成 `prio|seq|qty`）会造成
"库存同步顺手改了优先级"这种越权 —— 校验那条 `HGET stock:prio:SKU9 whA` 就是拦这个的。
可用量在真实系统里 = 按优先级顺序对多仓求和（且受可达范围限制），
那是**读路径**的事，绝不能在写路径上被合并掉。

**工程延伸（面试追问点）**

1. ZSET 会不会无限增长？（会，所以要"按版本压缩"而不是"按时间删"：
   保留最新 N 条 + 全部**跨状态变化**的边界条（例如 0 ↔ 非 0），
   并且压缩只往更老的版本压，当前值与举证期内的版本永不动。）
2. 为什么 member 里要重复存 seq（score 已经是 seq）？
   （为了 `ZSCORE key "<seq>|<qty>"` 这类**按内容定位**的查询：
   审计给的是"那张调整单同步了多少件"，不是分数。
   代价是同一份信息两处存，好处是历史可以被逐条举证而不需要反解分数。）
3. 投影准确率怎么落成指标？（拿 `max(score)` 那条与商家侧查询接口
   （`pdd.stock.ware.warehouse.query`）在某时刻的返回值比：
   `|投影 − 商家值| / 商家值` 的分布就是投影准确率。
   分母要用**同一时刻**，否则你测的是通道滞后而不是准确性。）
4. 和算法题「库存是商家的镜像」是什么关系？（那题把滞后写成 `lag` 并算出假有货峰值；
   这题是滞后的**来源**：乱序、重放、以及"最后写入赢"这三种实现。
   面试题里能主动把两层接起来 —— 先建模滞后、再解释滞后从哪来 —— 才是做过这条链。）"""

    return base(
        'sql', 'senior',
        '库存投影要存版本化绝对值：乱序不覆盖当前值、重放天然幂等、历史不许删',
        statement, 'redis',
        ['inventory-projection', 'out-of-order-writes', 'idempotent-replay', 'audit-trail',
         'modern:data-consistency'],
        src('服务端研发（库存与履约方向） 高级工程师',
            TXN + '#4 考点 1（调整单语义：`move_direction=3 库存同步`、`business_type=6`、'
            '`move_order_sn` 天然幂等键、单批 ≤30）＋ `pdd.stock.depot.priority.update` 多仓优先级'
            '＋ 素材建议 judgeKind=redis「多仓优先级 + 同步乱序下的可用性判定与幂等调整单」'),
        language='sql',
        cases=[
            {'name': '乱序旧消息不许成为当前值：whA 当前是 32|0',
             'input': ['ZREVRANGE stock:hist:SKU9:whA 0 0'], 'expected': ['32|0'],
             'note': '最后写入赢的实现这里是 25|40 或 32|0 取决于顺序，总之不可信'},
            {'name': '重放同一张调整单不许多出一条历史：whA 历史条数是 4',
             'input': ['ZCARD stock:hist:SKU9:whA'], 'expected': 4,
             'note': '18|50 / 25|40 / 30|28 / 32|0 —— M3 写的是同一个成员，所以还是 4'},
            {'name': '被乱序重放写回去的那条，分数仍然是首次的 30',
             'input': ['ZSCORE stock:hist:SKU9:whA 30|28'], 'expected': '30',
             'note': '这条断的是"重复写入没把它推到别的位置"，也就是顺序信息还在'},
            {'name': '另一个仓各自独立：whB 当前是 31|7',
             'input': ['ZREVRANGE stock:hist:SKU9:whB 0 0'], 'expected': ['31|7']},
            {'name': '边界：归零之后历史仍在（不许 DEL，举证期没到）',
             'input': ['EXISTS stock:hist:SKU9:whA'], 'expected': 1,
             'note': '"一店一处罚"要求逐单可复原；30 天滚动日志在取证时等于没有'},
            {'name': '同步通道不许改商家配的仓库优先级',
             'input': ['HGET stock:prio:SKU9 whA'], 'expected': '1',
             'note': '优先级与库存是两条独立写路径；合并成一个 key 就会越权'},
            {'name': '退化：那条"最后写入赢"的影子表必须根本没被建出来',
             'input': ['EXISTS stock:proj:SKU9'], 'expected': 0,
             'note': 'HSET 上去就永久留痕，而读路径一旦有两份真相就再也对不清'},
        ],
        runner={'setup': setup, 'entry': 'function', 'timeoutMs': 10000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=22,
        answer=answer,
    )


# =================================================================== B1 报表分层与晚到回补
@draft('bd-pdd-report-layer-diff')
def q_report_layer_diff():
    """小时表 → 分天表重算 + 差异分类。金额一律用**分**（整数），
    浮点求和的尾差会让"晚到"与"真差异"分不开 —— 这本身就是考点之一。"""
    SCHEMA = ('row_id int, layer string, bill_date string, ad_plan_id string, '
              'charge_fen bigint, click_cnt int, ingest_batch int, caliber_version string')
    VIEW = 'report_rows'

    def classify(rows):
        hourly = {}
        daily = {}
        for r in rows:
            key = (r['bill_date'], r['ad_plan_id'])
            if r['layer'] == 'hourly':
                e = hourly.setdefault(key, {'charge': 0, 'late': 0, 'calibers': set()})
                e['charge'] += r['charge_fen']
                e['calibers'].add(r['caliber_version'])
                if r['ingest_batch'] > 1:
                    e['late'] += r['charge_fen']
            else:
                daily[key] = r
        out = []
        for key in sorted(set(hourly) | set(daily)):
            h, d = hourly.get(key), daily.get(key)
            rec = h['charge'] if h else None
            dc = d['charge_fen'] if d else None
            diff = (rec - dc) if (h and d) else None
            if d is None:
                kind = 'lost'                     # 有小时数据却没有分天结果 ⇒ 这一层丢数
            elif h is None:
                kind = 'hourly-missing'           # 有分天结果却拼不出小时 ⇒ 反向缺口
            elif max(h['calibers']) != d['caliber_version']:
                kind = 'caliber-change'
            elif diff == 0:
                kind = 'match'
            elif diff == h['late']:
                kind = 'late-arrival'             # 差额恰好等于回补批次带来的量
            else:
                kind = 'unexplained'
            out.append({'bill_date': key[0], 'ad_plan_id': key[1], 'daily_charge_fen': dc,
                        'recomputed_charge_fen': rec, 'diff_charge_fen': diff, 'diff_type': kind})
        return out

    def case(name, rows, note=None):
        payload = {'name': name,
                   'input': {'view': VIEW, 'schema': SCHEMA, 'rows': [dict(r) for r in rows]},
                   'expected': classify(rows)}
        if note:
            payload['note'] = note
        return payload

    def h(row_id, day, plan, charge, batch=1, caliber='v1'):
        return {'row_id': row_id, 'layer': 'hourly', 'bill_date': day, 'ad_plan_id': plan,
                'charge_fen': charge, 'click_cnt': 1, 'ingest_batch': batch,
                'caliber_version': caliber}

    def d(row_id, day, plan, charge, caliber='v1'):
        return {'row_id': row_id, 'layer': 'daily', 'bill_date': day, 'ad_plan_id': plan,
                'charge_fen': charge, 'click_cnt': 1, 'ingest_batch': 1,
                'caliber_version': caliber}

    statement = """## 输入

PySpark 3.5（判题容器内）。已注册一张表 `report_rows`：

```
report_rows(
  row_id INT, layer STRING,          -- 'hourly' | 'daily'
  bill_date STRING,                  -- 'yyyy-MM-dd'
  ad_plan_id STRING,
  charge_fen BIGINT,                 -- 消耗金额，单位**分**（整数）
  click_cnt INT,
  ingest_batch INT,                  -- 1 = 首次入库；>1 = 回补批次写进来的晚到数据
  caliber_version STRING)            -- 口径版本，如 'v1' / 'v2'
```

## 背景

官方广告接口存在**分层报表**：`pdd.ad.api.report.hourly.report.query`、
`report.daily.report.query`、`report.entity.report.query`（分级）。
小时与分天同时存在，就意味着必须先回答一句话：**谁是一次真相。**
本题的立场是：**小时层是一次真相，分天层是投影**；
`daily` 行是"用 `ingest_batch = 1` 那批小时数据算出来的快照"，晚到的数据只会让重算值变大。

## 任务

按 `(bill_date, ad_plan_id)` 输出一行差异分类，列固定为：

```
bill_date, ad_plan_id, daily_charge_fen, recomputed_charge_fen, diff_charge_fen, diff_type
```

- `recomputed_charge_fen` = 该 key 下**所有** `layer = 'hourly'` 行的 `charge_fen` 之和；
- `daily_charge_fen` = 该 key 的 `daily` 行的 `charge_fen`；
- `diff_charge_fen` = `recomputed − daily`（任一侧缺失时为 `null`）；
- 按 `bill_date` 升序、再按 `ad_plan_id` 升序。

## `diff_type` 判定（**优先级从上到下，命中即止**）

| 顺序 | 条件 | `diff_type` | 含义 |
| --- | --- | --- | --- |
| 1 | 有小时数据、**没有** daily 行 | `lost` | 聚合层丢数（最严重：报表整块少一块） |
| 2 | 有 daily 行、**没有**任何小时数据 | `hourly-missing` | 明细层缺口，反向不可重算 |
| 3 | daily 的 `caliber_version` **不等于**该 key 小时行的**最大** `caliber_version` | `caliber-change` | 口径变更未同步到聚合层 |
| 4 | `diff = 0` | `match` | 对得上 |
| 5 | `diff` 恰好等于该 key 上 `ingest_batch > 1` 的行之和 | `late-arrival` | 差额被晚到回补完全解释 |
| 6 | 其余 | `unexplained` | 真差异：要人去看的那一条 |

三条口径纪律：

- **口径变更优先于金额比较**：口径不同的两个数相减没有意义，
  报成 `late-arrival` 或 `unexplained` 都是把治理问题伪装成算术问题。
- **`late-arrival` 要求"恰好等于"**：只看"差额为正就算晚到"的实现会把
  `unexplained` 全部吞掉 —— 而差额为正但**不等于**回补量，恰恰说明还有一笔没被解释。
- 缺失侧的金额输出 `null`，**不许填 0**（0 是"这一天消耗为零"，null 是"这一层没有这一行"）。

## 约束

不许 `collect()` 到驱动侧；金额全程整数（分），不许出现浮点比较。

## 这题真正考的东西

素材里那句"广告小时数据和分天数据对不上，你的立场是什么"的标准答案是：
**先说谁是一次真相，再说晚到回补窗口，最后说不回溯的口径变更协议。**
这题把这三句话变成六个分类，写完你就知道自己在哪一句上没有实现。"""

    reference = """import pyspark.sql.functions as F


def solve(spark):
    r = spark.table('report_rows')

    hourly = (r.filter(F.col('layer') == 'hourly')
              .groupBy('bill_date', 'ad_plan_id')
              .agg(F.sum('charge_fen').cast('long').alias('recomputed_charge_fen'),
                   F.max('caliber_version').alias('hourly_caliber'),
                   F.sum(F.when(F.col('ingest_batch') > 1, F.col('charge_fen'))
                         .otherwise(F.lit(0))).cast('long').alias('late_charge_fen')))

    daily = (r.filter(F.col('layer') == 'daily')
             .select('bill_date', 'ad_plan_id',
                     F.col('charge_fen').cast('long').alias('daily_charge_fen'),
                     F.col('caliber_version').alias('daily_caliber')))

    j = hourly.join(daily, ['bill_date', 'ad_plan_id'], 'fullouter')

    diff = (F.when(F.col('recomputed_charge_fen').isNotNull()
                   & F.col('daily_charge_fen').isNotNull(),
                   F.col('recomputed_charge_fen') - F.col('daily_charge_fen')))
    return (j.select('bill_date', 'ad_plan_id', 'daily_charge_fen', 'recomputed_charge_fen',
                     diff.alias('diff_charge_fen'),
                     F.when(F.col('daily_charge_fen').isNull(), F.lit('lost'))
                      .when(F.col('recomputed_charge_fen').isNull(), F.lit('hourly-missing'))
                      .when(F.col('daily_caliber') != F.col('hourly_caliber'),
                            F.lit('caliber-change'))
                      .when(diff == 0, F.lit('match'))
                      .when(diff == F.col('late_charge_fen'), F.lit('late-arrival'))
                      .otherwise(F.lit('unexplained')).alias('diff_type'))
            .orderBy('bill_date', 'ad_plan_id'))"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    # "对不上就是晚到"版：不声明一次真相层、不看口径版本、把缺失侧兜成 0。
    # 症状是分类列里永远只有 match 和 late-arrival，真正的丢数与口径变更被吞干净。
    r = spark.table('report_rows')
    hourly = (r.filter(F.col('layer') == 'hourly')
              .groupBy('bill_date', 'ad_plan_id')
              .agg(F.sum('charge_fen').alias('recomputed_charge_fen')))
    daily = (r.filter(F.col('layer') == 'daily')
             .select('bill_date', 'ad_plan_id',
                     F.col('charge_fen').alias('daily_charge_fen')))
    j = hourly.join(daily, ['bill_date', 'ad_plan_id'], 'left')
    return (j.select('bill_date', 'ad_plan_id',
                     F.coalesce('daily_charge_fen', F.lit(0)).alias('daily_charge_fen'),
                     F.col('recomputed_charge_fen'),
                     (F.col('recomputed_charge_fen') - F.coalesce('daily_charge_fen', F.lit(0)))
                     .alias('diff_charge_fen'),
                     F.when(F.col('recomputed_charge_fen')
                            == F.coalesce('daily_charge_fen', F.lit(0)), F.lit('match'))
                     .otherwise(F.lit('late-arrival')).alias('diff_type'))
            .orderBy('bill_date', 'ad_plan_id'))"""

    answer = """## 参考答案要点

两条聚合 + 一次 **full outer join** + 一条按优先级写死的 `when` 链。
`fullouter` 不是可选项：丢数（有小时无分天）与反向缺口（有分天无小时）
只有在双向连接下才同时看得见 —— 用 `left` 连接的实现会**永远报不出 `lost`**，
而 `lost` 是唯一"报表整块少一块"的那一类。

**基线那组数据六个分类各命中一次**（具体分类以模型输出为准，这也是 expected 交给代码算的原因）。
其中最值得盯的是两对：
`late-arrival` 与 `unexplained` 都满足"重算值 > 分天值"，
差别只在**差额是否恰好等于回补批次之和**。差额为正但不等于回补量，
说明回补之外还有一笔没被解释 —— 用"差额为正就算晚到"的实现会把这一类全部吞掉，
而它正是"每天少一点、谁也说不清少在哪"的那种事故。

**口径变更必须排在金额比较之前**（第 3 优先）。
`v2` 的小时数据对 `v1` 的分天结果，相减得到的是一个**没有意义的数**：
它同时混合了"晚到"和"口径改了"两个原因。把它报成金额差异，
下游会去做一件完全错误的事（追数据），而正确答案是去改聚合层的版本声明。
这也对应素材里那句"**不回溯的口径变更必须公告 + 冻结可比区间**"。

**缺失侧输出 `null` 而不是 0**：`0` 的业务含义是"这一天消耗为零"，
`null` 才是"这一层根本没有这一行"。把 `lost` 的金额兜成 0 之后，
`diff_charge_fen` 会等于整天的重算值，看起来像"一笔巨大的晚到"，
于是这条真事故被伪装成一个回补事故。

**为什么全程整数**：`SUM(DOUBLE)` 的尾差会让 `diff == 0` 在"本该相等"的行上成立不了，
于是 `match` 行大面积变成 `unexplained`。
一旦被迫用 `abs(diff) < 0.005` 这种容差，就再也分不清"0.4 分的尾差"与"4 分的真差异"，
而分单位下 4 分是**真钱**。素材里金额字段本来就是 `DECIMAL(12,2)`，
落到 Spark 里就用整数分或 Decimal，不要用 double。

**工程延伸（面试追问点）**

1. 一次真相为什么选小时层而不是分天层？（小时层粒度更细、可以直接追溯到点击日志，
   且晚到数据总是先落到小时层。反选分天层的系统，重算历史时要靠上一层的上一层，
   链路长度决定了修复窗口。）
2. `caliber_version` 谁负责写？（**生成方**写，不是消费方猜。
   所以 DWD/聚合层每输出一行都要带上"我用的是哪一版口径"，
   这题把它做成列就是这个意思。）
3. 回补窗口要多长？（由计费争议期决定，不是由"我们一般回补 3 天"决定：
   退款回冲、跨天归因、券归属都可能把消耗推到很多天之后。
   窗口之外必须**冻结**，而冻结要公告 —— 否则同比环比在窗口边界上突然全部错位。）
4. 这六个分类怎么变成告警？（只有 `lost` 与 `unexplained` 阻断发布；
   `late-arrival` 是常态、进看板；`caliber-change` 应该**在变更公告后自动消失**，
   如果它长期存在说明有一层没跟着改口径 —— 那是最贵的静默。
   `hourly-missing` 单独一条：它意味着明细被清理得太早，要改保留期。）"""

    return base(
        'big-data', 'principal',
        '小时表是分天表的一次真相？先把对不上的原因分成六类，再谈重算',
        statement, 'pyspark',
        ['report-layering', 'late-arrival', 'caliber-change', 'integrity-classification',
         'modern:metric-governance'],
        src('数据研发（报表与口径分层方向） 高级工程师',
            DATA + '#4 考点 8（`pdd.ad.api.report.hourly/daily/entity` 三层报表官方接口 + '
            '素材建议 judgeKind=pyspark「小时表 → 分天表重算 + 差异分类（晚到/回补/口径变更/丢数）」）'
            '＋ §2 追问 7；素材给了分类维度，未给优先级与判据'),
        language='python',
        cases=[
            case('基线：六类差异各命中一次',
                 [h(1, '2026-05-01', 'p1', 1000), h(2, '2026-05-01', 'p1', 500),
                  d(3, '2026-05-01', 'p1', 1500),
                  h(4, '2026-05-01', 'p2', 800), h(5, '2026-05-01', 'p2', 200, batch=2),
                  d(6, '2026-05-01', 'p2', 800),
                  h(7, '2026-05-01', 'p3', 700), d(8, '2026-05-01', 'p3', 500),
                  h(9, '2026-05-02', 'p4', 300),
                  h(10, '2026-05-02', 'p5', 400, caliber='v2'), d(11, '2026-05-02', 'p5', 400),
                  d(12, '2026-05-02', 'p6', 900)],
                 note='p1 match / p2 late-arrival / p3 unexplained / p4 lost / '
                      'p5 caliber-change / p6 hourly-missing'),
            case('晚到但差额大于回补量：必须落进 unexplained，不许被"正差额"吞掉',
                 [h(1, '2026-05-03', 'p7', 1000), h(2, '2026-05-03', 'p7', 300, batch=3),
                  d(3, '2026-05-03', 'p7', 900)],
                 note='回补只解释得了 300 分，而差额是 400 分 ⇒ 还有一笔没被解释 ⇒ unexplained'),
            case('边界：口径相同的两侧都为零 ⇒ match 而不是 caliber-change',
                 [h(1, '2026-05-04', 'p8', 0, caliber='v2'), d(2, '2026-05-04', 'p8', 0,
                                                              caliber='v2')]),
            case('退化：没有任何报表行 ⇒ 零行输出', []),
            case('多个回补批次叠加：late 是它们的和，不是最大那条',
                 [h(1, '2026-05-05', 'p9', 600), h(2, '2026-05-05', 'p9', 100, batch=2),
                  h(3, '2026-05-05', 'p9', 150, batch=3), d(4, '2026-05-05', 'p9', 600)]),
        ],
        runner={'entry': 'function', 'orderSensitive': False, 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=34,
        answer=answer,
    )


# =================================================================== B2 地址缺失率的可见性失真
@draft('bd-pdd-address-missing-metric')
def q_address_missing_metric():
    """官方语义：收件人字段仅在"待发货且未被风控打标"时返回密文，其余返回空串。
    于是"缺失率"这个指标里混着"不该给"。把它拆成两列才是正解。"""
    SCHEMA = ('order_sn int, biz_date string, order_status int, risk_control_status int, '
              'receiver_address string')
    VIEW = 'ods_order_receiver'

    def compute(rows):
        groups = {}
        for r in rows:
            groups.setdefault(r['biz_date'], []).append(r)
        out = []
        for day in sorted(groups):
            mine = groups[day]
            total = len(mine)
            raw = 0
            masked = 0
            true_missing = 0
            for r in mine:
                empty = r['receiver_address'] is None or r['receiver_address'] == ''
                hidden = (r['order_status'] != 1) or (r['risk_control_status'] == 1)
                if empty:
                    raw += 1
                if empty and hidden:
                    masked += 1
                if empty and not hidden:
                    true_missing += 1
            raw_bp = bp(raw, total)
            true_bp = bp(true_missing, total)
            out.append({'biz_date': day, 'total_orders': total, 'raw_missing_cnt': raw,
                        'policy_hidden_cnt': masked, 'true_missing_cnt': true_missing,
                        'raw_missing_bp': raw_bp, 'true_missing_bp': true_bp,
                        'distorted': 1 if raw_bp - true_bp > 1000 else 0})
        return out

    def case(name, rows, note=None):
        payload = {'name': name,
                   'input': {'view': VIEW, 'schema': SCHEMA, 'rows': [dict(r) for r in rows]},
                   'expected': compute(rows)}
        if note:
            payload['note'] = note
        return payload

    def o(sn, day, status, risk, addr):
        return {'order_sn': sn, 'biz_date': day, 'order_status': status,
                'risk_control_status': risk, 'receiver_address': addr}

    statement = """## 输入

PySpark 3.5（判题容器内）。已注册一张表 `ods_order_receiver`：

```
ods_order_receiver(
  order_sn INT, biz_date STRING,        -- 'yyyy-MM-dd'
  order_status INT,                     -- 1 待发货 / 2 已发货待签收 / 3 已签收
  risk_control_status INT,              -- 0 正常 / 1 审核中
  receiver_address STRING)              -- 密文、空串 ''、或 NULL
```

## 背景

官方字段注释原文：`receiver_address`「订单状态为待发货状态，**且订单未被风控打标的情况下
返回密文数据；其余情况返回空字符串**」。
也就是说一个字段有**三态**：密文 / 空串 / 根本没这一列，
而"空串"通常是**权限或风控结果**，不是数据缺失。

事故场景（素材原题）：某天开始"地址缺失率"从 2% 涨到 40%，同时"待发货超时率"略微下降。
业务方怀疑采集坏了。这题就是让这条指标**自己说清楚**它是被谁污染的。

## 任务

按 `biz_date` 输出一行，列固定为：

```
biz_date, total_orders, raw_missing_cnt, policy_hidden_cnt, true_missing_cnt,
raw_missing_bp, true_missing_bp, distorted
```

## 口径（这张表就是判分点）

1. **"取不到值" `empty`** 的判据：`receiver_address IS NULL OR receiver_address = ''`
   —— 空串与 NULL 都必须算"取不到"（这一层是 ODS，两种写法都真实存在）。
2. **"本就不该给" `hidden`** 的判据：`NOT (order_status = 1 AND risk_control_status = 0)`，
   即**状态不是待发货**或**被风控打标**。
3. `raw_missing_cnt` = `empty` 的行数（朴素口径：今天大家看到的那条"缺失率"）。
4. `policy_hidden_cnt` = `empty AND hidden` 的行数（**不该给所以没有**，是合规正常态）。
5. `true_missing_cnt` = `empty AND NOT hidden` 的行数（**该给却没给**，这才是数据质量事故）。
6. `raw_missing_bp` = `ROUND(raw_missing_cnt × 10000 / total_orders)`，
   `true_missing_bp` 同理。用**万分比**（不是百分数），中间不要出现浮点比较。
7. `distorted` = 1 当且仅当 `raw_missing_bp − true_missing_bp > 1000`
   （即"缺失率里有超过 10 个百分点是被可见性策略撑起来的"）。
   **严格大于**：正好 10 个百分点不算失真。

按 `biz_date` 升序。

## 约束

不许 `collect()` 到驱动侧；比率一律用整数万分比表达，不要用 double。

## 这题真正考的东西

- **`hidden` 与 `empty` 是两个维度**：一行可以"该给但没给"（事故）、
  "不该给所以没有"（正常）、"不该给但值还在"（另一类合规问题，本题不判）。
  只用一列 `IS NULL` 的指标，在风控收紧的那一周必然"看起来像采集故障"。
- **失真量本身要成为指标**：`distorted` 是"这条指标今天能不能信"的元信息。
  看板不带它，就会出现"整条曲线被业务动作推动、团队去查 ETL 查三天"。"""

    reference = """import pyspark.sql.functions as F


def solve(spark):
    w = (spark.table('ods_order_receiver')
         .withColumn('is_empty',
                     F.col('receiver_address').isNull()
                     | (F.col('receiver_address') == F.lit('')))
         .withColumn('is_hidden',
                     ~(F.col('order_status') == 1) | (F.col('risk_control_status') == 1)))

    g = (w.groupBy('biz_date')
         .agg(F.count(F.lit(1)).cast('int').alias('total_orders'),
              F.sum(F.col('is_empty').cast('int')).cast('int').alias('raw_missing_cnt'),
              F.sum((F.col('is_empty') & F.col('is_hidden')).cast('int')).cast('int')
                .alias('policy_hidden_cnt'),
              F.sum((F.col('is_empty') & ~F.col('is_hidden')).cast('int')).cast('int')
                .alias('true_missing_cnt')))

    return (g.select('biz_date', 'total_orders', 'raw_missing_cnt', 'policy_hidden_cnt',
                     'true_missing_cnt',
                     F.round(F.col('raw_missing_cnt') * 10000 / F.col('total_orders'))
                       .cast('int').alias('raw_missing_bp'),
                     F.round(F.col('true_missing_cnt') * 10000 / F.col('total_orders'))
                       .cast('int').alias('true_missing_bp'),
                     F.when((F.round(F.col('raw_missing_cnt') * 10000 / F.col('total_orders'))
                             - F.round(F.col('true_missing_cnt') * 10000 / F.col('total_orders')))
                            > 1000, 1).otherwise(0).cast('int').alias('distorted'))
            .orderBy('biz_date'))"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    # "空值就是缺失"版：没有可见性维度，policy_hidden 恒 0，
    # 于是风控收紧的当天这条指标直接翻十倍，而它测的东西根本不是数据质量。
    g = (spark.table('ods_order_receiver')
         .groupBy('biz_date')
         .agg(F.count(F.lit(1)).cast('int').alias('total_orders'),
              F.sum(F.when(F.col('receiver_address').isNull(), 1).otherwise(0)).cast('int')
                .alias('raw_missing_cnt')))
    return (g.select('biz_date', 'total_orders', 'raw_missing_cnt',
                     F.lit(0).cast('int').alias('policy_hidden_cnt'),
                     F.col('raw_missing_cnt').alias('true_missing_cnt'),
                     F.round(F.col('raw_missing_cnt') * 10000 / F.col('total_orders'))
                       .cast('int').alias('raw_missing_bp'),
                     F.round(F.col('raw_missing_cnt') * 10000 / F.col('total_orders'))
                       .cast('int').alias('true_missing_bp'),
                     F.lit(0).cast('int').alias('distorted'))
            .orderBy('biz_date'))"""

    answer = """## 参考答案要点

一行布尔（`is_empty`）、一行布尔（`is_hidden`），然后四个条件求和共用同一次扫描。
关键结构是**先建可见性判定，再算缺失**：`policy_hidden_cnt` 与 `true_missing_cnt`
是 `raw_missing_cnt` 的一个**划分**，所以恒等式
`raw = policy_hidden + true_missing` 必须在每一行上成立 —— 这句话本身就是最好的自检。

**为什么 `empty` 要把 NULL 和空串都算进来**：官方语义里"其余情况返回空字符串"，
所以绝大多数缺失行其实是 `''`；而 ODS 层还可能整列没给（NULL）。
只写 `IS NULL` 的实现（就是朴素解）在这张表上会得到一个**永远偏低**的缺失率，
风控当天涨到 40% 它也纹丝不动 —— 因为它连"取不到值"都没测到。

**`hidden` 的布尔写法**：`NOT (status = 1 AND risk = 0)` 等价于
`status != 1 OR risk == 1`。写成后一种更短，但要小心 NULL：
本题 `order_status` / `risk_control_status` 都是非空列，所以两种写法同解；
真实 ODS 里这两列**可以**为空，那时 `!=` 会把 NULL 行判成"不 hidden"，
于是"该给却没给"被虚增。这就是这类布尔表达式在数仓里最经典的三值逻辑坑。

**`distorted` 的阈值方向**（严格大于 1000 万分点）：
正好 10 个百分点是"合规策略的正常投影"，不该报警。
把 `>` 写成 `>=` 之后，风控比例一稳定在 10%，这条指标就永久亮红 ——
**告警失效通常不是漏报，是滥报**：一周后没人再看它，真正的采集故障就在里面。

**看板怎么用它**：把 `raw_missing_bp` 与 `true_missing_bp` 画在同一张图上。
两条线重合 ⇒ 缺失就是缺失；两条线分开且 `distorted = 1` ⇒
**这条指标的波动来自可见性策略，不是数据质量**，该去问风控为什么收紧，
而不是去查 ETL。用例里风控占比升高的那一天就是专门演示这一对的。

**工程延伸（面试追问点）**

1. 为什么在 DWD 就拆，而不是在报表层？（报表层的口径无法约束上游：
   任何新消费者都会重新"猜"一次。放到 DWD 之后，
   `receiver_value` + `visibility_reason` 两列是全公司唯一入口。）
2. 三种结论分别是什么？（① 风控打标比例升高 ⇒ `policy_hidden` 涨、`true_missing` 不动；
   ② 订单状态分布变化（大促后集中发货）⇒ 同上但 reason 是状态；
   ③ 上游真的没传 ⇒ `true_missing` 涨。区分三者只需要这两列，不需要查日志。）
3. `visibility_reason` 值不值得建枚举？（值得，而且必须版本化：
   将来新增"跨境分区不下发"之类的 reason 时，
   未知值要显式落到 `unmapped` 桶并告警，不能被 `ELSE` 吞掉 ——
   否则"缺失率"又一次悄悄换了定义。）
4. 万分比而不是百分数？（万分比与广告那边的分流桶同构，
   且 `> 1000` 这种阈值在整数域上比较不需要容差 ——
   指标层少一处浮点比较，就少一处"昨天等今天不等"的排查。）"""

    return base(
        'big-data', 'senior',
        '地址缺失率涨到 40%：把"不该给"与"该给却没给"拆成两列，再让指标自己报失真',
        statement, 'pyspark',
        ['field-visibility', 'metric-distortion', 'null-vs-empty', 'three-valued-logic',
         'modern:privacy-engineering'],
        src('数据研发（埋点与指标治理方向） 高级工程师',
            DATA + '#1 核心机制 8 与 §5 题面草稿 C（"地址缺失率从 2% 涨到 40%"的原题场景、'
            'receiver_* 三态官方注释、"在 DWD 就拆成 value + visibility_reason 两列"）'),
        language='python',
        cases=[
            case('基线：6 单里 4 单取不到值，其中 2 单本就不该给',
                 [o(1, '2026-05-01', 1, 0, 'enc:A'), o(2, '2026-05-01', 1, 0, ''),
                  o(3, '2026-05-01', 1, 1, ''), o(4, '2026-05-01', 2, 0, ''),
                  o(5, '2026-05-01', 1, 0, None), o(6, '2026-05-01', 3, 0, 'enc:C')],
                 note='raw 4 条 = 不该给 2 条 + 真缺失 2 条；恒等式 raw = hidden + true 必须成立'),
            case('风控收紧那天：raw 拉到 80% 而 true_missing 是 0（distorted 必须亮）',
                 [o(i, '2026-05-02', 1, 1, '') for i in range(1, 9)]
                 + [o(9, '2026-05-02', 1, 0, 'enc:A'), o(10, '2026-05-02', 1, 0, 'enc:B')],
                 note='80% 的"缺失"全部来自审核中打标 ⇒ 该去问风控而不是查 ETL'),
            case('边界：失真正好 10 个百分点不算失真（严格大于才亮）',
                 [o(i, '2026-05-03', 2, 0, '') for i in (1, 2)]
                 + [o(i, '2026-05-03', 1, 0, 'enc:X') for i in range(3, 21)],
                 note='20 行里 2 行是"不该给"、0 行真缺失 ⇒ 两个比率之差正好 1000 万分点，'
                      '写成 >= 的实现这里会翻成 1 —— 之后风控比例一稳在 10% 就永久滥报'),
            case('真缺失事故：raw 与 true 同时拉满而差为零（此刻这条指标是可信的）',
                 [o(1, '2026-05-04', 1, 0, None), o(2, '2026-05-04', 1, 0, ''),
                  o(3, '2026-05-04', 1, 0, None)],
                 note='三行全都"该给却没给" ⇒ raw_bp = true_bp = 10000、distorted 0；'
                      '这种形态才是要立刻查管道的那种'),
            case('退化：全部有值 ⇒ 两个比率都是 0 且 distorted 为 0',
                 [o(1, '2026-05-05', 1, 0, 'enc:A'), o(2, '2026-05-05', 2, 1, 'enc:B')]),
        ],
        runner={'entry': 'function', 'orderSensitive': False, 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== B3 GMV / 结算 / 收入三层
@draft('bd-pdd-gmv-three-layer')
def q_gmv_three_layers():
    """成交—结算—收入是三层不同的钱；素材里"GMV 涨 20%、交易服务收入只涨 12%"
    的定位路径，落到数据上就是这四列各自的分母与逐行取整。"""
    SCHEMA = ('order_sn int, merchant_account_id int, pay_amount int, post_amount int, '
              'service_fee int, refund_amount int, take_rate_bp int, '
              'confirm_status int, group_status int')
    VIEW = 'dwd_order_settle'

    def compute(rows):
        groups = {}
        for r in rows:
            groups.setdefault(r['merchant_account_id'], []).append(r)
        out = []
        for acct in sorted(groups):
            mine = groups[acct]
            deal = sum(r['pay_amount'] for r in mine)
            goods = sum(r['pay_amount'] - r['post_amount'] - r['service_fee'] for r in mine)
            settled = [r for r in mine if r['confirm_status'] == 1 and r['group_status'] == 1]
            settle = sum(r['pay_amount'] - r['service_fee'] - r['refund_amount']
                         for r in settled)
            revenue = sum((r['pay_amount'] - r['post_amount'] - r['service_fee'])
                          * r['take_rate_bp'] // 10000 for r in settled)
            gap_bp = 0 if deal == 0 else bp(deal - settle, deal)
            out.append({'merchant_account_id': acct, 'order_rows': len(mine),
                        'settled_rows': len(settled), 'deal_fen': deal, 'goods_fen': goods,
                        'settle_fen': settle, 'revenue_fen': revenue, 'unsettled_gap_bp': gap_bp})
        return out

    def case(name, rows, note=None):
        payload = {'name': name,
                   'input': {'view': VIEW, 'schema': SCHEMA, 'rows': [dict(r) for r in rows]},
                   'expected': compute(rows)}
        if note:
            payload['note'] = note
        return payload

    def o(sn, acct, pay, post, fee, refund, rate, confirm, group):
        return {'order_sn': sn, 'merchant_account_id': acct, 'pay_amount': pay,
                'post_amount': post, 'service_fee': fee, 'refund_amount': refund,
                'take_rate_bp': rate, 'confirm_status': confirm, 'group_status': group}

    statement = """## 输入

PySpark 3.5（判题容器内）。已注册一张 DWD 宽表 `dwd_order_settle`（金额一律**分**，整数）：

```
dwd_order_settle(
  order_sn INT, merchant_account_id INT,
  pay_amount INT,        -- 官方口径：含邮费与服务费
  post_amount INT,       -- 邮费
  service_fee INT,       -- 服务费（平台收入的一部分，不给商家结算）
  refund_amount INT,     -- 已发生的退款（0 表示没退）
  take_rate_bp INT,      -- 该类目佣金率，万分比
  confirm_status INT,    -- 0 未成交 / 1 已成交 / 2 已取消
  group_status INT)      -- 0 拼团中 / 1 已成团 / 2 团失败
```

## 背景

素材里那道必答题："GMV 涨 20%，交易服务收入只涨 12%，给我三种解释路径。"
三条路径（take rate 结构变化 / 出资结构 / 退款滞后回冲）分别对应下面四列里的**不同分母**。
所以这题不是算术，是**把三层钱各自的分母写对**。

官方口径锚点：`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`；
交易服务收入是"for sales of the products **completed** on our platforms"，
而平台"**does not control the products ... at any point in time**"。

## 任务

按 `merchant_account_id` 升序输出一行，列固定为：

```
merchant_account_id, order_rows, settled_rows, deal_fen, goods_fen, settle_fen,
revenue_fen, unsettled_gap_bp
```

## 四层口径（这张表就是判分点）

1. `order_rows` = 该商家的行数（**所有**订单，含未成交、团失败、已取消）。
2. **成交层** `deal_fen` = `SUM(pay_amount)`，**不加任何过滤**
   （支付口径就是"买家付了多少"，它含邮费与服务费 —— 这正是它不能当 GMV 商品口径的原因）。
3. **商品层** `goods_fen` = `SUM(pay_amount − post_amount − service_fee)`，同样**不加过滤**。
   把邮费与服务费剥出来才是可比的商品价体量。
4. **应结算集合**：`confirm_status = 1 AND group_status = 1`
   （"钱付了但团没成"**不在**这个集合里）。`settled_rows` 是它的行数。
5. **结算层** `settle_fen` = 应结算集合上 `SUM(pay_amount − service_fee − refund_amount)`。
6. **收入层** `revenue_fen` = 应结算集合上 **逐行**
   `FLOOR((pay_amount − post_amount − service_fee) × take_rate_bp / 10000)` 之和。
   **必须逐行取整再求和**：佣金是按单结算的，先把分子分母各自求和再乘率
   会得到另一个数（而且只会偏大或偏小，没人知道差在哪一单）。
7. `unsettled_gap_bp` = `ROUND((deal_fen − settle_fen) × 10000 / deal_fen)`，
   `deal_fen = 0` 时输出 `0`（这一列是"付了但没结给商家的比例"，没有分母就是 0）。

## 约束

不许 `collect()` 到驱动侧；不许用浮点做金额运算；分组的 shuffle 键必须是商家账号。

## 这题真正考的东西

- **四层各有各的过滤条件**：成交层与商品层**不**过滤状态，结算层与收入层**才**过滤。
  把过滤条件下推到全部四列，`deal_fen` 就变成"可结算口径"，
  于是"GMV 涨、收入不涨"这件事在报表上**消失**了 —— 你把要解释的现象自己解释掉了。
- **`group_status` 参与结算判定**：这是"成团才算成交"落到资金侧的样子。
- **逐行取整 vs 聚合后取整**是真实系统里最常见的"对不上三分钱"来源。"""

    reference = """import pyspark.sql.functions as F


def solve(spark):
    # 四层共用一次 groupBy：过滤条件只写在结算层与收入层的聚合表达式里，
    # 成交层与商品层**不**加过滤 —— 这是"分层口径不漂移"的唯一结构。
    r = (spark.table('dwd_order_settle')
         .withColumn('settled',
                     (F.col('confirm_status') == 1) & (F.col('group_status') == 1))
         .withColumn('goods',
                     F.col('pay_amount') - F.col('post_amount') - F.col('service_fee'))
         .withColumn('settle_row',
                     F.col('pay_amount') - F.col('service_fee') - F.col('refund_amount'))
         # 佣金按单入账：逐行乘率再截断。cast('long') 对正数就是 floor。
         .withColumn('fee_row',
                     (F.col('goods') * F.col('take_rate_bp') / F.lit(10000)).cast('long')))

    agg = r.groupBy('merchant_account_id').agg(
        F.count(F.lit(1)).cast('int').alias('order_rows'),
        F.sum(F.col('pay_amount')).cast('long').alias('deal_fen'),
        F.sum('goods').cast('long').alias('goods_fen'),
        F.sum(F.col('settled').cast('int')).cast('int').alias('settled_rows'),
        F.sum(F.when(F.col('settled'), F.col('settle_row'))).cast('long').alias('settle_fen'),
        F.sum(F.when(F.col('settled'), F.col('fee_row'))).cast('long').alias('revenue_fen'))

    return (agg.select('merchant_account_id', 'order_rows', 'settled_rows', 'deal_fen',
                       'goods_fen',
                       F.coalesce('settle_fen', F.lit(0)).cast('long').alias('settle_fen'),
                       F.coalesce('revenue_fen', F.lit(0)).cast('long').alias('revenue_fen'),
                       F.when(F.col('deal_fen') == 0, F.lit(0))
                        .otherwise(F.round((F.col('deal_fen')
                                            - F.coalesce(F.col('settle_fen'), F.lit(0)))
                                           * 10000 / F.col('deal_fen')))
                        .cast('int').alias('unsettled_gap_bp'))
             .orderBy('merchant_account_id'))"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    # "四层共用一个 WHERE"版：所有指标都只算可结算行，
    # 于是"GMV 涨了收入没涨"这件事在报表上根本不存在 —— 问题被口径吃掉了。
    r = (spark.table('dwd_order_settle')
         .filter((F.col('confirm_status') == 1) & (F.col('group_status') == 1)))
    agg = r.groupBy('merchant_account_id').agg(
        F.count(F.lit(1)).cast('int').alias('order_rows'),
        F.sum('pay_amount').cast('long').alias('deal_fen'),
        F.sum(F.col('pay_amount') - F.col('post_amount') - F.col('service_fee'))
          .cast('long').alias('goods_fen'),
        F.sum(F.col('pay_amount') - F.col('service_fee') - F.col('refund_amount'))
          .cast('long').alias('settle_fen'))
    return (agg.select('merchant_account_id', 'order_rows',
                       F.col('order_rows').alias('settled_rows'),
                       'deal_fen', 'goods_fen', 'settle_fen',
                       (F.col('goods_fen') * 1000 / F.lit(10000)).cast('long')
                       .alias('revenue_fen'),
                       F.lit(0).cast('int').alias('unsettled_gap_bp'))
             .orderBy('merchant_account_id'))"""

    answer = """## 参考答案要点

一次 `groupBy(merchant_account_id)`，七列全部在**同一个** `agg` 里算完，
靠 `F.when(应结算条件, …)` 给结算层与收入层加过滤，成交层与商品层不加。
这样四层看的是同一批行，差异只来自各自的过滤条件 —— 这是"分层口径"唯一不会漂移的写法。

**（参考解里有个坑值得单独讲）**：`F.when(cond, x)` 在 `cond` 为假时返回 **NULL**，
而 `SUM` 会跳过 NULL —— 所以"不加过滤的列"和"加了 when 的列"混在同一个 `agg` 里是对的，
但**计数**列如果也用 `when` 就必须 `.otherwise(0)`，否则空集会得到 NULL 而不是 0。
`cast('long')` 也不能省：整数除法在 Spark 里返回 `bigint`，
而 `F.sum` 的结果类型随表达式推导，不显式收口就会在 schema 比对上翻车。

**逐行取整为什么必须**（第 6 条口径）：
用例「逐行取整 vs 聚合后取整」就是为这一条造的：三单，每单商品价 1 分、费率 9999 万分点。
逐行 `1 × 9999 ÷ 10000` 截断 ⇒ 每单 0 分，合计 **0 分**；
先加再乘 ⇒ `3 × 9999 ÷ 10000 = 2.9997` 截断成 **2 分**。
同一个商家的收入，两种实现差出一倍。差额无规律（取决于每一单的尾数），
所以对账时永远查不出来，只会积累成"佣金总额总比财务口径少几分钱"。
**根因是佣金按单入账**：商家账单是按单可解释的，任何"先聚合再乘率"的结果都拆不回单。

**`deal_fen` 不加过滤是这题最贵的一条**（朴素解把过滤条件下推到全部四列，会**把整题打掉**）：
成交层的意义是"买家掏了多少钱"，它必须包含"付了但团失败"、"付了但被取消"这些行。
把这些过滤掉，`unsettled_gap_bp` 就恒等于 0，
于是"GMV 涨 20% 而收入涨 12%"这个真实存在的现象**在你的报表上做出来是平的** ——
指标治理最坏的失败不是算错，是**把要解释的现象用口径吃掉了**。

**`unsettled_gap_bp` 的分母是 `deal_fen` 而不是 `settle_fen`**：
它回答的是"付出去的钱里有几成还没结给商家"。
用 `settle_fen` 当分母在 `settle = 0` 时会炸（除零），
而且语义变成"结算额里有多少被吞了"，那是另一个问题（而且是财务问题，不是产品问题）。

**工程延伸（面试追问点）**

1. 为什么 `goods_fen` 也要"不加过滤"？（要和成交层**逐行对齐**才能算"邮费+服务费占比"；
   两张不同过滤集合的表相减得到的比例无法解释。）
2. 国补与支付立减在这四列里怎么落？（它们进 `discount_amount`，不进 `pay_amount` 的加项；
   出资方不是平台也不是商家的那部分**不能**算进平台让利 ——
   参见同方向那道 `pay_amount` 口径题，两边必须能互相对上。）
3. 退款时间跨账期怎么办？（`refund_amount` 是"已发生的退款"快照 ⇒ 这条宽表必须带
   `as_of_date`，否则重跑同一天会得到不同的 `settle_fen`。
   素材里"可变对价要预估并事后冲正"说的就是这件事：要留**预估时点快照**，
   不然历史永远无法复算。）
4. `take_rate_bp` 为什么在行上而不在类目维表上？（这是 DWD 宽表，费率是**成交时点**的费率。
   调率之后再 join 维表会把历史订单的佣金改掉 —— 那正是审计追溯断裂的形态。
   维表只用于解释，不用于重算。）"""

    return base(
        'big-data', 'senior',
        '成交—商品—结算—收入四层钱：过滤条件各不相同，佣金必须逐行取整',
        statement, 'pyspark',
        ['layered-metrics', 'take-rate', 'per-row-rounding', 'metric-denominator',
         'modern:finance-consistency'],
        src('数据研发（交易与收入口径方向） 高级工程师',
            DATA + '#4 考点 3/14 与 §5 题面草稿 A 第 2 问（成交/结算/收入多列口径、'
            '`pay_amount` 官方公式含邮费与服务费、"GMV 涨而交易服务收入不涨"的三条解释路径、'
            'FY2025 收入结构 50.4% / 49.6%）'),
        language='python',
        cases=[
            case('基线：两商家四层钱各不相同，501 有一单付了没结',
                 [o(1, 501, 10000, 600, 300, 0, 1000, 1, 1),
                  o(2, 501, 5000, 0, 200, 1000, 1000, 1, 2),
                  o(3, 502, 20000, 1000, 500, 0, 250, 1, 1),
                  o(4, 502, 8000, 0, 0, 8000, 250, 1, 1)],
                 note='501 的 settled_rows 是 1 而 order_rows 是 2 —— 那 1 单是"付了但团失败"'),
            case('逐行取整 vs 聚合后取整：小金额高费率时必须分岔',
                 [o(1, 503, 1, 0, 0, 0, 9999, 1, 1), o(2, 503, 1, 0, 0, 0, 9999, 1, 1),
                  o(3, 503, 1, 0, 0, 0, 9999, 1, 1)]),
            case('边界：一单都没结 ⇒ settle 与 revenue 都是 0 而 gap 是 10000',
                 [o(1, 504, 30000, 1000, 500, 0, 500, 0, 0),
                  o(2, 504, 12000, 0, 0, 0, 500, 1, 2)]),
            case('退化：只有一单且零退款 ⇒ gap 只剩服务费那一段',
                 [o(1, 505, 9900, 900, 900, 0, 100, 1, 1)]),
            case('全额退款的一单：settle_fen 被扣成负数，不许夹到 0',
                 [o(1, 506, 5000, 0, 250, 5000, 400, 1, 1), o(2, 506, 7000, 500, 300, 0, 400, 1, 1)],
                 note='第一单退款额等于实付 ⇒ 结算额 −250 分（商家欠平台服务费）；'
                      '兜成 0 就等于凭空多结 250 分，那是资损'),
        ],
        runner={'entry': 'function', 'orderSensitive': False, 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=32,
        answer=answer,
    )


# =================================================================== F1 收件人字段的视图模型
@draft('fe-pdd-receiver-view-model')
def q_receiver_view_model():
    """前端拿到的是"空串"，而它必须渲染成三种不同的界面状态。
    判分事实来源是生成的测试文件，所以断言（含错误消息）全部从同一个模型生成。"""
    import json as _json

    BUCKETS = {'ok': 'visible', 'risk-hold': 'policy-hidden',
               'not-awaiting-shipment': 'policy-hidden', 'not-ciphered': 'integrity-broken',
               'no-column': 'pipeline-missing'}
    TEXTS = {'ok': ('可查看', 'ok'), 'risk-hold': ('审核中 · 暂不可查看', 'warn'),
             'not-awaiting-shipment': ('已发货 · 不再提供', 'muted'),
             'not-ciphered': ('未加密 · 禁止展示', 'warn'),
             'no-column': ('数据缺失', 'warn')}

    def receiver_view(row):
        if row is None:
            raise ModelError('row must be an object')
        status = row.get('status')
        risk = row.get('risk')
        stored = row.get('stored')
        if status not in (1, 2, 3, 5):
            raise ModelError('unknown order status')
        if status == 5:
            raise ModelError('filter value 5 is not a real status')
        if risk not in (0, 1):
            raise ModelError('unknown risk control status')
        if stored not in ('cipher', 'plain', 'absent'):
            raise ModelError('unknown stored form')
        if stored == 'absent':
            reason = 'no-column'
        elif status != 1:
            reason = 'not-awaiting-shipment'
        elif risk == 1:
            reason = 'risk-hold'
        elif stored == 'plain':
            reason = 'not-ciphered'
        else:
            reason = 'ok'
        text, tone = TEXTS[reason]
        return {'reason': reason, 'text': text, 'tone': tone,
                'canDecrypt': reason == 'ok',
                'metricBucket': BUCKETS[reason],
                'ariaLabel': '收件人信息：' + text,
                'countsAsMissingForQuality': reason == 'no-column'}

    SPECS = [
        ('基线：待发货 + 未打标 + 密文 ⇒ 唯一可解密的形态',
         {'status': 1, 'risk': 0, 'stored': 'cipher'}, None),
        ('风控审核中必须渲染成"暂不可查看"，不能渲染成"数据缺失"',
         {'status': 1, 'risk': 1, 'stored': 'cipher'}, None),
        ('已发货：状态本身就不该再展示收件人信息',
         {'status': 2, 'risk': 0, 'stored': 'cipher'}, None),
        ('整列没返回：这一种才允许进"数据缺失"的分子',
         {'status': 1, 'risk': 0, 'stored': 'absent'}, None),
        ('库里是明文：禁止展示，且归到完整性问题而不是缺失',
         {'status': 1, 'risk': 0, 'stored': 'plain'}, None),
        ('退化：已签收 + 审核中 + 缺列三件事同时成立时，缺列优先（管道故障最该被看见）',
         {'status': 3, 'risk': 1, 'stored': 'absent'}, None),
        ('边界：已发货优先于审核中（状态是更强的拒绝理由）',
         {'status': 3, 'risk': 1, 'stored': 'cipher'}, None),
        ('非法：整行是 null', None, 'row must be an object'),
        ('非法：未知订单状态', {'status': 9, 'risk': 0, 'stored': 'cipher'},
         'unknown order status'),
        ('非法：筛选值 5 落进了数据', {'status': 5, 'risk': 0, 'stored': 'cipher'},
         'filter value 5 is not a real status'),
        ('非法：未知风控标记', {'status': 1, 'risk': 2, 'stored': 'cipher'},
         'unknown risk control status'),
        ('非法：未知存储形态', {'status': 1, 'risk': 0, 'stored': 'hashed'},
         'unknown stored form'),
    ]

    cases = []
    for name, row, err in SPECS:
        if err:
            cases.append({'name': name, 'input': [row], 'expected': None,
                          'expectThrow': 'Error', 'throwMessage': err})
        else:
            cases.append({'name': name, 'input': [row], 'expected': receiver_view(row)})

    tl = ["import { describe, expect, it } from 'vitest';",
          "import { receiverView } from './Solution';",
          '',
          '/**',
          ' * 断言由 gen.py 里同一个 receiver_view() 模型生成，不手抄 ——',
          ' * react-vitest 题的判分事实来源就是这份测试文件，抄错一次就永久错一次。',
          ' * 契约型用例断言到**消息**：只写 .toThrow() 会让几条"都该抛错"的用例收敛成同一条。',
          ' */',
          "describe('receiverView：收件人字段三态语义的视图模型', () => {"]

    def js(v):
        return _json.dumps(v, ensure_ascii=False)

    for c in cases:
        arg = js(c['input'][0])
        tl.append("  it(%s, () => {" % js(c['name']))
        if c.get('expectThrow'):
            tl.append("    expect(() => receiverView(%s as never)).toThrow(%s);"
                      % (arg, js(c['throwMessage'])))
        else:
            tl.append("    expect(receiverView(%s)).toEqual(%s);" % (arg, js(c['expected'])))
        tl.append('  });')
    tl.append('});')
    test_file = '\n'.join(tl)

    statement = """## 背景

订单详情里有一块"收件人信息"。接口层的事实是：
`receiver_address` 只有在**订单待发货且未被风控打标**时才返回密文，**其余情况返回空字符串**。
所以前端拿到的"空"至少有四个原因：审核中、已发货、整列没返回、库里根本没加密。

**把它们渲染成同一句"数据缺失"，是这条链上最贵的前端 bug**：
它会驱动一条假的"地址缺失率"指标，让数据团队去查一条没坏的管道，
而真实原因是风控收紧。前端是唯一有"原因"这个信息的地方 —— 接口已经把状态与风控都给了它。

## 你要实现的入口

```ts
export interface ReceiverInput {
  status: 1 | 2 | 3;        // 1 待发货 / 2 已发货待签收 / 3 已签收
  risk: 0 | 1;              // 0 正常 / 1 审核中
  stored: 'cipher' | 'plain' | 'absent';   // 库里存的是密文 / 明文 / 这一列没返回
}

export interface ReceiverView {
  reason: 'ok' | 'risk-hold' | 'not-awaiting-shipment' | 'not-ciphered' | 'no-column';
  text: string;             // 见下表，必须一字不差
  tone: 'ok' | 'muted' | 'warn';
  canDecrypt: boolean;      // 是否显示"点击查看"按钮
  metricBucket: 'visible' | 'policy-hidden' | 'pipeline-missing' | 'integrity-broken';
  ariaLabel: string;        // '收件人信息：' + text
  countsAsMissingForQuality: boolean;   // 只允许一种 reason 记为真缺失
}

export function receiverView(row: ReceiverInput): ReceiverView
```

## reason 判定（优先级从上到下，与接口层那道题**必须一致**）

1. `stored === 'absent'` ⇒ `no-column`
2. `status !== 1` ⇒ `not-awaiting-shipment`
3. `risk === 1` ⇒ `risk-hold`
4. `stored === 'plain'` ⇒ `not-ciphered`
5. 其余 ⇒ `ok`

## 每个 reason 的输出（这张表就是判分点）

| `reason` | `text` | `tone` | `canDecrypt` | `metricBucket` | `countsAsMissingForQuality` |
| --- | --- | --- | --- | --- | --- |
| `ok` | `可查看` | `ok` | `true` | `visible` | `false` |
| `risk-hold` | `审核中 · 暂不可查看` | `warn` | `false` | `policy-hidden` | `false` |
| `not-awaiting-shipment` | `已发货 · 不再提供` | `muted` | `false` | `policy-hidden` | `false` |
| `not-ciphered` | `未加密 · 禁止展示` | `warn` | `false` | `integrity-broken` | `false` |
| `no-column` | `数据缺失` | `warn` | `false` | `pipeline-missing` | `true` |

`ariaLabel` 恒为 `'收件人信息：' + text`（屏幕阅读器必须能读出"为什么看不见"，
而不是只读出一句"数据缺失"）。

## 抛错（`throw new Error(...)`，消息文本必须一致）

- `row` 是 `null` / `undefined` ⇒ `row must be an object`
- `status` 不是 1/2/3/5 ⇒ `unknown order status`
- `status === 5` ⇒ `filter value 5 is not a real status`（那是查询用的**筛选值**，不该出现在数据里）
- `risk` 不是 0/1 ⇒ `unknown risk control status`
- `stored` 不在三种形态里 ⇒ `unknown stored form`

校验顺序就按上面列出的先后。

不许引入第三方依赖（无 styled-components、无 intl）。"""

    reference = """export interface ReceiverInput {
  status: number;
  risk: number;
  stored: string;
}

export interface ReceiverView {
  reason: string;
  text: string;
  tone: string;
  canDecrypt: boolean;
  metricBucket: string;
  ariaLabel: string;
  countsAsMissingForQuality: boolean;
}

const REASON_TEXT: Record<string, [string, string]> = {
  ok: ['可查看', 'ok'],
  'risk-hold': ['审核中 · 暂不可查看', 'warn'],
  'not-awaiting-shipment': ['已发货 · 不再提供', 'muted'],
  'not-ciphered': ['未加密 · 禁止展示', 'warn'],
  'no-column': ['数据缺失', 'warn'],
};

const REASON_BUCKET: Record<string, string> = {
  ok: 'visible',
  'risk-hold': 'policy-hidden',
  'not-awaiting-shipment': 'policy-hidden',
  'not-ciphered': 'integrity-broken',
  'no-column': 'pipeline-missing',
};

export function receiverView(row: ReceiverInput): ReceiverView {
  if (row === null || row === undefined) throw new Error('row must be an object');
  const { status, risk, stored } = row;
  if (status !== 1 && status !== 2 && status !== 3 && status !== 5) {
    throw new Error('unknown order status');
  }
  if (status === 5) throw new Error('filter value 5 is not a real status');
  if (risk !== 0 && risk !== 1) throw new Error('unknown risk control status');
  if (stored !== 'cipher' && stored !== 'plain' && stored !== 'absent') {
    throw new Error('unknown stored form');
  }

  // 优先级：管道没给 > 状态不该给 > 风控压着 > 值没加密 > 正常
  let reason: string;
  if (stored === 'absent') reason = 'no-column';
  else if (status !== 1) reason = 'not-awaiting-shipment';
  else if (risk === 1) reason = 'risk-hold';
  else if (stored === 'plain') reason = 'not-ciphered';
  else reason = 'ok';

  const [text, tone] = REASON_TEXT[reason];
  return {
    reason,
    text,
    tone,
    canDecrypt: reason === 'ok',
    metricBucket: REASON_BUCKET[reason],
    ariaLabel: '收件人信息：' + text,
    countsAsMissingForQuality: reason === 'no-column',
  };
}"""

    naive = """export function receiverView(row: any): any {
  // "空就是没有"版：四个原因压成一句文案，全部计入缺失率。
  // 症状：风控收紧那天，前端"地址缺失"提示翻倍，数据团队据此立项去查一条没坏的管道。
  const missing = !row || !row.stored || row.stored === 'absent';
  const text = missing ? '数据缺失' : '可查看';
  return {
    reason: missing ? 'no-column' : 'ok',
    text,
    tone: missing ? 'warn' : 'ok',
    canDecrypt: !missing,
    metricBucket: missing ? 'pipeline-missing' : 'visible',
    ariaLabel: text,
    countsAsMissingForQuality: missing,
  };
}"""

    answer = """## 参考答案要点

一个优先级链定 `reason`，两张表把 `reason` 映射成文案与指标桶。
**关键结构是"先判原因，再由原因查文案"**，而不是在每个分支里各写一遍字符串 ——
后者会让文案、tone、metricBucket 三处各自漂移，而它们是同一条业务规则的三个投影。

**基线五种输入各打一条分支**，其中最值钱的两条：
`status=3, risk=1, stored='absent'` ⇒ `no-column`（优先级 1 压过 2 和 3：
管道故障比业务原因更该被先看见，否则"缺列"会被风控解释掉而没人去修）；
`status=3, risk=1, stored='cipher'` ⇒ `not-awaiting-shipment`
（**状态优先于风控**：已经发货的单，风控解不解除都不该再给地址。
把 2、3 两条顺序换一下，这条就会翻成 `risk-hold`，
于是"审核中"的计数虚高、发货后的合规隐藏被记成风控问题）。

**`countsAsMissingForQuality` 只允许 `no-column` 为 true**：
这一列是"前端把哪些情况算进数据质量分子"的显式契约。
朴素解把它写成 `missing`（覆盖所有拿不到值的情况），
于是风控与状态两种"合规正常态"一起进了缺失率 —— 这正是素材里
"缺失率从 2% 涨到 40%"那条事故的源头。
**指标层那道题（pyspark）与这道题共用同一个判据**，两边必须能对上。

**`metricBucket` 为什么比 `reason` 多一层抽象**：
`risk-hold` 与 `not-awaiting-shipment` 是两个不同的 reason，
但它们是同一个指标桶（`policy-hidden`）。看板按桶聚合、按 reason 下钻。
如果只有 reason，聚合规则会被写进 BI 层的 CASE 表达式里 ——
那正是"同一个口径在两处实现、迟早漂移"的起点。

**为什么 `not-ciphered` 既不算可见也不算缺失**：
库里躺着明文本身是合规事故（PIPL 下的个人敏感信息），
但它**不是**"数据不可用"。把它塞进 `pipeline-missing` 会掩盖真正的问题：
需要被修的是加密链路，不是补数据。所以它单独一个桶 `integrity-broken`。

**`ariaLabel` 要带原因**（`'收件人信息：' + text`）：
只读"数据缺失"对屏幕阅读器用户等于什么都没读出来。
可访问性与可观测性在这里是同一件事 —— **界面必须说得出"为什么没有"**。

**工程延伸（面试追问点）**

1. 为什么前端不做解密？（解密是**字段级权限 + 审计动作**：谁、何时、为哪个订单解了密
   必须留痕，所以解密要打一请求，而不是把密钥发到浏览器。
   `canDecrypt` 控制的是按钮，不是能力。）
2. 这套 reason 值不值得写进共享包？（必须。接口层、数仓层、前端三处用的是**同一套枚举**，
   任何一处私自加值都会被另外两处静默吞掉。真实工程是
   `@arena/receiver-visibility` 之类的共享模块 + 一份契约测试。）
3. 新增一种 reason 会怎样？（老前端会命中"未知"分支。所以映射表要有
   `default`：**未知 reason 一律按最保守的展示**（不给解密、不计缺失、tone warn），
   并且单独上报一个 `unmapped` 计数 —— 这就是枚举治理的前端版本。）
4. 测试为什么要断整个对象而不是 `text`？（这条链上的缺陷全是"文案对了但 metricBucket 错了"
   这类**语义错位**。`toEqual` 打全对象是这类缺陷唯一的捕获方式。）"""

    return base(
        'frontend', 'senior',
        '收件人信息不能只渲染"数据缺失"：四种空各有文案、指标桶与无障碍标签',
        statement, 'react-vitest',
        ['field-visibility', 'view-model', 'accessibility', 'metric-bucket',
         'modern:privacy-engineering'],
        src('前端工程（交易中台 / 订单详情方向） 高级工程师',
            TXN + '#1 核心机制 4（`receiver_*` 官方三态注释 + `risk_control_status` 打标）'
            '＋ DATA 考点 5「把值与可见性原因拆成两列，下游必须引用可见性列而不是猜」。'
            'note：素材本身未提出前端题，这里落在**已有官方字段语义**上，不引入任何拼多多前端栈断言'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'receiver.test.ts', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== F2 发货承诺状态徽标
@draft('fe-pdd-fulfillment-badge')
def q_fulfillment_badge():
    """48 小时发货承诺 + 缺货三态 + 审核中，三条线合成一个徽标；
    赔付资格与"该不该进发货队列"必须是两个不同的输出。"""

    def badge(row):
        if row is None:
            raise ModelError('row must be an object')
        stock = row.get('stockOutHandleStatus')
        risk = row.get('riskControlStatus')
        confirm = row.get('confirmStatus')
        group = row.get('groupStatus')
        paid = row.get('paidAtSec')
        shipped = row.get('shippedAtSec')
        now = row.get('nowSec')
        for name, value in (('stockOutHandleStatus', stock), ('riskControlStatus', risk),
                            ('confirmStatus', confirm), ('groupStatus', group)):
            allowed = {-1, 0, 1} if name == 'stockOutHandleStatus' else {0, 1, 2}
            if name == 'riskControlStatus':
                allowed = {0, 1}
            if value not in allowed:
                raise ModelError('unknown ' + name)
        if not isinstance(paid, int) or not isinstance(now, int) or paid < 0 or now < 0:
            raise ModelError('timestamps must be non-negative integers')
        if shipped is not None and (not isinstance(shipped, int) or shipped < 0):
            raise ModelError('shippedAtSec must be null or a non-negative integer')

        # 优先级：取消 > 风控 > 缺货 > 团失败 > 时效
        if confirm == 2:
            return {'level': 'muted', 'label': '已取消', 'payoutEligible': False,
                    'inShipQueue': False}
        if risk == 1:
            return {'level': 'blocked', 'label': '审核中 · 不进发货队列',
                    'payoutEligible': False, 'inShipQueue': False}
        if stock == 0:
            return {'level': 'breach', 'label': '缺货待处理 · 触发赔付',
                    'payoutEligible': True, 'inShipQueue': False}
        if stock == 1:
            return {'level': 'watch', 'label': '缺货已处理',
                    'payoutEligible': True, 'inShipQueue': False}
        if group == 2:
            return {'level': 'watch', 'label': '团失败 · 待回补',
                    'payoutEligible': False, 'inShipQueue': False}
        limit = 172800      # 48 小时（题面假设）
        soon = 151200       # 剩余 6 小时就提醒
        elapsed = (shipped - paid) if shipped is not None else (now - paid)
        if elapsed > limit:
            label = '已发货但超 48 小时' if shipped is not None else '未发货已超 48 小时'
            return {'level': 'breach', 'label': label, 'payoutEligible': True,
                    'inShipQueue': shipped is None}
        if shipped is None and elapsed > soon:
            return {'level': 'watch', 'label': '临近 48 小时', 'payoutEligible': False,
                    'inShipQueue': True}
        if shipped is not None:
            return {'level': 'ok', 'label': '已发货', 'payoutEligible': False,
                    'inShipQueue': False}
        return {'level': 'ok', 'label': '待发货', 'payoutEligible': False,
                'inShipQueue': True}

    SPECS = [
        ('基线：付款后 30 小时未发货 ⇒ 待发货，进队列，不赔付',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 0,
          'groupStatus': 0, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 108000}),
        ('缺货待处理：既判违约又不许进发货队列',
         {'stockOutHandleStatus': 0, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 3600}),
        ('审核中优先于缺货：赔付与队列都要关停',
         {'stockOutHandleStatus': 0, 'riskControlStatus': 1, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 3600}),
        ('边界：正好 48 小时不算超时（严格大于才违约）',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 1000, 'shippedAtSec': None, 'nowSec': 173800}),
        ('边界：48 小时后再多一秒 ⇒ 违约，且已经发货的单也要被追认',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': 172801, 'nowSec': 200000}),
        ('团失败：不赔付（钱要退不是要赔），但要进"待回补"视野',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 2, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 3600}),
        ('退化：已取消的单最优先，缺货标记一概不许覆盖它',
         {'stockOutHandleStatus': 0, 'riskControlStatus': 1, 'confirmStatus': 2,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 999999}),
        ('临近超时：42 小时未发货 ⇒ watch，仍在队列里',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 155000}),
        ('非法：未知的缺货处理状态',
         {'stockOutHandleStatus': 7, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': None, 'nowSec': 1},
         'unknown stockOutHandleStatus'),
        ('非法：时间戳为负',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': -5, 'shippedAtSec': None, 'nowSec': 1},
         'timestamps must be non-negative integers'),
        ('非法：发货时间类型不对（既不是 null 也不是非负整数）',
         {'stockOutHandleStatus': -1, 'riskControlStatus': 0, 'confirmStatus': 1,
          'groupStatus': 1, 'paidAtSec': 0, 'shippedAtSec': '123', 'nowSec': 1},
         'shippedAtSec must be null or a non-negative integer'),
        ('非法：整行是 null', None, 'row must be an object'),
    ]

    cases = []
    for spec in SPECS:
        name, row = spec[0], spec[1]
        err = spec[2] if len(spec) > 2 else None
        if err:
            cases.append({'name': name, 'input': [row], 'expected': None,
                          'expectThrow': 'Error', 'throwMessage': err})
        else:
            cases.append({'name': name, 'input': [row], 'expected': badge(row)})

    import json as _json

    def js(v):
        return _json.dumps(v, ensure_ascii=False)

    tl = ["import { describe, expect, it } from 'vitest';",
          "import { fulfillmentBadge } from './Solution';",
          '',
          '/**',
          ' * 断言由 gen.py 里同一个 badge() 模型生成，不手抄。',
          ' * 契约型用例断言到消息：四条"都该抛错"的用例否则会被收敛成同一条代码路径。',
          ' */',
          "describe('fulfillmentBadge：48 小时承诺 × 缺货三态 × 风控打标', () => {"]
    for c in cases:
        arg = js(c['input'][0])
        tl.append("  it(%s, () => {" % js(c['name']))
        if c.get('expectThrow'):
            tl.append("    expect(() => fulfillmentBadge(%s as never)).toThrow(%s);"
                      % (arg, js(c['throwMessage'])))
        else:
            tl.append("    expect(fulfillmentBadge(%s)).toEqual(%s);" % (arg, js(c['expected'])))
        tl.append('  });')
    tl.append('});')
    test_file = '\n'.join(tl)

    statement = """## 背景

拼多多官网对消费者的承诺列表里有四条：**全场包邮、7 天退换、假一赔十、48 小时发货**，
配合"发货超时赔付"，说明**超卖/缺货在这套体系里是一条有状态机的正式流程**，不是客服个案。
订单上同时挂着**三条独立的状态线**：

```
stock_out_handle_status : -1 无缺货处理 / 0 缺货待处理 / 1 缺货已处理
risk_control_status     :  0 正常订单 / 1 审核中订单
confirm_status          :  0 未成交 / 1 已成交 / 2 已取消
group_status            :  0 拼团中 / 1 已成团 / 2 团失败
```

列表页要为每行订单渲染**一个**徽标。难点不在画图，在"三条线互相冲突时听谁的"。

## 你要实现的入口

```ts
export interface OrderRow {
  stockOutHandleStatus: -1 | 0 | 1;
  riskControlStatus: 0 | 1;
  confirmStatus: 0 | 1 | 2;
  groupStatus: 0 | 1 | 2;
  paidAtSec: number;             // 支付时刻（epoch 秒）
  shippedAtSec: number | null;   // null = 还没发货
  nowSec: number;
}

export function fulfillmentBadge(row: OrderRow): {
  level: 'ok' | 'watch' | 'breach' | 'blocked' | 'muted';
  label: string;
  payoutEligible: boolean;
  inShipQueue: boolean;
}
```

## 判定优先级（从上到下，命中即止）

| 顺序 | 条件 | `level` | `label` | `payoutEligible` | `inShipQueue` |
| --- | --- | --- | --- | --- | --- |
| 1 | `confirmStatus === 2` | `muted` | `已取消` | `false` | `false` |
| 2 | `riskControlStatus === 1` | `blocked` | `审核中 · 不进发货队列` | `false` | `false` |
| 3 | `stockOutHandleStatus === 0` | `breach` | `缺货待处理 · 触发赔付` | `true` | `false` |
| 4 | `stockOutHandleStatus === 1` | `watch` | `缺货已处理` | `true` | `false` |
| 5 | `groupStatus === 2` | `watch` | `团失败 · 待回补` | `false` | `false` |
| 6 | 超时（见下） | `breach` | `未发货已超 48 小时` 或 `已发货但超 48 小时` | `true` | `shippedAtSec === null` |
| 7 | 未发货且 `elapsed > 42 小时` | `watch` | `临近 48 小时` | `false` | `true` |
| 8 | 已发货（未超时） | `ok` | `已发货` | `false` | `false` |
| 9 | 其余（未发货、未超时） | `ok` | `待发货` | `false` | `true` |

`elapsed` = 已发货时用 `shippedAtSec − paidAtSec`，未发货时用 `nowSec − paidAtSec`。
48 小时 = `172800` 秒，42 小时 = `151200` 秒。**两个阈值都是严格大于**：
正好 48 小时不算超时（那是"最后一秒发货也合规"）。

第 6 行的 `label` 有两种：已发货用 `已发货但超 48 小时`，未发货用 `未发货已超 48 小时`。

## 抛错（`throw new Error(...)`，消息文本必须一致）

- `row` 是 `null` / `undefined` ⇒ `row must be an object`
- 任一状态列取值不在其枚举内 ⇒ `unknown <字段名>`（字段名按接口里的驼峰名，
  如 `unknown stockOutHandleStatus`）
- `paidAtSec` / `nowSec` 不是非负整数 ⇒ `timestamps must be non-negative integers`
- `shippedAtSec` 既不是 `null` 也不是非负整数 ⇒ `shippedAtSec must be null or a non-negative integer`

校验顺序：先整行，再四个状态列（按 `stockOutHandleStatus`、`riskControlStatus`、
`confirmStatus`、`groupStatus` 的顺序），再 `paidAtSec`/`nowSec`，最后 `shippedAtSec`。

不许引入第三方依赖。

## 这题真正考的东西

- **`payoutEligible` 与 `inShipQueue` 必须是两个输出**：
  审核中的单**不能进发货队列**，但素材里"审核中单不应进入赔付计算"同样重要 ——
  两者常常相反，压成一个布尔就必然有一边错。
- **缺货标记优先于时效**：已经登记缺货的单，不必再算"还剩几小时"，
  否则会出现"缺货 + 还有 20 小时"这种自相矛盾的徽标。
- **团失败不产生赔付**：那是"钱要退"而不是"货没发"，混进赔付口径会虚增成本。"""

    reference = """export interface OrderRow {
  stockOutHandleStatus: number;
  riskControlStatus: number;
  confirmStatus: number;
  groupStatus: number;
  paidAtSec: number;
  shippedAtSec: number | null;
  nowSec: number;
}

export interface Badge {
  level: string;
  label: string;
  payoutEligible: boolean;
  inShipQueue: boolean;
}

const LIMIT_SEC = 172800;   // 48 小时（题面假设）
const SOON_SEC = 151200;    // 剩余 6 小时就提醒

function isNonNegInt(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

export function fulfillmentBadge(row: OrderRow): Badge {
  if (row === null || row === undefined) throw new Error('row must be an object');
  const allowed: Record<string, number[]> = {
    stockOutHandleStatus: [-1, 0, 1],
    riskControlStatus: [0, 1],
    confirmStatus: [0, 1, 2],
    groupStatus: [0, 1, 2],
  };
  for (const name of ['stockOutHandleStatus', 'riskControlStatus', 'confirmStatus', 'groupStatus']) {
    const v = (row as any)[name];
    if (!allowed[name].includes(v)) throw new Error('unknown ' + name);
  }
  if (!isNonNegInt(row.paidAtSec) || !isNonNegInt(row.nowSec)) {
    throw new Error('timestamps must be non-negative integers');
  }
  if (row.shippedAtSec !== null && !isNonNegInt(row.shippedAtSec)) {
    throw new Error('shippedAtSec must be null or a non-negative integer');
  }

  const shipped = row.shippedAtSec;
  const elapsed = (shipped === null ? row.nowSec : shipped) - row.paidAtSec;

  if (row.confirmStatus === 2) {
    return { level: 'muted', label: '已取消', payoutEligible: false, inShipQueue: false };
  }
  if (row.riskControlStatus === 1) {
    return { level: 'blocked', label: '审核中 · 不进发货队列',
             payoutEligible: false, inShipQueue: false };
  }
  if (row.stockOutHandleStatus === 0) {
    return { level: 'breach', label: '缺货待处理 · 触发赔付',
             payoutEligible: true, inShipQueue: false };
  }
  if (row.stockOutHandleStatus === 1) {
    return { level: 'watch', label: '缺货已处理', payoutEligible: true, inShipQueue: false };
  }
  if (row.groupStatus === 2) {
    return { level: 'watch', label: '团失败 · 待回补', payoutEligible: false, inShipQueue: false };
  }
  if (elapsed > LIMIT_SEC) {
    return { level: 'breach',
             label: shipped === null ? '未发货已超 48 小时' : '已发货但超 48 小时',
             payoutEligible: true, inShipQueue: shipped === null };
  }
  if (shipped === null && elapsed > SOON_SEC) {
    return { level: 'watch', label: '临近 48 小时', payoutEligible: false, inShipQueue: true };
  }
  if (shipped !== null) {
    return { level: 'ok', label: '已发货', payoutEligible: false, inShipQueue: false };
  }
  return { level: 'ok', label: '待发货', payoutEligible: false, inShipQueue: true };
}"""

    naive = """export function fulfillmentBadge(row: any): any {
  // "只看有没有发货"版：缺货三态与风控打标被忽略，赔付与发货队列被压成同一个布尔。
  // 症状有两处：审核中的单被送去发货（并计入超时赔付），缺货的单却还在队列里转。
  const late = (row.shippedAtSec === null ? row.nowSec : row.shippedAtSec) - row.paidAtSec > 43200;
  const done = row.shippedAtSec !== null;
  return {
    level: late ? 'breach' : 'ok',
    label: done ? '已发货' : '待发货',
    payoutEligible: late,
    inShipQueue: !done && !late,
  };
}"""

    answer = """## 参考答案要点

一条 `if` 链按表里的优先级排下来，加一个"两个输出"的返回结构。
真正的设计决定只有一个：**`payoutEligible`（要不要赔）与 `inShipQueue`（还要不要发）
是两个独立字段**，因为它们在"审核中"这一行上是**反的** ——
不赔（还不能定性），但也不发（风控压着）。压成一个布尔必然有一边错。

**基线八种输入各打一条规则**：
`已取消 + 审核中 + 缺货 + 距付款很久`  ⇒ `已取消`（优先级 1：终局状态最优先，
否则一个已经取消的单还在提示"缺货待处理"，客服会去做一件没意义的事）；
`审核中 + 缺货待处理` ⇒ `blocked`（**赔付也要关停**：素材原话是
"审核中的单不能进发货队列，也不能被自动缺货处理误伤"）；
`缺货待处理 + 正常 + 已成交成团` ⇒ `breach` 且 `inShipQueue: false`。

**两条边界用例是这道题的判分核心**：
`elapsed == 172800`（正好 48 小时）⇒ **不是违约**，落进 `watch / 临近 48 小时` ——
**严格大于**才算超时，因为"最后一秒发货"仍然合规；
`elapsed == 172801` 且**已经发货** ⇒ `已发货但超 48 小时` + `payoutEligible: true` +
`inShipQueue: false`。
后一条是"追认赔付"：货发出去了不表示超时没发生，消费者承诺是按发货时刻算的。
只测"未发货超时"的用例覆盖不到这条分支，而它恰好是实际赔付最多的一类。

**`elapsed` 的算法在两侧不同**：已发货时用 `shippedAtSec − paidAtSec`（事实），
未发货时用 `nowSec − paidAtSec`（进行中的等待）。
把它统一成 `nowSec − paidAtSec` 的实现会让所有历史订单随着时间推移全部变红 ——
**这是"徽标随刷新变多"的经典成因**，也是"同一个字段名承载两种语义"的代价。

**为什么 `groupStatus === 2`（团失败）不给赔付资格**：
团失败的资金处置是**退款**，不是**赔付**。
把两者混进同一个 `payoutEligible`，赔付成本会被团失败的数量污染 ——
而素材里"成团才算成交"这条业务规则在数据侧最容易被忘的就是这一点。
`inShipQueue: false` 同样重要：没成团的单压根不该被仓配看见。

**工程延伸（面试追问点）**

1. 阈值为什么写成常量而不是配置？（真实系统必须是配置：大促期承诺会变（活动商品 72 小时），
   而且阈值要能**按订单成交时刻**取值 —— 事后改配置会把历史单全部重判。
   所以配置要版本化 + 与订单快照一起存。）
2. 列表页要排序吗？（要按 `(payoutEligible desc, elapsed desc)`，
   但**不能**按 `level` 排：`level` 是展示语义，`breach` 里同时有缺货与超时两种责任人，
   按它排会把两类工单混成一批。）
3. 这个函数该放在前端还是服务端？（**判定放服务端，展示映射放前端**。
   理由与可见性那道题一样：赔付是真金白银，不能由浏览器时间决定；
   而文案与 tone 是 UI 契约，前端持有。朴素解把两条合在一起，
   用户机器时钟偏了就能改变赔付结果。）
4. 怎么防"三条状态线再加一条"时这里失配？（给这份优先级表写**契约测试**：
   枚举笛卡尔积全跑一遍，断言"每个 reason 恰好命中一次"。
   新增状态线时它会红，而不是靠 code review。）"""

    return base(
        'frontend', 'senior',
        '48 小时承诺 × 缺货三态 × 风控打标的徽标：要不要赔与还要不要发是两个字段',
        statement, 'react-vitest',
        ['fulfillment-sla', 'state-machine-merge', 'payout-eligibility', 'threshold-boundary',
         'modern:marketplace-rules'],
        src('前端工程（商家后台 / 履约列表方向） 高级工程师',
            TXN + '#1 核心机制 5（`stock_out_handle_status` 三态 + 官网"48 小时发货"承诺 + '
            '发货超时赔付）与考点 8「审核中的单不能进发货队列，也不能被自动缺货处理误伤」。'
            'note：素材本身未提出前端题，这里落在**已有官方状态枚举**上，不引入前端栈断言'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'badge.test.ts', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=28,
        answer=answer,
    )


def rubric(points, notes=None):
    """points = [(label, weight, criteria), ...]；权重合计必须是 10（schema 强制）。"""
    body = {'maxScore': 10,
            'points': [{'label': l, 'weight': w, 'criteria': c} for l, w, c in points]}
    total = sum(p[1] for p in points)
    if total != 10:
        raise AssertionError(f'rubric 权重合计是 {total}，必须是 10：{[p[0] for p in points]}')
    if len(points) < 3:
        raise AssertionError('rubric 至少 3 个考点（闸门要求）')
    if notes:
        body['notes'] = notes
    return body


# =================================================================== S1 库存投影架构（principal）
@draft('sys-pdd-inventory-projection')
def q_sys_inventory_projection():
    statement = """## 角色与时长

你正在面试**拼多多 服务端研发（交易 / 库存方向）的 Senior（principal 轮）**，45 分钟。
面试官不问概念，只问"字段与状态怎么变"。

## 业务前提（全部是可核查事实，不要质疑出处）

- 平台侧**不持有库存**：2025 年报原文 —— "We do not control the products provided by
  merchants at any point in time during the transactions."商品由第三方商家供货。
- 商家通过开放平台接口自行改库存与价格：`pdd.goods.quantity.update`、
  `pdd.stock.ware.warehouse.query`、`pdd.stock.ware.move`
  （`move_direction`：`1 入库 / 2 出库 / 3 库存同步`；`business_type`：
  `1 采购 / 2 调拨 / 3 退货 / 4 盘点 / 5 发货 / 6 库存同步`；`move_order_sn` 唯一）。
  批量接口有上限：**一次传入 list size 不超过 30 个**。
- 订单有两条正交状态：`group_status`（`0 拼团中 / 1 已成团 / 2 团失败`）与
  `confirm_status`（`0 未成交 / 1 已成交 / 2 已取消`）；另有
  `stock_out_handle_status`（`-1 无 / 0 缺货待处理 / 1 已处理`）与
  `risk_control_status`（`0 正常 / 1 审核中`）。
- 收件人三字段仅在"待发货且未被风控打标"时返回密文，**其余情况返回空字符串**。
- 订单增量拉取被官方限制为：按 `updated_at` 切片、**窗口不超过 30 分钟**、
  **必须倒序分页（从最后一页往回取）才能避免漏单**。
- 对账给外部的是**商家货款日账单文件**（`pdd.finance.balance.daily.bill.url.get`），不是实时接口。
- 平台侧负债量级（2026-03-31）：应付商家款约 RMB 1091.5 亿、商家保证金约 179.1 亿、
  客户预付与递延收入约 35.2 亿。
- 消费者承诺（官网）：**全场包邮、7 天退换、假一赔十、48 小时发货**，并有发货超时赔付。

## 事故现场（这里的数字全部是**出题假设**，请把它们当假设并说明你会怎么验证）

某爆款活动商品（1 个 SKU，商家自有 ERP 管库存）。活动开始后第 12 分钟，
平台侧投影库存比商家实际可售**多 1.8 万件**；已产生 **6200 笔"已支付未成团"**
与 **310 笔"已成团待发货"**；商家在第 15 分钟把库存改成了 **0**；
同分钟起该 SKU 的"审核中"订单占比升到 **11%**。

## 请回答（六问，逐条作答）

1. **投影库存的写入 / 失效模型**：谁写、写什么、幂等键放哪一层、乱序怎么处理，
   并明确"库存同步类调整单"与"出库类调整单"的优先级规则。
2. **这 6200 + 310 笔单的处置决策树**：哪一类可以直接赔、哪一类必须回补、
   哪一类因为"审核中"不能动；每一步对"48 小时发货 / 假一赔十"承诺的成本影响。
3. 为什么"商家把库存改成 0"这件事**不能**当止损终点？你的正确止损动作是什么？
4. **增量通道漏单的检测与补偿**：在不放宽 30 分钟窗口的前提下，你如何**证明**没漏单？
   （不许回答"和商家对一下"。）
5. 缺货赔付与货款结算（日账单）之间的差异如何闭环：谁承担、怎么审计、账期怎么对。
6. 三条你会写进团队规范的**硬卡口**（必须可被 CI 或网关拦截，不许是"加强 review"）。

## 评分时会特别看的东西（答到时请主动说）

- 把"投影 vs 真库存"的误差量化成 SLI（投影准确率、发货前重算拦截率）；
- 识别"收件人字段变空串"会让下游把审核中单误判为无地址，并给出区分方案；
- 用"一店一处罚 / 举证留痕"论证为什么人工改库存必须可回溯到调整单；
- 主动承认"成团时限、窗口长度、QPS 量级是假设"，并说明你如何压测验证。"""

    return base(
        'system-design', 'principal',
        '平台不持货：投影库存被商家改零、6200 单未成团，你的写入模型与止损决策树',
        statement, 'llm-rubric',
        ['inventory-projection', 'oversell-handling', 'incremental-recon', 'settlement-loop',
         'modern:marketplace-risk'],
        src('服务端研发（交易/库存方向） 首席工程师候选', TXN + '#5 题面草稿 B（主推 10 分制长题）'),
        language='markdown',
        rubric=[
            ('投影写入与失效模型', 2,
             '必须说清：占用同步扣投影、商家侧变化立刻改真库存但投影滞后；'
             '幂等键用 move_order_sn；乱序用"版本化绝对值"而不是增量累加；'
             '并给出同步类(move_direction=3)与出库类调整单的优先级。只答"Redis 预扣 + MySQL 兜底"给 0 分'),
            ('处置决策树按状态分桶', 3,
             '必须区分"已支付未成团"与"已成团待发货"两条路径，并明确指出'
             'risk_control_status=1 的单既不进发货队列也不进赔付计算；'
             '答出"回补与重新参团并发会造出假有货"额外加分'),
            ('止损终点判断', 1,
             '要能说清"商家改成 0"只挡未来的单、不解决已开出去的敞口，'
             '正确止损是下架/限流/最后一步确认前重算，并按缺货流程处置已成交单'),
            ('漏单证明能力', 2,
             '必须给出可证明的方案：拉取留痕 + 水位线 + 按成交时间全量集合差集反证，'
             '并把漏单率做成 SLI；解释倒序分页为什么不跳过（队头掉行时"从队尾数的位置"不变）。'
             '回答"和商家对一下"直接给 0 分'),
            ('赔付与结算差异闭环', 1,
             '要提到日账单文件为一次真相、差异分类（账期未到/退款冲销/风控/真差异）、'
             '出资方与责任人、以及止付与审计留痕'),
            ('三条可拦截的硬卡口', 1,
             '卡口必须是机器可判的（网关校验恒等式、CI 阻断未知枚举值、白名单接口调用），'
             '"加强 review / 写文档"不算'),
        ],
        notes='本题所有 QPS / 件数 / 占比 / 时长都是出题假设；候选人把它们当已知事实硬算具体容量不扣分，'
              '但主动声明假设并给出验证方式才算满分。素材里明确写了拼多多官方从未公布任何秒杀/交易量级数字。',
        estimatedMinutes=45,
        answer="""## 参考要点（只喂评分模型）

**1. 投影模型。** 两个变量而不是一个：`real`（商家真库存）与 `proj`（平台投影）。
占用打在 proj 上（同步），商家侧变化打在 real 上（立刻）并经同步通道滞后落到 proj。
事故构造性定义：`proj > real` 就是假有货。幂等键 = `move_order_sn`（官方唯一），
投影要存**版本化绝对值**（score = seq 的历史），因为乱序与重放在"最后写入赢"的
HASH 上会把过时值写成当前值。优先级：同步类（`move_direction=3`）> 出库类，
因为前者是"事实纠正"、后者是"业务动作"。要能主动说：宁可假缺货也不能假有货
（假缺货少卖可度量，假有货收钱发不出货且触发 48 小时赔付）。

**2. 决策树。** 三条线各自处置：
- 已支付未成团（`confirm_status=0/2` 且已收款）：钱在托管里，**不产生发货义务**，
  按未成团退款路径走，不动库存；
- 已成团待发货（`group_status=1 AND confirm_status=1`）：合同已成立，
  要么补货、要么走缺货处置 + 赔付，**不能砍单了事**；
- `risk_control_status=1`：**既不进发货队列也不进赔付计算**，
  因为它的数据可见性也被改变（收件人字段返回空串），动它等于用一份不完整的数据做决策。
加分点：回补与重新参团并发时，如果回补走异步而占用走同步，就会出现
"回补后立刻又被占用"→ 投影 > 真库存，这就是那 1.8 万件的机制解释。

**3. 止损终点。** 商家改成 0 只影响**未来的**占用（而且还要等同步追上），
已开出去的 6510 笔一分没少。正确动作按代价从低到高：
活动页限流/摘入口 → 下单最后一步**重新校验真库存**（挡住新增）→ 已成团的按缺货流程赔付。
"以商家改零为止损点"的实现，其真实含义是"止损依赖对手方配合"。

**4. 漏单证明。** 倒序分页为什么有效是一个不变量：**队头掉行时，每行从队尾数的位置不变**，
而从队头数的位置全体左移 ⇒ 正序按页偏移取数会跨过刚被推进来的行。
但倒序解决不了"行在轮到它之前掉出窗口"，所以必须三通道：
分钟级增量 + 按成交时间全量校对 + `order_sn` 集合差集补拉，
并且**漏单率本身做成 SLI**（全量集合基数 − 已拉取留痕基数 = 缺口）。
水位线只能推到"从队头起连续已读"的位置，不是"本次返回的最大 updated_at"。

**5. 赔付与结算闭环。** 对账以**日账单文件**为一次真相；差异必须分类，
不能只有一个"不一致"：账期未到 / 退款冲销 / 风控审核中 / 金额不符 / 真差异。
只有"真差异"要人去做事。赔付出资方要显式建模（平台 / 商家 / 支付渠道），
因为它同时决定商家账单里的 `platform_discount` 与 `seller_discount` 归属，
以及财务侧记作收入抵减还是市场费用。审计要求来自"一店一处罚"：逐单可复原。

**6. 硬卡口示例。** ① 网关：`pay_amount` 恒等式校验不过的单可以下单，但**不许进结算**；
② CI：任何新增枚举值未在字典登记 ⇒ 阻断发布（未知值必须显式落到 `unmapped` 桶）；
③ 投影偏差方向：`proj - real` 超过阈值 ⇒ 自动摘活动入口（而不是发告警等人）。

**明确的不足信号**：只会说 Redis 预扣 + MQ 削峰；把砍单当默认止血；
处置不区分"已支付未成团"与"已成团"；对账只说"跑个 job 看看"；
对"商家随时能改库存"这个事实无感；把成团时限/QPS 当已知数字硬算。"""
    )


# =================================================================== S2 增量与对账体系
@draft('sys-pdd-increment-recon-architecture')
def q_sys_increment_recon():
    statement = """## 角色

拼多多 服务端研发（开放平台 / 交易同步方向）Senior 设计轮，30 分钟。

## 已知约束（官方接口注释原文，可核查）

- `pdd.order.number.list.increment.get`：按**最后更新时间**切片，
  "开始时间结束时间间距**不超过 30 分钟**"；
  "**注：必须采用倒序的分页方式（从最后一页往回取）才能避免漏单问题**"。
- `order_status` 取值：`1 待发货 / 2 已发货待签收 / 3 已签收 / 5 全部`
  （注意 `5` 是**筛选值**，不是订单的真实状态）。
- 库存调整批量接口："一次传入 list size **不超过 30 个**"。
- 消息服务：`pdd.pmc.accrue.query`（**消息队列积压数量查询**）、
  `pdd.pmc.user.permit / .cancel / .get`（订阅生命周期）。
- 对外资金对账通道是**日账单文件下载**（`pdd.finance.balance.daily.bill.url.get`）。

## 题目

设计一个"平台 ↔ 商家 ERP / ISV"的**订单同步与对账子系统**，要求覆盖：

1. 三条通道（分钟级增量、按成交时间的全量校对、集合差集补拉）各自的职责、频率与失败语义；
2. 水位线的推进规则（含：上游把 `updated_at` 写成**未来时间**时怎么办）；
3. "没有漏单"如何被**证明**并可对外举证（不许依赖"商家自己发现"）；
4. 幂等与乱序：同一张调整单重放、跨窗口乱序、批次大小 30 的分片策略；
5. 可观测性：把"积压"做成一等 SLI（素材里官方就是把积压查询直接给 ISV 的），
   并说明"平台推送成功"与"ISV 处理成功"为什么是两个 SLA；
6. 成本与取舍：全量校对要扫多大范围？窗口能不能放宽？为什么？

## 特别要求

题面里的频率、延迟、量级**全部要你自己假设并标注为假设** ——
拼多多官方从未公布任何同步链路的量级数字。答不出"我怎么验证这个假设"会被降档。"""

    return base(
        'system-design', 'senior',
        '30 分钟窗口 + 倒序分页 + 30 条批量上限：设计一个能被证明没漏单的同步子系统',
        statement, 'llm-rubric',
        ['incremental-sync', 'reconciliation', 'watermark', 'pipeline-lag-sli',
         'modern:data-consistency'],
        src('服务端研发（开放平台 / 交易同步方向） 高级工程师',
            TXN + '#4 考点 4（三条官方约束 + 素材建议 rubric「三通道设计与验证」）'
            '＋ DATA 考点 6/7（积压查询官方接口、微批窗口与水位线）'),
        language='markdown',
        rubric=[
            ('三通道职责与失败语义', 2,
             '增量（分钟级、只保证低延迟）、全量校对（按成交时间、天级、负责反证）、'
             '差集补拉（幂等、有终止条件）。必须说清每条通道挂了会怎样、由谁兜底'),
            ('水位线推进规则', 2,
             '要答到"只能推到从队头起连续已读的位置"，并给出未来时间戳的三件套：'
             '隔离区 + 不参与推进 + 告警。直接丢弃或简单 max(updated_at) 都扣分'),
            ('可证明性', 2,
             '漏单率是一等 SLI；用全量集合基数 − 已拉取留痕基数；'
             '留痕要带窗口边界才能区分漏单与错窗。"和商家对一下"给 0 分'),
            ('幂等与乱序', 2,
             '调整单以 move_order_sn 为键、投影用版本化绝对值、批量 30 的分片要说明'
             '为什么不能"一次传更多"以及失败分片如何重试而不产生重复'),
            ('SLI 设计与 SLA 分层', 1,
             '端到端延迟分位数 + 完整度（应到 vs 实到）+ 乱序率，而不是均值延迟；'
             '并明确"推送成功"与"处理成功"是两个 SLA（静默断流是首要故障模式）'),
            ('成本与边界的取舍', 1,
             '说清窗口为什么不能放宽（放宽会把漏单变成静默）、'
             '全量校对的扫描范围如何用成交时间收敛，并主动标注假设'),
        ],
        notes='如果候选人只讲"用 Flink/CDC 就行"而答不出证明方法，按"可证明性"0 分处理并整体降一档。'
              '本题不许引用任何"拼多多内部栈"作为事实（素材明确说明官方开源为零、无技术博客）。',
        estimatedMinutes=30,
        answer="""## 参考要点

**三通道分工。** 增量通道只负责"快"，不负责"全"——这是最容易被讲反的一点：
把增量当真相，就会在它挂掉时得到一条**看起来正常**的曲线。
全量校对按**成交时间**（不是更新时间）扫描，负责反证；
差集补拉负责收敛，并且必须有**终止条件**（例如只补 7 天），
否则三年前的一条迟到记录会重开一个早已归档的账期。

**水位线。** 推进判据是"从窗口队头起连续已读的最大位置"，不是"本次返回的最大 `updated_at`"——
后者在倒序分页下会把没读到的行永久跳过。
`updated_at` 被写成未来时间时必须**隔离而不是丢弃**：
丢弃等于承认"这单不存在"，而它只是时间戳坏了；
隔离区不参与水位线推进、单独告警、修好时间戳后重放。

**可证明性。** 留痕表要带 `window_start / window_end`，
因为"没人拉过"与"拉了但那次的窗口本不该包含它"是两类问题：
前者改翻页方式，后者修窗口与时钟。只存 `pulled_at` 的留痕回答不了第二类。
最终指标：漏单率 =（全量集合 − 已拉取集合）/ 全量集合，配补拉命中率与到账时延。

**为什么倒序有效。** 队头掉行时，每行"从队尾数的位置"不变、"从队头数的位置"全体左移。
正序用的坐标会漂 ⇒ 跳过；倒序坐标不漂 ⇒ 窗口内不漏读。
但倒序会把风险挪到窗口左边界（行掉出去才轮到它），所以三通道 + 30 分钟窄窗口缺一不可。

**幂等与批量。** `move_order_sn` 天然唯一 ⇒ 作为幂等键；投影存版本化绝对值 ⇒
重放是同一个成员、乱序不覆盖当前值。单批 ≤30 时按"稳定键（如仓 + 调整单号）分桶"而不是
按到达顺序切，否则一个分片失败后重放会与其他分片交叉。

**SLI。** 官方把"消息队列积压数量查询"直接给 ISV，说明积压是一等指标。
真实系统要把它拆成三个：端到端延迟分位数、**完整度**（应到 vs 实到）、乱序率。
"平台推送成功"与"ISV 处理成功"是两个 SLA ——
最常见事故是订阅被 `.cancel` 之后**静默断流**：队列不炸、积压为 0、数据一条没到。

**窗口为什么不能放宽。** 放宽到 60 分钟会减少请求数（成本降），
但调用方的水位线是按它自己看到的边界推进的：
一旦平台侧把窗口悄悄截断，每个周期都会稳定漏掉一段，而两边日志都说自己没错。
窄窗口是**把漏单变成可发现**的前提，不是性能参数。

**假设的验证方式。** 窗口长度、轮询频率、补拉回溯期、批量大小都要给"怎么量"：
用真实 `updated_at` 增量分布算窗口内行数分位数；用留痕与全量差集历史值定回溯期；
压测要按"商家维度二次分桶"倾斜（大商家单窗口可能几十万行），否则测的是平均值而不是长尾。"""
    )


# =================================================================== S3 资金与出资认定
@draft('sys-pdd-fund-subsidy-governance')
def q_sys_fund_subsidy():
    statement = """## 角色

拼多多 服务端研发 / 技术财务交叉方向 Senior，35 分钟。

## 可核查事实

- 2025 年报："We currently rely on commercial banks and third-party payment service
  providers for **payment processing and escrow services**"，并承认业务依赖这些机构的
  billing / payment / escrow 系统来 "**maintain accurate records of payments of sales
  proceeds**"；自列风险包含 "**failure to manage funds accurately or loss of funds**,
  whether due to employee fraud, security breaches, technical errors or otherwise"。
- 负债量级（2026-03-31，官方财报）：应付商家款 ≈ RMB 1091.5 亿、
  商家保证金 ≈ 179.1 亿、客户预付与递延收入 ≈ 35.2 亿。
- 官方收入确认段：平台自费给消费者的 incentives 包括
  "coupons, credits and **other subsidies that may or may not be specific to any merchant**"，
  可用于低价购买 "**or to redeem for cash from us**"；
  入账方式取决于是否存在"替商家履行的明示或默示义务"——
  有 ⇒ 记作 **reductions of revenues**（或代商家承担的负债），无 ⇒ 记作 **marketing expenses**；
  并且"**Variable consideration is estimated** and included in the transaction price
  to the extent that it is probable that a significant revenue reversal will not occur"。
- 官方订单字段：`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`；
  `discount_amount = 平台优惠 + 商家优惠 + 团长免单优惠金额`；
  `promotion_type = 30`（以旧换新）注释明确"**优惠金额已包含平台优惠金额里**"；
  `trade_in_national_subsidy_amount_type`：`1 支付优惠 / 2 商家优惠`；
  另有 `duo_duo_pay_reduction`（多多支付立减，钱由支付渠道出）。
- 外部对账通道是**商家货款日账单文件**（不是实时接口）。

## 题目

请设计"券 / 补贴 / 结算"这条链的工程形态，回答：

1. 为什么"出资方 + 义务性质"必须是**券批次的一等属性**，而不是财务事后调账？
   给出你的字段建模（至少四个属性）与它如何落到 `platform_discount` / `seller_discount`。
2. **可提现红包**与**下单抵扣券**为什么必须分属两套资产账户？混用会开出什么通道？
3. 三个"已包含"陷阱怎么防：`promotion_type=30`、国补 `type=2`、`duo_duo_pay_reduction`。
   给出可机器判的恒等式与它应挂在链路的哪一层。
4. 可变对价要**预估并事后冲正** —— 这对数据平台提出什么要求？
   （提示：只存终值会怎样？）
5. 以日账单为一次真相的结算体系里，差异如何分类、谁承担、止付条件是什么。
6. 你会拒绝做的一件事是什么？说明理由。

题面里的金额量级是官方披露值；任何你没看到的比例、账期天数、容差都必须标注为假设。"""

    return base(
        'system-design', 'senior',
        '同一张券在账务上有三种落点：把出资方与义务性质做成批次的一等属性',
        statement, 'llm-rubric',
        ['subsidy-accounting', 'asset-account-separation', 'settlement-recon',
         'variable-consideration', 'modern:finance-consistency'],
        src('服务端研发（营销与结算方向） / 技术财务交叉 高级工程师',
            TXN + '#4 考点 14 与 DATA 考点 14（20-F 收入确认段原文：reductions of revenues / '
            'marketing expenses / redeem for cash、可变对价预估、escrow 与 loss of funds 自列风险）'),
        language='markdown',
        rubric=[
            ('出资方一等属性建模', 3,
             '必须给出批次维度的属性（出资主体、义务性质、是否可提现、账期/归属期），'
             '并说明它如何决定 platform_discount 与 seller_discount 的归属；'
             '只答"加个字段标记一下"不算'),
            ('两套资产账户', 2,
             '要说清可提现与下单抵扣混用直接开出套现通道（低价买入→核销→提现），'
             '并给出账户层的隔离与限额；答到"资金账户与权益账户分离"更好'),
            ('三处双计的防法', 2,
             'promotion_type=30 已含在平台优惠、国补 type=2 已含在商家优惠、'
             '支付立减由渠道出 ⇒ 各自的可机器判恒等式，并说明为什么校验挂结算而不是挂下单'),
            ('可变对价的可复算性', 1,
             '必须答到"存预估时点快照 + 冲正记录"，否则历史永远无法复算、审计追溯断裂'),
            ('差异分类与止付', 1,
             '账期未到 / 退款冲销 / 风控审核中 / 金额不符 / 真差异；只有真差异要人做事；'
             '止付要有明确触发条件而不是"看起来不对就停"'),
            ('主动拒绝的一件事', 1,
             '例如拒绝把三种落点合成一个"补贴率"对外报，理由要落在口径不可逆地丢失上'),
        ],
        notes='这一题的区分度在于候选人是否承认"同一张券有三个账务落点"。'
              '把补贴当成一个数（补贴率）来设计的，最多拿到 4 分。',
        estimatedMinutes=35,
        answer="""## 参考要点

**1. 为什么必须是一等属性。** 官方收入确认段给的判据是"是否存在**替商家履行**的
明示或默示义务"，这决定了同一张券记作收入抵减、代商家负债、还是市场费用。
事后调账的代价有两个方向：账务已经出了、口径已经对外说了，改不动；
以及商家账单里的 `platform_discount` / `seller_discount` 分不干净 ⇒ 结算争议。
所以批次建模至少四个属性：`funding_party`（平台 / 商家 / 支付渠道 / 品牌方）、
`obligation_nature`（是否替商家）、`redeemable_to_cash`（可否提现）、
`attribution_period`（归属期，决定进哪一期报表）。
`promotion_type=30` 这类"已包含"关系要作为**批次的约束**存下来，而不是靠字段注释。

**2. 两套资产账户。** 可提现的是**现金等价物**，下单抵扣的是**权益**。
混在一套里就出现"用权益买入账 → 转成可提现 → 提现"的通道，
而这类通道的症状是补贴成本持续高于预算、但每一笔核销都合法。
工程上要求：两套账户 + 各自限额 + 提现侧有独立的资金来源约束（只能由平台预算账户注入）。

**3. 三处双计与恒等式。** 可机器判的三条：
`pay_amount = goods_amount − discount_amount + post_amount + service_fee`；
`discount_amount = platform_discount + seller_discount + capital_free_discount`；
`platform_subsidy = platform_discount + Σ(promotion_amount WHERE promotion_type != 30)`。
第三条最关键：它明确把 `type=30` 排除在"再加一次"之外。
**校验挂在结算而不是下单**，因为改价、赔付、分摊回冲都会**临时**破坏恒等式，
写入时强校验会挡正常业务；而结算必须看到"坏了几单、涉及多少钱"。

**4. 可变对价。** 官方明确"预估并计入交易价格，事后冲正"。
数据平台如果只存终值，历史报表在每次冲正后都变了 ⇒ 同一天的数两个版本，
审计问"你上月报的那个数怎么来的"无人能答。
要求：每次预估落一个**带预估时点的快照**，冲正落成一条**可追溯到原预估**的调整记录。
（素材里"prior reporting periods 的调整不重大"这句正是这种机制的产物 —— 能报出来说明有留痕。）

**5. 差异分类与止付。** 只有"真差异"要人去做事；
风控审核中是**延迟理由不是免单理由**（解除之后同一行必须变成真差异，
否则那笔钱永久沉没，这就是 loss of funds 的日常形态）。
止付触发要具体：同一商家真差异金额超阈值、或真差异条数环比突变，
而不是"对账不一致就停"（不一致是常态，会立刻滥停）。

**6. 可以拒绝的事。** 典型好答案：拒绝把三种账务落点合并成一个"补贴率"对外报。
理由：合并不可逆 —— 一旦业务按"补贴率"做决策，
再拆开就需要重建出资认定，而历史数据里的出资方信息如果没有在批次上落成一等属性，
就**永远拆不回来了**。这与"只存终值不存预估快照"是同一类错误。

**不足信号**：把补贴当一个数设计；说"财务事后调账"；
认为对账靠实时接口；把 `platform_discount` 当"平台掏的钱"而不看"已包含"关系；
答不出预估快照。"""
    )


# =================================================================== S4 广告计费一致性
@draft('sys-pdd-ad-billing-consistency')
def q_sys_ad_billing():
    statement = """## 角色

拼多多 服务端研发（广告 / 计费方向）Senior，30 分钟。

## 可核查事实

- 官方广告接口族（`pdd.ad.api.*`）里有：
  `advertiser.open.account`（广告主开户）、`query.account.balance`（**预充值账户余额**）、
  `plan.update.max_cost`（**日消耗上限**）、`plan.update.plan.discount`（**分时折扣**）、
  `unit.tr.update.optimization.bid`（全站推广**成交出价**）、
  `unit.tr.update.target.roi`（**目标投产比**）、
  `unit.creative.distribute.flow.rate`（智能创意流量比例分配）与
  `unit.creative.query.flow.rate`（查询流量分配比例，**单位：万分比**）、
  `report.hourly.report.query` / `report.daily.report.query` / `report.entity.report.query`
  （**分层报表**）。
- 2025 年报的广告收入口径："matching product listings appearing in search or browsing
  results ... charging merchants based on **impressions or clicks**, and display marketing
  ... at **fixed prices**" ⇒ **三种计费方式同时存在**。
- 官方对交易服务收入的确认时点："at a point in time when consumers **view or click on**
  the merchants' product listings **or over the period** during which the advertising
  services are provided, depending on the type" ⇒ **即时确认与服务期分摊两种并存**。

## 题目

1. **预算是硬对象**：日消耗上限 + 分时折扣 + 预充值余额，三者如何共同决定"这次曝光/点击
   能不能计费"？说出你的扣减时序与事务边界，以及"超投"为什么是资损而不是体验问题。
2. **万分比**这个精度单位对分流桶与报表分组意味着什么？为什么它们必须**同构**？
3. 目标 ROI 与成交出价的一致性：给定客单价与目标 ROI，如何推导出可接受的成交出价上界？
   两种口径（广告归因成交 vs 交易真实成交）为什么会不同，差在哪几项？
4. **三种计费（曝光 / 点击 / 固定价）+ 两种收入确认时点**并存时，
   "广告 ARPU / 千次收入"这类指标必须先在定义里声明什么？
5. 小时报表与分天报表对不上，你的立场是什么？（必须回答：谁是一次真相、
   晚到回补窗口多长、不回溯的口径变更怎么公告与冻结可比区间。）
6. 给出三条能落地的对账规则，并说明各自命中时是**谁**的什么动作。

题面任何金额、比例、窗口长度都需要你自己假设并标注。"""

    return base(
        'system-design', 'senior',
        '日消耗上限、万分比分流、三种计费并存：广告链路的钱怎么算得清',
        statement, 'llm-rubric',
        ['ad-billing', 'budget-consistency', 'report-layering', 'attribution-gap',
         'modern:ad-billing'],
        src('服务端研发（广告与计费方向） 高级工程师',
            TXN + '#4 考点 13 ＋ DATA 考点 8/14（官方 ad 接口族、'
            'impressions/clicks/fixed prices 三种计费、view-or-click 即时与按服务期分摊并存的原文）'),
        language='markdown',
        rubric=[
            ('预算与余额的事务边界', 3,
             '必须说清计费扣减是"预占 → 扣减 → 回补"三段且与余额账户同事务；'
             '指出超投是平台垫付 ⇒ 资损，不是体验问题；提到分时折扣只能缩不能放大上限'),
            ('万分比与桶同构', 2,
             '答到"精度单位决定最小分流粒度"，报表分组必须用同一套桶，'
             '否则小时与分天的分母不是同一批人；能说出并列/取整规则更好'),
            ('两种成交口径的差异项', 2,
             '必须逐项列出差异来源：退款回冲、跨天归因、券与补贴归属、抽奖单与拼内购单，'
             '而不是笼统说"有延迟"'),
            ('指标定义要声明确认模式', 1,
             '即时确认与按服务期分摊混在同一收入线里 ⇒ 任何 ARPU 必须先说明属于哪一类'),
            ('报表分层立场', 1,
             '先声明一次真相层，再给晚到回补窗口，再给口径变更的公告与冻结期；顺序错则扣分'),
            ('可落地对账规则', 1,
             '规则要指名责任方与动作（停投 / 追扣 / 人工复核 / 阻断发布），不能只是"核对"'),
        ],
        notes='这题最容易暴露的点是"把广告归因成交当成交易成交"。'
              '拼多多的交易口径里有成团与风控两条线，广告侧一条都没有 —— 说不清这个差别就是没做过。',
        estimatedMinutes=30,
        answer="""## 参考要点

**1. 超投是资损。** 曝光/点击发生即产生对商家的应收，但商家的钱是**预充值**的。
余额不足或触达日消耗上限之后仍然投出去的部分，平台收不回来 ——
这笔是平台自己垫付的，不是"用户体验差一点"。
所以扣减必须三段：`预占（同一事务里把余额扣成在途）→ 计费确认 → 回补未消耗部分`，
并且**预占与上限检查必须在同一个事务边界内**，否则并发请求会各自看到充足余额。
分时折扣是把上限**调小**的旋钮（`plan.discount`），它不能把总上限放大 ——
实现里如果它是"乘在扣减金额上"，就变成了超预算的口子。

**2. 万分比 ⇒ 桶至少 10⁴，且必须与报表同构。** 设置值的精度是万分比，
意味着分流空间要能被 10⁴ 等分；如果报表按另一套分桶聚合，
两侧的分母不是同一批人，"流量比例分配为 30% 的创意只拿到 22% 消耗"这种争论无法判定谁对。
分配本身要用**最大余数法**并给并列定确定序（见同方向的算法题），
否则同一份配置两次运行给出不同分桶 —— 实验数据直接作废。

**3. 出价与目标 ROI 的一致性。** 可接受的成交出价上界 ≈ 客单价 ÷ 目标 ROI
（都换成整数分与万分比再算，不要用浮点）。
一致性检查的价值在于：商家把目标 ROI 调高、却把成交出价也调高时，
两个参数互相矛盾，系统会持续"投不出去"或"投出去必亏"，
而两边的设置都合法 ⇒ 没有任何单点会报错。这要作为**配置期的交叉校验**。

**4. 两种成交口径为什么不同。** 广告归因的是"点击之后若干天内的成交"，
交易口径要过两条广告侧根本不存在的线：`group_status = 1`（成团才算成交）与
`risk_control_status`（审核中不进结算）。再叠上退款回冲、跨天、券归属、
抽奖单 / 拼内购单的排除集，两套数必然不同。
**正确立场是给出映射表而不是选边**：从广告归因成交到可结算成交，逐项列出扣减，
让差额可解释；差额解释不了的部分才是问题。

**5. 报表分层的立场。** 顺序必须是：① 谁是一次真相（小时层，可追溯到计费日志）；
② 晚到回补窗口多长（按退款与归因争议期定，不是"我们一般回补 3 天"），窗口外冻结；
③ 不回溯的口径变更要公告 + **冻结可比区间**（否则同比环比在变更点全部错位，
而报表看起来一切正常）。跳过 ① 直接讲"以分天为准"的候选人，说明没做过分层对账。

**6. 指标必须先声明确认模式。** 即时确认（曝光/点击）与按服务期分摊（固定价展示）
混在同一条收入线里，所以"千次收入"必须先说是哪一类：
把分摊类算进千次分母，会把一个稳定客户的价格包摊成"效率暴跌"。

**可落地的三条对账规则**：① 计费明细之和 ≠ 报表消耗 ⇒ 停投该计划并追扣（责任在报表）；
② 在途预占超期未落地 ⇒ 自动回补 + 告警（责任在计费链路，通常是消费端挂了）；
③ 同一创意在小时层与分天层的桶数不一致 ⇒ **阻断发布**（责任在分桶实现，这是最贵的静默）。

**不足信号**：认为超投是体验问题；把两种成交口径"取一个为准"；
用浮点算出价；只答"跑个 job 对一下"；说不清万分比与桶的关系。"""
    )


# =================================================================== S5 跨境与合规分区
@draft('sys-pdd-cross-border-data-partition')
def q_sys_cross_border():
    statement = """## 角色

拼多多 数据平台架构（Senior / Staff），30 分钟。

## 可核查事实

- 2025 年报："Our servers are hosted in internet data centers in different geographic
  regions and countries around the world, including Europe, the U.S. ..."
- 同一段列出：PIPL / CII 要求"在境内运营中收集 and 产生的重要数据须存境内"；
  "持有超过 **100 万用户个人信息**的网络平台运营者赴国外上市须申报网络安全审查"。
- 欧盟 DSA 对 Temu 的义务覆盖 "**traceability of merchants/business users**" 与
  "enhanced transparency measures including in relation to **any recommendation systems**"；
  2024-10 欧盟委员会启动正式调查（涉及非法商品、界面设计、推荐系统、**researcher data access**），
  2025-07 初步认定违反 DSA **第 34 条风险评估义务**，罚款上限为全球年营业额 **6%**。
- 另有 EU AI Act 的分级合规要求。
- 监管取证侧（2026-04 "幽灵外卖"系列案执法纪实）：
  执法方要求平台交出"**订单流转、资质备案、转单交易**"三类关键电子数据，
  平台第一次提供的是"整体数据 1/3、1/4 甚至更少"、"碎片化、格式混乱"，
  处理方式是"**一店一处罚**"、"6 万多个具体案件不能批量化认定"。

## 题目

设计跨主站（境内）与 Temu（境外）的数据平台形态，回答：

1. 为什么"分区"不等于"两套数仓"？给出你的分层结论（指标定义 / 物理数据 / 派生聚合 / 决策证据）。
2. 哪些数据是**可被要求交出去的交付物**、哪些**不能出境**？给出你的分类判据与两条边界案例。
3. "风险评估"在 DSA 下是**可交付物**（风险登记、缓解措施、独立审计），
   这对日志与曝光链路的保留期提出什么要求？为什么不能按成本定保留期？
4. 设计"监管 48 小时取证"的交付物：内容、格式、不可抵赖性、以及你怎么保证它平时就是可用的。
5. 派生特征跨区时的隐私与合规约束：什么可以出去、什么必须留在本地计算。
6. 一条你会主动**放弃**的统一（把两边统一会违反哪个约束）。

素材明确写了：拼多多内部数据栈选型无任何可核查来源 —— 本题不考选型，只考口径与义务。"""

    return base(
        'system-design', 'senior',
        '指标一份、数据各留本地、证据可导出：把跨境分区当合规件而不是架构偏好',
        statement, 'llm-rubric',
        ['data-residency', 'regulatory-traceability', 'evidence-export', 'retention-policy',
         'modern:compliance-architecture'],
        src('数据平台架构（跨境与合规方向） 首席工程师候选',
            DATA + '#4 考点 11/12（多地域 IDC、PIPL/CII 本地化、DSA 商户可追溯与推荐透明、'
            'Art.34 初步认定与 6% 上限、监管取证的"1/3、1/4 碎片化数据"与一店一处罚）'),
        language='markdown',
        rubric=[
            ('分层的正确切法', 2,
             '必须给出"定义一份 / 物理数据各留本地 / 派生聚合可跨区 / 决策证据按需导出"四层，'
             '并说明每层的变更审批人不同；只答"两边各建一套数仓"给 0 分'),
            ('可导出与不可出境的分类判据', 2,
             '判据要来自义务（谁有权要求、要求什么）而不是"敏感级"标签；'
             '两个边界案例各说对一条即可'),
            ('保留期按义务定', 2,
             '答到风险评估是可交付物 ⇒ 保留期由监管窗口（含申诉与复议期）决定；'
             '只按存储成本定 = 在需要举证时等于没留痕'),
            ('48 小时交付物设计', 2,
             '最小闭包导出包：内容清单 + 字段版本 + 抽取时刻 + 哈希清单 + 操作审计不可抵赖；'
             '并说明"平时就是可用的"= 定期演练 / 契约化'),
            ('派生特征的跨区约束', 1,
             '可出聚合与阈值、不可出个体级明文；能指出"逆向重识别"是真实风险更好'),
            ('主动放弃的一个统一', 1,
             '例如拒绝统一用户主键（跨区 join 本身就是出境）；理由要落在具体义务上'),
        ],
        notes='这题不考组件选型（素材明确：拼多多内部数据栈无任何可核查来源）。'
              '如果候选人一直讲 Kafka/Paimon/ClickHouse 而答不出义务映射，按"分类判据"0 分处理。',
        estimatedMinutes=30,
        answer="""## 参考要点

**1. 分区不是两套数仓。** 四层结论：
**指标定义一份**（同一个"活跃商家"在两边必须是同一个定义，否则集团报表无法合并 ——
素材里官方定义是唯一事实，两边共用）；
**物理数据各留本地**（境内收集产生的重要数据存境内）；
**派生聚合层可跨区**（不带个体标识的聚合是两权相害取其轻的产物）；
**决策证据可导出**（这是给监管/内审的，不是给分析的）。
这四层的变更审批人不同：定义层是指标委员会、物理层是法务与安全、
聚合层是数据平台、证据层是合规 —— 把四层混在一个仓库里，就没有审批边界可言。

**2. 分类判据来自义务，不来自"敏感级"。** 两个边界案例最能区分人：
① **曝光-点击-成交链路日志**：DSA 明确要求推荐系统透明与研究者数据访问，
所以它**必须**能交出去（含"为什么这件商品被推给这个人"的决策依据），
这属于"可交付物"而不是"内部隐私"；
② **境内商家的个人身份与联系方式**：PIPL / CII 下不得出境，
而素材里另一条更硬 —— 平台若无法向消费者提供商户真实姓名、地址、有效联系方式，
可能需**先行赔付**。所以它是"留在本地、按需向境内监管提供"，
不是"绝对不能给"，也**不是**"可以同步到境外机房"。

**3. 保留期按义务定。** 欧盟的初步认定是**违反第 34 条风险评估义务**，
而风险评估是**可交付物**（风险登记、缓解措施、独立审计），不是一份 PPT。
所以证据链的保留期由"被要求解释的时刻"决定：至少覆盖监管调查窗口 + 申诉复议期。
按存储成本定保留期的后果很具体：30 天滚动日志在取证时等于没有，
企业会因此从"我做了但拿不出证据"退化成"我无法证明我做了"。
（素材里的执法纪实正是这个方向：办案方要"反复研究平台数据架构、交易流程及算法逻辑"
才提取出三类关键电子数据。）

**4. 48 小时交付物 = 最小闭包导出包。** 内容：某主体某时段的全部
订单流转 + 资质备案 + 转单链条；每列带**字段版本**（哪一期口径）、
**抽取时刻**、**文件哈希清单**（可校验未被修改）、
**操作审计**（谁看过、谁导出过，含内部审核人员 —— 案文明确出现"内部审核人员相互勾连"，
所以不可抵赖必须覆盖自己人）。
"平时就可用"的含义：这个包要**定期演练生成**并纳入 DQC，
否则 48 小时到了才发现"整体只能交出 1/4、格式混乱"——那就是素材里平台第一次交数据的样子。

**5. 派生特征跨区。** 可以出去的是**聚合与非标识性统计**；
必须留在本地算的是任何能回到个体的东西（个体级特征、样本明细、模型梯度）。
一个常被忽略的风险是**逆向重识别**：小分桶的聚合（比如某地某类目"日均 1.2 单"）
实质就是个体数据 ⇒ 所以派生层要有最小分桶规模约束，而不是只看"是不是明细"。

**6. 可以拒绝的统一。** 典型好答案：**拒绝跨区统一用户主键 / 全局 ID mapping**。
理由很具体：把境内用户标识映射到境外可解析的键，本身构成个人信息的出境处理，
而这正是本地化义务要挡的事。
替代方案是**两边各自可解释、在集团层只统一指标定义与元数据**。
另一个合格答案：拒绝把两边的曝光日志合并到同一张表做特征（推荐透明义务要的是可解释证据，
合并之后两边都无法独立举证）。

**不足信号**：把合规当"法务已经确认过了"；答"两套数仓各管各的"；
按成本定保留期；48 小时交付物答"导个 Excel"；用组件名代替义务推理。"""
    )


# =================================================================== A1 资质核验与准入 Agent（principal）
@draft('ag-pdd-qualification-review-agent')
def q_ag_qualification_agent():
    statement = """## 角色

拼多多 风控 / AI 工程方向 Senior（principal 轮），40 分钟。
你要设计一个**准入审核 Agent**，它不是聊天机器人，是替人做决定的那条链。

## 可核查事实

- 2025 年报："After merchants post product information on our platforms, we leverage
  **artificial intelligence-based screening system** to identify potential issues and
  subject questionable merchandise to **further review and verification**"；
  治理手段包括 "**block noncompliant products prior to their launch**"（**上架前拦截**）。
- 官方接口层对得上：`pdd.goods.outer.cat.mapping.get`（**类目预测**）、
  `pdd.goods.advice.price.get`（**商品建议价格**）、
  `pdd.goods.latest.commit.status.get`（批量查**审核状态**）。
- 2026 年 4 月市场监管总局"幽灵外卖"系列案：7 家平台合计罚没 35.97 亿元、
  单个平台最高罚款 15 亿元（20-F 确认对拼多多平台运营者约 15 亿元），
  查实 **67604 家**幽灵店铺，按"**一店一处罚**"处理；
  一家"甜颜情书"名下 378 家连锁店的食品经营许可证"**全部为伪造**"；
  平台被认定的两类问题是"**未依法履行审查义务**"与
  "对蛋糕店铺把消费者订单**转让给其他经营者且未告知消费者**（转单）的行为未采取措施"；
  拼多多另被"**九个月暂停新增蛋糕店铺入驻**"。
- 监管要求的机制是"**资质审核、风险监测、问题排查、快速处置**"四件套。
- 执法纪实里两个工程细节：执法方"一个蛋糕店铺一个店铺核验信息、查资质"，且
  "**对于每一个手机号，平台会限定登录查看次数**"（说明账号级频控存在）；
  办案方靠"反复研究平台数据架构、交易流程及算法逻辑"提取
  "**订单流转、资质备案、转单交易**"关键电子数据。

## 请设计

1. **Agent 的边界**：哪些判断可以自动化处置，哪些必须落到人工，为什么。
   给出你的"自动拦截 / 人工复核 / 直接放行"三分规则与阈值来源。
2. **证照核验的数据源**：为什么不能采信商家上传件？
   连锁品牌的"总店—门店"授权链要怎么逐级证明（否则"378 家店同一套假证"必然过审）。
3. **转单识别**：给出你的信号集合与交叉验证方式（履约主体 ≠ 签约主体）。
4. **容量方程**：把召回率提到 99% 会发生什么？给出"拦截准确率 × 人工产能"的方程，
   并说明灰度期给新商家的豁免策略。
5. **可复算性**：每一条拦截决策要能复算到什么程度？给出你的留痕字段清单
   （含模型/规则/特征版本）与"人工改判"的审计要求。
6. **高危审计对象**：你会把哪些"动作本身"当成审计对象（而不是只审结果）？
   至少四条，其中至少一条要覆盖内部审核人员。

## 约束

素材明确写了：拼多多没有任何公开的技术博客 / 开源组件 / 模型细节。
所以**不许**声称"拼多多用了 X 模型"；本题考的是机制与取舍，不是栈。"""

    return base(
        'agent-design', 'principal',
        '资质造假罚 15 亿：把"上架前拦截"做成可复算、可举证、有容量方程的审核 Agent',
        statement, 'llm-rubric',
        ['qualification-verification', 'order-transfer-detection', 'human-review-capacity',
         'decision-reproducibility', 'modern:risk-audit'],
        src('算法工程（风控与准入方向） / AI 平台 首席工程师候选',
            TXN + '#4 考点 12（20-F 与执法纪实的处罚事实、一店一处罚、转单未采取措施）'
            '＋ DATA 考点 10（AI screening + further review + block prior to launch '
            '的官方原文、类目预测/建议价/审核状态接口）'),
        language='markdown',
        rubric=[
            ('自动化与人工的边界', 2,
             '三分规则要给出阈值来源（历史precision/召回曲线 + 人工产能），'
             '并明确"高置信才可自动拦截"——把处置权交给模型的扣分；'
             '能说出"拦截动作对商家是真金白银，所以要影子跑 + 决策差异清单"更好'),
            ('证照数据源与授权链', 2,
             '必须答：不采信上传件、比对发证机关数据源并留存比对结果；'
             '总店—门店逐级授权链可证明（否则 378 家同一套假证必然过审）'),
            ('转单识别信号', 2,
             '要给出多信号交叉：面单发货地/仓库编码集合突变、证照地址 vs 实际揽收地址偏离、'
             '履约主体 ≠ 签约主体、消费者投诉文本；单信号判定的要指出误伤'),
            ('容量方程与豁免', 2,
             '召回↑ ⇒ 误杀↑ ⇒ 申诉量 = 人工队列。要能把方程写出来并给出灰度期新商家豁免策略，'
             '而不是说"提模型效果"'),
            ('决策可复算', 1,
             '留痕清单要含：输入快照、模型/规则/特征版本、阈值版本、决策、人工改判与理由、'
             '时间戳；改判必须双人且不可抵赖'),
            ('高危动作审计', 1,
             '至少四条且含内部人员，例如"跳过审核""白名单加入""阈值下调""批量导出""人工改判"'),
        ],
        notes='这题的红线是编造拼多多的模型实现。凡出现"拼多多用 X 框架/X 模型"的断言，'
              '在可复算项上直接给 0 并整体降档；只谈机制与义务不扣分。',
        estimatedMinutes=40,
        answer="""## 参考要点

**1. 边界。** 三档：
`高置信 + 后果可逆` ⇒ 自动处置（例：图片重复度极高 ⇒ 直接驳回，商家可重提）；
`高置信 + 后果不可逆` ⇒ **必须人工**（例：清退店铺、冻结货款）；
`低置信` ⇒ 放行 + 进抽检池。
阈值来源不是拍脑袋：从历史的 precision/recall 曲线 + **人工日处理量**反推
"自动拦截的最大比例"。加分点：模型升级要**影子跑**并输出**决策差异清单** ——
因为拦截动作对商家是真金白银，差异清单是申诉的依据。

**2. 证照。** 采信商家上传件等于把造假成本降为零（案文里 378 张**全部为伪造**）。
必须比对**发证机关数据源**，并且**留存比对结果**（比对时间、返回值、原文快照），
否则过审了也证明不了"依法履行了审查义务"。
连锁品牌要建**授权链**：总店资质 + 逐级授权书 + 门店地址与许可范围一致性，
每级可单独证明、断一级即整链不过。
"一店一处罚"意味着**批量认定不可用**：核验必须逐店完成，批量"抽查通过"不免责。

**3. 转单。** 判据是"履约主体 ≠ 签约主体"，靠交叉而不是单信号：
面单发货地/仓库编码集合突变（一家店突然从三个城市发货）、
证照地址 vs 实际揽收地址偏离、订单被转派的接口调用痕迹、
消费者投诉文本（"收到的店和我下单的店不一样"）。
单信号必误伤（例如商家换仓是正常的），所以要求**至少两个独立来源同向**才处置，
且处置动作分级：先降级流量/加人工审核，最后才清退。

**4. 容量方程。** 设日提交量 `N`、模型召回 `R`、精度 `P`，人工产能 `C`（单/人日 × 人数）。
自动拦截量 ≈ `N × R`，其中误杀 = `N × R × (1−P)` 会转化为**申诉**，
申诉处理成本通常是首次审核的 2–3 倍。
所以"提到 99% 召回"的真实含义是"人工队列翻几倍"，
除非同时给出 `C` 的增长或 `P` 的提升。
新商家灰度豁免要有**退出条件**（首月内低置信不自动拦截，但强制抽检 ≥ x%），
否则它变成刷单者的注册窗口。

**5. 可复算。** 每条决策留痕：输入快照（商品标题/图片哈希/类目/价格）、
模型版本 + 规则集版本 + 特征版本 + 阈值版本、输出分数与决策、
人工改判记录（谁、依据、第二人复核）、时间戳。
"复算"的判据是**同一份输入 + 同一版本必须得到同一决策**；
做不到就说明版本没留痕，那也就是审计拿不到证据。
（素材里执法方要"反复研究数据架构、交易流程及算法逻辑"才能提取三类电子数据 ——
这就是没有可复算留痕的代价：举证成本转嫁给办案方。）

**6. 高危动作审计（要审动作，不只是结果）**：
① "跳过审核 / 白名单加入"（任何一次都要双人 + 理由 + 有效期）；
② 阈值与规则集变更（本身就是变更事件，要能关联到之后的漏审上升）；
③ 批量导出与批量核验（案文里"每个手机号限定登录查看次数"是账号级频控，
   批量导出是它的镜像风险）；
④ **人工改判**（自动拦截被人放行必须留第二人复核）；
⑤ 内部人员账号的异常访问模式（案文明确出现"平台内部审核人员相互勾连"，
   所以审计必须覆盖自己人，且不可抵赖）。

**不足信号**：把 Agent 做成"大模型读商品描述打分"而没有可复算与人工边界；
说"接官方证照接口"但答不出比对结果要留痕；
用单一信号判转单；答不出容量方程；把审计做成"日志留 30 天"。"""
    )


# =================================================================== A2 监管取证 Agent
@draft('ag-pdd-regulatory-evidence-agent')
def q_ag_evidence_agent():
    statement = """## 角色

拼多多 数据平台 / 内审方向 Senior，30 分钟。

要设计一个**取证导出 Agent**：监管或内审提出"给我某主体某时段的全部链条"，
它要在 **48 小时**内产出一个可举证、可校验、不可抵赖的交付包。

## 可核查事实（执法纪实的三条，直接决定设计）

1. 取证难点原话："**数据量大、取证难、固定难、核验难**……电商平台的业务数据不仅数量庞大，
   而且**存储分散，一般都是在云端**"，需要平台技术人员"从云端现场调取数据"。
2. 平台第一次提供的数据是"整体数据 **1/3、14 甚至更少**"、"**碎片化、格式混乱**"；
   执法方反过来建自己的库（"数据共性、数据比对、**交叉核验、溯源倒查**"）逼平台补齐到 100%。
3. 办案方"反复研究平台**数据架构、交易流程及算法逻辑**"才完成对
   "**订单流转、资质备案、转单交易**"三类关键电子数据的提取、分类梳理与固化。
   处理是"**一店一处罚**"、"不能批量化认定，6 万多个具体案件每一家店情况都不一样"。
   另案披露：平台内部审核人员相互勾连；"对于每一个手机号，平台会限定登录查看次数"。
- 20-F 对中国消保责任的描述：平台若无法向消费者提供商户真实姓名、地址、有效联系方式，
  **可能需先行赔付**。

## 请设计

1. **Agent 的工具面**：它需要哪些工具（不是模型能力）？给出工具清单与每个的输入/输出契约。
2. **最小闭包**：从"一个主体 + 一个时间范围"出发，怎么算闭包？
   哪些边必须跟着走（例如店铺 → 资质 → 面单 → 揽收地址 → 转单目标店铺），
   哪些可以停在边界上并显式声明"未展开"。
3. **交付包的形态**：目录结构、每列的字段版本、抽取时刻、哈希清单、
   以及"核验难"怎么解（让办案方能自己验，而不是相信你说你验过）。
4. **不可抵赖**：审计要覆盖内部审核人员。给出你的机制与它的成本。
5. **覆盖率指标**："可举证覆盖率"怎么定义？为什么它必须平时就在跑，而不是案发后再算？
6. **一条你希望 Agent 拒绝执行的请求**，并说明拒绝的判据。

## 约束

不许引入任何"拼多多内部实现"的断言（素材明确：官方开源为零、无技术文章）。
本题考机制、契约与义务映射。"""

    return base(
        'agent-design', 'senior',
        '48 小时交出"订单流转 + 资质备案 + 转单"三张链：取证导出 Agent 的工具面与闭包',
        statement, 'llm-rubric',
        ['evidence-export', 'data-lineage', 'non-repudiation', 'closure-query',
         'modern:regulatory-traceability'],
        src('数据平台（血缘与合规交付方向） 高级工程师',
            DATA + '#4 考点 11（执法纪实三条原文：取证难点、1/3 折扣数据与碎片化格式、'
            '三类关键电子数据的提取固化、一店一处罚不能批量认定、内部审核人员勾连）'),
        language='markdown',
        rubric=[
            ('工具面与契约', 2,
             '要有明确的工具清单（主体解析、闭包遍历、字段版本查询、脱敏执行、哈希固化、'
             '交付登记），每个带输入输出；只答"写 SQL 导出"最多给 1 分'),
            ('最小闭包的判据', 3,
             '必须说清"跟着义务走"：哪些边必须展开、哪些可停并显式标注未展开；'
             '能指出"转单目标店铺必须递归进去，否则链条断在关键环节"是满分关键'),
            ('交付包可校验', 3,
             '目录 + 字段版本 + 抽取时刻 + 逐文件哈希 + 第三方可复核的验签路径；'
             '要正面回答"核验难"：让办案方能自己验，而不是自证'),
            ('不可抵赖与内部人员', 1,
             '签名/双人/时间源不可回拨/导出动作本身入审计；成本要说明（存储与密钥管理）'),
            ('覆盖率平时就在跑', 1,
             '"可举证覆盖率"= 能在 SLA 内闭环导出的主体占比；'
             '案发后再算是素材里"只交出 1/3"的直接成因'),
        ],
        notes='这题的分辨点在"闭包"二字：把交付包做成"把相关表都 dump 出来"的人，'
              '正是素材里第一次只能交出 1/3、格式混乱的那种平台的实现者。',
        estimatedMinutes=30,
        answer="""## 参考要点

**1. 工具面。** Agent 的价值不在"会写 SQL"，在它有**受约束的工具**：
`resolve_subject`（店铺 → 经营主体 → 关联账号集，含历史变更）、
`expand_closure`（按边类型遍历，可指定深度与"必须展开"的边集）、
`field_registry`（每列的口径版本与变更时间，用于回答"你这列当时是什么定义"）、
`mask_execute`（按收件方身份决定明文/密文/剔除 —— 出境与可见性两条约束都在这一步落地）、
`seal`（哈希固化 + 时间戳）、`deliver_log`（谁申请、给了什么、谁复核）。
每个工具都要有**输入输出契约与配额**，否则 Agent 会退化成"一个能连生产的 shell"。

**2. 最小闭包。** 判据是"**义务要求的证据链**"，不是"外键可达"。
必须展开的边：店铺 → 资质备案（含比对结果与比对时刻）、
店铺 → 订单流转（下单/支付/成团/发货/签收/退款/赔付）、
订单 → 面单 → **实际揽收地址**、以及**转单目标店铺**（这条必须**递归**进去 ——
否则链条正好断在"转让给其他经营者"这个被处罚的关键动作上）。
可以停在边界并显式声明的：消费者个体明细（超出请求范围时按聚合给）、
跨境主体的境内原始数据（义务冲突，给导出申请记录而不是数据）。
关键交付物要有一页**"未展开清单"**：为什么没展开、谁批准、补展开的路径。
——"碎片化、格式混乱、只交出 1/3"的根因就是没人对闭包负责。

**3. 交付包形态。** 一次交付一个目录：
`manifest.json`（请求方、范围、时刻、工具版本、闭包规则版本）、
`data/*.csv`（每份带 `columns.json`：列名 + **字段口径版本** + 该版本生效区间）、
`lineage.md`（每张表从哪个库哪个查询取的、抽取 SQL 原文）、
`checksums.txt`（逐文件哈希 + 一个根哈希）、`signature`。
解"核验难"的办法是**把验证能力交给对方**：给验算脚本与哈希算法说明，
让办案方能独立复算"这份包未被改动、且确实是这个查询在这个时刻产出的"。
"固定难"对应的是哈希 + 时间戳 + 只读归档，不是"我们内部有备份"。

**4. 不可抵赖要覆盖自己人。** 案文出现"平台内部审核人员相互勾连"，
所以：导出、改判、跳过审核三类动作要**双人 + 数字签名 + 不可回拨的时间源**，
并且**审计日志本身在另一个权限域**（审核团队不能删自己的记录）。
成本要如实说：密钥管理与日志留存是真钱，但"一店一处罚"的举证成本更高
（6 万多个案件不能批量认定 ⇒ 每一次都要独立证据）。

**5. 覆盖率指标。** `可举证覆盖率 = 能在 48 小时内完成闭包导出的主体数 / 全部主体数`，
按主体类型分桶（连锁/单店/跨境）。它必须**平时就在跑**：
每周抽 N 个主体做演练导出，失败即缺陷。
案发后才第一次算，得到的就是素材里那个"1/3、1/4"。

**6. 应当拒绝的请求。** 典型好答案：拒绝"把这个城市**全部**商家的收件人地址导出来"这类
**范围超出请求目的**的导出。判据是目的绑定 + 最小必要：
请求单上的义务/案件编号与数据范围要能对上，对不上就必须回绝并要求补充授权。
（反过来，把"拒绝"用在"监管依法要求推荐系统透明"上就是错 ——
那一类是 DSA 明确的可交付物，该做的是建能力不是挡请求。）

**不足信号**：把交付包当"跑个 join 导 CSV"；答不出未展开清单；
认为哈希/时间戳是"形式主义"；审计不覆盖内部人员；覆盖率指标留到案发后。"""
    )


# =================================================================== A3 增量排障 Agent
@draft('ag-pdd-increment-triage-agent')
def q_ag_increment_triage():
    statement = """## 角色

拼多多 服务端研发（开放平台 / 稳定性方向）Senior，25 分钟。

ISV / 商家技术支持每天收到一类工单：**"你们漏了我的订单。"**
你要设计一个**排障 Agent** 来处理它。

## 可核查事实

- `pdd.order.number.list.increment.get`：按**最后更新时间**切片、
  **窗口跨度不超过 30 分钟**、**必须倒序分页（从最后一页往回取）才能避免漏单**。
- `order_status`：`1 待发货 / 2 已发货待签收 / 3 已签收 / 5 全部`（`5` 是筛选值）。
- 消息服务：`pdd.pmc.accrue.query`（队列积压数量查询）、
  `pdd.pmc.user.permit / .cancel / .get`（订阅生命周期）——
  **ISV 侧唯一能自助看的健康度就是 lag**。
- 网关公共参数：`client_id / access_token / timestamp（秒级）/ type / sign`。
- 对账对外通道是**日账单文件**，不是实时接口。

## 请回答

1. **Agent 的工具集**：定位一次"漏单"工单需要哪些查询？给出诊断顺序（先查什么、为什么）。
2. **结论空间**：这个工单可能有多少种"真相"？逐一给出**判据**（可机器判的判据，
   不是"看起来像"），并区分"平台漏"、"ISV 漏"、"口径误会"三类责任。
3. **权限边界**：Agent 可以自动执行哪些动作、哪些必须人来批？
   特别说明：为什么"**把窗口放宽到 2 小时重试一次**"必须是禁止动作。
4. **补偿动作**：确认漏了之后怎么补？补拉的幂等键与终止条件。
5. **自证能力**：如何把"我没漏"变成可对外举证的一句话（带数据的），
   而不是"我们查了没有漏"。
6. 这条工单流本身应该产出什么**指标**，让下一批工单不再出现。

## 约束

题面里的窗口/频率/超时数字都是官方约束或出题假设；不许引用任何拼多多内部实现。"""

    return base(
        'agent-design', 'senior',
        '"你们漏了我的订单"：排障 Agent 的诊断顺序、结论空间与禁止动作',
        statement, 'llm-rubric',
        ['incident-triage', 'idempotent-replay', 'permission-boundary', 'self-attestation',
         'modern:data-consistency'],
        src('服务端研发（开放平台支持 / 稳定性方向） 高级工程师',
            TXN + '#4 考点 4（30 分钟窗口 + 倒序分页防漏单 + 三通道对账的官方约束）'
            '＋ DATA 考点 6（消息积压查询与订阅生命周期接口、静默断流是首要故障模式）'),
        language='markdown',
        rubric=[
            ('诊断顺序与工具集', 3,
             '顺序要对：先判职责范围（水位线）→ 再看留痕（pull_log 是否存在及其窗口）→ '
             '再判翻页方式 → 最后才怀疑数据。给出可执行查询而非"看看日志"'),
            ('结论空间可判', 3,
             '至少给出 4 类真相且各自有判据；必须显式区分平台漏 / ISV 漏 / 口径误会。'
             '只答"确实漏了/没漏"给 0 分'),
            ('权限边界与禁止动作', 2,
             '要说明"放宽窗口"为什么被禁止：它把漏单从可发现变成静默，且改变对方水位线语义。'
             '自动动作要限于只读查询与幂等补拉'),
            ('补偿的幂等与终止', 1,
             '补拉键（order_sn + 原因 + 请求 id）与终止条件（回溯上限），'
             '并说明为什么不能无界补拉'),
            ('可举证的自证', 1,
             '给出集合基数差与留痕证据（能对外说"缺口 = 0"的那种数），不是主观结论'),
        ],
        notes='这题的分辨点在结论空间：能把"口径误会"（order_status=5 是筛选值、'
              '按 created_at 而不是 updated_at 查、抽奖单/拼内购被排除）与"真漏单"分开的人，'
              '才是做过对账的人。',
        estimatedMinutes=25,
        answer="""## 参考要点

**1. 诊断顺序。** 顺序本身就是答案：
① **职责范围**——这单到底归不归那个窗口管（`updated_at` 是否落在 ISV 声称的那次拉取窗口内；
超过水位线的不算漏）；
② **留痕**——平台侧 `pull_log` 里有没有这单，以及**当时那条留痕的窗口边界**
（有留痕但窗口没包住它 ⇒ 错窗，不是漏单）；
③ **翻页方式**——该 ISV 是正序还是倒序（正序 + 窗口内有更新 ⇒ 结构上必漏）；
④ **消息通道**——`pdd.pmc.accrue.query` 的积压值 + 订阅是否被 `.cancel`（静默断流）；
⑤ 最后才查平台自己的写入链路。
先查⑤是新手做法：它会花三天查一条没坏的管道。

**2. 结论空间**（至少这几类，每类都要有可机器判的判据）：
- **平台漏**：`updated_at <= 水位线` 且留痕里从未出现 ⇒ 判据是集合基数差 > 0；
- **错窗**：留痕有，但那条记录的 `[window_start, window_end]` 不包含 `updated_at`
  ⇒ 责任在窗口计算或上游时钟，不是分页；
- **ISV 漏**：平台留痕正常且推送成功，ISV 侧处理失败 ——
  **"平台推送成功"与"ISV 处理成功"是两个 SLA**，这就是为什么必须分开；
- **静默断流**：积压 = 0 且拉到 0 条 —— 订阅被 `.cancel` 之后队列不炸、
  指标全绿，**一条数据都没到**（首要故障模式）；
- **口径误会**（现实中占比最高）：ISV 用 `created_at` 查而不是 `updated_at`；
  把 `order_status=5`（筛选值）当状态值；漏了 `confirm_status/group_status` 的分桶；
  或者订单还在"待成团"窗口里就被当成丢单；
- **重单被误报成漏单**：倒序 + 重叠窗口必然重复拉取，ISV 未做幂等合并，
  看到"数量不对"就报漏单。

**3. 权限边界。** Agent 可自动执行：**只读**查询（留痕、水位线、积压、订阅状态、集合差集）
+ **幂等补拉**（按 `order_sn` 精确补，带请求号）。
必须人批：改窗口长度、改轮询频率、改水位线推进规则、改任何 ISV 侧配置、
以及任何"重跑覆盖历史"的动作。
**"把窗口放宽到 2 小时重试一次"必须是禁止动作**，理由不是"违反官方限制"这么表面：
调用方的水位线是按它以为的窗口边界推进的，平台侧单方面放宽/截断会让
**每个周期稳定漏掉一段，而两边日志都说自己没错** ——
它把"漏单"从可发现变成静默。要放宽必须双方同步变更口径并公告、冻结可比区间。

**4. 补偿。** 幂等键 = `order_sn + 补拉原因 + 请求号`，写入侧要能回答
"这条是补拉来的"（不能与正常增量混成一份，否则永远算不清漏单率）。
终止条件是必须的：回溯期上限（例如 7 天）、单工单补拉条数上限、
同一主体连续补拉触发熔断转人工 —— 否则一个坏掉的水位线会无限补拉，
把自己变成一次 DDoS，并把"漏单率"这个 SLI 洗成 0（**用补偿动作掩盖故障**是最隐蔽的自欺）。

**5. 自证。** 可对外举证的话只有一种形状：
"你方在 `[T1, T2]` 按 `updated_at` 应得订单 **N** 条，我方留痕显示已交付 **N** 条，
集合差集为空（差集基数 = 0），证据见附件导出"。
这里的关键是**全量集合基数**这一侧要有一按**成交时间**的独立口径（就是三通道里的第二条）——
没有它，"我没漏"永远只是自述。

**6. 这条工单流产出的指标。**
① 漏单率（差集基数 / 全量基数）；② 补拉命中率与到账时延；
③ **口径误会占比**（结论空间里各归一类的分布，尤其是"非平台责任"的比例）；
④ 正序拉取的 ISV 数量（这是**可以被产品文档消灭的**根因）。
④ 最重要：把它变成主动通知，工单量就会掉 ——
**排障 Agent 的最高价值不是解工单，是把某类工单归零。**

**不足信号**：先怀疑平台写入链路；把"推送成功"当"对方处理成功"；
把放宽窗口当合理重试；补拉无终止条件；结论没有可机器判的判据。"""
    )


# =================================================================== A4 口径问答 Agent
@draft('ag-pdd-metric-caliber-agent')
def q_ag_metric_caliber_agent():
    statement = """## 角色

拼多多 数据平台方向 Senior，25 分钟。

要上一个**口径问答 Agent**：业务方在群里问"上周活跃商家多少"、
"这个补贴率对不对"、"为什么 GMV 涨了收入没涨"，它来答。

## 可核查事实

- 官方对"活跃商家"的定义原文：
  "merchant accounts that had **one or more orders shipped to a buyer** on our platforms
  in that period, **regardless of whether the buyer returns the merchandise or the merchant
  refunds the purchase price**"。
- 公司自列风险："Fictitious transactions **may result in the inflation of our key metrics**"，
  且虚假交易的目的是抬高 "sales records and **search results rankings**"。
- 官方承认"平台自有流量与社交分享流量**无法准确二分**"
  （"it is impracticable for us to accurately bifurcate and quantify the buyer traffic
  generated directly through our platforms and through social networks"）。
- 金额有官方公式（`pay_amount` 含邮费与服务费；`discount_amount` 三项之和；
  `promotion_type=30` 已包含在平台优惠里）。
- 收入确认：广告有"即时确认"与"按服务期分摊"**两种并存**；交易服务收入在
  服务义务完成时点确认，且**可变对价要预估并事后冲正**。

## 请回答

1. **Agent 的检索对象**：它该查什么才答得可信？给出"指标卡"的字段清单（至少五项）。
2. **拒答设计**：哪些问题 Agent 必须**拒绝回答而不是估算**？给出判据与拒答话术的形状。
3. **一个数字三种答案**：当不同人对"活跃商家"给出三个数，Agent 的处置流程是什么？
4. **可信度**：去噪后的指标怎么让业务方接受（否则他们会一直用原始数）？
   给出双轨指标的呈现契约。
5. **反馈回路**：虚假交易抬高销量与搜索排序 ⇒ 指标可信本身就是数据职责。
   Agent 怎么发现自己的答案正在被用来做增量证据不足的事？
6. 一条你会**主动不做**的报表/口径，说明理由。

题面数字全部可核查，但不要引入任何"拼多多内部指标平台实现"的断言。"""

    return base(
        'agent-design', 'senior',
        '口径问答 Agent：指标卡检索、必须拒答的问题清单，与让业务接受去噪数的契约',
        statement, 'llm-rubric',
        ['metric-card', 'refusal-design', 'denoised-metric', 'feedback-loop',
         'modern:metric-governance'],
        src('数据研发（指标平台与语义层方向） 高级工程师',
            DATA + '#4 考点 2/9（官方活跃商家定义原文、虚假交易抬高关键指标与搜索排序、'
            '双轨指标与去噪评估）＋ 考点 1（流量归因官方承认不可二分）＋ §2 追问 3/7'),
        language='markdown',
        rubric=[
            ('指标卡是检索对象', 3,
             '五项齐全（触发事件、去重主体、时间归属、是否回溯、排除集）且能说明'
             'Agent 只答有卡的指标、无卡即拒；答"接个 Text2SQL"最多 1 分'),
            ('拒答判据', 3,
             '至少给三类必须拒答：无官方依据的二分（流量归因）、跨时间锚点混算、'
             '未登记口径；并给出可执行的判据而不是态度'),
            ('冲突处置流程', 2,
             '三个数并存时要做的是**收敛成口径卡 + 版本**，不是挑一个当真相；'
             '要说清谁裁决、怎么公告、历史怎么标'),
            ('双轨呈现契约', 1,
             '原始/去噪并列 + 去噪规则的命中率与误伤率公开；黑盒去噪不得分'),
            ('反馈回路自察', 1,
             '能说出"我的答案被拿去支撑一个没有增量证据的结论"如何被发现'),
        ],
        notes='这题最容易过的答案是"接个大模型 + Text2SQL"，那正好是素材里'
              '"堆模型名词却答不出口径"的不足信号。评分时优先看第 2 项（拒答判据）。',
        estimatedMinutes=25,
        answer="""## 参考要点

**1. 检索对象是指标卡，不是表。** 五项必备：**触发事件**（shipped / paid / confirmed）、
**去重主体**（账号 / 店铺 / 经营主体）、**时间归属**（按哪个时间落周期、闭区间还是开区间）、
**是否回溯**（退款发生后要不要改历史）、**排除集**（测试单、抽奖、拼内购、风控审核中）。
Agent 只答有卡的指标；无卡即拒（并生成一张待登记的卡）。
为什么这么硬：官方"活跃商家"三项细节（shipped / 不扣退款 / 主体是账号）任何一项猜错，
答案都会差出可观测的幅度，而且**错的方向恰好是让数字看起来更正常**。

**2. 必须拒答的三类。**
① **官方已承认不可分的量**：渠道 GMV / "社交裂变带来的成交占比"——
20-F 原文是 "impracticable to accurately bifurcate"。
判据：该指标的定义里出现了"归因拆分"但没有已登记的准实验设计 ⇒ 拒答。
拒答话术的形状是"**这个量当前没有可信口径，我不给估算值；给你两个可信替代 + 一个实验设计**"，
而不是"数据不足"。
② **跨时间锚点的比较**：把"活跃商家（已发货，不扣退款）"与"结算商家（已成交成团，扣退款）"
放同一张对比图。这两个指标的时间锚点天然不同，直接对比**必然**得到错误结论。
判据：两个指标的 `触发事件` 或 `是否回溯` 不一致却被并列 ⇒ 拒答并给出可比的替代。
③ **未登记口径 + 隐含结论**："帮我算个补贴率"——素材说得很清楚，补贴不是一个数，
是三个（GMV 补贴、平台让利、财务收入抵减），混成一个就是最常见的口径事故。
判据：请求的口径不在卡里、或它的分子分母跨了两个出资认定 ⇒ 拒答并指出会丢哪种可逆性。

**3. 冲突处置。** 三个人报出三个数，正确动作**不是判定谁对**，而是：
把三种算法显式化为三张卡 → 找出**唯一合法的对外口径**（与财报对齐的那个）→
其余标为"内部诊断口径"并改名（带后缀，如 `_excluding_refund`）→ 公告 + 冻结可比区间。
关键是**改名而不是覆盖**：历史报表要能回答"当时那个数是怎么来的"，
这与可变对价要存预估快照是同一条原则（否则审计追溯断裂）。

**4. 让业务接受去噪数**：唯一可行的办法是**公开去噪规则的评估指标**
（命中率 + 误伤率，并给"新商家爆单被误伤"的显式豁免），
并且**双轨并列展示而不是替换**。
替换式去噪一定失败：业务方会发现自己的原始报表不见了，从此不信这套系统，
退回去用 Excel。呈现契约：`metric_original` 与 `metric_denoised` 两列永远同时出现，
外加第三列 `noise_share`（被去掉的占比），让"去噪了多少"本身可讨论。

**5. 反馈回路自察。** 官方把两件事写在同一页：虚假交易抬高销量与**搜索排名**，
以及"关键指标可能被虚高"。含义是：**指标本身就是被攻击面**。
Agent 要能发现"我的答案正在被用于没有增量证据的结论"——
可操作做法：记录每次回答被引用的下游决策（报表、复盘 PPT、预算申请），
当同一个数被用于"因为指标涨了所以活动有效"这类**因果句式**时，
自动附加一条"该结论需要增量性证据"的提示并计数；
这类提示被忽略的比例本身就是一个指标。

**6. 主动不做的报表。** 合格答案示例：拒绝做"渠道 ROI 报表"（在没有准实验之前）。
理由：它会持续产出一个看似精确、实际无法证伪的数，
并且**因为它是决策依据，它就变成不可撤回的口径**——
一年之后没人记得它是估的。与之相对，"我拒绝做但我会做增量实验设计"才是完整答案。

**不足信号**：堆模型/组件名词答不出口径；把去噪做成黑盒；
遇到无法二分的问题给一个估算数；三个数并存时挑一个当真相；
只答"我拒绝"不给可信替代。"""
    )


# =================================================================== H1 短题：倒序分页
@draft('hot-pdd-increment-window-short')
def q_hot_increment_window():
    statement = """## 短题（10 分钟，高频追问）

拼多多官方接口 `pdd.order.number.list.increment.get` 的参数注释里有两句原文：

> 必填，最后更新时间结束时间的时间戳……**开始时间结束时间间距不超过 30 分钟**
>
> **注：必须采用倒序的分页方式（从最后一页往回取）才能避免漏单问题**

请在 10 分钟内回答三件事：

1. **正序分页为什么会漏单？** 请给出机制，不要只重复"会漏单"。
2. **你的水位线怎么设计？** 允许重叠吗？能推到哪儿？
3. **你如何在生产上证明没有漏单？**（不许回答"和商家对一下"。）"""

    return base(
        'hot-interviews', 'senior',
        '10 分钟短题：正序分页为什么漏单、水位线推到哪儿、怎么证明没漏',
        statement, 'llm-rubric',
        ['reverse-pagination', 'watermark', 'missed-record', 'modern:data-consistency'],
        src('服务端研发（交易/开放平台方向） 高级工程师高频追问',
            TXN + '#5 题面草稿 C（原题：官方 30 分钟窗口 + 倒序分页 + 证明没漏单）'),
        language='markdown',
        rubric=[
            ('机制解释', 4,
             '要给出坐标不变量的解释（队头掉行时"从队尾数的位置"不变、从队头数的位置左移），'
             '而不是重复题面；能画出一页一行的具体例子给满分'),
            ('水位线设计', 3,
             '推进判据是"从队头起连续已读"而非"本次最大 updated_at"；'
             '要允许重叠窗口并配安全滞后；说清倒序把风险挪到窗口左边界'),
            ('可证明性', 3,
             '按成交时间的全量集合差集 + 拉取留痕基数；漏单率作为一等 SLI；'
             '提到"未来时间戳要隔离不参与推进"加分'),
        ],
        notes='短题的分辨力极高：机制解释不出来的，基本没写过这条链路。'
              '注意候选人是否主动指出"倒序解决不了右扩问题，所以窗口必须窄"。',
        estimatedMinutes=10,
        answer="""## 参考答案

**1. 为什么会漏单 —— 一个不变量就够。**
结果集按 `updated_at` 升序排列，窗口左边界随时间向前推进 ⇒ 队头不断掉行。
此时：**每一行"从队尾数过去的位置"保持不变，而"从队头数过去的位置"全体左移。**
正序分页用的是会漂的那个坐标：第 `s` 次请求取 `[s×P, (s+1)×P)`，
而前面已经掉出去了 `k` 行 ⇒ 实际取到的是原始的 `[s×P+k, (s+1)×P+k)`，
于是 `[s×P, s×P+k)` 这一段被跨过，且**它不会再出现在任何后续页里**。
倒序用的是不漂的坐标（从队尾数第 `s` 页），所以窗口内的行不会被跨过。

举个具体例子：6 行、页大小 2、跑 3 步、每步掉 1 行 ——
正序读到 `{0,1}`、`{3,4}`、越界 ⇒ 结束时窗口里是 `{2,3,4,5}`，**漏 2 和 5**；
倒序读到 `{4,5}`、`{2,3}`、`{2,3}` ⇒ 结束时窗口里的四行**一条不漏**。

**倒序不是万能的**：如果新行不断从**队尾**进来，倒序会反复读到新行、把队头老行饿死。
这正是"窗口不超过 30 分钟"存在的理由 ——
窗口够窄，右扩的量在一个作业周期内才是有界的。三句话必须一起用。

**2. 水位线。**
推进判据是"**从窗口队头起连续已读到的最大位置**"，不是"本次返回的最大 `updated_at`"
（后者在正序漏读时会把没读到的行永久跳过），也不是"本次请求的结束时间"。
必须**允许重叠**：水位线 = `上次成功处理的 max(updated_at) − 安全滞后`，
滞后量由上游更新的回写深度决定（实测分布，不是拍的）。
倒序分页的新风险在左边界：行可能在轮到它之前就掉出窗口 ——
这部分不算"翻页漏单"，但必须被**水位线 + 差集**捕获，
所以实现里要显式记录"本次读到的最小 `updated_at`"，并与"上次处理位置"比对：
有缺口就把水位线**退回去**而不是继续推。
`updated_at` 被写成未来时间时必须进**隔离区**：不参与推进、不丢弃、单独告警
（丢弃等于承认"这单不存在"，而它只是时间戳坏了）。

**3. 怎么证明没漏。**
"和商家对一下"不是证明，是甩锅。可证明的形状只有一种：**集合基数差**。
第二条通道按**成交时间**（不是更新时间）做全量校对，
得到"该窗口应得订单集" `A`；拉取留痕给出"已交付订单集" `B`；
`|A − B|` 就是缺口，配补拉命中率与到账时延，三者构成一等 SLI。
留痕表必须存 `window_start / window_end`，
因为"没人拉过（missed）"与"拉了但那次窗口本不该包含它（错窗）"是两类责任：
前者改翻页方式，后者修窗口与时钟。
只有 `pulled_at` 的留痕回答不了第二类，而错窗这条更阴 ——
它在 `pull_log` 里看起来被处理过，差集补拉**不会**把它捞回来。

**追问预备**：大商家单窗口几十万行 ⇒ 按商家维度二次分桶，
但**水位线整体推进**（某个子桶失败不能把整条链卡住，也不能让它单独推进）。"""
    )


# =================================================================== H2 一个数字三种答案
@draft('hot-pdd-one-number-three-answers')
def q_hot_one_number():
    statement = """## 口径评审（principal 轮，20 分钟）

同一家公司、同一个自然周、同一份订单数据，三位工程师分别报出"上周成交金额"：

- 甲：**支付口径** —— `SUM(pay_amount)`，所有已支付订单；
- 乙：**商品口径** —— 剥掉邮费与服务费之后的金额；
- 丙：**可结算口径** —— 只算 `confirm_status = 1 AND group_status = 1` 且未被风控冻结的单。

三个数两两不同，而且**都对**（各自口径内部自洽）。

## 你要回答的（这才是 principal 的考点）

1. 这三个数的**分母分别是什么**？逐一写出触发事件、去重主体、时间归属、是否回溯、排除集。
2. 哪一个必须与**财报口径**对齐？说明依据（不许说"财务说了算"）。
3. 老板在会上问"到底多少"，你的回答结构是什么？给出你说话的**顺序**与理由。
4. 如果只能保留一张中间表来支撑 80% 的分析需求，你留哪张、什么粒度？为什么？
5. 半年后有人拿甲除以丙得出"流失率 30%"。这个数错在哪？
   你要在哪一层阻止它被算出来（不是靠 review）？
6. 一条你会**主动拒绝**的报表，并说明理由。

## 已知事实（拼多多的，可核查）

- 官方金额公式：`pay_amount = 商品金额 − 折扣金额 + 邮费 + 服务费`；
  `discount_amount = 平台优惠 + 商家优惠 + 团长免单优惠金额`；
  `promotion_type = 30` 的以旧换新优惠"**已包含在平台优惠金额里**"；
  `trade_in_national_subsidy_amount_type`：`1 支付优惠 / 2 商家优惠`。
- 交易服务收入："we earn fees from merchants for **sales of their products completed
  on our platforms**"，且收入"recognized ... at a point in time when our service
  obligation ... is determined to have been completed"；**可变对价要预估并事后冲正**。
- "活跃商家"官方定义以**已发货**为触发事件且**不扣退款**。
- 订单有两条正交状态：`group_status`（拼团中/已成团/团失败）与
  `confirm_status`（未成交/已成交/已取消）；`risk_control_status` 会改变数据可见性。

不要给"统一成一个口径"这种答案 —— 那要么毁掉三个真实不同的量，要么毁掉可解释性。"""

    return base(
        'hot-interviews', 'principal',
        '同一个周五三个成交金额：分母、财报对齐、会上怎么说、以及在哪一层拦住乱除',
        statement, 'llm-rubric',
        ['metric-caliber', 'denominator-declaration', 'gmv-take-rate', 'semantic-layer',
         'modern:metric-governance'],
        src('数据研发 / 服务端交叉方向 首席工程师候选高频真题',
            DATA + '#5 题面草稿 A（"一个数字三种答案"原题）＋ §2 追问 2/11'
            '（GMV 与收入不同步的三条解释路径、只能留一张中间表留哪张）'
            '＋ TXN 考点 5（官方金额公式与"已包含"陷阱）'),
        language='markdown',
        rubric=[
            ('五个维度逐项声明', 3,
             '三个数各自的分母都要写全五项；漏写排除集（抽奖/拼内购/风控）或'
             '说不清时间归属的最多给 1 分'),
            ('财报对齐的依据', 2,
             '要能引到"completed on our platforms"与服务义务完成时点 ⇒ 丙（可结算）对齐，'
             '并说明为什么不是甲；答"财务说了算"给 0'),
            ('会上的回答结构', 2,
             '顺序必须是：先给主口径 + 分母，再给另两个及其差因，最后说"你要问的是哪件事"；'
             '直接挑一个数给老板的最多 1 分'),
            ('中间表的选择', 2,
             '订单事实粒度（可重算），不是聚合报表；要说明为什么粒度决定了能不能长出这三个数'),
            ('拦住乱除的层', 1,
             '语义层/指标卡的组合约束（可比性声明），不是"review 时提醒"'),
        ],
        notes='这题的地板是"能分清三个数"，天花板是"能说清哪个必须与财报对齐、'
              '以及在哪一层阻止不可比量相除"。中间那档人很多，principal 轮要看天花板。',
        estimatedMinutes=20,
        answer="""## 参考要点

**1. 三份口径卡。**

| 维度 | 甲（支付口径） | 乙（商品口径） | 丙（可结算口径） |
| --- | --- | --- | --- |
| 触发事件 | 支付成功 | 支付成功 | 成交且成团（`confirm_status=1 AND group_status=1`） |
| 度量对象 | `pay_amount`（含邮费+服务费） | `pay_amount − post − service_fee` | 同乙再扣 `service_fee` 与退款回冲 |
| 去重主体 | 订单（不去重） | 订单 | 订单 |
| 时间归属 | 支付时刻落周期 | 支付时刻落周期 | **结算/服务义务完成时点**落周期 |
| 是否回溯 | 退款不回冲（另列） | 退款不回冲 | 退款回冲；可变对价预估后冲正 |
| 排除集 | 测试单 | 测试单 | 测试单 + 抽奖单 + 拼内购单 + 风控审核中单 |

三个数两两差的是**不同的东西**：甲−乙 = 邮费与服务费；
甲−丙 = "付了但没成/没结"的（团失败、未成团、已取消、审核中、跨账期）；
乙−丙 = 上面那批的商品额。
**能把差额解释成具体业务态，才是懂了口径**；只说"定义不同"是背题。

**2. 与财报对齐的是丙。** 依据不是"财务说了算"，而是官方收入确认段：
交易服务收入 "earn fees from merchants for **sales of their products completed**
on our platforms"，且"recognized at a point in time when our service obligation
is determined to have been completed" ——
"完成"在拼多多的数据模型里就是 `group_status=1 AND confirm_status=1`（成团才算成交）。
所以对外可审计的那个数只能是丙；甲与乙是内部诊断口径。
再叠一层：可变对价要**预估并事后冲正** ⇒ 丙本身带预估成分，
所以报表必须存**预估时点快照**，否则历史永远无法复算（审计追溯断裂）。

**3. 会上的顺序（这是 principal 真正的考点）。**
① 先给**一个主数**并立刻附分母（"可结算口径 3.2 亿，分母是成团且已成交、
扣退款与服务费、含预估冲正"）；
② 再给另两个并说明**差在哪几笔**（不是"定义不同"）；
③ 最后反问一句**"你想决策的是哪件事"**：
要不要补库存 → 看甲；要不要评价商品定价 → 看乙；要不要对外沟通或对账 → 看丙。
直接挑一个数回答"到底多少"的人，会把老板引到一个没有分母的结论上 ——
**这才是那 30% 流失率的诞生现场。**

**4. 只能留一张表 → 留订单事实粒度。**
判据是**可重算性**：聚合报表只能回答"当初设计它的人想到的问题"，
而订单事实 + 优惠分摊明细 + 状态时间戳能长出甲乙丙以及未来任何一列。
素材里那句"如果只能保留一张中间表支撑 80% 分析需求"，期待答案正是
"能重算的粒度，而不是聚合报表"。
代价要主动说：查询成本更高，所以要配**按真实查询模式设计的物化裁剪**
（并给出验证方法：查询命中分布 + 重算成本对比）。

**5. 拦住"甲除以丙"。** 错在**时间锚点与排除集都不同**的两个量相除，
得到的不是比率而是噪声（分子是支付时刻、分母是结算完成时刻，
跨账期的单会被同时"多算分子、少算分母"，于是这个数会随账期节奏周期性抖动）。
要在**语义层**拦：每个指标登记时声明可与哪些指标做比值（可比性约束），
不在允许组合内的除法由 BI/取数网关**直接拒绝生成 SQL**。
"review 时注意"不是防线 —— 素材里"语义层强制：所有对外指标必须来自口径卡"说的就是这个。

**6. 主动拒绝的报表。** 合格答案示例：拒绝"流失率"这类
**分子分母来自两个不同锚点**的复合指标；或拒绝在准实验之前做"渠道 ROI"。
理由要落在"它会变成一个无法撤回的决策依据，而没人记得它是估的"。

**不足信号**：给一个"统一口径"；说"以财务为准"却给不出依据；
把三个数的差归成"有延迟"；主张保留聚合报表以便省成本；
把防线放在人工 review。"""
    )


# =================================================================== H3 缺失率定位
@draft('hot-pdd-missing-rate-triage')
def q_hot_missing_rate():
    statement = """## 短题（10 分钟，数据岗高频）

某天开始，看板上"**地址缺失率**"从 2% 涨到 40%；
同一时间，"**待发货超时率**"略微**下降**。
业务方在群里说："采集坏了，你们查一下 ETL。"

请给出：

1. 你的**定位顺序**（第一步查什么，为什么不是先查 ETL）；
2. **三种可能结论**，每种给出可机器判的判据（能一句话把另一种排除掉的那种）；
3. 修法：这条指标应该被改成什么样，才能下次不再被误读；
4. 顺手回答：为什么"待发货超时率下降"和这件事**很可能是同一件事**？

## 一条可核查的官方事实（拼多多的，不是假设）

订单收件人字段 `receiver_address / receiver_name / receiver_phone` 的官方注释：
"订单状态为待发货状态，**且订单未被风控打标的情况下返回密文数据；其余情况返回空字符串**"。
另有 `risk_control_status`：`0 正常订单 / 1 审核中订单`；
`order_status`：`1 待发货 / 2 已发货待签收 / 3 已签收 / 5 全部`。"""

    return base(
        'hot-interviews', 'senior',
        '"地址缺失率 2% 涨到 40%"：先用可见性语义排除，再去查那条没坏的管道',
        statement, 'llm-rubric',
        ['metric-triage', 'field-visibility', 'null-vs-empty', 'root-cause-order',
         'modern:privacy-engineering'],
        src('数据研发（埋点与指标治理方向） 高级工程师高频追问',
            DATA + '#5 题面草稿 C（原题：缺失率 2%→40% 而超时率略降，给出定位顺序与三种结论）'
            '＋ §2 追问 4 与 TXN 核心机制 4（receiver_* 三态官方注释）'),
        language='markdown',
        rubric=[
            ('定位顺序', 3,
             '第一步必须是**分辨可见性语义**（风控占比 / 状态分布 / 字段返回比例），'
             '而不是查 ETL。顺序对了才给分'),
            ('三种结论各自可判', 4,
             '风控打标比例上升 / 订单状态分布变化 / 上游真的没传（或 ETL 丢字段），'
             '每种要给出能把另两种排除掉的判据'),
            ('修法', 2,
             '把"值"与"为什么看不见"拆成两列（DWD 层定型），禁止用空串算缺失；'
             '并给出禁止回退的机制'),
            ('两条指标的联动解释', 1,
             '审核中的单不进发货队列 ⇒ 分母/分子同时变化 ⇒ 超时率下降是同一事件的投影'),
        ],
        notes='这题专门用来筛"把指标当事实"的人。答对第一步（先看语义再看管道）就能过；'
              '能顺带把"超时率下降"解释成同一件事的，是做过口径治理的。',
        estimatedMinutes=10,
        answer="""## 参考答案

**1. 定位顺序：先语义，再管道。**
第一步**不是**查 ETL，而是把"缺失"拆开看：**风控打标占比**、
**订单状态分布**、**字段返回比例**（密文 / 空串 / 无）。
理由就在官方注释里：**待发货且未打标 ⇒ 密文；其余情况 ⇒ 空字符串**。
所以"地址取不到"绝大多数时候是**规则的正常结果**，不是数据丢失。
拿 `IS NULL`/空串直接算"缺失率"的指标，本来就在测"我有多少单不该被看见"，
只是平时没人发现 —— 风控一收紧就现出原形。

**2. 三种结论，各自的排除判据。**
- **A. 风控打标比例升高**（最常见）。判据：`risk_control_status = 1` 的占比同步升高，
  且缺失率升高幅度 ≈ 打标占比升高幅度。
  排除 B/C 的方法：把缺失率**按 reason 分桶**重算，
  若"该给却没给"（`order_status=1 AND risk=0` 且值为空）那条基本没动 ⇒ 不是 C，
  而字段返回比例（有值/空串/缺列的比例）与状态分布同步 ⇒ 不是 B。
- **B. 订单状态分布变化**（例如大促后集中发货，待发货单减少、已发货单增多）。
  判据：状态分布变了而 `risk_control_status` 占比没变；
  "不该给"里的 reason 几乎全是 `not-awaiting-shipment`。
- **C. 上游真的没传 / ETL 丢字段**。判据：`order_status=1 AND risk=0` 且**整列为 NULL**
  （注意官方语义里"没有值"的正常形态是**空串**；大面积 NULL 才是管道问题），
  并且 A、B 的分桶解释不了新增的那部分。
  这一条才是"查 ETL"的正确时机 —— 作为**第三**个假设被证实，而不是第一个被假设。

**3. 修法。** 在 **DWD** 就把一列拆成两列：`receiver_value` + `visibility_reason`
（取值 `ok / risk-hold / not-awaiting-shipment / no-column`），
并把"缺失率"重新定义为**只按 `no-column` 计算**，另出一条"合规遮蔽率"。
下游任何"缺失"指标必须引用 reason 列 —— 这条要成为**语义层的组合约束**
（不允许再对 `receiver_value` 写 `IS NULL` 出指标），否则三个月后有人建回来。
再往外一层：接口返回字段的**形态随状态变化** ⇒ ETL 的 schema 稳定 ≠ 语义稳定，
所以 DQC 要监控**返回比例分布**（密文/空串/缺列三者的占比），
而不是只监控"列在不在"。

**4. 为什么"超时率下降"是同一件事。**
审核中的单**既不进发货队列、也不进赔付/超时计算**（素材原话）。
风控打标比例升高 ⇒ 待发货的可计算分母变小，
而**恰好最容易超时的老单被挡在统计之外** ⇒ 超时率下降。
两条指标一动一静、方向相反，正是同一个原因的两个投影 ——
**看到这种"一升一降"就去查两条管道的人，会浪费两次力气；
正确反应是先怀疑它们共享的那个上游口径。**

**加分点**：主动说"缺失率"这类指标**必须自带元信息**
（今天这个数有百分之多少来自策略而不是数据），
比如并列输出 `raw_missing_pct` 与 `true_missing_pct` 加一个 `distorted` 标记 ——
那正是这题的 pyspark 版（`bd-pdd-address-missing-metric`）在做的事。"""
    )


# <<<SECTION-END>>>


if __name__ == '__main__':
    os.makedirs(OUT_DIR, exist_ok=True)
    if '--list' in sys.argv:
        for k in sorted(DRAFTS):
            print(k)
        raise SystemExit(0)
    for key, fn in sorted(DRAFTS.items()):
        path = os.path.join(OUT_DIR, f'{key}.json')
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(fn(), f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'wrote {os.path.relpath(path, ROOT)}')
    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.json'):
            json.load(open(os.path.join(OUT_DIR, name), encoding='utf-8'))
    print(f'全部 {len(DRAFTS)} 份草稿 JSON 可解析')
