// AWS Signature Version 4 tối giản (đủ cho SES API v2) — chỉ thư viện chuẩn.
const crypto = require('crypto');

const hmac = (key, s) => crypto.createHmac('sha256', key).update(s, 'utf8').digest();
const hash = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function signRequest({ method, url, headers = {}, body = '', region, service, accessKeyId, secretAccessKey, sessionToken, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const h = { ...headers, host: u.host, 'x-amz-date': amzDate };
  if (sessionToken) h['x-amz-security-token'] = sessionToken;
  const lower = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const signedHeaders = Object.keys(lower).sort().join(';');
  const canonicalHeaders = Object.keys(lower).sort().map(k => `${k}:${lower[k]}\n`).join('');
  const canonicalPath = u.pathname.split('/').map(seg => enc(decodeURIComponent(seg))).join('/') || '/';
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method.toUpperCase(), canonicalPath, query, canonicalHeaders, signedHeaders, hash(body)].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    headers: { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    signature, canonicalRequest, stringToSign,
  };
}

module.exports = { signRequest };
