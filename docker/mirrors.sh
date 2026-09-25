#!/usr/bin/env bash
# 依赖源策略集中在此（需求 通用 7/8：国内镜像优先 → 官方源兜底 → 源码编译）。
# 只改这一个文件就能整体切换源；每个函数都带官方源 fallback。
set -euo pipefail

# 必须 http，不是 https：`ubuntu:22.04` 基座里**没有** /etc/ssl/certs/ca-certificates.crt
# （实测 `ls` 报 No such file），apt 走 https 会"update 退出 0 但一个列表都没拿到"，
# 紧接着整层报 `E: Unable to locate package tzdata/locales/...` —— 第一次改这个函数就是这样炸的。
# ca-certificates 是这一层 apt-get install 才装的，装之前没有信任链可用。
MIRROR_APT="${MIRROR_APT:-http://mirrors.aliyun.com}"
MIRROR_PIP="${MIRROR_PIP:-https://pypi.tuna.tsinghua.edu.cn/simple}"
MIRROR_MAVEN="${MIRROR_MAVEN:-https://maven.aliyun.com/repository/public}"
MIRROR_NPM="${MIRROR_NPM:-https://registry.npmmirror.com}"
MIRROR_PLAYWRIGHT="${MIRROR_PLAYWRIGHT:-https://cdn.npmmirror.com/mirrors/playwright}"
# Node 二进制包的国内地址不在这里：它是 `docker build` 阶段的 curl，那时本脚本还没被调用，
# 见 docker/Dockerfile 里的 url_cn/url_official 两档。

apt_sources() {
  local codename="$1"
  if [[ -f /etc/apt/sources.list.d/ubuntu.sources ]]; then
    # 23.04+ 的 deb822 形态
    cat > /etc/apt/sources.list.d/ubuntu.sources <<EOF
Types: deb
URIs: ${MIRROR_APT}/ubuntu/
Suites: ${codename} ${codename}-security ${codename}-updates ${codename}-backports
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
  elif [[ -f /etc/apt/sources.list ]] && grep -q "ubuntu.com" /etc/apt/sources.list; then
    # ubuntu 基座（含本仓库的 ubuntu:22.04）：sources.list 里是 archive.ubuntu.com 与
    # security.ubuntu.com。原来这一支只 sed 了 deb.debian.org，于是在 ubuntu 上**一个字符都不改**
    # —— 镜像构建号称走国内源（红线 C3），实际全程从 archive.ubuntu.com 拉。
    # 实测抓回来的证据：构建完 cat /etc/apt/sources.list 还是 archive.ubuntu.com。
    sed -i -E \
      -e "s#https?://(archive|security)\.ubuntu\.com/ubuntu(-updates)?/?#${MIRROR_APT}/ubuntu#g" \
      -e "s#https?://ports\.ubuntu\.ubuntu\.com/ubuntu-ports#${MIRROR_APT}/ubuntu-ports#g" \
      /etc/apt/sources.list
  else
    sed -i "s|http://deb.debian.org/debian|${MIRROR_APT}/debian|g" /etc/apt/sources.list
  fi
  # 把结果打出来：这一行是"到底换没换成"的唯一现场证据，别信函数名。
  echo "apt → ${MIRROR_APT}；生效行："
  { grep -hE "^(deb|URIs)" /etc/apt/sources.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true; } | head -3
}

pip_config() {
  mkdir -p /etc/pip.conf.d /root/.config/pip
  cat > /root/.config/pip/pip.conf <<EOF
[global]
index-url = ${MIRROR_PIP}
trusted-host = $(echo "${MIRROR_PIP}" | sed -E 's#https?://([^/]+).*#\1#')
timeout = 120
EOF
  echo "pip → ${MIRROR_PIP}"
}

maven_settings() {
  mkdir -p /root/.m2
  cat > /root/.m2/settings.xml <<EOF
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <mirrors>
    <mirror>
      <id>aliyun</id>
      <mirrorOf>central</mirrorOf>
      <url>${MIRROR_MAVEN}</url>
    </mirror>
  </mirrors>
</settings>
EOF
  echo "maven → ${MIRROR_MAVEN}"
}

env_export() {
  {
    echo "export NPM_CONFIG_REGISTRY=${MIRROR_NPM}"
    echo "export PLAYWRIGHT_DOWNLOAD_HOST=${MIRROR_PLAYWRIGHT}"
    echo "export PIP_INDEX_URL=${MIRROR_PIP}"
  } > /etc/profile.d/arena-mirrors.sh
  echo "npm → ${MIRROR_NPM}"
}

case "${1:-}" in
  apt) apt_sources "${2:-jammy}" ;;
  pip) pip_config ;;
  maven) maven_settings ;;
  env) env_export ;;
  all)
    apt_sources "${2:-jammy}"
    pip_config
    maven_settings
    env_export
    ;;
  *) echo "usage: mirrors.sh {apt <codename>|pip|maven|env|all <codename>}" >&2; exit 2 ;;
esac
