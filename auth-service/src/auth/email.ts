const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

const ASCII_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const ZERO_WIDTH_PATTERN = /[\u200b-\u200d\ufeff]/u;
const BIDI_CONTROL_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export const MAX_EMAIL_LENGTH = 254;

export class InvalidEmailError extends Error {
  readonly code = "invalid_email";

  constructor() {
    super("Invalid email");
    this.name = "InvalidEmailError";
  }
}

export function canonicalizeEmail(input: string): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_EMAIL_LENGTH ||
    ASCII_CONTROL_PATTERN.test(input) ||
    ZERO_WIDTH_PATTERN.test(input) ||
    BIDI_CONTROL_PATTERN.test(input) ||
    !/^[\x00-\x7f]*$/.test(input)
  ) {
    throw new InvalidEmailError();
  }

  const canonical = input.trim().toLowerCase();

  if (!EMAIL_PATTERN.test(canonical)) {
    throw new InvalidEmailError();
  }

  return canonical;
}
