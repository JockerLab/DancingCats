(() => {
  "use strict";

  class BeatDetector {
    constructor(sampleRate, fftSize) {
      this.sampleRate = sampleRate;
      this.fftSize = fftSize;
      this.reset();
    }

    reset() {
      this.previousSpectrum = null;
      this.fluxHistory = [];
      this.onsets = [];
      this.lastOnsetMs = -Infinity;
      this.lastEstimateMs = -Infinity;
      this.smoothedBpm = null;
      this.state = emptyState("detecting");
    }

    process(dbSpectrum, nowMs) {
      const flux = this.calculateFlux(dbSpectrum);
      this.fluxHistory.push({ time: nowMs, value: flux });
      this.trim(nowMs);

      const recent = this.fluxHistory.filter((item) => item.time >= nowMs - 1500);
      const values = recent.map((item) => item.value);
      const mean = average(values);
      const deviation = standardDeviation(values, mean);
      const threshold = mean + deviation * 1.5;
      const previousFlux = recent.at(-2)?.value ?? 0;

      if (
        recent.length >= 8 &&
        flux > threshold &&
        flux > previousFlux * 1.03 &&
        nowMs - this.lastOnsetMs >= 170
      ) {
        this.onsets.push({
          time: nowMs,
          strength: Math.min(3, flux / Math.max(threshold, 1e-6))
        });
        this.lastOnsetMs = nowMs;
      }

      if (nowMs - this.lastEstimateMs >= 400) {
        this.lastEstimateMs = nowMs;
        this.state = this.estimate(nowMs, mean, deviation);
      }
      return this.state;
    }

    calculateFlux(dbSpectrum) {
      const spectrum = new Float32Array(dbSpectrum.length);
      const binHz = this.sampleRate / this.fftSize;
      let flux = 0;
      for (let index = 0; index < dbSpectrum.length; index += 1) {
        const hz = index * binHz;
        const magnitude = Number.isFinite(dbSpectrum[index]) ? 10 ** (dbSpectrum[index] / 20) : 0;
        spectrum[index] = magnitude;
        if (!this.previousSpectrum || hz < 35 || hz > 3000) continue;
        const difference = magnitude - this.previousSpectrum[index];
        if (difference <= 0) continue;
        flux += difference * (hz < 250 ? 1.8 : hz < 1000 ? 1.25 : 0.75);
      }
      this.previousSpectrum = spectrum;
      return flux;
    }

    estimate(nowMs, fluxMean, fluxDeviation) {
      const onsets = this.onsets.filter((onset) => onset.time >= nowMs - 10000);
      const energy = normalizeEnergy(fluxMean, fluxDeviation);
      if (onsets.length < 6) {
        return { ...emptyState(energy < 0.015 ? "no-signal" : "detecting"), energy };
      }

      const minBpm = 70;
      const maxBpm = 180;
      const resolution = 0.5;
      const histogram = new Float64Array(Math.round((maxBpm - minBpm) / resolution) + 1);
      for (let right = 1; right < onsets.length; right += 1) {
        for (let left = Math.max(0, right - 8); left < right; left += 1) {
          const interval = onsets[right].time - onsets[left].time;
          if (interval < 250 || interval > 2400) continue;
          let bpm = 60000 / interval;
          while (bpm < minBpm) bpm *= 2;
          while (bpm > maxBpm) bpm /= 2;
          if (bpm < minBpm || bpm > maxBpm) continue;
          const index = Math.round((bpm - minBpm) / resolution);
          const score = Math.min(onsets[left].strength, onsets[right].strength) / Math.sqrt(right - left);
          histogram[index] += score;
          if (index > 0) histogram[index - 1] += score * 0.25;
          if (index + 1 < histogram.length) histogram[index + 1] += score * 0.25;
        }
      }

      let bestIndex = 0;
      let bestScore = 0;
      let totalScore = 0;
      for (let index = 0; index < histogram.length; index += 1) {
        totalScore += histogram[index];
        if (histogram[index] > bestScore) {
          bestScore = histogram[index];
          bestIndex = index;
        }
      }
      if (!bestScore) return { ...emptyState("detecting"), energy };

      const rawBpm = minBpm + bestIndex * resolution;
      this.smoothedBpm = this.smoothedBpm == null
        ? rawBpm
        : this.smoothedBpm * 0.8 + rawBpm * 0.2;
      const beatPeriodMs = 60000 / this.smoothedBpm;
      const phase = estimatePhase(onsets, beatPeriodMs);
      const peakShare = bestScore / Math.max(totalScore, 1e-6);
      const amountScore = Math.min(1, onsets.length / 18);
      const confidence = Math.min(1, (peakShare * 3.5 + phase.concentration) * 0.5 * amountScore);
      const beatIndex = Math.floor((nowMs - phase.offsetMs) / beatPeriodMs);
      const lastBeatTimeMs = phase.offsetMs + beatIndex * beatPeriodMs;

      return {
        bpm: Math.round(this.smoothedBpm * 10) / 10,
        confidence,
        beatPeriodMs,
        epochMs: phase.offsetMs,
        lastBeatTimeMs,
        beatIndex,
        energy,
        mode: confidence >= 0.32 ? "locked" : "detecting"
      };
    }

    trim(nowMs) {
      const cutoff = nowMs - 12000;
      while (this.fluxHistory[0]?.time < cutoff) this.fluxHistory.shift();
      while (this.onsets[0]?.time < cutoff) this.onsets.shift();
    }
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function standardDeviation(values, mean) {
    if (values.length < 2) return 0;
    return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  }

  function normalizeEnergy(mean, deviation) {
    return Math.min(1, Math.max(0, (mean + deviation) * 18));
  }

  function estimatePhase(onsets, periodMs) {
    let x = 0;
    let y = 0;
    let total = 0;
    for (const onset of onsets) {
      const angle = ((onset.time % periodMs) / periodMs) * Math.PI * 2;
      x += Math.cos(angle) * onset.strength;
      y += Math.sin(angle) * onset.strength;
      total += onset.strength;
    }
    let angle = Math.atan2(y, x);
    if (angle < 0) angle += Math.PI * 2;
    return {
      offsetMs: (angle / (Math.PI * 2)) * periodMs,
      concentration: Math.sqrt(x * x + y * y) / Math.max(total, 1e-6)
    };
  }

  function emptyState(mode) {
    return {
      bpm: null,
      confidence: 0,
      beatPeriodMs: null,
      epochMs: null,
      lastBeatTimeMs: null,
      beatIndex: 0,
      energy: 0,
      mode
    };
  }

  globalThis.DancingCatsBeatDetector = BeatDetector;
})();
