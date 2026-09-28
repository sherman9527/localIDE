#!/usr/bin/env bash
# 提交署名闸门：作者与提交者的邮箱必须等于 .githooks/publish-identity 里那个发布身份。
#
# 为什么文件内容的发布闸门拦不住这件事：`publish-identity.test.ts` 扫的是**被跟踪的文件**，
# 而身份写在 commit 元数据里 —— 推上去就进了公开历史，收不回来。上一轮脱敏把历史压成一个
# noreply 署名的提交，随后仍有 5 个 commit 直接用本机 `git config` 提了出去（个人邮箱），
# 是推送前手动复扫才发现的。规矩是"不改 git config、身份逐条命令传"，
# 而**"记得传"是靠不住的** ⇒ 交给机器判。
#
# 想换身份就改 `.githooks/publish-identity` 并提交 —— 那是一次可被评审的改动，
# 比留一个 `SKIP=1` 的口子诚实。`git commit --no-verify` 当然还能绕，
# 但那条会在推上去的历史里留下痕迹，而这条闸门要防的是"忘了"，不是"蓄意"。
set -uo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo '[commit-identity] 当前目录不在 git 仓库里，没法判署名' >&2
  exit 1
}
file="${root}/.githooks/publish-identity"

# 没判据就红，不静默放行：一条"没配就等于通过"的闸门，配错的那天就不存在了。
if [ ! -s "${file}" ]; then
  echo "[commit-identity] 判据 ${file} 不存在或为空 —— 闸门不许在没判据时放行" >&2
  exit 1
fi

expected="$(head -n 1 "${file}" | tr -d '\r')"
expected_email="$(printf '%s' "${expected}" | sed -n 's/.*<\(.*\)>.*/\1/p')"
if [ -z "${expected_email}" ]; then
  echo "[commit-identity] ${file} 里没解析出邮箱，要写成：Name <email@domain>" >&2
  exit 1
fi

bad=''
for who in AUTHOR COMMITTER; do
  # git var 会把"env 显式给的 > config > 用户名@主机名兜底"这条优先级算好，
  # 所以这里读它而不是读 git config —— 逐条传身份那条路也要能被验到。
  ident="$(git var "GIT_${who}_IDENT" 2>/dev/null || true)"
  email="$(printf '%s' "${ident}" | sed -n 's/.*<\(.*\)>.*/\1/p')"
  if [ "${email}" != "${expected_email}" ]; then
    bad="${bad}  ${who}: ${ident:-（读不到身份）}\n"
  fi
done

if [ -n "${bad}" ]; then
  echo "[commit-identity] 提交署名不是发布身份（${expected}）：" >&2
  printf '%b' "${bad}" >&2
  echo "  这一次请逐条传身份（本仓库的规矩是不改 git config）：" >&2
  echo "    GIT_AUTHOR_NAME=Name GIT_AUTHOR_EMAIL=${expected_email} \\" >&2
  echo "    GIT_COMMITTER_NAME=Name GIT_COMMITTER_EMAIL=${expected_email} git commit -m ..." >&2
  echo "  或者如果发布身份真的变了：改 ${file} 并提交，让这件事留在 diff 里。" >&2
  exit 1
fi

exit 0
