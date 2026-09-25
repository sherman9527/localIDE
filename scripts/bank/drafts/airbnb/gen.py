#!/usr/bin/env python3
"""
Airbnb 方向题目草稿生成器。

取材来源：content/knowledge/hot-interviews/airbnb-*.md、content/jd-cache/airbnb-2026-09-19.json。
纪律与 apple / deepseek 两个目录一致：只挑"素材里讲了概念、但没做成可判分要求"的地方，
expected 一律由 Python 从数据集算出来，不手抄。

用法：
    python scripts/bank/drafts/airbnb/gen.py            # 生成草稿到 data/drafts-airbnb/out/
    python scripts/bank/drafts/airbnb/gen.py --list
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), *(['..'] * 4)))
OUT_DIR = os.path.join(ROOT, 'data', 'drafts-airbnb', 'out')

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
    q.update(extra)
    return q


def src(role, ref):
    return {
        'company': 'Airbnb',
        'role': role,
        'location': 'us',
        'origin': 'history',
        'jds': [],
        'era': '2026',
        'knowledgeRef': ref,
        'addedBy': 'arena-company-expansion',
    }


# =================================================================== 可订日期选择器
@draft('fe-airbnb-availability')
def q_availability_calendar():
    """expected 由 Python 按同一套区间语义算，绝不手推 —— 这题的错法就是差一天。"""

    def selectable(blocked, min_nights, max_nights, horizon):
        if min_nights <= 0:
            raise ValueError('minNights must be positive')
        if max_nights < min_nights:
            raise ValueError('maxNights must be >= minNights')
        blocked_set = set(blocked)
        out = []
        for check_in in range(horizon):
            for nights in range(min_nights, max_nights + 1):
                check_out = check_in + nights
                if check_out > horizon:
                    break                     # 再长一定越界，不必继续试
                if any(n in blocked_set for n in range(check_in, check_out)):
                    continue                  # 注意：占用的是 [check_in, check_out)
                out.append(check_in)
                break
        return out

    def expect(name, blocked, min_nights, max_nights, horizon, note=None):
        try:
            got = selectable(blocked, min_nights, max_nights, horizon)
            payload = {'name': name,
                       'input': [blocked, min_nights, max_nights, horizon],
                       'expected': got}
        except ValueError:
            payload = {'name': name,
                       'input': [blocked, min_nights, max_nights, horizon],
                       'expected': None, 'expectThrow': 'Error'}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

房源日历上那个"哪些日期能选入住"的组件，是 Airbnb 前端最容易写错的一块 ——
因为**可订性不是一个 nightly 布尔值，而是"存在一段满足规则的连续空闲块"**。

给定整段可售视界里被阻挡的夜晚、最短/最长住期，返回所有**可选作入住日**的夜晚下标。

## 契约

```ts
export function selectableCheckIns(
  blockedNights: number[],   // 被占/封存的夜晚下标（不是"日期"，就是第几晚）
  minNights: number,         // 最短住期
  maxNights: number,         // 最长住期
  horizon: number,           // 可售视界：夜晚下标 0 .. horizon-1
): number[]                  // 升序的可选入住日
```

## 规则（区间语义是判分点本身）

- 一次住宿是 **`[checkIn, checkOut)`**：入住那晚占用，**退房那晚不占用**。
  住 `n` 晚 ⇒ 占用 `checkIn .. checkIn+n-1`，`checkOut = checkIn + n`。
- 晚数 `n` 必须满足 `minNights <= n <= maxNights`。
- 占用的每一晚都不能在 `blockedNights` 里。
- `checkOut <= horizon`（不能超出可售视界 —— 视界外的日期还没放出来卖）。
- 只要**存在**一个合法的 `n`，该 `checkIn` 就可订。
- `blockedNights` 允许越界/乱序/重复的输入，不要因此崩掉。
- `minNights <= 0` 或 `maxNights < minNights` ⇒ `throw new Error(...)`（配置写错要炸在组件里，
  不要静默渲染出一个"全都不可订"的日历 —— 那会被当成房源下架）。
- `horizon <= 0` ⇒ 返回空数组。

## 这题真正考的东西

1. **只看"当晚空不空"是错的**。`minNights=2` 时，第 3 晚本身是空的，
   但如果第 4 晚被挡，从第 3 晚入住就凑不出两晚 —— 它不该可选。
   反过来，某晚被挡**不代表它不能当退房日**：住到那天早上离开，占用的只有前面几晚。
2. **退房日的 off-by-one**：把占用写成 `checkIn .. checkOut`（含退房日）会让
   "退房日恰好被下一个客人占着"的合法房源被禁用 —— 而日历上这种紧邻排期是**大多数**。
3. **尾部越界**：`checkIn` 靠近视界末尾时，短住期能住、长住期越界，
   必须"任一合法即可"而不是"最长住期合法才行"。
4. **阻挡日乱序/越界/重复**是真实输入（来自多个数据源合并），
   用数组下标直接索引会越界读，用 `Set` 才是对的形状。

不许引入第三方依赖。"""

    reference = """export function selectableCheckIns(
  blockedNights: number[],
  minNights: number,
  maxNights: number,
  horizon: number,
): number[] {
  if (minNights <= 0) throw new Error('minNights must be positive');
  if (maxNights < minNights) throw new Error('maxNights must be >= minNights');
  if (horizon <= 0) return [];

  // Set 而不是布尔数组：阻挡日可能乱序、重复、甚至落在视界之外（多源合并的常态）
  const blocked = new Set(blockedNights);
  const out: number[] = [];

  for (let checkIn = 0; checkIn < horizon; checkIn++) {
    for (let nights = minNights; nights <= maxNights; nights++) {
      const checkOut = checkIn + nights;
      if (checkOut > horizon) break;          // 再长一定越界
      let free = true;
      for (let n = checkIn; n < checkOut; n++) {   // [checkIn, checkOut)：退房日不占用
        if (blocked.has(n)) {
          free = false;
          break;
        }
      }
      if (free) {
        out.push(checkIn);
        break;                                 // 存在一段合法即可，不必要求最长住期合法
      }
    }
  }
  return out;
}"""

    naive = """export function selectableCheckIns(
  blockedNights: number[],
  minNights: number,
  maxNights: number,
  horizon: number,
): number[] {
  if (minNights <= 0) throw new Error('minNights must be positive');
  if (horizon <= 0) return [];
  const blocked = new Set(blockedNights);
  const out: number[] = [];
  for (let checkIn = 0; checkIn < horizon; checkIn++) {
    // 错法一：只看入住当晚空不空，不看能不能凑出满足住期的连续块
    // 错法二：占用区间写成闭区间，把退房日也算进去
    let free = true;
    for (let n = checkIn; n <= checkIn + minNights; n++) {
      if (n > horizon || blocked.has(n)) {
        free = false;
        break;
      }
    }
    if (free && !blocked.has(checkIn)) out.push(checkIn);
  }
  return out;
}"""

    test_file = """import { describe, expect, it } from 'vitest';
import { selectableCheckIns } from './Solution';

/**
 * 可订性判分的核心是区间语义：占用 [checkIn, checkOut)，退房日不占用。
 * 这些期望值全部由 Python 按同一套规则算过一遍再写进来（见本目录 gen.py 的 selectable()）。
 */
describe('selectableCheckIns：可订性是"存在一段合法连续块"', () => {
  it('全空日历：视界末尾两晚因住期越界而不可选', () => {
    expect(selectableCheckIns([], 2, 3, 5)).toEqual([0, 1, 2, 3]);
  });

  it('中间一晚被挡：它自己与前一晚都不能作入住日', () => {
    expect(selectableCheckIns([2], 2, 3, 5)).toEqual([0, 3]);
  });

  it('退房日那一晚不占用：阻挡日恰好是退房日时仍可订', () => {
    expect(selectableCheckIns([3], 2, 2, 5)).toEqual([0, 1]);
  });

  it('连续三晚被挡：只剩挡块之后能凑住期的日子', () => {
    expect(selectableCheckIns([1, 2, 3], 2, 2, 6)).toEqual([4]);
  });

  it('最短住期为 1 时逐晚独立判断', () => {
    expect(selectableCheckIns([2], 1, 1, 3)).toEqual([0, 1]);
  });

  it('退化：horizon 为 0 返回空数组', () => {
    expect(selectableCheckIns([], 2, 3, 0)).toEqual([]);
  });

  it('退化：阻挡日乱序、重复且越界，不许崩', () => {
    expect(selectableCheckIns([7, 2, 2, -1], 2, 2, 5)).toEqual([0, 3]);
  });

  it('非法：minNights 为 0 要抛错而不是渲染全灰日历', () => {
    expect(() => selectableCheckIns([], 0, 3, 5)).toThrow();
  });

  it('非法：maxNights 小于 minNights 要抛错', () => {
    expect(() => selectableCheckIns([], 3, 2, 5)).toThrow();
  });
});"""

    answer = """## 参考答案要点

双层循环：外层枚举入住日，内层枚举住期 `minNights..maxNights`；
占用区间是 **半开区间 `[checkIn, checkOut)`**，只要有一档住期全空闲且不出视界就可选。
`O(horizon × maxNights × maxNights)` 最坏，阻挡集合用 `Set` 所以越界/重复/乱序都天然安全。

**为什么退房日不能算占用**：真实日历上"上一位客人 12:00 退房、下一位 15:00 入住"是同一天，
如果按闭区间判定，这两个排期会互相把对方判成不可订 —— 症状是"明明有房但日历全灰"，
而数据侧完全正确。这类 off-by-one 在评审里几乎必漏，因为它在**空日历上看不出差别**，
只有阻挡日恰好落在退房位置时才暴露（用例 3 就是专门造这一条）。

**为什么"存在一段"而不是"最长住期成立"**：视界末尾必然出现"能住 2 晚但住不了 3 晚"的房源。
按最长住期判会把这几天全部禁用，转化率直接掉一截而没人会归因到日历组件。

**为什么 `Set` 而不是布尔数组**：阻挡日来自多个源（订单、房东封存、清洁排期），
合并后可能越界与重复。布尔数组遇到越界下标不会崩，只会**静默错位** —— 那比崩更难查。

**工程延伸（面试追问点）**

1. 真实系统为什么不让前端算这个？（可订性取决于**日期区间锁**与价格日历的一致性，
   前端算出来的一定与下单时校验的结果不一致 —— 正确做法是后端给"可订区间"，
   前端只做渲染。本题的价值在于让前端同学也能把区间语义写对一次。）
2. 时区与"晚"的定义？（一晚是 `[15:00, 12:00)` 这种跨日的业务窗口，不是 UTC 日历日。
   跨 DST 的房源会出现同一晚在两个"日"里，所以索引必须是"晚"而不是"日期" —— 本题正是这么设计的。）
3. 性能怎么优化？（预处理"连续空闲段"，对每段用区间判断可订入住日，`O(段数)`；
   或者反向做：从阻挡日切段后对每段做区间加。关键是别在渲染路径上跑三层循环。）
4. 长住（28 晚以上）规则不同怎么办？（那是**另一套 min/max**，按房源与日期区间配置，
   不能塞进这两个参数；正确抽象是"规则集合 + 求交"，本题的函数签名是它退化到单规则的形状。）"""

    return base(
        'frontend', 'senior',
        '可订日期选择器：可订性是"存在一段合法连续块"，而退房日那一晚不占用',
        statement, 'react-vitest',
        ['availability', 'interval-semantics', 'off-by-one', 'calendar', 'modern:marketplace-rules'],
        src('搜索与发现 / 前端平台 高级工程师',
            'content/knowledge/hot-interviews/airbnb-marketplace-booking.md §1.1'
            '（日历 + 规则 + 区间锁）；素材只描述了业务，未做成可判分契约'),
        language='typescript',
        cases=[
            expect('全空日历：视界末尾两晚因住期越界而不可选', [], 2, 3, 5,
                   note='checkIn=4 时最短两晚也要到 checkOut=6 > horizon ⇒ 不可选'),
            expect('中间一晚被挡：它自己与前一晚都不能作入住日', [2], 2, 3, 5),
            expect('退房日那一晚不占用：阻挡日恰好是退房日时仍可订', [3], 2, 2, 5,
                   note='checkIn=1 住两晚 → 占用 1、2，退房日 3 被挡不影响；闭区间实现会禁用它'),
            expect('连续三晚被挡：只剩挡块之后能凑住期的日子', [1, 2, 3], 2, 2, 6),
            expect('最短住期为 1 时逐晚独立判断', [2], 1, 1, 3),
            expect('退化：horizon 为 0 返回空数组', [], 2, 3, 0),
            expect('退化：阻挡日乱序、重复且越界，不许崩', [7, 2, 2, -1], 2, 2, 5,
                   note='越界与重复是多源合并的常态；布尔数组实现会静默错位'),
            expect('非法：minNights 为 0 要抛错而不是渲染全灰日历', [], 0, 3, 5),
            expect('非法：maxNights 小于 minNights 要抛错', [], 3, 2, 5),
        ],
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'availability.test.ts', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=24,
        answer=answer,
    )


