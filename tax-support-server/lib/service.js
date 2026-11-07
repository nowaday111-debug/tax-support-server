// Nghiệp vụ tài khoản + dùng thử + license (không phụ thuộc HTTP, để kiểm thử trực tiếp).
const C = require('./crypto-utils');
const keys = require('./license-keys');
const ent = require('./entitlement');
const T = require('./templates');

const DAY = 86400000;

const STAFF = ['admin', 'root']; // quản trị viên và root (quyền cao nhất)
const isStaff = u => !!u && STAFF.includes(u.role);

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

class LicenseService {
  /**
   * @param {object} o
   * @param {import('./store').Store} o.store
   * @param {{send: Function}} o.mailer
   * @param {string} o.secret          LICENSE_SECRET — khoá HMAC của license-key
   * @param {object} o.keyPair         { privateKey, publicPem }
   */
  constructor({ store, mailer, secret, keyPair, trialDays = 30, otpMinutes = 15, sessionDays = 30, entitlementHours = 168, maxDevices = 3, productName = 'Hóa đơn & Tờ khai', appUrl = '', issuer = 'hdtk-license', now = () => Date.now() }) {
    if (!secret || String(secret).length < 16) throw new Error('LICENSE_SECRET phải có ít nhất 16 ký tự');
    Object.assign(this, { store, mailer, secret, keyPair, trialDays, otpMinutes, sessionDays, entitlementHours, maxDevices, productName, appUrl, issuer, now });
  }
  get d() { return this.store.data; }

  // ---------- tiện ích ----------
  findUserByEmail(email) { const k = C.emailKey(email); return this.d.users.find(u => u.email_key === k); }
  accessOf(u) {
    const now = this.now();
    if (isStaff(u)) return { plan: 'admin', access_until: new Date(now + 3650 * DAY).toISOString(), active: true, days_left: 3650 };
    const trial = u.trial_ends_at ? Date.parse(u.trial_ends_at) : 0;
    const lic = u.license_expires_at ? Date.parse(u.license_expires_at) : 0;
    const until = Math.max(trial, lic);
    const plan = lic > now ? 'licensed' : trial > now ? 'trial' : (lic ? 'license_expired' : 'trial_expired');
    return { plan, access_until: until ? new Date(until).toISOString() : null, active: until > now && u.status === 'active', days_left: Math.max(0, Math.ceil((until - now) / DAY)) };
  }
  publicUser(u) {
    const a = this.accessOf(u);
    return { id: u.id, email: u.email, name: u.name, phone: u.phone || '', company: u.company || '', role: u.role, status: u.status,
      created_at: u.created_at, trial_ends_at: u.trial_ends_at || null, license_expires_at: u.license_expires_at || null,
      plan: a.plan, access_until: a.access_until, active: a.active, days_left: a.days_left,
      licenses: (u.licenses || []).map(l => ({ key: maskKey(l.key), days: l.days, activated_at: l.activated_at })) };
  }
  issueEntitlement(u, deviceId) {
    const a = this.accessOf(u);
    const iat = this.now();
    return ent.sign(this.keyPair.privateKey, {
      v: 1, iss: this.issuer, sub: u.id, email: u.email, name: u.name, role: u.role,
      plan: a.plan, trial_ends_at: u.trial_ends_at || null, license_expires_at: u.license_expires_at || null,
      access_until: a.access_until, device_id: deviceId || null,
      iat: new Date(iat).toISOString(), exp: new Date(iat + this.entitlementHours * 3600000).toISOString(),
    });
  }
  async mail(to, m) {
    try { await this.mailer.send({ to, ...m }); return true; }
    catch (e) { this.store.audit('MAIL_FAILED', to, e.message); console.error('[mail] lỗi:', e.message); return false; }
  }

