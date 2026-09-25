/**
 * 判题器内置的二叉树节点（LeetCode 口径，序列化用层序数组、null 表示空位）。
 * 只在题目签名里出现 TreeNode 时才写进沙箱；字段 public 的理由同 ListNode。
 */
public class TreeNode {
  public int val;
  public TreeNode left;
  public TreeNode right;

  public TreeNode() {}

  public TreeNode(int val) {
    this.val = val;
  }

  public TreeNode(int val, TreeNode left, TreeNode right) {
    this.val = val;
    this.left = left;
    this.right = right;
  }
}
