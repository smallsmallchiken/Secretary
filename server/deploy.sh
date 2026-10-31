#!/usr/bin/env bash
# 服务器端部署脚本（在 Linux 服务器上跑，root 执行）。
#
# 目标：把 QQ 值守拉起来，跑在 node 容器里，连本机 docker 里的 NapCat。
# 设计原则：
#   - 幂等：重复跑只会更新代码 + 重启容器
#   - 不动密钥：.data/config.json 是本机手工放上去的，脚本只检查存不存在
#   - 宿主机不装 node（CentOS 7 的 glibc 2.17 跑不了 node 18+），一律走容器
#
# 用法：
#   bash server/deploy.sh                # 更新代码 + 重启值守
#   bash server/deploy.sh --no-restart   # 只更新代码和依赖
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/secretary}
DATA_DIR=${DATA_DIR:-$APP_DIR/.data}
REPO=${REPO:-https://github.com/smallsmallchiken/Secretary.git}
NODE_IMAGE=${NODE_IMAGE:-node:20-slim}
CONTAINER=${CONTAINER:-qqbot}
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    *) echo "未知参数 $arg"; exit 2 ;;
  esac
done

say() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- 1. 代码
if [ -d "$APP_DIR/.git" ]; then
  say "更新代码 $APP_DIR"
  cd "$APP_DIR"
  git fetch --depth 1 origin main
  # 复位到 FETCH_HEAD，不要用 origin/main：
  # `fetch --depth 1 origin main` 只写 FETCH_HEAD 这一个引用，浅仓库里
  # 远端跟踪引用 refs/remotes/origin/main 不会跟着更新。用 origin/main
  # 复位的结果是「每次都停在很久以前那个提交」，脚本还一路报告成功，
  # 部署完以为上线了、实际跑的还是旧代码（2026-10-31 踩过一次）。
  git reset --hard FETCH_HEAD
else
  say "克隆到 $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --depth 1 "$REPO" "$APP_DIR"
  cd "$APP_DIR"
fi

# ---------------------------------------------------------------- 2. 数据目录
mkdir -p "$DATA_DIR/media/pics" "$DATA_DIR/media/voice" "$DATA_DIR/media/_cache"
if [ ! -f "$DATA_DIR/config.json" ]; then
  say "⚠ 没有 $DATA_DIR/config.json —— 值守起来也会因为 qq.enabled=false 直接退出"
  say "  把本机 .data/config.json 传上来，或参考 config.example.json 手写一份"
fi

# ---------------------------------------------------------------- 3. 依赖
# 宿主机没有 node，用一次性容器装。--omit=dev 会跳过 electron（服务器不需要 GUI）。
say "安装依赖（容器内 npm install --omit=dev）"
docker run --rm -v "$APP_DIR:/app" -w /app "$NODE_IMAGE" \
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3

# ---------------------------------------------------------------- 4. 容器
if [ "$RESTART" = "1" ]; then
  say "重建值守容器 $CONTAINER"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # --network host：NapCat 的 WS 监听在宿主机 127.0.0.1:3001，容器桥接网访问不到
  #                 （也不该把 3001 暴露到公网）。
  # 挂整个 APP_DIR 而不是只挂 .data：语音/图片发送要用 file:// 绝对路径，
  # NapCat 在宿主机侧读文件也得是同一个路径。
  docker run -d --name "$CONTAINER" \
    --restart unless-stopped \
    --network host \
    -e PET_DATA_DIR="$DATA_DIR" \
    -v "$APP_DIR:$APP_DIR" \
    -w "$APP_DIR" \
    "$NODE_IMAGE" \
    node server/qq-bot.js

  say "等 5 秒看日志"
  sleep 5
  docker logs --tail 25 "$CONTAINER" 2>&1 || true
else
  say "--no-restart：跳过容器重建"
fi

say "完成。常用命令："
say "  docker logs -f --tail 100 $CONTAINER"
say "  docker restart $CONTAINER"
say "  docker exec -it $CONTAINER node server/qq-bot.js --check"
