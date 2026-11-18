export const REGISTRATION_PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;
export const LOGIN_PASSWORD_MIN_LENGTH = 1;

export class PasswordPolicyError extends Error {
  readonly code = "password_policy_violation";

  constructor() {
    super("Password does not satisfy the frozen policy");
    this.name = "PasswordPolicyError";
  }
}

function assertPasswordLength(
  password: string,
  minimumLength: number,
): void {
  if (
    typeof password !== "string" ||
    password.length < minimumLength ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new PasswordPolicyError();
  }
}

export function assertRegistrationPassword(password: string): void {
  assertPasswordLength(password, REGISTRATION_PASSWORD_MIN_LENGTH);
}

export function assertLoginPassword(password: string): void {
  assertPasswordLength(password, LOGIN_PASSWORD_MIN_LENGTH);
}
