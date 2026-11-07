#!/usr/bin/env node
// Công cụ dòng lệnh cho máy chủ license (chạy trên máy chủ, đọc cùng thư mục dữ liệu).
//   node license-server/cli.js create-root <email> <mật-khẩu> [họ tên]   (quyền cao nhất)
//   node license-server/cli.js create-admin <email> <mật-khẩu> [họ tên]
//   node license-server/cli.js gen-keys --days 365 --count 10 [--note "Đơn 123"] [--email khach@gmail.com] [--csv keys.csv]
//   node license-server/cli.js list-keys [--status new|active|revoked]
//   node license-server/cli.js revoke <KEY>
//   node license-server/cli.js users
//   node license-server/cli.js extend <email> <số-ngày>
//   node license-server/cli.js public-key
// Máy chủ đang chạy sẽ tự đọc lại store.json khi cli.js ghi (so thời điểm sửa file trước mỗi request).
const fs = require('fs');
const path = require('path');
const { createApp, loadEnvFile } = require('./server');
const { vnDate } = require('./lib/templates');

loadEnvFile(path.join(__dirname, '.env'));
const [cmd, ...rest] = process.argv.slice(2);
const opt = name => { const i = rest.indexOf('--' + name); return i >= 0 ? rest[i + 1] : undefined; };
let svc, keyPair;
try { ({ svc, keyPair } = createApp({ ...process.env, REMINDERS: '0', ADMIN_EMAIL: '', ROOT_EMAIL: '', MAIL_QUIET: '1' })); }
catch (e) { console.error('Lỗi:', e.message); process.exit(1); }

function main() {
  switch (cmd) {
    case 'create-root': {
      const [email, password, ...name] = rest;
      if (!email || !password) throw new Error('Cú pháp: create-root <email> <mật-khẩu> [họ tên]');
      const u = svc.createRoot(email, password, name.join(' ') || 'Root');
      console.log(`Đã tạo/cập nhật tài khoản root: ${u.email}`);
      break;
    }
    case 'create-admin': {
      const [email, password, ...name] = rest;
      if (!email || !password) throw new Error('Cú pháp: create-admin <email> <mật-khẩu> [họ tên]');
      const u = svc.createAdmin(email, password, name.join(' ') || 'Quản trị');
      console.log(`Đã tạo/cập nhật quản trị viên: ${u.email}`);
      break;
    }
    case 'gen-keys': {
      const keys = svc.generateKeys({ days: opt('days') || 365, count: opt('count') || 1, note: opt('note') || '', customer_email: opt('email') || '', plan: opt('plan') || '' }, 'cli');
      for (const k of keys) console.log(`${k.key}\t${k.days} ngày${k.customer_email ? '\t' + k.customer_email : ''}`);
      const csv = opt('csv');
      if (csv) {
        fs.writeFileSync(csv, '﻿key,so_ngay,goi,ghi_chu,email_khach,ngay_tao\n' + keys.map(k => [k.key, k.days, k.plan, k.note, k.customer_email, k.created_at].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');
        console.log(`Đã ghi ${keys.length} key vào ${csv}`);
      }
      break;
    }
    case 'list-keys': {
      const st = opt('status');
      for (const k of svc.d.keys.filter(x => !st || x.status === st)) console.log(`${k.key}\t${k.days}d\t${k.status}\t${k.activated_email || k.customer_email || ''}\t${k.note || ''}`);
      break;
    }
    case 'revoke': { const k = svc.revokeKey(rest[0], 'cli'); console.log(`Đã thu hồi ${k.key}`); break; }
    case 'users': {
      for (const u of svc.d.users) { const p = svc.publicUser(u); console.log(`${p.email}\t${p.role}\t${p.status}\t${p.plan}\t${p.access_until ? vnDate(p.access_until) : '-'}\t${p.name}`); }
      break;
    }
    case 'extend': {
      const u = svc.findUserByEmail(rest[0]); if (!u) throw new Error('Không tìm thấy email');
      const p = svc.adjustUser(u.id, { add_days: rest[1] }, 'cli');
      console.log(`${p.email}: dùng đến ${vnDate(p.access_until)}`);
      break;
    }
    case 'public-key': process.stdout.write(keyPair.publicPem); break;
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
}
try { main(); } catch (e) { console.error('Lỗi:', e.message); process.exit(1); }
