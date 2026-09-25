/**
 * 判题器内置的单链表节点（LeetCode 口径）。
 * 只在题目签名里出现 ListNode 时才会被写进沙箱，所以考生代码里不要再定义同名类。
 * 字段是 public：arena 包里的 Harness 靠反射读写它，不能依赖包内可见性。
 */
public class ListNode {
  public int val;
  public ListNode next;

  public ListNode() {}

  public ListNode(int val) {
    this.val = val;
  }

  public ListNode(int val, ListNode next) {
    this.val = val;
    this.next = next;
  }
}
