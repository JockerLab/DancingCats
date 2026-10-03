(() => {
  "use strict";

  const { MESSAGE, DEFAULT_LAYOUT, clamp, sanitizeLayout } = DancingCatsShared;
  const LAYOUT_KEY = "layout";

  class BeatClock {
    constructor() {
      this.reset();
    }

    reset() {
      this.position = 0;
      this.periodMs = null;
      this.lastNowMs = null;
      this.locked = false;
    }

    update(state, nowMs) {
      if (!state?.beatPeriodMs || state.lastBeatTimeMs == null || state.confidence < 0.24) return;
      if (this.locked) this.advance(nowMs);
      const phase = (nowMs - state.lastBeatTimeMs) / state.beatPeriodMs;
      if (!this.locked) {
        this.position = positiveModulo(phase, 1);
        this.locked = true;
      } else {
        const targetFraction = positiveModulo(phase, 1);
        const currentFraction = positiveModulo(this.position, 1);
        const phaseError = wrappedUnitDifference(targetFraction, currentFraction);
        this.position += phaseError * 0.2;
      }
      this.periodMs = this.periodMs == null
        ? state.beatPeriodMs
        : this.periodMs * 0.82 + state.beatPeriodMs * 0.18;
      this.lastNowMs = nowMs;
    }

    positionAt(nowMs) {
      if (!this.locked || !this.periodMs) return null;
      this.advance(nowMs);
      return this.position;
    }

    advance(nowMs) {
      if (this.lastNowMs != null && this.periodMs) {
        this.position += (nowMs - this.lastNowMs) / this.periodMs;
      }
      this.lastNowMs = nowMs;
    }
  }

  class MotionPlanner {
    constructor(motionMap) {
      this.map = motionMap;
      this.segments = new Map(motionMap.segments.map((segment) => [segment.id, segment]));
      this.reset();
    }

    reset() {
      this.segment = this.map.segments[0];
      this.segmentStartBeat = 0;
      this.transitionSerial = 0;
      this.activeTransition = null;
      this.lastBeat = null;
    }

    sample(unwrappedBeat, beatPeriodMs, musicEnergy) {
      if (this.lastBeat != null && unwrappedBeat < this.lastBeat - 0.5) this.reset();
      while (unwrappedBeat >= this.segmentStartBeat + this.segment.beats) {
        const previous = this.segment;
        this.segmentStartBeat += previous.beats;
        this.segment = this.chooseNext(previous, musicEnergy);
        this.transitionSerial += 1;
        const discontinuity = Math.abs(previous.sourceEnd - this.segment.sourceStart) > 0.05;
        this.activeTransition = discontinuity ? {
          key: this.transitionSerial,
          startBeat: this.segmentStartBeat,
          fromTime: previous.sourceEnd
        } : null;
      }
      this.lastBeat = unwrappedBeat;

      const localBeat = clamp(unwrappedBeat - this.segmentStartBeat, 0, this.segment.beats);
      const anchors = this.segment.anchors;
      let left = anchors[0];
      let right = anchors.at(-1);
      for (let index = 1; index < anchors.length; index += 1) {
        if (localBeat <= anchors[index].beat) {
          left = anchors[index - 1];
          right = anchors[index];
          break;
        }
      }
      const beatSpan = Math.max(1e-6, right.beat - left.beat);
      const progress = clamp((localBeat - left.beat) / beatSpan, 0, 1);
      const sourceTime = left.time + (right.time - left.time) * progress;
      const musicSeconds = beatSpan * beatPeriodMs / 1000;
      const playbackRate = (right.time - left.time) / Math.max(1e-6, musicSeconds);
      return {
        unwrappedBeat,
        localBeat,
        sourceTime,
        playbackRate,
        segment: this.segment,
        transitionSerial: this.transitionSerial,
        transition: this.activeTransition
      };
    }

    chooseNext(current, musicEnergy) {
      const allSegments = [...this.segments.values()];
      const candidates = allSegments.length > 1
        ? allSegments.filter((segment) => segment.id !== current.id)
        : allSegments;
      if (!candidates.length) return this.map.segments[0];
      const preferred = new Set(current.next ?? []);
      return candidates.sort((left, right) => {
        const score = (candidate) => {
          const energyCost = Math.abs(candidate.energy - musicEnergy) * 4;
          const transitionCost = preferred.has(candidate.id) ? 0 : 0.12;
          const poseCost = candidate.entryPose === current.exitPose ? 0 : 0.08;
          return energyCost + transitionCost + poseCost;
        };
        return score(left) - score(right) || left.id.localeCompare(right.id);
      })[0];
    }
  }

  class DancingCatsController {
    constructor() {
      this.enabled = false;
      this.layout = { ...DEFAULT_LAYOUT };
      this.mainVideo = null;
      this.playerAbort = null;
      this.host = null;
      this.shadow = null;
      this.box = null;
      this.primaryVideo = null;
      this.secondaryVideo = null;
      this.fallback = null;
      this.statusBadge = null;
      this.analysisStatus = { status: "starting", error: null };
      this.motionMap = null;
      this.motionPlanner = null;
      this.beatClock = new BeatClock();
      this.choreography = null;
      this.lastCueIndex = null;
      this.videoUrl = null;
      this.beatState = null;
      this.planOriginBeat = null;
      this.visibleTransitionKey = null;
      this.assetReady = false;
      this.attachScheduled = false;
      this.animationFrame = null;
      this.observer = new MutationObserver(() => this.scheduleAttach());
      this.resourcesPromise = Promise.all([this.loadLayout(), this.loadAsset()]);
    }

    async loadLayout() {
      const stored = await chrome.storage.local.get(LAYOUT_KEY);
      this.layout = sanitizeLayout(stored[LAYOUT_KEY]);
      this.applyLayout();
    }

    async loadAsset() {
      const catalogUrl = chrome.runtime.getURL("assets/catalog.json");
      const catalog = await fetchJson(catalogUrl);
      const descriptor = catalog.assets.find((asset) => asset.id === catalog.defaultAssetId);
      if (!descriptor) throw new Error("Default cat asset is missing from catalog");
      const mapUrl = new URL(descriptor.motionMap, catalogUrl).href;
      this.motionMap = await fetchJson(mapUrl);
      this.videoUrl = new URL(this.motionMap.video, mapUrl).href;
      this.motionPlanner = new MotionPlanner(this.motionMap);
    }

    async enable() {
      if (this.enabled) return;
      this.enabled = true;
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
      window.addEventListener("yt-navigate-finish", this.onYouTubeNavigate);
      try {
        await this.resourcesPromise;
      } catch {
        // The visual fallback remains available if catalog loading fails.
      }
      if (this.enabled) {
        this.attach();
        this.animationFrame = requestAnimationFrame(this.animate);
      }
    }

    disable() {
      this.enabled = false;
      this.observer.disconnect();
      window.removeEventListener("yt-navigate-finish", this.onYouTubeNavigate);
      this.detachPlayer();
      if (this.animationFrame != null) cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
      this.primaryVideo?.pause();
      this.secondaryVideo?.pause();
      this.host?.remove();
      this.host = null;
      this.shadow = null;
      this.box = null;
      this.primaryVideo = null;
      this.secondaryVideo = null;
      this.fallback = null;
      this.statusBadge = null;
      this.analysisStatus = { status: "starting", error: null };
      this.resetPlan();
    }

    receiveBeat(state) {
      if (!state) return;
      this.beatState = state;
      this.beatClock.update(state, wallClockNow());
    }

    receiveChoreography(choreography) {
      if (!choreography?.cues?.length) return;
      if (this.motionMap && choreography.assetId !== this.motionMap.id) return;
      this.choreography = choreography;
      this.lastCueIndex = null;
      this.planOriginBeat = null;
    }

    receiveAnalysisState(status, error) {
      this.analysisStatus = { status, error };
      if (!this.statusBadge) return;
      const labels = {
        submitting: "AI: отправка",
        queued: "AI: очередь",
        running: "AI: анализ",
        complete: "AI: карта готова",
        unavailable: "RT: backend недоступен"
      };
      this.statusBadge.textContent = labels[status] ?? String(status ?? "");
      this.statusBadge.dataset.state = status ?? "unknown";
      this.statusBadge.title = error || "";
    }

    showCaptureError() {
      void this.enable();
      this.resetPlan();
    }

    onYouTubeNavigate = () => {
      this.resetPlan();
      this.scheduleAttach();
      chrome.runtime.sendMessage({
        type: MESSAGE.RESET_ANALYSIS,
        youtubeUrl: location.href
      }).catch(() => {});
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
      const reset = () => {
        this.resetPlan(true);
        chrome.runtime.sendMessage({ type: MESSAGE.RESET_ANALYSIS }).catch(() => {});
      };
      video.addEventListener("play", () => this.playPrimary(), { signal });
      video.addEventListener("pause", () => this.pauseLayers(), { signal });
      video.addEventListener("seeking", reset, { signal });
      video.addEventListener("emptied", reset, { signal });
      if (video.paused) this.pauseLayers();
      else this.playPrimary();
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
            <div class="effect-layer">
              <video class="cat-video secondary" muted playsinline preload="auto"></video>
              <video class="cat-video primary" muted playsinline loop preload="auto"></video>
              <div class="fallback" hidden><span>🐈</span><span>🐈</span><span>🐈</span></div>
            </div>
            <div class="analysis-status" data-state="starting">AI: запуск</div>
            <button class="resize-handle" type="button" title="Изменить размер" aria-label="Изменить размер"></button>
          </div>
        </div>`;
      this.box = this.shadow.querySelector(".cat-box");
      this.primaryVideo = this.shadow.querySelector(".primary");
      this.secondaryVideo = this.shadow.querySelector(".secondary");
      this.fallback = this.shadow.querySelector(".fallback");
      this.statusBadge = this.shadow.querySelector(".analysis-status");
      this.receiveAnalysisState(this.analysisStatus.status, this.analysisStatus.error);

      if (this.videoUrl) {
        this.primaryVideo.src = this.videoUrl;
        this.secondaryVideo.src = this.videoUrl;
        this.primaryVideo.addEventListener("loadedmetadata", () => {
          this.assetReady = true;
          this.fallback.hidden = true;
          if (!this.mainVideo?.paused) this.playPrimary();
        });
        this.primaryVideo.addEventListener("error", () => this.useFallback());
      } else {
        this.useFallback();
      }

      this.installDragging();
      this.installResizing(this.shadow.querySelector(".resize-handle"));
      this.applyLayout();
    }

    useFallback() {
      this.assetReady = false;
      if (this.primaryVideo) this.primaryVideo.hidden = true;
      if (this.secondaryVideo) this.secondaryVideo.hidden = true;
      if (this.fallback) this.fallback.hidden = false;
    }

    animate = () => {
      if (!this.enabled) return;
      this.animationFrame = requestAnimationFrame(this.animate);
      if (!this.mainVideo?.isConnected) {
        this.scheduleAttach();
        return;
      }
      if (this.mainVideo.paused || this.mainVideo.seeking) {
        this.pauseLayers();
        return;
      }
      if (!this.assetReady || !this.motionPlanner) return;

      if (this.choreography?.cues?.length) {
        const sample = this.sampleChoreography(this.mainVideo.currentTime);
        if (sample) {
          this.updatePrecomputedTransition(sample);
          this.updateEffects(sample.cue, this.mainVideo.currentTime);
          this.syncPrimary(sample.sourceTime, sample.playbackRate);
          return;
        }
      }
      this.resetEffects();

      const timing = this.getTiming();
      if (!timing) {
        this.primaryVideo.style.opacity = "1";
        this.secondaryVideo.style.opacity = "0";
        this.primaryVideo.playbackRate = 1;
        this.playPrimary();
        return;
      }

      const nowMs = wallClockNow();
      const absoluteBeat = this.beatClock.positionAt(nowMs);
      if (absoluteBeat == null) return;
      if (this.planOriginBeat == null) this.planOriginBeat = Math.floor(absoluteBeat);
      const unwrappedBeat = absoluteBeat - this.planOriginBeat;
      const sample = this.motionPlanner.sample(unwrappedBeat, timing.beatPeriodMs, timing.energy);
      this.updateRealtimeEffects(sample, timing);
      this.updateTransition(sample);
      this.syncPrimary(sample.sourceTime, sample.playbackRate);
    };

    getTiming() {
      if (
        !this.beatState?.bpm ||
        !this.beatClock.locked ||
        !this.beatClock.periodMs ||
        this.beatState.confidence < 0.24
      ) return null;
      return { ...this.beatState, beatPeriodMs: this.beatClock.periodMs };
    }

    syncPrimary(desiredTime, requestedRate) {
      const video = this.primaryVideo;
      const error = desiredTime - video.currentTime;
      if (Math.abs(error) > 0.16) video.currentTime = clamp(desiredTime, 0, this.motionMap.duration - 0.02);
      const correction = clamp(1 + error * 0.12, 0.94, 1.06);
      video.playbackRate = clamp(requestedRate * correction, 0.55, 1.8);
      this.playPrimary();
    }

    sampleChoreography(mediaTime) {
      const cues = this.choreography.cues;
      let cueIndex = cues.findIndex((cue) => mediaTime >= cue.start && mediaTime < cue.end);
      if (cueIndex < 0) return null;
      const cue = cues[cueIndex];
      const cueDuration = Math.max(1e-6, cue.end - cue.start);
      const progress = clamp((mediaTime - cue.start) / cueDuration, 0, 1);
      const sourceTime = cue.sourceStart + (cue.sourceEnd - cue.sourceStart) * progress;
      return {
        cue,
        cueIndex,
        sourceTime,
        playbackRate: clamp(cue.playbackRate * this.mainVideo.playbackRate, 0.55, 1.8)
      };
    }

    updatePrecomputedTransition(sample) {
      if (sample.cueIndex !== this.lastCueIndex) {
        const previous = this.lastCueIndex == null ? null : this.choreography.cues[this.lastCueIndex];
        const discontinuity = previous && Math.abs(previous.sourceEnd - sample.cue.sourceStart) > 0.05;
        if (discontinuity && this.secondaryVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
          this.secondaryVideo.currentTime = clamp(
            previous.sourceEnd - 1 / 30,
            0,
            this.motionMap.duration - 1 / 30
          );
          this.secondaryVideo.pause();
        }
        this.lastCueIndex = sample.cueIndex;
      }
      const elapsed = this.mainVideo.currentTime - sample.cue.start;
      const previous = sample.cueIndex > 0 ? this.choreography.cues[sample.cueIndex - 1] : null;
      const discontinuity = previous && Math.abs(previous.sourceEnd - sample.cue.sourceStart) > 0.05;
      if (discontinuity && elapsed >= 0 && elapsed < 0.22) {
        const progress = clamp(elapsed / 0.22, 0, 1);
        this.primaryVideo.style.opacity = String(progress);
        this.secondaryVideo.style.opacity = String(1 - progress);
      } else {
        this.primaryVideo.style.opacity = "1";
        this.secondaryVideo.style.opacity = "0";
      }
    }

    updateEffects(cue, mediaTime) {
      const beats = this.choreography.song?.beats ?? [];
      const beatIndex = findPreviousIndex(beats, mediaTime);
      let pulseProgress = 1;
      if (beatIndex >= 0 && beatIndex + 1 < beats.length) {
        pulseProgress = clamp(
          (mediaTime - beats[beatIndex]) / Math.max(1e-6, beats[beatIndex + 1] - beats[beatIndex]),
          0,
          1
        );
      }
      const pulse = Number(cue.scale?.pulse ?? 0) * (1 - pulseProgress) ** 3;
      const scale = Number(cue.scale?.base ?? 1) + pulse;
      this.box.style.setProperty("--effect-scale", String(scale));
      this.box.style.setProperty("--effect-mirror", cue.mirror ? "-1" : "1");
    }

    updateRealtimeEffects(sample, timing) {
      const beatProgress = positiveModulo(sample.unwrappedBeat, 1);
      const pulse = (0.025 + timing.energy * 0.08) * (1 - beatProgress) ** 3;
      const scale = 0.96 + timing.energy * 0.09 + pulse;
      const mirror = sample.transitionSerial % 2 === 1 && timing.energy >= 0.45;
      this.box.style.setProperty("--effect-scale", String(scale));
      this.box.style.setProperty("--effect-mirror", mirror ? "-1" : "1");
    }

    resetEffects() {
      this.box?.style.setProperty("--effect-scale", "1");
      this.box?.style.setProperty("--effect-mirror", "1");
    }

    updateTransition(sample) {
      if (sample.transition && sample.transition.key !== this.visibleTransitionKey) {
        if (this.secondaryVideo.readyState >= HTMLMediaElement.HAVE_METADATA) {
          this.secondaryVideo.currentTime = clamp(
            sample.transition.fromTime - 1 / 30,
            0,
            this.motionMap.duration - 1 / 30
          );
          this.secondaryVideo.pause();
        }
        this.visibleTransitionKey = sample.transition.key;
      }

      const transitionBeats = this.motionMap.transition?.beats ?? 0;
      const transitionProgress = sample.transition
        ? sample.unwrappedBeat - sample.transition.startBeat
        : Infinity;
      if (transitionBeats > 0 && transitionProgress >= 0 && transitionProgress < transitionBeats) {
        const progress = clamp(transitionProgress / transitionBeats, 0, 1);
        this.primaryVideo.style.opacity = String(progress);
        this.secondaryVideo.style.opacity = String(1 - progress);
      } else {
        this.primaryVideo.style.opacity = "1";
        this.secondaryVideo.style.opacity = "0";
      }
    }

    resetPlan(keepChoreography = false) {
      this.beatState = null;
      this.beatClock.reset();
      this.motionPlanner?.reset();
      if (!keepChoreography) this.choreography = null;
      this.lastCueIndex = null;
      this.planOriginBeat = null;
      this.visibleTransitionKey = null;
      if (this.primaryVideo) this.primaryVideo.style.opacity = "1";
      if (this.secondaryVideo) this.secondaryVideo.style.opacity = "0";
      this.resetEffects();
    }

    pauseLayers() {
      this.primaryVideo?.pause();
      this.secondaryVideo?.pause();
    }

    playPrimary() {
      if (!this.primaryVideo || this.mainVideo?.paused) return;
      this.primaryVideo.play().catch(() => {});
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
    }

    async saveLayout() {
      await chrome.storage.local.set({ [LAYOUT_KEY]: this.layout });
    }
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load ${url}`);
    return response.json();
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

  function wallClockNow() {
    return performance.timeOrigin + performance.now();
  }

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function wrappedUnitDifference(target, current) {
    let difference = target - current;
    if (difference > 0.5) difference -= 1;
    if (difference < -0.5) difference += 1;
    return difference;
  }

  function findPreviousIndex(values, target) {
    let low = 0;
    let high = values.length - 1;
    let answer = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (values[middle] <= target) {
        answer = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return answer;
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
    .effect-layer {
      position: relative; width: 100%;
      transform: scale(var(--effect-scale)) scaleX(var(--effect-mirror));
      transform-origin: center bottom;
      transition: transform 90ms ease-out;
    }
    .cat-video {
      display: block; width: 100%; height: auto; pointer-events: none;
      position: relative; transition: opacity 50ms linear;
    }
    .cat-video.secondary { position: absolute; inset: 0; opacity: 0; }
    .cat-video.primary { opacity: 1; }
    .fallback {
      display: flex; justify-content: center; align-items: end; gap: 1%;
      min-height: 120px; font-size: clamp(36px, 8vw, 112px); pointer-events: none;
      filter: drop-shadow(0 3px 4px #0008);
    }
    .analysis-status {
      position: absolute; left: 50%; bottom: -24px; transform: translateX(-50%);
      max-width: 95%; padding: 3px 8px; overflow: hidden; white-space: nowrap;
      border-radius: 999px; background: #854d0ecc; color: #fff; font: 11px/1.4 sans-serif;
      pointer-events: none; text-overflow: ellipsis; box-shadow: 0 1px 3px #0008;
    }
    .analysis-status[data-state="complete"] { background: #6d28d9dd; }
    .analysis-status[data-state="unavailable"] { background: #334155dd; }
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
    if (message?.type === MESSAGE.ENABLE_OVERLAY) void controller.enable();
    else if (message?.type === MESSAGE.DISABLE_OVERLAY) controller.disable();
    else if (message?.type === MESSAGE.BEAT_STATE) controller.receiveBeat(message.state);
    else if (message?.type === MESSAGE.ANALYSIS_STATE) {
      controller.receiveAnalysisState(message.status, message.error);
    }
    else if (message?.type === MESSAGE.CHOREOGRAPHY_READY) {
      controller.receiveChoreography(message.choreography);
    }
    else if (message?.type === MESSAGE.ERROR) controller.showCaptureError();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[LAYOUT_KEY]) return;
    controller.layout = sanitizeLayout(changes[LAYOUT_KEY].newValue);
    controller.applyLayout();
  });
  chrome.runtime.sendMessage({ type: MESSAGE.CONTENT_READY }).catch(() => {});
})();
