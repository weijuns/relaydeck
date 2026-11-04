#!/usr/bin/env bash
# 把 RelayDeck 的源码部署到服务器并重启服务。
#
# 依赖：本机到目标机已配置 SSH 密钥登录（不要再把密码写进脚本）。
#
# 用法：
#   RELAYDECK_ADMIN_TOKEN=xxx ./scripts/deploy.sh
#   DEPLOY_HOST=root@1.2.3.4 DEPLOY_DIR=/opt/relaydeck ./scripts/deploy.sh
#
# 只同步 standalone 的源码与静态资源；数据目录、node_modules、systemd 单元不动。
set -euo pipefail

HOST="${DEPLOY_HOST:-}"
DIR="${DEPLOY_DIR:-/opt/relaydeck}"
ADMIN_TOKEN="${RELAYDECK_ADMIN_TOKEN:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "缺少 RELAYDECK_ADMIN_TOKEN（管理端令牌），拒绝部署。" >&2
  exit 1
fi
if [[ -z "$HOST" ]]; then
  echo "缺少 DEPLOY_HOST（例如 root@your-server），拒绝部署。" >&2
  exit 1
fi

echo "== 本地校验 =="
(cd "$ROOT" && npm run lint --silent && npm test --silent)

TMP="$(mktemp -t relaydeck-deploy-XXXXXX).tar.gz"
trap 'rm -f "$TMP"' EXIT

echo "== 打包 =="
tar czf "$TMP" -C "$ROOT" src public package.json scripts
ls -lh "$TMP"

echo "== 上传到 $HOST =="
scp -q "$TMP" "$HOST:/tmp/relaydeck-src.tar.gz"

echo "== 解压并重启 =="
ssh "$HOST" bash -s <<EOF
set -e
tar xzf /tmp/relaydeck-src.tar.gz -C '$DIR/standalone'
systemctl restart relaydeck
sleep 4
systemctl is-active relaydeck
curl -fsS -H 'x-admin-token: $ADMIN_TOKEN' http://127.0.0.1:8327/api/health
echo
EOF

echo "== 完成 =="
