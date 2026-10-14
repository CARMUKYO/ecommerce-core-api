import { env } from "../../config/env.js";
import { db } from "../../db/client.js";
import { isUniqueViolation } from "../../db/pg-errors.js";
import type { User } from "../../db/schema/users.js";
import { AppError, ErrorCodes } from "../../http/errors.js";
import { authRepository } from "./auth.repository.js";
import type { LoginInput, RegisterInput } from "./auth.schemas.js";
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  SESSION_TOKEN_PATTERN,
  verifyAgainstDummy,
  verifyPassword,
} from "./credentials.js";

export interface PublicUser {
  id: string;
  email: string;
  role: User["role"];
  status: User["status"];
  createdAt: Date;
}

/** Allowlist projection: password_hash can never reach a response. */
export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt };
}

const invalidCredentials = () =>
  new AppError({
    statusCode: 401,
    code: ErrorCodes.INVALID_CREDENTIALS,
    message: "Invalid email or password",
  });

const unauthenticated = () =>
  new AppError({
    statusCode: 401,
    code: ErrorCodes.UNAUTHENTICATED,
    message: "Invalid authentication credentials",
  });

export class AuthService {
  async register(input: RegisterInput): Promise<PublicUser> {
    const passwordHash = await hashPassword(input.password);
    try {
      return toPublicUser(await authRepository.createCustomer(db, input.email, passwordHash));
    } catch (err: unknown) {
      if (isUniqueViolation(err, "users_email_key")) {
        throw new AppError({
          statusCode: 409,
          code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
          message: "An account with this email already exists",
        });
      }
      throw err;
    }
  }

  async login(input: LoginInput): Promise<{ token: string; expiresAt: Date; user: PublicUser }> {
    const user = await authRepository.findUserByEmail(db, input.email);

    // Unknown email and wrong password are indistinguishable in body AND timing.
    const passwordOk = user
      ? await verifyPassword(input.password, user.passwordHash)
      : await verifyAgainstDummy(input.password);
    if (!user || !passwordOk) throw invalidCredentials();

    // Checked only after the password, so suspension status is not disclosed
    // to someone who does not know the password.
    if (user.status === "SUSPENDED") {
      throw new AppError({ statusCode: 403, code: ErrorCodes.ACCOUNT_SUSPENDED, message: "User account is suspended" });
    }

    const token = generateSessionToken();
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 60 * 60 * 1000);
    await authRepository.createSession(db, user.id, hashSessionToken(token), expiresAt);

    return { token, expiresAt, user: toPublicUser(user) };
  }

  /**
   * Resolve a bearer token to its live session and user. Malformed, unknown,
   * expired and revoked tokens all fail identically. User status is re-read on
   * every request, so suspension takes effect immediately.
   */
  async authenticate(token: string): Promise<{ user: User; sessionId: string }> {
    if (!SESSION_TOKEN_PATTERN.test(token)) throw unauthenticated();

    const found = await authRepository.findLiveSessionWithUser(db, hashSessionToken(token));
    if (!found) throw unauthenticated();

    if (found.user.status === "SUSPENDED") {
      throw new AppError({ statusCode: 403, code: ErrorCodes.ACCOUNT_SUSPENDED, message: "User account is suspended" });
    }
    return { user: found.user, sessionId: found.session.id };
  }

  /** Idempotent: revoking an already-deleted session is a no-op. */
  async logout(sessionId: string): Promise<void> {
    await authRepository.deleteSession(db, sessionId);
  }
}


export const authService = new AuthService();
