import { describe, it, expect, beforeEach } from 'vitest';
import { LatencyTracker, shouldBuffer, SystemState } from '../../src/core';

describe('shouldBuffer()', () => {
  let tracker: LatencyTracker;
  let defaultState: SystemState;

  beforeEach(() => {
    tracker = new LatencyTracker(100);
    defaultState = {
      globalForcedBuffering: false,
      simulatedLatencyMs: 0,
      systemHalted: false
    };
  });

  describe('healthy conditions', () => {
    it('should not buffer when latency is below threshold', () => {
      tracker.record(1000);
      const result = shouldBuffer(tracker, 5000, defaultState);
      
      expect(result.buffering).toBe(false);
      expect(result.reason).toBe('healthy');
    });

    it('should not buffer when exactly at threshold', () => {
      tracker.record(5000);
      // Using > not >= for threshold check
      const result = shouldBuffer(tracker, 5000, defaultState);
      
      expect(result.buffering).toBe(false);
    });
  });

  describe('degraded conditions', () => {
    it('should buffer when latency exceeds threshold', () => {
      tracker.record(6000);
      const result = shouldBuffer(tracker, 5000, defaultState);
      
      expect(result.buffering).toBe(true);
      expect(result.reason).toContain('latency');
      expect(result.reason).toContain('6000');
    });
  });

  describe('manual override', () => {
    it('should buffer when globalForcedBuffering is true', () => {
      tracker.record(100); // Very low latency
      const state = { ...defaultState, globalForcedBuffering: true };
      
      const result = shouldBuffer(tracker, 5000, state);
      
      expect(result.buffering).toBe(true);
      expect(result.reason).toBe('manual override');
    });
  });

  describe('simulated latency', () => {
    it('should buffer when simulated latency exceeds threshold', () => {
      // No real samples
      const state = { ...defaultState, simulatedLatencyMs: 20000 };
      
      const result = shouldBuffer(tracker, 5000, state);
      
      expect(result.buffering).toBe(true);
      expect(result.reason).toContain('simulated');
      expect(result.latencyMs).toBe(20000);
    });

    it('should not buffer when simulated latency is below threshold', () => {
      const state = { ...defaultState, simulatedLatencyMs: 1000 };
      
      const result = shouldBuffer(tracker, 5000, state);
      
      expect(result.buffering).toBe(false);
    });
  });

  describe('system halted', () => {
    it('should always buffer when halted', () => {
      tracker.record(100); // Very low latency
      const state = { 
        globalForcedBuffering: false,
        simulatedLatencyMs: 0,
        systemHalted: true 
      };
      
      const result = shouldBuffer(tracker, 5000, state);
      
      expect(result.buffering).toBe(true);
      expect(result.reason).toBe('SYSTEM HALTED');
    });

    it('should prioritize halt over other states', () => {
      const state = { 
        globalForcedBuffering: true,
        simulatedLatencyMs: 99999,
        systemHalted: true 
      };
      
      const result = shouldBuffer(tracker, 5000, state);
      
      expect(result.reason).toBe('SYSTEM HALTED');
    });
  });

  describe('priority order', () => {
    it('should check halt > forced > simulated > real', () => {
      const state = { 
        globalForcedBuffering: true,
        simulatedLatencyMs: 10000,
        systemHalted: false 
      };
      tracker.record(20000);
      
      const result = shouldBuffer(tracker, 5000, state);
      
      // Forced takes precedence over real latency
      expect(result.reason).toBe('manual override');
    });
  });
});
