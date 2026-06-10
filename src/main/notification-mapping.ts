/**
 * Async notifications (#14): the pure, tested core-boundary mapping — which lifecycle transitions
 * become native OS notifications, and with what copy. Deliberately electron-free so the unit tier
 * (and CI, which never downloads the Electron binary) can import it; the thin Electron shell lives
 * in notifications.ts.
 */

import type { LifecycleEvent } from "../core/ports/lifecycle.js";

export interface NativeNotification {
  title: string;
  body: string;
}

/** Which transitions deserve a notification, and the copy. Null = stay silent. */
export function notificationFor(event: LifecycleEvent): NativeNotification | null {
  if (event.kind === "spec") {
    if (event.status === "merged") {
      return {
        title: `Spec merged — ${event.storyKey}`,
        body: `${event.specId} went green and merged into the story branch.`,
      };
    }
    if (event.status === "failed") {
      return {
        title: `Spec failed — ${event.storyKey}`,
        body: `${event.specId} failed. Open Dugout to review and restart clean.`,
      };
    }
    return null;
  }
  switch (event.status) {
    case "awaiting-review":
      return {
        title: `Review required — ${event.storyKey}`,
        body: "A review-required spec merged. Execution is paused for your code review.",
      };
    case "dev-complete":
      return {
        title: `Story dev-complete — ${event.storyKey}`,
        body: "Every spec is green and merged. Ready to push & open PRs.",
      };
    // story `failed` is always preceded by the failing spec's own event — one notification, not two.
    default:
      return null;
  }
}
