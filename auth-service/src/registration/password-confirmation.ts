import {
  assertRegistrationPassword,
  PasswordPolicyError,
} from "../auth/password-policy.js";

export function assertRegistrationPasswordConfirmation(
  password: string,
  confirmPassword: string,
): void {
  if (password !== confirmPassword) {
    throw new PasswordPolicyError();
  }
  assertRegistrationPassword(password);
}
