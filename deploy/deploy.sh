#!/usr/bin/env bash
# kids-trip 后端一键部署脚本（实测可用版本）
#
# 用法（默认已指向 ubuntu@your-server.example.com）：
#   bash deploy/deploy.sh
#   SERVER=ubuntu@1.2.3.4 bash deploy/deploy.sh
#
# 本服务器环境事实（与脚本一致）：
#   - pm2 守护进程以 ubuntu 运行（既有 mcp/poker/szw 等同例）；故本应用也以 ubuntu 运行，不做 kts 降权
#     （非 root 无法 setuid，ecosystem 里没有 uid/gid）。
#   - your-api.example.com 的证书已存在（/etc/nginx/ssl/your-api.example.com_*.pem，Let's Encrypt 签发，
#     有效期约 90 天），nginx 站点 /etc/nginx/sites-available/your-api.example.com 已存在。
#   - 云安全组未放通入站 80，故 certbot HTTP-01 暂不可用；证书续期需临时放通 80 或改用 DNS-01。
#   - 部署即：覆盖现有 nginx 站点为反代 127.0.0.1:8099（复用现有证书），pm2 启动 Node 应用。
#
# 前置（一次性）：Node >= 20、nginx（include conf.d + sites-enabled）、certbot（仅续期用）、openssl、rsync；
#               部署用户需 passwordless sudo。
set -euo pipefail

SERVER="${SERVER:-ubuntu@your-server.example.com}"
REMOTE_DIR="/opt/kids-trip-server"
DATA_DIR="/var/lib/kids-trip"
LOG_DIR="/var/log/kids-trip"
NGINX_SITE="/etc/nginx/sites-available/your-api.example.com"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> [1/4] 建目录(给 ubuntu 写权限) + rsync 代码"
ssh "$SERVER" "set -e
  sudo mkdir -p '$REMOTE_DIR' '$DATA_DIR' '$LOG_DIR' /var/www/certbot
  sudo chown ubuntu:ubuntu '$REMOTE_DIR'"
# 注意：data/ 不再整体排除。data/db.json 及各类备份/测试库是开发产物（生产 UGC 在
# /var/lib/kids-trip/db.json，由 DATA_FILE 指定，绝不被此处覆盖），只排除它们，
# 让 data/spot_i18n.json（译文数据，与业务数据物理分离）随代码一起部署。
rsync -az --delete \
  --exclude 'data/db.json' --exclude 'data/db.json.bak*' \
  --exclude 'data/_test_db.json*' --exclude 'data/_verify_db.json*' --exclude 'data/*.bak*' \
  --exclude '*.test.*' --exclude test_flow.mjs \
  --exclude node_modules --exclude '*.log' --exclude .git \
  "$PROJECT_DIR/" "$SERVER:$REMOTE_DIR/"

echo "==> [1.5/4] 同步 i18n 工具链 + 译文源到服务器（phase2-i18n -> i18n-tools，排除 *.bak）"
# 让生成/校验脚本（enhance.py / gen-backend-i18n.js / retranslate_stale.py 等）与依赖数据、
# 权威译文源 trilingual.json 随部署上线，便于在服务器侧复现译文，且不依赖易失的 /tmp。
rsync -az --exclude '*.bak' --exclude '__pycache__' --exclude '*.pyc' \
  "$PROJECT_DIR/../kids-trip/phase2-i18n/" "$SERVER:$REMOTE_DIR/i18n-tools/"

echo "==> [1.6/4] 用最新 trilingual.json 重新生成 data/spot_i18n.json（键=城市+名称，不碰 db.json / UGC）"
ssh "$SERVER" "set -e
  cd '$REMOTE_DIR'
  /usr/bin/node i18n-tools/gen-backend-i18n.js
  echo 'spot_i18n.json 已据 trilingual.json 重新生成（稳定键，不依赖 spot.id）'"

echo "==> [1.7/4] 校验译文完整性（以 trilingual.json 为基准查缺译/空串），失败则中止部署"
ssh "$SERVER" "set -e
  cd '$REMOTE_DIR'
  DATA_FILE='$DATA_DIR/db.json' I18N_FILE='$REMOTE_DIR/data/spot_i18n.json' \
    TRI_FILE='$REMOTE_DIR/i18n-tools/trilingual.json' \
    /usr/bin/node i18n-tools/check-i18n.mjs"

echo "==> [2/4] 修正权限 + pm2 启动（ubuntu，production）"
ssh "$SERVER" "set -e
  sudo chown -R ubuntu:ubuntu '$REMOTE_DIR' '$DATA_DIR' '$LOG_DIR'
  sudo chmod 750 '$DATA_DIR'
  cd '$REMOTE_DIR'
  export KTS_TOKEN_SECRET=\"\$(openssl rand -hex 32)\"
  pm2 start ecosystem.config.cjs --env production --update-env
  pm2 save
  echo 'pm2 启动完成'"

echo "==> [3/4] 覆盖 nginx 站点为反代(复用现有证书) + 清理引导配置 + 重载"
ssh "$SERVER" "set -e
  sudo cp '$REMOTE_DIR/deploy/nginx.your-api.example.com.site.conf' '$NGINX_SITE'
  sudo rm -f /etc/nginx/conf.d/your-api.example.com.bootstrap.conf
  sudo nginx -t && sudo systemctl reload nginx
  echo 'nginx 已切到反代配置'"

echo "==> [4/4] 验证"
ssh "$SERVER" "curl -fsS http://127.0.0.1:8099/healthz && echo '  [local node ok]'"
echo "完成。浏览器/小程序访问 https://your-api.example.com/healthz 应返回 {\"ok\":true,...}"
echo "微信小程序 request 合法域名需加入：https://your-api.example.com"
