"""常驻 Spark 判题 worker（pyspark runner 的容器侧）。

协议（行分隔 JSON，前缀固定，避免被 Spark/JVM 日志污染）：
  启动完成  -> ARENA_READY {"sparkVersion": "...", "pid": 1}
  每行读一个请求 -> {"id":1,"entry":"function|sql|script","code":"...","setup":["SQL",...],
                     "cases":[{"name":..,"input":..,"expected":..}],"orderSensitive":false}
  每行写一个结果 -> ARENA_RESULT {"id":1,"ok":true,"cases":[{"name":..,"status":"pass|fail|runtime",
                     "expected":"..","actual":"..","message":".."}],"elapsedMs":..}
  退出      -> ARENA_BYE {}

设计约束：
  * SparkSession 只建一次（local[2]），因此第二次判题不用付 JVM/会话冷启动的 10~20s。
  * 所有非协议输出都走 stderr；用户代码里的 print() 在 exec 期间被改道到 stderr。
  * INFO 日志压到 WARN，避免刷屏。
"""

import io
import json
import os
import sys
import time
import traceback

READY_PREFIX = "ARENA_READY "
RESULT_PREFIX = "ARENA_RESULT "
BYE_PREFIX = "ARENA_BYE "
FATAL_PREFIX = "ARENA_FATAL "

_REAL_STDOUT = sys.stdout
_MAX_ROWS_SHOWN = 20


def _emit(prefix, payload):
    _REAL_STDOUT.write(prefix + json.dumps(payload, ensure_ascii=False, default=str) + "\n")
    _REAL_STDOUT.flush()


def _result(payload):
    _emit(RESULT_PREFIX, payload)


class _StdoutToStderr(io.TextIOBase):
    """exec 用户代码期间把 stdout 改道，保护协议行。"""

    @staticmethod
    def write(text):
        if text:
            sys.stderr.write(text)
        return len(text) if text else 0

    @staticmethod
    def flush():
        sys.stderr.flush()


def _to_stderr_enabled(flag):
    sys.stdout = _StdoutToStderr() if flag else _REAL_STDOUT


def build_session(scratch_dir):
    from pyspark.sql import SparkSession

    os.makedirs(scratch_dir, exist_ok=True)
    builder = (
        SparkSession.builder.appName("arena-judge-worker")
        .master("local[2]")
        .config("spark.ui.enabled", "false")
        .config("spark.sql.session.timeZone", "UTC")
        .config("spark.driver.memory", "2g")
        .config("spark.sql.warehouse.dir", os.path.join(scratch_dir, "spark-warehouse"))
        .config("spark.local.dir", os.path.join(scratch_dir, "spark-local"))
        .config("spark.sql.shuffle.partitions", "4")
        .config("spark.sql.adaptive.enabled", "true")
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
        .config("spark.sql.autoBroadcastJoinThreshold", "67108864")
        .config("spark.ui.showConsoleProgress", "false")
        .config("spark.driver.host", "127.0.0.1")
        .config("spark.driver.bindAddress", "127.0.0.1")
    )
    spark = builder.getOrCreate()
    spark.sparkContext.setLogLevel("WARN")
    return spark


def _base_namespace(spark):
    """给用户代码的默认作用域：不用自己 import 也能写 F.col / Window。"""
    import pyspark
    from pyspark.sql import Row, Window
    import pyspark.sql.functions as F
    import pyspark.sql.types as T

    return {
        "spark": spark,
        "pyspark": pyspark,
        "F": F,
        "T": T,
        "Window": Window,
        "Row": Row,
        "col": F.col,
        "lit": F.lit,
        "when": F.when,
        "__builtins__": __builtins__,
    }


# ---------------------------------------------------------------- 值归一化


