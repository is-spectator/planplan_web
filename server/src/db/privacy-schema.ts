export const PRIVACY_SCHEMA_SQL = `ALTER TABLE users ADD COLUMN ai_consent_version text`;
// 回退后旧应用仍能工作，但不能恢复用户已撤回或已过期的同意。
export const PRIVACY_DOWN_SQL = `UPDATE users SET ai_consent = false, ai_consent_at = NULL; ALTER TABLE users DROP COLUMN ai_consent_version`;
