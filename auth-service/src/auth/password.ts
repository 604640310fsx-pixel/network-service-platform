import argon2 from "argon2";

import { argon2Gate, isArgon2BusyError } from "./argon2-gate.js";
import {
  assertLoginPassword,
  assertRegistrationPassword,
} from "./password-policy.js";

// Frozen by auth-service/DEPENDENCY_VERSIONS.md and AUTH-03-GAP-FROZEN.
export const ARGON2_PARAMETERS = Object.freeze({
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  type: argon2.argon2id,
});

export const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=1,t=3$9BGdUw/VFPmZ0kQu7a67aQ$6i3PIulllXJgjfSxZdqYBqXVhFkWPBWKZ/iR5c8VriE";

export class PasswordOperationError extends Error {
  readonly code = "password_operation_failed";

  constructor() {
    super("Password operation failed");
    this.name = "PasswordOperationError";
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertRegistrationPassword(password);

  try {
    return await argon2Gate.run(() =>
      argon2.hash(password, ARGON2_PARAMETERS),
    );
  } catch (error) {
    if (isArgon2BusyError(error)) {
      throw error;
    }
    throw new PasswordOperationError();
  }
}

export async function verifyPasswordHash(
  encodedHash: string,
  presentedPassword: string,
): Promise<boolean> {
  assertLoginPassword(presentedPassword);

  return argon2Gate.run(async () => {
    try {
      return await argon2.verify(encodedHash, presentedPassword);
    } catch {
      return false;
    }
  });
}
