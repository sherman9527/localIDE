package arena;

import java.io.*;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

/**
 * 判题用的值转换与反射调用工具（无第三方依赖）。
 * 题目只需声明方法签名，用例以 JSON 传入，结果用 canon() 归一化后比较。
 */
public final class Harness {

  public static final class TestCase {
    public final String name;
    public final List<Object> args;
    public final Object expected;
    /** 非空表示这个用例期望的是"抛出该简单类名的异常"（契约型用例） */
    public final String expectThrow;

    TestCase(String name, List<Object> args, Object expected, String expectThrow) {
      this.name = name;
      this.args = args;
      this.expected = expected;
      this.expectThrow = expectThrow;
    }
  }

  public static List<TestCase> loadCases(String path) throws IOException {
    String text = new String(Files.readAllBytes(Paths.get(path)), StandardCharsets.UTF_8);
    Object root = parseJson(text);
    List<?> list = asList(root);
    List<TestCase> out = new ArrayList<>();
    for (Object item : list) {
      Map<String, Object> obj = asMap(item);
      String name = String.valueOf(obj.get("name"));
      List<Object> args = obj.containsKey("input") ? asList(obj.get("input")) : new ArrayList<>();
      Object throwWanted = obj.get("expectThrow");
      out.add(new TestCase(name, args, obj.get("expected"), throwWanted == null ? null : String.valueOf(throwWanted)));
    }
    return out;
  }

  // ---------- JSON（仅支持 object / array / string / number / boolean / null） ----------

  public static Object parseJson(String text) {
    int[] pos = {0};
    Object value = readValue(text, pos);
    skipWs(text, pos);
    return value;
  }

  private static Object readValue(String s, int[] pos) {
    skipWs(s, pos);
    if (pos[0] >= s.length()) throw err(s, pos, "unexpected end");
    char c = s.charAt(pos[0]);
    switch (c) {
      case '{': return readObject(s, pos);
      case '[': return readArray(s, pos);
      case '"': return readString(s, pos);
      case 't': expect(s, pos, "true"); return Boolean.TRUE;
      case 'f': expect(s, pos, "false"); return Boolean.FALSE;
      case 'n': expect(s, pos, "null"); return null;
      default: return readNumber(s, pos);
    }
  }

  private static Map<String, Object> readObject(String s, int[] pos) {
    Map<String, Object> map = new LinkedHashMap<>();
    pos[0]++;
    skipWs(s, pos);
    if (s.charAt(pos[0]) == '}') {
      pos[0]++;
      return map;
    }
    while (true) {
      skipWs(s, pos);
      String key = readString(s, pos);
      skipWs(s, pos);
      if (s.charAt(pos[0]) != ':') throw err(s, pos, "expected :");
      pos[0]++;
      map.put(key, readValue(s, pos));
      skipWs(s, pos);
      char c = s.charAt(pos[0]++);
      if (c == '}') return map;
      if (c != ',') throw err(s, pos, "expected , or }");
    }
  }

  private static List<Object> readArray(String s, int[] pos) {
    List<Object> list = new ArrayList<>();
    pos[0]++;
    skipWs(s, pos);
    if (s.charAt(pos[0]) == ']') {
      pos[0]++;
      return list;
    }
    while (true) {
      list.add(readValue(s, pos));
      skipWs(s, pos);
      char c = s.charAt(pos[0]++);
      if (c == ']') return list;
      if (c != ',') throw err(s, pos, "expected , or ]");
    }
  }

  private static String readString(String s, int[] pos) {
    if (s.charAt(pos[0]) != '"') throw err(s, pos, "expected string");
    StringBuilder sb = new StringBuilder();
    pos[0]++;
    while (true) {
      char c = s.charAt(pos[0]++);
      if (c == '"') return sb.toString();
      if (c != '\\') {
        sb.append(c);
        continue;
      }
      char esc = s.charAt(pos[0]++);
      switch (esc) {
        case 'n': sb.append('\n'); break;
        case 't': sb.append('\t'); break;
        case 'r': sb.append('\r'); break;
        case 'b': sb.append('\b'); break;
        case 'f': sb.append('\f'); break;
        case '/': sb.append('/'); break;
        case '"': sb.append('"'); break;
        case '\\': sb.append('\\'); break;
        case 'u':
          sb.append((char) Integer.parseInt(s.substring(pos[0], pos[0] + 4), 16));
          pos[0] += 4;
          break;
        default: throw err(s, pos, "bad escape");
      }
    }
  }

