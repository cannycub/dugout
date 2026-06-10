/**
 * Lifecycle port — streams story- and spec-level transitions to whoever renders progress (the UI).
 * Fire-and-forget and best-effort: an emit must never throw into the state machine (mirrors the
 * metrics wrapper, CONTEXT.md invariant 7). Distinct from {@link MetricsPort} on purpose — metrics
 * go to Datadog and never reach the renderer (#27 de-conflation); lifecycle goes to the renderer
 * and never to Datadog.
 */

import type { StoryStatus, SpecStatus } from "../domain.js";

/** A domain transition, emitted as it happens. The transport stamps time and maps to the wire shape. */
export type LifecycleEvent =
  | { kind: "story"; storyKey: string; status: StoryStatus }
  | { kind: "spec"; storyKey: string; specId: string; status: SpecStatus };

export interface LifecyclePort {
  /** Fire-and-forget; must never throw into a transition. */
  emit(event: LifecycleEvent): void;
}
