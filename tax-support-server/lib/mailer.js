// Gửi thư cho máy chủ license. Ba kênh (MAIL_TRANSPORT):
//  - outbox  : không gửi ra ngoài, ghi file .eml vào data/outbox và in ra console (mặc định, để thử)
//  - ses_api : Amazon SES API v2 (SendEmail), ký SigV4 — khuyên dùng, gửi từ hotro@vn-invsearch.top
//  - smtp    : SMTP (Gmail App Password, SMTP của SES, ...), hỗ trợ STARTTLS (587) và SMTPS (465)
// Chỉ dùng thư viện chuẩn Node.
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const https = require('https');
const { signRequest } = require('./sigv4');

const b64 = s => Buffer.from(String(s), 'utf8').toString('base64');
const encodeHeader = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');
function fromHeader(cfg) { return cfg.fromName ? `${encodeHeader(cfg.fromName)} <${cfg.from}>` : cfg.from; }

function buildMime(cfg, { to, subject, text, html }) {
  const boundary = 'b_' + crypto.randomBytes(12).toString('hex');
  const headers = [
    `From: ${fromHeader(cfg)}`,
    `To: ${to}`,
    cfg.replyTo ? `Reply-To: ${cfg.replyTo}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${(cfg.from.split('@')[1] || 'localhost')}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const part = (type, body) => [`--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, 'Content-Transfer-Encoding: base64', '', wrap76(b64(body))].join('\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + [part('text/plain', text || ''), part('text/html', html || `<pre>${text}</pre>`), `--${boundary}--`, ''].join('\r\n');
}

// ---------- outbox ----------
async function sendOutbox(cfg, msg) {
  const dir = cfg.outboxDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${msg.to.replace(/[^a-z0-9@._-]/gi, '_')}.eml`);
  fs.writeFileSync(file, buildMime(cfg, msg));
  if (!cfg.quiet) console.log(`[mail/outbox] -> ${msg.to} | ${msg.subject}\n${msg.text}\n(lưu tại ${file})`);
  return { transport: 'outbox', file };
}

// ---------- Amazon SES API v2 ----------
function httpsRequest(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: 20000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('SES quá thời gian chờ')));
    req.on('error', reject);
    req.end(body);
  });
}
async function sendSes(cfg, msg) {
  if (!cfg.aws.accessKeyId || !cfg.aws.secretAccessKey) throw new Error('Thiếu AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY cho SES');
  const region = cfg.aws.region;
  const url = cfg.aws.endpoint ? cfg.aws.endpoint.replace(/\/$/, '') + '/v2/email/outbound-emails' : `https://email.${region}.amazonaws.com/v2/email/outbound-emails`;
  const payload = {
    FromEmailAddress: fromHeader(cfg),
    Destination: { ToAddresses: [msg.to] },
    Content: { Simple: {
      Subject: { Data: msg.subject, Charset: 'UTF-8' },
      Body: { Text: { Data: msg.text || '', Charset: 'UTF-8' }, ...(msg.html ? { Html: { Data: msg.html, Charset: 'UTF-8' } } : {}) },
    } },
  };
  if (cfg.replyTo) payload.ReplyToAddresses = [cfg.replyTo];
  if (cfg.aws.configurationSet) payload.ConfigurationSetName = cfg.aws.configurationSet;
  const body = JSON.stringify(payload);
  const signed = signRequest({ method: 'POST', url, headers: { 'content-type': 'application/json' }, body, region, service: 'ses',
    accessKeyId: cfg.aws.accessKeyId, secretAccessKey: cfg.aws.secretAccessKey, sessionToken: cfg.aws.sessionToken });
  const r = await httpsRequest(url, { method: 'POST', headers: { ...signed.headers, 'content-length': Buffer.byteLength(body) }, body });
  if (r.status < 200 || r.status >= 300) {
    let m = r.body; try { const j = JSON.parse(r.body); m = j.message || j.Message || r.body; } catch { /* giữ nguyên */ }
    throw new Error(`SES trả lỗi ${r.status}: ${m}`);
  }
  return { transport: 'ses_api', messageId: (JSON.parse(r.body || '{}').MessageId) || null };
}

// ---------- SMTP ----------
function smtpSession(socket) {
  let buf = ''; const waiters = [];
  const onData = d => {
    buf += d.toString('utf8');
    let m;
    // một phản hồi hoàn chỉnh kết thúc bằng dòng "NNN " (không phải "NNN-")
    while ((m = buf.match(/^((?:\d{3}-[^\r\n]*\r?\n)*\d{3} [^\r\n]*\r?\n)/))) {
      buf = buf.slice(m[1].length);
      const w = waiters.shift(); if (w) w.resolve(m[1]);
    }
  };
  socket.on('data', onData);
  const onErr = e => { while (waiters.length) waiters.shift().reject(e); };
  socket.on('error', onErr);
  return {
    read: () => new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    detach: () => { socket.off('data', onData); socket.off('error', onErr); },
  };
}
async function sendSmtp(cfg, msg) {
  const s = cfg.smtp;
  if (!s.host) throw new Error('Thiếu SMTP_HOST');
  const implicitTls = s.secure === 'ssl' || Number(s.port) === 465;
  let socket = await new Promise((resolve, reject) => {
    const opts = { host: s.host, port: Number(s.port), servername: s.host, rejectUnauthorized: s.rejectUnauthorized !== false };
    const so = implicitTls ? tls.connect(opts, () => resolve(so)) : net.connect(opts, () => resolve(so));
    so.setTimeout(30000, () => so.destroy(new Error('SMTP quá thời gian chờ')));
    so.once('error', reject);
  });
  let io = smtpSession(socket);
  const cmd = async (line, expect) => {
    if (line !== null) socket.write(line + '\r\n');
    const resp = await io.read();
    const code = Number(resp.slice(0, 3));
    if (!expect.includes(code)) throw new Error(`SMTP lỗi sau "${(line || '').split(' ')[0] || 'kết nối'}": ${resp.trim()}`);
    return resp;
  };
  try {
    const ehloName = s.ehloName || 'localhost';
    await cmd(null, [220]);
    let ehlo = await cmd(`EHLO ${ehloName}`, [250]);
    if (!implicitTls && /STARTTLS/i.test(ehlo) && s.secure !== 'none') {
      await cmd('STARTTLS', [220]);
      io.detach();
      socket = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: s.host, rejectUnauthorized: s.rejectUnauthorized !== false }, () => resolve(t));
        t.once('error', reject);
      });
      io = smtpSession(socket);
      ehlo = await cmd(`EHLO ${ehloName}`, [250]);
    } else if (!implicitTls && s.secure === 'starttls') {
      throw new Error('Máy chủ SMTP không hỗ trợ STARTTLS');
    }
    if (s.user) {
      await cmd('AUTH LOGIN', [334]);
      await cmd(b64(s.user), [334]);
      await cmd(b64(s.pass || ''), [235]);
    }
    await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
    await cmd(`RCPT TO:<${msg.to}>`, [250, 251]);
    await cmd('DATA', [354]);
    const data = buildMime(cfg, msg).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    socket.write(data + '\r\n.\r\n');
    const resp = await cmd(null, [250]);
    socket.write('QUIT\r\n'); socket.end();
    return { transport: 'smtp', response: resp.trim() };
  } catch (e) {
    socket.destroy();
    throw e;
  }
}

