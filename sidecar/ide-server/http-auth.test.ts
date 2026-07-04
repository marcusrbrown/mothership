import { describe, expect, test } from "bun:test";
import { extractBearer, isAuthorized } from "./http-auth";

describe("http-auth", () => {
  test("extracts a bearer token from the header", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
    expect(extractBearer("bearer abc123")).toBe("abc123");
  });

  test("returns undefined for a missing/malformed header", () => {
    expect(extractBearer(null)).toBeUndefined();
    expect(extractBearer("Basic abc123")).toBeUndefined();
  });

  test("isAuthorized true only for the exact matching token", () => {
    expect(isAuthorized("Bearer secret", "secret")).toBe(true);
    expect(isAuthorized("Bearer wrong", "secret")).toBe(false);
    expect(isAuthorized(null, "secret")).toBe(false);
  });
});
