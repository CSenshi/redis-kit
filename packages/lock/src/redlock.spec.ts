import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { RedisClientType } from 'redis';
import { Redlock } from './redlock.js';
import { InvalidParameterError } from './errors.js';

// Mock Redis client interface
interface MockRedisClient {
  isReady: boolean;
  eval: vi.MockedFunction<any>;
}

// Helper to create mock Redis clients
function createMockRedisClient(isReady = true): MockRedisClient {
  return {
    isReady,
    eval: vi.fn(),
  };
}

// Helper to create multiple mock clients
function createMockClients(count: number, allReady = true): MockRedisClient[] {
  return Array.from({ length: count }, () => createMockRedisClient(allReady));
}

describe('Redlock', () => {
  let mockClients: MockRedisClient[];
  let redlock: Redlock;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    
    // Create 5 mock Redis clients (standard Redlock setup)
    mockClients = createMockClients(5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Constructor', () => {
    it('should create Redlock instance with valid clients', () => {
      redlock = new Redlock(mockClients as RedisClientType[]);
      
      // Redlock instance should be created successfully
      expect(redlock).toBeInstanceOf(Redlock);
    });

    it('should throw error with empty client array', () => {
      const emptyClients: any[] = [];
      
      expect(() => {
        new Redlock(emptyClients as RedisClientType[]);
      }).toThrow(InvalidParameterError);
    });

    it('should throw error with disconnected clients', () => {
      const clients = createMockClients(3, false); // All disconnected
      
      expect(() => {
        new Redlock(clients as RedisClientType[]);
      }).toThrow(InvalidParameterError);
    });

    it('should warn about even number of instances', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fourClients = createMockClients(4);
      
      new Redlock(fourClients as RedisClientType[]);
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('even number')
      );
    });

    it('should validate drift factor option', () => {
      expect(() => {
        new Redlock(mockClients as RedisClientType[], { driftFactor: -0.1 });
      }).toThrow(InvalidParameterError);

      expect(() => {
        new Redlock(mockClients as RedisClientType[], { driftFactor: 0.2 });
      }).toThrow(InvalidParameterError);
    });

    it('should validate retry options', () => {
      expect(() => {
        new Redlock(mockClients as RedisClientType[], { retryDelayMs: -100 });
      }).toThrow(InvalidParameterError);

      expect(() => {
        new Redlock(mockClients as RedisClientType[], { maxRetryAttempts: -1 });
      }).toThrow(InvalidParameterError);
    });
  });

  describe('Timing Calculations', () => {
    beforeEach(() => {
      redlock = new Redlock(mockClients as RedisClientType[], {
        driftFactor: 0.01,
      });
    });

    it('should calculate effective validity correctly', () => {
      // Access private method for testing
      const calculateEffectiveValidity = (redlock as any).calculateEffectiveValidity.bind(redlock);
      
      const ttlMs = 10000; // 10 seconds
      const elapsedMs = 1000; // 1 second
      
      // Expected: 10000 - 1000 - (0.01 * 10000) = 8900ms
      const result = calculateEffectiveValidity(ttlMs, elapsedMs);
      expect(result).toBe(8900);
    });



    it('should generate random retry delays', () => {
      redlock = new Redlock(mockClients as RedisClientType[], {
        retryDelayMs: 200,
        retryJitterMs: 100,
      });

      const generateRetryDelay = (redlock as any).generateRetryDelay.bind(redlock);
      
      const delay1 = generateRetryDelay();
      const delay2 = generateRetryDelay();
      
      // Should be between 200 and 300ms
      expect(delay1).toBeGreaterThanOrEqual(200);
      expect(delay1).toBeLessThanOrEqual(300);
      expect(delay2).toBeGreaterThanOrEqual(200);
      expect(delay2).toBeLessThanOrEqual(300);
      
      // Should be different (with high probability)
      expect(delay1).not.toBe(delay2);
    });
  });

  describe('Majority Consensus Logic', () => {
    beforeEach(() => {
      redlock = new Redlock(mockClients as RedisClientType[]);
    });

    it('should correctly identify majority consensus', () => {
      const hasMajorityConsensus = (redlock as any).hasMajorityConsensus.bind(redlock);
      
      // With 5 instances, quorum is 3
      expect(hasMajorityConsensus({ successCount: 3 })).toBe(true);
      expect(hasMajorityConsensus({ successCount: 4 })).toBe(true);
      expect(hasMajorityConsensus({ successCount: 5 })).toBe(true);
      expect(hasMajorityConsensus({ successCount: 2 })).toBe(false);
      expect(hasMajorityConsensus({ successCount: 1 })).toBe(false);
      expect(hasMajorityConsensus({ successCount: 0 })).toBe(false);
    });

    it('should validate timing constraints', () => {
      const isTimingValid = (redlock as any).isTimingValid.bind(redlock);
      
      // Valid timing (effective validity > 1ms)
      expect(isTimingValid({ ttlMs: 10000, elapsedTime: 1000 })).toBe(true);
      
      // Invalid timing (effective validity <= 1ms)
      expect(isTimingValid({ ttlMs: 1000, elapsedTime: 999 })).toBe(false);
      expect(isTimingValid({ ttlMs: 1000, elapsedTime: 1000 })).toBe(false);
    });

    it('should evaluate acquisition attempts correctly', () => {
      const evaluateAcquisitionAttempt = (redlock as any).evaluateAcquisitionAttempt.bind(redlock);
      
      // Successful attempt
      const successfulAttempt = {
        successCount: 3,
        ttlMs: 10000,
        elapsedTime: 1000,
      };
      
      const successResult = evaluateAcquisitionAttempt(successfulAttempt);
      expect(successResult.success).toBe(true);
      expect(successResult.effectiveValidityMs).toBe(8900); // 10000 - 1000 - 100
      
      // Failed attempt - insufficient consensus
      const failedConsensusAttempt = {
        successCount: 2,
        ttlMs: 10000,
        elapsedTime: 1000,
      };
      
      const consensusResult = evaluateAcquisitionAttempt(failedConsensusAttempt);
      expect(consensusResult.success).toBe(false);
      expect(consensusResult.failureReason).toContain('Insufficient consensus');
      
      // Failed attempt - timing violation
      const failedTimingAttempt = {
        successCount: 3,
        ttlMs: 1000,
        elapsedTime: 999,
      };
      
      const timingResult = evaluateAcquisitionAttempt(failedTimingAttempt);
      expect(timingResult.success).toBe(false);
      expect(timingResult.failureReason).toContain('Timing constraint violated');
    });
  });

  describe('Parameter Validation', () => {
    beforeEach(() => {
      redlock = new Redlock(mockClients as RedisClientType[]);
    });

    it('should validate key parameter', () => {
      const validateKey = (redlock as any).validateKey.bind(redlock);
      
      expect(() => validateKey('valid-key')).not.toThrow();
      expect(() => validateKey('')).toThrow(InvalidParameterError);
      expect(() => validateKey('   ')).toThrow(InvalidParameterError);
      expect(() => validateKey(null)).toThrow(InvalidParameterError);
      expect(() => validateKey(undefined)).toThrow(InvalidParameterError);
    });

    it('should validate token parameter', () => {
      const validateToken = (redlock as any).validateToken.bind(redlock);
      
      expect(() => validateToken('valid-token')).not.toThrow();
      expect(() => validateToken('')).toThrow(InvalidParameterError);
      expect(() => validateToken('   ')).toThrow(InvalidParameterError);
      expect(() => validateToken(null)).toThrow(InvalidParameterError);
      expect(() => validateToken(undefined)).toThrow(InvalidParameterError);
    });

    it('should validate TTL parameter', () => {
      const validateTtl = (redlock as any).validateTtl.bind(redlock);
      
      expect(() => validateTtl(1000)).not.toThrow();
      expect(() => validateTtl(0)).toThrow(InvalidParameterError);
      expect(() => validateTtl(-1000)).toThrow(InvalidParameterError);
      expect(() => validateTtl(1.5)).toThrow(InvalidParameterError);
      expect(() => validateTtl('1000' as any)).toThrow(InvalidParameterError);
    });

    it('should warn about very short TTLs', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const validateTtl = (redlock as any).validateTtl.bind(redlock);
      
      validateTtl(500); // Less than 1000ms
      
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('very short')
      );
    });
  });

  describe('Error Categorization', () => {
    beforeEach(() => {
      redlock = new Redlock(mockClients as RedisClientType[]);
    });

    it('should categorize timeout errors', () => {
      const categorizeError = (redlock as any).categorizeError.bind(redlock);
      
      expect(categorizeError(new Error('Operation timed out'))).toBe('timeout');
      expect(categorizeError(new Error('Request timeout'))).toBe('timeout');
    });

    it('should categorize connection errors', () => {
      const categorizeError = (redlock as any).categorizeError.bind(redlock);
      
      expect(categorizeError(new Error('Connection refused'))).toBe('connection');
      expect(categorizeError(new Error('Cannot connect to Redis'))).toBe('connection');
    });

    it('should categorize network errors', () => {
      const categorizeError = (redlock as any).categorizeError.bind(redlock);
      
      expect(categorizeError(new Error('ENOTFOUND redis.example.com'))).toBe('network');
      expect(categorizeError(new Error('ECONNREFUSED'))).toBe('network');
      expect(categorizeError(new Error('Network error'))).toBe('network');
    });

    it('should categorize Redis errors', () => {
      const categorizeError = (redlock as any).categorizeError.bind(redlock);
      
      expect(categorizeError(new Error('WRONGTYPE Operation against a key'))).toBe('redis');
      expect(categorizeError(new Error('Redis syntax error'))).toBe('redis');
    });

    it('should categorize unknown errors', () => {
      const categorizeError = (redlock as any).categorizeError.bind(redlock);
      
      expect(categorizeError(new Error('Some random error'))).toBe('unknown');
      expect(categorizeError('string error')).toBe('unknown');
      expect(categorizeError(null)).toBe('unknown');
    });
  });



  describe('Critical Error Detection', () => {
    beforeEach(() => {
      redlock = new Redlock(mockClients as RedisClientType[]);
    });

    it('should identify critical errors', () => {
      const isCriticalError = (redlock as any).isCriticalError.bind(redlock);
      
      expect(isCriticalError(new InvalidParameterError('key', null, 'string'))).toBe(true);
      expect(isCriticalError(new Error('Network timeout'))).toBe(false);
      expect(isCriticalError(new Error('Connection failed'))).toBe(false);
    });
  });
});