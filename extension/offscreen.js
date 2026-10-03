(() => {
  "use strict";

  const { MESSAGE } = DancingCatsShared;
  let session = null;
  let analysisController = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== "offscreen") return false;
    if (message.type === MESSAGE.START_CAPTURE) {
      void startCapture(message).then(
        () => sendResponse({ ok: true }),
        (error) => {
          reportError(message.tabId, error);
          sendResponse({ ok: false, error: String(error) });
        }
      );
      return true;
    }
    if (message.type === MESSAGE.STOP_CAPTURE) {
      stopCapture(message.reason ?? "stopped");
      sendResponse({ ok: true });
      return false;
    }
    if (message.type === MESSAGE.RESET_ANALYSIS && session?.tabId === message.tabId) {
      session.detector.reset();
      if (message.youtubeUrl) void analyzeTrack(message.tabId, message.youtubeUrl);
      sendResponse({ ok: true });
    }
    return false;
  });

  async function startCapture({ tabId, streamId, youtubeUrl }) {
    stopCapture("replaced", false);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    const audioContext = new AudioContext({ latencyHint: "interactive" });
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.15;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    source.connect(audioContext.destination);
    source.connect(analyser);

    const detector = new DancingCatsBeatDetector(audioContext.sampleRate, analyser.fftSize);
    session = {
      tabId,
      stream,
      audioContext,
      source,
      analyser,
      detector,
      spectrum: new Float32Array(analyser.frequencyBinCount),
      timer: null,
      lastSentMs: 0
    };
    const activeSession = session;
    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (session === activeSession) stopCapture("stream-ended");
      }, { once: true });
    }
    session.timer = setInterval(() => analyze(activeSession), 25);
    await chrome.runtime.sendMessage({
      source: "offscreen",
      type: MESSAGE.CAPTURE_READY,
      tabId
    });
    if (youtubeUrl) void analyzeTrack(tabId, youtubeUrl);
  }

  function analyze(activeSession) {
    if (session !== activeSession || activeSession.audioContext.state === "closed") return;
    activeSession.analyser.getFloatFrequencyData(activeSession.spectrum);
    const nowMs = performance.timeOrigin + performance.now();
    const state = activeSession.detector.process(activeSession.spectrum, nowMs);
    if (nowMs - activeSession.lastSentMs < 100) return;
    activeSession.lastSentMs = nowMs;
    void chrome.runtime.sendMessage({
      source: "offscreen",
      type: MESSAGE.BEAT_STATE,
      tabId: activeSession.tabId,
      state
    });
  }

  function stopCapture(reason, notify = true) {
    analysisController?.abort();
    analysisController = null;
    if (!session) return;
    const previous = session;
    session = null;
    clearInterval(previous.timer);
    for (const track of previous.stream.getTracks()) track.stop();
    previous.source.disconnect();
    previous.analyser.disconnect();
    void previous.audioContext.close();
    if (notify) {
      void chrome.runtime.sendMessage({
        source: "offscreen",
        type: MESSAGE.CAPTURE_ENDED,
        tabId: previous.tabId,
        reason
      });
    }
  }

  async function analyzeTrack(tabId, youtubeUrl) {
    analysisController?.abort();
    const controller = new AbortController();
    analysisController = controller;
    try {
      reportAnalysisState(tabId, "submitting");
      const response = await fetch("http://127.0.0.1:8765/v1/analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl, assetId: "three-cats" }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Local analyzer returned HTTP ${response.status}`);
      let job = await response.json();
      while (job.status === "queued" || job.status === "running") {
        reportAnalysisState(tabId, job.status);
        await abortableDelay(1000, controller.signal);
        const statusResponse = await fetch(
          `http://127.0.0.1:8765/v1/analysis/${encodeURIComponent(job.jobId)}`,
          { signal: controller.signal }
        );
        if (!statusResponse.ok) throw new Error(`Unable to poll analysis job: HTTP ${statusResponse.status}`);
        job = await statusResponse.json();
      }
      if (job.status !== "complete" || !job.mapUrl) {
        throw new Error(job.error || "Local analysis failed");
      }
      const mapResponse = await fetch(job.mapUrl, { signal: controller.signal });
      if (!mapResponse.ok) throw new Error(`Unable to load choreography: HTTP ${mapResponse.status}`);
      const choreography = await mapResponse.json();
      if (analysisController !== controller || session?.tabId !== tabId) return;
      await chrome.runtime.sendMessage({
        source: "offscreen",
        type: MESSAGE.CHOREOGRAPHY_READY,
        tabId,
        choreography
      });
      reportAnalysisState(tabId, "complete");
    } catch (error) {
      if (error?.name === "AbortError") return;
      reportAnalysisState(tabId, "unavailable", error instanceof Error ? error.message : String(error));
    } finally {
      if (analysisController === controller) analysisController = null;
    }
  }

  function reportAnalysisState(tabId, status, error = null) {
    void chrome.runtime.sendMessage({
      source: "offscreen",
      type: MESSAGE.ANALYSIS_STATE,
      tabId,
      status,
      error
    });
  }

  function abortableDelay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  function reportError(tabId, error) {
    void chrome.runtime.sendMessage({
      source: "offscreen",
      type: MESSAGE.ERROR,
      tabId,
      code: "AUDIO_CAPTURE_FAILED",
      message: error instanceof Error ? error.message : String(error)
    });
  }
})();