  // ---------- OTP ----------
  async sendOtp(u, purpose) {
    const now = this.now();
    const prev = this.d.otps.find(o => o.email_key === u.email_key && o.purpose === purpose);
    if (prev && now - Date.parse(prev.sent_at) < 60000) throw new HttpError(429, 'OTP_COOLDOWN', 'Vui lòng chờ 60 giây trước khi gửi lại mã');
    const code = C.otpCode();
    this.d.otps = this.d.otps.filter(o => !(o.email_key === u.email_key && o.purpose === purpose) && Date.parse(o.expires_at) > now);
    this.d.otps.push({ email_key: u.email_key, purpose, code_hash: C.sha256(`${u.email_key}|${purpose}|${code}`), sent_at: new Date(now).toISOString(), expires_at: new Date(now + this.otpMinutes * 60000).toISOString(), attempts: 0 });
    this.store.save();
    const sent = await this.mail(u.email, T.otpMail({ product: this.productName, name: u.name, code, purpose, minutes: this.otpMinutes }));
    return { sent, _code: code };
  }
  checkOtp(u, purpose, code) {
    const now = this.now();
    const o = this.d.otps.find(x => x.email_key === u.email_key && x.purpose === purpose);
    if (!o || Date.parse(o.expires_at) < now) throw new HttpError(400, 'OTP_EXPIRED', 'Mã đã hết hạn hoặc chưa được gửi, vui lòng gửi lại mã');
    if (o.attempts >= 5) throw new HttpError(429, 'OTP_LOCKED', 'Nhập sai quá 5 lần, vui lòng gửi lại mã mới');
    if (C.sha256(`${u.email_key}|${purpose}|${String(code || '').trim()}`) !== o.code_hash) {
      o.attempts++; this.store.save();
      throw new HttpError(400, 'OTP_INVALID', `Mã không đúng (còn ${5 - o.attempts} lần thử)`);
    }
    this.d.otps = this.d.otps.filter(x => x !== o);
  }

  // ---------- Đăng ký / xác minh ----------
  async register({ email, password, name, phone, company }) {
    if (!C.isValidEmail(email)) throw new HttpError(400, 'EMAIL_INVALID', 'Email không hợp lệ');
    const pwErr = C.passwordProblem(password); if (pwErr) throw new HttpError(400, 'PASSWORD_WEAK', pwErr);
    name = String(name || '').trim().slice(0, 100);
    if (!name) throw new HttpError(400, 'NAME_REQUIRED', 'Vui lòng nhập họ tên');
    let u = this.findUserByEmail(email);
    if (u && u.status !== 'pending') throw new HttpError(409, 'EMAIL_EXISTS', 'Email này đã có tài khoản. Vui lòng đăng nhập hoặc dùng "Quên mật khẩu".');
    const nowIso = new Date(this.now()).toISOString();
    if (!u) {
      u = { id: C.uid(), email: C.normalizeEmail(email), email_key: C.emailKey(email), role: 'customer', status: 'pending', created_at: nowIso, licenses: [], reminders: {} };
      this.d.users.push(u);
    }
    Object.assign(u, { name, phone: String(phone || '').trim().slice(0, 30), company: String(company || '').trim().slice(0, 200), password_hash: C.hashPassword(password) });
    this.store.save();
    this.store.audit('REGISTER', u.email);
    const r = await this.sendOtp(u, 'verify').catch(e => { if (e.code === 'OTP_COOLDOWN') return { sent: true, cooldown: true }; throw e; });
    return { email: u.email, status: 'pending', mail_sent: r.sent, _code: r._code };
  }

  async resendVerify(email) {
    const u = this.findUserByEmail(email);
    if (!u || u.status !== 'pending') return { ok: true }; // không tiết lộ email có tồn tại hay không
    const r = await this.sendOtp(u, 'verify');
    return { ok: true, mail_sent: r.sent, _code: r._code };
  }

