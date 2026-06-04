// Polyfills for jsdom-environment tests (the Motion library expects these browser APIs).
// Guarded on `window` so node-environment tests (the core suite) skip it entirely.
if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number;
    window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  }
}
