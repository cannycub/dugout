/**
 * The Electron shell for #14: shows the native notification for a lifecycle transition (works
 * while the app is backgrounded). Best-effort — a notification failure degrades to a warning and
 * never touches the run (invariant 7). The tested mapping lives in notification-mapping.ts,
 * which stays electron-free for the unit tier.
 */

import { Notification } from "electron";
import type { LifecycleEvent } from "../core/ports/lifecycle.js";
import { notificationFor } from "./notification-mapping.js";

/** Show the native notification; best-effort, never throws. */
export function notifyNative(event: LifecycleEvent): void {
  try {
    const payload = notificationFor(event);
    if (!payload || !Notification.isSupported()) return;
    new Notification({ title: payload.title, body: payload.body }).show();
  } catch (err) {
    console.warn(`[dugout] native notification failed (non-blocking): ${String(err)}`);
  }
}