  async verifyEmail({ email, code, device_id, device_name, ip }) {
    const u = this.findUserByEmail(email);
    if (!u) throw new HttpError(400, 'OTP_INVALID', 'Mã không đúng');
    if (u.status !== 'pending') throw new HttpError(409, 'ALREADY_VERIFIED', 'Email đã được xác minh, vui lòng đăng nhập');
    this.checkOtp(u, 'verify', code);
    const now = this.now();
    u.status = 'active';
    u.verified_at = new Date(now).toISOString();
    // Mỗi hộp thư (theo email_key) chỉ được dùng thử 1 lần, kể cả khi tài khoản cũ đã bị xoá
    const usedTrial = (this.d.trial_ledger || []).includes(u.email_key);
    if (!usedTrial) {
      u.trial_started_at = u.verified_at;
      u.trial_ends_at = new Date(now + this.trialDays * DAY).toISOString();
      (this.d.trial_ledger = this.d.trial_ledger || []).push(u.email_key);
    }
    this.store.save();
    this.store.audit('VERIFY_EMAIL', u.email, usedTrial ? 'không cấp dùng thử (đã dùng trước đó)' : `dùng thử đến ${u.trial_ends_at}`);
    if (u.trial_ends_at) await this.mail(u.email, T.welcomeMail({ product: this.productName, name: u.name, email: u.email, trialEndsAt: u.trial_ends_at, trialDays: this.trialDays, appUrl: this.appUrl }));
    return this.createSession(u, { device_id, device_name, ip });
  }

  // ---------- Đăng nhập / phiên ----------
  createSession(u, { device_id, device_name, ip }) {
    const now = this.now();
    const token = C.randomToken();
    const deviceId = String(device_id || '').slice(0, 100) || null;
    // một thiết bị chỉ giữ một phiên; vượt số thiết bị tối đa thì đóng phiên cũ nhất
    this.d.sessions = this.d.sessions.filter(s => Date.parse(s.expires_at) > now && !(s.user_id === u.id && deviceId && s.device_id === deviceId));
    const mine = this.d.sessions.filter(s => s.user_id === u.id).sort((a, b) => Date.parse(a.last_seen_at) - Date.parse(b.last_seen_at));
    while (!isStaff(u) && mine.length >= this.maxDevices) { const old = mine.shift(); this.d.sessions = this.d.sessions.filter(s => s !== old); }
    this.d.sessions.push({ id: C.uid(), token_hash: C.sha256(token), user_id: u.id, device_id: deviceId, device_name: String(device_name || '').slice(0, 100),
      ip: ip || '', created_at: new Date(now).toISOString(), last_seen_at: new Date(now).toISOString(), expires_at: new Date(now + this.sessionDays * DAY).toISOString() });
    u.last_login_at = new Date(now).toISOString();
    this.store.save();
    return { token, account: this.publicUser(u), entitlement: this.issueEntitlement(u, deviceId) };
  }

