import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { db } from "../../src/db/client.js";
import { sessions, users } from "../../src/db/schema/index.js";
import { hashSessionToken } from "../../src/modules/auth/credentials.js";
import { createUser } from "../helpers/fixtures.js";

describe("Authentication & Error Envelope", () => {
  const app = buildApp();

  it("returns 401 UNAUTHENTICATED when authorization header is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/products",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body).toEqual({
      error: {
        code: "UNAUTHENTICATED",
        message: "Missing or invalid authorization header",
      },
    });
  });

  it("returns 401 UNAUTHENTICATED when bearer token is malformed or invalid user id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/admin/products",
      headers: {
        authorization: "Bearer 00000000-0000-0000-0000-000000000000",
      },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("returns 403 FORBIDDEN when user has CUSTOMER role", async () => {
    const customer = await createUser({ role: "CUSTOMER", status: "ACTIVE" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/products",
      headers: {
        authorization: `Bearer ${customer.token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body).toEqual({
      error: {
        code: "FORBIDDEN",
        message: "You do not have permission to perform this action",
      },
    });
  });

  it("returns 403 ACCOUNT_SUSPENDED when admin user is suspended", async () => {
    const suspendedAdmin = await createUser({ role: "ADMIN", status: "SUSPENDED" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/products",
      headers: {
        authorization: `Bearer ${suspendedAdmin.token}`,
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body).toEqual({
      error: {
        code: "ACCOUNT_SUSPENDED",
        message: "User account is suspended",
      },
    });
  });

  it("succeeds when user is an ACTIVE ADMIN", async () => {
    const admin = await createUser({ role: "ADMIN", status: "ACTIVE" });
    const res = await app.inject({
      method: "GET",
      url: "/admin/products",
      headers: {
        authorization: `Bearer ${admin.token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });

  const PASSWORD = "correct horse battery staple";

  async function register(email: string, password = PASSWORD, extra: Record<string, unknown> = {}) {
    return app.inject({ method: "POST", url: "/auth/register", payload: { email, password, ...extra } });
  }

  async function login(email: string, password = PASSWORD) {
    return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
  }

  function me(token: string) {
    return app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
  }

  describe("Registration", () => {
    it("creates a CUSTOMER even when the request asks for ADMIN, and never returns the hash", async () => {
      const res = await register("New.User@Example.com ", PASSWORD, { role: "ADMIN", status: "ACTIVE" });

      expect(res.statusCode).toBe(201);
      const { user } = res.json();
      expect(user).toMatchObject({ email: "new.user@example.com", role: "CUSTOMER", status: "ACTIVE" });
      expect(Object.keys(user).sort()).toEqual(["createdAt", "email", "id", "role", "status"]);
      expect(res.body).not.toContain("scrypt");

      // Stored as a salted scrypt hash, never the plaintext
      const [row] = await db.select().from(users).where(eq(users.id, user.id));
      expect(row?.passwordHash).toMatch(/^scrypt\$131072\$8\$1\$/);
      expect(row?.passwordHash).not.toContain(PASSWORD);
    });

    it("rejects a duplicate email case-insensitively with 409 EMAIL_ALREADY_REGISTERED", async () => {
      expect((await register("dup@example.com")).statusCode).toBe(201);
      const res = await register("DUP@Example.COM");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("EMAIL_ALREADY_REGISTERED");
    });

    it("concurrent registrations of the same email: exactly one 201, one 409", async () => {
      const responses = await Promise.all([register("race@example.com"), register("race@example.com")]);
      expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    });

    it.each([
      ["password shorter than 12 characters", "a@example.com", "short"],
      ["password longer than 128 characters", "a@example.com", "x".repeat(129)],
      ["invalid email", "not-an-email", PASSWORD],
    ])("rejects %s with 400 VALIDATION_ERROR", async (_label, email, password) => {
      const res = await register(email, password);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("Login", () => {
    it("issues a 7-day token that authenticates /auth/me, with case-insensitive email", async () => {
      await register("login@example.com");
      const res = await login("  LOGIN@example.com");

      expect(res.statusCode).toBe(200);
      const { token, expiresAt, user } = res.json();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const ttlHours = (new Date(expiresAt).getTime() - Date.now()) / 3_600_000;
      expect(ttlHours).toBeGreaterThan(167.9);
      expect(ttlHours).toBeLessThanOrEqual(168);

      const meRes = await me(token);
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().user).toEqual(user);
      expect(meRes.json().user).not.toHaveProperty("passwordHash");
    });

    it("wrong password and unknown email produce byte-identical 401 responses", async () => {
      await register("victim@example.com");
      const wrongPassword = await login("victim@example.com", "definitely-not-it");
      const unknownEmail = await login("nobody@example.com", "definitely-not-it");

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownEmail.statusCode).toBe(401);
      expect(wrongPassword.body).toBe(unknownEmail.body);
      expect(wrongPassword.json().error.code).toBe("INVALID_CREDENTIALS");
    });

    it("suspended user: 403 only with the correct password (status not disclosed otherwise)", async () => {
      const { user } = (await register("suspended@example.com")).json();
      await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, user.id));

      const correct = await login("suspended@example.com");
      expect(correct.statusCode).toBe(403);
      expect(correct.json().error.code).toBe("ACCOUNT_SUSPENDED");

      const wrong = await login("suspended@example.com", "definitely-not-it");
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().error.code).toBe("INVALID_CREDENTIALS");

      expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
    });
  });

  describe("Sessions", () => {
    it("stores only the SHA-256 hash of the token, never the token itself", async () => {
      const { user } = (await register("hash@example.com")).json();
      const { token } = (await login("hash@example.com")).json();

      const rows = await db.select().from(sessions).where(eq(sessions.userId, user.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).toBe(hashSessionToken(token));
      expect(rows[0]!.tokenHash).not.toContain(token);
    });

    it("logout revokes only the current session; the revoked token then gets 401", async () => {
      await register("multi@example.com");
      const deviceA = (await login("multi@example.com")).json().token;
      const deviceB = (await login("multi@example.com")).json().token;

      const out = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${deviceA}` },
      });
      expect(out.statusCode).toBe(204);

      expect((await me(deviceA)).statusCode).toBe(401);
      expect((await me(deviceB)).statusCode).toBe(200);

      // Repeating logout with the revoked token is harmless (just unauthenticated)
      const again = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${deviceA}` },
      });
      expect(again.statusCode).toBe(401);
    });

    it("rejects an expired session with 401", async () => {
      const user = await createUser();
      await db
        .update(sessions)
        .set({ createdAt: new Date(Date.now() - 2 * 3_600_000), expiresAt: new Date(Date.now() - 1_000) })
        .where(eq(sessions.userId, user.id));

      const res = await me(user.token);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    });

    it("suspension takes effect on the very next request of an existing session", async () => {
      const user = await createUser();
      expect((await me(user.token)).statusCode).toBe(200);

      await db.update(users).set({ status: "SUSPENDED" }).where(eq(users.id, user.id));
      const res = await me(user.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("ACCOUNT_SUSPENDED");
    });

    it("the old dev seam is gone: a raw user id is not a valid token", async () => {
      const user = await createUser({ role: "ADMIN" });
      const res = await app.inject({
        method: "GET",
        url: "/admin/products",
        headers: { authorization: `Bearer ${user.id}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("never writes the bearer token to the request logs", async () => {
      const lines: string[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString());
          cb();
        },
      });
      const loggedApp = buildApp({ logger: { level: "trace", stream: sink } });
      const user = await createUser();

      const res = await loggedApp.inject({
        method: "GET",
        url: "/auth/me",
        headers: { authorization: `Bearer ${user.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.join("")).not.toContain(user.token);
      await loggedApp.close();
    });
  });
});