  private static Object readNumber(String s, int[] pos) {
    int start = pos[0];
    while (pos[0] < s.length() && "-+.eE0123456789".indexOf(s.charAt(pos[0])) >= 0) pos[0]++;
    String token = s.substring(start, pos[0]);
    if (token.isEmpty()) throw err(s, pos, "bad value");
    if (token.indexOf('.') >= 0 || token.indexOf('e') >= 0 || token.indexOf('E') >= 0) {
      return Double.parseDouble(token);
    }
    long v = Long.parseLong(token);
    if (v >= Integer.MIN_VALUE && v <= Integer.MAX_VALUE) return (int) v;
    return v;
  }

  private static void skipWs(String s, int[] pos) {
    while (pos[0] < s.length() && Character.isWhitespace(s.charAt(pos[0]))) pos[0]++;
  }

  private static void expect(String s, int[] pos, String literal) {
    if (!s.startsWith(literal, pos[0])) throw err(s, pos, "expected " + literal);
    pos[0] += literal.length();
  }

  private static RuntimeException err(String s, int[] pos, String msg) {
    return new RuntimeException("JSON 解析失败 @" + pos[0] + ": " + msg);
  }

  @SuppressWarnings("unchecked")
  private static List<Object> asList(Object v) {
    if (v == null) return new ArrayList<>();
    return (List<Object>) v;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> asMap(Object v) {
    return (Map<String, Object>) v;
  }

  // ---------- 方法签名解析与参数转换 ----------

  /** 形如 `int[] twoSum(int[] nums, int target)`；返回 [returnType, name, paramTypes...] */
  public static String[] parseSignature(String signature) {
    String sig = signature.trim();
    int open = sig.indexOf('(');
    int close = sig.lastIndexOf(')');
    if (open < 0 || close < open) throw new IllegalArgumentException("非法方法签名: " + signature);
    String head = sig.substring(0, open).trim();
    String returnType = head.substring(0, head.lastIndexOf(' ')).trim();
    String name = head.substring(head.lastIndexOf(' ') + 1).trim();
    String params = sig.substring(open + 1, close).trim();
    List<String> types = new ArrayList<>();
    if (!params.isEmpty()) {
      int depth = 0;
      StringBuilder cur = new StringBuilder();
      for (char c : params.toCharArray()) {
        if (c == '<') depth++;
        if (c == '>') depth--;
        if (c == ',' && depth == 0) {
          types.add(paramType(cur.toString()));
          cur.setLength(0);
        } else cur.append(c);
      }
      types.add(paramType(cur.toString()));
    }
    List<String> out = new ArrayList<>();
    out.add(returnType);
    out.add(name);
    out.addAll(types);
    return out.toArray(new String[0]);
  }

  /** 去掉参数名只留类型：`List&lt;String&gt; names` → `List&lt;String&gt;`（泛型必须留着，convert 要看它）。 */
  private static String paramType(String declaration) {
    String d = declaration.trim();
    int space = lastTypeSeparator(d);
    return (space >= 0 ? d.substring(0, space) : d).trim();
  }

  private static int lastTypeSeparator(String d) {
    int depth = 0;
    for (int i = d.length() - 1; i >= 0; i--) {
      char c = d.charAt(i);
      if (c == '>') depth++;
      if (c == '<') depth--;
      if (Character.isWhitespace(c) && depth == 0) return i;
    }
    return -1;
  }

  public static Method findMethod(Class<?> clazz, String name, String[] paramTypes) throws NoSuchMethodException {
    List<Method> candidates = new ArrayList<>();
    candidates.addAll(Arrays.asList(clazz.getMethods()));
    for (Method declared : clazz.getDeclaredMethods()) {
      if (!candidates.contains(declared)) candidates.add(declared);
    }
    Method loose = null;
    for (Method m : candidates) {
      if (!m.getName().equals(name) || m.getParameterCount() != paramTypes.length) continue;
      Class<?>[] declared = m.getParameterTypes();
      boolean exact = true;
      for (int i = 0; i < declared.length; i++) {
        if (!matchesType(declared[i], paramTypes[i])) {
          exact = false;
          break;
        }
      }
      if (exact) return m;
      if (loose == null) loose = m;
    }
    // 名字与参数个数对得上就放行：类型不符会在 convertArgs/invoke 阶段报出更具体的错
    if (loose != null) return loose;
    throw new NoSuchMethodException("找不到方法 " + name + " " + Arrays.toString(paramTypes)
        + "；请把题目里的方法签名写成与实现完全一致的形式");
  }

  /** 签名里允许写简单名（int[]、List、String、TreeNode），不必写全限定名或 JVM 描述符。 */
  private static boolean matchesType(Class<?> declared, String spec) {
    String s = spec.trim();
    int angle = s.indexOf('<');
    if (angle >= 0) s = s.substring(0, angle).trim(); // 反射只看到裸类型，泛型实参留给 convert 用
    if (s.endsWith("[]")) {
      return declared.isArray() && matchesType(declared.getComponentType(), s.substring(0, s.length() - 2));
    }
    switch (s) {
      case "int": return declared == int.class || declared == Integer.class;
      case "Integer": return declared == Integer.class || declared == int.class;
      case "long": return declared == long.class || declared == Long.class;
      case "Long": return declared == Long.class || declared == long.class;
      case "double": return declared == double.class || declared == Double.class;
      case "Double": return declared == Double.class || declared == double.class;
      case "float": return declared == float.class || declared == Float.class;
      case "boolean": return declared == boolean.class || declared == Boolean.class;
      case "Boolean": return declared == Boolean.class || declared == boolean.class;
      case "char": return declared == char.class || declared == Character.class;
      case "byte": return declared == byte.class;
      case "short": return declared == short.class;
      case "String": return declared == String.class;
      case "List": case "ArrayList": case "LinkedList":
        return java.util.List.class.isAssignableFrom(declared);
      case "Set": case "HashSet": case "TreeSet": case "LinkedHashSet":
        return java.util.Set.class.isAssignableFrom(declared);
      case "Map": case "HashMap": case "TreeMap": case "LinkedHashMap":
        return java.util.Map.class.isAssignableFrom(declared);
      default: return declared.getSimpleName().equals(s) || declared.getName().equals(s);
    }
  }

  public static Object[] convertArgs(String[] paramTypes, List<Object> json) {
    Object[] out = new Object[paramTypes.length];
    for (int i = 0; i < paramTypes.length; i++) {
      Object raw = i < json.size() ? json.get(i) : null;
      out[i] = convert(paramTypes[i], raw);
    }
    return out;
  }

  @SuppressWarnings("unchecked")
  private static Object convert(String type, Object v) {
    switch (type) {
      case "int": case "java.lang.Integer": return v == null ? null : ((Number) v).intValue();
      case "long": case "java.lang.Long":
        // 大整数在题目 JSON 里建议写成字符串：JS 的 number 超过 2^53 就已经丢精度了
        if (v instanceof String) return Long.parseLong(((String) v).trim());
        return v == null ? null : ((Number) v).longValue();
      case "double": case "java.lang.Double": return v == null ? null : ((Number) v).doubleValue();
      case "float": return v == null ? null : ((Number) v).floatValue();
      case "boolean": case "java.lang.Boolean": return v;
      case "char": return v == null ? null : ((String) v).charAt(0);
      case "String": return v;
      case "int[]": return toIntArray(v, true);
      case "long[]": return toLongArray(v);
      case "double[]": return toDoubleArray(v);
      case "String[]": {
        List<Object> list = (List<Object>) v;
        return list == null ? null : list.toArray(new String[0]);
      }
      default: break;
    }
    // 指针结构题（N-04）：签名里写 ListNode / TreeNode 就按 LeetCode 口径的数组建对象
    if (isPointer(type)) return buildPointer(type, v);
    if (type.endsWith("[][]")) {
      // 嵌套原始数组（int[][]、String[][] …）：按组件类型递归构造真正的数组。
      // 之前这类签名会被原样透传成 List，反射调用时抛 IllegalArgumentException，题目物理不可判。
      return toArray(type, v);
    }
    if (type.endsWith("[]") && !type.startsWith("int") && !type.startsWith("long") && !type.startsWith("double")) {
      // 其它对象数组：String[] 之外的自定义类型按原样透传，交给反射去报不匹配
      return v;
    }
    if (type.startsWith("java.util.List") || type.equals("List")) {
      List<Object> list = (List<Object>) v;
      if (list == null) return null;
      if (type.contains("String")) {
        List<String> out = new ArrayList<>();
        for (Object o : list) out.add(o == null ? null : String.valueOf(o));
        return out;
      }
      if (type.contains("Long")) {
        List<Long> out = new ArrayList<>();
        for (Object o : list) out.add(o == null ? null : ((Number) o).longValue());
        return out;
      }
      List<Integer> out = new ArrayList<>();
      for (Object o : list) {
        // 元素不是数字（嵌套 List、对象列表）就原样透传：静默 intValue() 会把大数截断成垃圾喂给考生代码
        if (!(o instanceof Number) && o != null) return list;
        out.add(o == null ? null : ((Number) o).intValue());
      }
      return out;
    }
    return v;
  }

  /** 递归构造多维数组：`int[][]` → `Array.newInstance(int[].class, n)`，每层再走 convert。 */
  private static Object toArray(String type, Object v) {
    if (v == null) return null;
    if (!(v instanceof List)) return v;
    List<Object> items = (List<Object>) v;
    String component = type.substring(0, type.length() - 2);
    Object array = java.lang.reflect.Array.newInstance(componentClass(component), items.size());
    for (int i = 0; i < items.size(); i++) java.lang.reflect.Array.set(array, i, convert(component, items.get(i)));
    return array;
  }

  private static Class<?> componentClass(String type) {
    switch (type) {
      case "int": return int.class;
      case "long": return long.class;
      case "double": return double.class;
      case "float": return float.class;
      case "boolean": return boolean.class;
      case "char": return char.class;
      case "byte": return byte.class;
      case "short": return short.class;
      case "String": return String.class;
      default:
        if (type.endsWith("[]")) {
          // "int[]" 这类还要再降一层：Class.forName("int[]") 是不存在的名字，必须按组件类型构造数组类
          return java.lang.reflect.Array.newInstance(componentClass(type.substring(0, type.length() - 2)), 0).getClass();
        }
        try {
          return Class.forName(type);
        } catch (ClassNotFoundException notFound) {
          return Object.class;
        }
    }
  }

  private static int[] toIntArray(Object v, boolean strict) {
    if (v == null) return null;
    List<Object> list = (List<Object>) v;
    int[] out = new int[list.size()];
    for (int i = 0; i < out.length; i++) out[i] = list.get(i) == null ? 0 : ((Number) list.get(i)).intValue();
    return out;
  }

  private static long[] toLongArray(Object v) {
    if (v == null) return null;
    List<Object> list = (List<Object>) v;
    long[] out = new long[list.size()];
    for (int i = 0; i < out.length; i++) out[i] = list.get(i) == null ? 0L : ((Number) list.get(i)).longValue();
    return out;
  }

  private static double[] toDoubleArray(Object v) {
    if (v == null) return null;
    List<Object> list = (List<Object>) v;
    double[] out = new double[list.size()];
    for (int i = 0; i < out.length; i++) out[i] = list.get(i) == null ? 0d : ((Number) list.get(i)).doubleValue();
    return out;
  }

  // ---------- 指针结构：ListNode / TreeNode ----------
  // 内置类在默认包，而本类在 arena 包里 —— Java 不允许 import 默认包，所以只能反射读写。

  /** 一次比较最多看多少个节点：环或失控构造要报错，不能把判题进程挂死。 */
  private static final int NODE_LIMIT = 200_000;

  public static boolean isPointer(String type) {
    String s = type == null ? "" : type.trim();
    return "ListNode".equals(s) || "TreeNode".equals(s);
  }

  /** 把题目里的 `[1,2,3]` / 层序 `[3,9,20,null,null,15,7]` 建成真对象；空数组与 `[null]` 都建成 null。 */
  @SuppressWarnings("unchecked")
  public static Object buildPointer(String type, Object json) {
    Object source = json instanceof String ? parseJson((String) json) : json;
    if (source == null) return null;
    if (!(source instanceof List)) {
      throw new IllegalArgumentException(
          type + " 的取值要写成数组（ListNode 用 [1,2,3]，TreeNode 用层序 [3,9,20,null,null,15,7]），实际收到 "
              + source.getClass().getSimpleName());
    }
    List<Object> items = (List<Object>) source;
    if (items.isEmpty() || items.get(0) == null) return null;
    try {
      return "ListNode".equals(type) ? buildList(items) : buildTree(items);
    } catch (ReflectiveOperationException missing) {
      throw new IllegalStateException(
          "判题器没能构造 " + type + "：签名声明了它，但沙箱里没有内置的 " + type + " 类（" + missing.getMessage() + "）");
    }
  }

  /** 期望值与实际值走同一条归一化路径，否则"写法不同但等价的树"会被判成失败。 */
  public static String canonPointer(String type, Object value) {
    if (value != null && isPointer(value.getClass().getName())) return canon(value);
    if (value == null) return "ListNode".equals(type) ? "[]" : "null";
    return canon(value);
  }

  /** 题目里期望值写成 `[1,2]` / 层序数组，先建成对象再归一化，和考生返回值同一口径。 */
  public static String canonExpected(String type, Object json) {
    return isPointer(type) ? canonPointer(type, buildPointer(type, json)) : canon(json);
  }

  private static Object buildList(List<Object> items) throws ReflectiveOperationException {
    Class<?> clazz = Class.forName("ListNode");
    Constructor<?> ctor = clazz.getConstructor(int.class);
    Field next = clazz.getField("next");
    Object head = null;
    Object tail = null;
    for (Object item : items) {
      Object node = ctor.newInstance(intOf(item));
      if (tail == null) {
        head = node;
        tail = node;
      } else {
        next.set(tail, node);
        tail = node;
      }
    }
    return head;
  }

  private static Object buildTree(List<Object> items) throws ReflectiveOperationException {
    Class<?> clazz = Class.forName("TreeNode");
    Constructor<?> ctor = clazz.getConstructor(int.class);
    Field left = clazz.getField("left");
    Field right = clazz.getField("right");
    Object root = ctor.newInstance(intOf(items.get(0)));
    Deque<Object> queue = new ArrayDeque<Object>();
    queue.add(root);
    int i = 1;
    while (!queue.isEmpty() && i < items.size()) {
      Object parent = queue.poll();
      for (Field side : new Field[] {left, right}) {
        if (i >= items.size()) break;
        Object value = items.get(i++);
        if (value == null) continue;
        Object child = ctor.newInstance(intOf(value));
        side.set(parent, child);
        queue.add(child);
      }
    }
    return root;
  }

  private static int intOf(Object v) {
    if (v instanceof Number) return ((Number) v).intValue();
    if (v instanceof String) return Integer.parseInt(((String) v).trim());
    throw new IllegalArgumentException("节点值必须是整数，收到 " + v);
  }

  private static Object field(Object node, String name) {
    try {
      Field f = node.getClass().getField(name);
      f.setAccessible(true);
      return f.get(node);
    } catch (ReflectiveOperationException broken) {
      throw new IllegalStateException("内置 " + node.getClass().getSimpleName() + " 缺少字段 " + name + "：" + broken.getMessage());
    }
  }

  private static String canonList(Object head) {
    List<String> parts = new ArrayList<String>();
    Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>());
    Object cur = head;
    while (cur != null) {
      if (!seen.add(cur)) throw new IllegalStateException("链表里出现环，无法比较结果");
      parts.add(String.valueOf(((Number) field(cur, "val")).intValue()));
      cur = field(cur, "next");
    }
    return "[" + String.join(",", parts) + "]";
  }

