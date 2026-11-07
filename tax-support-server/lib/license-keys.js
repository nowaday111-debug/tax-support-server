// License-key dạng HDTK-XXXXX-XXXXX-XXXXX-XXXXX (Crockford base32, 20 ký tự = 100 bit).
// 8 byte ngẫu nhiên + 4 byte HMAC-SHA256 (LICENSE_SECRET) cắt ngắn, nên:
//  - gõ sai một ký tự bị phát hiện ngay, không cần tra CSDL;
//  - không biết LICENSE_SECRET thì không tự "chế" được key hợp lệ.
// Key hợp lệ về hình thức vẫn phải có trong kho (do máy chủ phát hành) và chưa bị dùng/thu hồi.
const crypto = require('crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: bỏ I, L, O, U
const PREFIX = 'HDTK';

function b32encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function mac(secret, body) {
  return crypto.createHmac('sha256', String(secret)).update(PREFIX).update(body).digest().subarray(0, 4);
}

function generateKey(secret) {
  const body = crypto.randomBytes(8);
  const raw = b32encode(Buffer.concat([body, mac(secret, body)])); // 96 bit -> 20 ký tự
  return `${PREFIX}-${raw.match(/.{5}/g).join('-')}`;
}

// Chuẩn hoá chuỗi người dùng nhập: chữ hoa, bỏ khoảng trắng, O->0, I/L->1 (theo Crockford)
function normalizeKey(input) {
  let s = String(input || '').toUpperCase().replace(/[\s_]/g, '');
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  s = s.replace(/-/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== 20) return null;
  return `${PREFIX}-${s.match(/.{5}/g).join('-')}`;
}

function checkKeyFormat(secret, input) {
  const key = normalizeKey(input);
  if (!key) return { ok: false, key: null };
  const buf = b32decode(key.slice(PREFIX.length + 1).replace(/-/g, ''));
  if (!buf || buf.length < 12) return { ok: false, key };
  // ký tự cuối chỉ mang 1 bit dữ liệu (4 bit đệm): bắt buộc dạng chuẩn để mọi lỗi gõ đều bị phát hiện
  if (`${PREFIX}-${b32encode(buf.subarray(0, 12)).match(/.{5}/g).join('-')}` !== key) return { ok: false, key };
  const body = buf.subarray(0, 8), tag = buf.subarray(8, 12);
  return { ok: crypto.timingSafeEqual(tag, mac(secret, body)), key };
}

module.exports = { generateKey, normalizeKey, checkKeyFormat, PREFIX };
