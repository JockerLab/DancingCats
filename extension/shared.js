(() => {
  "use strict";

  const MESSAGE = Object.freeze({
    CONTENT_READY: "CONTENT_READY",
    ENABLE_OVERLAY: "ENABLE_OVERLAY",
    DISABLE_OVERLAY: "DISABLE_OVERLAY",
    START_ANALYSIS: "START_ANALYSIS",
    GET_ANALYSIS: "GET_ANALYSIS",
    ANALYSIS_STATE: "ANALYSIS_STATE"
  });

  const DEFAULT_LAYOUT = Object.freeze({ scale: 0.48, x: 0.5, y: 0.7 });

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, Number(value)));
  }

  function sanitizeLayout(value = {}) {
    return {
      scale: clamp(value.scale ?? DEFAULT_LAYOUT.scale, 0.15, 1),
      x: clamp(value.x ?? DEFAULT_LAYOUT.x, 0.05, 0.95),
      y: clamp(value.y ?? DEFAULT_LAYOUT.y, 0.05, 0.95)
    };
  }

  globalThis.DancingCatsShared = Object.freeze({
    MESSAGE,
    DEFAULT_LAYOUT,
    clamp,
    sanitizeLayout
  });
})();
