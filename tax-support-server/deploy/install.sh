#!/usr/bin/env bash
# Cài máy chủ quản lý lên VPS Ubuntu/Debian (chạy bằng root hoặc sudo).
#   sudo bash deploy/install.sh
set -euo pipefail
APP_DIR=/opt/tax-support-server
APP_USER=taxsupport
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Node.js 20+
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo ">> Cài Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

if [ "$SRC_DIR" != "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  cp -r "$SRC_DIR"/{server.js,cli.js,package.json,package-lock.json,lib,public,deploy,.env.example} "$APP_DIR"/
fi
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
mkdir -p data
if [ ! -f .env ]; then
  cp .env.example .env
  # sinh LICENSE_SECRET cố định
  sed -i "s|^LICENSE_SECRET=.*|LICENSE_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')|" .env
  sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" .env
  echo ">> Đã tạo $APP_DIR/.env (đã sinh LICENSE_SECRET). Hãy sửa cấu hình gửi thư rồi khởi động lại."
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 600 .env

cp deploy/tax-support-server.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tax-support-server
sleep 1
systemctl --no-pager status tax-support-server | head -n 15
echo ">> Xong. Kiểm tra: curl -s http://127.0.0.1:4000/api/v1/health"
echo ">> Tạo root: sudo -u $APP_USER node $APP_DIR/cli.js create-root <email> <mật-khẩu>"
