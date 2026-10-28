import type { DatabaseConnection } from "../db.js";
import { DUMMY_PASSWORD_HASH, verifyPasswordHash } from "./password.js";
import {
  findUserByEmail,
  isUserLoginEligible,
  type UserRole,
} from "./user-repository.js";

export interface AuthenticationCandidate {
  readonly id: number;
  readonly email: string;
  readonly role: UserRole;
  readonly verifiedPasswordHash: string;
}

export class InvalidCredentialsError extends Error {
  readonly code = "invalid_credentials";

  constructor() {
    super("Invalid credentials");
    this.name = "InvalidCredentialsError";
  }
}

export async function authenticateUserCandidate(
  database: DatabaseConnection,
  email: string,
  presentedPassword: string,
): Promise<AuthenticationCandidate> {
  const user = findUserByEmail(database, email);
  const passwordHash = user?.passwordHash ?? DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPasswordHash(
    passwordHash,
    presentedPassword,
  );

  if (
    user === null ||
    !passwordMatches ||
    !isUserLoginEligible(user)
  ) {
    throw new InvalidCredentialsError();
  }

  return {
    id: user.id,
    email: user.email,
    role: user.role,
    verifiedPasswordHash: user.passwordHash,
  };
}
