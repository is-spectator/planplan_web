import nodemailer from 'nodemailer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emailConfigFromEnv } from '../src/auth/email-config.js';
import { directMail } from '../src/auth/mail.js';

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn() } }));
const sendMail = vi.fn(async () => undefined);
const valid: NodeJS.ProcessEnv = {
  EMAIL_AUTH_ENABLED: '1', EMAIL_AUTH_SECRET: 'synthetic-mail-auth-secret-at-least-32-bytes',
  BETA_EMAIL_ALLOWLIST: 'alice@example.test', EMAIL_SMTP_HOST: 'smtp.qiye.aliyun.com',
  EMAIL_FROM: 'verify@example.test', EMAIL_SMTP_PASSWORD: 'synthetic-smtp-password-never-used',
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(nodemailer.createTransport).mockReturnValue({ sendMail } as unknown as ReturnType<typeof nodemailer.createTransport>);
});
describe('阿里企业邮箱与 DirectMail 配置兼容，合成SMTP适配器', () => {
  it('官方企业邮箱固定465 SSL、证书校验和TLS下限，配置不触发发送', async () => {
    const config = emailConfigFromEnv({ ...valid, EMAIL_SMTP_PORT: '25', EMAIL_SMTP_SECURE: 'false', EMAIL_SMTP_REJECT_UNAUTHORIZED: 'false' })!;
    expect(config.allowedEmails).toEqual(new Set(['alice@example.test']));
    expect(nodemailer.createTransport).toHaveBeenCalledExactlyOnceWith({
      host: 'smtp.qiye.aliyun.com', port: 465, secure: true,
      auth: { user: valid.EMAIL_FROM, pass: valid.EMAIL_SMTP_PASSWORD },
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 12000, logger: false, debug: false,
    });
    expect(sendMail).not.toHaveBeenCalled();
    await config.mailer.send('alice@example.test', '123456', 'register');
    expect(sendMail).toHaveBeenCalledExactlyOnceWith({ from: { name: 'PlanPlan', address: 'verify@example.test' }, to: 'alice@example.test', subject: 'PlanPlan 注册账户验证码', text: expect.stringContaining('123456') });
  });
  it.each(['smtpdm.aliyun.com', 'smtpdm-ap-southeast-1.aliyun.com', 'smtpdm-us-east-1.aliyun.com'])('保留 DirectMail 官方主机 %s 与旧环境变量', host => {
    const { EMAIL_SMTP_HOST: _host, EMAIL_FROM: _from, EMAIL_SMTP_PASSWORD: _password, ...base } = valid;
    emailConfigFromEnv({ ...base, DIRECTMAIL_SMTP_HOST: host, DIRECTMAIL_FROM: valid.EMAIL_FROM, DIRECTMAIL_SMTP_PASSWORD: valid.EMAIL_SMTP_PASSWORD });
    expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({ host, port: 465, secure: true }));
  });
  it('旧配置默认主机保持不变；新旧同值可以共存', () => {
    const { EMAIL_SMTP_HOST: _host, EMAIL_FROM: _from, EMAIL_SMTP_PASSWORD: _password, ...base } = valid;
    emailConfigFromEnv({ ...base, DIRECTMAIL_FROM: valid.EMAIL_FROM, DIRECTMAIL_SMTP_PASSWORD: valid.EMAIL_SMTP_PASSWORD });
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtpdm.aliyun.com' }));
    emailConfigFromEnv({ ...valid, DIRECTMAIL_SMTP_HOST: valid.EMAIL_SMTP_HOST, DIRECTMAIL_FROM: valid.EMAIL_FROM, DIRECTMAIL_SMTP_PASSWORD: valid.EMAIL_SMTP_PASSWORD });
    expect(nodemailer.createTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.qiye.aliyun.com' }));
  });
  it.each([
    ['DIRECTMAIL_SMTP_HOST', 'smtpdm.aliyun.com'],
    ['DIRECTMAIL_FROM', 'other@example.test'],
    ['DIRECTMAIL_SMTP_PASSWORD', 'different-synthetic-secret'],
  ])('新旧别名冲突拒绝且错误不含值：%s', (legacy, value) => {
    let error: unknown; try { emailConfigFromEnv({ ...valid, [legacy]: value }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).toContain('冲突');
    expect((error as Error).message).not.toContain(value); expect((error as Error).message).not.toContain(valid.EMAIL_SMTP_PASSWORD);
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it.each(['attacker.example', 'smtp.qiye.aliyun.com.attacker.example', 'smtp.qiye.aliyun.com:465', 'smtp.qiye.aliyun.com.', 'SMTP.QIYE.ALIYUN.COM', 'smtp.mxhichina.com', 'smtphk.qiye.aliyun.com', '127.0.0.1'])('不扩展任意/旧版/别名SMTP主机：%s', host => {
    expect(() => directMail({ host, from: 'verify@example.test', password: 'synthetic' })).toThrow('官方 SMTP');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
  it('新配置仍要求明确密钥和最多20位内测名单，关闭时不建SMTP连接', () => {
    expect(emailConfigFromEnv({ ...valid, EMAIL_AUTH_ENABLED: '0' })).toBeUndefined();
    expect(() => emailConfigFromEnv({ ...valid, EMAIL_SMTP_PASSWORD: '' })).toThrow('EMAIL_SMTP_PASSWORD');
    expect(() => emailConfigFromEnv({ ...valid, EMAIL_FROM: undefined })).toThrow('EMAIL_FROM');
    expect(() => emailConfigFromEnv({ ...valid, BETA_EMAIL_ALLOWLIST: Array.from({ length: 21 }, (_, i) => `person${i}@example.test`).join(',') })).toThrow('最多 20');
    expect(() => emailConfigFromEnv({ ...valid, BETA_EMAIL_ALLOWLIST: '*' })).toThrow('有效邮箱');
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