# =================================================================== Price grid 总价重算
@draft('sql-airbnb-price-grid')
def q_price_grid():
    """所有金额由 Python 的 Decimal 按同一口径算出来（半分钱的差异必须是有意的）。"""
    from decimal import Decimal, ROUND_HALF_UP

    def money(x):
        return float(Decimal(x).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))

    # listing 7 的价格日历：06-14 是退房日，那一晚有价但**不计入**
    PRICES = {
        '2026-06-10': Decimal('100.00'),
        '2026-06-11': Decimal('120.50'),
        '2026-06-12': Decimal('99.99'),
        '2026-06-13': Decimal('250.00'),
        '2026-06-14': Decimal('999.99'),
        '2026-06-15': Decimal('180.00'),
    }
    FEES = {'cleaning': Decimal('85.00'), 'service_rate': Decimal('0.1400'), 'tax_rate': Decimal('0.1250')}

    def totals(check_in, check_out, prices=None, fees=None):
        """口径：占用 [check_in, check_out)；清洁费不随晚数摊；
        服务费基数 = 房费 + 清洁费；住宿税只对房费征；**先分项舍入再求和**。"""
        prices = PRICES if prices is None else prices
        fees = FEES if fees is None else fees
        start = date_of(check_in)
        end = date_of(check_out)
        nights = (end - start).days
        if nights <= 0:
            return None
        keys = []
        day = start
        while day < end:
            keys.append(day.isoformat())
            day += timedelta(days=1)
        if any(k not in prices for k in keys):
            return None                     # 缺价 ⇒ 不输出该行（不许按 0 计）
        lodging = sum((prices[k] for k in keys), Decimal('0.00'))
        cleaning = fees['cleaning']
        service = money((lodging + cleaning) * fees['service_rate'])
        tax = money(lodging * fees['tax_rate'])
        lodging_f, cleaning_f = float(lodging), float(cleaning)
        return [nights, lodging_f, cleaning_f, service, float(tax),
                money(Decimal(str(lodging_f)) + Decimal(str(cleaning_f))
                      + Decimal(str(service)) + Decimal(str(tax)))]

    def date_of(iso):
        from datetime import date
        y, m, d = iso.split('-')
        return date(int(y), int(m), int(d))

    from datetime import timedelta  # noqa: 供 totals() 使用

    COLUMNS = ['nights', 'lodging_subtotal', 'cleaning_fee', 'service_fee', 'occupancy_tax', 'total']

    BASE_RANGE = ('2026-06-10', '2026-06-14')

    def case(name, check_in, check_out, drop_dates=(), rates=None, note=None):
        """
        一条用例只描述一次"与基线的差异"，SQL 语句与期望值都从这里生成。

        为什么不能像上一版那样分别写 `extra_sql` 和期望值：那样模型看到的是**未变更**的数据集，
        带 DELETE/UPDATE 的用例会算出错误答案（这一版就是这么被发现的）。
        """
        prices = {k: v for k, v in PRICES.items() if k not in drop_dates}
        fees = dict(FEES)
        sql = []
        if (check_in, check_out) != BASE_RANGE:
            sql.append(f"UPDATE reservation SET check_in = DATE('{check_in}'), "
                       f"check_out = DATE('{check_out}') WHERE listing_id = 7")
        for d in drop_dates:
            sql.append(f"DELETE FROM nightly_price WHERE stay_date = DATE('{d}')")
        if rates is not None:
            fees['service_rate'], fees['tax_rate'] = Decimal(str(rates[0])), Decimal(str(rates[1]))
            sql.append("UPDATE listing_fee SET service_rate = %s, tax_rate = %s "
                       "WHERE listing_id = 7" % (f'{rates[0]:.4f}', f'{rates[1]:.4f}'))
        rows = totals(check_in, check_out, prices, fees)
        # 空结果必须是裸数组 []：mysql --batch 在 0 行时连列名都不输出，
        # 写成 {columns, rows: []} 会因为"列名不一致"永远判 fail（同 sql-mysql-0011）。
        payload = {
            'name': name,
            'input': sql,
            'expected': [] if rows is None else {
                'columns': COLUMNS, 'rows': [rows], 'orderSensitive': True},
        }
        if note:
            payload['note'] = note
        return payload

    statement = """## 基线

MySQL 8.0（判题容器 8.0.x，默认 `ONLY_FULL_GROUP_BY`）。

```
nightly_price(listing_id INT, stay_date DATE, price DECIMAL(10,2))   -- 每晚价，同一房源每天可不同
listing_fee  (listing_id INT PRIMARY KEY, cleaning_fee DECIMAL(10,2),
              service_rate DECIMAL(6,4), tax_rate DECIMAL(6,4))
reservation  (listing_id INT PRIMARY KEY, check_in DATE, check_out DATE)  -- 待报价的那一单
```

## 任务

为 `reservation` 里的这一单**重算总价**（这就是"price grid 必须重算，不能拿展示起价乘晚数"的那件事）。
输出一行，列名与顺序必须是：

```
nights, lodging_subtotal, cleaning_fee, service_fee, occupancy_tax, total
```

判题会按 `DECIMAL` 逐列比对（`570.49` 与 `570.490` 等价，但 `570.5` 不等价）。

## 口径（这些是判分点，不是建议）

1. **住宿占用的日期是 `[check_in, check_out)`**：入住当晚计价，**退房那一晚不计价**。
   `check_out - check_in` 天就是 `nights`。
2. `lodging_subtotal` = 被占用各晚价格**逐晚相加**（每晚价格可能不同）。
3. `cleaning_fee` = 房源固定清洁费，**不随晚数摊**。
4. `service_fee` = `ROUND((lodging_subtotal + cleaning_fee) * service_rate, 2)`。
5. `occupancy_tax` = `ROUND(lodging_subtotal * tax_rate, 2)` —— 住宿税**只对房费征**，
   不对清洁费与服务费征。
6. **舍入时机**：先按上面每一项各自 `ROUND(...,2)`，再把已舍入的四项相加得 `total`。
   先把未舍入的值加起来再舍，会出现 1 分钱的差异 —— 而账单必须逐项相加等于总额。
7. 只要被占用的某一晚在 `nightly_price` 里**缺价**，这一单就**不输出行**
   （不许用 `COALESCE(price, 0)` 补一个看起来合理的低价）。
8. `nights <= 0`（退房不晚于入住）同样不输出行。

只提交一条 `SELECT` / `WITH` 查询。日期从 `reservation` 表里取，不要写死。

## 这题真正考的东西

- **`MIN(price) × nights` 或"起价 × 晚数"是产品上最贵的一种错**：它正是
  "展示价与下单价差 40%"投诉的算术来源。价格日历必须逐晚取。
- **`BETWEEN check_in AND check_out` 会多算一晚**：闭区间把退房日也算进去了。
  本题数据里退房日 `2026-06-14` 故意放了一个 `999.99` 的高价，谁算进去谁露馅。
- **税基与服务费基数不是一回事**：住宿税只针对房费，服务费针对"房费+清洁费"。
  把税算到总价上是多数实现的默认行为，也是合规问题。
- **先舍后加 vs 先加后舍**：账单要能自证（分项相加等于总额），所以必须在分项处舍入。"""

    reference = """WITH booking AS (
  SELECT r.listing_id, r.check_in, r.check_out,
         DATEDIFF(r.check_out, r.check_in) AS nights,
         f.cleaning_fee, f.service_rate, f.tax_rate
  FROM reservation r
  JOIN listing_fee f ON f.listing_id = r.listing_id
  WHERE r.listing_id = 7
), lodging AS (
  SELECT b.listing_id,
         b.nights,
         b.cleaning_fee,
         b.service_rate,
         b.tax_rate,
         COUNT(p.stay_date) AS priced_nights,
         SUM(p.price)       AS lodging_subtotal
  FROM booking b
  JOIN nightly_price p ON p.listing_id = b.listing_id
    AND p.stay_date >= b.check_in
    AND p.stay_date <  b.check_out        -- [check_in, check_out)：退房日不计价
  GROUP BY b.listing_id, b.nights, b.cleaning_fee, b.service_rate, b.tax_rate
)
SELECT nights,
       lodging_subtotal,
       cleaning_fee,
       ROUND((lodging_subtotal + cleaning_fee) * service_rate, 2) AS service_fee,
       ROUND(lodging_subtotal * tax_rate, 2)                      AS occupancy_tax,
       ROUND(lodging_subtotal + cleaning_fee
             + ROUND((lodging_subtotal + cleaning_fee) * service_rate, 2)
             + ROUND(lodging_subtotal * tax_rate, 2), 2)          AS total
FROM lodging
WHERE nights > 0
  AND priced_nights = nights            -- 有任意一晚缺价 ⇒ 整单不报价（不是按 0 计）"""

    naive = """SELECT DATEDIFF(r.check_out, r.check_in)              AS nights,
       MIN(p.price) * DATEDIFF(r.check_out, r.check_in) AS lodging_subtotal,
       f.cleaning_fee * DATEDIFF(r.check_out, r.check_in) AS cleaning_fee,
       ROUND(MIN(p.price) * DATEDIFF(r.check_out, r.check_in) * f.service_rate, 2) AS service_fee,
       ROUND(MIN(p.price) * DATEDIFF(r.check_out, r.check_in) * f.tax_rate, 2)     AS occupancy_tax,
       ROUND(MIN(p.price) * DATEDIFF(r.check_out, r.check_in) * (1 + f.service_rate + f.tax_rate)
             + f.cleaning_fee * DATEDIFF(r.check_out, r.check_in), 2)              AS total
FROM reservation r
JOIN nightly_price p ON p.listing_id = r.listing_id
  AND p.stay_date BETWEEN r.check_in AND r.check_out
JOIN listing_fee f ON f.listing_id = r.listing_id
WHERE r.listing_id = 7
GROUP BY r.check_out, r.check_in, f.cleaning_fee, f.service_rate, f.tax_rate"""

    answer = """## 参考答案要点

```sql
WITH booking AS (SELECT r.*, DATEDIFF(check_out, check_in) AS nights, f.* 
                 FROM reservation r JOIN listing_fee f USING (listing_id)),
     lodging AS (SELECT b.*, COUNT(p.stay_date) AS priced_nights, SUM(p.price) AS lodging_subtotal
                 FROM booking b JOIN nightly_price p
                   ON p.stay_date >= b.check_in AND p.stay_date < b.check_out   -- 半开区间
                 GROUP BY ...)
SELECT nights, lodging_subtotal, cleaning_fee,
       ROUND((lodging_subtotal + cleaning_fee) * service_rate, 2) AS service_fee,
       ROUND(lodging_subtotal * tax_rate, 2) AS occupancy_tax,
       ROUND(lodging_subtotal + cleaning_fee
             + ROUND((lodging_subtotal + cleaning_fee) * service_rate, 2)
             + ROUND(lodging_subtotal * tax_rate, 2), 2) AS total
FROM lodging WHERE nights > 0 AND priced_nights = nights;
```

**基线手算一遍（用来核对 expected 是不是真的对）**：占用 06-10..06-13 四晚
⇒ `lodging = 100.00 + 120.50 + 99.99 + 250.00 = 570.49`；
`service = (570.49 + 85.00) × 0.14 = 91.7686 → 91.77`；
`tax = 570.49 × 0.125 = 71.31125 → 71.31`；
`total = 570.49 + 85.00 + 91.77 + 71.31 = 818.57`。
退房日 `06-14` 的 `999.99` 没被算进来 —— 一旦用 `BETWEEN` 就变成 `1570.48` 起跳。

**四个判分点各自的错法**

1. **`MIN(price) × nights`**：这是"起价 × 晚数"式报价，与逐晚真实和差多少完全随机
   （本题差 `570.49 − 399.96 = 170.53`）。它也是监管点名的"展示价 ≠ 下单价"来源。
2. **闭区间**：退房日那一晚在真实数据里几乎总是有价的（下一位客人要住），
   所以这个错**不会**在测试数据上暴露成"缺行"，只会暴露成"多收一晚"。
3. **清洁费按晚摊**：住 4 晚收 4 次清洁费，是报价里最容易看漏的放大器。
4. **`priced_nights = nights` 这个守卫**：用 `LEFT JOIN + COALESCE(price,0)` 的实现
   会在缺价时给出一个"看起来对但偏低"的总价 —— 而报价偏低在下单时才会被发现，
   那时已经变成客诉。缺价必须**不出价**，让上游去补数据。

**工程延伸（面试追问点）**

1. 为什么"先舍后加"？（账单要能自证：分项相加必须等于总额。先加后舍会让
   `total ≠ Σ 分项`，对账系统每天报差异，最后只能靠容差掩盖真问题。）
2. 折扣/长住优惠/币种怎么进来？（都是"定价管线"的一环：先算逐晚价 → 应用规则 → 再算费用与税。
   关键是**舍入只发生在管线末端一次**，中间步骤保持高精度，否则误差会随规则数累积。）
3. 缓存这个结果吗？（Airbnb 的报价缓存必须把"价格日历版本 + 费率版本"一起做成缓存键，
   否则费率变更后旧报价继续被复用 —— 这正是 sys-design 那道报价缓存题的落点。）
4. 多房源/多房型？（`nightly_price` 加 `room_type_id`，但"退房日不计价"与税基口径不变；
   口径类规则一定要收在一处实现，双边市场最怕的是房东端与房客端各算一遍。）"""

    return base(
        'sql', 'senior',
        'Price grid 总价重算：退房日不计价、清洁费不摊、税基只有房费、先舍后加',
        statement, 'mysql',
        ['pricing', 'decimal-rounding', 'half-open-interval', 'tax-base', 'modern:marketplace-integrity'],
        src('房东体验 / 定价与可用性 高级工程师',
            'content/knowledge/hot-interviews/airbnb-marketplace-booking.md §1.2 展示价链条'
            '（"总价必须等于逐晚之和"）；素材只描述了链路，未做成可判分口径'),
        language='sql',
        cases=[
            case('基线：四晚逐晚相加，退房日那晚的 999.99 不算进来',
                 '2026-06-10', '2026-06-14',
                 note='lodging 570.49 / service 91.77 / tax 71.31 / total 818.57'),
            case('两晚短住：清洁费仍只收一次', '2026-06-11', '2026-06-13',
                 note='lodging 220.49，清洁费不因晚数变化'),
            case('单晚：服务费的基数含清洁费', '2026-06-12', '2026-06-13'),
            case('缺价的一晚：整单不报价，而不是按 0 补上', '2026-06-13', '2026-06-16',
                 drop_dates=['2026-06-15'],
                 note='06-15 被删 ⇒ 占用区间缺价 ⇒ 0 行；LEFT JOIN+COALESCE 会给出偏低总价'),
            case('退房日不晚于入住：不输出行', '2026-06-14', '2026-06-14'),
            case('费率改成 0：只剩房费与清洁费', '2026-06-10', '2026-06-14',
                 rates=(0, 0),
                 note='service 与 tax 都归 0，total = 570.49 + 85.00 = 655.49'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS nightly_price',
                'DROP TABLE IF EXISTS listing_fee',
                'DROP TABLE IF EXISTS reservation',
                'CREATE TABLE nightly_price (listing_id INT NOT NULL, stay_date DATE NOT NULL, '
                'price DECIMAL(10,2) NOT NULL, PRIMARY KEY (listing_id, stay_date)) '
                'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4',
                'CREATE TABLE listing_fee (listing_id INT PRIMARY KEY, cleaning_fee DECIMAL(10,2) NOT NULL, '
                'service_rate DECIMAL(6,4) NOT NULL, tax_rate DECIMAL(6,4) NOT NULL) ENGINE=InnoDB',
                'CREATE TABLE reservation (listing_id INT PRIMARY KEY, check_in DATE NOT NULL, '
                'check_out DATE NOT NULL) ENGINE=InnoDB',
                'INSERT INTO nightly_price (listing_id, stay_date, price) VALUES '
                + ', '.join(f"(7, DATE('{d}'), {p})" for d, p in PRICES.items()),
                "INSERT INTO listing_fee VALUES (7, 85.00, 0.1400, 0.1250)",
                "INSERT INTO reservation VALUES (7, DATE('2026-06-10'), DATE('2026-06-14'))",
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== 预订闸门的区间锁
@draft('alg-airbnb-booking-gate')
def q_booking_gate():
    """区间锁状态机：expected 全部由 replay() 跑出来，不手推。"""

    def replay(now, ops, froms, tos, reqs, args):
        LOCK, RELEASE, COMMIT = 0, 1, 2
        n = len(now)
        if n == 0:
            if any(len(x) for x in (ops, froms, tos, reqs, args)):
                raise ValueError('length mismatch')
            return []
        if any(len(x) != n for x in (ops, froms, tos, reqs, args)):
            raise ValueError('length mismatch')
        locks = []      # 每项 [reqId, from, to, expirySec]
        booked = []     # 每项 [reqId, from, to]
        last_token = [0]

        def hit(a, b, c, d):
            return a < d and c < b       # 半开区间重叠

        out = []
        for i in range(n):
            t = now[i]
            if i and t < now[i - 1]:
                raise ValueError('time must be non-decreasing')
            op, f, to, r, a = ops[i], froms[i], tos[i], reqs[i], args[i]
            if r <= 0:
                raise ValueError('reqId must be positive')
            if f >= to:
                raise ValueError('empty date range')
            if op not in (LOCK, RELEASE, COMMIT):
                raise ValueError('unknown op')
            # 到期判定先做：expiry == t 的锁在这一刻已经不成立了
            locks[:] = [l for l in locks if l[3] > t]

            if op == LOCK:
                if a <= 0:
                    raise ValueError('ttl must be positive')
                own = [k for k, l in enumerate(locks) if l[0] == r and hit(l[1], l[2], f, to)]
                if own:                                   # 重入：不新建，只续期
                    for k in own:
                        locks[k][3] = t + a
                    out.append(1)
                    continue
                if any(hit(l[1], l[2], f, to) for l in locks):
                    out.append(0)
                    continue
                if any(hit(b[1], b[2], f, to) for b in booked):
                    out.append(0)                         # 已经成交的区间永久挡住新锁
                    continue
                locks.append([r, f, to, t + a])
                out.append(1)
            elif op == RELEASE:
                if a != 0:
                    raise ValueError('RELEASE takes no arg')
                keep = [l for l in locks if not (l[0] == r and hit(l[1], l[2], f, to))]
                out.append(1 if len(keep) < len(locks) else 0)
                locks[:] = keep
            else:
                if a < 0:
                    raise ValueError('token must be >= 0')
                covers = any(l[0] == r and l[1] <= f and to <= l[2] for l in locks)
                if not covers or a <= last_token[0]:
                    out.append(0)                         # 纯失败：不成交也不释放锁
                    continue
                booked.append([r, f, to])
                locks[:] = [l for l in locks if not (l[0] == r and hit(l[1], l[2], f, to))]
                last_token[0] = a
                out.append(1)
        return out

    def case(name, now, ops, froms, tos, reqs, args, throws=False, note=None):
        """
        `throws` 是**声明**而不是推断：上一版让 expected 默默跟着模型走，
        于是"非法：RELEASE 带了 arg"这条实际发的是 LOCK 并且成功返回 ——
        名字与内容已经对不上，闸门却还是绿的。声明不一致就直接炸在生成期。
        """
        try:
            got = replay(now, ops, froms, tos, reqs, args)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [now, ops, froms, tos, reqs, args],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [now, ops, froms, tos, reqs, args],
                       'expected': got}
        if note:
            payload['note'] = note
        return payload

    L, R, C = 0, 1, 2

    statement = """## 背景

旺季某城市出现超卖：同一个 `[入住, 退房)` 被两单占用。事后复盘发现写路径是
**"先查可订 → 再创建预订"**，两步之间没有任何约束 —— 这是 TOCTOU 竞态的教科书形状。
修复方向也是教科书的两句话：

> **锁只是降低失败率的手段，正确性必须落在存储侧的约束上。**

本题就考这两句话：你要实现一个单 listing 日历上的**区间锁 + 提交闸门**，
按顺序重放一串操作，返回每个操作的成功/失败（`1` / `0`）。

## 你要实现的入口

```java
public static int[] replay(long[] nowSec, int[] op, int[] fromDay, int[] toDay,
                           int[] reqId, int[] arg)
```

六个数组**按下标对齐**，`op` 取值：

| op | 含义 | `arg` |
| --- | --- | --- |
| `0` LOCK | 尝试锁住 `[fromDay, toDay)` | 租约秒数，必须 `> 0` |
| `1` RELEASE | 释放 `[fromDay, toDay)` 上自己持有的锁 | 必须 `0` |
| `2` COMMIT | 用 `arg` 作为 fencing token 提交这一单 | token，`>= 0` |

日期是"第几天"的整数下标，区间一律 **`[fromDay, toDay)` 半开**：
`[10,15)` 与 `[15,20)` **不**重叠，`[10,15)` 与 `[14,16)` 重叠。

## 闸门规则（逐条都是判分点）

1. **处理第 i 个操作之前**，先丢弃所有 `expiry <= nowSec[i]` 的锁。
   也就是说"恰好在这一刻到期"的锁**已经不算持有**。
2. **LOCK**：
   - 若本 `reqId` 已经持有一把与请求区间**重叠**的活锁 ⇒ **重入**：不新建锁，
     而是把本方所有重叠锁的到期时刻续到 `nowSec + arg`，返回 `1`；
   - 否则若**任何人**的活锁与之重叠 ⇒ `0`；
   - 否则若与之重叠的区间里**已有成交**（committed booking）⇒ `0`（成交永久挡住新锁）；
   - 否则登记一把新锁，到期时刻 `nowSec + arg`，返回 `1`。
3. **RELEASE** 只准摘掉**本 `reqId` 自己**的锁：删除本方所有与请求区间重叠的活锁；
   删掉了至少一把返回 `1`，一把都没删（例如区间里只有别人的锁）返回 `0`。
   **任何情况下都不许动别人的锁，也不许动已成交的预订。**
4. **COMMIT** 要同时满足两条才成功：
   - 本 `reqId` 持有**一把**活锁**完整覆盖** `[fromDay, toDay)`
     （`lock.from <= fromDay && toDay <= lock.to`）—— 两把相邻的锁**不算**覆盖；
   - `arg` **严格大于**历史上已经提交过的最大 token（初始最大 token 视为 `0`）。
   成功时：登记成交、摘掉本方所有与它重叠的活锁、把最大 token 更新为 `arg`、返回 `1`。
   失败时：**什么都没发生** —— 不登记成交、不释放锁、不更新 token，返回 `0`。
5. 输入非法一律抛 `IllegalArgumentException`：数组长度不一致、`nowSec` 逆序、
   `reqId <= 0`、`fromDay >= toDay`（空区间是调用方的 bug，不是"锁不住任何一天"）、
   未知 `op`、LOCK 的 `arg <= 0`、RELEASE 的 `arg != 0`、COMMIT 的 `arg < 0`。
   六个数组都为空 ⇒ 返回空数组。

## 这题真正考的东西

- **"先查再写"不是解法**：本题没有查询接口，一切判定都必须在写的那一刻做出结论。
- **锁的归属**：`RELEASE` 不带 owner 校验，就是把别人的锁删掉 —— 而它**不会报错**，
  只会让超卖照旧发生、监控上锁一切正常。
- **fencing token 不是可选装饰**：只判"锁还在不在"，挡不住
  "一个进程在锁里 GC 停顿、租约到期、别人接手成交之后它才醒来提交"。
- **提交失败必须是纯失败**：顺手把锁释放掉的实现，会把重试方永久挡在门外。

不许引入第三方依赖。"""

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  private static final int LOCK = 0, RELEASE = 1, COMMIT = 2;

  public static int[] replay(long[] nowSec, int[] op, int[] fromDay, int[] toDay,
                             int[] reqId, int[] arg) {
    int n = nowSec.length;
    if (n != op.length || n != fromDay.length || n != toDay.length
        || n != reqId.length || n != arg.length) {
      throw new IllegalArgumentException("length mismatch");
    }
    List<long[]> locks = new ArrayList<>();   // {reqId, from, to, expiry}
    List<long[]> booked = new ArrayList<>();  // {reqId, from, to}
    long maxToken = 0;
    int[] out = new int[n];

    for (int i = 0; i < n; i++) {
      long t = nowSec[i];
      int kind = op[i], from = fromDay[i], to = toDay[i], req = reqId[i], a = arg[i];
      if (i > 0 && t < nowSec[i - 1]) throw new IllegalArgumentException("time goes backwards");
      if (req <= 0) throw new IllegalArgumentException("reqId must be positive");
      if (from >= to) throw new IllegalArgumentException("empty date range");
      if (kind != LOCK && kind != RELEASE && kind != COMMIT) {
        throw new IllegalArgumentException("unknown op: " + kind);
      }

      // 到期先处理：expiry == t 的锁已经不成立了
      locks.removeIf(l -> l[3] <= t);

      if (kind == LOCK) {
        if (a <= 0) throw new IllegalArgumentException("ttl must be positive");
        boolean own = false;
        for (long[] l : locks) {
          if (l[0] == req && overlaps(l[1], l[2], from, to)) {
            l[3] = t + a;                     // 重入：只续期，不新建
            own = true;
          }
        }
        if (own) {
          out[i] = 1;
          continue;
        }
        for (long[] l : locks) {
          if (overlaps(l[1], l[2], from, to)) {
            out[i] = 0;
            own = true;                        // 复用 own 当"已被拒"的标记
            break;
          }
        }
        if (own) continue;
        for (long[] b : booked) {
          if (overlaps(b[1], b[2], from, to)) {
            out[i] = 0;
            own = true;
            break;
          }
        }
        if (own) continue;
        locks.add(new long[] {req, from, to, t + a});
        out[i] = 1;
      } else if (kind == RELEASE) {
        if (a != 0) throw new IllegalArgumentException("RELEASE takes no arg");
        int before = locks.size();
        locks.removeIf(l -> l[0] == req && overlaps(l[1], l[2], from, to));
        out[i] = locks.size() < before ? 1 : 0;
      } else {
        if (a < 0) throw new IllegalArgumentException("token must be >= 0");
        boolean covered = false;
        for (long[] l : locks) {
          if (l[0] == req && l[1] <= from && to <= l[2]) {
            covered = true;
            break;
          }
        }
        if (!covered || a <= maxToken) {
          out[i] = 0;                          // 纯失败：不登记、不释放、不改 token
          continue;
        }
        booked.add(new long[] {req, from, to});
        locks.removeIf(l -> l[0] == req && overlaps(l[1], l[2], from, to));
        maxToken = a;
        out[i] = 1;
      }
    }
    return out;
  }

  /** 半开区间重叠：[aFrom,aTo) 与 [bFrom,bTo)。 */
  private static boolean overlaps(long aFrom, long aTo, int bFrom, int bTo) {
    return aFrom < bTo && bFrom < aTo;
  }
}"""

    naive = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  // 上线前那一版：锁只看区间、释放只看区间、提交只看"锁还在不在"
  public static int[] replay(long[] nowSec, int[] op, int[] fromDay, int[] toDay,
                             int[] reqId, int[] arg) {
    int n = nowSec.length;
    if (n != op.length || n != fromDay.length || n != toDay.length
        || n != reqId.length || n != arg.length) {
      throw new IllegalArgumentException("length mismatch");
    }
    List<long[]> locks = new ArrayList<>();
    List<long[]> booked = new ArrayList<>();
    int[] out = new int[n];

    for (int i = 0; i < n; i++) {
      long t = nowSec[i];
      int from = fromDay[i], to = toDay[i], req = reqId[i], a = arg[i];
      if (req <= 0) throw new IllegalArgumentException("reqId must be positive");
      if (from >= to) throw new IllegalArgumentException("empty date range");
      if (a < 0) throw new IllegalArgumentException("negative arg");
      locks.removeIf(l -> l[3] < t);            // 错 0：用 < 而不是 <=，到期那一刻还当作持有

      if (op[i] == 0) {
        boolean blocked = false;
        for (long[] l : locks) {
          if (l[0] != req && l[1] < to && from < l[2]) {
            blocked = true;
            break;
          }
        }
        for (long[] b : booked) {
          if (b[1] < to && from < b[2]) {
            blocked = true;
            break;
          }
        }
        out[i] = blocked ? 0 : 1;
        if (!blocked) locks.add(new long[] {req, from, to, t + a});   // 错 1：重入也再登记一把
      } else if (op[i] == 1) {
        int before = locks.size();
        locks.removeIf(l -> l[1] < to && from < l[2]);                 // 错 2：不看 owner
        out[i] = locks.size() < before ? 1 : 0;
      } else {
        boolean held = false;
        for (long[] l : locks) {
          if (l[0] == req && l[1] < to && from < l[2]) {
            held = true;
            break;
          }
        }
        boolean overlapsBooking = false;
        for (long[] b : booked) {
          if (b[1] < to && from < b[2]) {
            overlapsBooking = true;
            break;
          }
        }
        out[i] = held && !overlapsBooking ? 1 : 0;                     // 错 3：完全不比 token
        if (held) {
          booked.add(new long[] {req, from, to});
          locks.removeIf(l -> l[1] < to && from < l[2]);
        }
      }
    }
    return out;
  }
}"""

    answer = """## 参考答案要点

三份状态：活锁表 `[(reqId, from, to, expiry)]`、成交表 `[(reqId, from, to)]`、
以及"已提交过的最大 token"。每个操作先做**到期回收**（`expiry <= t` 就没了），
再按 op 走条件写。核心子程序只有一个：半开区间重叠判定
`aFrom < bTo && bFrom < aTo` —— 全部三条规则都建立在它上面。

**为什么"到期 == 此刻"必须算已失效**：锁的持有区间是 `[取得时刻, 取得时刻+ttl)`，
和预订占用日期一样是半开的。写成 `expiry < t` 的实现，在"租约正好走完"那一毫秒
会让前一个持有者以为自己还在锁里 —— 而真实事故里 GC 停顿、网络重传消耗掉的
恰好就是这点余量。用例「租约正好到期：旧主提交失败，新主能锁能成交」打的就是这一条。

**`RELEASE` 不校验 owner 的后果**（用例「释放只动自己的锁：删不掉别人的，返回 0」）：
按区间删除时，`[20,25)` 上属于别人的锁会被一起摘掉。线上表现是
"两个人都以为自己有锁"，而锁的**存在性指标完全正常**。
所以 `RELEASE` 的语义必须是"本方的、重叠的、活锁"三个条件同时成立才删，
一把都没删到就返回 `0`（这是调用方该报警的信号，不是可以忽略的失败）。

**fencing token 挡的是哪一种事故**（用例「token 不增就被拒，而且失败必须是纯失败」）：
经典时序是 —— 进程 A 拿到锁 → 进入长时间停顿 → 租约到期 → 进程 B 拿锁并成交（token 9）
→ A 醒来，它"手里有锁"的内存快照还在，于是提交 token 4。
只有"锁还在"这个条件是挡不住的，因为 A 检查的锁早已被 B 换掉了；
必须要求 **token 严格大于已提交的最大值**。
另外这条用例还检查一件事：提交被拒之后 A 的锁**不许被顺手释放** ——
否则重试方 A 再试时连锁都没了，会被 B 之后的请求永久挡在外面。

**重入为什么不新建锁**（用例「重入续期不新建：别人进不来」）：
如果同一方对同一区间登记了两把锁，`RELEASE` 只摘掉重叠的一把
（其实两把都摘，但 `COMMIT` 之后残留的语义就乱了），而"我到底还持不持有"
在日志里变成两行。重入的正确形状是**原地续期**，永远让一方在一个区间上最多一把锁。

**两把相邻的锁不算覆盖**（用例「相邻两把锁不能合并提交」）：
`[10,12)` 与 `[12,15)` 合起来确实覆盖了 `[10,15)`，但本题**故意**不认。
理由是可解释性：一把锁对应一段租约，两把锁的到期时刻可以差很远，
"合并提交"等价于用两个短租约换一次长占用，这让"锁什么时候失效"变成不可回答的问题。
要提交 `[10,15)` 就先去锁 `[10,15)`。真实系统里这条通常表述为
**"一次预订 = 一次锁定 = 一次提交"，禁止拼装**。

**工程延伸（面试追问点）**

1. 为什么这题仍然"不是正确性来源"？（整个过程假设单实例、按序重放。真集群里
   `nowSec` 来自各机器时钟、`maxToken` 要在存储侧原子递增 —— 所以最终仍需
   `listing_occupancy(listing_id, stay_date)` 的主键约束做兜底，
   锁与 token 只是把冲突提前暴露、把失败率压下来。）
2. `COMMIT` 为什么要顺手释放自己的锁？（成交之后锁已经没有意义，留着会挡住改期路径。
   但"释放锁"和"登记成交"必须是**一个原子动作** —— 中间断开就会出现"已成交但没有占用记录"。）
3. 取消/改期怎么进这套状态？（改期是"新区间先 COMMIT 成功，再释放旧区间的占用"，
   顺序反了就会两边都没房；这需要第四种操作 `REPLACE`，并且它的失败路径要能补偿 —— 这就是 1.1 里说的组合状态。）
4. 提前预订窗口、最小住期这些规则放哪？（**放在 LOCK 之前**，作为"请求合法性"检查，
   不要混进闸门：闸门只管并发正确性，规则管业务许可。混在一起的代价是规则一改就要重放全部并发用例。）"""

    return base(
        'algorithms', 'senior',
        '预订闸门：区间锁的归属、租约到期与 fencing token',
        statement, 'java-junit',
        ['interval-lock', 'fencing-token', 'toctou', 'half-open-interval',
         'modern:marketplace-integrity'],
        src('Booking / Marketplace Integrity 高级工程师',
            'content/knowledge/hot-interviews/airbnb-marketplace-booking.md §1.1、§4 题面草稿 A'
            '（素材给了"锁不是正确性来源"的结论与操作清单，未做成可判分状态机）'),
        language='java',
        cases=[
            case('基线：不重叠可并行，重叠即互斥',
                 [0, 0, 0], [L, L, L], [10, 15, 12], [15, 20, 16], [1, 1, 2], [100, 100, 100],
                 note='[10,15) 与 [15,20) 半开不相交；r2 的 [12,16) 撞 r1'),
            case('重入续期不新建：别人进不来',
                 [0, 0, 50, 70], [L, L, L, L],
                 [10, 10, 10, 10], [15, 15, 15, 15], [1, 1, 1, 2], [60, 60, 60, 60],
                 note='第 3 条把到期推到 110 ⇒ 70 时刻 r2 仍被挡（不续期的话 60 就放开了）'),
            case('租约正好到期：旧主提交失败，新主能锁能成交',
                 [0, 100, 100, 100], [L, C, L, C],
                 [10, 10, 10, 10], [15, 15, 15, 15], [1, 1, 2, 2], [100, 7, 100, 9],
                 note='expiry==100 ⇒ r1 在 100 时刻已经不算持有；用 < 的实现这里会给 1'),
            case('释放只动自己的锁：删不掉别人的，返回 0',
                 [0, 0, 0, 0, 0], [L, L, R, R, C],
                 [10, 20, 20, 10, 20], [15, 25, 25, 15, 25], [1, 2, 1, 1, 2], [100, 100, 0, 0, 4],
                 note='第 3 条 r1 去删 r2 的 [20,25) ⇒ 0，且 r2 随后仍能成交'),
            case('token 不增就被拒，而且失败必须是纯失败',
                 [0, 0, 0, 0, 5], [L, L, C, C, C],
                 [10, 20, 10, 20, 20], [15, 25, 15, 25, 25], [1, 2, 1, 2, 2], [100, 100, 9, 4, 11],
                 note='r2 用 token 4 提交失败（最大已是 9），锁留着 ⇒ 第二次用 11 还能成功'),
            case('已成交的区间永久挡住新锁',
                 [0, 0, 5, 5], [L, C, L, L],
                 [10, 10, 10, 20], [15, 15, 12, 25], [1, 1, 2, 3], [100, 3, 100, 100],
                 note='r2 想锁 [10,12) 撞已成交 ⇒ 0；r3 的 [20,25) 不受影响 ⇒ 1'),
            case('相邻两把锁不能合并提交',
                 [0, 0, 5], [L, L, C], [10, 12, 10], [12, 15, 15], [1, 1, 1], [100, 100, 3],
                 note='必须是"一把锁完整覆盖"，否则"锁什么时候失效"无法回答'),
            case('释放之后不许再提交',
                 [0, 0, 1], [L, R, C], [10, 10, 10], [15, 15, 15], [1, 1, 1], [100, 0, 3],
                 note='锁是提交资格的来源之一；删了就是放弃了这一单'),
            case('退化：没有任何操作', [], [], [], [], [], []),
            case('非法：数组长度不一致', [0, 1], [L], [10], [15], [1], [100], throws=True),
            case('非法：时间倒流', [10, 5], [L, L], [10, 10], [15, 15], [1, 1], [100, 100],
                 throws=True),
            case('非法：空日期区间', [0], [L], [15], [15], [1], [100], throws=True,
                 note='from>=to 是调用方 bug，不是"锁不住任何一天"'),
            case('非法：LOCK 的 ttl 为 0', [0], [L], [10], [15], [1], [0], throws=True),
            case('非法：RELEASE 带了 arg', [0], [R], [10], [15], [1], [100], throws=True,
                 note='RELEASE 没有参数位 —— 传了数说明调用方理解错了协议'),
            case('非法：未知 op', [0], [7], [10], [15], [1], [100], throws=True),
            case('非法：reqId 为 0', [0], [L], [10], [15], [0], [100], throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] replay(long[] nowSec, int[] op, int[] fromDay, int[] toDay, '
                             'int[] reqId, int[] arg)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=32,
        answer=answer,
    )


# =================================================================== 搜索转化率的两种口径
@draft('sql-airbnb-conversion-definitions')
def q_conversion_two_definitions():
    """
    数据集只在这里声明一次：INSERT 语句与 expected 都从同一份行集生成。
    上一版把 SQL 和期望值分开写，带 DELETE 的用例立刻算错（price-grid 那题就是这么暴露的），
    所以这里所有变异都走 apply_mutation()，绝不允许第二份事实。
    """
    from decimal import Decimal, ROUND_HALF_UP

    SESSIONS = [
        # session_id, user_id, started_at, query_cat
        (1, 1, '2026-07-01 10:00:00', 'city'),
        (2, 2, '2026-07-01 11:00:00', 'city'),
        (3, 3, '2026-07-01 12:00:00', 'city'),
        (4, 4, '2026-07-01 13:00:00', 'city'),
        (10, 10, '2026-07-01 14:00:00', 'city'),
        (5, 5, '2026-07-01 10:00:00', 'beach'),
        (6, 6, '2026-07-01 10:00:00', 'beach'),
        (7, 7, '2026-07-01 11:00:00', 'beach'),
        (8, 8, '2026-07-01 09:00:00', 'new'),
        (9, 9, '2026-07-01 09:00:00', 'new'),
    ]
    CLICKS = [
        # click_id, session_id, listing_id, clicked_at, position
        (1, 1, 101, '2026-07-01 10:01:00', 3),
        (2, 1, 102, '2026-07-01 10:02:00', 1),
        (3, 1, 103, '2026-07-01 10:05:00', 2),
        (4, 2, 201, '2026-07-01 11:01:00', 5),
        (5, 2, 202, '2026-07-01 11:03:00', 2),
        (6, 3, 301, '2026-07-01 12:01:00', 1),
        (7, 5, 501, '2026-07-01 10:31:00', 2),
        (8, 5, 502, '2026-07-01 10:31:00', 1),
        (9, 6, 601, '2026-07-01 10:35:00', 4),
        (10, 6, 601, '2026-07-01 10:36:00', 4),
        (11, 7, 701, '2026-07-01 11:01:00', 1),
        (12, 9, 901, '2026-07-01 09:31:00', 2),
        (13, 10, 1001, '2026-07-01 14:01:00', 1),
        (14, 10, 1002, '2026-07-01 14:02:00', 2),
        (15, 10, 1001, '2026-07-01 14:03:00', 1),
    ]
    BOOKINGS = [
        # booking_id, session_id, listing_id, booked_at, gmv
        (1, 1, 103, '2026-07-01 10:10:00', Decimal('200.00')),
        (2, 2, 201, '2026-07-01 11:10:00', Decimal('150.00')),
        (3, 3, 301, '2026-07-01 12:05:00', Decimal('99.00')),
        (4, 3, 301, '2026-07-01 12:06:00', Decimal('99.00')),
        (5, 4, 404, '2026-07-01 13:20:00', Decimal('300.00')),
        (6, 5, 502, '2026-07-01 10:40:00', Decimal('120.00')),
        (7, 6, 601, '2026-07-01 10:50:00', Decimal('80.00')),
        (8, 8, 701, '2026-07-01 09:40:00', Decimal('60.00')),
        (9, 9, 901, '2026-07-01 09:35:00', Decimal('45.00')),
        (10, 10, 1002, '2026-07-01 14:10:00', Decimal('500.00')),
    ]

    TABLES = {
        'session': ('search_session', ('session_id', 'user_id', 'started_at', 'query_cat'), SESSIONS),
        'click': ('search_click', ('click_id', 'session_id', 'listing_id', 'clicked_at', 'position'), CLICKS),
        'booking': ('booking', ('booking_id', 'session_id', 'listing_id', 'booked_at', 'gmv'), BOOKINGS),
    }

    def sql_literal(v):
        """**唯一**的"Python 值 → MySQL 字面量"口径。DATETIME 用普通字符串字面量：
        MySQL 里没有 `DATETIME('...')` 这种构造（第一版就是这么写的，setup 直接语法报错）。"""
        if isinstance(v, Decimal):
            return str(v)
        if isinstance(v, bool):
            return '1' if v else '0'
        if isinstance(v, int):
            return str(v)
        return f"'{v}'"

    def row_literal(r):
        return '(' + ', '.join(sql_literal(v) for v in r) + ')'

    def insert_all(table_key):
        table, cols, rows = TABLES[table_key]
        head = f'INSERT INTO {table} ({", ".join(cols)}) VALUES '
        return head + ', '.join(row_literal(r) for r in rows)

    def apply_mutation(rows, kind, table_key, payload):
        """变异只有一种表示法：先改内存行集，再由同一份行集生成 SQL 与期望值。"""
        _, cols, _ = TABLES[table_key]
        target = rows[table_key]
        if kind == 'del':
            target[:] = [r for r in target if r[0] != payload]
            return f"DELETE FROM {TABLES[table_key][0]} WHERE {cols[0]} = {payload}"
        if kind == 'ins':
            target.append(payload)
            return (f"INSERT INTO {TABLES[table_key][0]} ({', '.join(cols)}) VALUES "
                    f"{row_literal(payload)}")
        pk, col, value = payload
        idx = cols.index(col)
        target[:] = [r[:idx] + (value,) + r[idx + 1:] if r[0] == pk else r for r in target]
        return (f"UPDATE {TABLES[table_key][0]} SET {col} = {sql_literal(value)} "
                f"WHERE {cols[0]} = {pk}")

    def q4(n, total):
        """与 MySQL 的 ROUND(x, 4) 对齐：四舍五入（half-up），不是 Python 默认的 half-even。"""
        return float((Decimal(n) / Decimal(total)).quantize(Decimal('0.0001'),
                                                            rounding=ROUND_HALF_UP))

    def rates(rows):
        """口径实现：分子按**会话**去重，最后一次点击的并列按 position 最小破。"""
        per_cat = {}
        for sid, _user, _started, cat in rows['session']:
            clicks = [c for c in rows['click'] if c[1] == sid]
            books = [b for b in rows['booking'] if b[1] == sid]
            bucket = per_cat.setdefault(cat, [0, 0, 0])
            bucket[0] += 1                                     # 分母 = 会话数
            if clicks and books:
                bucket[1] += 1                                 # 口径 A：有点击且有预订，记 1 个会话
                latest = max((c[3] for c in clicks))
                best_pos = min(c[4] for c in clicks if c[3] == latest)
                last_listing = min(c[2] for c in clicks
                                   if c[3] == latest and c[4] == best_pos)
                if last_listing in {b[2] for b in books}:
                    bucket[2] += 1                             # 口径 B：订的正是最后看的那个
        return [[cat, q4(any_c, total), q4(last_c, total)]
                for cat, (total, any_c, last_c) in sorted(per_cat.items())]

    COLUMNS = ['query_cat', 'conv_click_any', 'conv_last_viewed']

    def case(name, mutations=(), note=None):
        rows = {k: list(v[2]) for k, v in TABLES.items()}
        sql = []
        for kind, table_key, payload in mutations:
            sql.append(apply_mutation(rows, kind, table_key, payload))
        payload_case = {
            'name': name, 'input': sql,
            'expected': {'columns': COLUMNS, 'rows': rates(rows), 'orderSensitive': True},
        }
        if note:
            payload_case['note'] = note
        return payload_case

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。一个搜索会话可以有很多次点击、零到多笔预订：

```
search_session(session_id INT PRIMARY KEY, user_id INT, started_at DATETIME, query_cat VARCHAR(20))
search_click (click_id INT PRIMARY KEY, session_id INT, listing_id INT,
              clicked_at DATETIME, position INT)      -- position = 结果页上的位次
booking      (booking_id INT PRIMARY KEY, session_id INT, listing_id INT,
              booked_at DATETIME, gmv DECIMAL(10,2))  -- session_id = 成交**所在**的会话
```

## 任务

按 `query_cat` 输出**两种口径**的搜索→预订转化率，三列且列名顺序必须是：

```
query_cat, conv_click_any, conv_last_viewed
```

两列都是 `[0,1]` 的小数，`ROUND(..., 4)`，按 `query_cat` 升序。只交一条 `SELECT` / `WITH` 查询。

## 口径（这些是判分点，不是建议）

1. **分母永远是该类别的会话数**，含那些"没有点击"和"没有预订"的会话。
2. **口径 A `conv_click_any`**：该会话内**至少一次点击** 且 该会话内**至少一笔预订**
   ⇒ 这个会话计 **1**（不是计预订数、也不是计点击数）。
3. **口径 B `conv_last_viewed`**：该会话**最后一次点击**的那个 `listing_id`
   出现在该会话的预订里 ⇒ 计 1。
   这是 KDD'18 那个 "book the last viewed listing" 的代理目标，用来区分
   "搜索把用户送到了对的那一家" 与 "用户随便看了几家最后订了其中一家"。
4. **"最后一次点击"的定义**：`clicked_at` 最大；**若同一秒点了多个不同 listing，
   取 `position` 最小（排得更靠前）的那一条**。同一条 listing 被点多次不算并列。
5. 归因一律以 `booking.session_id` 为准（成交所在会话）。
   用户在会话 X 里点了 listing，在会话 Y 里下单 ⇒ 对 X 的两个口径都不算。

## 这题真正考的东西

- **`JOIN` 出来的不是会话**：`session ⟶ click ⟶ booking` 一连就产生**笛卡尔扇出**
  （一次会话 3 击 1 订 = 3 行）。直接 `SUM(CASE WHEN ... THEN 1 ELSE 0)` 或
  `COUNT(booking_id)` 的分子会把会话数放大成"点击×预订配对数"。
- **分母必须从会话表出发**：用 `INNER JOIN search_click` 求分母，
  "有预订但没点击"的会话会整体消失 —— 分子分母同时少，看起来"没问题"，
  而某个本来零转化的类别会**整行不见了**而不是显示 0。
- **"订的不是最后点的"这一类必须存在**：A 与 B 的差值才是这题的输出，
  两个口径写成同一个表达式实现对判题是透明的、对业务是灾难。
- **并列破法必须确定**：不打破 ties 的实现，`MAX(clicked_at)` 之后随手取一条，
  结果依赖存储顺序 —— 同一份数据两次跑可能给不同的 B。

不许用窗口函数之外的方言特性；`PERCENTILE_CONT` 之类不存在。"""

    reference = """WITH per_session AS (
  SELECT s.session_id,
         s.query_cat,
         (SELECT COUNT(*) FROM search_click c WHERE c.session_id = s.session_id) AS click_cnt,
         (SELECT COUNT(*) FROM booking b WHERE b.session_id = s.session_id)       AS booking_cnt
  FROM search_session s
), last_view AS (
  -- 最后一次点击：时刻最大；同刻并列时位次最小（必须确定，否则 B 依赖存储顺序）
  SELECT c.session_id, c.listing_id
  FROM search_click c
  WHERE NOT EXISTS (
    SELECT 1 FROM search_click x
    WHERE x.session_id = c.session_id
      AND (x.clicked_at > c.clicked_at
           OR (x.clicked_at = c.clicked_at AND x.position < c.position))
  )
), scored AS (
  SELECT ps.query_cat,
         CASE WHEN ps.click_cnt > 0 AND ps.booking_cnt > 0 THEN 1 ELSE 0 END AS in_any,
         CASE WHEN ps.click_cnt > 0 AND ps.booking_cnt > 0
                   AND EXISTS (
                        SELECT 1 FROM last_view lv
                        JOIN booking b ON b.session_id = lv.session_id
                                      AND b.listing_id = lv.listing_id
                        WHERE lv.session_id = ps.session_id
                      )
              THEN 1 ELSE 0 END AS in_last
  FROM per_session ps            -- 从会话表出发：INNER JOIN 会让零转化的类别整行消失
)
SELECT query_cat,
       ROUND(SUM(in_any) / COUNT(*), 4)  AS conv_click_any,
       ROUND(SUM(in_last) / COUNT(*), 4) AS conv_last_viewed
FROM scored
GROUP BY query_cat
ORDER BY query_cat"""

    naive = """-- 上线第一版：分子数的是"点击×预订的配对数"，分母数的是"参与过 JOIN 的行"
SELECT s.query_cat,
       ROUND(SUM(CASE WHEN b.booking_id IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 4)
         AS conv_click_any,
       ROUND(SUM(CASE WHEN c.listing_id = b.listing_id THEN 1 ELSE 0 END) / COUNT(*), 4)
         AS conv_last_viewed
FROM search_session s
JOIN search_click c ON c.session_id = s.session_id          -- INNER：没点击的会话直接消失
LEFT JOIN booking b ON b.session_id = s.session_id
GROUP BY s.query_cat
ORDER BY s.query_cat"""

    answer = """## 参考答案要点

三步：① 以**会话表为骨架**算出每个会话的 `click_cnt` / `booking_cnt`（标量子查询，
不参与 JOIN，所以不会扇出）；② 用 `NOT EXISTS` 找"最后一次点击"，把并列按 `position`
最小破掉；③ 按 `query_cat` 聚合，分子是 `SUM(0/1)`、分母是 `COUNT(*)` —— 两边都是会话粒度。

**基线手算一遍（用来核对 expected 真的对）**：
- `city` 5 个会话：1(3击1订,订的是最后点的)、2(2击1订,订的是第一次点的)、
  3(1击2订)、4(**无点击**有订)、10(3击1订,订的是中间那次点的)
  ⇒ A = 4/5 = **0.8000**（4 排除，因为它没有点击），
  B = 2/5 = **0.4000**（只有 1 和 3 订的是最后点的）。
  会话 3 有**两笔**预订但只能记 1 —— 这就是 A 与"预订数/会话数"的分岔点。
- `beach` 3 个会话：5(同秒点了 501@pos2 与 502@pos1，订的是 502)、6(同一家点两次,订它)、
  7(点了没订) ⇒ A = B = 2/3 = **0.6667**。
  会话 5 靠并列破法才落在 502 上：位次小的排得靠前，"最后看的是页面上更靠前的那一家"。
- `new` 2 个会话：8(**有订无击**)、9 ⇒ A = B = 1/2 = **0.5000**。

**扇出为什么是最贵的一种错**（用例「同一会话两笔预订：分子仍然只算 1 个会话」）：
`session JOIN click JOIN booking` 之后，会话 3 变成 1击×2订 = 2 行，会话 1 变成 3击×1订 = 3 行。
"分子 = 配对数、分母 = JOIN 后行数"两边同时被放大，比值看起来还在 `[0,1]` 里 ——
它不会触发任何"指标越界"的告警，只会让城市之间的相对排序发生变化，
然后被拿去做供给决策。**转化率这种比值指标最危险的不是算错，而是算错了还像对的。**

**分母必须从会话表出发**（用例「新增一个只有点击、没有预订的类别：该行必须出现且为 0」）：
`INNER JOIN search_click` 把"没有点击的会话"从分母里抹掉了 —— 于是
`city` 的分母从 5 变 4，A 从 0.8000 变 1.0000（会话 4 有预订，但它没点击，
它那一行整个不见了，分子里却还留着它的预订配对）。
一个数字同时错在两个方向上，这正是"一个指标三种答案"的成因。

**A 与 B 必须真的不同**（用例「并列被打破：501 点得更晚，beach 的 B 掉一档」）：
把会话 5 的 501 改成 10:32 之后，最后点的是 501、订的是 502 ⇒ B 掉到 1/3 = 0.3333，
A 不动（仍是 0.6667）。这条用例存在的意义就是：**把两列写成同一个表达式的实现必须当场露馅。**

**工程延伸（面试追问点）**

1. 为什么"按用户数"再要一列？（会话级转化率会被"重度比较型用户"拉低：
   他们本来就要开 5 个会话才订。用户级口径的分母是 `COUNT(DISTINCT user_id)`，
   分子要定义成"该用户在窗口内是否订过"，与"哪次搜索带来的"就脱钩了 ——
   所以它是**另一个问题**的答案，不是同一个指标的更好版本。）
2. 跨设备/跨会话归因怎么办？（`booking.session_id` 是"成交所在会话"，
   这本身就是一个归因假设。真实系统要同时留"最后一击所在会话"和"首次发现所在会话"，
   两个口径都算，再按业务选 —— 关键是**这个假设要写在指标定义里**，不能藏在 SQL 的 JOIN 方向里。）
3. `position` 与位次偏差怎么一起看？（B 隐含"用户订的是他看到的第一家"，
   而位次本身就是排序策略的产物 —— 所以 B 提升可能只是"把结果 1 做得更像会被订的那家"，
   而不是相关性变好。这也是这题要单独算"位次 1 的点击占比 / 曝光占比"的原因。）
4. 这两个口径谁该上仪表盘？（A 适合做**漏斗**（搜索有没有把人带到下单动作），
   B 适合做**排序质量代理**（带得准不准）。放一起看才有意义：
   A 涨 B 跌 = 用更激进的标题/图片换来了不相关的成交。）"""

    return base(
        'sql', 'senior',
        '搜索转化率的两种口径：分子按会话去重、分母不许被 JOIN 吃掉',
        statement, 'mysql',
        ['metric-definition', 'join-fanout', 'attribution', 'tie-break',
         'modern:marketplace-integrity'],
        src('搜索与发现 / 数据平台 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §4 题面草稿 B'
            '（素材给了"一个数字三种答案"的判分意图，未给可判分的口径与并列破法）'),
        language='sql',
        cases=[
            case('基线：三类别两种口径，A 与 B 的差值就是这题的输出',
                 note='city A 0.8 / B 0.4；beach 0.6667/0.6667；new 0.5/0.5'),
            case('同一会话两笔预订：分子仍然只算 1 个会话',
                 [('del', 'booking', 4)],
                 note='删掉会话 3 的第二笔预订 ⇒ 期望与基线完全相同；'
                      '按预订数计分子的实现这里会动'),
            case('补上"无点击会话"的第一次点击：city 两列同时上跳',
                 [('ins', 'click', (16, 4, 404, '2026-07-01 13:10:00', 1))],
                 note='会话 4 从"有订无击"变成"订的就是最后点的" ⇒ A 1.0、B 0.6'),
            case('并列被打破：501 点得更晚，beach 的 B 掉一档而 A 不动',
                 [('upd', 'click', (7, 'clicked_at', '2026-07-01 10:32:00'))],
                 note='把两列写成同一个表达式的实现在这条上必露馅'),
            case('新增一个只有点击、没有预订的类别：该行必须出现且为 0',
                 [('ins', 'session', (11, 11, '2026-07-01 08:00:00', 'cabin')),
                  ('ins', 'click', (17, 11, 1101, '2026-07-01 08:05:00', 1))],
                 note='INNER JOIN search_click 会让 cabin 整行消失，而不是给出 0.0000'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS booking',
                'DROP TABLE IF EXISTS search_click',
                'DROP TABLE IF EXISTS search_session',
                'CREATE TABLE search_session (session_id INT PRIMARY KEY, user_id INT NOT NULL, '
                'started_at DATETIME NOT NULL, query_cat VARCHAR(20) NOT NULL) ENGINE=InnoDB',
                'CREATE TABLE search_click (click_id INT PRIMARY KEY, session_id INT NOT NULL, '
                'listing_id INT NOT NULL, clicked_at DATETIME NOT NULL, position INT NOT NULL) '
                'ENGINE=InnoDB',
                'CREATE TABLE booking (booking_id INT PRIMARY KEY, session_id INT NOT NULL, '
                'listing_id INT NOT NULL, booked_at DATETIME NOT NULL, gmv DECIMAL(10,2) NOT NULL) '
                'ENGINE=InnoDB',
                insert_all('session'),
                insert_all('click'),
                insert_all('booking'),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=30,
        answer=answer,
    )


# =================================================================== 实验分流的样本比例失配（SRM）
@draft('sql-airbnb-srm-audit')
def q_srm_audit():
    """
    数据集只声明一次，expected 由 srm_rows() 从行集算出；
    用例的变异只有"按主键删行"一种，SQL 与派生共用同一份描述。
    """
    EXPERIMENTS = [
        # experiment_id, name, control_share（设计值）
        (1, 'price-display', 0.5000),
        (2, 'rank-blending', 0.5000),
        (3, 'new-supply-boost', 0.2000),
        (4, 'unused-lab', 0.5000),
    ]
    ASSIGNMENTS = [
        # assign_id, experiment_id, user_id, variant, assigned_at
        (1, 1, 101, 'control', '2026-08-01 08:00:00'),
        (2, 1, 101, 'treatment', '2026-08-03 09:00:00'),      # 换组：必须按首次归因
        (3, 1, 102, 'control', '2026-08-01 08:00:00'),
        (4, 1, 103, 'treatment', '2026-08-01 08:00:00'),
        (5, 1, 104, 'control', '2026-08-01 08:00:00'),
        (6, 1, 105, 'treatment', '2026-08-01 08:00:00'),
        (7, 1, 106, 'control', '2026-08-01 08:00:00'),
        (8, 2, 201, 'control', '2026-08-02 10:00:00'),
        (9, 2, 202, 'control', '2026-08-02 10:00:00'),
        (10, 2, 203, 'treatment', '2026-08-02 10:00:00'),
        (11, 2, 204, 'treatment', '2026-08-02 10:00:00'),
        (12, 2, 205, 'control', '2026-08-02 10:00:00'),
        (13, 3, 301, 'control', '2026-08-05 06:00:00'),
        (14, 3, 302, 'treatment', '2026-08-05 06:00:00'),
        (15, 3, 303, 'treatment', '2026-08-05 06:00:00'),
        (16, 3, 304, 'treatment', '2026-08-05 06:00:00'),
        (17, 3, 305, 'treatment', '2026-08-05 06:00:00'),
        (18, 3, 306, 'treatment', '2026-08-05 06:00:00'),
    ]
    EXPOSURES = [
        # exposure_id, experiment_id, user_id, day, impressions
        (1, 1, 101, '2026-08-02', 30),
        (2, 1, 102, '2026-08-02', 40),
        (3, 1, 103, '2026-08-02', 10),
        (4, 1, 104, '2026-08-02', 20),
        (5, 1, 105, '2026-08-02', 999),
        (6, 1, 106, '2026-08-03', 5),
        (7, 2, 201, '2026-08-03', 12),
        (8, 2, 202, '2026-08-03', 7),
        (9, 2, 203, '2026-08-03', 3),
        (10, 2, 204, '2026-08-03', 5),
        (11, 3, 301, '2026-08-06', 8),
        (12, 3, 302, '2026-08-06', 8),
        (13, 3, 303, '2026-08-06', 8),
        (14, 1, 109, '2026-08-04', 6),        # 有曝光但没有分配记录
    ]

    COLUMNS = ['experiment_id', 'control_users', 'treatment_users',
               'total_users', 'control_share', 'srm_flag']

    def srm_rows(experiments, assignments, exposures):
        from decimal import Decimal, ROUND_HALF_UP
        exposed = {(e[1], e[2]) for e in exposures}        # (experiment_id, user_id)
        first = {}
        for aid, exp, user, variant, at in sorted(assignments, key=lambda r: (r[1], r[2], r[4], r[0])):
            first.setdefault((exp, user), variant)         # 首次分配归因
        out = []
        for exp, _name, expected in experiments:
            users = {u for (e, u) in exposed if e == exp}
            buckets = {'control': 0, 'treatment': 0}
            for u in users:
                variant = first.get((exp, u))
                if variant in buckets:
                    buckets[variant] += 1                 # 没有分配记录的曝光用户两个桶都不进
            total = buckets['control'] + buckets['treatment']
            if total == 0:
                continue                                  # 零曝光的实验不输出行
            share = float((Decimal(buckets['control']) / Decimal(total))
                          .quantize(Decimal('0.0001'), rounding=ROUND_HALF_UP))
            flag = 1 if abs(Decimal(str(share)) - Decimal(str(expected))) > Decimal('0.0050') else 0
            out.append([exp, buckets['control'], buckets['treatment'], total, share, flag])
        return out

    def case(name, drop_assignments=(), drop_exposures=(), note=None):
        keep_a = [a for a in ASSIGNMENTS if a[0] not in set(drop_assignments)]
        keep_e = [e for e in EXPOSURES if e[0] not in set(drop_exposures)]
        sql = [f'DELETE FROM assignment WHERE assign_id = {i}' for i in drop_assignments]
        sql += [f'DELETE FROM exposure WHERE exposure_id = {i}' for i in drop_exposures]
        payload = {'name': name, 'input': sql,
                   'expected': {'columns': COLUMNS, 'rows': srm_rows(EXPERIMENTS, keep_a, keep_e),
                                'orderSensitive': True}}
        if note:
            payload['note'] = note
        return payload

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

```
experiment  (experiment_id INT PRIMARY KEY, name VARCHAR(40), control_share DECIMAL(5,4))
assignment  (assign_id INT PRIMARY KEY, experiment_id INT, user_id INT,
             variant VARCHAR(10), assigned_at DATETIME)   -- variant ∈ control|treatment
exposure    (exposure_id INT PRIMARY KEY, experiment_id INT, user_id INT,
             day DATE, impressions INT)
```

## 任务

SRM（sample ratio mismatch）是实验平台的"结论可信吗"开关：
**实际进组比例偏离设计比例**，说明分流系统或数据采集有 bug，此时任何指标差异都不可信。
按 `experiment_id` 升序输出一行审计结果，列名与顺序必须是：

```
experiment_id, control_users, treatment_users, total_users, control_share, srm_flag
```

## 口径（逐条都是判分点）

1. **统计对象是"真正进了实验的人"= 有曝光记录的去重用户**，
   不是被分配的人，更不是曝光行数或 `SUM(impressions)`。
2. **分组按"首次分配"归因**：同一 `(experiment_id, user_id)` 可能有多条 `assignment`
   （分流系统改过桶）。只取 `assigned_at` 最早的那条的 `variant`；
   并列最早时取 `assign_id` 最小的。
   按"最新分组"归因会把"改桶 bug"本身洗掉 —— 而它恰恰是 SRM 最常见的原因。
3. 分母 `total_users` = `control_users + treatment_users`（**有分配记录**的去重曝光用户）。
   有曝光但没有任何分配记录的用户，两个桶都不进、也不进分母。
4. `control_share` = `ROUND(control_users / total_users, 4)`。
5. `srm_flag` = 1 当 `|control_share - experiment.control_share| > 0.0050`，否则 0。
   严格大于：正好等于 0.0050 不算失配。
6. `total_users = 0` 的实验**不输出行**。

只提交一条 `SELECT` / `WITH` 查询。

## 这题真正考的东西

- **`COUNT(*)` vs `COUNT(DISTINCT user_id)`**：重度用户一天能刷 999 次曝光，
  按行数或按 `SUM(impressions)` 加权时，一个用户就能把整个比例带偏 ——
  而 SRM 检出的正是"比例带偏"，用带偏的口径去检带偏，等于自欺。
- **首次 vs 最新归因**决定了同一个 bug 是被检出还是被掩盖。
- **孤儿曝光**（有曝光无分配）是采集侧最常见的坏数据；
  把它算进分母会让 `control_share` 偏向任何一边，取决于它落在哪个桶（它没有桶）。"""

    reference = """WITH first_assign AS (
  SELECT a.experiment_id, a.user_id, MIN(a.assign_id) AS pick_id
  FROM assignment a
  JOIN (SELECT experiment_id, user_id, MIN(assigned_at) AS first_at
        FROM assignment GROUP BY experiment_id, user_id) f
    ON f.experiment_id = a.experiment_id
   AND f.user_id = a.user_id
   AND f.first_at = a.assigned_at
  GROUP BY a.experiment_id, a.user_id
), attributed AS (
  SELECT fa.experiment_id, fa.user_id, a.variant
  FROM first_assign fa
  JOIN assignment a ON a.assign_id = fa.pick_id
), exposed AS (
  SELECT DISTINCT experiment_id, user_id FROM exposure
), counted AS (
  SELECT e.experiment_id,
         COUNT(DISTINCT CASE WHEN t.variant = 'control' THEN e.user_id END)   AS control_users,
         COUNT(DISTINCT CASE WHEN t.variant = 'treatment' THEN e.user_id END) AS treatment_users
  FROM exposed e
  JOIN attributed t ON t.experiment_id = e.experiment_id AND t.user_id = e.user_id
  GROUP BY e.experiment_id
)
SELECT c.experiment_id,
       c.control_users,
       c.treatment_users,
       c.control_users + c.treatment_users AS total_users,
       ROUND(c.control_users / (c.control_users + c.treatment_users), 4) AS control_share,
       CASE WHEN ABS(ROUND(c.control_users / (c.control_users + c.treatment_users), 4)
                     - x.control_share) > 0.0050 THEN 1 ELSE 0 END        AS srm_flag
FROM counted c
JOIN experiment x ON x.experiment_id = c.experiment_id
ORDER BY c.experiment_id"""

    naive = """-- "看起来对"版：按曝光行加权，并按最后一次分配归因
SELECT e.experiment_id,
       SUM(CASE WHEN a.variant = 'control' THEN 1 ELSE 0 END)   AS control_users,
       SUM(CASE WHEN a.variant = 'treatment' THEN 1 ELSE 0 END) AS treatment_users,
       COUNT(*)                                                 AS total_users,
       ROUND(SUM(CASE WHEN a.variant = 'control' THEN 1 ELSE 0 END) / COUNT(*), 4) AS control_share,
       CASE WHEN ABS(ROUND(SUM(CASE WHEN a.variant = 'control' THEN 1 ELSE 0 END) / COUNT(*), 4)
                     - x.control_share) > 0.005 THEN 1 ELSE 0 END AS srm_flag
FROM exposure e
JOIN assignment a ON a.experiment_id = e.experiment_id AND a.user_id = e.user_id
JOIN experiment x ON x.experiment_id = e.experiment_id
GROUP BY e.experiment_id, x.control_share
ORDER BY e.experiment_id"""

    answer = """## 参考答案要点

三步 CTE：① `first_assign` 用 `(experiment_id, user_id)` 上的 `MIN(assigned_at)`
锁定首次分配，再用 `MIN(assign_id)` 破并列；② `exposed` 是 `DISTINCT` 的曝光用户；
③ 两者 JOIN 之后用 `COUNT(DISTINCT CASE WHEN ... THEN user_id END)` 分桶计数。
零曝光的实验因为在 `counted` 里没有行而自然消失，不需要额外过滤。

**基线手算一遍（用来核对 expected 是不是真的对）**：
- 实验 1：曝光用户 101/102/103/104/105/106 六个都有分配，
  其中 101 首次是 `control`（08-01），第二次被改成 `treatment`（08-03）⇒ 按首次算 control。
  ⇒ control = {101,102,104,106} = 4，treatment = {103,105} = 2，total 6，share 0.6667，
  设计 0.5 ⇒ 差 0.1667 > 0.005 ⇒ **flag=1**。
  用户 109 有曝光无分配 ⇒ 不进任何桶也不进分母（按 `SUM(impressions)` 加权的话
  它 6 次曝光会把分母撑到 12）。
- 实验 2：201/202/203/204 有曝光（205 没有），control 2 / treatment 2 ⇒ share 0.5 ⇒ **flag=0**。
- 实验 3：只有 301、302、303 有曝光 ⇒ control 1 / treatment 2，share 0.3333，
  设计 0.2 ⇒ 差 0.1333 ⇒ **flag=1**。
- 实验 4：没有任何曝光 ⇒ **不输出行**（不是输出 0 或 NULL）。

**按行加权的实现错得有多离谱**（用例「删掉 999 次曝光的那个人的全部曝光：只算 1 个用户」）：
朴素版里 `exposure JOIN assignment` 会为"同一用户的多次曝光 × 多条分配记录"再次扇出。
实验 1 的 101 有 2 条分配（control + treatment），它这一次曝光就被数成
"一个 control 加一个 treatment" —— 于是**换组 bug 从"检出"变成"自我抵消"**，
flag 直接归 0。这不是精度问题，是同一份坏数据在两种口径下一边报警一边闭嘴。

**首次 vs 最新的差别只在有改桶记录时出现**（用例「删掉首次分配：归因跟着换到新桶」）：
把 101 的首次 `control` 删掉，它的首次就变成 08-03 的 `treatment` ⇒
实验 1 变 control 3 / treatment 3，share 0.5 ⇒ **flag 从 1 变 0**。
一条 DELETE 让结论翻转，正好证明这个字段真的在判分里起作用。

**孤儿曝光**（用例「删掉无分配用户的曝光：三个桶计数都不动」）：
109 没有分配记录，删不删它的曝光，实验 1 的三个数字都不变。
把它写进分母的实现（`COUNT(*)` 来自 `exposure`）会给出 total 7 ⇒ share 0.5714。

**工程延伸（面试追问点）**

1. 为什么阈值是"绝对差 > 0.005"而不是卡方检验？（0.005 是**工程护栏**，简单可解释；
   真正的平台会按样本量做卡方/二项检验 —— 小实验上 0.005 可能是噪声，
   大实验上 0.001 都该停线。这题选绝对阈值是为了可判分，答的时候要说清它随样本量失真。）
2. 检出 SRM 之后该做什么？（**停线，不是修正**。指标差异在有偏分流下不可解释，
   任何"加权纠偏"都假设了偏移机制已知，而 SRM 的含义正是"我们不知道机制"。
   要做的动作是回溯：分流日志是否丢、是否有用户跨设备被认成两个人、缓存是否把旧桶发出去。）
3. 为什么按曝光而不是按分配统计？（"被分到 treatment 但从未打开过 App"的用户
   对指标没有贡献，把他们算进分母会稀释效应、也会让"上游只对活跃用户生效"的分流 bug 隐形。
   代价是引入**选择偏差** —— 所以两者都要看：分配数是 ITT 口径，曝光数是实际触达口径。）
4. 用户跨设备怎么办？（按 `user_id` 去重是对的，但前提是分流键与去重键一致。
   如果分流按 device、统计按 user，同一用户会同时出现在两个桶里 ——
   这是 SRM 的经典成因之一，也是"分流单元必须与实验单元一致"这条规范的来源。）"""

    return base(
        'sql', 'senior',
        'SRM 审计：按首次分配归因、按去重用户计数，不许被重度用户带偏',
        statement, 'mysql',
        ['experimentation', 'srm', 'count-distinct', 'attribution', 'data-quality',
         'modern:marketplace-integrity'],
        src('实验与分析平台 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §1、§2.8（"SRM 监控与自动停线"'
            '只作为一句话出现，未给可判分的归因与计数口径）'),
        language='sql',
        cases=[
            case('基线：实验 1 因改桶用户被检出，实验 4 零曝光不输出行',
                 note='exp1 4/2 share 0.6667 flag1；exp2 2/2 flag0；exp3 1/2 flag1；exp4 无行'),
            case('删掉首次分配：归因跟着换到新桶，实验 1 的 flag 归 0',
                 drop_assignments=[1],
                 note='101 变成 treatment ⇒ exp1 3/3 share 0.5 flag0 —— 证明"首次"这个口径真的在判分'),
            case('删掉无分配用户的曝光：三个桶计数都不动',
                 drop_exposures=[14],
                 note='孤儿曝光不进分母；把它算进去的实现这里会把 exp1 的 share 从 0.6667 变 0.5714'),
            case('删掉 999 次曝光的那个人的全部曝光：只算 1 个用户',
                 drop_exposures=[5],
                 note='按人去重 ⇒ 删掉 105 只让分母从 6 变 5、treatment 从 2 变 1（share 0.8）。'
                      '按行或按 impressions 加权的实现这里会一次掉几百，且各列互相对不上'),
            case('删掉实验 2 唯一的 treatment 曝光：share 变 1.0 并触发失配',
                 drop_exposures=[9, 10],
                 note='exp2 只剩 201/202 两个 control ⇒ 1/0 share 1.0 flag1'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS exposure',
                'DROP TABLE IF EXISTS assignment',
                'DROP TABLE IF EXISTS experiment',
                'CREATE TABLE experiment (experiment_id INT PRIMARY KEY, name VARCHAR(40) NOT NULL, '
                'control_share DECIMAL(5,4) NOT NULL) ENGINE=InnoDB',
                'CREATE TABLE assignment (assign_id INT PRIMARY KEY, experiment_id INT NOT NULL, '
                'user_id INT NOT NULL, variant VARCHAR(10) NOT NULL, assigned_at DATETIME NOT NULL) '
                'ENGINE=InnoDB',
                'CREATE TABLE exposure (exposure_id INT PRIMARY KEY, experiment_id INT NOT NULL, '
                'user_id INT NOT NULL, day DATE NOT NULL, impressions INT NOT NULL) ENGINE=InnoDB',
                'INSERT INTO experiment VALUES '
                + ', '.join(f"({i}, '{n}', {s})" for i, n, s in EXPERIMENTS),
                'INSERT INTO assignment VALUES '
                + ', '.join(f"({i}, {e}, {u}, '{v}', '{t}')"
                            for i, e, u, v, t in ASSIGNMENTS),
                'INSERT INTO exposure VALUES '
                + ', '.join(f"({i}, {e}, {u}, '{d}', {n})"
                            for i, e, u, d, n in EXPOSURES),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=30,
        answer=answer,
    )


# =================================================================== 无结果时的约束松弛阶梯
@draft('alg-airbnb-relax-ladder')
def q_relax_ladder():
    """
    选哪几条约束去松 = 带代价的最大覆盖，**不是**贪心。
    expected 由 pick() 枚举全部子集算出（约束数是个位数，枚举在这里是诚实的做法）。
    """

    def pick(covers, bucket_size, cost, min_results):
        n = len(covers)
        if len(cost) != n:
            raise ValueError('cost and covers disagree')
        if not bucket_size:
            raise ValueError('no buckets')
        if min_results <= 0:
            raise ValueError('minResults must be positive')
        for c in cost:
            if c < 0:
                raise ValueError('cost must be >= 0')
        for groups in covers:
            for b in groups:
                if b < 1 or b >= len(bucket_size):
                    raise ValueError('bucket id out of range')   # 桶 0 是基线，不许被"松"出来
        base = bucket_size[0]
        if base >= min_results:
            return []                                            # 已经够了：一条都不松
        best = None
        for mask in range(1, 1 << n):
            picked = [i for i in range(n) if mask >> i & 1]
            total_cost = sum(cost[i] for i in picked)
            if best is not None and total_cost > best[0]:
                continue
            reached = set()
            for i in picked:
                reached.update(covers[i])
            if base + sum(bucket_size[b] for b in reached) < min_results:
                continue
            cand = (total_cost, picked)
            if best is None or cand[0] < best[0] or (cand[0] == best[0] and picked < best[1]):
                best = cand
        return best[1] if best else [-1]

    def case(name, covers, bucket_size, cost, min_results, throws=False, note=None):
        """`throws` 是声明不是推断（见本文件 booking-gate 的 case() 注释）。"""
        try:
            got = pick(covers, bucket_size, cost, min_results)
        except ValueError as exc:
            if not throws:
                raise AssertionError(f'用例「{name}」没声明 throws，但模型抛了 {exc}') from exc
            payload = {'name': name, 'input': [covers, bucket_size, cost, min_results],
                       'expected': None, 'expectThrow': 'IllegalArgumentException'}
        else:
            if throws:
                raise AssertionError(f'用例「{name}」声明了 throws，但模型正常返回 {got}')
            payload = {'name': name, 'input': [covers, bucket_size, cost, min_results],
                       'expected': got}
        if note:
            payload['note'] = note
        return payload

    statement = """## 背景

搜索无结果率是 Airbnb 搜索侧的核心产品指标之一，而"无结果"多数不是没房，
是**约束叠太狠**。标准处置是按**松弛阶梯**逐条放宽（先松"立即入住"，再松"整套"，
最后才动价格带与位置），把 0 结果变成"有替代方案"。

阶梯顺序是业务判断，但**它不等于最优解**：松一条昂贵的约束可能就够了，
而按阶梯从上往下松会连着松掉三条。本题要求给出**代价最小的松弛方案**。

## 你要实现的入口

```java
public static int[] pickRelaxations(int[][] covers, int[] bucketSize, int[] cost, int minResults)
```

- 候选结果被分到若干**桶**：桶 `0` 是"当前条件下就能查出来"的基线桶，
  桶 `1..` 各自对应一类被某条约束挡掉的结果。`bucketSize[b]` 是该桶的结果条数。
- `covers[i]` 是**松开第 i 条约束能救回的桶编号列表**（一条约束可以救多个桶，
  多条约束也可以救同一个桶 —— 所以**收益不可加**）。
- `cost[i]` 是松开第 i 条约束的代价（越大越不该松）。
- 返回被选中松弛的**下标升序数组**；`minResults` 是至少要凑出的结果条数。

## 选择规则（判分点）

1. 结果数 = `bucketSize[0] + Σ bucketSize[b]`，其中求和范围是**被选中松弛覆盖到的桶的并集**
   （同一个桶被两条松弛覆盖只算一次）。
2. 在满足"结果数 ≥ `minResults`"的所有子集里取**总代价最小**的。
3. 代价并列时，取下标序列**字典序最小**的那一组（比较的是升序数组本身，不是长度）。
4. `bucketSize[0] >= minResults` ⇒ 返回**空数组**：一条都不许松。
5. 任何子集都凑不出 `minResults` ⇒ 返回 `[-1]`（**不是**空数组 —— 空数组是"不用松"，
   `[-1]` 是"松光了也没有"，前端要给用户的话术完全不同）。
6. 非法输入抛 `IllegalArgumentException`：`minResults <= 0`、`cost` 有负数、
   `covers` 与 `cost` 长度不一致、`bucketSize` 为空、`covers` 里出现越界桶号
   （含出现桶 `0`：基线桶不需要任何松弛就能查出来，把它写进 `covers` 说明建模错了）。

约束条数 `covers.length <= 12`，所以**枚举全部子集是允许的**（也是本题推荐的写法）。"""

    reference = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  public static int[] pickRelaxations(int[][] covers, int[] bucketSize, int[] cost, int minResults) {
    if (bucketSize.length == 0) throw new IllegalArgumentException("no buckets");
    if (covers.length != cost.length) throw new IllegalArgumentException("cost and covers disagree");
    if (minResults <= 0) throw new IllegalArgumentException("minResults must be positive");
    for (int c : cost) {
      if (c < 0) throw new IllegalArgumentException("cost must be >= 0");
    }
    for (int[] groups : covers) {
      for (int b : groups) {
        if (b < 1 || b >= bucketSize.length) {
          throw new IllegalArgumentException("bucket id out of range: " + b);
        }
      }
    }
    int base = bucketSize[0];
    if (base >= minResults) {
      return new int[0];                      // 够了 ⇒ 一条都不松
    }

    int n = covers.length;
    boolean[] used = new boolean[bucketSize.length];
    int bestCost = Integer.MAX_VALUE;
    List<Integer> best = null;
    // 枚举全部子集。n <= 12 ⇒ 最多 4095 个组合，代价与正确性都清楚。
    for (int mask = 1; mask < (1 << n); mask++) {
      int total = 0;
      List<Integer> picked = new ArrayList<>();
      for (int i = 0; i < n; i++) {
        if ((mask >> i & 1) == 1) {
          total += cost[i];
          picked.add(i);
        }
      }
      if (total > bestCost) {
        continue;                             // 剪枝：已经不比现有答案好
      }
      java.util.Arrays.fill(used, false);
      int reached = base;
      for (int i : picked) {
        for (int b : covers[i]) {
          if (!used[b]) {
            used[b] = true;
            reached += bucketSize[b];         // 并集才加 ⇒ 收益不可加
          }
        }
      }
      if (reached >= minResults) {
        if (total < bestCost || (total == bestCost && lessThan(picked, best))) {
          bestCost = total;
          best = picked;
        }
      }
    }
    if (best == null) {
      return new int[] {-1};
    }
    int[] out = new int[best.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = best.get(i);
    }
    return out;
  }

  /** 代价并列时按下标序列的字典序比：null 表示"还没有答案"，任何候选都优于它。 */
  private static boolean lessThan(List<Integer> a, List<Integer> b) {
    if (b == null) return true;
    for (int i = 0; i < Math.min(a.size(), b.size()); i++) {
      if (!a.get(i).equals(b.get(i))) return a.get(i) < b.get(i);
    }
    return a.size() < b.size();
  }
}"""

    naive = """import java.util.ArrayList;
import java.util.List;

public class Solution {
  // 阶梯实现版：按代价从低到高贪心累加，够数就停
  public static int[] pickRelaxations(int[][] covers, int[] bucketSize, int[] cost, int minResults) {
    if (bucketSize.length == 0) throw new IllegalArgumentException("no buckets");
    if (covers.length != cost.length) throw new IllegalArgumentException("cost and covers disagree");
    if (minResults <= 0) throw new IllegalArgumentException("minResults must be positive");
    for (int c : cost) {
      if (c < 0) throw new IllegalArgumentException("cost must be >= 0");
    }
    for (int[] groups : covers) {
      for (int b : groups) {
        if (b < 1 || b >= bucketSize.length) {
          throw new IllegalArgumentException("bucket id out of range: " + b);
        }
      }
    }
    List<Integer> order = new ArrayList<>();
    for (int i = 0; i < covers.length; i++) order.add(i);
    order.sort(java.util.Comparator.comparingInt(i -> cost[i]));

    boolean[] used = new boolean[bucketSize.length];
    int reached = bucketSize[0];
    List<Integer> picked = new ArrayList<>();
    for (int i : order) {
      if (reached >= minResults) break;
      picked.add(i);
      for (int b : covers[i]) {
        if (!used[b]) {
          used[b] = true;
          reached += bucketSize[b];
        }
      }
    }
    if (reached < minResults) return new int[] {-1};
    java.util.Collections.sort(picked);
    int[] out = new int[picked.size()];
    for (int i = 0; i < out.length; i++) out[i] = picked.get(i);
    return out;
  }
}"""

    answer = """## 参考答案要点

枚举全部子集（`covers.length <= 12` ⇒ 至多 4095 个），每个子集用一张 `used[]`
求"覆盖桶的并集"再加基线，够数就参与比较；先按总代价、代价并列按下标字典序取胜者。
两个实现细节：`total > bestCost` 的提前跳过是纯剪枝（不影响正确性），
以及 `used[]` 必须**每个子集重置一次**（复用同一张表会让后一个子集白捡前一个的覆盖）。

**为什么"按代价贪心"是错的**（用例「两条便宜的不如一条中价的」）：
松弛 A 代价 1、只救 3 条；B 代价 1、只救 4 条；C 代价 2、一次救 20 条；
需要凑到 20 条以上。贪心先取 A、再取 B（累计 7 条不够），最后还得取 C ⇒ 总代价 4；
最优解是单独取 C ⇒ 代价 2。
而**阶梯顺序**的写法（按业务优先级从前往后松）在这里更糟：它可能一路松到 C 之前
已经把 A、B 都松了，把"能松的都不该松"变成默认行为。
松弛问题本质是**带代价的最大覆盖**，贪心没有最优性保证 —— 它的近似比是 `1 - 1/e`，
所以真实系统要么约束条数少到能枚举，要么接受"至少差 37%"。

**收益不可加**（用例「两条松弛救同一个桶：第二条不值」）：
A 救桶 1（10 条）与桶 2（5 条），B 也救桶 2（5 条）。松 A 已经到 15 条，
再松 B 只多 0 条 —— 但把每条松弛的"独立收益"当成边际收益相加的实现会以为 B 值 5 条，
于是多付一次代价，而且**统计出来的"每条松弛的贡献"永远大于真实贡献之和**。
这正是线上"松弛阶梯越做越长、无结果率却不动"的机制。

**`[]` 与 `[-1]` 必须是两个不同的答案**（用例「基线就够：一条都不松」与
「松光了也不够：无解」）：
前者对用户是"这就是正常结果，别乱改排序"，后者是"这里真的没房，给替代方案"。
把它们都返回空数组的实现，会让无结果兜底逻辑**永远不触发** ——
而这恰好是最需要它的时候。

**工程延伸（面试追问点）**

1. 约束条数变大怎么办？（整数规划或按"性价比 = 新增结果数 / 代价"排序的贪心 + 局部搜索；
   但更重要的是**先减少条数**：真实系统里多数约束互斥或冗余，
   把"松了也不会新增结果"的约束从阶梯里删掉，通常能砍掉一半。）
2. 松弛之后怎么排序？（替代结果必须**标记松弛来源**并降权，否则用户看到"完全不符合条件"
   的结果会以为是 bug。产品口径通常是"以下是放宽了 X 的结果"，把代价显式给用户。）
3. 代价怎么定？（它不是拍的：用**转化损失**标定 —— 松掉"整套"之后成交率下降多少，
   就把它换成多少代价。这样"最小代价"才真的是"最小体验损失"，而不是"最少改动条数"。）
4. 为什么不用"直接放一个更大的地理半径"？（那是**另一条松弛**，而且通常是代价最高的那条；
   阶梯的价值就在于它把"从便宜到贵"的顺序显式化并允许产品调，本题把它做成可计算的选择，
   顺序退化为 `cost` 的一个特例。）"""

    return base(
        'algorithms', 'senior',
        '无结果松弛阶梯：带代价的最大覆盖，贪心与阶梯顺序都不是最优',
        statement, 'java-junit',
        ['set-cover', 'search-quality', 'greedy-trap', 'empty-vs-none',
         'modern:marketplace-rules'],
        src('搜索与发现 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §2.4'
            '（"约束松开的策略层级"只作为答题要点出现，未做成可判分的最优选择问题）'),
        language='java',
        cases=[
            case('基线就够：一条都不松（返回空数组而不是 [-1]）',
                 [[1], [2]], [50, 10, 10], [1, 5], 30,
                 note='bucketSize[0]=50 已达 minResults=30 ⇒ []'),
            case('单条就够：选够用的那一条',
                 [[1], [2]], [0, 10, 4], [3, 8], 8),
            case('两条便宜的不如一条中价的：贪心会多付',
                 [[1], [2], [3]], [0, 3, 4, 20], [1, 1, 2], 20,
                 note='A(1)+B(1) 只到 7 条，还得再取 C ⇒ 代价 4；单独 C 只要 2'),
            case('两条松弛救同一个桶：第二条不值',
                 [[1, 2], [2]], [0, 10, 5], [1, 6], 15,
                 note='松 0 就到 15 ⇒ 只需 [0]；把独立收益相加的实现会连 1 也选上'),
            case('代价并列：取下标字典序更小的一组',
                 [[1], [2], [1, 2]], [0, 5, 5, 10], [1, 1, 2], 10,
                 note='单独 2 与 {0,1} 都是 10 条、代价都是 2 ⇒ 比字典序取 [0,1]（首位 0 < 2），'
                      '不是取"条数更少的那组"'),
            case('必须两条联合才够',
                 [[1], [2]], [0, 3, 4], [5, 5], 7,
                 note='单条最多 3 或 4 条 ⇒ 只能同时松两条'),
            case('松光了也不够：返回 [-1]',
                 [[1], [2]], [0, 3, 4], [7, 9], 100),
            case('零代价的松弛也要真的选上',
                 [[1], [2]], [0, 7, 7], [0, 5], 7,
                 note='cost=0 那条必选；按"性价比"排序的实现这里会除零或把它排到最后'),
            case('退化：一条约束都没有', [], [3], [], 5),
            case('非法：minResults 为 0', [[1]], [0, 5], [1], 0, throws=True),
            case('非法：covers 与 cost 长度不一致', [[1], [2]], [0, 5, 5], [1], 5, throws=True),
            case('非法：代价为负', [[1]], [0, 5], [-1], 5, throws=True),
            case('非法：桶号越界', [[1], [7]], [0, 5, 5], [1, 1], 5, throws=True),
            case('非法：把基线桶写进 covers', [[0]], [4, 5], [1], 9, throws=True,
                 note='桶 0 不需要任何松弛就能查出来 —— 出现它说明建模错了'),
            case('非法：bucketSize 为空', [[1]], [], [1], 1, throws=True),
        ],
        runner={'className': 'Solution',
                'signature': 'int[] pickRelaxations(int[][] covers, int[] bucketSize, int[] cost, '
                             'int minResults)',
                'entry': 'function', 'timeoutMs': 15000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer=answer,
    )


# =================================================================== 滥用与风控的处置设计（主观题）
@draft('hot-airbnb-abuse-response')
def q_abuse_response():
    statement = """## 场景

你是 Airbnb 预订链路的后端负责人。一个季度里连续发生四件事：

1. **占位不付款**：某地区的"锁窗口 + 稍后支付"流程被批量利用，
   单日为 3800 个房源锁住库存但不付款，其中 11% 在旺季真的挤掉了正常下单。
2. **日历爬取**：一批账号以每人每天 4 万次的频率查询价格与可订日历，
   把 price grid 的缓存打穿，DB 成本环比 +60%。它们不看详情页、从不下单。
3. **取消博弈**：旺季同一批房客在两个热门日期各下一单，临近入住退掉一单，
   导致房东的"可订率"在搜索排序里被错误地压低。
4. **一次误杀事故**：风控上线一条新规则后，某个城市的正常订单被拒 6.2%（约 2100 单），
   18 小时后才发现 —— 期间没有任何一条告警指向这条规则，是客服工单先看出来的。

现状：拦截与放行是二元开关；规则上线没有影子跑批；被拒用户看不到原因也无处申诉。

## 你要回答的问题

1. 给这四件事各自的**判定信号**分个层：哪些是单请求内可判的、
   哪些必须跨请求/跨账号聚合、哪些必须依赖图或历史画像。
   并说明为什么第 2 件事"用限流解决"是不够的。
2. 占位与取消博弈都是"**用合法操作制造非法后果**"。
   请分别给出机制设计层面的解法（不是加更多规则），并说明它牺牲了谁的体验、
   牺牲多少、怎么度量。
3. 误杀成本与欺诈损失怎么放进同一个决策？给出一个可运营的判据
   （含具体量纲），并说明它随季节/城市怎么变。
4. 针对第 4 件事：给出风控规则的**上线流程**，要求能在 15 分钟内发现"某条规则在误杀"，
   并说明为什么"看总体成交率"发现不了它。
5. 被拒的用户/房客该看到什么？给出"可解释、可申诉、但不给攻击者留下探测接口"
   三者同时成立的设计。指出你**绝不**告诉调用方的那一条信息是什么。
6. 风控要数据，平台要最小化。逐条说明你在这四件事里各存什么、存多久、
   房东与房客彼此能看到对方什么。"""

    return base(
        'hot-interviews', 'senior',
        '预订链路的滥用处置：机制设计、误杀判据、可申诉但不可枚举',
        statement, 'llm-rubric',
        ['fraud-abuse', 'mechanism-design', 'false-positive-cost', 'appeal-design',
         'data-minimization', 'modern:marketplace-integrity'],
        src('Booking / Trust & Safety 高级工程师',
            'content/knowledge/hot-interviews/airbnb-marketplace-booking.md §1.4 与 §3'
            '（素材点名列举了滥用模式与"误杀成本 vs 欺诈损失"，未做成可判分的处置与上线流程）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '信号分层并说清限流挡不住爬取', 'weight': 2,
                 'criteria': '是否区分：单请求内可判（参数合法性、attestation、金额异常）／'
                             '跨请求聚合（同 IP 段的枚举形状、账号-设备-收款人的重合度、'
                             '请求节奏的方差）／需要图或画像（收款人聚集、社交关系、历史取消行为）。'
                             '并且必须指出限流只压总量、不改**收益函数**：'
                             '爬虫可以横向扩账号池、慢速跑，或者把成本转给平台'
                             '（打穿缓存这件事在限流后依然发生，只是变慢）。'
                             '只答"限流 + 验证码"的此项不得过半。'},
                {'label': '用机制而不是规则处理"合法操作制造非法后果"', 'weight': 2,
                 'criteria': '占位：必须给出**让占用产生成本或让占用可让渡**的机制'
                             '（锁窗口配额按账号信誉分级、押金/预付比例随风险浮动、'
                             '锁到期后把房源放进"排队可捡"队列而不是回落到公开列表、'
                             '或改成意图化下单 + 一次性支付凭证）。'
                             '取消博弈：必须给出**取消代价与占用时间挂钩**的机制'
                             '（临近入住取消扣减额度、对同时段持有多个互斥订单的行为单独定价、'
                             '以及"房东侧取消与房客侧取消分开计分"）。'
                             '关键加分：说明这些机制**牺牲了谁**（正常用户的便利/转化率）、'
                             '牺牲多少怎么度量（拒单率、下单时长、转化损失），'
                             '以及为什么宁可让正常用户多一步也不要让滥用者零成本。'},
                {'label': '误杀与欺诈放进同一个可运营判据', 'weight': 2,
                 'criteria': '必须给出具体量纲（例如"拦下一笔欺诈的价值 = 平均赔付 + 品牌损失折算，'
                             '误杀一单的代价 = 该单毛利 + 用户流失折算"），'
                             '并把阈值写成**边际比较**：只有当"多拦一单带来的期望减损 >'
                             ' 多误杀一单的期望损失"时才继续收紧。'
                             '并且要指出这个比值随季节/城市变化'
                             '（旺季误杀的机会成本更高、淡季欺诈密度更高），'
                             '因此阈值不是一条全局常数而是按市场切片标定。'},
                {'label': '规则上线流程能在 15 分钟内发现误杀', 'weight': 2,
                 'criteria': '必须包含：影子运行（新规则只记录不拦截，跑够样本再放）／'
                             '分市场或分比例灰度而非一次性全量／'
                             '**按规则维度**出指标（每条规则单独一条误杀率、拒单量、'
                             '申诉率曲线，而不是只看总体成交率）／'
                             '自动回滚阈值与"谁有权调阈值"。'
                             '并明确回答"为什么总体成交率发现不了"：'
                             '2100 单占一个城市一天的量，全站指标淹没在噪声里，'
                             '而客服工单本来就是滞后的。'},
                {'label': '可申诉但不给探测接口，并指出绝不外泄的那一条', 'weight': 1,
                 'criteria': '响应必须**统一化**（同结构、同长度、同耗时量级），'
                             '申诉入口对所有人开放且走人工/异步复核，'
                             '给用户的解释停留在"这笔订单需要进一步验证"这一层。'
                             '必须点名至少一条绝不外泄的信息：'
                             '具体命中了哪条规则／阈值／剩余配额，'
                             '"还差多少就能通过"这类**边界可逼近**的反馈（等于给出枚举 oracle）。'
                             '只答"给用户说明原因"的此项不得分。'},
                {'label': '数据最小化落到字段与保留期', 'weight': 1,
                 'criteria': '是否逐条说明存哪些聚合特征、原始明细保留多久、'
                             '图特征用什么不可逆标识（而不是明文的收款人/设备映射表），'
                             '以及**房东与房客彼此可见范围**的边界'
                             '（例如房东不该看到房客的取消历史明细，只看到平台给出的信誉档）。'},
            ],
            'notes': '总分封顶 5 的情形：全程只谈"加更多规则/更强的模型"而无机制设计；'
                     '把误杀归因为"规则总要牺牲一些用户"而不给量化判据；'
                     '申诉设计里出现"告诉用户具体命中的规则以便其修正"；'
                     '用"接一个风控 SaaS"代替设计。',
        },
        estimatedMinutes=45,
        answer="""## 参考答案要点

**信号分层与限流的边界**：单请求内可判的是必要条件而非充分条件 —— 爬虫的每一次请求
单独看都合法，异常只出现在**序列**上（节奏方差、只查日历不看详情、账号池横向扩张）。
限流改变的是"每秒能做多少"，滥用者的目标函数是"总量"，所以它会用时间和账号数换速率；
要打的是**单位收益**：让每次枚举请求拿不到增量信息（统一响应、不可逼近的边界）、
让缓存穿透变贵（价格日历按 listing 版本化 + 单一实现）。

**机制优于规则的地方**：这四件事共同点是"用合法操作制造非法后果"，
规则只能事后识别，而机制改变的是收益曲线 ——
锁窗口要付代价（配额按信誉分级 / 到期进"排队可捡"队列而非公开回落），
取消要按占用时长计价，两个互斥订单同时持有本身就是被定价的行为。
必须同时说清**牺牲了谁**：正常用户的下单摩擦会上升，
判据是"每 1% 的转化损失换多少超卖/占位",这个数字要按城市标定。

**误杀与欺诈放进同一个判据**：唯一可运营的形式是边际比较 ——
`继续收紧 iff 多拦一单的期望减损 > 多误杀一单的期望损失`,
两边都要折算到钱（赔付 + 品牌 vs 毛利 + 流失）。
比值的两端都随季节与城市变化，所以阈值是分片参数;
"一条全局阈值"等于宣布我们不打算管误杀。

**15 分钟发现误杀**：靠"每条规则自己有指标"。总体成交率是最没用的信号 ——
2100 单摊到全站是一粒沙,而客服工单是滞后的最后一道。
可运营的最小集合：影子运行（只记录不拦截）→ 分市场灰度 → 按规则的拒单率/申诉率曲线
→ 自动回滚阈值 + 明确的调权责任人。

**可申诉但不可枚举**：响应统一化（结构、长度、耗时量级一致），
解释停在"需要进一步验证",申诉走异步人工复核。
绝不外泄的是**边界可逼近的反馈**：任何"还差多少就通过 / 命中了哪条规则"
都会把一个二值预言机变成梯度信号，攻击者据此收敛。
这一条与"联系人发现不许因哪条被拒而响应不同"是同一个原理。

**最小化**：图特征用不可逆标识（受控加盐哈希/PSI），不用明文映射表;
明细保留期按风控必要性设限（而不是"先存了再说"）;
房东与房客彼此只看到平台给出的**信誉档**，不看到对方的行为明细。"""
    )


# =================================================================== 搜索无结果率的三个状态
@draft('sql-airbnb-no-results')
def q_no_result_rates():
    """
    会话行集只声明一次；建表数据、用例变异 SQL、expected 全部由同一份行集派生。
    三态（0 结果 / 被限流 / 未采集）的归属是这题的全部难点，所以它必须只有一种表示法。
    """
    SESSIONS = [
        # session_id, user_id, day, n_results, is_ratelimited
        (1, 101, '2026-08-10', 12, 0),
        (2, 101, '2026-08-10', 0, 0),
        (3, 102, '2026-08-10', 0, 0),
        (4, 102, '2026-08-10', 0, 0),        # 同一用户两次无结果：用户级只算一次
        (5, 103, '2026-08-10', 0, 1),        # 被限流导致的 0 结果 ⇒ 三个口径里都不算
        (6, 103, '2026-08-10', 7, 0),
        (7, 104, '2026-08-10', None, 0),     # 未采集 ⇒ 分子分母都不进
        (8, 105, '2026-08-10', 3, 0),
        (9, 101, '2026-08-11', 0, 0),
        (10, 106, '2026-08-11', 5, 0),
        (11, 106, '2026-08-11', 0, 1),
        (12, 107, '2026-08-11', None, 0),
        (13, 108, '2026-08-11', 0, 0),
    ]
    COLUMNS = ['day', 'sessions', 'no_result_sessions', 'session_rate_pct',
               'users', 'users_with_no_result', 'user_rate_pct']

    def rates(rows):
        from decimal import Decimal, ROUND_HALF_UP
        by_day = {}
        for sid, uid, day, n, rl in rows:
            by_day.setdefault(day, []).append((uid, n, rl))
        out = []
        for day in sorted(by_day):
            # 有效会话：未被限流**且**结果数已采集
            valid = [(u, n) for (u, n, rl) in by_day[day] if not rl and n is not None]
            limited = [(u, n) for (u, n, rl) in by_day[day] if rl]
            untracked = [1 for (_u, n, rl) in by_day[day] if not rl and n is None]
            sessions = len(valid)
            no_result = sum(1 for (_u, n) in valid if n == 0)
            users = len({u for (u, _n) in valid})
            users_no = len({u for (u, n) in valid if n == 0})

            def pct(a, b):
                if b == 0:
                    return None
                return float((Decimal(a) * 100 / Decimal(b)).quantize(
                    Decimal('0.01'), rounding=ROUND_HALF_UP))

            row = [day, sessions, no_result, pct(no_result, sessions),
                   users, users_no, pct(users_no, users)]
            # 说明性断言：三态必须把每一行都归到一处，谁都不许被悄悄丢掉
            assert sessions + len(limited) + len(untracked) == len(by_day[day]), day
            out.append(row)
        return out

    def case(name, mutations=(), note=None):
        rows = list(SESSIONS)
        sql = []
        for mut in mutations:
            if mut[0] == 'del':
                rows = [r for r in rows if r[0] != mut[1]]
                sql.append(f'DELETE FROM search_session WHERE session_id = {mut[1]}')
            elif mut[0] == 'ins':
                rows.append(mut[1])
                sql.append('INSERT INTO search_session VALUES (' + ', '.join(
                    'NULL' if v is None else (f"'{v}'" if isinstance(v, str) else str(v))
                    for v in mut[1]) + ')')
            elif mut[0] == 'upd':
                _, sid, col, value = mut
                idx = {'user_id': 1, 'day': 2, 'n_results': 3, 'is_ratelimited': 4}[col]
                rows = [r[:idx] + (value,) + r[idx + 1:] if r[0] == sid else r for r in rows]
                lit = 'NULL' if value is None else (f"'{value}'" if isinstance(value, str) else str(value))
                sql.append(f'UPDATE search_session SET {col} = {lit} WHERE session_id = {sid}')
            else:
                raise AssertionError(f'未知变异 {mut[0]}')
        payload = {'name': name, 'input': sql,
                   'expected': {'columns': COLUMNS, 'rows': rates(rows), 'orderSensitive': True}}
        if note:
            payload['note'] = note
        return payload

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。

```
search_session(session_id INT PRIMARY KEY, user_id INT NOT NULL, day DATE NOT NULL,
               n_results INT NULL,           -- NULL = 该会话的结果数没被采集到
               is_ratelimited TINYINT NOT NULL)   -- 1 = 该会话是网关限流直接返回的空结果
```

## 任务

按 `day` 升序输出每天的两级无结果率，列名与顺序必须是：

```
day, sessions, no_result_sessions, session_rate_pct,
users, users_with_no_result, user_rate_pct
```

## 口径（三态归属是本题全部难点）

一条会话只有三种可能，**每一行都必须被归进下面某一类，且只归一类**：

| 类别 | 条件 | 计入哪里 |
| --- | --- | --- |
| 有效会话 | `is_ratelimited = 0` **且** `n_results IS NOT NULL` | 分母 `sessions`；若 `n_results = 0` 还计入分子 |
| 限流会话 | `is_ratelimited = 1` | **不进分子也不进分母**（两个层级都不进） |
| 未采集会话 | `is_ratelimited = 0` 且 `n_results IS NULL` | **不进分子也不进分母** |

1. `sessions` = 有效会话数；`no_result_sessions` = 其中 `n_results = 0` 的数量。
2. `users` = 有效会话里出现过的**去重用户数**；
   `users_with_no_result` = 这些用户中，当天**至少有一次** `n_results = 0` 的去重用户数。
   一个用户有 5 次无结果，`users_with_no_result` 仍然只加 1。
3. `session_rate_pct` = `no_result_sessions / sessions × 100`，
   `user_rate_pct` = `users_with_no_result / users × 100`，都 `ROUND(..., 2)`。
4. 分母为 0 ⇒ 该列输出 `NULL`（不是 0 —— 这一天没有任何可用样本，
   与"样本都在、结果率是 0%"是两件不同的事，报表必须能把它们分开）。
5. 某一天所有会话都是限流/未采集 ⇒ 这一天**仍要输出一行**，
   `sessions = 0`、两个比率是 `NULL`。
   （否则"限流打满的那天"会从报表上消失，看起来像"那天没人搜索"。）

只交一条 `SELECT` / `WITH` 查询。

## 这题真正考的东西

- **`n_results = 0` 不等于"无结果体验差"**：限流返回的也是 0。
  把它算进分子，限流一涨无结果率就涨，值班会去查搜索引擎而真正的原因是配额。
- **`NULL` 不是 0**：未采集既不该被算成"有结果"也不该被算成"无结果"。
  用 `COALESCE(n_results, 0)` 的实现会让埋点丢数的那几天曲线暴涨。
- **会话级与用户级是两个问题**：重度比较型用户一人能贡献 5 次无结果，
  两个数字会显著分岔 —— 分岔本身是有意义的，但**不能相互替代**。"""

    reference = """WITH valid AS (
  SELECT s.user_id, s.day, s.n_results
  FROM search_session s
  WHERE s.is_ratelimited = 0
    AND s.n_results IS NOT NULL          -- 未采集既不算"有结果"也不算"无结果"
), per_day AS (
  SELECT v.day,
         COUNT(*) AS sessions,
         SUM(v.n_results = 0) AS no_result_sessions,
         COUNT(DISTINCT v.user_id) AS users,
         COUNT(DISTINCT CASE WHEN v.n_results = 0 THEN v.user_id END) AS users_with_no_result
  FROM valid v
  GROUP BY v.day
), all_days AS (                    -- 全限流/全未采集的那天也要出行
  SELECT DISTINCT s.day FROM search_session s
)
SELECT d.day,
       COALESCE(p.sessions, 0)                     AS sessions,
       COALESCE(p.no_result_sessions, 0)           AS no_result_sessions,
       CASE WHEN COALESCE(p.sessions, 0) = 0 THEN NULL
            ELSE ROUND(p.no_result_sessions * 100 / p.sessions, 2) END AS session_rate_pct,
       COALESCE(p.users, 0)                        AS users,
       COALESCE(p.users_with_no_result, 0)         AS users_with_no_result,
       CASE WHEN COALESCE(p.users, 0) = 0 THEN NULL
            ELSE ROUND(p.users_with_no_result * 100 / p.users, 2) END AS user_rate_pct
FROM all_days d
LEFT JOIN per_day p ON p.day = d.day
ORDER BY d.day"""

    naive = """-- "把无结果当成一个布尔条件"版：限流与未采集都算进分子
SELECT s.day,
       COUNT(*)                                          AS sessions,
       SUM(COALESCE(s.n_results, 0) = 0)                 AS no_result_sessions,
       ROUND(SUM(COALESCE(s.n_results, 0) = 0) * 100 / COUNT(*), 2) AS session_rate_pct,
       COUNT(DISTINCT s.user_id)                         AS users,
       COUNT(DISTINCT CASE WHEN COALESCE(s.n_results, 0) = 0 THEN s.user_id END) AS users_with_no_result,
       ROUND(COUNT(DISTINCT CASE WHEN COALESCE(s.n_results, 0) = 0 THEN s.user_id END)
             * 100 / COUNT(DISTINCT s.user_id), 2)       AS user_rate_pct
FROM search_session s
GROUP BY s.day
ORDER BY s.day"""

    answer = """## 基线手算一遍（用来核对 expected 是不是真的对）

**2026-08-10**：13 条里的 8 条 ——
限流的 5 号、未采集的 7 号被剔掉 ⇒ `sessions = 6`（1,2,3,4,6,8）；
其中 0 结果是 2,3,4 ⇒ `no_result_sessions = 3`；
用户级：有效用户是 101,102,103,105 ⇒ `users = 4`；
有 0 结果的用户是 101（会话 2）、102（会话 3、4）⇒ `users_with_no_result = 2`。
⇒ `session_rate = 3/6 = 50.00`，`user_rate = 2/4 = 50.00`。
**注意 102 一个人贡献了两次无结果，用户级只算一次** —— 这正是两个数字会分岔的地方。

**2026-08-11**：有效的是 9（101，0 结果）、10（106，5 结果）、13（108，0 结果）⇒ `sessions = 3`、
`no_result = 2` ⇒ 66.67；用户 101,106,108 ⇒ `users = 3`，有 0 结果的是 101、108 ⇒ 2 ⇒ 66.67。
11 号（106 被限流）与 12 号（107 未采集）两边都不进 —— 于是用户 107 整天不出现。

**为什么 `COALESCE(n_results, 0) = 0` 是最危险的一行**：
它把"埋点丢了"翻译成"用户看到了空结果"。
某天采集器故障 30%，无结果率立刻从 50% 跳到 65%，
而值班手册上这条指标的解释是"搜索引擎召回变差" —— 于是去查索引、查供给，
查两个小时才发现是埋点。**指标错误的代价从来不是数字不准，而是把人引向错误的调查方向。**

**限流必须整个剔除，而不是只从分子里剔除**：
如果只从分子剔除而留在分母里，`session_rate` 会被稀释 ——
限流越严重，无结果率反而越低。这不是假设，这是这类看板真实出现过的形状。

**全限流的那天要出行且比率是 `NULL`**（用例「制造一个全限流的日子」）：
`all_days` 那一层就是为此存在的。
直接 `GROUP BY` 有效集的写法会让那天从报表上消失，
而"消失"与"是 0"在图上长得一样（都是没有点），
第二天补数据时没人知道中间断过。

**工程延伸（面试追问点）**

1. 为什么还要按"查询类型"再切一层？（无结果率的构成在不同意图下差异极大：
   长尾地名查询的 0 结果是**供给问题**，筛选条件叠加的 0 结果是**产品问题**，
   两者混在一个数里就只能得出"搜索变差了"这种无法行动的结论。）
2. 用户级与会话级该上哪个？（都要，且不能互相替代：
   会话级衡量"搜索引擎在多少次的请求上失败"，用户级衡量"多少人体验过失败"。
   产品决策（要不要做无结果兜底）通常看用户级，因为它是被体验的次数。）
3. `n_results IS NULL` 该怎么治理？（它是**埋点健康度**指标，应该单独立一条告警：
   未采集占比 > 0.5% 就报警，而不是让它以"结果"的身份参与业务指标。）
4. 为什么分母为 0 时输出 `NULL` 而不是 0？（`0.00` 在图上是一个"很好的点"，
   `NULL` 是一个断点。把"没有样本"画成"样本完美"是所有 BI 系统最经典的谎言。）"""

    return base(
        'sql', 'senior',
        '搜索无结果率：限流与未采集都不许进分母，会话级与用户级不可互相替代',
        statement, 'mysql',
        ['search-quality', 'metric-definition', 'three-state-null', 'denominator-hygiene',
         'modern:marketplace-integrity'],
        src('搜索与发现 / 数据平台 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §4 题面草稿 B 第 2 点'
            '（素材点名"无结果率要排除被限流的记录、并按会话数与用户数分别统计"，'
            '未给三态归属与分母为 0 的可判分口径）'),
        language='sql',
        cases=[
            case('基线：两个整天，102 一个人贡献两次无结果',
                 note='08-10 3/6=50.00、2/4=50.00；08-11 2/3=66.67、2/3=66.67'),
            case('制造一个全限流的日子：那天仍要出行且比率是 NULL',
                 [('ins', (14, 109, '2026-08-12', 0, 1)),
                  ('ins', (15, 110, '2026-08-12', 0, 1))],
                 note='08-12：sessions 0、no_result 0、两个比率 NULL —— 内连接写法这天会整行消失'),
            case('退化：某天的有效会话全部变成未采集：出行、比率 NULL、用户数 0',
                 [('upd', 1, 'n_results', None), ('upd', 2, 'n_results', None),
                  ('upd', 3, 'n_results', None), ('upd', 4, 'n_results', None),
                  ('upd', 6, 'n_results', None), ('upd', 8, 'n_results', None)],
                 note='埋点丢数的那天：sessions 0 ⇒ 比率 NULL；'
                      '把 NULL 当 0 的实现这里会报出 100% 无结果率'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS search_session',
                'CREATE TABLE search_session (session_id INT PRIMARY KEY, user_id INT NOT NULL, '
                'day DATE NOT NULL, n_results INT NULL, is_ratelimited TINYINT NOT NULL) '
                'ENGINE=InnoDB',
                'INSERT INTO search_session VALUES ' + ', '.join(
                    '(' + ', '.join('NULL' if v is None else (f"'{v}'" if isinstance(v, str) else str(v))
                                    for v in r) + ')'
                    for r in SESSIONS),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== 两道主观题：查询理解落点、索引升级上线
@draft('ag-airbnb-query-understanding')
def q_query_understanding_agent():
    statement = """## 场景

**你正在面试 Airbnb 的 Search Platform 工程师，40 分钟**

产品要求"用 LLM/Agent 升级搜索"。已提的三个需求：

- **A** 查询理解：把"适合带狗去的海边大房子，周末两天"解析成
  `{宠物友好, 海滩附近, 整套, 房型≥大床, 日期=下个周末, 2 晚}`；
- **B** 改写：无结果时自动放宽（同义词、地理放宽、日期弹性）；
- **C** 排序：让 LLM 直接给候选 listing 打相关性分，混进精排。

约束：搜索端到端 p95 现在 420ms（价格与可用性填充占 180ms）；
日均查询量级按 10 亿次估；A 的输出会**写进索引查询**，直接影响用户看到什么。

## 你要回答的问题

1. A/B/C 三个需求，逐个给"做/不做/换个做法"的判断与理由。
   判据必须包含延迟、成本、可评测性三条中的至少两条。
2. A 的结构化输出怎么保证可靠？给出 schema 设计、非法输出的处置、
   以及"解析错了会不会伤到用户"的**归因路径**（不是"加监控"）。
3. 这个 LLM 调用挂了什么方案：哪些查询该走、哪些不该走、
   走哪一档模型。给出一条可操作的准入判据，而不是"复杂的走大模型"。
4. **提示注入**：用户查询是要被 LLM 读的文本。给出你的防御层次，
   并指出"哪一层是真正兜底的"。
5. 怎么评测 A 的质量？给出一个不需要人工标注全量查询、
   且能防止"自己给自己打分"的方案。离线指标与线上指标分别是什么。
6. 无结果兜底（B）与 A 的解析结果冲突时，以谁为准？说明这个决策归谁、
   怎么记录，以及为什么它不该由模型决定。"""

    return base(
        'agent-design', 'senior',
        'LLM 进搜索的哪一层：查询理解可做、直接混进精排不可做、以及兜底与解析冲突归谁',
        statement, 'llm-rubric',
        ['query-understanding', 'llm-in-search', 'prompt-injection', 'eval-design',
         'guardrail-ownership', 'modern:agent-ops'],
        src('搜索平台 / Search Platform 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §2.9 与 §3'
            '（素材给出"LLM 可用于查询理解、不进排序主链路"的结论与"需防注入与可解释留痕"，'
            '未给可判分的准入判据、注入兜底层与评测方案）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': 'A/B/C 的判词带延迟与成本量级', 'weight': 2,
                 'criteria': 'C 必须判为**不进排序主链路**，理由至少覆盖两条：'
                             'p95 420ms 的预算里放不下 LLM 打分（且候选是千级）、'
                             '成本随查询量线性放大、不可离线复算 ⇒ 无法归因排序变化。'
                             'A 可做但要说清它加的是**一次串行延迟**（要么并行/要么缓存）；'
                             'B 可做但必须是"规则化的放宽 + LLM 只在无结果冷路径上选放宽方向"，'
                             '不能让 LLM 每次决策。'
                             '只答"A、B 可以，C 不行"而不给量级/预算者此项最多 1 分。'},
                {'label': '结构化输出的可靠性与归因路径', 'weight': 2,
                 'criteria': '必须有：封闭 schema（枚举值而非自由文本、日期用绝对日期而非"周末"、'
                             '**显式的"无法解析"取值**），并且**校验不过就不落地**'
                             '（宁可退回原始查询也不许猜）、'
                             '以及**每条解析结果与查询一起持久化**'
                             '（`query_id + 解析结果 + 模型版本 + prompt 版本 + 置信`）。'
                             '归因路径要能回答"这周转化跌是不是解析错了"：'
                             '能按解析字段回放查询、能对同一批查询跑两个版本做 diff。'
                             '答"加监控/加日志"不得分。'},
                {'label': '准入判据可操作，不是"复杂走大的"', 'weight': 2,
                 'criteria': '判据必须可判定，例如：'
                             '查询长度/是否含时间或数量表达/是否命中既有规则解析器'
                             '（规则能解决的**不送 LLM**）/'
                             '是否是无结果或低置信的**冷路径**/'
                             '该 query 是否已在解析缓存里。'
                             '并要求说明缓存键的维度（含 prompt 与模型版本，否则升级后旧解析复用）。'
                             '"简单的走小模型复杂的走大模型"这种同义反复不得分。'},
                {'label': '注入防御分清哪层真正兜底', 'weight': 1,
                 'criteria': '层次要至少给出输入侧（不信任查询文本、不让它影响输出格式或工具选择）、'
                             '输出侧（**只有 schema 白名单内的字段能落到查询里**、'
                             '枚举值必须存在于字典）、'
                             '以及权限侧（解析结果只能收紧不能凭空放宽约束）。'
                             '真正兜底的是"输出被 schema 与检索权限约束卡住"'
                             ' —— 提示词层的防御只是降噪，不能作为最后防线；'
                             '点出这一点是本项的分水岭。'},
                {'label': '评测不靠人工全量标注、也不自评', 'weight': 2,
                 'criteria': '方案需包含**规则/人工构造的黄金集**（覆盖时间表达、复合约束、'
                             '无解、注入样本等对抗类别）+ 一致性指标'
                             '（同输入两次解析的稳定率）+ **回归式线上代理**'
                             '（无结果率、零点击率、解析字段被实际用于过滤的比率）。'
                             '必须指出"让 LLM 评 LLM 打分"不能当质量结论用：'
                             '被评与评委同分布，一旦 prompt 改动，评分尺度跟着漂。'
                             '加分：说明离线指标涨了线上没动时先看分布漂移。'},
                {'label': '兜底与解析冲突时由规则裁决并留痕', 'weight': 1,
                 'criteria': '必须回答"以谁为准"并给理由：'
                             '解析结果是**用户意图的陈述**，放宽是**平台主动偏离意图**，'
                             '因此默认以解析结果为约束、放宽只在无结果时发生且必须显式标注'
                             '（前端要能区分"这就是你要的"与"我们放宽了 X"）。'
                             '决策归属：产品规范 + 代码常量/配置，可版本化可回滚，'
                             '不是模型自由裁量 —— 理由是它涉及可解释性与合规口径。'},
            ],
            'notes': '总分封顶 5 的情形：认为"给排序模型加 LLM 特征就行"而不区分'
                     '打分与特征；用"加一层校验 + 加监控"糊过第 2 问；'
                     '把提示注入的兜底交给"在 system prompt 里写不许被影响"；'
                     '评测只有"人抽 200 条看看"；'
                     '全文没有出现延迟预算或成本量级的任何数字。',
        },
        estimatedMinutes=40,
        answer="""## 参考答案要点

**三个需求的判词**：C（LLM 直接给候选打分并进精排）不该做 ——
端到端 p95 只有 420ms，其中价格与可用性填充就占 180ms，
千级候选过一遍 LLM 在延迟、成本、可复算三条上同时不成立。
A 可以做，但它加的是一次**串行**延迟，所以必须配解析缓存与规则前置；
B 可以做，但只能落在"无结果"这条冷路径上 —— 热路径上让 LLM 决定放宽方向，
等于把可解释性最好的一个产品行为变成黑盒。

**结构化输出真正值钱的地方是"可回放"**：
每条解析结果与 `query_id`、模型版本、prompt 版本一起持久化，
于是"这周转化是不是解析搞坏了"这个问题有答案路径 ——
能按解析字段回放查询、能对同一批查询跑两个版本做 diff。
反过来，只有日志没有回放能力的系统，出了事只能回滚而不能定位。
校验不过就不落地（退回原始查询），宁可少解析也不许猜：
猜出来的 `宠物友好=true` 会直接删掉用户本来能看到的房源。

**准入判据**要能判定而不是类比：规则解析器能吃下的不送 LLM；
含时间/数量/复合约束表达的才送；无结果或低置信的冷路径优先送；
命中解析缓存的不送。缓存键必须含 prompt 与模型版本 ——
否则升级之后旧解析被无限复用，新模型的效果永远测不出来。

**注入的最后防线不是提示词**。三层里真正兜底的是"输出被 schema 白名单
与检索权限卡住"：解析结果只能落到已有字段、枚举值必须存在于字典、
并且**只允许收紧约束不允许凭空放宽**。
在 system prompt 里写"不要受用户输入影响"只是降噪 ——
它挡不住把内容写进查询的能力，因为危险的不是模型被说服，而是输出被无条件执行。

**评测要避开自评**：黄金集要按对抗类别构造（时间表达、多约束叠加、
无解、注入样本），指标除了准确率还要看**稳定率**（同输入两次是否一致 ——
不一致说明解析在采样上漂）。线上新媒体用无结果率、零点击率、
"解析字段真的被用于过滤的比率"这类代理。
LLM 评 LLM 可以做回归监控，不能做质量结论：评委和被评的是同一分布，
prompt 一改评分尺度跟着漂，那正是自我强化的测量环路。

**冲突归谁**：解析结果是"用户要什么"，放宽是"平台主动偏离"。
默认以解析结果为约束，放宽只在无结果时发生且必须显式标注并留痕；
这条决策属于产品规范 + 可版本化配置，不该由模型裁量 ——
因为它同时涉及可解释性、合规口径和客服话术三个都需要确定性的地方。"""
    )


@draft('sys-airbnb-index-upgrade')
def q_embedding_index_upgrade():
    statement = """## 场景

**你正在面试 Airbnb 的 Data/ML Platform 工程师，45 分钟**

要把搜索的向量召回底座从 v1 embedding 换成 v2。已知事实：

- v1 索引 4.2 亿个 listing 向量，服务侧 ANN 查询 p95 12ms；
- v2 维度从 256 变 768，离线评测的 recall@100 比 v1 高 11 个点；
- 全量重算 embedding 的推理成本约等于 9 天的一个 GPU 池；
- **listing 的内容会变**（改标题、改照片、改价格规则），所以 v2 索引必须持续更新，
  不是一次性产物；
- 排序模型的特征里有 v1 的产物（用户-listing 相似度分）；
- 有一个"以图搜房"入口和两个下游团队直接调用 v1 向量服务。

团队提的方案是"周末停机 6 小时全量重刷"。

## 你要回答的问题

1. 为什么"周末停机全量重刷"这个方案在你接手前就该被否掉？给出至少三条独立理由
   （不要说"不够优雅"）。
2. 给出你的双跑迁移设计：两套索引怎么共存、切流怎么切、
   怎么在**不停机**的前提下处理"内容一直在变"。
3. recall@100 高 11 个点，为什么还不能直接上线？
   说出至少三个必须额外回答的问题，并给出各自的验证方式。
4. 排序特征依赖 v1 产物、还有两个下游直接调用 —— 这两类"消费者"的迁移
   在方案上有何本质不同？谁更难，为什么？
5. 回滚：切到 v2 第三天发现某类查询变差。给出回滚动作、
   以及**回滚之后**你必须回答的那个问题。
6. 迁移期间你要盯的四个指标是什么？其中哪个最容易被忽略而它最关键？"""

    return base(
        'system-design', 'senior',
        'Embedding 底座升级：否掉停机重刷、双跑与持续追新、消费者分类迁移与回滚判据',
        statement, 'llm-rubric',
        ['embedding-upgrade', 'shadow-traffic', 'index-consistency', 'rollback',
         'modern:ml-platform'],
        src('ML Data Platform / 检索底座 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §2.2 与 §3'
            '（素材给出"双索引双塔并跑 + 灰度 + 老索引保留期 + 回滚判据"的要点清单，'
            '未给可判分的否题理由、消费者分类与持续追新机制）'),
        rubric={
            'maxScore': 10,
            'points': [
                {'label': '至少三条独立的否掉停机重刷的理由', 'weight': 2,
                 'criteria': '候选理由需互相独立，例如：'
                             '① 6 小时里搜索的向量召回路整体不可用，而它是**主链路**（无结果率会暴涨）；'
                             '② 重刷完成的那一刻索引已经落后于内容变更，'
                             '缺一个"追平机制"就永远追不上 —— 停机型方案的隐含前提是数据静止，'
                             '而 listing 天天在改；'
                             '③ 一次全量 9 天 GPU 池的花费押在"要么全成要么全废"上，'
                             '中途出问题沉没成本不可回收；'
                             '④ 回滚半径 = 整个索引，无法只回滚一部分；'
                             '⑤ 排序特征与两个下游消费者的切换被迫挤进同一窗口 ⇒ 耦合发布。'
                             '只答"风险大/不够平滑"不得分。'},
                {'label': '双跑设计覆盖"持续追新"这一条', 'weight': 2,
                 'criteria': '必须给出：v1/v2 两套索引并存且有**版本标签**（模型版本 + 索引构建批次），'
                             '新内容与变更内容进 v2 走增量流水线'
                             '（内容变更 ⇒ 重算该 listing 的向量 ⇒ 幂等 upsert），'
                             '切流按**查询侧灰度**（同一份索引不能被两个版本同时读，'
                             '否则 256 维与 768 维会混进同一次 ANN），'
                             '以及"影子查询"（线上真实流量复制打到 v2，只记录不参与结果）。'
                             '关键判据：说清 v2 索引的**新鲜度指标**（变更后多少秒进入索引）'
                             '并把它列入切流前提 —— 新鲜度不达标就不许放量。'},
                {'label': 'recall 高 11 个点为什么不足以支撑上线', 'weight': 2,
                 'criteria': '必须列出并给验证方式，至少三条：'
                             '① 离线评测的 query 分布是否代表线上（尤其长尾与多语言）；'
                             '② recall 提升是否**跨分片均匀**，某些切片可能变差'
                             '（按城市/类目/listing 新旧分层看）；'
                             '③ 召回指标与下游是否一致：recall@100 涨了但精排截断在 top-50 时可能没用；'
                             '④ 与 v1 训出的下游特征/模型是否兼容（换底座会让既有相似度分变成噪声）；'
                             '⑤ 索引体积 ×3 带来的成本与 p95 影响（768 维的 ANN 延迟与内存）。'
                             '验证方式要给具体的分层对比/影子评估，不接受"上线看看"。'},
                {'label': '两类消费者的本质差别，并说清谁更难', 'weight': 2,
                 'criteria': '排序特征是**内部、可版本化、可重算**的：'
                             '加特征版本、双特征并行一段窗口、重训后再切；'
                             '难在"模型训练周期"这个外部依赖，但可控。'
                             '两个下游团队是**外部消费者**：他们的切换节奏不由你决定、'
                             '他们的用法你不可见（可能有离线批量、可能有硬编码 256 维），'
                             '所以更难 —— 解法必须是"接口契约 + 弃用期 + 可观测谁还在调 v1"'
                             '（调用方标识与用量报表），而不是"通知他们"。'
                             '明确判定"外部消费者更难"并给出弃用节奏者得满分。'},
                {'label': '回滚动作 + 回滚之后必须回答的问题', 'weight': 1,
                 'criteria': '动作：查询侧立刻把灰度比例归零回到 v1（因为双跑一直在，'
                             '回滚是**配置级**而非重建级 —— 这正是双跑设计的收益）；'
                             '回滚后必须回答的是"**为什么我们没在上线前发现**"：'
                             '要求补的是评测切片（哪类查询、哪个城市、什么意图）'
                             '并把这条切片永久加进发布前的评估集 ——'
                             '否则同一类问题下次还会穿过。'
                             '只描述回滚不回答"漏检根因"的此项最多 1 分。'},
                {'label': '四个迁移期指标且点名最易忽略的那个', 'weight': 1,
                 'criteria': '需给出：结果一致性代理（离线指标：同查询两版本召回集合的重叠度/Jaccard）、'
                             '线上业务指标（无结果率、点击、成交）、'
                             '性能与成本（p95 与内存/GPU 小时）、'
                             '以及**v2 索引新鲜度（落后当前内容多少）**。'
                             '点名"新鲜度"最易忽略且最关键 ——'
                             '迁移窗口拉两周，如果增量流水线落后，'
                             '切过去用的是"两周前的世界"，'
                             '而所有离线对比都是拿新鲜 v1 与陈旧 v2 比，结论系统性失真。'},
            ],
            'notes': '总分封顶 5 的情形：把双跑说成"两套索引轮流全量重建"；'
                     '认为"离线 recall 涨了就可以上线"；'
                     '对下游只说"提前通知"；'
                     '回滚方案里出现"重建 v1 索引"（说明双跑没做对）；'
                     '全程没有出现"版本"这个词，无法区分哪份结果由哪套底座产生。',
        },
        estimatedMinutes=45,
        answer="""## 参考答案要点

**停机重刷该在评审就被否**，理由要互相独立：
主链路 6 小时不可用（无结果率暴涨，这是用户能直接感知的）；
**重刷结束的那一刻索引就已经落后**，因为 listing 内容天天在改，
停机型方案的隐含假设是数据静止；
9 天 GPU 池的成本押在"全成或全废"上，沉没不可回收；
回滚半径是整个索引，做不到部分回退；
并且它把排序特征与两个外部消费者的切换挤进同一窗口，变成耦合发布。

**双跑的关键不是"两套索引"，而是"增量能追平"**：
v2 必须有内容变更 → 重算该 listing 向量 → 幂等 upsert 的流水线，
并把**新鲜度**（变更后多少秒进索引）作为放量前提 ——
新鲜度不达标就不许继续切流。
切流按查询侧灰度，且一次查询不许混读两个版本
（256 维与 768 维混进同一次 ANN 是灾难，而它只需要一个漏掉版本标签的分支就会发生）。
影子查询（复制真实流量打到 v2，只记录不参与结果）是唯一能在
不改用户的前提下拿到线上分布证据的手段。

**recall +11 点不足以上线**，因为离线评测至少四件事没被回答：
query 分布是否代表线上（长尾、多语言）；提升是否**跨切片均匀**
（按城市/类目/新旧分层看，很可能新 listing 变差，而新供给扶持正是产品目标）；
recall@100 与精排截断位是否相关（截在 top-50 时前面的召回可能根本没变）；
以及 768 维带来的延迟与内存成本是否吞掉收益。
验证方式必须是分层对比 + 影子评估，而不是"上线看看"。

**两类消费者里外部消费者更难**：
排序特征是内部、可版本化、可重算的，难在训练周期但可控；
外部团队的切换节奏不由你决定、用法你不可见（可能硬编码 256 维、可能离线批量），
所以只能靠"接口契约 + 弃用期 + **谁还在调 v1 的用量报表**"来收敛。
通知是无效的：没有观测手段的弃用等于没有弃用。

**回滚是配置级的** —— 这正是双跑买来的东西。
而回滚之后真正要回答的是"为什么上线前没发现"，
产出是把那类切片永久加进发布前评估集，否则同类问题下次照样穿过。

**最容易被忽略的指标是 v2 索引新鲜度**：
迁移窗口拉长两周，如果增量落后，切过去用的是"两周前的世界"，
而所有离线比较都是拿**新鲜的 v1** 与**陈旧的 v2** 比 ——
结论系统性偏负，团队会因此做出错误决策（要么放弃 v2，要么回滚一个其实更好的版本）。"""
    )


# =================================================================== 新供给曝光份额
@draft('fe-airbnb-exposure-share')
def q_exposure_share():
    """
    期望值由 share() 算出，并且测试文件里的断言**也从同一个模型生成** ——
    react-vitest 题的判分事实来源是测试文件，手抄断言=第二个漂移入口。
    """
    import json as _json

    def share(rows):
        if rows is None:
            raise ValueError('rows must be an array')
        for r in rows:
            if r is None:
                raise ValueError('row must be an object')
            if not isinstance(r.get('segment'), str) or r['segment'] == '':
                raise ValueError('segment must be a non-empty string')
            if not isinstance(r.get('supply'), int) or r['supply'] < 0:
                raise ValueError('supply must be >= 0')
            im = r.get('impressions')
            if im is not None and (not isinstance(im, int) or im < 0):
                raise ValueError('impressions must be >= 0 or null')
        segs = {r['segment'] for r in rows}
        if len(segs) != len(rows):
            raise ValueError('duplicated segment')

        # 未采集的那一段**两边都要剔**：只剔一边，份额之和就不再等于 100
        tracked = [r for r in rows if r['impressions'] is not None]
        total_supply = sum(r['supply'] for r in tracked)
        total_impr = sum(r['impressions'] for r in tracked)

        def pct(part, whole):
            return 0.0 if whole == 0 else round(part * 100.0 / whole, 2)

        out = []
        for r in rows:
            if r['impressions'] is None:
                out.append({'segment': r['segment'], 'supplySharePct': None,
                            'exposureSharePct': None, 'gapPct': None,
                            'underExposed': False, 'untracked': True})
                continue
            ss = pct(r['supply'], total_supply)
            es = pct(r['impressions'], total_impr)
            out.append({'segment': r['segment'], 'supplySharePct': ss, 'exposureSharePct': es,
                        'gapPct': round(es - ss, 2),
                        'underExposed': es < ss * 0.8, 'untracked': False})
        return out

    def js(value):
        return _json.dumps(value, ensure_ascii=False)

    SPECS = [
        ('基线：新供给只拿到 1.2% 曝光，判为投放不足',
         [{'segment': 'new', 'supply': 60, 'impressions': 120},
          {'segment': 'established', 'supply': 940, 'impressions': 9880}], None),
        ('份额分母是总量而不是行平均：两行的段权重要按供给算',
         [{'segment': 'a', 'supply': 100, 'impressions': 40},
          {'segment': 'b', 'supply': 100, 'impressions': 960}], None),
        ('未采集的那一段：供给与曝光两侧都剔除',
         [{'segment': 'a', 'supply': 400, 'impressions': 500},
          {'segment': 'b', 'supply': 400, 'impressions': 500},
          {'segment': 'broken', 'supply': 200, 'impressions': None}], None),
        ('阈值是严格小于：正好 0.8 倍不算投放不足',
         [{'segment': 'x', 'supply': 100, 'impressions': 400},
          {'segment': 'y', 'supply': 100, 'impressions': 600}], None),
        ('零曝光的一段：份额 0 且必然判为不足',
         [{'segment': 'z', 'supply': 50, 'impressions': 0},
          {'segment': 'w', 'supply': 50, 'impressions': 900}], None),
        ('退化：完全没有曝光数据 ⇒ 两侧分母都是 0，份额全记 0',
         [{'segment': 'a', 'supply': 0, 'impressions': 0}], None),
        ('退化：没有任何分段', [], None),
        ('非法：分段名重复', [{'segment': 'a', 'supply': 1, 'impressions': 1},
                             {'segment': 'a', 'supply': 2, 'impressions': 2}], 'duplicated segment'),
        ('非法：供给为负', [{'segment': 'a', 'supply': -1, 'impressions': 1}], 'negative supply'),
        ('非法：曝光为负', [{'segment': 'a', 'supply': 1, 'impressions': -5}], 'negative impressions'),
        ('非法：分段名是空串', [{'segment': '', 'supply': 1, 'impressions': 1}], 'empty segment'),
    ]

    cases = []
    for name, rows, err in SPECS:
        if err:
            cases.append({'name': name, 'input': [rows], 'expected': None,
                          'expectThrow': 'Error', 'throwMessage': err})
        else:
            cases.append({'name': name, 'input': [rows], 'expected': share(rows)})

    tl = ["import { describe, expect, it } from 'vitest';",
          "import { exposureShare } from './Solution';",
          '',
          '/**',
          ' * 断言由 gen.py 里的同一个 share() 模型生成，不手抄 ——',
          ' * react-vitest 题的判分事实来源就是这份测试文件，抄错一次就永久错一次。',
          ' */',
          "describe('exposureShare：曝光份额与供给份额', () => {"]
    for c in cases:
        arg = js(c['input'][0])
        tl.append(f"  it({js(c['name'])}, () => {{")
        if c.get('expectThrow'):
            tl.append(f"    expect(() => exposureShare({arg} as never)).toThrow({js(c['throwMessage'])});")
        else:
            tl.append(f"    expect(exposureShare({arg})).toEqual({js(c['expected'])});")
        tl.append('  });')
    tl.append('});')
    test_file = '\n'.join(tl)

    statement = """## 背景

产品要求"新供给（上架 <7 天）的曝光份额要跟上它的供给份额"。
看板上一行字写着：新供给占供给 6%、只拿到 1.2% 曝光。
这两个数都是"份额"，而份额类指标的算法错误几乎从不报错 —— 它只是让结论反过来。

## 你要实现的入口

```ts
export interface SegmentRow {
  segment: string;             // 非空、不重复
  supply: number;              // 该分段的房源数，>= 0
  impressions: number | null;  // 该分段的曝光数；null = 这一段曝光未采集
}

export interface SegmentShare {
  segment: string;
  supplySharePct: number | null;
  exposureSharePct: number | null;
  gapPct: number | null;
  underExposed: boolean;
  untracked: boolean;
}

export function exposureShare(rows: SegmentRow[]): SegmentShare[]
```

## 口径（逐条都是判分点）

1. **份额的分母是总量，不是行平均。**
   `supplySharePct = 该段 supply / Σ supply × 100`，`exposureSharePct` 同理。
   结果 `ROUND` 到 2 位小数（用 `Math.round(x * 100) / 100`）。
2. **`impressions === null` 的段整条退出统计**：
   它的 `supply` **也不能进供给分母**。
   这条段自己的输出是 `supplySharePct / exposureSharePct / gapPct = null`、
   `underExposed = false`、`untracked = true`。
   只从曝光侧剔除而留着供给侧，会让"其它段的供给份额之和"超过 100% ——
   这是份额类看板最常见也最难被发现的错。
3. `gapPct = exposureSharePct - supplySharePct`（可为负，负得越多越是投放不足）。
4. `underExposed = exposureSharePct < supplySharePct × 0.8`。
   **严格小于**：正好等于 0.8 倍不算不足。
5. `supplySharePct` 的分母为 0（没有任何有效供给）⇒ 该字段输出 `0`（不是 `null`）——
   `null` 在本契约里专门表示"这一段未采集"，两种"没有数"必须能区分。
6. 输出顺序与输入顺序一致（不排序）。空输入 ⇒ 空数组。

## 抛错（`throw new Error(...)`，消息必须一致）

`rows` 不是数组 ⇒ `'rows must be an array'`；
某行是 `null` ⇒ `'row must be an object'`；
`segment` 不是非空字符串 ⇒ `'empty segment'`；
`supply` 不是非负整数 ⇒ `'negative supply'`；
`impressions` 既不是 `null` 也不是非负整数 ⇒ `'negative impressions'`；
`segment` 重复 ⇒ `'duplicated segment'`。

不许引入第三方依赖。"""

    reference = """export interface SegmentRow {
  segment: string;
  supply: number;
  impressions: number | null;
}

export interface SegmentShare {
  segment: string;
  supplySharePct: number | null;
  exposureSharePct: number | null;
  gapPct: number | null;
  underExposed: boolean;
  untracked: boolean;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export function exposureShare(rows: SegmentRow[]): SegmentShare[] {
  if (!Array.isArray(rows)) throw new Error('rows must be an array');
  const seen = new Set<string>();
  for (const r of rows) {
    if (r === null || r === undefined) throw new Error('row must be an object');
    if (typeof r.segment !== 'string' || r.segment === '') throw new Error('empty segment');
    if (!Number.isInteger(r.supply) || r.supply < 0) throw new Error('negative supply');
    if (r.impressions !== null && (!Number.isInteger(r.impressions) || r.impressions < 0)) {
      throw new Error('negative impressions');
    }
    if (seen.has(r.segment)) throw new Error('duplicated segment');
    seen.add(r.segment);
  }

  // 未采集的那一段两侧都剔：只剔一边，剩下各段的供给份额之和就会超过 100%
  const tracked = rows.filter((r) => r.impressions !== null);
  const totalSupply = tracked.reduce((n, r) => n + r.supply, 0);
  const totalImpr = tracked.reduce((n, r) => n + (r.impressions as number), 0);
  const pct = (part: number, whole: number) => (whole === 0 ? 0 : round2((part * 100) / whole));

  return rows.map((r) => {
    if (r.impressions === null) {
      return { segment: r.segment, supplySharePct: null, exposureSharePct: null,
               gapPct: null, underExposed: false, untracked: true };
    }
    const supplySharePct = pct(r.supply, totalSupply);
    const exposureSharePct = pct(r.impressions, totalImpr);
    return {
      segment: r.segment,
      supplySharePct,
      exposureSharePct,
      gapPct: round2(exposureSharePct - supplySharePct),
      underExposed: exposureSharePct < supplySharePct * 0.8,
      untracked: false,
    };
  });
}"""

    naive = """export function exposureShare(rows: any[]): any[] {
  // 行平均版：每段自己除以"本段供给 + 本段曝光"，再和邻居比 —— 份额根本不是份额
  const avgSupply = rows.reduce((n, r) => n + r.supply, 0) / Math.max(rows.length, 1);
  const tracked = rows.filter((r) => r.impressions !== null);
  const avgImpr = tracked.reduce((n, r) => n + r.impressions, 0) / Math.max(tracked.length, 1);
  return rows.map((r) => {
    const supplySharePct = Math.round((r.supply / avgSupply) * 10000) / 100;
    const exposureSharePct =
      r.impressions === null ? 0 : Math.round((r.impressions / avgImpr) * 10000) / 100;
    return {
      segment: r.segment,
      supplySharePct,
      exposureSharePct,
      gapPct: exposureSharePct - supplySharePct,
      // 错在只从曝光侧剔除，未采集那段的 supply 仍留在供给分母里
      underExposed: exposureSharePct <= supplySharePct * 0.8,
      untracked: false,
    };
  });
}"""

    answer = """## 参考答案要点

两次求和（`Σ supply`、`Σ impressions`）只在**有效段**上算，
然后对每段做 `part / whole × 100` 并四舍五入两位；未采集段直接返回一组 `null`。
真正的判分点不在算术，在两条口径：分母是总量还是行平均；未采集段是否两侧都剔。

**"份额"的分母是整体，不是"段的平均值"**（用例「份额分母是总量而不是行平均」）：
`a`、`b` 两段供给各 100、曝光 40/960。
按总量算 ⇒ 供给份额各 50%、曝光份额 4%/96% ⇒ `a` 严重投放不足；
按行平均算 ⇒ 每段都是"自己除以平均"，两段供给份额都是 100%，
差异被抹平，看板上显示"新供给与成熟供给曝光一致"。
份额指标最阴的地方在于**行平均版本看起来更"正常"**（数值都在 100 附近），
所以没人会怀疑。

**未采集段必须两侧都剔**（用例「未采集的那一段：供给与曝光两侧都剔除」）：
数据 `a(400/500) b(400/500) broken(200/null)`。
正确：有效供给 800 ⇒ a、b 各 50%；`broken` 三个数是 `null` 且 `untracked=true`。
只从曝光侧剔 ⇒ 有效供给按 1000 算 ⇒ a、b 各 40%，
于是**所有段的供给份额之和 = 80% 而不是 100%** ——
这个不自洽不会报错，只会让每个段都"看起来少了一点"，
产品结论变成"所有分段投放都不足"，而真实原因是某段的埋点断了。
**份额类指标要写一条断言：可统计段的份额之和应约等于 100。**
（本实现里它就是 `50 + 50 = 100`。）

**`null` 与 `0` 是两件事**（规则 5）：
`null` 表示"这一段没有采集"，`0` 表示"采集了，值是零/分母为零"。
把未采集显示成 0%，运营会以为该段真的没曝光而去查投放，
而真相是数据管道断了 —— 与 SRM 那道题里"把埋点丢失算成无结果"是同一个错误家族。

**阈值方向**（用例「阈值是严格小于：正好 0.8 倍不算投放不足」）：
`x` 供给份额 50%、曝光份额 40%，正好是 0.8 倍 ⇒ `underExposed = false`。
写成 `<=` 会把"正好卡在阈值"的段全部标红，
于是徽标失去区分度，一周后没人再看它 —— **告警的失效通常不是漏报，是滥报**。

**工程延伸（面试追问点）**

1. 为什么"新供给 6% / 曝光 1.2%"这种比较要小心？
   （供给份额按房源数算，曝光份额按曝光次数算 —— 一个 listing 的曝光次数受它在榜时间影响。
   新供给刚上架几天，天然分母窗口不同。诚实的对比是"按 listing-天"归一，
   或者按同龄段（同为上架 0-7 天）互比。）
2. 扶持要设上限吗？（要，而且上限必须是**可退出的**：
   按质量信号（转化率、取消率、评价）动态退出，否则"扶持"变成长期补贴，
   排序不再反映真实相关性，最终反噬成交。）
3. 看板怎么防"份额不自洽"这类静默错误？
   （把不变量做成断言并在页面渲染：可统计段的供给份额之和、曝光份额之和
   都应在 100±0.5 内，超界就在表头挂一个"数据不自洽"的提示 ——
   而不是等到有人肉眼发现每段都少了 10%。）"""

    return base(
        'frontend', 'senior',
        '新供给曝光份额：分母是总量不是行平均，未采集段两侧都要剔',
        statement, 'react-vitest',
        ['share-metric', 'denominator-consistency', 'null-vs-zero', 'alert-threshold',
         'modern:marketplace-rules'],
        src('搜索与发现 / 前端平台 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §4 与 §2.3'
            '（素材给出现象"新供给占 6% 供给只拿到 1.2% 曝光"与冷启扶持要点，'
            '未给可判分的份额口径与未采集处理）'),
        language='typescript',
        cases=cases,
        runner={'entry': 'function', 'timeoutMs': 45000,
                'files': [{'path': 'exposure.test.ts', 'content': test_file}],
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=26,
        answer=answer,
    )


# =================================================================== 训练特征的时点正确性
@draft('bd-airbnb-feature-freshness')
def q_feature_freshness():
    """
    expected 由 pick() 从观测行集算出（Python 侧按元组排序取最后一项，
    Spark 侧用 max(struct(...)) —— 两边同结果才说明口径没有歧义）。
    """
    OBS = [
        # obs_id, row_id, listing_id, feature, as_of_query, observed_at, value
        (1, 1, 101, 'price', '2026-06-01 12:00:00', '2026-06-01 09:00:00', 120.5),
        (2, 1, 101, 'price', '2026-06-01 12:00:00', '2026-05-30 08:00:00', 99.99),
        (3, 1, 101, 'price', '2026-06-01 12:00:00', '2026-06-03 18:00:00', 310.0),
        (4, 1, 101, 'supply_days', '2026-06-01 12:00:00', '2026-06-01 12:00:00', 7.0),
        (5, 1, 101, 'supply_days', '2026-06-01 12:00:00', '2026-05-01 00:00:00', 3.0),
        (6, 1, 101, 'host_reply', '2026-06-01 12:00:00', '2026-06-02 10:00:00', 0.91),
        (7, 2, 102, 'price', '2026-06-05 00:00:00', '2026-06-04 23:59:59', 88.0),
        (8, 2, 102, 'price', '2026-06-05 00:00:00', '2026-06-04 23:59:59', 87.0),
        (9, 2, 102, 'price', '2026-06-05 00:00:00', '2026-06-05 00:00:00', 90.0),
        (10, 3, 103, 'price', '2026-06-10 08:00:00', '2026-06-11 08:00:00', 45.0),
        (11, 3, 103, 'price', '2026-06-10 08:00:00', '2026-06-12 08:00:00', 46.0),
    ]
    COLUMNS = ['row_id', 'feature', 'value', 'obs_id_used', 'future_count']

    def pick(rows):
        groups = {}
        for r in rows:
            groups.setdefault((r[1], r[3]), []).append(r)
        out = []
        for (row_id, feature) in sorted(groups):
            as_of = groups[(row_id, feature)][0][4]
            past = [r for r in groups[(row_id, feature)] if r[5] <= as_of]
            future = [r for r in groups[(row_id, feature)] if r[5] > as_of]
            if past:
                chosen = max(past, key=lambda r: (r[5], r[0]))   # 时刻最新；并列取 obs_id 最大
                out.append({'row_id': row_id, 'feature': feature, 'value': chosen[6],
                            'obs_id_used': chosen[0], 'future_count': len(future)})
            else:
                out.append({'row_id': row_id, 'feature': feature, 'value': None,
                            'obs_id_used': None, 'future_count': len(future)})
        return out

    COLS = ['obs_id', 'row_id', 'listing_id', 'feature', 'as_of_query', 'observed_at', 'value']
    SCHEMA = ('obs_id int, row_id int, listing_id int, feature string, '
              'as_of_query string, observed_at string, value double')

    def case(name, mutations=(), note=None):
        """
        pyspark 题的每个用例自带一份行集（没有共享的 setup 表），
        所以变异只作用在内存行上，再由同一份行集派生 expected —— SQL 不参与。
        """
        rows = list(OBS)
        for mut in mutations:
            if mut[0] == 'del':
                rows = [r for r in rows if r[0] != mut[1]]
            elif mut[0] == 'upd':
                _, obs_id, col, value = mut
                idx = COLS.index(col)
                rows = [r[:idx] + (value,) + r[idx + 1:] if r[0] == obs_id else r for r in rows]
            elif mut[0] == 'ins':
                rows.append(mut[1])
            else:
                raise AssertionError(f'未知变异 {mut[0]}')
        payload = {'name': name,
                   'input': {'view': 'feature_observations', 'schema': SCHEMA,
                             'rows': [dict(zip(COLS, r)) for r in rows]},
                   'expected': pick(rows)}
        return {**payload, **({'note': note} if note else {})}

    statement = """## 输入

PySpark 3.5（判题容器内）。工作区里已经注册好一张表：

```
feature_observations(
  obs_id INT, row_id INT, listing_id INT, feature STRING,
  as_of_query STRING,      -- 该训练样本的**查询时刻**（同一 row_id 内恒定），'yyyy-MM-dd HH:mm:ss'
  observed_at STRING,      -- 这条特征值被观测到的时刻，同上格式
  value DOUBLE)
```

一行 = 一个"某样本的某特征在某时刻被观测到"的事实。同一个 `(row_id, feature)`
会有多条观测，**其中一些的时间晚于 `as_of_query`**（那是上线之后才会出现的数据）。

## 任务

实现 `solve(spark)`，返回**时点正确的训练特征表**，列为：

```
row_id, feature, value, obs_id_used, future_count
```

按 `row_id`、`feature` 升序。每个 `(row_id, feature)` 输出**一行**。

## 口径（逐条都是判分点）

1. **可见性以 `as_of_query` 为界**：只有 `observed_at <= as_of_query` 的观测可用。
   **等号算可见**（查询发生在那一刻，那一刻已经存在的值是看得到的）。
2. 从可见观测里取 `observed_at` 最新的一条；
   **若同一时刻有多条，取 `obs_id` 最大的那条**（确定性要求 —— 不定义 tie-break 的实现
   在同一份数据上两次跑可能给出不同 `value`）。
3. `value` / `obs_id_used` 就是被选中的那条观测的值与 `obs_id`。
   **没有任何可见观测 ⇒ 两列都是 `null`**（不许回退去用未来值，也不许填 0）。
4. `future_count` = 该 `(row_id, feature)` 下 `observed_at > as_of_query` 的观测条数
   （可以为 0）。它是"这个样本有多容易被取错时间而泄漏"的量度 —— 特征值本身可能一模一样，
   但**只要有一条未来观测存在，写错的 join 就会悄悄改变结果**。

## 这题真正考的东西

- **`<= as_of_query` 与 `<= label_ts` 的区别不会让作业失败**。
  用标签时刻做可见性边界，训练集照样跑通、离线 AUC 还会**变高**
  （因为它提前看到了"价格已经涨到 310"这类与成交结果同源的信息），
  上线后指标掉下去，而没人会怀疑特征生成器 —— 这就是"时点正确性"这一整类事故的形状。
- **"取最新"必须有确定性的并列规则**。同一秒批量灌进来的观测很常见
  （上游一次跑批写多条），按 Spark 分区顺序随便取一条，
  结果是**同一份数据两次训练产出不同模型**，再也无法复现。
- `future_count` 是本题唯一的**产出侧**要求：
  它让下游可以在不重跑训练的情况下筛掉"高危样本"（比如只保留 `future_count = 0` 的样本
  做一致性对照）。泄漏防不住的时候，至少要能度量。

## 约束

不许 `collect()` 全表到驱动侧再算；不许建 UDF 做 Python 循环遍历；
只允许 DataFrame / Spark SQL 算子。输入表可能有几十万行。"""

    reference = """import pyspark.sql.functions as F


def solve(spark):
    obs = spark.table('feature_observations')

    # max(struct(...)) 按字段顺序逐位比较 ⇒ 先比 observed_at，再比 obs_id，
    # 正好是"时刻最新、并列取 obs_id 最大"。当量级不可见时 when 给 null，max 会忽略 null。
    visible = F.when(F.col('observed_at') <= F.col('as_of_query'),
                     F.struct(F.col('observed_at'), F.col('obs_id'), F.col('value')))

    picked = obs.groupBy('row_id', 'feature').agg(
        F.max(visible).alias('pick'),
        F.sum(F.when(F.col('observed_at') > F.col('as_of_query'), 1).otherwise(0))
         .alias('future_count'),
    )

    return picked.select(
        F.col('row_id'),
        F.col('feature'),
        F.col('pick.value').alias('value'),
        F.col('pick.obs_id').alias('obs_id_used'),
        F.col('future_count').cast('int').alias('future_count'),
    ).orderBy('row_id', 'feature')"""

    naive = """import pyspark.sql.functions as F


def solve(spark):
    obs = spark.table('feature_observations')

    # "取最新"版：完全不看 as_of_query —— 这正是离线虚高、上线掉点的那个实现
    picked = obs.groupBy('row_id', 'feature').agg(
        F.max(F.struct(F.col('observed_at'), F.col('obs_id'), F.col('value'))).alias('pick'),
        F.lit(0).alias('future_count'),
    )

    return picked.select(
        F.col('row_id'),
        F.col('feature'),
        F.col('pick.value').alias('value'),
        F.col('pick.obs_id').alias('obs_id_used'),
        F.col('future_count'),
    ).orderBy('row_id', 'feature')"""

    answer = """## 参考答案要点

一次 `groupBy('row_id','feature')` 出两件事：
`max(when(observed_at <= as_of_query, struct(observed_at, obs_id, value)))` 取可见的最新一条，
`sum(when(observed_at > as_of_query, 1))` 出 `future_count`。
`struct` 的比较顺序（先 `observed_at` 再 `obs_id`）刚好就是 tie-break 规则，
所以不需要窗口函数、也不需要把数据 `collect` 到驱动侧。
不可见时 `when` 给 `null` 而 `max` 忽略 `null` ⇒ 全未来时整列自然为 `null`，
不需要额外的"没有可见观测"分支。

**基线手算一遍（用来核对 expected 是不是真的对）**：
- `(1, price)`：可见 obs 1（09:00, 120.5）与 obs 2（05-30, 99.99）；obs 3 在 06-03 ⇒ 未来。
  ⇒ `value=120.5, obs_id_used=1, future_count=1`。
  **不按时点取会拿到 310.0**（obs 3 是"涨价之后"的价格，而它恰恰是成交的原因之一 ——
  这就是标签泄漏最典型的形态：特征与标签来自同一次状态变化）。
- `(1, supply_days)`：obs 4 的 `observed_at` **正好等于** `as_of_query` ⇒ 可见且更新 ⇒
  `value=7.0, obs_id_used=4, future_count=0`。写成 `<`（不含等号）会退回 3.0。
- `(1, host_reply)`：obs 6 晚于查询 ⇒ 没有可见观测 ⇒ `value=null, obs_id_used=null, future_count=1`。
  填 0 的实现会造出一个"房东回复率 0%"的假样本，模型会学到"这类房源很差"。
- `(2, price)`：obs 7 与 8 **同一时刻**（06-04 23:59:59）⇒ 取 `obs_id` 最大的 8 ⇒ `value=87.0`；
  obs 9 正好在查询时刻 ⇒ 可见且更晚 ⇒ 实际取的是 obs 9（`value=90.0, obs_id_used=9`）。
  这一条同时钉住"等号可见"和"tie-break"两点。
- `(3, price)`：两条全在未来 ⇒ `null/null`，`future_count=2`。

**为什么"不定义并列规则"是正确性问题而不是风格问题**：
`max(struct)` 与"随便取一条"在数据上给的是同一个**分布**，
但在两次运行中可能给出不同的 `obs_id` —— 于是同一份训练集两次产出不同模型。
一个无法复现的训练管道，之后所有的 A/B 结论都要打折。

**`observed_at` 用字符串比较为什么在这里是安全的**：
格式固定 `yyyy-MM-dd HH:mm:ss`，字典序与时间序一致。
真实系统里更稳的做法是存 timestamp 或 epoch 毫秒；
本题沿用题库既有约定（输入是 JSON 行集），但这是**依赖格式纪律**的取舍，
一旦上游混进 `2026-6-1 9:0:0` 就会静默排错序 —— 值得在契约里显式声明。

**工程延伸（面试追问点）**

1. 怎么自动发现"未来信息"？（两种可执行检查：① 生成特征时断言所有被用的
   `observed_at <= as_of_query`（本题就是它的数据结构版本）；
   ② 时间旅行反事实：用 `T-Δ` 与 `T` 各生成一份特征，比较标签可分性 ——
   如果只用 `T` 的那份 AUC 明显更高，说明有东西跨过了时间边界。）
2. 慢变特征和快变特征的存法不同怎么办？（快变（价格、可订天数）必须带观测时间且进
   时间旅行表；慢变（房源类型、城市）可以用维表的 SCD2 区间。
   两者混在一套 join 里是"时点正确性"最常被破坏的地方 ——
   因为 SCD2 的 `start_date` 语义和"最后一次观测"语义不等价。）
3. `future_count` 高说明什么？（说明该样本的**特征在查询后不久就变了**，
   这类样本对"用错时间"最敏感，也是对线上表现预测力最弱的：
   线上只有过去，训练里有未来可选。可以把 `future_count = 0` 的样本单独做一个对照集。）
4. 要不要把不可见的特征直接丢掉整行？（不。`null` + `value_missing` 标记更诚实：
   丢行会让样本分布偏移（越新的房源越容易没有历史观测，丢掉等于系统性歧视新供给），
   而这正是上一题"新供给曝光不足"的另一种发生方式。）"""

    return base(
        'big-data', 'senior',
        '训练特征的时点正确性：可见性以查询时刻为界，并列要有确定规则',
        statement, 'pyspark',
        ['point-in-time', 'feature-store', 'label-leakage', 'determinism',
         'modern:ml-platform'],
        src('ML Data Platform / 特征平台 高级工程师',
            'content/knowledge/hot-interviews/airbnb-search-ranking.md §1"时点正确性"与 §2.6'
            '（素材给出"特征必须用查询时刻可见的值；用未来值 = 离线虚高上线掉点"这条原则，'
            '未给可判分的可见性边界与并列规则）'),
        language='python',
        cases=[
            case('基线：未来价格不许进训练集，并列取 obs_id 最大',
                 note='(1,price) 120.5 而不是 310.0；(1,supply_days) 等号可见取 7.0；'
                      '(1,host_reply) 全未来 ⇒ null'),
            case('把等号改成不含：正好在查询时刻的那条观测被踢出可见集',
                 [('del', 4)],
                 note='(1,supply_days) 退回 obs 5 的 3.0 —— 这条用例专门钉"等号算可见"'),
            case('把未来观测挪到查询之前：泄漏样本转正',
                 [('upd', 3, 'observed_at', '2026-06-01 11:00:00')],
                 note='(1,price) 变成 310.0、future_count 归 0 —— '
                      '证明未来/可见的划分确实是按 as_of_query 算的'),
            case('删掉 (1,price) 的两条可见观测：只剩未来值 ⇒ null 而不是 0',
                 [('del', 1), ('del', 2)],
                 note='(1,price) 只剩 obs 3（未来）⇒ value/obs_id_used 都 null、future_count 1'),
            case('同一时刻两条并列 + 再插一条更早的：并列规则要确定',
                 [('ins', (12, 2, 102, 'price', '2026-06-05 00:00:00',
                           '2026-06-04 23:59:59', 86.0))],
                 note='obs 7/8/12 同刻、obs 9 更晚 ⇒ 仍取 obs 9；把 obs 9 删掉才会落到 12'),
            case('退化：只有一条观测',
                 [('del', i) for i in [1, 2, 3, 4, 5, 6, 7, 8, 9, 11]],
                 note='只剩 obs 10（row 3 的未来观测）⇒ 一行输出且三个数都是 null/null/1'),
        ],
        runner={'entry': 'function', 'orderSensitive': False, 'timeoutMs': 90000,
                'referenceSolution': reference, 'naiveSolution': naive},
        estimatedMinutes=30,
        answer=answer,
    )


@draft('sql-airbnb-hold-overlap-audit')
def q_hold_overlap_audit():
    """
    占用表是真相，锁只是效率手段 —— 这句话能被写成一条 SQL：
    把"有效占用"两两配对，半开区间重叠的就是事故，并按锁的生死分三类。
    行集只声明一次，expected 由 Python 模型从行集算出；用例的变异只有 DELETE / UPDATE 两种。
    """
    from datetime import date, datetime

    AS_OF = datetime(2026, 9, 15, 12, 0, 0)

    # hold_id, listing_id, guest_id, start, end, state, held_until
    HOLDS = [
        (1, 1, 901, date(2026, 9, 20), date(2026, 9, 25), 'COMMITTED', None),
        (2, 1, 902, date(2026, 9, 24), date(2026, 9, 28), 'COMMITTED', None),
        (3, 1, 903, date(2026, 9, 25), date(2026, 9, 27), 'COMMITTED', None),   # 与 1 同日退房即入住
        (4, 1, 904, date(2026, 9, 21), date(2026, 9, 22), 'HELD', datetime(2026, 9, 16, 0, 0, 0)),
        (5, 1, 905, date(2026, 9, 20), date(2026, 9, 21), 'HELD', datetime(2026, 9, 14, 0, 0, 0)),  # 锁已过期
        (6, 2, 906, date(2026, 10, 1), date(2026, 10, 5), 'COMMITTED', None),
        (7, 2, 907, date(2026, 10, 2), date(2026, 10, 3), 'CANCELLED', None),
        (8, 2, 908, date(2026, 10, 3), date(2026, 10, 8), 'HELD', datetime(2026, 9, 18, 0, 0, 0)),
        (9, 3, 909, date(2026, 11, 1), date(2026, 11, 5), 'HELD', datetime(2026, 9, 17, 0, 0, 0)),
        (10, 3, 910, date(2026, 11, 4), date(2026, 11, 6), 'HELD', datetime(2026, 9, 17, 0, 0, 0)),
        (11, 4, 911, date(2026, 1, 1), date(2027, 1, 1), 'COMMITTED', None),    # 整年长租
        (12, 4, 912, date(2026, 6, 1), date(2026, 6, 10), 'COMMITTED', None),   # 被 11 完全包含
        (13, 5, 913, date(2026, 9, 20), date(2026, 9, 25), 'COMMITTED', None),  # 与 1 同日期、不同 listing
    ]
    COLUMNS = ['listing_id', 'hold_a', 'hold_b', 'conflict_kind', 'overlap_days']

    def live(rows):
        """有效占用：已提交，或"锁窗口还没到点"的持有。"""
        return [r for r in rows
                if r[5] == 'COMMITTED' or (r[5] == 'HELD' and r[6] is not None and r[6] >= AS_OF)]

    def audit(rows):
        pool = sorted(live(rows), key=lambda r: r[0])
        out = []
        for i in range(len(pool)):
            for j in range(i + 1, len(pool)):
                a, b = pool[i], pool[j]
                if a[1] != b[1]:
                    continue                                     # 不同 listing 从不冲突
                if not (a[3] < b[4] and b[3] < a[4]):
                    continue                                     # 半开区间：退房日那一晚不占用
                days = (min(a[4], b[4]) - max(a[3], b[3])).days
                states = {a[5], b[5]}
                kind = ('double-commit' if states == {'COMMITTED'}
                        else 'lock-contention' if states == {'HELD'} else 'lock-breach')
                out.append([a[1], a[0], b[0], kind, days])
        return sorted(out, key=lambda r: (r[0], r[1], r[2]))

    def case(name, delete=(), updates=(), note=None):
        """变异只有两种形状，SQL 与派生共用同一份描述（见 q_srm_audit 的同名注释）。"""
        kept = [r for r in HOLDS if r[0] not in set(delete)]
        patched = []
        for r in kept:
            for target, column, value in updates:
                if r[0] == target:
                    r = list(r)
                    r[column] = value
            patched.append(r)
        sql = [f'DELETE FROM hold WHERE hold_id = {i}' for i in delete]
        for target, column, value in updates:
            literal = f"'{value}'" if isinstance(value, str) else ('NULL' if value is None else f"'{value}'")
            sql.append(f'UPDATE hold SET {COLS[column]} = {literal} WHERE hold_id = {target}')
        rows = audit(patched)
        # 空结果集的用例**必须写成裸数组 `[]`**（`docs/JUDGING.md` 的 mysql 段，第 79 行）：
        # `mysql --batch` 在 0 行时连表头都不输出，runner 拿不到列名，带 `columns` 的期望
        # 会报"列名不一致：期望 [...]，实际 []"。`sql-mysql-0011` 第一次也栽在这上面 ——
        # 这次是矩阵替我把它抓回来了（我自己的预检比判题器弱，所以放行了，见 probe_sql_draft.py）。
        payload = {'name': name, 'input': sql, 'expected': rows if not rows else
                   {'columns': COLUMNS, 'rows': rows, 'orderSensitive': True}}
        if note:
            payload['note'] = note
        return payload

    COLS = {3: 'start_date', 4: 'end_date', 5: 'state', 6: 'held_until'}

    statement = """## 基线

MySQL 8.0，默认 `ONLY_FULL_GROUP_BY`。当前时刻放在单行表 `clock` 里（**每条语句都是新连接，
会话变量不跨语句**，所以别指望 `SET @as_of` 还能在下一条里用到 —— 提交就一条查询，自己 cross join 拿）。

```
clock  (as_of DATETIME)                       -- 只有一行
hold   (hold_id INT PRIMARY KEY, listing_id INT NOT NULL, guest_id INT NOT NULL,
        start_date DATE NOT NULL, end_date DATE NOT NULL,
        state VARCHAR(10) NOT NULL,           -- COMMITTED | HELD | CANCELLED
        held_until DATETIME NULL)             -- 仅 HELD 有值：锁窗口到点时刻
```

## 业务口径（判分点，逐条都要照做）

1. **日期区间是半开的 `[start_date, end_date)`**：`end_date` 是退房日，那一晚不占用。
   所以"9/25 退房"与"9/25 入住"**不冲突**。
2. 参与判定的只有**有效占用**：`state='COMMITTED'`，或者 `state='HELD' AND held_until >= as_of`
   （锁窗口还活着）。`CANCELLED` 与**已过期**的 `HELD` 一律不参与 ——
   过期锁已经让位，拿它去指控别人违约是假警报。
3. 同一 `listing_id` 内两两配对，**每对只报一次**（取 `hold_id` 小的在前）。
4. `conflict_kind` 按两边的状态分三类：
   两边都 `COMMITTED` ⇒ `double-commit`（真超卖，客人会被要求搬家）；
   一边 `HELD` 一边 `COMMITTED` ⇒ `lock-breach`（提交绕过了还活着的锁窗口）；
   两边都 `HELD` ⇒ `lock-contention`（互斥本身失效了 —— 锁没起作用）。
5. `overlap_days` = 重叠段的天数 = `DATEDIFF(LEAST(两结束), GREATEST(两开始))`。
   被完全包含时按**被包含那段**算，不是按较长那条算。
6. 没有冲突 ⇒ **返回空结果集**（不是返回一行 NULL / 0）。
7. 输出列顺序固定为 `listing_id, hold_a, hold_b, conflict_kind, overlap_days`，
   并 `ORDER BY listing_id, hold_a, hold_b`。

只提交一条 `SELECT` / `WITH` 查询。

## 这题真正考的东西

素材里那句"**锁只是效率手段，正确性落在占用表的约束上**"不是一句口号：它意味着
"有没有事故"必须能从占用表本身查出来，而不是问 Redis。这道题就是那个查询 ——
- **半开区间**是日历系统最常见的 off-by-one 来源，用 `<=` 会把"同日退房即入住"报成冲突，
  于是每天中午都有几百条假警报，很快就没人看这个报表了；
- **过期锁要不要参与**决定了这份报表是"抓真事故"还是"抓噪声"；
- 三分类不是装饰：`double-commit` 要立刻逐单安置，`lock-breach` 要查提交路径为什么没看锁，
  `lock-contention` 要查锁本身 —— 混成一列数字，处置动作就没法定。"""

    reference = """WITH live AS (
  SELECT h.hold_id, h.listing_id, h.start_date, h.end_date, h.state
  FROM hold h CROSS JOIN clock c
  WHERE h.state = 'COMMITTED'
     OR (h.state = 'HELD' AND h.held_until >= c.as_of)
), pairs AS (
  SELECT a.listing_id,
         a.hold_id AS hold_a,
         b.hold_id AS hold_b,
         a.state AS state_a,
         b.state AS state_b,
         DATEDIFF(LEAST(a.end_date, b.end_date), GREATEST(a.start_date, b.start_date)) AS overlap_days
  FROM live a
  JOIN live b
    ON b.listing_id = a.listing_id
   AND b.hold_id > a.hold_id
   AND a.start_date < b.end_date
   AND b.start_date < a.end_date
)
SELECT listing_id, hold_a, hold_b,
       CASE WHEN state_a = 'COMMITTED' AND state_b = 'COMMITTED' THEN 'double-commit'
            WHEN state_a = 'HELD' AND state_b = 'HELD' THEN 'lock-contention'
            ELSE 'lock-breach' END AS conflict_kind,
       overlap_days
FROM pairs
ORDER BY listing_id, hold_a, hold_b"""

    naive = """WITH all_states AS (
  SELECT hold_id, listing_id, start_date, end_date, state FROM hold
), pairs AS (
  SELECT a.listing_id, a.hold_id AS hold_a, b.hold_id AS hold_b,
         a.state AS state_a, b.state AS state_b,
         DATEDIFF(LEAST(a.end_date, b.end_date), GREATEST(a.start_date, b.start_date)) AS overlap_days
  FROM all_states a
  JOIN all_states b
    ON b.listing_id = a.listing_id
   AND b.hold_id > a.hold_id
   AND a.start_date <= b.end_date          -- 闭区间：把"同日退房即入住"也报成冲突
   AND b.start_date <= a.end_date
)
SELECT listing_id, hold_a, hold_b,
       CASE WHEN state_a = 'COMMITTED' AND state_b = 'COMMITTED' THEN 'double-commit'
            ELSE 'lock-breach' END AS conflict_kind,      -- 不看 HELD 生死，也不分 lock-contention
       overlap_days
FROM pairs
ORDER BY listing_id, hold_a, hold_b"""

    base_rows = audit(HOLDS)
    breach_row = [r for r in base_rows if r[3] == 'lock-breach'][0]
    contention_row = [r for r in base_rows if r[3] == 'lock-contention'][0]
    contain_row = [r for r in base_rows if r[4] == max(x[4] for x in base_rows)][0]
    only_pairs = audit([r for r in HOLDS if r[0] in (1, 3)])

    answer = f"""**基线有 {len(base_rows)} 行**（由模型从行集算出，不是手抄）：
`double-commit` {sum(1 for r in base_rows if r[3] == 'double-commit')} 行、
`lock-breach` {sum(1 for r in base_rows if r[3] == 'lock-breach')} 行、
`lock-contention` {sum(1 for r in base_rows if r[3] == 'lock-contention')} 行。

**三条规则各自在哪个用例上起作用**（数字全部量自 `probe_naive.py`）：

- **半开区间**：listing 1 的 1 号（9/20–9/25）与 3 号（9/25–9/27）**不是冲突**。
  基线里它们不出现在结果中；把区间写成闭区间的实现会多出这一对，
  而它的 `overlap_days` 是 **0** —— 这正是"每天几百条假警报"的形状：0 天的冲突根本不是冲突。
  用例「边界：只剩同日退房即入住的两笔 ⇒ listing 1 一行都不出」把这条单独隔离出来
  （删掉 2 号与 4 号之后，listing 1 只剩 1 号与 3 号这对同日衔接）：
  正确实现**不输出 listing 1 的任何行**，闭区间实现输出一行 `overlap_days = 0`。
- **过期锁不参与**：5 号锁的 `held_until` 早于 `as_of`，所以它与 1 号的重叠不算事故。
  用例「重复：把过期锁的到点时刻推到未来」只改这一个字段，结果就多出一行
  `{breach_row}`（1 天 lock-breach）。忽略 `held_until` 的实现会在基线里就多报这一行。
- **`>=` 还是 `>`**：用例「并列：锁的到点时刻正好等于当前时刻 ⇒ 仍算活锁，结果与基线一致」
  把 4 号的 `held_until` 改成 `as_of` 本身 ⇒ 口径是"到点那一刻仍然有效"，所以**结果与基线完全一致**；
  写成 `>` 的实现这一行会掉进"已过期"，基线的 lock-breach 直接少一行。
- **`CANCELLED` 是噪声**：用例「退化：删掉那笔已取消的占用」删掉 7 号，
  **一行都不该变**。任何"把所有状态都 JOIN 进来"的实现在这里会掉行或加行。
- **包含关系按被包含段算**：11 号是整年长租，12 号只有 9 天 ⇒
  重叠是 {contain_row[4]} 天，不是 365 天。
- **不同 listing 从不冲突**：13 号与 1 号日期完全相同，但分属 listing 5 与 1 ⇒ 不报。
  漏掉 `listing_id` 等值条件的实现会把它当成最严重的一类。

**为什么"锁更强、TTL 更长"不是答案**（素材 §3 点名的常见错误）：把 TTL 拉长只是把
悬挂的时间拉长，超卖照样发生；真正兜底的是占用表上的唯一约束与这份对账查询。
`lock-contention` 这一类的存在尤其说明问题 —— 两个**都还活着**的锁重叠，意味着互斥
从来没有生效过（比如锁键用了 `listing_id` 而没带日期区间），这时加多长的 TTL 都只是在
掩盖一个键设计错误。

**处置顺序**（面试追问点）：先停相关写路径 ⇒ 按 `conflict_kind` 分流
（`double-commit` 逐单安置 + 补偿；`lock-breach` 查提交路径；`lock-contention` 查锁键设计）
⇒ 再补上"写入时唯一约束"让同类事故不可能发生，最后把这份对账挂成常态监控而不是事后脚本。"""

    return base(
        'sql', 'senior',
        '预订占用对账：半开区间重叠才是事故，锁的生死决定这一行算不算违约',
        statement, 'mysql',
        ['interval-overlap', 'half-open-interval', 'reconciliation', 'lock-window',
         'over-selling', 'modern:marketplace-integrity'],
        src('市场交易完整性 高级工程师',
            'content/knowledge/hot-interviews/airbnb-marketplace-booking.md §1.2、§2.1、§2.7'
            '（素材给出"锁只是效率手段 + 悬挂预订对账"的结论，未做成可判分的区间口径与分类）'),
        language='sql',
        cases=[
            case('基线：三类冲突各一行，同日衔接与过期锁都不算'),
            case('边界：只剩同日退房即入住的两笔 ⇒ listing 1 一行都不出',
                 delete=[2, 4],
                 note='1 号(9/20–9/25) 与 3 号(9/25–9/27) 是同日衔接；闭区间实现会在这里多出一行 '
                      'overlap_days=0 的"冲突"，而 0 天的重叠根本不是重叠'),
            case('重复：把过期锁的到点时刻推到未来 ⇒ 多出一行 lock-breach',
                 updates=[(5, 6, datetime(2026, 9, 20, 0, 0, 0))],
                 note='只改 held_until 一个字段，5 号从"已让位"变成"活锁被绕过"'),
            case('退化：删掉那笔已取消的占用，一行都不该变',
                 delete=[7],
                 note='CANCELLED 本来就不参与；把它 JOIN 进来的实现这里数字会动'),
            case('并列：锁的到点时刻正好等于当前时刻 ⇒ 仍算活锁，结果与基线一致',
                 updates=[(4, 6, AS_OF)],
                 note='考 >= 与 > 的差别：写成 > 的实现会少一行 lock-breach'),
            case('极大：把被包含的那笔挪到完全不相交 ⇒ 包含关系那行消失',
                 updates=[(12, 3, date(2027, 6, 1)), (12, 4, date(2027, 6, 10))],
                 note='11 号是整年长租；12 号挪到 2027-06 之后与它不再相交'),
            case('单条：只留一笔有效占用 ⇒ 没有任何配对',
                 delete=[r[0] for r in HOLDS if r[0] != 1],
                 note='空结果集不是"一行 NULL"'),
        ],
        runner={
            'setup': [
                'DROP TABLE IF EXISTS hold',
                'DROP TABLE IF EXISTS clock',
                'CREATE TABLE clock (as_of DATETIME NOT NULL) ENGINE=InnoDB',
                'CREATE TABLE hold (hold_id INT PRIMARY KEY, listing_id INT NOT NULL, '
                'guest_id INT NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL, '
                'state VARCHAR(10) NOT NULL, held_until DATETIME NULL) ENGINE=InnoDB',
                f"INSERT INTO clock VALUES ('{AS_OF:%Y-%m-%d %H:%M:%S}')",
                'INSERT INTO hold VALUES '
                + ', '.join(
                    f"({hid}, {lid}, {gid}, '{s:%Y-%m-%d}', '{e:%Y-%m-%d}', '{st}', "
                    + ('NULL' if until is None else f"'{until:%Y-%m-%d %H:%M:%S}'") + ')'
                    for hid, lid, gid, s, e, st, until in HOLDS),
            ],
            'orderSensitive': True,
            'timeoutMs': 8000,
            'referenceSolution': reference,
            'naiveSolution': naive,
        },
        estimatedMinutes=26,
        answer=answer,
    )


if __name__ == '__main__':
    if '--list' in sys.argv:
        for k in sorted(DRAFTS):
            print(k)
        raise SystemExit(0)
    os.makedirs(OUT_DIR, exist_ok=True)
    for key, fn in sorted(DRAFTS.items()):
        path = os.path.join(OUT_DIR, f'{key}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(fn(), f, ensure_ascii=False, indent=2)
            f.write('\n')
        print(f'wrote {os.path.relpath(path, ROOT)}')
    for name in sorted(os.listdir(OUT_DIR)):
        if name.endswith('.json'):
            json.load(open(os.path.join(OUT_DIR, name), encoding='utf-8'))
    print(f'全部 {len(DRAFTS)} 份草稿 JSON 可解析')
