import { generateRandomId, randomBase60String } from "../../src/lib/utils/generate-random-id";
import { stringifyError } from "../../src/lib/utils/error-handle";
import { deg } from "../../src/renderer/render-snapshots";

// ─── generateRandomId ─────────────────────────────────────────────────────────

describe("generateRandomId", () => {
  it("generates a URL-safe base64 string (no +, /, or = chars)", () => {
    const id = generateRandomId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates a consistent length of 22 characters (UUID 16 bytes → base64)", () => {
    for (let i = 0; i < 10; i++) {
      expect(generateRandomId().length).toBe(22);
    }
  });

  it("generates unique IDs across 1000 calls", () => {
    const ids = new Set(Array.from({ length: 1000 }, generateRandomId));
    expect(ids.size).toBe(1000);
  });
});

// ─── randomBase60String ───────────────────────────────────────────────────────

const BASE60 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx";

describe("randomBase60String", () => {
  it("generates a string of the exact requested length", () => {
    expect(randomBase60String(1).length).toBe(1);
    expect(randomBase60String(8).length).toBe(8);
    expect(randomBase60String(16).length).toBe(16);
    expect(randomBase60String(0).length).toBe(0);
  });

  it("only uses characters from the base60 alphabet", () => {
    const s = randomBase60String(200);
    for (const ch of s) {
      expect(BASE60).toContain(ch);
    }
  });

  it("generates different outputs across calls (probabilistic)", () => {
    const a = randomBase60String(16);
    const b = randomBase60String(16);
    // Probability of collision is astronomically low
    expect(a).not.toBe(b);
  });
});

// ─── stringifyError ───────────────────────────────────────────────────────────

describe("stringifyError", () => {
  it("returns the .message for Error instances", () => {
    expect(stringifyError(new Error("something went wrong"))).toBe("something went wrong");
  });

  it("returns .error for plain objects with an error string field", () => {
    expect(stringifyError({ error: "bad thing happened" })).toBe("bad thing happened");
  });

  it("returns 'Error: <value>' for strings", () => {
    expect(stringifyError("raw message")).toBe("Error: raw message");
  });

  it("returns 'Error: <value>' for numbers", () => {
    expect(stringifyError(42)).toBe("Error: 42");
  });

  it("returns 'Error: null' for null", () => {
    expect(stringifyError(null)).toBe("Error: null");
  });

  it("returns 'Error: undefined' for undefined", () => {
    expect(stringifyError(undefined)).toBe("Error: undefined");
  });

  it("does not use .error field when the value is not a string", () => {
    // .error is a number → should fall through to String()
    const obj = { error: 123 } as unknown;
    expect(stringifyError(obj)).toBe("Error: [object Object]");
  });
});

// ─── deg ──────────────────────────────────────────────────────────────────────

describe("deg (degrees → radians)", () => {
  it("converts 0° to 0 rad", () => {
    expect(deg(0)).toBe(0);
  });

  it("converts 180° to π rad", () => {
    expect(deg(180)).toBeCloseTo(Math.PI);
  });

  it("converts 360° to 2π rad", () => {
    expect(deg(360)).toBeCloseTo(2 * Math.PI);
  });

  it("converts 90° to π/2 rad", () => {
    expect(deg(90)).toBeCloseTo(Math.PI / 2);
  });

  it("converts 45° to π/4 rad", () => {
    expect(deg(45)).toBeCloseTo(Math.PI / 4);
  });
});
