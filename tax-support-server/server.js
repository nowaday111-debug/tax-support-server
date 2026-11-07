// Máy chủ tài khoản & license cho "Hóa đơn & Tờ khai".
// Khách cài ứng dụng trên máy của họ; ứng dụng gọi máy chủ này để đăng ký, xác minh email,
// đăng nhập, kiểm tra hạn dùng thử 30 ngày và kích hoạt license-key.
// Chạy: node license-server/server.js   (cấu hình: license-server/.env, xem .env.example)
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Store } = require('./lib/store');
const { LicenseService, HttpError } = require('./lib/service');
const { loadOrCreateKeyPair } = require('./lib/entitlement');
const { createMailer, mailConfigFromEnv } = require('./lib/mailer');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue; // biến môi trường thật thắng .env
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// Giới hạn tần suất đơn giản trong bộ nhớ (theo IP + nhóm route)
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = `${req.ip}|${req.baseUrl}${req.path}`;
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(k, h); }
    if (++h.n > max) return res.status(429).json({ error: 'Thao tác quá nhiều lần, vui lòng thử lại sau ít phút', code: 'RATE_LIMITED' });
    next();
  };
}

function createApp(env = process.env, { dataDir } = {}) {
  dataDir = dataDir || env.LICENSE_DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  let secret = env.LICENSE_SECRET;
  if (!secret) {
    // tự sinh và lưu lại để key đã phát hành vẫn hợp lệ sau khi khởi động lại
    const f = path.join(dataDir, 'license-secret.txt');
    if (!fs.existsSync(f)) fs.writeFileSync(f, require('crypto').randomBytes(32).toString('base64url'), { mode: 0o600 });
    secret = fs.readFileSync(f, 'utf8').trim();
  }
  const store = new Store(path.join(dataDir, 'store.json'));
  // Ghi dấu vân tay của LICENSE_SECRET: chạy máy chủ/cli với bí mật khác sẽ báo lỗi ngay,
  // tránh phát hành key mà máy chủ không nhận (hoặc làm mất hiệu lực key đã bán).
  const fp = require('crypto').createHash('sha256').update('hdtk-secret|' + secret).digest('hex').slice(0, 16);
  if (!store.data.secret_fingerprint) { store.data.secret_fingerprint = fp; store.save(); }
  else if (store.data.secret_fingerprint !== fp) throw new Error('LICENSE_SECRET không khớp với bí mật đã dùng để phát hành key trong store.json. Kiểm tra license-server/.env (máy chủ và cli.js phải dùng cùng một LICENSE_SECRET).');
  const keyPair = loadOrCreateKeyPair(path.join(dataDir, 'keys'));
  const mailer = createMailer(mailConfigFromEnv(env, dataDir));
  const svc = new LicenseService({
    store, mailer, secret, keyPair,
    trialDays: Number(env.TRIAL_DAYS || 30),
    otpMinutes: Number(env.OTP_MINUTES || 15),
    sessionDays: Number(env.SESSION_DAYS || 30),
    entitlementHours: Number(env.ENTITLEMENT_HOURS || 168),
    maxDevices: Number(env.LICENSE_MAX_DEVICES || 3),
    productName: env.PRODUCT_NAME || 'Hóa đơn & Tờ khai',
    appUrl: env.APP_PUBLIC_URL || '',
  });
  const exposeOtp = env.LICENSE_EXPOSE_OTP === '1'; // CHỈ dùng khi kiểm thử — trả mã OTP trong phản hồi
  const strip = o => { if (o && !exposeOtp) delete o._code; return o; };

  if (env.ROOT_EMAIL && env.ROOT_PASSWORD && !svc.findUserByEmail(env.ROOT_EMAIL)) {
    svc.createRoot(env.ROOT_EMAIL, env.ROOT_PASSWORD);
    console.log(`[license] Đã tạo tài khoản root ${env.ROOT_EMAIL}`);
  }
  if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD && !svc.findUserByEmail(env.ADMIN_EMAIL)) {
    svc.createAdmin(env.ADMIN_EMAIL, env.ADMIN_PASSWORD);
    console.log(`[license] Đã tạo tài khoản quản trị ${env.ADMIN_EMAIL}`);
  }

  const app = express();
  if (env.TRUST_PROXY === '1') app.set('trust proxy', true);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); next(); });
  app.use('/admin', express.static(path.join(__dirname, 'public')));
  app.get('/', (req, res) => res.redirect('/admin/'));

  const strict = rateLimit({ windowMs: 10 * 60000, max: Number(env.RATE_LIMIT_AUTH || 20) });
  const bearer = req => (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || null;
  const wrap = fn => async (req, res) => {
    try { res.json(await fn(req, res)); }
    catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error('[license] lỗi:', e);
      res.status(500).json({ error: 'Lỗi máy chủ', code: 'SERVER_ERROR' });
    }
  };
  const device = req => ({ device_id: req.body.device_id, device_name: req.body.device_name, ip: req.ip });

  const r = express.Router();
  r.use((req, res, next) => { store.refreshIfChanged(); next(); });
  r.get('/health', (req, res) => res.json({ ok: true, service: 'hdtk-license', trial_days: svc.trialDays, mail: mailer.describe().transport }));
  r.get('/public-key', (req, res) => res.type('text/plain').send(keyPair.publicPem));

  r.post('/auth/register', strict, wrap(async req => strip(await svc.register(req.body || {}))));
  r.post('/auth/resend', strict, wrap(async req => strip(await svc.resendVerify(req.body.email))));
  r.post('/auth/verify', strict, wrap(async req => svc.verifyEmail({ email: req.body.email, code: req.body.code, ...device(req) })));
  r.post('/auth/login', strict, wrap(async req => svc.login({ email: req.body.email, password: req.body.password, ...device(req) })));
  r.post('/auth/forgot', strict, wrap(async req => strip(await svc.forgot(req.body.email))));
  r.post('/auth/reset', strict, wrap(async req => svc.resetPassword(req.body || {})));
  r.post('/auth/logout', wrap(async req => { svc.logout(bearer(req)); return { ok: true }; }));
  r.post('/auth/change-password', strict, wrap(async req => svc.changePassword(bearer(req), req.body || {})));
  r.get('/me', wrap(async req => svc.me(bearer(req))));
  r.post('/license/activate', strict, wrap(async req => svc.activateKey(bearer(req), req.body.key)));

  // ----- quản trị -----
  r.get('/admin/stats', wrap(async req => { svc.requireAdmin(bearer(req)); return { ...svc.stats(), mail: mailer.describe() }; }));
  r.get('/admin/users', wrap(async req => {
    svc.requireAdmin(bearer(req));
    const q = String(req.query.q || '').toLowerCase();
    return svc.d.users.filter(u => !q || u.email.includes(q) || (u.name || '').toLowerCase().includes(q) || (u.company || '').toLowerCase().includes(q))
      .map(u => ({ ...svc.publicUser(u), last_login_at: u.last_login_at || null, devices: svc.d.sessions.filter(s => s.user_id === u.id).length }))
      .sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
  }));
  r.post('/admin/users/:id', wrap(async req => { const a = svc.requireAdmin(bearer(req)); return svc.adjustUser(req.params.id, req.body || {}, a.email, a.role); }));
  // ----- chỉ root -----
  r.post('/root/admins', wrap(async req => { const a = svc.requireRoot(bearer(req)); return svc.addAdmin(req.body || {}, a.email); }));
  r.post('/root/users/:id', wrap(async req => { const a = svc.requireRoot(bearer(req)); return svc.rootManageUser(req.params.id, req.body || {}, a.email); }));
  r.get('/admin/keys', wrap(async req => {
    svc.requireAdmin(bearer(req));
    const st = req.query.status;
    return svc.d.keys.filter(k => !st || k.status === st).slice().reverse();
  }));
  r.post('/admin/keys', wrap(async req => { const a = svc.requireAdmin(bearer(req)); return { keys: svc.generateKeys(req.body || {}, a.email) }; }));
  r.post('/admin/keys/:key/revoke', wrap(async req => { const a = svc.requireAdmin(bearer(req)); return svc.revokeKey(req.params.key, a.email); }));
  r.get('/admin/audit', wrap(async req => { svc.requireAdmin(bearer(req)); return svc.d.audit.slice(-300).reverse(); }));
  r.post('/admin/test-mail', wrap(async req => {
    const a = svc.requireAdmin(bearer(req));
    const to = req.body.to || a.email;
    try { const info = await mailer.send({ to, subject: 'Thư kiểm tra cấu hình gửi thư', text: `Máy chủ license gửi được thư qua kênh ${mailer.describe().transport}.` }); return { ok: true, info }; }
    catch (e) { throw new HttpError(502, 'MAIL_FAILED', e.message); }
  }));

  app.use('/api/v1', r);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này', code: 'NOT_FOUND' }));

  // nhắc hạn mỗi giờ (7 ngày và 1 ngày trước khi hết)
  if (env.REMINDERS !== '0') {
    const t = setInterval(() => { store.refreshIfChanged(); return svc.sendExpiryReminders().catch(e => console.error('[license] nhắc hạn lỗi:', e.message)); }, 3600000);
    t.unref();
  }
  return { app, svc, store, keyPair, mailer };
}

if (require.main === module) {
  loadEnvFile(path.join(__dirname, '.env'));
  const { app, keyPair, mailer, svc } = createApp(process.env);
  const port = Number(process.env.LICENSE_PORT || 4000);
  const host = process.env.LICENSE_HOST || '0.0.0.0';
  app.listen(port, host, () => {
    console.log(`[license] Máy chủ license chạy tại http://${host}:${port}  (trang quản trị: /admin/, gửi thư: ${mailer.describe().transport})`);
    if (!svc.d.users.some(u => u.role === 'root')) console.log('[license] Chưa có tài khoản root: chạy  node license-server/cli.js create-root <email> <mật-khẩu>');
    console.log('[license] Khoá công khai (chép vào config/license-public.pem của ứng dụng):\n' + keyPair.publicPem);
  });
}

module.exports = { createApp, loadEnvFile };
