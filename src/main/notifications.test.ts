import { describe, it, expect } from "vitest";
import { notificationFor } from "./notification-mapping.js";

/**
 * #14 — the core-boundary contract: which lifecycle transitions become native OS notifications,
 * and with what copy. The Electron `Notification` glue is a thin shell over this pure mapping.
 */
describe("notificationFor (lifecycle event → native notification)", () => {
  it("notifies a spec pass (merged)", () => {
    expect(
      notificationFor({ kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-2", status: "merged" }),
    ).toEqual({
      title: "Spec merged — DUG-1",
      body: "DUG-1-spec-2 went green and merged into the story branch.",
    });
  });

  it("notifies a spec fail", () => {
    expect(
      notificationFor({ kind: "spec", storyKey: "DUG-1", specId: "DUG-1-spec-2", status: "failed" }),
    ).toEqual({
      title: "Spec failed — DUG-1",
      body: "DUG-1-spec-2 failed. Open Dugout to review and restart clean.",
    });
  });

  it("notifies a review-required stop awaiting the developer", () => {
    expect(notificationFor({ kind: "story", storyKey: "DUG-1", status: "awaiting-review" })).toEqual({
      title: "Review required — DUG-1",
      body: "A review-required spec merged. Execution is paused for your code review.",
    });
  });

  it("notifies story completion (dev-complete)", () => {
    expect(notificationFor({ kind: "story", storyKey: "DUG-1", status: "dev-complete" })).toEqual({
      title: "Story dev-complete — DUG-1",
      body: "Every spec is green and merged. Ready to push & open PRs.",
    });
  });

  it("stays silent on story failed — the spec-level failure already notified", () => {
    expect(notificationFor({ kind: "story", storyKey: "DUG-1", status: "failed" })).toBeNull();
  });

  it("stays silent on non-terminal transitions (running, green, executing, drafted…)", () => {
    expect(notificationFor({ kind: "spec", storyKey: "DUG-1", specId: "s", status: "running" })).toBeNull();
    expect(notificationFor({ kind: "spec", storyKey: "DUG-1", specId: "s", status: "green" })).toBeNull();
    expect(notificationFor({ kind: "story", storyKey: "DUG-1", status: "executing" })).toBeNull();
    expect(notificationFor({ kind: "story", storyKey: "DUG-1", status: "drafted" })).toBeNull();
    expect(notificationFor({ kind: "story", storyKey: "DUG-1", status: "approved" })).toBeNull();
  });
});