def _canon_value(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _canon_number(float(value))
    try:  # Decimal / numpy 数值
        from decimal import Decimal

        if isinstance(value, Decimal):
            return _canon_number(float(value))
    except Exception:
        pass
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canon_value(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(f"{k}:{_canon_value(value[k])}" for k in sorted(value.keys())) + "}"
    return str(value)


def _canon_number(number):
    if number != number:  # NaN
        return "NaN"
    if number == int(number) and abs(number) < 1e16:
        return str(int(number))
    text = "%.10f" % number
    return text.rstrip("0").rstrip(".")


def _row_to_dict(row):
    if row is None:
        return {}
    if isinstance(row, dict):
        return dict(row)
    if hasattr(row, "asDict"):
        try:
            return row.asDict(recursive=True)
        except TypeError:
            return row.asDict()
    if hasattr(row, "_asdict"):
        return row._asdict()
    raise ValueError("无法把结果行转成字典：%r" % (row,))


def _canon_row(row):
    return json.dumps({k: _canon_value(v) for k, v in row.items()}, ensure_ascii=False, sort_keys=True)


def _ordered_canon_rows(rows):
    return [_canon_row(_row_to_dict(r)) for r in rows]


def _norm_columns(cols):
    return sorted(str(c) for c in cols)


def _expected_rows(expected, actual_rows):
    """期望值可以是 [{}] / {} / [[..]] / 标量，统一成行字典列表。"""
    actual_cols = _norm_columns(_row_to_dict(actual_rows[0]).keys()) if actual_rows else []

    if expected is None:
        raise ValueError("用例缺少 expected")
    if isinstance(expected, dict):
        return [expected]
    if isinstance(expected, (list, tuple)):
        items = list(expected)
        if not items:
            return []
        if all(isinstance(i, (dict,)) or hasattr(i, "asDict") for i in items):
            return [_row_to_dict(i) for i in items]
        if all(isinstance(i, (list, tuple)) for i in items):
            if actual_cols and all(len(list(i)) == len(actual_cols) for i in items):
                return [dict(zip(actual_cols, list(i))) for i in items]
            return [{str(n): v for n, v in enumerate(list(i))} for i in items]
        # 标量列表：与单列结果对齐
        if len(actual_cols) == 1:
            return [{actual_cols[0]: i} for i in items]
        raise ValueError("expected 是标量列表但结果有 %d 列，无法对齐" % len(actual_cols))
    if len(actual_cols) == 1:
        return [{actual_cols[0]: expected}]
    raise ValueError("expected 是标量但结果有 %d 列，无法对齐" % len(actual_cols))


def _preview(items):
    items = list(items)
    if len(items) <= _MAX_ROWS_SHOWN:
        return "[" + ", ".join(items) + "]"
    return "[" + ", ".join(items[:_MAX_ROWS_SHOWN]) + ", ...(%d more)]" % len(items)


def _diff_message(expected_canon, actual_canon, order_sensitive, expected_rows, actual_rows):
    if len(expected_canon) != len(actual_canon):
        return "行数不一致：期望 %d 行，实际 %d 行。期望=%s 实际=%s" % (
            len(expected_canon),
            len(actual_canon),
            _preview(expected_canon),
            _preview(actual_canon),
        )
    exp_cols = set()
    act_cols = set()
    for row in expected_rows:
        exp_cols.update(str(k) for k in row.keys())
    for row in actual_rows:
        act_cols.update(str(k) for k in _row_to_dict(row).keys())
    if exp_cols != act_cols:
        return "列名不一致：期望 {%s}，实际 {%s}" % (", ".join(sorted(exp_cols)), ", ".join(sorted(act_cols)))
    if order_sensitive:
        for index, (exp, act) in enumerate(zip(expected_canon, actual_canon)):
            if exp != act:
                return "行序敏感比对不一致：第 %d 行期望 %s，实际 %s" % (index + 1, exp, act)
        return "行序敏感比对不一致"
    for exp, act in zip(expected_canon, actual_canon):
        if exp != act:
            return "行集合不一致（默认行序不敏感）：期望 %s，实际 %s" % (exp, act)
    return "结果不一致"


# ---------------------------------------------------------------- 输入数据


def _schema_text(schema):
    if schema is None:
        return None
    if isinstance(schema, str):
        return schema
    if isinstance(schema, (list, tuple)):
        parts = []
        for item in schema:
            if isinstance(item, (list, tuple)):
                parts.append("%s %s" % (item[0], item[1]))
            elif isinstance(item, dict):
                parts.append("%s %s" % (item.get("name"), item.get("type", "string")))
            else:
                parts.append(str(item))
        return ", ".join(parts)
    return None


_NUMERIC_TARGETS = {
    "double": float, "float": float, "real": float,
    "bigint": int, "long": int, "integer": int, "int": int,
    "smallint": int, "short": int, "tinyint": int, "byte": int,
}


def _split_schema_fields(schema_text):
    """按**顶层**逗号切 'a string, d decimal(10,2), e array<string>'（括号/尖括号内的逗号不算）。"""
    parts = []
    depth = 0
    current = ""
    for ch in schema_text:
        if ch in "(<[":
            depth += 1
        elif ch in ")>]":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(current)
            current = ""
        else:
            current += ch
    if current.strip():
        parts.append(current)
    return parts


def _field_casters(schema_text):
    """列名 -> 目标类型构造函数。只处理数值列，其它类型原样交给 Spark 自己判。"""
    casters = {}
    for field in _split_schema_fields(schema_text):
        tokens = field.strip().split(None, 1)
        if len(tokens) != 2:
            continue
        name, type_text = tokens[0].strip("`"), tokens[1].strip()
        base = ""
        for ch in type_text:
            if ch in "(< ":
                break
            base += ch
        caster = _NUMERIC_TARGETS.get(base.lower())
        if caster:
            casters[name] = caster
    return casters


def _coerce_rows(rows, schema_text):
    """
    按 schema 声明的类型校正行值。

    为什么必须有它：题库是 Node 用 `JSON.stringify` 落盘的，`512.0` 会被写成 `512` ——
    类型信息在序列化这一步就磨掉了。而 PySpark 的 DoubleType 不接受 int
    （`CANNOT_ACCEPT_OBJECT_IN_TYPE`），症状是"参考解跑不起来"，
    看起来像题目写错，其实是判题器在替 JSON 的数字表示背锅。
    """
    casters = _field_casters(schema_text)
    if not casters:
        return rows
    fixed = []
    for row in rows:
        if not isinstance(row, dict):
            fixed.append(row)
            continue
        item = dict(row)
        for key, caster in casters.items():
            value = item.get(key)
            if value is None or isinstance(value, caster) or isinstance(value, bool):
                continue
            try:
                item[key] = caster(value)
            except (TypeError, ValueError):
                pass  # 转不动就原样交回去，让 Spark 报它自己的错，不在这里吞掉
        fixed.append(item)
    return fixed


def _frame_from_spec(spark, spec):
    """spec = {"rows": [...], "schema": "a string, b double" | [["a","string"]], "view": "orders"}"""
    if isinstance(spec, list):
        spec = {"rows": spec}
    if not isinstance(spec, dict):
        raise ValueError("用例 input 形态不支持：%r" % (type(spec),))
    rows = spec.get("rows")
    if rows is None:
        rows = spec.get("data")
    if rows is None:
        return None
    if isinstance(rows, dict):
        rows = [rows]
    rows = list(rows)
    schema = _schema_text(spec.get("schema"))
    if schema is not None:
        frame = spark.createDataFrame(_coerce_rows(rows, schema), schema)
    elif rows:
        frame = spark.createDataFrame(rows)
    else:
        raise ValueError("空 rows 必须同时提供 schema（否则无法推断列类型）")
    view = spec.get("view") or spec.get("table")
    if view:
        frame.createOrReplaceTempView(str(view))
    return frame


# ---------------------------------------------------------------- 执行


def _run_setup(spark, statements):
    for statement in statements or []:
        if not str(statement).strip():
            continue
        spark.sql(str(statement))


def _collect_result(result):
    if result is None:
        raise ValueError("solve() 没有返回 DataFrame（返回 None）")
    if hasattr(result, "collect") and hasattr(result, "schema"):
        rows = result.collect()
        return rows, [f.name for f in result.schema.fields]
    if isinstance(result, list):
        return [_to_row(r) for r in result], None
    if isinstance(result, tuple) and len(result) == 2 and hasattr(result[0], "collect"):
        rows = result[0].collect()
        return rows, [f.name for f in result[0].schema.fields]
    raise ValueError("solve() 返回值不是 DataFrame：%r" % (type(result),))


def _to_row(value):
    """列表型结果（用户直接 return [{...}, {...}]）也当成行来比。"""
    if isinstance(value, dict) or hasattr(value, "asDict"):
        return value
    raise ValueError("结果列表元素必须是字典或 Row")


def _call_solve(solve, spark, frame):
    import inspect

    try:
        signature = inspect.signature(solve)
    except (TypeError, ValueError):
        return solve(spark)
    names = [
        p.name
        for p in signature.parameters.values()
        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
    ]
    has_var_positional = any(p.kind == p.VAR_POSITIONAL for p in signature.parameters.values())
    args = []
    for index, name in enumerate(names):
        if index == 0 and name == "spark":
            args.append(spark)
        elif frame is not None:
            args.append(frame)
        else:
            args.append(spark)
    if has_var_positional:
        args = [spark] + ([frame] if frame is not None else [])
    return solve(*args[: len(names) or 1] if not has_var_positional else args)


def _entry_script_result(namespace):
    for key in ("result", "answer", "actual", "out"):
        value = namespace.get(key)
        if value is not None and hasattr(value, "collect"):
            return value
    candidates = [k for k, v in namespace.items() if hasattr(v, "collect") and hasattr(v, "schema") and k != "spark"]
    if len(candidates) == 1:
        return namespace[candidates[0]]
    raise ValueError("script 入口需要在最后把结果赋给 result（找到 %d 个 DataFrame 变量）" % len(candidates))


def _pick_frame(namespace):
    """IDE 模式挑一个 DataFrame 展示：优先显式命名，其次最后创建的那个。"""
    for key in ("result", "answer", "actual", "out"):
        value = namespace.get(key)
        if value is not None and hasattr(value, "collect") and hasattr(value, "schema"):
            return value
    frames = [
        (key, value)
        for key, value in namespace.items()
        if key != "spark" and hasattr(value, "collect") and hasattr(value, "schema")
    ]
    return frames[-1][1] if frames else None


def _frame_to_table(frame, row_limit):
    rows, cols = _collect_result(frame)
    columns = list(cols) if cols else sorted(_row_to_dict(rows[0]).keys()) if rows else []
    cells = []
    for row in rows[:row_limit]:
        record = _row_to_dict(row)
        cells.append(["" if record.get(c) is None else str(record.get(c)) for c in columns])
    return {"columns": columns, "rows": cells, "truncated": len(rows) > row_limit, "totalRows": len(rows)}


def run_ide_mode(spark, request):
    """IDE 模式：跑一段脚本，把用户 print 收进 stdout 字段，最后一个 DataFrame 当表格预览回。

    判题模式必须把 print 改道到 stderr（保住行分隔 JSON 协议），而 IDE 要的恰恰是那些 print
    —— 所以这里在**进程内**重定向到 StringIO 随响应返回，而不是去捞 stderr 的尾巴：
    尾巴里混着 Spark/JVM 自己的日志，用户看不到自己写了什么，还会看到一堆不属于他的噪声。

    每次运行都开一个 `spark.newSession()`：它复用同一个 SparkContext（实测 1.3ms，不付冷启动），
    但**临时视图注册表是独立的** —— 跑完就随会话消失。这是唯一靠得住的隔离方式：
    这个 PySpark 版本的 Catalog 根本没有列临时视图的 API（3.5.5 只有 `dropTempView`，
    没有 `listTempViews` / `listTemporaryViews`），"跑完按名单清掉"那种写法会静默变成空转
    —— 真这样写过，是 IDE 的隔离用例把它抓回来的。
    共用一个会话而不隔离的后果是 A 次运行建的 vw_orders 影响 B 次运行，甚至影响判题。
    """
    import contextlib
    import io as _io

    started = time.time()
    req_id = request.get("id")
    code = request.get("code") or ""
    limit = int(request.get("rowLimit") or 200)
    response = {"id": req_id, "ok": True, "mode": "ide", "cases": [], "elapsedMs": 0, "stdout": "", "table": None}
    session = spark.newSession()
    namespace = _base_namespace(session)
    buf = _io.StringIO()

    try:
        compiled = compile(code, "ide.py", "exec")
    except SyntaxError as exc:
        response.update(
            ok=False,
            error={"stage": "compile", "message": "代码语法错误：%s" % (exc,), "traceback": traceback.format_exc()},
        )
        response["elapsedMs"] = int((time.time() - started) * 1000)
        return response

    try:
        with contextlib.redirect_stdout(buf):
            _run_setup(session, request.get("setup"))
            exec(compiled, namespace)
            frame = _pick_frame(namespace)
            if frame is not None:
                response["table"] = _frame_to_table(frame, limit)
    except Exception as exc:
        response.update(
            ok=False,
            stdout=buf.getvalue(),
            error={
                "stage": "runtime",
                "message": "%s: %s" % (type(exc).__name__, exc),
                "traceback": traceback.format_exc(limit=12),
            },
        )
    else:
        response["stdout"] = buf.getvalue()
    response["elapsedMs"] = int((time.time() - started) * 1000)
    return response


def handle_request(spark, request):
    started = time.time()
    req_id = request.get("id")
    entry = request.get("entry") or "function"
    code = request.get("code") or ""
    order_sensitive = bool(request.get("orderSensitive"))
    cases = request.get("cases") or []
    response = {"id": req_id, "ok": True, "entry": entry, "cases": [], "elapsedMs": 0}

    # IDE 走完全不同的形状（没有用例、要 stdout），单独一个入口，别把两套语义搅在一起
    if request.get("mode") == "ide":
        return run_ide_mode(spark, request)

    namespace = _base_namespace(spark)
    compiled = None
    if entry in ("function", "script"):
        try:
            compiled = compile(code, "submission.py", "exec")
        except SyntaxError as exc:
            response.update(ok=False, error={"stage": "compile", "message": "提交代码语法错误：%s" % (exc,), "traceback": traceback.format_exc()})
            response["elapsedMs"] = int((time.time() - started) * 1000)
            return response
        if entry == "function":
            # function 入口：模块级代码跑一次（拿 solve），用例阶段只调 solve
            try:
                _to_stderr_enabled(True)
                try:
                    exec(compiled, namespace)
                finally:
                    _to_stderr_enabled(False)
            except Exception as exc:
                response.update(
                    ok=False,
                    error={"stage": "runtime", "message": "提交代码执行到一半抛异常：%s" % (exc,), "traceback": traceback.format_exc()},
                )
                response["elapsedMs"] = int((time.time() - started) * 1000)
                return response
            solve = namespace.get("solve")
            if not callable(solve):
                response.update(ok=False, error={"stage": "compile", "message": "提交代码里没有可调用的 def solve(spark) / def solve(df)"})
                response["elapsedMs"] = int((time.time() - started) * 1000)
                return response

    for case in cases:
        name = case.get("name") or "case"
        try:
            _to_stderr_enabled(True)
            try:
                _run_setup(spark, request.get("setup"))
                spec = case.get("input")
                frame = _frame_from_spec(spark, spec) if spec is not None else None
                if entry == "sql":
                    result = spark.sql(code)
                elif entry == "function":
                    result = _call_solve(solve, spark, frame)
                elif entry == "script":
                    namespace["df"] = frame
                    exec(compiled, namespace)
                    result = _entry_script_result(namespace)
                else:
                    raise ValueError("pyspark runner 不支持的 entry：%s" % entry)
                rows, _cols = _collect_result(result)
            finally:
                _to_stderr_enabled(False)
        except Exception as exc:
            response.update(
                ok=False,
                error={"stage": "runtime", "message": "%s: %s" % (type(exc).__name__, exc), "traceback": traceback.format_exc()},
            )
            response["cases"].append(
                {
                    "name": name,
                    "status": "runtime",
                    "message": "%s: %s" % (type(exc).__name__, exc),
                    "traceback": traceback.format_exc(limit=12),
                }
            )
            break

        try:
            expected_rows = _expected_rows(case.get("expected"), rows)
        except Exception as exc:
            response["cases"].append(
                {"name": name, "status": "fail", "message": "期望值无法解析：%s" % exc, "actual": _preview(_ordered_canon_rows(rows))}
            )
            response.update(ok=False)
            continue

        ordered_expected = [_canon_row(row) for row in expected_rows]
        actual_ordered = _ordered_canon_rows(rows)
        matched = actual_ordered == ordered_expected if order_sensitive else sorted(actual_ordered) == sorted(ordered_expected)
        if matched:
            response["cases"].append({"name": name, "status": "pass", "rowCount": len(rows)})
            continue
        response.update(ok=False)
        response["cases"].append(
            {
                "name": name,
                "status": "fail",
                "expected": _preview(ordered_expected),
                "actual": _preview(actual_ordered),
                "message": _diff_message(sorted(ordered_expected), sorted(actual_ordered), order_sensitive, expected_rows, rows),
            }
        )

    response["elapsedMs"] = int((time.time() - started) * 1000)
    return response


def main():
    scratch_dir = os.environ.get("ARENA_SPARK_SCRATCH") or os.path.join(os.getcwd(), ".arena-spark")
    try:
        spark = build_session(scratch_dir)
    except Exception:
        _emit(FATAL_PREFIX, {"error": "SparkSession 启动失败", "traceback": traceback.format_exc()})
        sys.stderr.write(traceback.format_exc())
        return 1
    _emit(READY_PREFIX, {"sparkVersion": spark.version, "pid": os.getpid(), "scratch": scratch_dir})
    try:
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except Exception as exc:
                _result({"id": None, "ok": False, "error": {"stage": "protocol", "message": "请求不是合法 JSON：%s" % exc}})
                continue
            if request.get("action") == "shutdown":
                _emit(BYE_PREFIX, {"id": request.get("id"), "ok": True})
                break
            try:
                _result(handle_request(spark, request))
            except Exception:
                _result({"id": request.get("id"), "ok": False, "error": {"stage": "worker", "message": "worker 内部异常", "traceback": traceback.format_exc()}})
    finally:
        sys.stdout = _REAL_STDOUT
        try:
            spark.stop()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
