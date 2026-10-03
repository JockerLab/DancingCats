(() => {
  "use strict";

  const { MESSAGE, DEFAULT_LAYOUT, sanitizeLayout } = DancingCatsShared;
  const LAYOUT_KEY = "layout";
  const CAT_ASSET = "assets/cats/three-cats.webm";

  class DancingCatsController {
    constructor() {
      this.enabled = false;
      this.layout = { ...DEFAULT_LAYOUT };
      this.mainVideo = null;
      this.playerAbort = null;
      this.host = null;
      this.shadow = null;
      this.box = null;
      this.catVideo = null;
      this.fallback = null;
      this.attachScheduled = false;
      this.observer = new MutationObserver(() => this.scheduleAttach());
      void this.loadLayout();
    }

    async loadLayout() {
      const stored = await chrome.storage.local.get(LAYOUT_KEY);
      this.layout = sanitizeLayout(stored[LAYOUT_KEY]);
      this.applyLayout();
    }

    enable() {
      if (this.enabled) return;
      this.enabled = true;
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener("yt-navigate-finish", this.onYouTubeNavigate);
      this.attach();
    }

    disable() {
      this.enabled = false;
      this.observer.disconnect();
      window.removeEventListener("yt-navigate-finish", this.onYouTubeNavigate);
      this.detachPlayer();
      this.catVideo?.pause();
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.box = null;
      this.catVideo = null;
      this.fallback = null;
    }

    onYouTubeNavigate = () => this.scheduleAttach();

    scheduleAttach() {
      if (!this.enabled || this.attachScheduled) return;
      this.attachScheduled = true;
      requestAnimationFrame(() => {
        this.attachScheduled = false;
        this.attach();
      });
    }

    attach() {
      const video = findActiveVideo();
      if (!video) return;
      const player = video.closest(".html5-video-player") || video.parentElement;
      if (!player) return;

      if (!this.host) this.createOverlay();
      if (this.host.parentElement !== player) player.append(this.host);
      if (this.mainVideo !== video) this.attachPlayer(video);
    }

    attachPlayer(video) {
      this.detachPlayer();
      this.mainVideo = video;
      this.playerAbort = new AbortController();
      const { signal } = this.playerAbort;
      video.addEventListener("play", () => this.playCats(), { signal });
      video.addEventListener("pause", () => this.catVideo?.pause(), { signal });
      video.addEventListener("emptied", () => this.scheduleAttach(), { signal });
      if (video.paused) this.catVideo?.pause();
      else this.playCats();
    }

    detachPlayer() {
      this.playerAbort?.abort();
      this.playerAbort = null;
      this.mainVideo = null;
    }

    createOverlay() {
      this.host = document.createElement("div");
      this.host.id = "dancing-cats-extension-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      this.shadow.innerHTML = `
        <style>${OVERLAY_STYLES}</style>
        <div class="root">
          <div class="cat-box" title="Перетащите котов мышкой">
            <video class="cat-video" muted playsinline loop preload="auto"></video>
            <div class="fallback" hidden><span>🐈</span><span>🐈</span><span>🐈</span></div>
            <button class="resize-handle" type="button" title="Изменить размер" aria-label="Изменить размер"></button>
          </div>
        </div>`;

      this.box = this.shadow.querySelector(".cat-box");
      this.catVideo = this.shadow.querySelector(".cat-video");
      this.fallback = this.shadow.querySelector(".fallback");
      this.catVideo.src = chrome.runtime.getURL(CAT_ASSET);
      this.catVideo.addEventListener("loadedmetadata", () => {
        this.fallback.hidden = true;
        this.catVideo.hidden = false;
        if (!this.mainVideo?.paused) this.playCats();
      });
      this.catVideo.addEventListener("error", () => {
        this.catVideo.hidden = true;
        this.fallback.hidden = false;
      });

      this.installDragging();
      this.installResizing(this.shadow.querySelector(".resize-handle"));
      this.applyLayout();
    }

    installDragging() {
      this.box.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".resize-handle") || event.button !== 0) return;
        event.preventDefault();
        this.box.setPointerCapture(event.pointerId);
        const bounds = this.host.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const initialX = this.layout.x;
        const initialY = this.layout.y;

        const move = (moveEvent) => {
          if (!bounds.width || !bounds.height) return;
          this.layout = sanitizeLayout({
            ...this.layout,
            x: initialX + (moveEvent.clientX - startX) / bounds.width,
            y: initialY + (moveEvent.clientY - startY) / bounds.height
          });
          this.applyLayout();
        };
        const end = () => {
          this.box.removeEventListener("pointermove", move);
          this.box.removeEventListener("pointerup", end);
          this.box.removeEventListener("pointercancel", end);
          void this.saveLayout();
        };
        this.box.addEventListener("pointermove", move);
        this.box.addEventListener("pointerup", end);
        this.box.addEventListener("pointercancel", end);
      });
    }

    installResizing(handle) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        const hostBounds = this.host.getBoundingClientRect();
        const boxBounds = this.box.getBoundingClientRect();
        const startX = event.clientX;
        const startWidth = boxBounds.width;

        const move = (moveEvent) => {
          if (!hostBounds.width) return;
          const width = startWidth + (moveEvent.clientX - startX) * 2;
          this.layout = sanitizeLayout({
            ...this.layout,
            scale: width / hostBounds.width
          });
          this.applyLayout();
        };
        const end = () => {
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", end);
          handle.removeEventListener("pointercancel", end);
          void this.saveLayout();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
      });
    }

    applyLayout() {
      if (!this.host) return;
      this.host.style.setProperty("--cats-x", `${this.layout.x * 100}%`);
      this.host.style.setProperty("--cats-y", `${this.layout.y * 100}%`);
      this.host.style.setProperty("--cats-width", `${this.layout.scale * 100}%`);
    }

    async saveLayout() {
      await chrome.storage.local.set({ [LAYOUT_KEY]: this.layout });
    }

    playCats() {
      if (!this.catVideo || this.mainVideo?.paused) return;
      this.catVideo.play().catch(() => {});
    }
  }

  function findActiveVideo() {
    const videos = [...document.querySelectorAll("video")];
    let best = null;
    let bestScore = -Infinity;

    for (const video of videos) {
      const bounds = video.getBoundingClientRect();
      if (bounds.width < 100 || bounds.height < 80) continue;
      const visibleWidth = Math.max(0, Math.min(innerWidth, bounds.right) - Math.max(0, bounds.left));
      const visibleHeight = Math.max(0, Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.top));
      const visibleArea = visibleWidth * visibleHeight;
      if (!visibleArea) continue;

      let score = visibleArea / Math.max(1, bounds.width * bounds.height);
      score += Math.log2(Math.max(2, visibleArea)) / 20;
      if (!video.paused) score += 3;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) score += 1;
      if (video.closest("ytd-reel-video-renderer[is-active]")) score += 2;
      if (video.closest(".html5-video-player")) score += 1;
      if (score > bestScore) {
        best = video;
        bestScore = score;
      }
    }
    return best;
  }

  const OVERLAY_STYLES = `
    :host {
      --cats-x: 50%; --cats-y: 70%; --cats-width: 48%;
      position: absolute; inset: 0; z-index: 48; display: block;
      pointer-events: none; overflow: hidden;
    }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .root { position: absolute; inset: 0; pointer-events: none; }
    .cat-box {
      position: absolute; left: var(--cats-x); top: var(--cats-y); width: var(--cats-width);
      transform: translate(-50%, -50%); pointer-events: auto; cursor: grab;
      user-select: none; touch-action: none; border: 1px dashed transparent;
    }
    .cat-box:hover, .cat-box:active { border-color: #fff9; }
    .cat-box:active { cursor: grabbing; }
    .cat-video { display: block; width: 100%; height: auto; pointer-events: none; }
    .fallback {
      display: flex; justify-content: center; align-items: end; gap: 1%;
      min-height: 120px; font-size: clamp(36px, 8vw, 112px); pointer-events: none;
      filter: drop-shadow(0 3px 4px #0008);
    }
    .resize-handle {
      position: absolute; right: -8px; bottom: -8px; width: 18px; height: 18px;
      padding: 0; border: 2px solid #fff; border-radius: 50%; background: #f59e0b;
      box-shadow: 0 1px 4px #000b; cursor: nwse-resize; opacity: 0;
      pointer-events: auto; touch-action: none;
    }
    .cat-box:hover .resize-handle, .resize-handle:active { opacity: 1; }
  `;

  const controller = new DancingCatsController();

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.ENABLE_OVERLAY) controller.enable();
    else if (message?.type === MESSAGE.DISABLE_OVERLAY) controller.disable();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[LAYOUT_KEY]) return;
    controller.layout = sanitizeLayout(changes[LAYOUT_KEY].newValue);
    controller.applyLayout();
  });

  chrome.runtime.sendMessage({ type: MESSAGE.CONTENT_READY }).catch(() => {});
})();
