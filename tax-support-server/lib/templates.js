// Nội dung thư gửi khách (tiếng Việt, có bản text + HTML đơn giản).
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const vnDate = iso => { const d = new Date(iso); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };

function layout(title, bodyHtml, product) {
  return `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Inter,Arial,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px">
<div style="font-weight:700;color:#2563eb;font-size:14px;margin-bottom:16px">${esc(product)}</div>
<h1 style="font-size:18px;margin:0 0 12px">${esc(title)}</h1>
${bodyHtml}
<p style="font-size:12px;color:#475569;margin-top:24px;border-top:1px solid #f1f5f9;padding-top:12px">Thư gửi tự động, vui lòng không chia sẻ mã hoặc mật khẩu cho người khác.</p>
</div></body></html>`;
}

function otpMail({ product, name, code, purpose, minutes }) {
  const what = purpose === 'reset' ? 'đặt lại mật khẩu' : 'xác minh email đăng ký';
  const subject = purpose === 'reset' ? `Mã đặt lại mật khẩu: ${code}` : `Mã xác minh đăng ký: ${code}`;
  const text = `Xin chào ${name || ''},\n\nMã ${what} của bạn là: ${code}\nMã có hiệu lực trong ${minutes} phút.\n\nNếu bạn không yêu cầu, hãy bỏ qua thư này.\n\n${product}`;
  const html = layout(subject, `<p>Xin chào ${esc(name || '')},</p><p>Mã ${what} của bạn:</p>
<div style="font-size:28px;letter-spacing:6px;font-weight:700;background:#eff6ff;color:#1d4ed8;padding:12px 16px;border-radius:8px;display:inline-block">${esc(code)}</div>
<p style="font-size:13px;color:#475569">Mã có hiệu lực trong ${minutes} phút. Nếu bạn không yêu cầu, hãy bỏ qua thư này.</p>`, product);
  return { subject, text, html };
}

function welcomeMail({ product, name, email, trialEndsAt, trialDays, appUrl }) {
  const subject = `Chào mừng bạn — tặng ${trialDays} ngày dùng thử`;
  const text = `Xin chào ${name || ''},\n\nTài khoản ${email} đã được kích hoạt.\nBạn được dùng thử miễn phí ${trialDays} ngày, đến hết ngày ${vnDate(trialEndsAt)}.\nSau thời gian này, vui lòng mua license-key và nhập vào mục "Nhập license-key" trong phần mềm để tiếp tục sử dụng.\n${appUrl ? `\nĐăng nhập: ${appUrl}\n` : ''}\n${product}`;
  const html = layout('Tài khoản đã được kích hoạt', `<p>Xin chào ${esc(name || '')},</p>
<p>Tài khoản <b>${esc(email)}</b> đã được kích hoạt.</p>
<p>Bạn được <b>dùng thử miễn phí ${trialDays} ngày</b>, đến hết ngày <b>${vnDate(trialEndsAt)}</b>.</p>
<p>Sau thời gian này, vui lòng mua license-key và nhập vào mục <i>Nhập license-key</i> trong phần mềm để tiếp tục sử dụng.</p>
${appUrl ? `<p><a href="${esc(appUrl)}" style="background:#2563eb;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none">Đăng nhập</a></p>` : ''}`, product);
  return { subject, text, html };
}

function licenseActivatedMail({ product, name, key, days, expiresAt }) {
  const subject = `Đã kích hoạt license — dùng đến ${vnDate(expiresAt)}`;
  const text = `Xin chào ${name || ''},\n\nLicense-key ${key} (${days} ngày) đã được kích hoạt cho tài khoản của bạn.\nHạn sử dụng mới: ${vnDate(expiresAt)}.\n\nCảm ơn bạn đã sử dụng ${product}.`;
  const html = layout('Đã kích hoạt license', `<p>Xin chào ${esc(name || '')},</p>
<p>License-key <code>${esc(key)}</code> (${days} ngày) đã được kích hoạt cho tài khoản của bạn.</p>
<p>Hạn sử dụng mới: <b>${vnDate(expiresAt)}</b>.</p><p>Cảm ơn bạn đã sử dụng ${esc(product)}.</p>`, product);
  return { subject, text, html };
}

function expiryReminderMail({ product, name, accessUntil, daysLeft, plan }) {
  const what = plan === 'trial' ? 'Thời gian dùng thử' : 'License';
  const subject = `${what} còn ${daysLeft} ngày`;
  const text = `Xin chào ${name || ''},\n\n${what} của bạn hết hạn ngày ${vnDate(accessUntil)} (còn ${daysLeft} ngày).\nVui lòng mua license-key và nhập vào phần mềm để không bị gián đoạn.\n\n${product}`;
  const html = layout(subject, `<p>Xin chào ${esc(name || '')},</p><p>${what} của bạn hết hạn ngày <b>${vnDate(accessUntil)}</b> (còn ${daysLeft} ngày).</p><p>Vui lòng mua license-key và nhập vào phần mềm để không bị gián đoạn.</p>`, product);
  return { subject, text, html };
}

module.exports = { otpMail, welcomeMail, licenseActivatedMail, expiryReminderMail, vnDate };
