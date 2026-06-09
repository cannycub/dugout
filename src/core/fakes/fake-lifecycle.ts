import type { LifecyclePort, LifecycleEvent } from "../ports/lifecycle.js";

/** Recording lifecycle sink — the unit-test surface for transition sequences (#27). */
export class FakeLifecycle implements LifecyclePort {
  readonly events: LifecycleEvent[] = [];

  emit(event: LifecycleEvent): void {
    this.events.push(event);
  }
}
