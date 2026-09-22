require('dotenv').config();
const nodemailer = require('nodemailer');

console.log('--- 环境变量检查 ---');
console.log('SMTP_HOST =', process.env.SMTP_HOST);
console.log('SMTP_PORT =', process.env.SMTP_PORT);
console.log('SMTP_SECURE =', process.env.SMTP_SECURE);
console.log('SMTP_USER =', process.env.SMTP_USER);
console.log('SMTP_PASS =', process.env.SMTP_PASS ? '(已设置)' : '(未设置)');
console.log('SMTP_FROM =', process.env.SMTP_FROM);
console.log('--------------------');

(async () => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  // 明确指定 to
  const to = process.env.MAIL_TO || '783311307@qq.com';
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;

  if (!to) {
    console.error('收件人地址为空，请在 .env 中设置 MAIL_TO 或 SMTP_USER。');
    process.exit(1);
  }

  try {
    const info = await transporter.sendMail({
      from,
      to,
      subject: '测试邮件',
      text: '这是一封测试邮件'
    });
    console.log('发送成功:', info.messageId);
  } catch (err) {
    console.error('发送失败:', err.message);
    console.error(err);
  }
})();