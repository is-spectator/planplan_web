import nodemailer from 'nodemailer';

export type EmailPurpose = 'register' | 'reset';
export interface VerificationMailer {
  send(to: string, code: string, purpose: EmailPurpose): Promise<void>;
}

/** Alibaba Mail / DirectMail official SMTP, implicit TLS. No insecure transport option is exposed. */
export function directMail(config: { host: string; from: string; password: string }): VerificationMailer {
  if (!['smtpdm.aliyun.com', 'smtpdm-ap-southeast-1.aliyun.com', 'smtpdm-us-east-1.aliyun.com', 'smtp.qiye.aliyun.com'].includes(config.host)) {
    throw new Error('EMAIL_SMTP_HOST 必须为允许的阿里邮箱或 DirectMail 官方 SMTP 地址');
  }
  const transport = nodemailer.createTransport({
    host: config.host, port: 465, secure: true,
    auth: { user: config.from, pass: config.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000,
    logger: false, debug: false,
  });
  return {
    async send(to, code, purpose) {
      const action = purpose === 'register' ? '注册账户' : '重置密码';
      await transport.sendMail({
        from: { name: 'PlanPlan', address: config.from }, to,
        subject: `PlanPlan ${action}验证码`,
        text: `你正在${action}。验证码：${code}\n验证码 10 分钟内有效，请勿向他人提供。\n如非本人操作，请忽略此邮件。`,
      });
    },
  };
}