  private static String canonTree(Object root) {
    List<String> parts = new ArrayList<String>();
    // ArrayDeque 不收 null，而层序比较恰恰要把"空位"也排进队列 —— 用 List + 游标当队列
    List<Object> queue = new ArrayList<Object>();
    Set<Object> seen = Collections.newSetFromMap(new IdentityHashMap<Object, Boolean>());
    queue.add(root);
    int visited = 0;
    for (int head = 0; head < queue.size(); head++) {
      Object node = queue.get(head);
      if (node == null) {
        parts.add("null");
        continue;
      }
      if (!seen.add(node) || ++visited > NODE_LIMIT) {
        throw new IllegalStateException("树里有环或节点超过 " + NODE_LIMIT + " 个，无法比较结果");
      }
      parts.add(String.valueOf(((Number) field(node, "val")).intValue()));
      queue.add(field(node, "left"));
      queue.add(field(node, "right"));
    }
    // 尾部空位是写法差异，不是结构差异：[1,2] 与 [1,2,null,null] 是同一棵树
    while (!parts.isEmpty() && "null".equals(parts.get(parts.size() - 1))) parts.remove(parts.size() - 1);
    return "[" + String.join(",", parts) + "]";
  }

  // ---------- 结果归一化 ----------

  public static String canon(Object v) {
    if (v == null) return "null";
    String className = v.getClass().getName();
    if ("ListNode".equals(className)) return canonList(v);
    if ("TreeNode".equals(className)) return canonTree(v);
    if (v instanceof Object[]) {
      StringBuilder sb = new StringBuilder("[");
      Object[] arr = (Object[]) v;
      for (int i = 0; i < arr.length; i++) sb.append(i > 0 ? "," : "").append(canon(arr[i]));
      return sb.append("]").toString();
    }
    if (v instanceof int[]) {
      int[] a = (int[]) v;
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < a.length; i++) sb.append(i > 0 ? "," : "").append(a[i]);
      return sb.append("]").toString();
    }
    if (v instanceof long[]) {
      long[] a = (long[]) v;
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < a.length; i++) sb.append(i > 0 ? "," : "").append(a[i]);
      return sb.append("]").toString();
    }
    if (v instanceof double[]) {
      double[] a = (double[]) v;
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < a.length; i++) sb.append(i > 0 ? "," : "").append(num(a[i]));
      return sb.append("]").toString();
    }
    if (v instanceof float[]) {
      // 没有这个分支时 float[] 会走到 String.valueOf(对象) → 打出地址，任何正确解都永远 fail
      float[] a = (float[]) v;
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < a.length; i++) sb.append(i > 0 ? "," : "").append(num(a[i]));
      return sb.append("]").toString();
    }
    if (v instanceof boolean[]) {
      boolean[] a = (boolean[]) v;
      StringBuilder sb = new StringBuilder("[");
      for (int i = 0; i < a.length; i++) sb.append(i > 0 ? "," : "").append(a[i]);
      return sb.append("]").toString();
    }
    if (v instanceof char[]) {
      return "\"" + new String((char[]) v) + "\"";
    }
    if (v instanceof List) {
      StringBuilder sb = new StringBuilder("[");
      List<?> list = (List<?>) v;
      for (int i = 0; i < list.size(); i++) sb.append(i > 0 ? "," : "").append(canon(list.get(i)));
      return sb.append("]").toString();
    }
    if (v instanceof Set) {
      List<String> parts = new ArrayList<>();
      for (Object o : (Set<?>) v) parts.add(canon(o));
      Collections.sort(parts);
      return "[" + String.join(",", parts) + "]";
    }
    if (v instanceof Map) {
      Map<?, ?> map = (Map<?, ?>) v;
      List<String> parts = new ArrayList<>();
      for (Map.Entry<?, ?> e : map.entrySet()) parts.add(String.valueOf(e.getKey()) + ":" + canon(e.getValue()));
      Collections.sort(parts);
      return "{" + String.join(",", parts) + "}";
    }
    if (v instanceof Long || v instanceof Integer || v instanceof Short || v instanceof Byte) {
      // 整数直接出字面量：过 double 会让 2^53 以上的 long（如 Long.MAX_VALUE）丢精度
      return String.valueOf(((Number) v).longValue());
    }
    if (v instanceof Number) {
      double d = ((Number) v).doubleValue();
      if (Math.abs(d - Math.rint(d)) < 1e-9 && Math.abs(d) < 1e15) return String.valueOf((long) d);
      return num(d);
    }
    return String.valueOf(v);
  }

  private static String num(double d) {
    // 先挡住大数：(long)d 与 Math.round 在 |d| >= 2^63 时都会饱和成同一个值，
    // 不挡就会把 1e19 和 1e300 判成相等（橡皮图章）
    if (!Double.isFinite(d) || Math.abs(d) >= 1e15) return String.valueOf(d);
    if (Math.abs(d - Math.rint(d)) < 1e-9) return String.valueOf((long) d);
    return String.valueOf(Math.round(d * 1e6) / 1e6);
  }

  private Harness() {}
}
