#!/usr/bin/env bash
# WI-91（子项目 A2：镜像里一条真能交互执行的 Scala kernel）路径 B 的取件脚本。
#
# 它做的事：按 docker-cache/toree/<版本>/toree-artifacts.tsv 里钉死的 **sha512 + sha256** 把 Apache Toree
# 的二进制制品取下来，验过之后**只把清单里列出的那一个 fat jar** 放进 --dest，并当场跑三道"这条类路径
# 会不会把判题环境带坏"的闸门。
#
# 为什么形状与路径 A（scripts/fetch-almond.sh）不同，但纪律相同：
#   ⚠ 路径 A **未落地**：跟踪树里没有 scripts/fetch-almond.sh，也没有 arena-scala-almond kernelspec，
#   别在本仓库找这两个文件。它的实现只活在探索档
#   `.superpowers/sdd/2026-10-10-scala-jupyter-kernel-spike-wi91/path-A-almond/`（该目录不被 git 跟踪，
#   别的 clone 上未必有）。下文所有"路径 A / A 档"都指那份归档，不是仓库里可解析的路径。
# * Almond 那条要自己解闭包（93 个 jar，还得按 coursier 语义钉版本），Toree 的公开制品就是**一个 26MB 的
#   sbt-assembly fat jar**，依赖已经烤在里面 ⇒ 取件单位是"一份 tar + 一个成员"。
# * A 档那条"与 /opt/spark/jars 同名的 artifact 让 Spark 那份赢"在这里**没有逐件丢弃这个旋钮**：
#   fat jar 里那 753 个 scala/** 类（Scala 2.12.15）删不掉。同一条纪律只剩一种表达 ——
#   **类路径顺序**：/opt/spark/jars/* 必须排在 fat jar 前面（镜像里 Spark 3.5.5 是 2.12.18 编的）。
#   所以这里把那道"漂移闸门"改成了三样东西（下面 GATE 1/2/3），每一样都是当场实测出来的坏法，不是想象。
#
# 三条只有实测才知道的事（都写在对应的闸门旁边）：
# 1. archive.apache.org 从本机 ~50KB/s 而且**会在尾部断流**（下到 97% 被 reset，curl 重试也接不上），
#    downloads.apache.org 同样要 6 分钟；tuna 那份是**同一串字节**（sha512 逐字节相等）且十几秒到完。
#    ⇒ --dist-base 是一个**列表**，按能不能下完排，不是按权威性排；三个都失败才算失败，不许静默拿半个文件。
# 2. Toree 不发 GitHub Releases（api.github.com/repos/apache/toree/releases/latest 的 tag_name 是 null），
#    所以 URL 只能来自 Apache dist 的目录形状。
# 3. 制品里 **一个 org/apache/spark 类都没有**（Spark 依赖是 provided，toree-ivy.xml 写的 3.0.3）⇒
#    "和镜像里的 Spark 3.5.5 同不同得了一条类路径"这件事没法从字节判断，只能由那一次 --execute 探针回答；
#    但"别把第二份 Spark 装进来"是可以从字节判断的，所以 GATE 1 判它。
#
# ⚠ 这个脚本**不写** /opt/spark、/opt/spark-jars、/opt/scala 里的任何东西（红线①）：它只往 --dest 里放
#   自己那一个 jar。/opt/spark 是指向 pip pyspark 的符号链接 ⇒ 那是判题侧也在用的那份安装，只读挂上类路径。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VERSION="${TOREE_VERSION:-}"
MANIFEST="${TOREE_MANIFEST:-}"
DEST="${TOREE_DEST:-}"
# 下载缓存：命中且校验通过就不重下（24MB 那份 tar）。宿主默认落在 docker-cache/toree/<版本>/download-cache ——
# 那是**宿主侧重验（--verify-only）与本地排障的缓存**；镜像构建**不读这两处**（.dockerignore 把 payload/ 与
# download-cache/ 排出上下文；构建期另有自己的 BuildKit cache mount，机器本地、可被 prune）。可复现契约只认
# 清单（URL + sha512/sha256 + 逐件验不过就停），详见 docker/BUILDINFO.md「Toree 的可复现取件」。
CACHE="${TOREE_CACHE:-}"
# Apache dist 的三条 base（同一个相对路径拼上去是同一串字节）。顺序 = 可用性优先，2026-10-20 本机复测：
# tuna 24MB 用时 1.0s；dlcdn 同一串字节（与 tuna 那份 cmp 逐字节相等）但 3m19s；archive 当天只复核了
# HEAD 200，整档**今天没重测** —— 探索档实测它 ~50KB/s 且在尾部断流，留作最后兜底。三个都失败才算失败。
DIST_BASES="${TOREE_DIST_BASES:-https://mirrors.tuna.tsinghua.edu.cn/apache https://dlcdn.apache.org https://archive.apache.org/dist}"
VERIFY_ONLY=0

