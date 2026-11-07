// Giấy phép sử dụng ("entitlement") ký bằng Ed25519.
// Máy chủ giữ khoá bí mật; ứng dụng của khách chỉ cần khoá công khai để kiểm tra offline.
// Định dạng token: base64url(JSON payload) + "." + base64url(chữ ký).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function loadOrCreateKeyPair(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const privFile = path.join(dir, 'entitlement-ed25519.pem');
  const pubFile = path.join(dir, 'entitlement-ed25519.pub.pem');
  if (!fs.existsSync(privFile)) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }));
  }
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privFile));
  const publicKey = crypto.createPublicKey(privateKey);
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  if (!fs.existsSync(pubFile)) fs.writeFileSync(pubFile, publicPem);
  return { privateKey, publicKey, publicPem };
}

function sign(privateKey, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from(body), privateKey).toString('base64url');
  return `${body}.${sig}`;
}

// Dùng chung cho cả máy chủ và ứng dụng khách (bản sao ở src/auth/entitlement.js).
function verify(publicKey, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  try {
    const key = typeof publicKey === 'string' ? crypto.createPublicKey(publicKey) : publicKey;
    if (!crypto.verify(null, Buffer.from(body), key, Buffer.from(sig, 'base64url'))) return null;
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch { return null; }
}

module.exports = { loadOrCreateKeyPair, sign, verify };
