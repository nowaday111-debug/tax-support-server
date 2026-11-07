// Băm mật khẩu (scrypt), mã OTP, token phiên, chuẩn hoá email — chỉ dùng thư viện chuẩn Node.
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, N, r, p, saltB64, hashB64] = stored.split('$');
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, got);
}

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const otpCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const uid = () => Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

// Email hiển thị: giữ nguyên (trim + chữ thường).
// Khoá chống trùng: với Gmail bỏ dấu chấm và phần +bí-danh, để một hộp thư không lấy được nhiều lần dùng thử.
function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return e;
}
function emailKey(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  local = local.split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
function isValidEmail(email) {
  const e = normalizeEmail(email);
  return e.length <= 254 && /^[^\s@"'<>(),;:\\]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e);
}
function passwordProblem(pw) {
  pw = String(pw || '');
  if (pw.length < 8) return 'Mật khẩu tối thiểu 8 ký tự';
  if (pw.length > 128) return 'Mật khẩu tối đa 128 ký tự';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Mật khẩu phải có cả chữ và số';
  return null;
}

module.exports = { hashPassword, verifyPassword, sha256, randomToken, otpCode, uid, normalizeEmail, emailKey, isValidEmail, passwordProblem };
