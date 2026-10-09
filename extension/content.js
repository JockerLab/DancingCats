(() => {
  "use strict";

  const { MESSAGE, DEFAULT_LAYOUT, clamp, sanitizeLayout } = DancingCatsShared;
  const LEGACY_LAYOUT_KEY = "layout";
  const LAYERS_KEY = "layers-v1";
  const POLL_INTERVAL_MS = 1000;
  const MIN_PLAYBACK_RATE = 0.25;
  const MAX_PLAYBACK_RATE = 4;
  const HARD_SEEK_THRESHOLD_SECONDS = 0.35;
  const FRAME_TOLERANCE_SECONDS = 1 / 30;

  class DancingCatsController {
    constructor() {
      this.enabled = false;
      this.mainVideo = null;
      this.playerAbort = null;
      this.host = null;
      this.shadow = null;
      this.layersRoot = null;
      this.addButton = null;
      this.assetMenu = null;
      this.layers = [];
      this.nextLayerId = 1;
      this.catalog = null;
      this.catalogPromise = null;
      this.motionMapPromises = new Map();
      this.assetResources = new Map();
      this.assetStates = new Map();
      this.analysisUrl = null;
      this.analysisToken = 0;
      this.animationFrame = null;
      this.attachScheduled = false;
      this.lastReportedStatus = null;
      this.hasStoredLayers = false;
      this.storedLayerConfigs = [];
      this.legacyLayout = null;
      this.observer = new MutationObserver(() => this.scheduleAttach());
      this.storagePromise = this.loadStoredLayers();
    }

    async loadStoredLayers() {
      const stored = await chrome.storage.local.get([LAYERS_KEY, LEGACY_LAYOUT_KEY]);
      if (Array.isArray(stored[LAYERS_KEY])) {
        this.hasStoredLayers = true;
        this.storedLayerConfigs = stored[LAYERS_KEY]
          .filter((item) => item && typeof item.assetId === "string")
          .map((item) => ({ assetId: item.assetId, layout: sanitizeLayout(item.layout) }));
      } else {
        this.legacyLayout = sanitizeLayout(stored[LEGACY_LAYOUT_KEY]);
      }
    }

    async enable(youtubeUrl = location.href) {
      if (!isYouTubeWatchUrl(youtubeUrl)) return;
      if (!this.enabled) {
        this.enabled = true;
        this.observer.observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener("yt-navigate-finish", this.onYouTubeNavigate);
        this.attach();
        this.animationFrame = requestAnimationFrame(this.animate);
        try {
          await Promise.all([this.storagePromise, this.loadCatalog()]);
          if (!this.enabled) return;
          this.attach();
          this.restoreLayers();
          this.populateAssetMenu();
        } catch (error) {
          this.showGlobalError(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      if (this.analysisUrl !== youtubeUrl) void this.startAnalyses(youtubeUrl);
      else if (!this.layers.length) this.reportState("ready");
    }

    disable() {
      this.enabled = false;
      this.analysisToken += 1;
      this.analysisUrl = null;
      this.assetStates.clear();
      this.observer.disconnect();
      window.removeEventListener("yt-navigate-finish", this.onYouTubeNavigate);
      this.detachPlayer();
      if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      for (const layer of this.layers) layer.video.pause();
      this.layers = [];
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.layersRoot = null;
      this.addButton = null;
      this.assetMenu = null;
      this.lastReportedStatus = null;
    }

    restoreLayers() {
      if (this.layers.length || !this.catalog) return;
      const knownAssets = new Set(this.catalog.assets.map((asset) => asset.id));
      if (this.hasStoredLayers) {
        for (const config of this.storedLayerConfigs) {
          if (knownAssets.has(config.assetId)) this.createLayer(config.assetId, config.layout);
        }
        return;
      }
      this.createLayer(this.catalog.defaultAssetId, this.legacyLayout || DEFAULT_LAYOUT);
      void this.saveLayers();
    }

    async loadCatalog() {
      if (!this.catalogPromise) {
        this.catalogPromise = fetchJsonWithRetry(chrome.runtime.getURL("assets/catalog.json"))
          .then((catalog) => {
            if (!Array.isArray(catalog.assets) || !catalog.assets.length) {
              throw new Error("Каталог ассетов пуст");
            }
            this.catalog = catalog;
            return catalog;
          })
          .catch((error) => {
            this.catalogPromise = null;
            throw error;
          });
      }
      return this.catalogPromise;
    }

    descriptorFor(assetId) {
      return this.catalog?.assets.find((asset) => asset.id === assetId) || null;
    }

    async loadMotionMap(descriptor) {
      if (!this.motionMapPromises.has(descriptor.id)) {
        const catalogUrl = chrome.runtime.getURL("assets/catalog.json");
        const mapUrl = new URL(descriptor.motionMap, catalogUrl).href;
        const promise = fetchJsonWithRetry(mapUrl)
          .then((motionMap) => ({ motionMap, mapUrl }))
          .catch((error) => {
            this.motionMapPromises.delete(descriptor.id);
            throw error;
          });
        this.motionMapPromises.set(descriptor.id, promise);
      }
      return this.motionMapPromises.get(descriptor.id);
    }

    async loadAssetResources(assetId) {
      if (!this.assetResources.has(assetId)) {
        const promise = this.fetchAssetResources(assetId).catch((error) => {
          this.assetResources.delete(assetId);
          throw error;
        });
        this.assetResources.set(assetId, promise);
      }
      return this.assetResources.get(assetId);
    }

    async fetchAssetResources(assetId) {
      await this.loadCatalog();
      const descriptor = this.descriptorFor(assetId);
      if (!descriptor) throw new Error(`Ассет ${assetId} отсутствует в каталоге`);
      const { motionMap, mapUrl } = await this.loadMotionMap(descriptor);
      const videoUrl = new URL(motionMap.video, mapUrl).href;
      const response = await fetchWithRetry(videoUrl);
      const videoBlob = await response.blob();
      if (!videoBlob.size) throw new Error(`Видеоассет ${descriptor.name || assetId} пуст`);
      return { motionMap, videoBlobUrl: URL.createObjectURL(videoBlob) };
    }

    async startAnalyses(youtubeUrl) {
      const token = ++this.analysisToken;
      this.analysisUrl = youtubeUrl;
      this.assetStates.clear();
      for (const layer of this.layers) {
        layer.ready = false;
        layer.lastCueIndex = null;
        layer.video.pause();
        this.setLayerVisual(layer, "loading", "queued");
      }
      this.reportState("loading");
      const assetIds = this.catalog.assets.map((asset) => asset.id);
      for (const assetId of assetIds) {
        this.assetStates.set(assetId, {
          assetId,
          url: youtubeUrl,
          status: "loading",
          choreography: null,
          resources: null,
          resourcePromise: null,
          error: null,
          promise: null
        });
      }
      const batchPromise = this.runCatalogAnalysis(assetIds, token);
      for (const state of this.assetStates.values()) {
        state.promise = batchPromise.then(() => state);
      }
      await batchPromise;
      if (this.isCurrentAnalysis(token)) this.refreshReportedState();
    }

    async ensureAssetAnalysis(assetId, token = this.analysisToken) {
      let state = this.assetStates.get(assetId);
      if (!state || state.url !== this.analysisUrl) {
        await this.startAnalyses(this.analysisUrl);
        state = this.assetStates.get(assetId);
      }
      if (state?.status === "loading" && state.promise) await state.promise;
      if (state?.status === "ready") await this.prepareAssetState(state, token);
      return state;
    }

    async runCatalogAnalysis(assetIds, token) {
      try {
        let response = await chrome.runtime.sendMessage({
          type: MESSAGE.START_ANALYSIS,
          youtubeUrl: this.analysisUrl,
          assetIds
        });
        if (!response?.ok) throw new Error(response?.error || "Не удалось запустить анализ");
        let job = response.data;
        for (const assetId of assetIds) {
          this.setAssetVisual(assetId, "loading", job.stage || job.status);
        }
        while (job.status === "queued" || job.status === "running") {
          await delay(POLL_INTERVAL_MS);
          if (!this.isCurrentAnalysis(token)) return;
          response = await chrome.runtime.sendMessage({
            type: MESSAGE.GET_ANALYSIS,
            jobId: job.jobId
          });
          if (!response?.ok) throw new Error(response?.error || "Не удалось получить анализ");
          job = response.data;
          for (const assetId of assetIds) {
            this.setAssetVisual(assetId, "loading", job.stage || job.status);
          }
        }
        if (job.status === "complete" && !job.choreographies) {
          response = await chrome.runtime.sendMessage({
            type: MESSAGE.GET_ANALYSIS,
            jobId: job.jobId
          });
          if (!response?.ok) throw new Error(response?.error || "Не удалось загрузить карту");
          job = response.data;
        }
        if (!this.isCurrentAnalysis(token)) return;
        if (job.status !== "complete" || !job.choreographies) {
          throw new Error(job.error || "Backend не сформировал хореографию");
        }
        for (const assetId of assetIds) {
          const state = this.assetStates.get(assetId);
          const choreography = job.choreographies[assetId];
          if (!state) continue;
          if (!choreography?.cues?.length) {
            state.status = "error";
            state.error = `Backend не сформировал хореографию для ${assetId}`;
            this.setAssetVisual(assetId, "error", "error", state.error);
            continue;
          }
          state.status = "ready";
          state.choreography = choreography;
        }
        const activeIds = [...new Set(this.layers.map((layer) => layer.assetId))];
        await Promise.all(activeIds.map(async (assetId) => {
          const state = this.assetStates.get(assetId);
          if (state?.status === "ready") await this.prepareAssetState(state, token);
        }));
      } catch (error) {
        if (!this.isCurrentAnalysis(token)) return;
        const message = error instanceof Error ? error.message : String(error);
        for (const assetId of assetIds) {
          const state = this.assetStates.get(assetId);
          if (!state || state.status === "error") continue;
          state.status = "error";
          state.error = message;
          this.setAssetVisual(assetId, "error", "error", message);
        }
      }
      this.refreshReportedState();
    }

    async prepareAssetState(state, token) {
      if (state.status !== "ready") return state;
      try {
        if (!state.resources) {
          this.setAssetVisual(state.assetId, "loading", "asset");
          if (!state.resourcePromise) {
            state.resourcePromise = this.loadAssetResources(state.assetId);
          }
          state.resources = await state.resourcePromise;
        }
        if (!this.isCurrentAnalysis(token)) return state;
        await this.prepareMatchingLayers(state, token);
      } catch (error) {
        if (!this.isCurrentAnalysis(token)) return state;
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        this.setAssetVisual(state.assetId, "error", "error", state.error);
      }
      return state;
    }

    isCurrentAnalysis(token) {
      return this.enabled && token === this.analysisToken;
    }

    async prepareMatchingLayers(state, token) {
      const layers = this.layers.filter((layer) => layer.assetId === state.assetId && !layer.ready);
      await Promise.all(layers.map((layer) => this.prepareLayerVideo(layer, state, token)));
    }

    async prepareLayerVideo(layer, state, token) {
      if (!layer.box.isConnected || state.status !== "ready") return;
      const loadToken = ++layer.loadToken;
      const { video } = layer;
      try {
        if (video.src !== state.resources.videoBlobUrl) {
          video.src = state.resources.videoBlobUrl;
          video.load();
          await waitForMedia(video, "loadeddata");
        }
        if (!this.isCurrentAnalysis(token) || loadToken !== layer.loadToken || !this.layers.includes(layer)) {
          return;
        }
        layer.lastCueIndex = null;
        const sample = this.sampleChoreography(layer, state, this.mainVideo?.currentTime ?? 0);
        video.currentTime = clamp(
          sample.sourceTime,
          0,
          Math.max(0, Number(state.resources.motionMap.duration) - 1 / 30)
        );
        await waitForSeek(video);
        if (loadToken !== layer.loadToken || !this.layers.includes(layer)) return;
        layer.ready = true;
        this.setLayerVisual(layer, "ready", "complete");
        this.renderLayerFrame(layer);
      } catch (error) {
        if (!this.layers.includes(layer)) return;
        layer.ready = false;
        this.setLayerVisual(layer, "error", "error", error instanceof Error ? error.message : String(error));
      }
      this.refreshReportedState();
    }

    onYouTubeNavigate = () => {
      const youtubeUrl = location.href;
      if (!isYouTubeWatchUrl(youtubeUrl)) {
        this.disable();
        return;
      }
      this.closeAssetMenu();
      this.detachPlayer();
      this.scheduleAttach();
      void this.startAnalyses(youtubeUrl);
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
      video.addEventListener("play", () => {
        for (const layer of this.layers) this.playLayer(layer);
      }, { signal });
      video.addEventListener("pause", () => {
        for (const layer of this.layers) layer.video.pause();
      }, { signal });
      video.addEventListener("seeking", () => this.renderAllLayers(), { signal });
      video.addEventListener("seeked", () => this.renderAllLayers(), { signal });
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
          <div class="layers"></div>
          <div class="asset-picker">
            <button class="add-layer-button" type="button" title="Добавить слой с котами"
              aria-label="Добавить слой с котами" aria-expanded="false">+</button>
            <div class="asset-menu" role="menu" hidden></div>
          </div>
          <div class="global-error" role="alert" hidden>!</div>
        </div>`;
      this.layersRoot = this.shadow.querySelector(".layers");
      this.addButton = this.shadow.querySelector(".add-layer-button");
      this.assetMenu = this.shadow.querySelector(".asset-menu");
      this.addButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const open = this.assetMenu.hidden;
        this.assetMenu.hidden = !open;
        this.addButton.setAttribute("aria-expanded", String(open));
      });
      this.shadow.addEventListener("pointerdown", (event) => {
        if (!event.target.closest(".asset-picker")) this.closeAssetMenu();
      });
      this.shadow.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.closeAssetMenu();
          this.addButton.focus();
        }
      });
      if (this.catalog) this.populateAssetMenu();
    }

    populateAssetMenu() {
      if (!this.assetMenu || !this.catalog) return;
      this.assetMenu.replaceChildren();
      for (const descriptor of this.catalog.assets) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "asset-option";
        item.setAttribute("role", "menuitem");
        item.innerHTML = `
          <span class="asset-preview-wrap">
            <video class="asset-preview" muted playsinline preload="metadata"></video>
            <span class="asset-preview-error" hidden>!</span>
          </span>
          <span class="asset-name"></span>`;
        item.querySelector(".asset-name").textContent = descriptor.name || descriptor.id;
        item.addEventListener("click", () => {
          this.closeAssetMenu();
          void this.addLayer(descriptor.id);
        });
        this.assetMenu.append(item);
        void this.loadAssetPreview(descriptor, item);
      }
    }

    async loadAssetPreview(descriptor, item) {
      const preview = item.querySelector(".asset-preview");
      const errorMark = item.querySelector(".asset-preview-error");
      try {
        const { motionMap, mapUrl } = await this.loadMotionMap(descriptor);
        if (!item.isConnected) return;
        preview.src = new URL(motionMap.video, mapUrl).href;
        preview.load();
        await waitForMedia(preview, "loadeddata");
        preview.currentTime = 0;
      } catch {
        if (!item.isConnected) return;
        preview.hidden = true;
        errorMark.hidden = false;
      }
    }

    closeAssetMenu() {
      if (!this.assetMenu) return;
      this.assetMenu.hidden = true;
      this.addButton?.setAttribute("aria-expanded", "false");
    }

    async addLayer(assetId) {
      if (!this.descriptorFor(assetId)) return;
      const ordinal = this.layers.length;
      const layout = sanitizeLayout({
        ...DEFAULT_LAYOUT,
        x: DEFAULT_LAYOUT.x + (ordinal % 4) * 0.05,
        y: DEFAULT_LAYOUT.y - (ordinal % 3) * 0.05
      });
      const layer = this.createLayer(assetId, layout);
      await this.saveLayers();
      if (!this.analysisUrl) return;
      this.reportState("loading");
      const state = await this.ensureAssetAnalysis(assetId);
      if (state?.status === "ready" && !layer.ready) {
        await this.prepareLayerVideo(layer, state, this.analysisToken);
      }
      this.refreshReportedState();
    }

    createLayer(assetId, rawLayout) {
      if (!this.layersRoot) return null;
      const box = document.createElement("div");
      box.className = "cat-box";
      box.title = "Перетащите слой мышкой";
      box.innerHTML = `
        <video class="cat-video" muted playsinline preload="auto" hidden></video>
        <div class="spinner" role="status" aria-label="Загрузка хореографии"></div>
        <div class="error-mark" role="alert" hidden>!</div>
        <button class="mirror-button" type="button" hidden
          title="Отразить котов по вертикали" aria-label="Отразить котов по вертикали"
          aria-pressed="false">]|[</button>
        <button class="remove-button" type="button" hidden
          title="Удалить слой" aria-label="Удалить слой">×</button>
        <button class="resize-handle" type="button" hidden
          title="Изменить размер" aria-label="Изменить размер"></button>`;
      this.layersRoot.append(box);
      const layer = {
        id: this.nextLayerId++, assetId, layout: sanitizeLayout(rawLayout), box,
        video: box.querySelector(".cat-video"),
        spinner: box.querySelector(".spinner"),
        errorMark: box.querySelector(".error-mark"),
        mirrorButton: box.querySelector(".mirror-button"),
        removeButton: box.querySelector(".remove-button"),
        resizeHandle: box.querySelector(".resize-handle"),
        visualState: { kind: "loading", stage: "queued", message: "" },
        ready: false, lastCueIndex: null, loadToken: 0
      };
      this.layers.push(layer);
      layer.video.addEventListener("error", () => {
        if (!this.layers.includes(layer)) return;
        const code = layer.video.error?.code;
        layer.ready = false;
        this.setLayerVisual(layer, "error", "error", `Ошибка декодирования видеоассета${code ? ` (${code})` : ""}`);
        this.refreshReportedState();
      });
      layer.video.addEventListener("seeked", () => this.renderLayerFrame(layer));
      this.installLayerDragging(layer);
      this.installLayerMirroring(layer);
      this.installLayerRemoval(layer);
      this.installLayerResizing(layer);
      this.applyLayerLayout(layer);
      this.applyLayerVisual(layer);
      return layer;
    }

    installLayerDragging(layer) {
      layer.box.addEventListener("pointerdown", (event) => {
        if (event.target.closest("button") || event.button !== 0) return;
        event.preventDefault();
        layer.box.setPointerCapture(event.pointerId);
        const bounds = this.host.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const initialX = layer.layout.x;
        const initialY = layer.layout.y;
        const move = (moveEvent) => {
          if (!bounds.width || !bounds.height) return;
          layer.layout = sanitizeLayout({
            ...layer.layout,
            x: initialX + (moveEvent.clientX - startX) / bounds.width,
            y: initialY + (moveEvent.clientY - startY) / bounds.height
          });
          this.applyLayerLayout(layer);
        };
        const end = () => {
          layer.box.removeEventListener("pointermove", move);
          layer.box.removeEventListener("pointerup", end);
          layer.box.removeEventListener("pointercancel", end);
          void this.saveLayers();
        };
        layer.box.addEventListener("pointermove", move);
        layer.box.addEventListener("pointerup", end);
        layer.box.addEventListener("pointercancel", end);
      });
    }

    installLayerMirroring(layer) {
      layer.mirrorButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        layer.layout = sanitizeLayout({ ...layer.layout, mirrored: !layer.layout.mirrored });
        this.applyLayerLayout(layer);
        void this.saveLayers();
      });
    }

    installLayerRemoval(layer) {
      layer.removeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.removeLayer(layer);
      });
    }

    removeLayer(layer) {
      const index = this.layers.indexOf(layer);
      if (index < 0) return;
      layer.loadToken += 1;
      layer.video.pause();
      layer.box.remove();
      this.layers.splice(index, 1);
      void this.saveLayers();
      this.refreshReportedState();
    }

    installLayerResizing(layer) {
      layer.resizeHandle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        layer.resizeHandle.setPointerCapture(event.pointerId);
        const hostBounds = this.host.getBoundingClientRect();
        const startX = event.clientX;
        const startWidth = layer.box.getBoundingClientRect().width;
        const move = (moveEvent) => {
          if (!hostBounds.width) return;
          layer.layout = sanitizeLayout({
            ...layer.layout,
            scale: (startWidth + (moveEvent.clientX - startX) * 2) / hostBounds.width
          });
          this.applyLayerLayout(layer);
        };
        const end = () => {
          layer.resizeHandle.removeEventListener("pointermove", move);
          layer.resizeHandle.removeEventListener("pointerup", end);
          layer.resizeHandle.removeEventListener("pointercancel", end);
          void this.saveLayers();
        };
        layer.resizeHandle.addEventListener("pointermove", move);
        layer.resizeHandle.addEventListener("pointerup", end);
        layer.resizeHandle.addEventListener("pointercancel", end);
      });
    }

    applyLayerLayout(layer) {
      layer.box.style.left = `${layer.layout.x * 100}%`;
      layer.box.style.top = `${layer.layout.y * 100}%`;
      layer.box.style.width = `${layer.layout.scale * 100}%`;
      layer.video.classList.toggle("mirrored", layer.layout.mirrored);
      layer.mirrorButton.classList.toggle("active", layer.layout.mirrored);
      layer.mirrorButton.setAttribute("aria-pressed", String(layer.layout.mirrored));
    }

    setAssetVisual(assetId, kind, stage, message = "") {
      for (const layer of this.layers) {
        if (layer.assetId === assetId) this.setLayerVisual(layer, kind, stage, message);
      }
    }

    setLayerVisual(layer, kind, stage, message = "") {
      layer.visualState = { kind, stage, message };
      this.applyLayerVisual(layer);
    }

    applyLayerVisual(layer) {
      const { kind, stage, message } = layer.visualState;
      if (kind !== "ready") layer.video.pause();
      layer.video.hidden = kind !== "ready";
      const label = loadingStageLabel(stage);
      layer.spinner.hidden = kind !== "loading";
      layer.spinner.title = label;
      layer.spinner.setAttribute("aria-label", label);
      layer.errorMark.hidden = kind !== "error";
      layer.errorMark.title = message;
      layer.mirrorButton.hidden = kind !== "ready";
      layer.removeButton.hidden = false;
      layer.resizeHandle.hidden = kind !== "ready";
    }

    showGlobalError(message) {
      if (!this.shadow) this.attach();
      const error = this.shadow?.querySelector(".global-error");
      if (error) {
        error.hidden = false;
        error.title = message;
      }
      this.reportState("error");
    }

    refreshReportedState() {
      if (!this.layers.length) return this.reportState("ready");
      if (this.layers.some((layer) => layer.visualState.kind === "error")) {
        this.reportState("error");
      } else if (this.layers.some((layer) => !layer.ready)) {
        this.reportState("loading");
      } else {
        this.reportState("ready");
      }
    }

    reportState(status) {
      if (status === this.lastReportedStatus) return;
      this.lastReportedStatus = status;
      chrome.runtime.sendMessage({ type: MESSAGE.ANALYSIS_STATE, status }).catch(() => {});
    }

    animate = () => {
      if (!this.enabled) return;
      this.animationFrame = requestAnimationFrame(this.animate);
      if (!this.mainVideo?.isConnected) {
        this.scheduleAttach();
        return;
      }
      if (this.mainVideo.paused || this.mainVideo.seeking) {
        for (const layer of this.layers) layer.video.pause();
        return;
      }
      this.renderAllLayers();
    };

    renderAllLayers() {
      for (const layer of this.layers) this.renderLayerFrame(layer);
    }

    renderLayerFrame(layer) {
      if (!layer.ready || !this.mainVideo || !this.layers.includes(layer)) return;
      const state = this.assetStates.get(layer.assetId);
      if (!state?.choreography || !state.resources) return;
      const sample = this.sampleChoreography(layer, state, this.mainVideo.currentTime);
      const limit = Math.max(0, Number(state.resources.motionMap.duration) - 1 / 30);
      const desiredTime = clamp(sample.sourceTime, 0, limit);
      const error = desiredTime - layer.video.currentTime;
      if (layer.video.seeking) return;
      const transitionNeedsSeek = sample.cueChanged && Math.abs(error) > FRAME_TOLERANCE_SECONDS;
      const mainSeekNeedsSync = this.mainVideo.seeking && Math.abs(error) > FRAME_TOLERANCE_SECONDS;
      if (transitionNeedsSeek || mainSeekNeedsSync || Math.abs(error) > HARD_SEEK_THRESHOLD_SECONDS) {
        layer.video.pause();
        layer.video.currentTime = desiredTime;
        return;
      }
      if (!sample.active) {
        layer.video.pause();
        return;
      }
      const correction = clamp(1 + error * 0.12, 0.94, 1.06);
      layer.video.playbackRate = clamp(
        sample.playbackRate * this.mainVideo.playbackRate * correction,
        MIN_PLAYBACK_RATE,
        MAX_PLAYBACK_RATE
      );
      this.playLayer(layer);
    }

    sampleChoreography(layer, state, mediaTime) {
      const cues = state.choreography.cues;
      if (mediaTime < cues[0].start) {
        layer.lastCueIndex = -1;
        return { active: false, cueChanged: false, sourceTime: cues[0].sourceStart, playbackRate: 1 };
      }
      const cueIndex = findCueIndex(cues, mediaTime);
      if (cueIndex < 0) {
        const lastCue = cues.at(-1);
        layer.lastCueIndex = cues.length;
        return { active: false, cueChanged: false, sourceTime: lastCue.sourceEnd - 1 / 30, playbackRate: 1 };
      }
      const cue = cues[cueIndex];
      const progress = clamp((mediaTime - cue.start) / Math.max(1e-6, cue.end - cue.start), 0, 1);
      const cueChanged = cueIndex !== layer.lastCueIndex;
      layer.lastCueIndex = cueIndex;
      return {
        active: true,
        cueChanged,
        sourceTime: cue.sourceStart + (cue.sourceEnd - cue.sourceStart) * progress,
        playbackRate: Number(cue.playbackRate) || 1
      };
    }

    playLayer(layer) {
      if (!layer.ready || this.mainVideo?.paused || this.mainVideo?.seeking || layer.video.seeking || !layer.video.paused) {
        return;
      }
      layer.video.play().catch((error) => {
        if (error?.name === "AbortError" || !this.layers.includes(layer)) return;
        layer.ready = false;
        this.setLayerVisual(layer, "error", "error", error instanceof Error ? error.message : String(error));
        this.refreshReportedState();
      });
    }

    async saveLayers() {
      const configs = this.layers.map((layer) => ({ assetId: layer.assetId, layout: layer.layout }));
      this.hasStoredLayers = true;
      this.storedLayerConfigs = configs;
      await chrome.storage.local.set({ [LAYERS_KEY]: configs });
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
      const ready = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); reject(new Error(`Ошибка загрузки WebM (${video.error?.code || "unknown"})`)); };
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
      return url.protocol === "https:"
        && url.hostname === "www.youtube.com"
        && url.pathname === "/watch"
        && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get("v") || "");
    } catch {
      return false;
    }
  }

  const OVERLAY_STYLES = `
    :host { position: absolute; inset: 0; z-index: 48; display: block; pointer-events: none; overflow: hidden; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    button { font-family: Arial, sans-serif; }
    .root, .layers { position: absolute; inset: 0; pointer-events: none; }
    .cat-box {
      position: absolute; min-height: 64px; transform: translate(-50%, -50%);
      pointer-events: auto; cursor: grab; user-select: none; touch-action: none;
      border: 1px dashed transparent;
    }
    .cat-box:hover, .cat-box:active { border-color: #fff9; }
    .cat-box:active { cursor: grabbing; }
    .cat-video { display: block; width: 100%; height: auto; pointer-events: none; transform: scaleX(1); transform-origin: center; }
    .cat-video.mirrored { transform: scaleX(-1); }
    .spinner {
      width: 46px; height: 46px; margin: 16px auto; border: 5px solid #ffffff44;
      border-top-color: #fff; border-radius: 50%; animation: spin 800ms linear infinite;
      background: #0005; box-shadow: 0 0 0 3px #0006, 0 2px 8px #000b;
      filter: drop-shadow(0 2px 3px #0008); pointer-events: none;
    }
    .error-mark, .global-error {
      width: 52px; height: 52px; border-radius: 50%; background: #b91c1c; color: #fff;
      font: 700 38px/52px Arial, sans-serif; text-align: center; box-shadow: 0 2px 6px #0009; pointer-events: none;
    }
    .error-mark { margin: 12px auto; }
    .global-error { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
    .mirror-button, .remove-button {
      position: absolute; top: -8px; z-index: 2; width: 30px; height: 30px; padding: 0;
      border: 1px solid #fff; border-radius: 50%; background: #111b; color: #fff;
      box-shadow: 0 1px 4px #000b; cursor: pointer; opacity: 0; pointer-events: auto; touch-action: manipulation;
    }
    .mirror-button { left: -8px; font: 700 12px/28px monospace; letter-spacing: -1px; }
    .remove-button { right: -8px; font: 400 24px/27px Arial, sans-serif; background: #991b1bcc; }
    .cat-box:hover .mirror-button, .cat-box:hover .remove-button,
    .mirror-button:focus-visible, .mirror-button:active,
    .remove-button:focus-visible, .remove-button:active { opacity: 1; }
    .mirror-button:hover, .mirror-button:focus-visible { background: #222e; }
    .mirror-button.active { color: #111; background: #f59e0b; }
    .remove-button:hover, .remove-button:focus-visible { background: #dc2626; }
    .resize-handle {
      position: absolute; right: -8px; bottom: -8px; width: 18px; height: 18px; padding: 0;
      border: 2px solid #fff; border-radius: 50%; background: #f59e0b; box-shadow: 0 1px 4px #000b;
      cursor: nwse-resize; opacity: 0; pointer-events: auto; touch-action: none;
    }
    .cat-box:hover .resize-handle, .resize-handle:active { opacity: 1; }
    .asset-picker { position: absolute; top: 12px; right: 12px; z-index: 10; pointer-events: auto; }
    .add-layer-button {
      display: block; margin-left: auto; width: 38px; height: 38px; padding: 0;
      border: 1px solid #fff; border-radius: 50%; background: #111c; color: #fff;
      font: 400 30px/34px Arial, sans-serif; box-shadow: 0 2px 8px #000a; cursor: pointer;
    }
    .add-layer-button:hover, .add-layer-button:focus-visible,
    .add-layer-button[aria-expanded="true"] { background: #f59e0b; color: #111; }
    .asset-menu {
      width: min(280px, calc(100vw - 32px)); max-height: min(420px, calc(100vh - 70px));
      margin-top: 8px; padding: 6px; overflow: auto; border: 1px solid #ffffff55;
      border-radius: 10px; background: #111e; box-shadow: 0 5px 18px #000c;
    }
    .asset-option {
      display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: 10px;
      width: 100%; min-height: 74px; padding: 5px; border: 0; border-radius: 7px;
      background: transparent; color: #fff; text-align: left; cursor: pointer;
    }
    .asset-option:hover, .asset-option:focus-visible { background: #ffffff1f; outline: none; }
    .asset-preview-wrap {
      position: relative; display: grid; place-items: center; width: 72px; height: 64px;
      overflow: hidden; border-radius: 6px; background-color: #333;
      background-image: linear-gradient(45deg, #444 25%, transparent 25%),
        linear-gradient(-45deg, #444 25%, transparent 25%),
        linear-gradient(45deg, transparent 75%, #444 75%),
        linear-gradient(-45deg, transparent 75%, #444 75%);
      background-size: 12px 12px; background-position: 0 0, 0 6px, 6px -6px, -6px 0;
    }
    .asset-preview { width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
    .asset-preview-error { color: #f87171; font: 700 28px/1 Arial, sans-serif; }
    .asset-name { font-size: 14px; line-height: 1.3; overflow-wrap: anywhere; }
    @keyframes spin { to { transform: rotate(360deg); } }
  `;

  const controller = new DancingCatsController();
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.ENABLE_OVERLAY) void controller.enable(message.youtubeUrl);
    else if (message?.type === MESSAGE.DISABLE_OVERLAY) controller.disable();
  });
  chrome.runtime.sendMessage({ type: MESSAGE.CONTENT_READY }).catch(() => {});
})();
