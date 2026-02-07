import { describe, it, expect, beforeEach } from 'vitest';
import { LatencyTracker } from '../../src/core';

describe('LatencyTracker', () => {
  let tracker: LatencyTracker;

  beforeEach(() => {
    tracker = new LatencyTracker(100);
  });

  describe('record()', () => {
    it('should record a positive latency', () => {
      tracker.record(500);
      expect(tracker.getSampleCount()).toBe(1);
    });

    it('should clamp negative latency to 0', () => {
      tracker.record(-500);
      expect(tracker.getAverage()).toBe(0);
    });

    it('should drop oldest when exceeding maxSamples', () => {
      const smallTracker = new LatencyTracker(5);
      for (let i = 0; i < 10; i++) {
        smallTracker.record(i * 100);
      }
      expect(smallTracker.getSampleCount()).toBe(5);
      // Oldest (0-400) dropped, newest (500-900) remain
      expect(smallTracker.getMax()).toBe(900);
    });
  });

  describe('getAverage()', () => {
    it('should return fallback when empty', () => {
      expect(tracker.getAverage(60000, 42)).toBe(42);
    });

    it('should return average of single sample', () => {
      tracker.record(100);
      expect(tracker.getAverage()).toBe(100);
    });

    it('should return average of multiple samples', () => {
      tracker.record(100);
      tracker.record(200);
      tracker.record(300);
      expect(tracker.getAverage()).toBe(200);
    });

    it('should only count samples within window', () => {
      const now = Date.now();
      // Old sample (outside window)
      tracker._injectSample(now - 120000, 1000);
      // Recent sample (inside window)
      tracker._injectSample(now - 1000, 100);
      
      expect(tracker.getAverage(60000, 0)).toBe(100);
    });
  });

  describe('getMax()', () => {
    it('should return fallback when empty', () => {
      expect(tracker.getMax(60000, 99)).toBe(99);
    });

    it('should return max of samples', () => {
      tracker.record(50);
      tracker.record(200);
      tracker.record(100);
      expect(tracker.getMax()).toBe(200);
    });

    it('should only count samples within window', () => {
      const now = Date.now();
      // Old sample (outside window) - would be max
      tracker._injectSample(now - 120000, 9999);
      // Recent samples (inside window)
      tracker._injectSample(now - 1000, 100);
      tracker._injectSample(now - 500, 200);
      
      expect(tracker.getMax(60000, 0)).toBe(200);
    });
  });

  describe('clear()', () => {
    it('should remove all samples', () => {
      tracker.record(100);
      tracker.record(200);
      expect(tracker.getSampleCount()).toBe(2);
      
      tracker.clear();
      expect(tracker.getSampleCount()).toBe(0);
    });
  });
});
