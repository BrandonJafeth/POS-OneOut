import { describe, expect, it } from "vitest";
import { ES_ULID, ulid, ulidTiempo } from "../src/lib/ulid";

describe("ULID", () => {
  it("tiene 26 caracteres Crockford y codifica el tiempo", () => {
    const t = Date.UTC(2026, 9, 29, 12, 0, 0);
    const id = ulid(t);
    expect(id).toMatch(ES_ULID);
    expect(ulidTiempo(id)).toBe(t);
  });

  it("es único y ordenado aunque se generen miles en el mismo milisegundo", () => {
    const t = Date.now();
    const ids = Array.from({ length: 5000 }, () => ulid(t));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("ordena por fecha de creación", () => {
    const a = ulid(1_000_000);
    const b = ulid(1_000_001);
    expect(a < b).toBe(true);
  });
});