  async login({ email, password, device_id, device_name, ip }) {
    const u = this.findUserByEmail(email);
    // luôn chạy scrypt để thời gian phản hồi không lộ email có tồn tại hay không
    const ok = C.verifyPassword(password, u ? u.password_hash : 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64'));
    if (!u || !ok) throw new HttpError(401, 'BAD_CREDENTIALS', 'Email hoặc mật khẩu không đúng');
    if (u.status === 'pending') {
      await this.sendOtp(u, 'verify').catch(() => null);
      throw new HttpError(403, 'EMAIL_NOT_VERIFIED', 'Email chưa được xác minh. Mã xác minh đã được gửi lại vào hộp thư của bạn.');
    }
    if (u.status === 'disabled') throw new HttpError(403, 'ACCOUNT_DISABLED', 'Tài khoản đã bị khoá, vui lòng liên hệ hỗ trợ');
    this.store.audit('LOGIN', u.email, device_name || '');
    return this.createSession(u, { device_id, device_name, ip });
  }

  authenticate(token) {
    if (!token) throw new HttpError(401, 'UNAUTHENTICATED', 'Chưa đăng nhập');
    const now = this.now();
    const s = this.d.sessions.find(x => x.token_hash === C.sha256(token));
    if (!s || Date.parse(s.expires_at) < now) throw new HttpError(401, 'SESSION_EXPIRED', 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại');
    const u = this.d.users.find(x => x.id === s.user_id);
    if (!u || u.status === 'disabled') throw new HttpError(401, 'ACCOUNT_DISABLED', 'Tài khoản không còn hoạt động');
    // gia hạn trượt: mỗi lần dùng đẩy hạn phiên thêm sessionDays (ghi tối đa 1 lần/giờ)
    if (now - Date.parse(s.last_seen_at) > 3600000) { s.last_seen_at = new Date(now).toISOString(); s.expires_at = new Date(now + this.sessionDays * DAY).toISOString(); this.store.save(); }
    return { user: u, session: s };
  }
  logout(token) {
    const h = C.sha256(token || '');
    this.d.sessions = this.d.sessions.filter(s => s.token_hash !== h);
    this.store.save();
  }
  me(token) {
    const { user, session } = this.authenticate(token);
    return { account: this.publicUser(user), entitlement: this.issueEntitlement(user, session.device_id) };
  }

  // ---------- Quên mật khẩu ----------
  async forgot(email) {
    const u = this.findUserByEmail(email);
    if (!u || u.status !== 'active') return { ok: true };
    const r = await this.sendOtp(u, 'reset');
    return { ok: true, _code: r._code };
  }
  async resetPassword({ email, code, new_password }) {
    const u = this.findUserByEmail(email);
    if (!u || u.status !== 'active') throw new HttpError(400, 'OTP_INVALID', 'Mã không đúng');
    const pwErr = C.passwordProblem(new_password); if (pwErr) throw new HttpError(400, 'PASSWORD_WEAK', pwErr);
    this.checkOtp(u, 'reset', code);
    u.password_hash = C.hashPassword(new_password);
    this.d.sessions = this.d.sessions.filter(s => s.user_id !== u.id); // đăng xuất mọi thiết bị
    this.store.save();
    this.store.audit('RESET_PASSWORD', u.email);
    return { ok: true };
  }
  changePassword(token, { old_password, new_password }) {
    const { user, session } = this.authenticate(token);
    if (!C.verifyPassword(old_password, user.password_hash)) throw new HttpError(400, 'BAD_CREDENTIALS', 'Mật khẩu hiện tại không đúng');
    const pwErr = C.passwordProblem(new_password); if (pwErr) throw new HttpError(400, 'PASSWORD_WEAK', pwErr);
    user.password_hash = C.hashPassword(new_password);
    this.d.sessions = this.d.sessions.filter(s => s.user_id !== user.id || s === session);
    this.store.save();
    this.store.audit('CHANGE_PASSWORD', user.email);
    return { ok: true };
  }

  // ---------- License-key ----------
  generateKeys({ count = 1, days = 365, plan = '', note = '', customer_email = '' }, actor) {
    count = Math.floor(Number(count)); days = Math.floor(Number(days));
    if (!(count >= 1 && count <= 500)) throw new HttpError(400, 'BAD_COUNT', 'Số lượng key từ 1 đến 500');
    if (!(days >= 1 && days <= 3650)) throw new HttpError(400, 'BAD_DAYS', 'Số ngày từ 1 đến 3650');
    const batch = C.uid();
    const created = [];
    const existing = new Set(this.d.keys.map(k => k.key));
    while (created.length < count) {
      const key = keys.generateKey(this.secret);
      if (existing.has(key)) continue;
      existing.add(key);
      const rec = { key, days, plan: String(plan || `${days} ngày`).slice(0, 60), note: String(note || '').slice(0, 300),
        customer_email: customer_email ? C.normalizeEmail(customer_email) : '', status: 'new', batch,
        created_at: new Date(this.now()).toISOString(), created_by: actor || 'cli' };
      this.d.keys.push(rec); created.push(rec);
    }
    this.store.save();
    this.store.audit('GENERATE_KEYS', actor || 'cli', `${count} key × ${days} ngày (lô ${batch})`);
    return created;
  }

  async activateKey(token, rawKey) {
    const { user } = this.authenticate(token);
    if (isStaff(user)) throw new HttpError(400, 'ADMIN_NO_LICENSE', 'Tài khoản quản trị không cần license');
    const fmt = keys.checkKeyFormat(this.secret, rawKey);
    if (!fmt.ok) throw new HttpError(400, 'KEY_INVALID', 'License-key không hợp lệ, vui lòng kiểm tra lại');
    const rec = this.d.keys.find(k => k.key === fmt.key);
    if (!rec) throw new HttpError(400, 'KEY_INVALID', 'License-key không hợp lệ, vui lòng kiểm tra lại');
    if (rec.status === 'revoked') throw new HttpError(400, 'KEY_REVOKED', 'License-key đã bị thu hồi');
    if (rec.status === 'active') throw new HttpError(409, 'KEY_USED', rec.activated_by === user.id ? 'Bạn đã kích hoạt key này rồi' : 'License-key đã được sử dụng cho tài khoản khác');
    if (rec.customer_email && C.emailKey(rec.customer_email) !== user.email_key) throw new HttpError(403, 'KEY_OTHER_CUSTOMER', 'License-key này được cấp cho email khác');
    const now = this.now();
    // cộng nối tiếp: không mất số ngày dùng thử/license còn lại
    const base = Math.max(now, user.trial_ends_at ? Date.parse(user.trial_ends_at) : 0, user.license_expires_at ? Date.parse(user.license_expires_at) : 0);
    user.license_expires_at = new Date(base + rec.days * DAY).toISOString();
    (user.licenses = user.licenses || []).push({ key: rec.key, days: rec.days, activated_at: new Date(now).toISOString() });
    user.reminders = {};
    Object.assign(rec, { status: 'active', activated_by: user.id, activated_email: user.email, activated_at: new Date(now).toISOString() });
    this.store.save();
    this.store.audit('ACTIVATE_KEY', user.email, `${rec.key} (+${rec.days} ngày) → ${user.license_expires_at}`);
    await this.mail(user.email, T.licenseActivatedMail({ product: this.productName, name: user.name, key: rec.key, days: rec.days, expiresAt: user.license_expires_at }));
    return this.me(token);
  }

  revokeKey(key, actor) {
    const k = this.d.keys.find(x => x.key === keys.normalizeKey(key));
    if (!k) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy key');
    if (k.status === 'active') {
      // thu hồi key đã kích hoạt: trừ lại số ngày đã cộng cho khách
      const u = this.d.users.find(x => x.id === k.activated_by);
      if (u && u.license_expires_at) {
        u.license_expires_at = new Date(Date.parse(u.license_expires_at) - k.days * DAY).toISOString();
        u.licenses = (u.licenses || []).filter(l => l.key !== k.key);
        // không còn ngày license nào vượt quá hạn dùng thử -> trở lại trạng thái dùng thử/hết hạn
        if (Date.parse(u.license_expires_at) <= Math.max(this.now(), u.trial_ends_at ? Date.parse(u.trial_ends_at) : 0)) u.license_expires_at = null;
      }
    }
    k.status = 'revoked'; k.revoked_at = new Date(this.now()).toISOString();
    this.store.save();
    this.store.audit('REVOKE_KEY', actor, k.key);
    return k;
  }

  // ---------- Quản trị ----------
  requireAdmin(token) {
    const { user } = this.authenticate(token);
    if (!isStaff(user)) throw new HttpError(403, 'FORBIDDEN', 'Chỉ quản trị viên được thực hiện');
    return user;
  }
  requireRoot(token) {
    const { user } = this.authenticate(token);
    if (user.role !== 'root') throw new HttpError(403, 'FORBIDDEN', 'Chỉ tài khoản root được thực hiện');
    return user;
  }
  // Tài khoản root: quyền cao nhất (quản lý cả quản trị viên). Tạo bằng cli.js create-root hoặc ROOT_EMAIL/ROOT_PASSWORD.
  createRoot(email, password, name = 'Root') {
    const u = this.createAdmin(email, password, name);
    u.role = 'root';
    this.store.save();
    this.store.audit('CREATE_ROOT', 'cli', u.email);
    return u;
  }
  // Root tạo quản trị viên mới (hoặc nâng một tài khoản đã có thành quản trị viên)
  addAdmin({ email, password, name }, actor) {
    const exist = this.findUserByEmail(email);
    if (exist && exist.role === 'root') throw new HttpError(400, 'IS_ROOT', 'Tài khoản này là root');
    if (!exist && !password) throw new HttpError(400, 'PASSWORD_REQUIRED', 'Nhập mật khẩu cho quản trị viên mới');
    if (password) { const e = C.passwordProblem(password); if (e) throw new HttpError(400, 'PASSWORD_WEAK', e); }
    if (!C.isValidEmail(email)) throw new HttpError(400, 'EMAIL_INVALID', 'Email không hợp lệ');
    let u = exist;
    if (!u) { u = { id: C.uid(), email: C.normalizeEmail(email), email_key: C.emailKey(email), created_at: new Date(this.now()).toISOString(), licenses: [], reminders: {} }; this.d.users.push(u); }
    Object.assign(u, { role: 'admin', status: 'active', name: String(name || u.name || 'Quản trị').slice(0, 100), verified_at: u.verified_at || new Date(this.now()).toISOString() });
    if (password) u.password_hash = C.hashPassword(password);
    this.store.save();
    this.store.audit('ADD_ADMIN', actor, u.email);
    return this.publicUser(u);
  }
  // Việc chỉ root làm được với một tài khoản: đổi vai trò, đặt lại mật khẩu, xoá
  rootManageUser(id, { role, new_password, remove }, actor) {
    const u = this.d.users.find(x => x.id === id);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
    if (u.role === 'root') throw new HttpError(400, 'IS_ROOT', 'Không thao tác trên tài khoản root (đổi mật khẩu root ở menu của chính root hoặc cli.js)');
    if (remove) {
      this.d.users = this.d.users.filter(x => x !== u);
      this.d.sessions = this.d.sessions.filter(s => s.user_id !== u.id);
      this.store.save(); this.store.audit('DELETE_USER', actor, u.email);
      return { ok: true, deleted: u.email };
    }
    if (role) {
      if (!['admin', 'customer'].includes(role)) throw new HttpError(400, 'BAD_ROLE', 'Vai trò không hợp lệ');
      if (role === 'admin' && u.status === 'pending') throw new HttpError(400, 'BAD_STATUS', 'Tài khoản chưa xác minh email');
      u.role = role;
      this.d.sessions = this.d.sessions.filter(s => s.user_id !== u.id); // đăng nhập lại để nhận quyền mới
      this.store.audit('SET_ROLE', actor, `${u.email} → ${role}`);
    }
    if (new_password) {
      const e = C.passwordProblem(new_password); if (e) throw new HttpError(400, 'PASSWORD_WEAK', e);
      u.password_hash = C.hashPassword(new_password);
      this.d.sessions = this.d.sessions.filter(s => s.user_id !== u.id);
      this.store.audit('ROOT_RESET_PASSWORD', actor, u.email);
    }
    this.store.save();
    return this.publicUser(u);
  }
  createAdmin(email, password, name = 'Quản trị') {
    if (!C.isValidEmail(email)) throw new Error('Email không hợp lệ');
    const pwErr = C.passwordProblem(password); if (pwErr) throw new Error(pwErr);
    let u = this.findUserByEmail(email);
    if (!u) { u = { id: C.uid(), email: C.normalizeEmail(email), email_key: C.emailKey(email), created_at: new Date(this.now()).toISOString(), licenses: [], reminders: {} }; this.d.users.push(u); }
    Object.assign(u, { name, role: 'admin', status: 'active', password_hash: C.hashPassword(password), verified_at: u.verified_at || new Date(this.now()).toISOString() });
    this.store.save();
    this.store.audit('CREATE_ADMIN', 'cli', u.email);
    return u;
  }
  adjustUser(id, { add_days, status }, actor, actorRole = 'root') {
    const u = this.d.users.find(x => x.id === id);
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Không tìm thấy tài khoản');
    if (u.role === 'root') throw new HttpError(400, 'IS_ROOT', 'Không thao tác trên tài khoản root');
    if (isStaff(u) && actorRole !== 'root') throw new HttpError(403, 'FORBIDDEN', 'Chỉ root được thay đổi tài khoản quản trị viên');
    if (add_days !== undefined && add_days !== null && add_days !== '') {
      const n = Math.floor(Number(add_days));
      if (!(Math.abs(n) >= 1 && Math.abs(n) <= 3650)) throw new HttpError(400, 'BAD_DAYS', 'Số ngày không hợp lệ');
      const now = this.now();
      const base = Math.max(now, u.trial_ends_at ? Date.parse(u.trial_ends_at) : 0, u.license_expires_at ? Date.parse(u.license_expires_at) : 0);
      u.license_expires_at = new Date(base + n * DAY).toISOString();
      u.reminders = {};
      this.store.audit('ADJUST_USER', actor, `${u.email} ${n > 0 ? '+' : ''}${n} ngày → ${u.license_expires_at}`);
    }
    if (status) {
      if (!['active', 'disabled'].includes(status)) throw new HttpError(400, 'BAD_STATUS', 'Trạng thái không hợp lệ');
      if (u.status === 'pending' && status === 'active') throw new HttpError(400, 'BAD_STATUS', 'Tài khoản chưa xác minh email');
      u.status = status;
      if (status === 'disabled') this.d.sessions = this.d.sessions.filter(s => s.user_id !== u.id);
      this.store.audit('USER_STATUS', actor, `${u.email} → ${status}`);
    }
    this.store.save();
    return this.publicUser(u);
  }
  stats() {
    const users = this.d.users.filter(u => !isStaff(u)).map(u => this.publicUser(u));
    const count = p => users.filter(p).length;
    return {
      users: users.length, pending: count(u => u.status === 'pending'), trial: count(u => u.plan === 'trial'),
      licensed: count(u => u.plan === 'licensed'), expired: count(u => /expired/.test(u.plan) && u.status === 'active'),
      keys_new: this.d.keys.filter(k => k.status === 'new').length, keys_active: this.d.keys.filter(k => k.status === 'active').length,
    };
  }

  // ---------- Nhắc hạn (chạy định kỳ) ----------
  async sendExpiryReminders(thresholds = [7, 1]) {
    let sent = 0;
    for (const u of this.d.users) {
      if (isStaff(u) || u.status !== 'active') continue;
      const a = this.accessOf(u);
      if (!a.active) continue;
      // ngưỡng nhỏ nhất còn >= số ngày còn lại; gửi một lần và đánh dấu mọi ngưỡng lớn hơn để không gửi trùng
      const due = thresholds.filter(t => a.days_left <= t);
      if (!due.length) continue;
      u.reminders = u.reminders || {};
      const tagOf = t => `${a.plan}-${a.access_until}-${t}`;
      if (u.reminders[tagOf(Math.min(...due))]) continue;
      for (const t of due) u.reminders[tagOf(t)] = new Date(this.now()).toISOString();
      await this.mail(u.email, T.expiryReminderMail({ product: this.productName, name: u.name, accessUntil: a.access_until, daysLeft: a.days_left, plan: a.plan }));
      sent++;
    }
    if (sent) this.store.save();
    return sent;
  }
}

function maskKey(k) { return k ? k.replace(/^(HDTK-\w{5})-\w{5}-\w{5}-(\w{5})$/, '$1-•••••-•••••-$2') : k; }

module.exports = { LicenseService, HttpError, maskKey, DAY, isStaff };
