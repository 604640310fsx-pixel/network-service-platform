export type LoginFailureCode =
  | "invalid_credentials"
  | "busy"
  | "rate_limited"
  | "auth_unavailable"
  | "login_failed";

export class LoginRequestError extends Error {
  readonly code: LoginFailureCode;

  constructor(code: LoginFailureCode) {
    super(code);
    this.name = "LoginRequestError";
    this.code = code;
  }
}
