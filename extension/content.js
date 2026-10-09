(() => {
  "use strict";

  const { MESSAGE, DEFAULT_LAYOUT, clamp, sanitizeLayout } = DancingCatsShared;
  const LAYOUT_KEY = "layout";
  const POLL_INTERVAL_MS = 1000;
  const MIN_PLAYBACK_RATE = 0.25;
  const MAX_PLAYBACK_RATE = 4;
  const HARD_SEEK_THRESHOLD_SECONDS = 0.35;
  const FRAME_TOLERANCE_SECONDS = 1 / 30;

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
      this.spinner = null;
      this.errorMark = null;
      this.mirrorButton = null;
      this.resizeHandle = null;
      this.choreography = null;
      this.motionMap = null;
      this.assetBlobUrl = null;
      this.assetResourcesPromise = null;
      this.assetReady = false;
      this.analysisUrl = null;
      this.analysisToken = 0;
      this.animationFrame = null;
      this.attachScheduled = false;
      this.visualState = { kind: "loading", stage: "queued", message: "" };
      this.observer = new MutationObserver(() => this.scheduleAttach());
      this.layoutPromise = this.loadLayout().catch(() => {
        this.layout = { ...DEFAULT_LAYOUT };
        this.applyLayout();
      });
    }

    async loadLayout() {
      const stored = await chrome.storage.local.get(LAYOUT_KEY);
      this.layout = sanitizeLayout(stored[LAYOUT_KEY]);
      this.applyLayout();
    }

    async enable(youtubeUrl = location.href) {
      if (!isYouTubeWatchUrl(youtubeUrl)) {
        this.showError("Поддерживаются только обычные YouTube video");
        return;
      }
      if (!this.enabled) {
        this.enabled = true;
        this.observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener("yt-navigate-finish", this.onYouTubeNavigate);
        this.showLoading("queued");
        this.attach();
        this.animationFrame = requestAnimationFrame(this.animate);
        await this.layoutPromise;
        this.attach();
      }
      if (this.analysisUrl !== youtubeUrl || !this.choreography) {
        void this.startAnalysis(youtubeUrl);
      }
    }

    disable() {
      this.enabled = false;
      this.analysisToken += 1;
      this.analysisUrl = null;
      this.choreography = null;
      this.assetReady = false;
      this.observer.disconnect();
      window.removeEventListener("yt-navigate-finish", this.onYouTubeNavigate);
      this.detachPlayer();
      if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      this.catVideo?.pause();
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.box = null;
      this.catVideo = null;
      this.spinner = null;
      this.errorMark = null;
      this.mirrorButton = null;
      this.resizeHandle = null;
    }

    async startAnalysis(youtubeUrl) {
      const token = ++this.analysisToken;
      this.analysisUrl = youtubeUrl;
      this.choreography = null;
      this.lastCueIndex = null;
      this.assetReady = false;
      this.showLoading("queued");
      this.reportState("loading");

      try {
        let response = await chrome.runtime.sendMessage({
          type: MESSAGE.START_ANALYSIS,
          youtubeUrl,
          assetId: "three-cats"
        });
        if (!response?.ok) throw new Error(response?.error || "Не удалось запустить анализ");
        let job = response.data;
        this.showLoading(job.stage || job.status);

        while (job.status === "queued" || job.status === "running") {
          await delay(POLL_INTERVAL_MS);
          if (!this.isCurrentAnalysis(token)) return;
          response = await chrome.runtime.sendMessage({
            type: MESSAGE.GET_ANALYSIS,
            jobId: job.jobId
          });
          if (!response?.ok) throw new Error(response?.error || "Не удалось получить анализ");
          job = response.data;
          this.showLoading(job.stage || job.status);
        }

        if (job.status === "complete" && !job.choreography) {
          response = await chrome.runtime.sendMessage({
            type: MESSAGE.GET_ANALYSIS,
            jobId: job.jobId
          });
          if (!response?.ok) throw new Error(response?.error || "Не удалось загрузить карту");
          job = response.data;
        }

        if (!this.isCurrentAnalysis(token)) return;
        if (job.status !== "complete" || !job.choreography?.cues?.length) {
          throw new Error(job.error || "Backend не сформировал хореографию");
        }

        this.showLoading("asset");
        const resources = await this.loadAssetResources(job.choreography.assetId);
        if (!this.isCurrentAnalysis(token)) return;
        this.motionMap = resources.motionMap;
        this.choreography = job.choreography;
        await this.waitForOverlay(token);
        await this.loadVideoElement(token);
        if (!this.isCurrentAnalysis(token)) return;
        this.assetReady = true;
        this.showReady();
        this.renderCurrentFrame();
        this.reportState("ready");
      } catch (error) {
        if (!this.isCurrentAnalysis(token)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.showError(message);
        this.reportState("error");
      }
    }

    isCurrentAnalysis(token) {
      return this.enabled && token === this.analysisToken;
    }

    async loadAssetResources(assetId) {
      if (!this.assetResourcesPromise) {
        this.assetResourcesPromise = this.fetchAssetResources(assetId).catch((error) => {
          this.assetResourcesPromise = null;
          throw error;
        });
      }
      return this.assetResourcesPromise;
    }

    async fetchAssetResources(assetId) {
      const catalogUrl = chrome.runtime.getURL("assets/catalog.json");
      const catalog = await fetchJsonWithRetry(catalogUrl);
      const descriptor = catalog.assets.find((asset) => asset.id === assetId);
      if (!descriptor) throw new Error(`Ассет ${assetId} отсутствует в каталоге`);
      const mapUrl = new URL(descriptor.motionMap, catalogUrl).href;
      const motionMap = await fetchJsonWithRetry(mapUrl);
      const videoUrl = new URL(motionMap.video, mapUrl).href;
      const response = await fetchWithRetry(videoUrl);
      const videoBlob = await response.blob();
      if (!videoBlob.size) throw new Error("Видеоассет котов пуст");
      if (this.assetBlobUrl) URL.revokeObjectURL(this.assetBlobUrl);
      this.assetBlobUrl = URL.createObjectURL(videoBlob);
      return { motionMap, videoBlobUrl: this.assetBlobUrl };
    }

    async waitForOverlay(token) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!this.isCurrentAnalysis(token)) throw new DOMException("Aborted", "AbortError");
        this.attach();
        if (this.catVideo) return;
        await delay(50);
      }
      throw new Error("Основной YouTube player не найден");
    }

    async loadVideoElement(token) {
      const video = this.catVideo;
      if (!video || !this.assetBlobUrl) throw new Error("Видеоассет не подготовлен");
      video.src = this.assetBlobUrl;
      video.load();
      await waitForMedia(video, "loadeddata");
      if (!this.isCurrentAnalysis(token) || video !== this.catVideo) {
        throw new DOMException("Aborted", "AbortError");
      }
      const sample = this.sampleChoreography(this.mainVideo?.currentTime ?? 0);
      video.currentTime = clamp(
        sample.sourceTime,
        0,
        Math.max(0, Number(this.motionMap.duration) - 1 / 30)
      );
      await waitForSeek(video);
    }

    onYouTubeNavigate = () => {
      const youtubeUrl = location.href;
      if (!isYouTubeWatchUrl(youtubeUrl)) {
        this.disable();
        return;
      }
      this.detachPlayer();
      this.scheduleAttach();
      void this.startAnalysis(youtubeUrl);
    };

    scheduleAttach() {
      if (!this.enabled || this.attachScheduled) return;
      this.attachScheduled = true;
      requestAnimationFrame(() => {
        this.attachScheduled = false;
        this.attach();
      });
    }

    attach() {
      if (!this.enabled) return;
      const video = findMainVideo();
      const player = video?.closest(".html5-video-player");
      if (!video || !player) return;
      if (!this.host) this.createOverlay();
      if (this.host.parentElement !== player) player.append(this.host);
      if (this.mainVideo !== video) this.attachPlayer(video);
    }

    attachPlayer(video) {
      this.detachPlayer();
      this.mainVideo = video;
      this.playerAbort = new AbortController();
      const { signal } = this.playerAbort;
      video.addEventListener("play", () => this.playCatVideo(), { signal });
      video.addEventListener("pause", () => this.catVideo?.pause(), { signal });
      video.addEventListener("seeking", () => this.renderCurrentFrame(), { signal });
      video.addEventListener("seeked", () => this.renderCurrentFrame(), { signal });
      video.addEventListener("emptied", () => this.scheduleAttach(), { signal });
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
            <video class="cat-video" muted playsinline preload="auto" hidden></video>
            <div class="spinner" role="status" aria-label="Загрузка хореографии"></div>
            <div class="error-mark" role="alert" hidden>!</div>
            <button class="mirror-button" type="button" hidden
              title="Отразить котов по вертикали" aria-label="Отразить котов по вертикали"
              aria-pressed="false">]|[</button>
            <button class="resize-handle" type="button" hidden
              title="Изменить размер" aria-label="Изменить размер"></button>
          </div>
        </div>`;
      this.box = this.shadow.querySelector(".cat-box");
      this.catVideo = this.shadow.querySelector(".cat-video");
      this.spinner = this.shadow.querySelector(".spinner");
      this.errorMark = this.shadow.querySelector(".error-mark");
      this.mirrorButton = this.shadow.querySelector(".mirror-button");
      this.resizeHandle = this.shadow.querySelector(".resize-handle");
      this.catVideo.addEventListener("error", () => {
        const code = this.catVideo?.error?.code;
        this.showError(`Ошибка декодирования видеоассета${code ? ` (${code})` : ""}`);
        this.reportState("error");
      });
      this.catVideo.addEventListener("seeked", () => this.renderCurrentFrame());
      this.installMirroring(this.mirrorButton);
      this.installDragging();
      this.installResizing(this.resizeHandle);
      this.applyLayout();
      this.applyVisualState();
    }

    showLoading(stage = "queued") {
      this.visualState = { kind: "loading", stage, message: "" };
      this.applyVisualState();
    }

    showReady() {
      this.visualState = { kind: "ready", stage: "complete", message: "" };
      this.applyVisualState();
    }

    showError(message) {
      this.visualState = { kind: "error", stage: "error", message: message || "Ошибка" };
      this.applyVisualState();
    }

    applyVisualState() {
      const { kind, stage, message } = this.visualState;
      if (this.catVideo) {
        if (kind !== "ready") this.catVideo.pause();
        this.catVideo.hidden = kind !== "ready";
      }
      if (this.spinner) {
        const label = loadingStageLabel(stage);
        this.spinner.hidden = kind !== "loading";
        this.spinner.title = label;
        this.spinner.setAttribute("aria-label", label);
      }
      if (this.errorMark) {
        this.errorMark.hidden = kind !== "error";
        this.errorMark.title = message;
      }
      if (this.mirrorButton) this.mirrorButton.hidden = kind !== "ready";
      if (this.resizeHandle) this.resizeHandle.hidden = kind !== "ready";
    }

    reportState(status) {
      chrome.runtime.sendMessage({ type: MESSAGE.ANALYSIS_STATE, status }).catch(() => {});
    }

    animate = () => {
      if (!this.enabled) return;
      this.animationFrame = requestAnimationFrame(this.animate);
      if (!this.mainVideo?.isConnected) {
        this.scheduleAttach();
        return;
      }
      if (!this.assetReady || !this.choreography || !this.catVideo) return;
      if (this.mainVideo.paused || this.mainVideo.seeking) {
        this.catVideo.pause();
        return;
      }
      this.renderCurrentFrame();
    };

    renderCurrentFrame() {
      if (!this.assetReady || !this.choreography || !this.catVideo || !this.mainVideo) return;
      const sample = this.sampleChoreography(this.mainVideo.currentTime);
      const limit = Math.max(0, Number(this.motionMap.duration) - 1 / 30);
      const desiredTime = clamp(sample.sourceTime, 0, limit);
      const error = desiredTime - this.catVideo.currentTime;
      if (this.catVideo.seeking) return;
      const transitionNeedsSeek = sample.cueChanged
        && Math.abs(error) > FRAME_TOLERANCE_SECONDS;
      const mainSeekNeedsSync = this.mainVideo.seeking
        && Math.abs(error) > FRAME_TOLERANCE_SECONDS;
      if (
        transitionNeedsSeek
        || mainSeekNeedsSync
        || Math.abs(error) > HARD_SEEK_THRESHOLD_SECONDS
      ) {
        this.catVideo.pause();
        this.catVideo.currentTime = desiredTime;
        return;
      }
      if (!sample.active) {
        this.catVideo.pause();
        return;
      }
      const correction = clamp(1 + error * 0.12, 0.94, 1.06);
      this.catVideo.playbackRate = clamp(
        sample.playbackRate * this.mainVideo.playbackRate * correction,
        MIN_PLAYBACK_RATE,
        MAX_PLAYBACK_RATE
      );
      this.playCatVideo();
    }

    sampleChoreography(mediaTime) {
      const cues = this.choreography.cues;
      if (mediaTime < cues[0].start) {
        this.lastCueIndex = -1;
        return {
          active: false,
          cueChanged: false,
          sourceTime: cues[0].sourceStart,
          playbackRate: 1
        };
      }
      const cueIndex = findCueIndex(cues, mediaTime);
      if (cueIndex < 0) {
        const lastCue = cues.at(-1);
        this.lastCueIndex = cues.length;
        return {
          active: false,
          cueChanged: false,
          sourceTime: lastCue.sourceEnd - 1 / 30,
          playbackRate: 1
        };
      }
      const cue = cues[cueIndex];
      const progress = clamp(
        (mediaTime - cue.start) / Math.max(1e-6, cue.end - cue.start),
        0,
        1
      );
      const cueChanged = cueIndex !== this.lastCueIndex;
      this.lastCueIndex = cueIndex;
      return {
        active: true,
        cueChanged,
        sourceTime: cue.sourceStart + (cue.sourceEnd - cue.sourceStart) * progress,
        playbackRate: Number(cue.playbackRate) || 1
      };
    }

    playCatVideo() {
      if (
        !this.catVideo
        || !this.assetReady
        || this.mainVideo?.paused
        || this.mainVideo?.seeking
        || this.catVideo.seeking
        || !this.catVideo.paused
      ) return;
      this.catVideo.play().catch((error) => {
        if (error?.name === "AbortError") return;
        this.showError(error instanceof Error ? error.message : String(error));
        this.reportState("error");
      });
    }

    installDragging() {
      this.box.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".resize-handle, .mirror-button") || event.button !== 0) return;
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

    installMirroring(button) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.layout = sanitizeLayout({
          ...this.layout,
          mirrored: !this.layout.mirrored
        });
        this.applyLayout();
        void this.saveLayout();
      });
    }

    installResizing(handle) {
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        const hostBounds = this.host.getBoundingClientRect();
        const startX = event.clientX;
        const startWidth = this.box.getBoundingClientRect().width;
        const move = (moveEvent) => {
          if (!hostBounds.width) return;
          this.layout = sanitizeLayout({
            ...this.layout,
            scale: (startWidth + (moveEvent.clientX - startX) * 2) / hostBounds.width
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
      this.catVideo?.classList.toggle("mirrored", this.layout.mirrored);
      if (this.mirrorButton) {
        this.mirrorButton.classList.toggle("active", this.layout.mirrored);
        this.mirrorButton.setAttribute("aria-pressed", String(this.layout.mirrored));
      }
    }

    async saveLayout() {
      await chrome.storage.local.set({ [LAYOUT_KEY]: this.layout });
    }
  }

  function findMainVideo() {
    return document.querySelector("#movie_player video.html5-main-video")
      || document.querySelector(".html5-video-player video");
  }

  function findCueIndex(cues, mediaTime) {
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const cue = cues[middle];
      if (mediaTime < cue.start) high = middle - 1;
      else if (mediaTime >= cue.end) low = middle + 1;
      else return middle;
    }
    return -1;
  }

  async function fetchJsonWithRetry(url) {
    const response = await fetchWithRetry(url);
    return response.json();
  }

  async function fetchWithRetry(url) {
    let lastError;
    for (const waitMs of [0, 250, 1000]) {
      if (waitMs) await delay(waitMs);
      try {
        const response = await fetch(url, { cache: "force-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Не удалось загрузить ассет: ${lastError?.message || lastError}`);
  }

  function waitForMedia(video, eventName) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ready = () => {
        cleanup();
        resolve();
      };
      const error = () => {
        cleanup();
        reject(new Error(`Ошибка загрузки WebM (${video.error?.code || "unknown"})`));
      };
      const cleanup = () => {
        video.removeEventListener(eventName, ready);
        video.removeEventListener("error", error);
      };
      video.addEventListener(eventName, ready, { once: true });
      video.addEventListener("error", error, { once: true });
    });
  }

  function waitForSeek(video) {
    if (!video.seeking) return Promise.resolve();
    return Promise.race([
      new Promise((resolve) => video.addEventListener("seeked", resolve, { once: true })),
      delay(1000)
    ]);
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function loadingStageLabel(stage) {
    return ({
      queued: "Анализ ожидает запуска",
      downloading: "Загрузка аудио",
      analyzing: "Анализ музыки",
      planning: "Построение хореографии",
      cached: "Загрузка готовой хореографии",
      complete: "Загрузка готовой хореографии",
      asset: "Загрузка видео с котами"
    })[stage] || "Загрузка хореографии";
  }

  function isYouTubeWatchUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return (
        url.protocol === "https:" &&
        url.hostname === "www.youtube.com" &&
        url.pathname === "/watch" &&
        /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "")
      );
    } catch {
      return false;
    }
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
      min-height: 64px; transform: translate(-50%, -50%); pointer-events: auto;
      cursor: grab; user-select: none; touch-action: none; border: 1px dashed transparent;
    }
    .cat-box:hover, .cat-box:active { border-color: #fff9; }
    .cat-box:active { cursor: grabbing; }
    .cat-video {
      display: block; width: 100%; height: auto; pointer-events: none;
      transform: scaleX(1); transform-origin: center;
    }
    .cat-video.mirrored { transform: scaleX(-1); }
    .spinner {
      width: 46px; height: 46px; margin: 16px auto; border: 5px solid #ffffff44;
      border-top-color: #fff; border-radius: 50%; animation: spin 800ms linear infinite;
      background: #0005; box-shadow: 0 0 0 3px #0006, 0 2px 8px #000b;
      filter: drop-shadow(0 2px 3px #0008); pointer-events: none;
    }
    .error-mark {
      width: 52px; height: 52px; margin: 12px auto; border-radius: 50%;
      background: #b91c1c; color: #fff; font: 700 38px/52px sans-serif;
      text-align: center; box-shadow: 0 2px 6px #0009; pointer-events: none;
    }
    .resize-handle {
      position: absolute; right: -8px; bottom: -8px; width: 18px; height: 18px;
      padding: 0; border: 2px solid #fff; border-radius: 50%; background: #f59e0b;
      box-shadow: 0 1px 4px #000b; cursor: nwse-resize; opacity: 0;
      pointer-events: auto; touch-action: none;
    }
    .mirror-button {
      position: absolute; left: -8px; top: -8px; z-index: 2;
      width: 30px; height: 30px; padding: 0;
      border: 1px solid #fff; border-radius: 50%; background: #111b;
      color: #fff; font: 700 12px/28px monospace; letter-spacing: -1px;
      box-shadow: 0 1px 4px #000b; cursor: pointer; opacity: 0;
      pointer-events: auto; touch-action: manipulation;
    }
    .cat-box:hover .mirror-button, .mirror-button:focus-visible, .mirror-button:active {
      opacity: 1;
    }
    .mirror-button:hover, .mirror-button:focus-visible { background: #222e; }
    .mirror-button.active { color: #111; background: #f59e0b; }
    .cat-box:hover .resize-handle, .resize-handle:active { opacity: 1; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  const controller = new DancingCatsController();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.ENABLE_OVERLAY) void controller.enable(message.youtubeUrl);
    else if (message?.type === MESSAGE.DISABLE_OVERLAY) controller.disable();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[LAYOUT_KEY]) return;
    controller.layout = sanitizeLayout(changes[LAYOUT_KEY].newValue);
    controller.applyLayout();
  });
  chrome.runtime.sendMessage({ type: MESSAGE.CONTENT_READY }).catch(() => {});
})();
