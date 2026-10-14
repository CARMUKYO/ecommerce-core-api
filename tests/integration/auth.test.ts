import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
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
        authorization: `Bearer ${customer.id}`,
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
        authorization: `Bearer ${suspendedAdmin.id}`,
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
        authorization: `Bearer ${admin.id}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
  });
});
