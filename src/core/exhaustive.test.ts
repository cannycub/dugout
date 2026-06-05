import { describe, it, expect } from "vitest";
import { assertNever } from "./exhaustive.js";

describe("assertNever", () => {
  it("throws with the unhandled value so a missed union arm is loud at runtime", () => {
    // Simulates a discriminant that escaped an exhaustive switch (cast through unknown).
    const rogue = { result: "surprise" } as unknown as never;
    expect(() => assertNever(rogue)).toThrow(/surprise/);
  });

  it("includes the caller's context label in the message", () => {
    const rogue = "x" as unknown as never;
    expect(() => assertNever(rogue, "draftStory")).toThrow(/draftStory/);
  });
});
