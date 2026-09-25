// spark-scala 判题 harness：读 cases.json → 每题建 DataFrame → 调 Solution.solve(df) → 比对 → 写 arena-results.json
//
// 值归一化刻意与 server/src/judge/spark_worker.py 的 _canon_* 逐条对齐，
// 这样同一道题从 PySpark 换到 Scala Spark 不会因为"4"和"4.0"这种细节判出不同结果。
// __SOLVE_TARGET__ 由 runner 替换成题目 runner.className（默认 Solution）。
import com.fasterxml.jackson.databind.{JsonNode, ObjectMapper}
import com.fasterxml.jackson.databind.node.ObjectNode
import org.apache.spark.sql.{DataFrame, Row, SparkSession}
import org.apache.spark.sql.types.StructType
import java.io.File
import java.util.concurrent.atomic.AtomicReference
import scala.jdk.CollectionConverters._

object ArenaScalaHarness {
  private val mapper = new ObjectMapper()

  def main(args: Array[String]): Unit = {
    val casesPath = args(0)
    val outPath = args(1)
    val orderSensitive = new File(casesPath).length() >= 0 && readOrderSensitive(casesPath)

    val report = mapper.createObjectNode()
    val casesOut = report.putArray("cases")
    val setupError = new AtomicReference[String](null)

    val spark = SparkSession
      .builder()
      .appName("arena-spark-scala")
      .master("local[*]")
      .config("spark.sql.shuffle.partitions", "2")
      .config("spark.ui.enabled", "false")
      .config("spark.driver.host", "127.0.0.1")
      .config("spark.sql.session.timeZone", "UTC")
      .getOrCreate()
    spark.sparkContext.setLogLevel("ERROR")

    try {
      val root = mapper.readTree(new File(casesPath))
      val setup = root.path("setup")
      root
        .path("cases")
        .elements()
        .asScala
        .foreach { testCase =>
          val node = casesOut.addObject()
          val name = testCase.path("name").asText("(未命名用例)")
          node.put("name", name)
          try {
            setup.elements().asScala.foreach(statement => spark.sql(statement.asText()))
            val solved = __SOLVE_TARGET__.solve(frameOf(spark, testCase.path("input")))
            val actual = canonRows(solved)
            val expected = canonExpected(testCase.path("expected"), solved.columns)
            node.put("expected", expected.mkString("[", ",", "]"))
            node.put("actual", actual.mkString("[", ",", "]"))
            val ok = if (orderSensitive) expected == actual else expected.sorted == actual.sorted
            node.put("status", if (ok) "pass" else "fail")
            if (!ok) node.put("message", diffMessage(expected, actual, orderSensitive))
          } catch {
            case err: Throwable =>
              node.put("status", "runtime")
              node.put("message", brief(err))
          }
        }
    } catch {
      case err: Throwable => setupError.set(brief(err))
    }

    if (setupError.get() != null) report.put("setupError", setupError.get())
    write(outPath, mapper.writeValueAsString(report))
    spark.stop()
  }

  private def readOrderSensitive(path: String): Boolean =
    mapper.readTree(new File(path)).path("orderSensitive").asBoolean(false)

  /** input 允许三种写法：行数组、{"rows":[...],"schema":"a string, b double","view":"orders"}、{"data":...} */
  private def frameOf(spark: SparkSession, spec: JsonNode): DataFrame = {
    import spark.implicits._
    val (rowsNode, schemaText, view) =
      if (spec.isArray) (spec, None, None)
      else
        (
          if (spec.has("rows")) spec.get("rows") else spec.get("data"),
          if (spec.hasNonNull("schema")) Some(ddlOf(spec.get("schema"))) else None,
          if (spec.hasNonNull("view")) Some(spec.get("view").asText()) else None
        )
    if (rowsNode == null || rowsNode.isMissingNode || rowsNode.isNull) {
      throw new IllegalArgumentException("用例 input 缺少 rows：无法建 DataFrame")
    }
    val lines = rowsNode.elements().asScala.map(_.toString).toSeq
    val reader = spark.read
    val framed = schemaText match {
      case Some(ddl) => reader.schema(StructType.fromDDL(ddl)).json(lines.toDS())
      case None      => reader.json(lines.toDS())
    }
    view.foreach(name => framed.createOrReplaceTempView(name))
    framed
  }

  /** schema 允许 "a string, b double" / [["a","string"]] / [{"name":"a","type":"string"}] —— 统一成 DDL 串。 */
  private def ddlOf(schema: JsonNode): String = {
    if (schema.isTextual) return schema.asText()
    if (schema.isArray) {
      return schema
        .elements()
        .asScala
        .map { item =>
          if (item.isTextual) item.asText()
          else if (item.isArray) s"${item.get(0).asText()} ${item.get(1).asText()}"
          else s"${item.path("name").asText()} ${item.path("type").asText("string")}"
        }
        .mkString(", ")
    }
    schema
      .fields()
      .asScala
      .map(entry => s"${entry.getKey} ${entry.getValue.asText("string")}")
      .mkString(", ")
  }

