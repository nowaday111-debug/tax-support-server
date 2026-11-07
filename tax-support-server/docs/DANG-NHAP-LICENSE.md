# Đăng nhập, dùng thử 30 ngày và license-key (bản 0.6.0)

Khách tự đăng ký bằng **email cá nhân**, xác minh bằng **mã 6 số** gửi về hộp thư, rồi đăng nhập.
Tài khoản mới được **dùng thử 30 ngày**. Hết hạn thì phải nhập **license-key** do máy chủ phát hành.

## 1. Kiến trúc

```
Máy khách (mỗi khách chạy bản riêng)            Máy chủ license (một chỗ, bạn quản lý)
┌──────────────────────────────┐   HTTPS   ┌────────────────────────────────────────┐
│ server.js  + public/login.html│ ───────▶ │ license-server/server.js               │
│ src/auth: chặn /api/*, cookie │           │  tài khoản, mã OTP, dùng thử, key, thư │
│ data/auth/sessions.json       │ ◀─────── │  ký "giấy phép" Ed25519 (entitlement)  │
└──────────────────────────────┘           │  trang quản trị /admin/, cli.js         │
                                           └────────────────────────────────────────┘
```

* Dữ liệu hóa đơn, tờ khai **vẫn nằm trên máy khách** (`data/db.json`). Máy chủ chỉ giữ tài khoản và license.
* Ứng dụng không lưu mật khẩu; chỉ lưu token phiên của máy chủ và giấy phép đã ký.
* Giấy phép có hạn kiểm tra lại (`ENTITLEMENT_HOURS`, mặc định 168 giờ = 7 ngày): mất mạng vẫn dùng được
  tới hạn đó; có mạng thì ứng dụng tự làm mới mỗi 12 giờ.
* Sửa tay giấy phép trong `data/auth/sessions.json` làm sai chữ ký → bị chặn. Chỉnh lùi đồng hồ máy
  (quá 1 giờ) → bắt buộc hỏi lại máy chủ.

## 2. Chạy thử trên một máy

```bat
:: Cửa sổ 1 — máy chủ license (cổng 4000)
run-local.cmd license
:: lần đầu tạo quản trị viên:
node license-server\cli.js create-admin admin@vn-invsearch.top MatKhau123

:: Cửa sổ 2 — ứng dụng (cổng 3000), .env đã có AUTH_SERVER_URL=http://localhost:4000
run-local.cmd mock
```

Mở http://localhost:3000 → tự chuyển tới màn hình đăng nhập. Khi `MAIL_TRANSPORT=outbox` (mặc định),
thư **không gửi ra ngoài**: mã xác minh in ở cửa sổ máy chủ license và lưu trong `license-server\data\outbox\*.eml`.

## 3. Luồng của khách

| Bước | Màn hình | Máy chủ làm gì |
|---|---|---|
| Đăng ký | Họ tên, email, SĐT, công ty, mật khẩu (≥ 8 ký tự, có chữ và số) | Tạo tài khoản *chờ xác minh*, gửi mã 6 số (hiệu lực 15 phút, sai 5 lần phải gửi lại, gửi lại cách nhau 60 giây) |
| Xác minh | Nhập mã | Kích hoạt, **bắt đầu 30 ngày dùng thử**, gửi thư chào mừng, đăng nhập luôn |
| Đăng nhập | Email + mật khẩu | Chưa xác minh → gửi lại mã, chuyển sang bước xác minh |
| Dùng app | Góc phải thanh trên: *Dùng thử: còn N ngày* / *License đến dd/mm/yyyy*; menu Nhập license-key, Đổi mật khẩu, Đăng xuất | Nhắc qua email khi còn 7 ngày và 1 ngày |
| Hết hạn | Mọi API trả 402, ứng dụng chuyển sang màn *Cần license-key* | — |
| Nhập key | `HDTK-XXXXX-XXXXX-XXXXX-XXXXX` (không phân biệt hoa thường, gõ `O`/`I`/`L` tự sửa thành `0`/`1`) | Cộng số ngày của key **nối tiếp** hạn hiện tại (không mất ngày dùng thử còn lại), gửi thư xác nhận |
| Quên mật khẩu | Email → mã 6 số → mật khẩu mới | Đổi mật khẩu, đăng xuất mọi máy |

Chống lạm dụng dùng thử: mỗi hộp thư chỉ được dùng thử **một lần**. Với Gmail, `nguyen.van.a+abc@gmail.com`
và `nguyenvana@gmail.com` được coi là một hộp thư. Một tài khoản đăng nhập tối đa `LICENSE_MAX_DEVICES` máy
(mặc định 3); đăng nhập máy thứ 4 thì phiên cũ nhất bị đóng.

## 4. Tạo và quản lý license-key

**Trang quản trị**: `http://<máy-chủ>:4000/admin/` (đăng nhập bằng tài khoản quản trị)

* Tạo key: chọn thời hạn (1/3/6 tháng, 1/2 năm hoặc tự nhập số ngày), số lượng (tối đa 500), ghi chú,
  tuỳ chọn *chỉ dùng cho email* (key chỉ kích hoạt được bởi đúng email đó). Sao chép hoặc tải CSV.
* Danh sách key: lọc *Chưa dùng / Đã kích hoạt / Đã thu hồi*, tìm theo key/email/ghi chú, **Thu hồi**
  (key đã kích hoạt thì trừ lại số ngày đã cộng cho khách).
* Khách hàng: gói, hạn dùng, số máy đang đăng nhập; **+ ngày** (cộng/trừ ngày thủ công), **Khoá / Mở khoá**.
* Gửi thư kiểm tra, xem nhật ký thao tác.

**Dòng lệnh** (trên máy chủ):