# 版本相关的默认值必须**等参数解析完**再回填：第一版在这里就用 VERSION 插值出 MANIFEST/DEST/CACHE，
# 而 --version 在其后的循环里才赋值 VERSION ⇒ --version 是死旋钮（Dockerfile 传的那次是 no-op；它同时
# 显式传了 --manifest/--dest/--cache，构建才被这个坏法瞒住）。"默认值依赖版本"的变量，只能在版本
# 定下来之后再 default。
apply_version_defaults() {
  [ -n "$VERSION" ] || VERSION="0.5.0-incubating"
  [ -n "$MANIFEST" ] || MANIFEST="${REPO_ROOT}/docker-cache/toree/${VERSION}/toree-artifacts.tsv"
  [ -n "$DEST" ] || DEST="${REPO_ROOT}/docker-cache/toree/${VERSION}/payload"
  [ -n "$CACHE" ] || CACHE="${REPO_ROOT}/docker-cache/toree/${VERSION}/download-cache"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --manifest) MANIFEST="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --cache) CACHE="$2"; shift 2 ;;
    --dist-base) DIST_BASES="$2"; shift 2 ;;   # 值是一个**空格分隔的列表**，整体加引号传
    --dist-base=*) echo "[fetch-toree] --dist-base 要用空格分开值，不用等号：--dist-base \"url1 url2\"" >&2; exit 2 ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help)
      apply_version_defaults   # 打印前先回填，否则 --version V 之后 -h 显示的仍是旧默认（死旋钮的同款坏法）
      sed -n '1,18p' "$0"
      echo "用法：$0 [--version V] [--dest DIR] [--cache DIR] [--manifest TSV] [--dist-base \"URL1 URL2 …\"] [--verify-only]"
      echo "今天的默认值：VERSION=${VERSION} DEST=${DEST} MANIFEST=${MANIFEST}"
      echo "                CACHE=${CACHE}"
      echo "                DIST_BASES=${DIST_BASES}"
      exit 0 ;;
    *) echo "[fetch-toree] 不认识的参数：$1（-h 看用法）" >&2; exit 2 ;;
  esac
done

apply_version_defaults

log() { printf '[fetch-toree] %s\n' "$*"; }
die() { log "$@"; exit 1; }
sha_of() { sha256sum "$1" | awk '{print $1}'; }
sha512_of() { sha512sum "$1" | awk '{print $1}'; }
# 清单里的第 N 列（TAB 分隔）
col() { printf '%s' "$1" | cut -f"$2"; }

[ -s "$MANIFEST" ] || die "清单不在或为空：${MANIFEST} ⇒ 无法校验任何东西。清单是**被 git 跟踪**的那一半（jar 载荷不是），它没了就是仓库坏了，别去下一份新的顶上。"
command -v curl >/dev/null || die "没有 curl，取不了件"
command -v sha256sum >/dev/null || die "没有 sha256sum，无法校验 ⇒ 宁可不装也不装没验过的 jar"
command -v tar >/dev/null || die "没有 tar，解不开那份 .tar.gz"

mkdir -p "$DEST" "$DEST/lib"
[ "$VERIFY_ONLY" = 1 ] || mkdir -p "$CACHE"

