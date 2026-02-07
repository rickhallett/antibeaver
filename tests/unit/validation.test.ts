import { describe, it, expect } from 'vitest';
import { validatePriority, validateThought, validateLatency } from '../../src/core';

describe('validatePriority()', () => {
  it('should accept P0', () => {
    expect(validatePriority('P0')).toBe('P0');
  });

  it('should accept P1', () => {
    expect(validatePriority('P1')).toBe('P1');
  });

  it('should accept P2', () => {
    expect(validatePriority('P2')).toBe('P2');
  });

  it('should default to P1 for invalid string', () => {
    expect(validatePriority('P99')).toBe('P1');
    expect(validatePriority('high')).toBe('P1');
    expect(validatePriority('')).toBe('P1');
  });

  it('should default to P1 for non-string', () => {
    expect(validatePriority(null)).toBe('P1');
    expect(validatePriority(undefined)).toBe('P1');
    expect(validatePriority(1)).toBe('P1');
    expect(validatePriority({})).toBe('P1');
  });
});

describe('validateThought()', () => {
  it('should accept valid string', () => {
    expect(validateThought('Hello world')).toBe('Hello world');
  });

  it('should reject non-string', () => {
    expect(validateThought(null)).toBeNull();
    expect(validateThought(undefined)).toBeNull();
    expect(validateThought(123)).toBeNull();
    expect(validateThought({})).toBeNull();
  });

  it('should reject empty string', () => {
    expect(validateThought('')).toBeNull();
  });

  it('should reject whitespace-only string', () => {
    expect(validateThought('   ')).toBeNull();
    expect(validateThought('\n\t')).toBeNull();
  });

  it('should truncate very long strings', () => {
    const longString = 'a'.repeat(60000);
    const result = validateThought(longString);
    
    expect(result).not.toBeNull();
    expect(result!.length).toBe(50000);
  });

  it('should preserve unicode', () => {
    expect(validateThought('Hello 🦫')).toBe('Hello 🦫');
  });
});

describe('validateLatency()', () => {
  it('should accept positive number', () => {
    expect(validateLatency(500)).toBe(500);
  });

  it('should round float to integer', () => {
    expect(validateLatency(500.7)).toBe(501);
    expect(validateLatency(500.2)).toBe(500);
  });

  it('should clamp negative to 0', () => {
    expect(validateLatency(-100)).toBe(0);
  });

  it('should return 0 for non-number', () => {
    expect(validateLatency('500')).toBe(0);
    expect(validateLatency(null)).toBe(0);
    expect(validateLatency(undefined)).toBe(0);
  });

  it('should return 0 for non-finite', () => {
    expect(validateLatency(Infinity)).toBe(0);
    expect(validateLatency(-Infinity)).toBe(0);
    expect(validateLatency(NaN)).toBe(0);
  });

  it('should handle very large numbers', () => {
    expect(validateLatency(999999999)).toBe(999999999);
  });
});
