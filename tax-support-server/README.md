# tax-support-server

Máy chủ quản lý (tài khoản & license) cho ứng dụng **Hóa đơn & Tờ khai** (tax-support-career).
Ứng dụng của khách chạy trên máy họ và gọi máy chủ này để:

- đăng ký bằng email + mã xác minh 6 số, đăng nhập (tối đa 3 máy/tài khoản), quên/đổi mật khẩu;
- dùng thử 30 ngày, sau đó kích hoạt license-key;
- nhận giấy phép sử dụng ký Ed25519 (ứng dụng chạy offline tối đa `ENTITLEMENT_HOURS`).

Trang quản trị: `https://<tên-miền>/admin/` — thống kê, tạo/thu hồi license-key, quản lý khách hàng, quản trị viên (root), nhật ký, gửi thư thử.

Yêu cầu: Node.js ≥ 20. Phụ thuộc duy nhất: `express`. Dữ liệu lưu trong `data/` (JSON).

## Cài lên VPS Linux (Ubuntu/Debian)

### Cách 1 — systemd (khuyên dùng)

```bash
sudo apt-get update && sudo apt-get install -y git nginx
git clone https://github.com/<tài-khoản>/tax-support-server.git
cd tax-support-server
sudo bash deploy/install.sh
```

Script sẽ: cài Node 20 nếu thiếu, chép mã vào `/opt/tax-support-server`, tạo user hệ thống `taxsupport`,
tạo `.env` (tự sinh `LICENSE_SECRET`, bật `TRUST_PROXY=1`), cài và bật dịch vụ `tax-support-server`
(chỉ nghe `127.0.0.1:4000`).

Sau đó:

```bash
sudo nano /opt/tax-support-server/.env          # cấu hình gửi thư (SES/SMTP), APP_PUBLIC_URL...
sudo systemctl restart tax-support-server
curl -s http://127.0.0.1:4000/api/v1/health

# tạo tài khoản root
cd /opt/tax-support-server
sudo -u taxsupport node cli.js create-root admin@vn-invsearch.top '<mật-khẩu-mạnh>'
```

Nginx + HTTPS:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/tax-support-server
sudo sed -i 's/license.example.com/license.vn-invsearch.top/' /etc/nginx/sites-available/tax-support-server
sudo ln -s /etc/nginx/sites-available/tax-support-server /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d license.vn-invsearch.top
sudo ufw allow 'Nginx Full'   # nếu dùng ufw; KHÔNG mở cổng 4000 ra ngoài
```

Cập nhật phiên bản mới:

```bash
cd ~/tax-support-server && git pull
sudo cp -r server.js cli.js package.json package-lock.json lib public deploy /opt/tax-support-server/
cd /opt/tax-support-server && sudo npm ci --omit=dev && sudo chown -R taxsupport:taxsupport .
sudo systemctl restart tax-support-server
```

Xem log: `journalctl -u tax-support-server -f`

### Cách 2 — Docker

```bash
cp .env.example .env     # điền LICENSE_SECRET, TRUST_PROXY=1, cấu hình thư
docker compose up -d --build
docker compose exec license-server node cli.js create-root <email> <mật-khẩu>
```

Container chỉ mở `127.0.0.1:4000`; dùng `deploy/nginx.conf` để đưa ra tên miền. Dữ liệu nằm ở `./data`.

## Lệnh quản trị (cli.js)

```bash
node cli.js create-root <email> <mật-khẩu> [họ tên]
node cli.js create-admin <email> <mật-khẩu> [họ tên]
node cli.js gen-keys ...          # tạo license-key
node cli.js list-keys
node cli.js revoke <key>
node cli.js users
node cli.js extend ...            # cộng/trừ ngày
node cli.js public-key            # in khoá công khai cho ứng dụng
```

Chạy bằng user `taxsupport` (systemd) hoặc qua `docker compose exec` để quyền ghi `data/` đúng.

## Kết nối ứng dụng khách

Trong `.env` của ứng dụng: `AUTH_MODE=remote`, `AUTH_SERVER_URL=https://license.vn-invsearch.top`.
Chép kết quả `node cli.js public-key` vào `config/license-public.pem` của bộ cài ứng dụng.

## Chuyển dữ liệu từ máy Windows lên VPS

Nếu đã phát hành key / tạo tài khoản trên máy local, chép cả thư mục `license-server/data/`
(gồm `store.json`, `keys/`, `license-secret.txt`) lên `/opt/tax-support-server/data/` **trước** khi chạy lần đầu,
và để trống `LICENSE_SECRET` trong `.env` (hoặc đặt đúng bằng nội dung `license-secret.txt`).
Nếu không, key cũ sẽ không còn hợp lệ và khoá ký giấy phép thay đổi (phải phát lại `license-public.pem`).

## Bảo mật & sao lưu

- **Không commit** `.env` và `data/` (đã có trong `.gitignore`).
- Không đổi `LICENSE_SECRET` sau khi đã phát hành key; máy chủ sẽ từ chối khởi động nếu bí mật không khớp `store.json`.
- Sao lưu định kỳ `data/`, ví dụ cron: `tar czf /root/backup/tax-support-$(date +%F).tgz -C /opt/tax-support-server data`.

Chi tiết luồng đăng nhập/license: [docs/DANG-NHAP-LICENSE.md](docs/DANG-NHAP-LICENSE.md).