# ------------------------------------------------------------------ 读清单
DIST_ROWS=""
EXTRACT_ROWS=""
while IFS= read -r row; do
  case "$row" in ''|'#'*) continue ;; esac
  IFS=$'\t' read -r kind relpath sha256 name sha512 <<< "$row"
  # 缺列的行第一版是 `[ -n "$name" ] || continue` 静默跳过 ⇒ 清单少一行 dist/extract，下游撞的是
  # "dist 行应该有且只有 1 条"这种间接报错，或者 kernel 缺主制品还看起来装完了。畸形行必须当场停并点名。
  { [ -n "$kind" ] && [ -n "$relpath" ] && [ -n "$sha256" ] && [ -n "$name" ]; } || die "清单里有畸形行：「${row}」⇒ 每行必须是 5 列（kind<TAB>相对路径<TAB>sha256<TAB>落盘名<TAB>sha512，无 sha512 写 -），前四列任何一列缺失都不许跳过、要改回来。"
  case "$kind" in
    dist)    DIST_ROWS="${DIST_ROWS}${relpath}"$'\t'"${sha256}"$'\t'"${name}"$'\t'"${sha512:-}"$'\n' ;;
    extract) EXTRACT_ROWS="${EXTRACT_ROWS}${relpath}"$'\t'"${sha256}"$'\t'"${name}"$'\t'"${sha512:-}"$'\n' ;;
    *) die "清单里出现不认识的 kind「${kind}」（${name}）⇒ 只支持 dist / extract，别猜它的意思" ;;
  esac
done < <(grep -v '^[[:space:]]*#' "$MANIFEST" | grep -v '^[[:space:]]*$')

n_dist="$(printf '%s' "$DIST_ROWS" | grep -c '^' || true)"
n_extract="$(printf '%s' "$EXTRACT_ROWS" | grep -c '^' || true)"
[ "$n_dist" = "1" ] || die "清单里 dist 行应该有且只有 1 条（那份 tar），现在是 ${n_dist} 条 ⇒ 要么有人加了第二个制品，要么这一档的取件单位变了"
[ "$n_extract" -ge 1 ] || die "清单里没有 extract 行 ⇒ 取到 tar 也不会往 ${DEST} 放任何东西，kernel 一定起不来"

# ------------------------------------------------------------------ 1) 取 tar（多 base 逐个试）
get_dist() { # $1=relpath $2=sha256 $3=name $4=sha512
  local rel="$1" want256="$2" name="$3" want512="$4" target="${CACHE}/$3" tried="" b got
  if [ -f "$target" ]; then
    got="$(sha_of "$target")"
    if [ "$got" = "$want256" ]; then log "缓存命中且校验通过：${target}"; return 0; fi
    if [ "$VERIFY_ONLY" = 1 ]; then die "缓存里的 ${target} 校验不过（期望 ${want256}，实得 ${got}）⇒ --verify-only 不联网，先查是不是被人动过"; fi
    log "缓存里那份 ${name} 校验不过（期望 ${want256} 实得 ${got}）⇒ 重下"
    rm -f "$target"
  fi
  if [ "$VERIFY_ONLY" = 1 ]; then
    die "校验模式缺制品：${target}（清单里的 dist 行 = ${rel}）⇒ 先在宿主跑一次本脚本把缓存喂满，或者别加 --verify-only"
  fi
  for b in $DIST_BASES; do
    local url="${b}/${rel}"
    tried="${tried}
    ${url}"
    log "试：${url}"
    # 注意 curl 的参数选择，每一条都对应踩过的坑：
    #   -f：HTTP 4xx/5xx 算失败（404 不许被当成"下到一个空文件"）
    #   --retry 3 而**不是**更多：这台机器上实测过"尾部断流 + 重试"会把半个文件留在盘上，
    #     真正的防线是下面的尺寸核对 + sha512 + sha256 三重校验，不是重试次数。
    #   --speed-limit/--speed-time：连接挂住（不断也不前进）时 60s 内切下一条 base，
    #     不然构建会挂在那儿看不到原因（A 档撞过 GitHub 那个 asset 的同类形状）。
    rm -f "${target}.part" "${target}.curl.log"
    # curl 的输出落 .curl.log 而不是 /dev/null（-sS：去掉进度表、**保留报错**）：base 列表**就是**这里的
    # 韧性机制，"哪条 base 死于什么"（DNS / 404/403 / TLS / 断流）是排查时唯一能读的证据。第一版把它丢进
    # /dev/null、失败时统一猜一句"多半是断流"——那是猜不是读；Dockerfile 里 Redis/JUnit 的取件块失败时
    # 都 tail 日志，同形。
    if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 20 --speed-limit 4096 --speed-time 60 \
         -o "${target}.part" "$url" >"${target}.curl.log" 2>&1; then
      got="$(sha_of "${target}.part")"
      if [ "$got" != "$want256" ]; then
        log "  ⇦ 字节不对（期望 sha256 ${want256}，实得 ${got}）⇒ 换下一条 base"
        rm -f "${target}.part" "${target}.curl.log"; continue
      fi
      if [ -n "$want512" ] && [ "$(sha512_of "${target}.part")" != "$want512" ]; then
        log "  ⇦ sha512 不对（Apache 官方发布的那把尺子）⇒ 换下一条 base"
        rm -f "${target}.part" "${target}.curl.log"; continue
      fi
      mv "${target}.part" "$target"
      rm -f "${target}.curl.log"
      log "  ⇦ 拿到（sha256 与 sha512 都对上）：${target}"
      return 0
    fi
    log "  ⇦ 下载失败（curl 非 0）：${url}"
    log "     curl 报错（最后 8 行；404/403=这一版不在这站上，Could not resolve/TLS=网络，transfer closed=断流）："
    tail -8 "${target}.curl.log" | sed 's/^/       /' || true
    rm -f "${target}.part" "${target}.curl.log"
  done
  log "三条 base 都没能取到 ${name}，试过的 URL："
  printf '%s\n' "$tried"
  die "这一档不许带着半个制品继续 ⇒ 构建到此为止。排查顺序：先手动 curl 一条 base 看是网络还是清单钉错了版本。"
}

