/* 只读引用 auth-service 已冻结的密码策略常量
   （auth-service/src/auth/password-policy.ts）。
   前端不重新定义、不加严、不放宽；此处仅用于输入框上限与提示文案。
   website 与 auth-service 是两个独立的 npm 包，无法跨包 import，
   因此在此复制常量值并注明来源，改动须与冻结源同步。 */

export const REGISTRATION_PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
