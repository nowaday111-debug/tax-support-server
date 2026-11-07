// Kho dữ liệu JSON của máy chủ license: tài khoản, license-key, phiên, mã OTP, nhật ký.
// Ghi nguyên tử (file tạm rồi đổi tên) để tránh hỏng file khi tắt máy giữa chừng.
const fs = require('fs');
const path = require('path');

const EMPTY = () => ({ users: [], keys: [], sessions: [], otps: [], audit: [] });

class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      this.load();
    } else {
      this.data = EMPTY();
      this.save();
    }
  }
  load() {
    this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    this.mtime = fs.statSync(this.file).mtimeMs;
  }
  // Đọc lại nếu tiến trình khác (cli.js) vừa ghi file — gọi trước mỗi request
  refreshIfChanged() {
    try { if (fs.statSync(this.file).mtimeMs !== this.mtime) this.load(); } catch { /* giữ dữ liệu trong bộ nhớ */ }
  }
  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.mtime = fs.statSync(this.file).mtimeMs;
  }
  audit(action, actor, detail) {
    this.data.audit.push({ at: new Date().toISOString(), action, actor: actor || '', detail: detail || '' });
    if (this.data.audit.length > 5000) this.data.audit = this.data.audit.slice(-4000);
    this.save();
  }
}

module.exports = { Store };