# ------------------------------------------------------------------ 2) 解出 extract 行
extract_all() { # $1=tarball
  local tar="$1" tmp member rel want name got
  # 解压目录用全局 TMP_EXTRACT + EXIT trap：函数里的 `trap ... RETURN` 在没开 functrace 时不生效，
  # 那样失败路径上会留下一个 /tmp/fetch-toree.* 没人收 —— 本档第 5 项代价判的就是"没留残骸"。
  TMP_EXTRACT="$(mktemp -d /tmp/fetch-toree.XXXXXX)"
  tmp="$TMP_EXTRACT"
  while IFS=$'\t' read -r rel want name _; do
    [ -n "$rel" ] || continue
    member="${DEST}/${name}"
    if [ -f "$member" ] && [ "$(sha_of "$member")" = "$want" ]; then
      log "已在位且校验通过：${member}"
      continue
    fi
    if [ "$VERIFY_ONLY" = 1 ]; then
      die "校验模式缺文件：${member}（清单 extract 行 = ${rel}，期望 sha256 ${want}）"
    fi
    log "从制品里取成员：${rel}"
    tar -xzf "$tar" -C "$tmp" "$rel" || die "制品里没有成员「${rel}」⇒ 清单与那份 tar 不是同一个版本（tar 是 $(basename "$tar")）"
    mkdir -p "$(dirname "$member")"
    cp "${tmp}/${rel}" "$member"
    got="$(sha_of "$member")"
    if [ "$got" != "$want" ]; then
      rm -f "$member"
      die "校验失败：${member}
  期望 sha256 ${want}
  实得 sha256 ${got}
  ⇒ 坏文件已删掉，没留在 ${DEST}。要么 tar 被换过，要么清单钉错了版本，两种都要停下来问人。"
    fi
  done <<< "$(printf '%s' "$EXTRACT_ROWS")"
}

TARBALL=""
TMP_EXTRACT=""
# 全局 EXIT trap（不是函数里的 RETURN trap —— 那个在没开 functrace 的 bash 里不生效，失败路径上
# 会留下一个 /tmp/fetch-toree.* 目录没人收，而本档第 5 项代价判的正是"有没有新增可写状态/残留"）
trap 'if [ -n "$TMP_EXTRACT" ] && [ -d "$TMP_EXTRACT" ]; then rm -rf "$TMP_EXTRACT"; fi' EXIT
while IFS=$'\t' read -r rel sha256 name sha512; do
  [ -n "$rel" ] || continue
  get_dist "$rel" "$sha256" "$name" "$sha512"
  TARBALL="${CACHE}/${name}"
