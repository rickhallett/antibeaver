import { describe, it, expect } from 'vitest';
import { generateSynthesisPrompt, BufferedThought } from '../../src/core';

describe('generateSynthesisPrompt()', () => {
  const makeThought = (overrides: Partial<BufferedThought> = {}): BufferedThought => ({
    id: 1,
    agent_id: 'main',
    channel: 'slack',
    target: '#ops',
    content: 'Test thought',
    priority: 'P1',
    created_at: '2026-02-07T12:00:00Z',
    status: 'pending',
    ...overrides
  });

  describe('empty input', () => {
    it('should handle empty array', () => {
      const result = generateSynthesisPrompt([]);
      expect(result).toContain('No buffered thoughts');
    });
  });

  describe('single thought', () => {
    it('should format single thought correctly', () => {
      const thought = makeThought({ content: 'Hello world' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('NETWORK RECOVERED');
      expect(result).toContain('1 messages');
      expect(result).toContain('Hello world');
      expect(result).toContain('1.');
    });
  });

  describe('priority ordering', () => {
    it('should sort P0 before P1 before P2', () => {
      const thoughts = [
        makeThought({ id: 1, priority: 'P2', content: 'Low priority' }),
        makeThought({ id: 2, priority: 'P0', content: 'Critical' }),
        makeThought({ id: 3, priority: 'P1', content: 'Normal' }),
      ];
      
      const result = generateSynthesisPrompt(thoughts);
      
      const criticalPos = result.indexOf('Critical');
      const normalPos = result.indexOf('Normal');
      const lowPos = result.indexOf('Low priority');
      
      expect(criticalPos).toBeLessThan(normalPos);
      expect(normalPos).toBeLessThan(lowPos);
    });

    it('should add [CRITICAL] tag to P0', () => {
      const thought = makeThought({ priority: 'P0', content: 'Urgent' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('[CRITICAL]');
    });

    it('should add [low] tag to P2', () => {
      const thought = makeThought({ priority: 'P2', content: 'Minor' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('[low]');
    });

    it('should not add tag to P1', () => {
      const thought = makeThought({ priority: 'P1', content: 'Normal' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).not.toContain('[CRITICAL]');
      expect(result).not.toContain('[low]');
    });
  });

  describe('time ordering within priority', () => {
    it('should sort by time within same priority', () => {
      const thoughts = [
        makeThought({ id: 1, priority: 'P1', content: 'Later', created_at: '2026-02-07T12:05:00Z' }),
        makeThought({ id: 2, priority: 'P1', content: 'Earlier', created_at: '2026-02-07T12:00:00Z' }),
      ];
      
      const result = generateSynthesisPrompt(thoughts);
      
      const earlierPos = result.indexOf('Earlier');
      const laterPos = result.indexOf('Later');
      
      expect(earlierPos).toBeLessThan(laterPos);
    });
  });

  describe('special characters', () => {
    it('should escape quotes', () => {
      const thought = makeThought({ content: 'He said "hello"' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('\\"hello\\"');
    });

    it('should escape newlines', () => {
      const thought = makeThought({ content: 'Line 1\nLine 2' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('Line 1\\nLine 2');
    });

    it('should preserve unicode', () => {
      const thought = makeThought({ content: 'Hello 🦫 beaver' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('🦫');
    });
  });

  describe('critical note', () => {
    it('should add note when P0 thoughts exist', () => {
      const thoughts = [
        makeThought({ priority: 'P0', content: 'Critical 1' }),
        makeThought({ priority: 'P0', content: 'Critical 2' }),
        makeThought({ priority: 'P1', content: 'Normal' }),
      ];
      
      const result = generateSynthesisPrompt(thoughts);
      
      expect(result).toContain('2 CRITICAL');
      expect(result).toContain('preserve unless clearly obsolete');
    });

    it('should not add note when no P0 thoughts', () => {
      const thoughts = [
        makeThought({ priority: 'P1', content: 'Normal' }),
        makeThought({ priority: 'P2', content: 'Low' }),
      ];
      
      const result = generateSynthesisPrompt(thoughts);
      
      expect(result).not.toContain('CRITICAL thought');
    });
  });

  describe('prompt structure', () => {
    it('should include all required sections', () => {
      const thought = makeThought({ content: 'Test' });
      const result = generateSynthesisPrompt([thought]);
      
      expect(result).toContain('SYSTEM: NETWORK RECOVERED');
      expect(result).toContain('TASK:');
      expect(result).toContain('Discard obsolete');
      expect(result).toContain('ONE coherent message');
      expect(result).toContain('Do not apologize');
    });
  });
});
