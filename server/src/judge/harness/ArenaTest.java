package arena;

import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.TestFactory;

/**
 * JUnit5 判题入口：每个用例一个 DynamicTest，结果由自己写进 arena-results.json。
 * 之所以不解析 JUnit 的 XML 报告：DynamicTest 的显示名在 XML 里会变成 "judge()[N]"，
 * 拿不回题目里的用例名（需求 场景 4 要求点名失败的用例）。
 */
public class ArenaTest {

  static String[] paramTypes = new String[0];
  /** 返回类型也要记一份：ListNode / TreeNode 的期望值得按同一口径建成对象再比。 */
  static String returnType = "";
  static Object instance;
  static Method method;
  static List<Harness.TestCase> cases = new ArrayList<>();
  static String setupError;

  static final List<Map<String, String>> outcomes = Collections.synchronizedList(new ArrayList<Map<String, String>>());

  @BeforeAll
  static void setUp() {
    try {
      String signature = read(System.getProperty("arena.method", "method.txt")).trim();
      String[] parsed = Harness.parseSignature(signature);
      returnType = parsed[0];
      String name = parsed[1];
      paramTypes = Arrays.copyOfRange(parsed, 2, parsed.length);

      String className = System.getProperty("arena.class", "Solution");
      Class<?> clazz = Class.forName(className);
      Constructor<?> ctor;
      try {
        ctor = clazz.getDeclaredConstructor();
      } catch (NoSuchMethodException noCtor) {
        ctor = null; // 允许纯静态方法的解法
      }
      if (ctor != null) {
        ctor.setAccessible(true);
        instance = ctor.newInstance();
      }
      method = Harness.findMethod(clazz, name, paramTypes);
      method.setAccessible(true);
      cases = Harness.loadCases(System.getProperty("arena.cases", "cases.json"));
      if (cases.isEmpty()) throw new IllegalStateException("题目没有携带任何测试用例");
    } catch (Throwable t) {
      setupError = describe(t);
    }
  }

  @TestFactory
  Collection<DynamicTest> judge() {
    List<DynamicTest> tests = new ArrayList<>();
    if (loadFailed()) {
      // 装载失败时不逐个报错，setupError 会被写进结果文件
      tests.add(DynamicTest.dynamicTest("setup-failed", () -> {}));
      return tests;
    }
    for (final Harness.TestCase tc : cases) {
      tests.add(DynamicTest.dynamicTest(tc.name, () -> check(tc)));
    }
    return tests;
  }

  static boolean loadFailed() {
    return setupError != null;
  }

  static void check(Harness.TestCase tc) {
    try {
      runCase(tc);
    } catch (AssertionError judged) {
      throw judged; // 已经记过账的判题结论
    } catch (Throwable harnessBug) {
      // 走到这里说明是判题器自己炸了（转换/归一化抛错）。不记一笔的话这条用例会凭空消失，
      // 上层只能报"进程可能被系统杀掉"，把判题器的 bug 说成考生的问题。
      Map<String, String> out = new LinkedHashMap<String, String>();
      out.put("name", tc.name);
      out.put("status", "error");
      out.put("message", "判题器内部错误：" + describe(harnessBug));
      outcomes.add(out);
      throw new AssertionError(out.get("message"));
    }
  }

  static void runCase(Harness.TestCase tc) {
    Map<String, String> out = new LinkedHashMap<String, String>();
    out.put("name", tc.name);
    Throwable thrown = null;
    Object actual = null;
    try {
      Object[] args = Harness.convertArgs(paramTypes, tc.args);
      actual = Modifier.isStatic(method.getModifiers()) ? method.invoke(null, args) : method.invoke(instance, args);
    } catch (InvocationTargetException invoked) {
      thrown = invoked.getTargetException();
    } catch (Throwable convertFailed) {
      out.put("status", "input");
      out.put("message", describe(convertFailed));
      outcomes.add(out);
      throw new AssertionError(out.get("message"));
    }

    if (tc.expectThrow != null) {
      // 契约型用例：期望抛出指定异常
      String actualType = thrown == null ? "正常返回 " + Harness.canon(actual) : thrown.getClass().getSimpleName();
      if (thrown != null && tc.expectThrow.equals(actualType)) {
        out.put("status", "pass");
        outcomes.add(out);
        return;
      }
      out.put("status", "fail");
      out.put("expected", "抛出 " + tc.expectThrow);
      out.put("actual", actualType);
      outcomes.add(out);
      throw new AssertionError("契约不符：应抛出 " + tc.expectThrow + "，实际 " + actualType);
    }

    if (thrown != null) {
      out.put("status", "runtime");
      out.put("message", describe(thrown));
      outcomes.add(out);
      throw new AssertionError("RUNTIME" + describe(thrown));
    }

    String expectedText = Harness.canonExpected(returnType, tc.expected);
    String actualText = Harness.isPointer(returnType) ? Harness.canonPointer(returnType, actual) : Harness.canon(actual);
    if (expectedText.equals(actualText)) {
      out.put("status", "pass");
      outcomes.add(out);
      return;
    }
    out.put("status", "fail");
    out.put("expected", expectedText);
    out.put("actual", actualText);
    outcomes.add(out);
    throw new AssertionError("期望 " + expectedText + "，实际 " + actualText);
  }

  @AfterAll
  static void flush() throws Exception {
    StringBuilder sb = new StringBuilder();
    sb.append("{\"setupError\":").append(json(setupError)).append(",\"cases\":[");
    synchronized (outcomes) {
      for (int i = 0; i < outcomes.size(); i++) {
        if (i > 0) sb.append(',');
        sb.append('{');
        int j = 0;
        for (Map.Entry<String, String> entry : outcomes.get(i).entrySet()) {
          if (j++ > 0) sb.append(',');
          sb.append(json(entry.getKey())).append(':').append(json(entry.getValue()));
        }
        sb.append('}');
      }
    }
    sb.append("]}");
    Files.write(
        Paths.get(System.getProperty("arena.results", "arena-results.json")),
        sb.toString().getBytes(StandardCharsets.UTF_8));
  }

  private static String read(String path) throws Exception {
    return new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
  }

  private static String json(String value) {
    if (value == null) return "null";
    StringBuilder sb = new StringBuilder("\"");
    for (char c : value.toCharArray()) {
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    return sb.append('"').toString();
  }

  private static String describe(Throwable t) {
    Throwable root = t;
    while (root.getCause() != null && root.getCause() != root) root = root.getCause();
    StringBuilder sb = new StringBuilder();
    sb.append(root.getClass().getSimpleName());
    if (root.getMessage() != null) sb.append(": ").append(root.getMessage());
    StackTraceElement[] trace = root.getStackTrace();
    for (int i = 0; i < Math.min(4, trace.length); i++) {
      sb.append("\n  at ").append(trace[i]);
    }
    return sb.toString();
  }
}