```bat
node license-server\cli.js gen-keys --days 365 --count 10 --note "Đơn 0005" --csv keys.csv
node license-server\cli.js gen-keys --days 30 --email khach@gmail.com
node license-server\cli.js list-keys --status new
node license-server\cli.js revoke HDTK-XXXXX-XXXXX-XXXXX-XXXXX
node license-server\cli.js users
node license-server\cli.js extend khach@gmail.com 30
node license-server\cli.js public-key
```

Cấu tạo key: 8 byte ngẫu nhiên + 4 byte HMAC-SHA256 theo `LICENSE_SECRET`, mã hoá Crockford base32.
Gõ sai một ký tự bị phát hiện ngay; không có `LICENSE_SECRET` thì không tự tạo được key hợp lệ; key còn phải
có trong kho của máy chủ và chưa được dùng.

> **Giữ bí mật và không đổi `LICENSE_SECRET`** sau khi đã bán key. Máy chủ ghi dấu vân tay của bí mật vào
> `store.json`; chạy máy chủ hoặc `cli.js` với bí mật khác sẽ báo lỗi ngay thay vì phát hành key hỏng.

## 5. Gửi thư thật

Trong `license-server\.env`:

| Kênh | Cấu hình |
|---|---|
| Amazon SES API (khuyên dùng, theo `EMAIL-SES.md`) | `MAIL_TRANSPORT=ses_api`, `AWS_REGION=ap-southeast-1`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (IAM user chỉ có `ses:SendEmail`), `MAIL_FROM=hotro@vn-invsearch.top` |
| SMTP (Gmail App Password hoặc SMTP của SES) | `MAIL_TRANSPORT=smtp`, `SMTP_HOST`, `SMTP_PORT=587`, `SMTP_SECURE=starttls`, `SMTP_USER`, `SMTP_PASS` |
| Thử nghiệm | `MAIL_TRANSPORT=outbox` — không gửi, ghi file `.eml` |

SES còn ở **sandbox** thì chỉ gửi được tới địa chỉ đã xác minh — khách thật sẽ **không nhận được mã**.
Cần *Request production access* và DKIM `SUCCESS` trước khi mở đăng ký công khai. Kiểm tra bằng nút
*Gửi thư kiểm tra* trên trang quản trị.

## 6. Triển khai máy chủ license thật

1. Chép thư mục `license-server/` lên máy chủ (VPS hoặc Docker: `docker compose up -d license-server`).
2. Tạo `license-server/.env` từ `.env.example`: đặt `LICENSE_SECRET` (chuỗi ngẫu nhiên ≥ 32 ký tự),
   cấu hình gửi thư, `APP_PUBLIC_URL`.
3. Đặt sau HTTPS, ví dụ Cloudflare → `https://license.vn-invsearch.top` → cổng 4000, và `TRUST_PROXY=1`.
4. Tạo quản trị viên: `node cli.js create-admin <email> <mật-khẩu>`.
5. Lấy khoá công khai: `node cli.js public-key > license-public.pem`, đưa vào bộ cài cho khách tại
   `config/license-public.pem` (nếu không có, ứng dụng tự lấy từ máy chủ ở lần chạy đầu và ghim lại).
6. Trong bộ cài của khách: `.env` đặt `AUTH_SERVER_URL=https://license.vn-invsearch.top`.
7. Sao lưu định kỳ `license-server/data/` (`store.json`, `keys/`, `license-secret.txt` nếu dùng).

## 7. API

Máy chủ license (`/api/v1`):

| Phương thức | Đường dẫn | Ghi chú |
|---|---|---|
| POST | `/auth/register` | `{email, password, name, phone?, company?}` |
| POST | `/auth/resend` | gửi lại mã xác minh |
| POST | `/auth/verify` | `{email, code, device_id?}` → `{token, account, entitlement}` |
| POST | `/auth/login` | `{email, password, device_id?}` → như trên; 403 `EMAIL_NOT_VERIFIED` |
| POST | `/auth/forgot`, `/auth/reset` | quên mật khẩu |
| POST | `/auth/change-password`, `/auth/logout` | Bearer token |
| GET | `/me` | Bearer → tài khoản + giấy phép mới |
| POST | `/license/activate` | Bearer, `{key}` |
| GET | `/public-key` | khoá công khai Ed25519 (PEM) |
| GET/POST | `/admin/stats`, `/admin/users`, `/admin/users/:id`, `/admin/keys`, `/admin/keys/:key/revoke`, `/admin/audit`, `/admin/test-mail` | chỉ quản trị viên |

Ứng dụng (`/api/auth/*`, luôn mở): `status`, `register`, `resend`, `verify`, `login`, `logout`, `forgot`,
`reset`, `change-password`, `activate`, `refresh`. Mọi `/api/*` khác: chưa đăng nhập → **401**,
hết hạn → **402** `LICENSE_REQUIRED`. `/api/health` luôn mở. `AUTH_MODE=off` tắt toàn bộ (chỉ để phát triển).

## 8. Giới hạn cần biết

* Khách chạy mã nguồn trên máy của họ nên người rành kỹ thuật **có thể sửa code** để bỏ kiểm tra license.
  Chữ ký Ed25519 chặn việc sửa giấy phép, không chặn được việc sửa chương trình. Muốn chặt hơn cần đóng gói
  (ví dụ build thành file chạy, làm rối mã) hoặc chuyển sang mô hình máy chủ chung.
* Kho dữ liệu là file JSON — phù hợp vài nghìn tài khoản. Nhiều hơn nên chuyển sang SQLite/PostgreSQL.
* Giới hạn tần suất (20 lần/10 phút/IP cho mỗi API đăng nhập, đăng ký…) giữ trong bộ nhớ, mất khi khởi động lại.
