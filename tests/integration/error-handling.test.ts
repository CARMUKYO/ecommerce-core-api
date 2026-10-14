import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createUser } from "../helpers/fixtures.js";

describe("Error Handling: client errors are 4xx in the standard envelope, never 500", () => {
  const app = buildApp();

  describe("Malformed bearer tokens", () => {
    it.each(["not-a-uuid", "123", `${randomUUID()}x`, "'; DROP TABLE users; --"])(
      "returns 401 UNAUTHENTICATED for token %j (indistinguishable from an unknown user)",
      async (token) => {
        for (const url of ["/cart", "/admin/products"]) {
          const res = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
          expect(res.statusCode).toBe(401);
          expect(res.json()).toEqual({
            error: { code: "UNAUTHENTICATED", message: "Invalid authentication credentials" },
          });
        }

        // A well-formed token that matches no session fails identically
        const unknownToken = await app.inject({
          method: "GET",
          url: "/cart",
          headers: { authorization: `Bearer ${"A".repeat(43)}` },
        });
        expect(unknownToken.statusCode).toBe(401);
        expect(unknownToken.json().error.message).toBe("Invalid authentication credentials");
      },
    );

    it("accepts a valid session token", async () => {
      const customer = await createUser();
      const res = await app.inject({
        method: "GET",
        url: "/cart",
        headers: { authorization: `Bearer ${customer.token}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("Body parsing errors", () => {
    it("returns 400 MALFORMED_REQUEST_BODY for invalid JSON without echoing the payload", async () => {
      const customer = await createUser();
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}`, "content-type": "application/json" },
        payload: '{"productId": SECRET_FRAGMENT',
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: { code: "MALFORMED_REQUEST_BODY", message: "Request body is malformed or empty" },
      });
      expect(res.body).not.toContain("SECRET_FRAGMENT");
    });

    it("returns 400 MALFORMED_REQUEST_BODY for an empty JSON body", async () => {
      const customer = await createUser();
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}`, "content-type": "application/json" },
        payload: "",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("MALFORMED_REQUEST_BODY");
    });

    // Note: text/plain is parsed by Fastify by default (it then fails schema validation with 400).
    it("returns 415 UNSUPPORTED_MEDIA_TYPE for a content type with no registered parser", async () => {
      const customer = await createUser();
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}`, "content-type": "text/xml" },
        payload: "<productId/>",
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({
        error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported content type" },
      });
    });

    it("returns 413 PAYLOAD_TOO_LARGE when the body exceeds the configured limit", async () => {
      const smallApp = buildApp({ bodyLimit: 64 });
      const customer = await createUser();
      const res = await smallApp.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}`, "content-type": "application/json" },
        payload: JSON.stringify({ productId: randomUUID(), quantity: 1, padding: "x".repeat(200) }),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
      await smallApp.close();
    });

    it("rejects an unauthenticated request with 401 before parsing a malformed body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { "content-type": "application/json" },
        payload: "{bad json",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    });
  });

  describe("Unknown routes", () => {
    it.each(["GET", "POST", "PROPFIND"] as const)("returns 404 ROUTE_NOT_FOUND envelope for %s", async (method) => {
      const res = await app.inject({ method, url: "/definitely/not/a/route?q=<script>" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: "ROUTE_NOT_FOUND", message: "The requested route does not exist" },
      });
    });
  });

  describe("Regression: existing error paths are unchanged", () => {
    it("still returns 400 VALIDATION_ERROR for schema violations", async () => {
      const customer = await createUser();
      const res = await app.inject({
        method: "POST",
        url: "/cart/items",
        headers: { authorization: `Bearer ${customer.token}` },
        payload: { productId: "nope", quantity: 0 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });

    it("still returns domain AppErrors as-is (400 CART_EMPTY)", async () => {
      const customer = await createUser();
      const res = await app.inject({
        method: "POST",
        url: "/checkout",
        headers: { authorization: `Bearer ${customer.token}`, "idempotency-key": randomUUID() },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("CART_EMPTY");
    });

    it("still returns a generic 500 that leaks nothing for genuine server errors", async () => {
      const faultyApp = buildApp();
      faultyApp.get("/__boom", async () => {
        throw new Error("connection string postgres://admin:hunter2@db");
      });
      const res = await faultyApp.inject({ method: "GET", url: "/__boom" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: { code: "INTERNAL_ERROR", message: "An internal server error occurred" },
      });
      expect(res.body).not.toContain("hunter2");
      await faultyApp.close();
    });
  });
});
