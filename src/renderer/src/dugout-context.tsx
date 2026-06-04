import { createContext, useContext, type ReactNode } from "react";
import type { DugoutApi } from "../../shared/dugout-api.js";

/**
 * Provides the {@link DugoutApi} to the component tree. Components consume it via {@link useDugout}
 * and never reference `window`/IPC — so the IPC implementation can be swapped for an HTTP one
 * (cloud backend) without touching any component (ADR-0001).
 */
const DugoutContext = createContext<DugoutApi | null>(null);

export function DugoutProvider({ api, children }: { api: DugoutApi; children: ReactNode }) {
  return <DugoutContext.Provider value={api}>{children}</DugoutContext.Provider>;
}

export function useDugout(): DugoutApi {
  const api = useContext(DugoutContext);
  if (!api) throw new Error("useDugout must be used within a DugoutProvider");
  return api;
}