done <<< "$(printf '%s' "$DIST_ROWS")"

if [ "$VERIFY_ONLY" = 1 ]; then
  log "校验模式：不解压、不覆盖，只核 ${DEST} 里的字节"
else
  extract_all "$TARBALL"
fi

# 逐件复核（**两种模式都跑**）。这一条是补出来的：第一版的 --verify-only 只在这段之前查过
# "已在位且 sha 对"，而 sha 不对时走的是"重解一遍并覆盖"那条路 —— 于是校验模式对坏字节是**绿的**
# （实测：把 jar 改坏一个字节，CORRUPT_EXIT=0）。"verify-only" 这个词承诺的是"验"，不是"验不验都行"，
# 所以这里加一道与模式无关的收尾复核：少了它，宿主侧那条 --verify-only 就是一条装饰。
while IFS=$'\t' read -r rel want name _; do
  [ -n "$rel" ] || continue
  member="${DEST}/${name}"
  if [ ! -f "$member" ]; then
    die "清单里的第 ${name} 件不在 ${member}（期望 sha256 ${want}）⇒ 上面某一步没落盘，或者 --dest 指错了目录"
  fi
  got="$(sha_of "$member")"
  [ "$got" = "$want" ] || die "校验失败：文件 ${member}
  期望 sha256 ${want}（清单钉的）
  实得 sha256 ${got}
  来源：制品 $(basename "${TARBALL:-未取}") 里的成员 ${rel}
  ⇒ 别删了重下就当没事：先弄清是这份文件被谁动过，还是清单钉错了版本。"
done <<< "$(printf '%s' "$EXTRACT_ROWS")"
log "逐件复核过：${n_extract} 件字节与清单一致（模式：$([ "$VERIFY_ONLY" = 1 ] && echo verify-only || echo fetch+extract)）"

# ------------------------------------------------------------------ 3) 三道闸门（都是"当场能读的坏法"）
JAR_COUNT="$(find "$DEST" -type f -name '*.jar' | wc -l | tr -d ' ')"
FILE_COUNT="$(find "$DEST" -type f | wc -l | tr -d ' ')"
[ "$JAR_COUNT" = "$n_extract" ] || die "数量对不上：清单有 ${n_extract} 行 extract，而 ${DEST} 里有 ${JAR_COUNT} 个 jar（总文件 ${FILE_COUNT}）。
  多出来 = 有人手工塞了 jar（类路径上多一个没人知道的版本）；少了 = 上面某行没落盘。两种都不许带着走。"

# GATE 1：fat jar 里**不许**有 org/apache/spark/** 类。
#   为什么单独判它：Toree 的 Spark 依赖在 toree-ivy.xml 里是 provided（3.0.3），所以公开制品不含 Spark；
#   哪一次换版本/换成别的发行形态把它烤进来了，那条类路径上就有**两份 Spark**（一份 3.0.3、一份判题侧的 3.5.5），
#   症状是 NoClassDefFoundError / 方法签名对不上，而不是一个能读的报错 —— 正是本仓库最讨厌的那一类。
#   实测：0.5.0-incubating 这份的 org/apache/spark 类计数为 0。
ASSEMBLY="$(find "$DEST/lib" -maxdepth 1 -type f -name 'toree-assembly-*.jar' | head -1)"
[ -n "$ASSEMBLY" ] || die "${DEST}/lib 里没有 toree-assembly-*.jar ⇒ kernel.json 的 -cp 指着的就是它，起不来的那句话已经成立"
if command -v unzip >/dev/null 2>&1; then
  # 空读数不许冒充通过 —— 与下面 GATE 3 同一条判据，也与本文件头部那条"每样都是当场实测出来的坏法"同一条纪律。
  # 第一版是 `unzip -l … 2>/dev/null | awk … | grep -c … || true`：unzip 在但中途失败（zip64 / 不支持的
  # 压缩方法 / IO 错）时 stderr 被丢弃、stdout 为空、grep -c 打印 0、`|| true` 吃掉非 0 退出 ⇒ 这里会
  # 打印"GATE 1 过"，配套的 scala 计数行读成"0 个"而不是 753 —— 一个空读数同时冒充了两件事。
  # 现在：收 unzip 的**退出码与全部输出**，先断言"总条目数 > 0"（清单确实被读出来了），只有这时
  # SPARK_CLASSES = 0 才是一个可信的读数，闸门才允许说"过"。
  if ! UNZIP_LISTING="$(unzip -l "$ASSEMBLY" 2>&1)"; then
    die "GATE 1 读不了制品清单：unzip -l ${ASSEMBLY} 非 0 退出 ⇒ 'org/apache/spark 类 0 个'这个读数**根本没发生**，不许当成 0。
  unzip 的输出（stdout+stderr 合并）：
