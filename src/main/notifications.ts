/**
 * Async notifications (#14): native OS notifications when a spec or story finishes (pass/fail) or
 * a review-required stop awaits the developer — so they can kick off a run and walk away.
 *
 * `notificationFor` is the pure, tested core-boundary mapping (lifecycle event → notification or
 * silence); `notifyNative` is the thin Electron shell. Notifications are a best-effort projection
 * (CONTEXT.md invariant 7): a failure degrades to a warning and never touches the run.
 */

import { Notification } from "electron";
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

/** Show the native notification (works while the app is backgrounded); best-effort, never throws. */
export function notifyNative(event: LifecycleEvent): void {
  try {
    const payload = notificationFor(event);
    if (!payload || !Notification.isSupported()) return;
    new Notification({ title: payload.title, body: payload.body }).show();
  } catch (err) {
    console.warn(`[dugout] native notification failed (non-blocking): ${String(err)}`);
  }
}