  private def canonRows(df: DataFrame): List[String] = {
    val columns = df.columns
    df.collect().map(row => canonRow(columns, row)).toList
  }

  private def canonRow(columns: Array[String], row: Row): String =
    columns
      .map(_.toLowerCase)
      .zip(columns)
      .map { case (key, original) => key -> canonValue(row.get(columns.indexOf(original))) }
      .toSeq
      .sortBy(_._1)
      .map { case (key, value) => s""""$key":$value""" }
      .mkString("{", ",", "}")

  /** 期望值允许：行对象数组 / 单个行对象 / 标量数组（结果只有一列时）/ 单个标量。 */
  private def canonExpected(node: JsonNode, columns: Array[String]): List[String] = {
    if (node == null || node.isMissingNode || node.isNull) throw new IllegalArgumentException("用例缺少 expected")
    if (node.isObject) return List(canonExpectedRow(node))
    if (node.isArray) {
      val items = node.elements().asScala.toList
      if (items.isEmpty) return Nil
      if (items.head.isObject) return items.map(canonExpectedRow)
      if (columns.length != 1) {
        throw new IllegalArgumentException(s"expected 是标量列表但结果有 ${columns.length} 列，无法对齐")
      }
      return items.map(value => s"""{"${columns.head.toLowerCase}":${canonValue(value)}}""")
    }
    if (columns.length != 1) {
      throw new IllegalArgumentException(s"expected 是标量但结果有 ${columns.length} 列，无法对齐")
    }
    List(s"""{"${columns.head.toLowerCase}":${canonValue(node)}}""")
  }

  private def canonExpectedRow(node: JsonNode): String =
    node
      .fields()
      .asScala
      .map(entry => entry.getKey.toLowerCase -> canonValue(entry.getValue))
      .toSeq
      .sortBy(_._1)
      .map { case (key, value) => s""""$key":$value""" }
      .mkString("{", ",", "}")

  /** 与 spark_worker.py 的 _canon_value 一致：数字整数化、浮点 10 位小数去尾零、容器递归、键排序。 */
  private def canonValue(value: Any): String = value match {
    case null                   => "null"
    case node: JsonNode         => canonJsonNode(node)
    case b: java.lang.Boolean   => if (b.booleanValue()) "true" else "false"
    case n: java.lang.Number    => canonNumber(n.doubleValue())
    case s: String              => "\"" + escape(s) + "\""
    case t: java.sql.Timestamp  => "\"" + t.toString + "\""
    case r: Row                 => "\"" + r.toString + "\""
    case other                  => "\"" + escape(String.valueOf(other)) + "\""
  }

  private def canonJsonNode(node: JsonNode): String = {
    if (node.isNull) "null"
    else if (node.isBoolean) (if (node.booleanValue()) "true" else "false")
    else if (node.isNumber) canonNumber(node.doubleValue())
    else if (node.isArray) node.elements().asScala.map(canonJsonNode).mkString("[", ",", "]")
    else if (node.isObject)
      node
        .fieldNames()
        .asScala
        .toList
        .sorted
        .map(key => s""""$key":${canonJsonNode(node.get(key))}""")
        .mkString("{", ",", "}")
    else "\"" + escape(node.asText()) + "\""
  }

  private def canonNumber(double: Double): String = {
    if (double.isNaN) "NaN"
    else if (double == math.rint(double) && math.abs(double) < 1e16) f"${double.toLong}%d"
    else {
      val text = f"$double%.10f"
      text.replaceAll("0+$", "").replaceAll("\\.$", "")
    }
  }

  private def diffMessage(expected: List[String], actual: List[String], orderSensitive: Boolean): String = {
    if (expected.length != actual.length) {
      return s"行数不一致：期望 ${expected.length} 行，实际 ${actual.length} 行"
    }
    if (orderSensitive) "行序敏感比对不一致（默认不要求行序，可用 runner.orderSensitive 打开）"
    else "行集合不一致（默认行序不敏感）"
  }

  private def brief(err: Throwable): String = {
    val head = Option(err.getMessage).getOrElse(err.getClass.getSimpleName)
    val trace = err.getStackTrace.take(4).map(e => s"  at $e").mkString("\n")
    s"${err.getClass.getSimpleName}: ${truncate(head, 600)}${if (trace.isEmpty) "" else s"\n$trace"}"
  }

  private def truncate(text: String, max: Int): String = if (text.length <= max) text else text.substring(0, max) + "…"

  private def escape(text: String): String =
    text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")

  private def write(path: String, content: String): Unit = {
    val writer = new java.io.OutputStreamWriter(new java.io.FileOutputStream(path), "UTF-8")
    try writer.write(content)
    finally writer.close()
  }
}