${UNZIP_LISTING}
  （zip64 / 不支持的压缩 / IO 坏都长这样。要么换能读这份 zip 的 unzip，要么停下来 —— 不能带着没验过的 jar 继续。）"
  fi
  # 条目行 = unzip -l 里第一列 Length 是纯数字的那些行（表头/分隔线/汇总行没有这个形状）。
  ENTRY_NAMES="$(printf '%s\n' "$UNZIP_LISTING" | awk '$1 ~ /^[0-9]+$/ {print $4}')"
  TOTAL_ENTRIES="$(printf '%s\n' "$ENTRY_NAMES" | grep -c '[^[:space:]]' || true)"
  [ "$TOTAL_ENTRIES" -gt 0 ] || die "GATE 1 空读数：unzip -l 退 0 但一个条目都没列出（总条目 0）⇒ 这不是'没有 Spark 类'，是'什么都没读到'（空 zip、清单格式变了、unzip 版本差异都可能长这样）。闸门停在这里，人来判。"
  SPARK_CLASSES="$(printf '%s\n' "$ENTRY_NAMES" | grep -c '^org/apache/spark/' || true)"
  [ "$SPARK_CLASSES" = "0" ] || die "制品里出现 ${SPARK_CLASSES} 个 org/apache/spark/** 类 ⇒ 这是一份**自带 Spark** 的发行物，和 /opt/spark/jars（判题侧共用的 3.5.5）会在同一条类路径上撞成两份 Spark。这一档不许用这种制品。"
  log "GATE 1 过：清单实读 ${TOTAL_ENTRIES} 个条目，其中 org/apache/spark 类 0 个（Spark 只从 /opt/spark/jars 来，只读）"
  # 顺带把"到底烤了什么进去"打进日志，换版本时这一行就是账（fat jar 里的 scala/** 类靠**类路径顺序**压住，见 GATE 3）。
  # 有上面的总条目断言垫底，这一行读出 0 意味着"内容真的变了"，不再是"没读到"的伪装。
  SCALA_CLASSES="$(printf '%s\n' "$ENTRY_NAMES" | grep -c '^scala/' || true)"
  log "  制品里 scala/** 类 ${SCALA_CLASSES} 个（Scala 2.12.15 编的）⇒ 必须让 /opt/spark/jars 排在前面，见 GATE 3"
else
  log "GATE 1 跳过：这个环境里没有 unzip，无法读制品内部的类名（构建镜像里有；宿主 --verify-only 可能没有）"
fi

# GATE 2：${DEST} 里不许出现**与 /opt/spark/jars 同名不同版**的 jar 文件名。
#   A 档那条同名漂移闸门的等价物（这里只剩"文件名"这一维，因为载荷只有一个 jar）。
STRAY_RE='^(scala-(compiler|library|reflect)|scala-xml_2\.12|scala-collection-compat_2\.12|slf4j-(api|nop)|log4j-|jackson-|spark-[a-z_]+_2\.12|jline)-'
stray="$(find "$DEST" -type f -name '*.jar' -printf '%f\n' | grep -E "$STRAY_RE" || true)"
[ -z "$stray" ] || die "这些 jar 不该出现在 ${DEST}（它们与 /opt/spark/jars 里的同名不同版，谁先上类路径谁赢）：
  ${stray}"