function mailConfigFromEnv(env, dataDir) {
  return {
    transport: (env.MAIL_TRANSPORT || 'outbox').toLowerCase(),
    from: env.MAIL_FROM || 'hotro@vn-invsearch.top',
    fromName: env.MAIL_FROM_NAME || 'Hóa đơn & Tờ khai',
    replyTo: env.MAIL_REPLY_TO || env.MAIL_FROM || 'hotro@vn-invsearch.top',
    outboxDir: path.join(dataDir, 'outbox'),
    quiet: env.MAIL_QUIET === '1',
    aws: {
      region: env.AWS_REGION || env.SES_REGION || 'ap-southeast-1',
      accessKeyId: env.AWS_ACCESS_KEY_ID || env.SES_ACCESS_KEY_ID || '',
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY || env.SES_SECRET_ACCESS_KEY || '',
      sessionToken: env.AWS_SESSION_TOKEN || '',
      endpoint: env.SES_ENDPOINT || '',
      configurationSet: env.SES_CONFIGURATION_SET || '',
    },
    smtp: {
      host: env.SMTP_HOST || '', port: Number(env.SMTP_PORT || 587),
      secure: (env.SMTP_SECURE || 'starttls').toLowerCase(), // starttls | ssl | none
      user: env.SMTP_USER || '', pass: env.SMTP_PASS || '',
      rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED !== '0',
    },
  };
}

function createMailer(cfg) {
  const send = async msg => {
    if (cfg.transport === 'ses_api' || cfg.transport === 'ses') return sendSes(cfg, msg);
    if (cfg.transport === 'smtp') return sendSmtp(cfg, msg);
    return sendOutbox(cfg, msg);
  };
  return { send, config: cfg, describe: () => ({ transport: cfg.transport, from: cfg.from, region: cfg.aws.region, smtp_host: cfg.smtp.host || null }) };
}

module.exports = { createMailer, mailConfigFromEnv, buildMime };
