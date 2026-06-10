import { describe, it, expect } from "vitest";
import { lineDiff } from "./line-diff.js";

describe("lineDiff (#5)", () => {
  it("marks added, removed, and unchanged lines", () => {
    const before = "# Spec\nAC one\nAC two";
    const after = "# Spec\nAC one — sharpened\nAC two\nAC three";

    expect(lineDiff(before, after)).toEqual([
      { kind: "same", text: "# Spec" },
      { kind: "removed", text: "AC one" },
      { kind: "added", text: "AC one — sharpened" },
      { kind: "same", text: "AC two" },
      { kind: "added", text: "AC three" },
    ]);
  });

  it("identical inputs are all-same; disjoint inputs are full remove+add", () => {
    expect(lineDiff("a\nb", "a\nb").every((l) => l.kind === "same")).toBe(true);
    const disjoint = lineDiff("a", "b");
    expect(disjoint.map((l) => l.kind).sort()).toEqual(["added", "removed"]);
  });
});