log "GATE 2 过：${DEST} 里没有与 /opt/spark/jars 同名的 jar 文件名"

# GATE 3：类路径顺序。fat jar 里的 scala/** 删不掉 ⇒ 纪律只剩一条能表达的形式：**Spark 在前**。
#   所以它不许只活在注释里。找得到 kernel.json 就当场判（构建期 /app 已经 COPY 进来了吗？没有 ——
#   kernelspec 是 stack 段的 COPY，比这一层晚，所以这里按"能读到就读"处理，读不到时由 Dockerfile 里
#   紧跟着的那条 node 判据兜住 —— 那一条是无条件判的，见 docker/Dockerfile 的 WI-91 路径 B 那一块）。
#   ⚠ 这一条**写过两遍**，第一遍是本仓库最恨的那种坏法，留在这儿给下一个人：
#     第一版是 `grep -o '"-cp", "[^"]*"' | grep -qv '^…'`，而 kernel.json 是**每个 argv 元素各占一行**的
#     美化 JSON ⇒ `"-cp", "…"` 这种**同一行内**的形状压根不存在 ⇒ grep 输出空串 ⇒ `grep -qv` 在空输入上退 1
#     ⇒ if 不成立 ⇒ 闸门打印"GATE 3 过"。它绿是因为它一行都没读到，不是因为顺序对。
#     （破坏性验证就是这么抓出来的：把 -cp 换成 /opt/toree 打头，第一版照样说"过"。）
#     修法不能是"给 grep 加 -A1"（那只是把"两行拼一句"再赌一次格式），要**解析 JSON 取 argv 的下一项**：
#     判的是 argv 的语义，不是文件的排版。node 在镜像里（stack 段装了 Node 24）与宿主上都有 ⇒ 两侧同一条实现。
SPEC_HINT="${REPO_ROOT}/docker/jupyter/kernels/arena-scala-toree/kernel.json"
if [ -f "$SPEC_HINT" ]; then
  # 先把换行压掉再取那一项：kernel.json 是每个 argv 元素各占一行的美化 JSON，
  # `"-cp", "…"` 这种同一行内的形状**不存在** —— 直接 grep 文件会得到空读数，而空读数上一版的
  # `grep -qv` 退 1 ⇒ if 不成立 ⇒ 打印"过"。所以这里两条都要判：**读到了没有** + **读到的对不对**。
  CP_RAW="$(tr -d '\n\r' < "$SPEC_HINT" | grep -o '"-cp", *"[^"]*"' | head -1 || true)"
  [ -n "$CP_RAW" ] || die "GATE 3 读不到 kernel.json 里 -cp 那一项（空读数）⇒ 要么 argv 的写法变了（不再是 \"-cp\", \"<值>\" 相邻两项），要么这个文件不是那份 kernelspec。闸门不许把\"没读到\"当成\"通过\"。"
  CP_VAL="$(printf '%s' "$CP_RAW" | sed -e 's/^.*, *"//' -e 's/"$//')"
  case "$CP_VAL" in
    "/opt/spark/jars/*:"*)
      log "GATE 3 过：kernel.json 的 -cp 值是 ${CP_VAL}（Scala 三件套由 Spark 那份赢）"
      ;;
    *)
      die "GATE 3 不过：kernel.json 的 -cp 读到的是「${CP_VAL}」，不是以 /opt/spark/jars/*: 开头 ⇒ 制品里那份 Scala 2.12.15 会盖掉 Spark 3.5.5 的 2.12.18（编译器与运行期混版，症状是 NoClassDefFoundError 而不是能读的报错）"
      ;;
  esac
else
  log "GATE 3 在本目录读不到 ${SPEC_HINT}（构建期 /app 还没 COPY）⇒ 由 Dockerfile 里那条同形状的判据判同一件事"
fi

log "完成：清单 ${n_extract} 个文件全部在位并校验通过（制品=${TARBALL}）"
log "  DEST=${DEST}"
log "  清单=${MANIFEST}"
log "  源：${DIST_BASES}"
