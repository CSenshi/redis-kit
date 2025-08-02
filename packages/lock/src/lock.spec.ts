import { RedisLock } from './lock.js';
import { RedisConnectionError, InvalidParameterError } from './errors.js';
import type { RedisClientType } from 'redis';
import { Mocked } from 'vitest';

// @ts-expect-error As RedisClientType is a complex type, we mock only the methods we use
const mockRedisClient: Mocked<RedisClientType> = {
  isReady: true,
  connect: vi.fn(),
  disconnect: vi.fn(),
  set: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  eval: vi.fn(),
};

describe('RedisLock', () => {
  describe('constructor', () => {
    it('should create instance with valid Redis client', () => {
      const lock = new RedisLock(mockRedisClient);
      expect(lock).toBeInstanceOf(RedisLock);
    });

    it('should create instance with custom options', () => {
      const options = {
        defaultTtlMs: 60000,
        tokenLength: 32,
      };
      const lock = new RedisLock(mockRedisClient, options);
      expect(lock).toBeInstanceOf(RedisLock);
    });

    it('should throw InvalidParameterError when Redis client is null', () => {
      expect(() => new RedisLock(null as unknown as RedisClientType)).toThrow(
        InvalidParameterError
      );
      expect(() => new RedisLock(null as unknown as RedisClientType)).toThrow();
    });

    it('should throw InvalidParameterError when Redis client is undefined', () => {
      expect(
        () => new RedisLock(undefined as unknown as RedisClientType)
      ).toThrow(InvalidParameterError);
      expect(
        () => new RedisLock(undefined as unknown as RedisClientType)
      ).toThrow();
    });

    it('should throw InvalidParameterError for invalid default TTL', () => {
      expect(() => new RedisLock(mockRedisClient, { defaultTtlMs: 0 })).toThrow(
        InvalidParameterError
      );

      expect(
        () => new RedisLock(mockRedisClient, { defaultTtlMs: -1000 })
      ).toThrow(InvalidParameterError);

      expect(
        () => new RedisLock(mockRedisClient, { defaultTtlMs: 1.5 })
      ).toThrow(InvalidParameterError);
    });

    it('should throw InvalidParameterError for invalid token length', () => {
      expect(() => new RedisLock(mockRedisClient, { tokenLength: 0 })).toThrow(
        InvalidParameterError
      );
      expect(() => new RedisLock(mockRedisClient, { tokenLength: 0 })).toThrow(
        'Invalid tokenLength: expected positive integer'
      );

      expect(() => new RedisLock(mockRedisClient, { tokenLength: -5 })).toThrow(
        InvalidParameterError
      );

      expect(
        () => new RedisLock(mockRedisClient, { tokenLength: 2.5 })
      ).toThrow(InvalidParameterError);
    });

    it('should use default options when none provided', () => {
      // Should not throw
      expect(() => new RedisLock(mockRedisClient)).not.toThrow();
    });
  });

  describe('acquire', () => {
    let lock: RedisLock;

    beforeEach(() => {
      lock = new RedisLock(mockRedisClient);
      vi.clearAllMocks();
    });

    it('should successfully acquire a lock', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      const result = await lock.acquire('test-key', 5000);

      expect(result.success).toBe(true);
      expect(result.success && result.token).toBeDefined();
      expect(result.success && typeof result.token).toBe('string');
      expect(result.success && result.expiresAt).toBeInstanceOf(Date);

      // Check that Redis eval was called with correct parameters
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining(
          'redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2])'
        ),
        {
          keys: ['test-key'],
          arguments: [expect.any(String), '5000'],
        }
      );
    });

    it('should fail to acquire when lock already exists', async () => {
      mockRedisClient.eval.mockResolvedValue(0);

      const result = await lock.acquire('test-key', 5000);

      expect(result.success).toBe(false);
      expect(
        !result.success && 'token' in result ? result.token : undefined
      ).toBeUndefined();
      expect(
        !result.success && 'expiresAt' in result ? result.expiresAt : undefined
      ).toBeUndefined();
    });

    it('should use default TTL when none provided', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      await lock.acquire('test-key');

      // Default TTL is 30000ms
      expect(mockRedisClient.eval).toHaveBeenCalledWith(expect.any(String), {
        keys: ['test-key'],
        arguments: [expect.any(String), '30000'],
      });
    });

    it('should use TTL in milliseconds correctly', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      // Test various TTL values in milliseconds
      await lock.acquire('test-key-1', 1000); // 1 second
      expect(mockRedisClient.eval).toHaveBeenLastCalledWith(
        expect.any(String),
        {
          keys: ['test-key-1'],
          arguments: [expect.any(String), '1000'],
        }
      );

      await lock.acquire('test-key-2', 1500); // 1.5 seconds
      expect(mockRedisClient.eval).toHaveBeenLastCalledWith(
        expect.any(String),
        {
          keys: ['test-key-2'],
          arguments: [expect.any(String), '1500'],
        }
      );

      await lock.acquire('test-key-3', 10000); // 10 seconds
      expect(mockRedisClient.eval).toHaveBeenLastCalledWith(
        expect.any(String),
        {
          keys: ['test-key-3'],
          arguments: [expect.any(String), '10000'],
        }
      );
    });

    it('should generate unique tokens for each acquisition', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      const result1 = await lock.acquire('test-key-1', 5000);
      const result2 = await lock.acquire('test-key-2', 5000);

      expect(result1.success && result1.token).not.toBe(
        result2.success && result2.token
      );
    });

    it('should set correct expiration time', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);
      const beforeTime = Date.now();

      const result = await lock.acquire('test-key', 5000);

      const afterTime = Date.now();
      const expectedExpiration = beforeTime + 5000;
      if (!result.success) {
        throw new Error('Lock acquisition failed or expiresAt is undefined');
      }
      const actualExpiration = result.expiresAt.getTime();

      // Allow for small timing differences
      expect(actualExpiration).toBeGreaterThanOrEqual(expectedExpiration);
      expect(actualExpiration).toBeLessThanOrEqual(afterTime + 5000);
    });

    it('should throw InvalidParameterError for invalid key', async () => {
      await expect(lock.acquire('', 5000)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.acquire('', 5000)).rejects.toThrow(
        'Invalid key: expected non-empty string'
      );
      await expect(
        lock.acquire(null as unknown as string, 5000)
      ).rejects.toThrow(InvalidParameterError);
      await expect(
        lock.acquire(undefined as unknown as string, 5000)
      ).rejects.toThrow(InvalidParameterError);
      await expect(lock.acquire('   ', 5000)).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should throw InvalidParameterError for invalid TTL', async () => {
      await expect(lock.acquire('test-key', 0)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.acquire('test-key', 0)).rejects.toThrow(
        'Invalid ttlMs: expected positive integer'
      );
      await expect(lock.acquire('test-key', -1000)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.acquire('test-key', 1.5)).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should handle Redis connection errors', async () => {
      const redisError = new Error('Redis connection failed');
      (mockRedisClient.eval).mockRejectedValue(redisError);

      await expect(lock.acquire('test-key', 5000)).rejects.toThrow(
        RedisConnectionError
      );
      await expect(lock.acquire('test-key', 5000)).rejects.toThrow(
        "Redis operation 'acquire' failed: Redis connection failed"
      );
    });

    it('should handle unknown Redis errors', async () => {
      (mockRedisClient.eval).mockRejectedValue('Unknown error');

      await expect(lock.acquire('test-key', 5000)).rejects.toThrow(
        RedisConnectionError
      );
      await expect(lock.acquire('test-key', 5000)).rejects.toThrow(
        "Redis operation 'acquire' failed: Unknown error"
      );
    });
  });

  describe('release', () => {
    let lock: RedisLock;

    beforeEach(() => {
      lock = new RedisLock(mockRedisClient);
      vi.clearAllMocks();
    });

    it('should successfully release a lock with valid token', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      const result = await lock.release('test-key', 'valid-token');

      expect(result).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("GET", KEYS[1])'),
        {
          keys: ['test-key'],
          arguments: ['valid-token'],
        }
      );
    });

    it('should fail to release lock with invalid token', async () => {
      (mockRedisClient.eval).mockResolvedValue(0);

      const result = await lock.release('test-key', 'invalid-token');

      expect(result).toBe(false);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("GET", KEYS[1])'),
        {
          keys: ['test-key'],
          arguments: ['invalid-token'],
        }
      );
    });

    it('should fail to release non-existent lock', async () => {
      (mockRedisClient.eval).mockResolvedValue(0);

      const result = await lock.release('non-existent-key', 'some-token');

      expect(result).toBe(false);
    });

    it('should use the correct Lua script', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      await lock.release('test-key', 'token');

      const calledScript = (mockRedisClient.eval).mock.calls[0][0];
      expect(calledScript).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
      expect(calledScript).toContain('redis.call("DEL", KEYS[1])');
      expect(calledScript).toContain('return 0');
    });

    it('should throw InvalidParameterError for invalid key', async () => {
      await expect(lock.release('', 'token')).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.release('', 'token')).rejects.toThrow(
        'Invalid key: expected non-empty string'
      );
      await expect(
        lock.release(null as unknown as string, 'token')
      ).rejects.toThrow(InvalidParameterError);
      await expect(
        lock.release(undefined as unknown as string, 'token')
      ).rejects.toThrow(InvalidParameterError);
      await expect(lock.release('   ', 'token')).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should throw InvalidParameterError for invalid token', async () => {
      await expect(lock.release('test-key', '')).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.release('test-key', '')).rejects.toThrow(
        'Invalid token: expected non-empty string'
      );
      await expect(
        lock.release('test-key', null as unknown as string)
      ).rejects.toThrow(InvalidParameterError);
      await expect(
        lock.release('test-key', undefined as unknown as string)
      ).rejects.toThrow(InvalidParameterError);
      await expect(lock.release('test-key', '   ')).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should handle Redis connection errors', async () => {
      const redisError = new Error('Redis connection failed');
      (mockRedisClient.eval).mockRejectedValue(redisError);

      await expect(lock.release('test-key', 'token')).rejects.toThrow(
        RedisConnectionError
      );
      await expect(lock.release('test-key', 'token')).rejects.toThrow(
        "Redis operation 'release' failed: Redis connection failed"
      );
    });

    it('should handle unknown Redis errors', async () => {
      (mockRedisClient.eval).mockRejectedValue('Unknown error');

      await expect(lock.release('test-key', 'token')).rejects.toThrow(
        RedisConnectionError
      );
      await expect(lock.release('test-key', 'token')).rejects.toThrow(
        "Redis operation 'release' failed: Unknown error"
      );
    });
  });

  describe('extend', () => {
    let lock: RedisLock;

    beforeEach(() => {
      lock = new RedisLock(mockRedisClient);
      vi.clearAllMocks();
    });

    it('should successfully extend a lock with valid token', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      const result = await lock.extend('test-key', 'valid-token', 10000);

      expect(result).toBe(true);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("GET", KEYS[1])'),
        {
          keys: ['test-key'],
          arguments: ['valid-token', '10000'],
        }
      );
    });

    it('should fail to extend lock with invalid token', async () => {
      (mockRedisClient.eval).mockResolvedValue(0);

      const result = await lock.extend('test-key', 'invalid-token', 10000);

      expect(result).toBe(false);
      expect(mockRedisClient.eval).toHaveBeenCalledWith(
        expect.stringContaining('redis.call("GET", KEYS[1])'),
        {
          keys: ['test-key'],
          arguments: ['invalid-token', '10000'],
        }
      );
    });

    it('should fail to extend non-existent lock', async () => {
      (mockRedisClient.eval).mockResolvedValue(0);

      const result = await lock.extend('non-existent-key', 'some-token', 5000);

      expect(result).toBe(false);
    });

    it('should use TTL in milliseconds correctly', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      // Test various TTL values in milliseconds
      await lock.extend('test-key', 'token', 1000); // 1 second
      expect(mockRedisClient.eval).toHaveBeenLastCalledWith(
        expect.any(String),
        {
          keys: ['test-key'],
          arguments: ['token', '1000'],
        }
      );

      await lock.extend('test-key', 'token', 1500); // 1.5 seconds
      expect(mockRedisClient.eval).toHaveBeenLastCalledWith(
        expect.any(String),
        {
          keys: ['test-key'],
          arguments: ['token', '1500'],
        }
      );

      await lock.extend('test-key', 'token', 30000); // 30 seconds
      expect(mockRedisClient.eval).toHaveBeenLastCalledWith(
        expect.any(String),
        {
          keys: ['test-key'],
          arguments: ['token', '30000'],
        }
      );
    });

    it('should use the correct Lua script', async () => {
      (mockRedisClient.eval).mockResolvedValue(1);

      await lock.extend('test-key', 'token', 5000);

      const calledScript = (mockRedisClient.eval).mock.calls[0][0];
      expect(calledScript).toContain('redis.call("GET", KEYS[1]) == ARGV[1]');
      expect(calledScript).toContain('redis.call("PEXPIRE", KEYS[1], ARGV[2])');
      expect(calledScript).toContain('return 0');
    });

    it('should throw InvalidParameterError for invalid key', async () => {
      await expect(lock.extend('', 'token', 5000)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.extend('', 'token', 5000)).rejects.toThrow(
        'Invalid key: expected non-empty string'
      );
      await expect(
        lock.extend(null as unknown as string, 'token', 5000)
      ).rejects.toThrow(InvalidParameterError);
      await expect(
        lock.extend(undefined as unknown as string, 'token', 5000)
      ).rejects.toThrow(InvalidParameterError);
      await expect(lock.extend('   ', 'token', 5000)).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should throw InvalidParameterError for invalid token', async () => {
      await expect(lock.extend('test-key', '', 5000)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.extend('test-key', '', 5000)).rejects.toThrow(
        'Invalid token: expected non-empty string'
      );
      await expect(
        lock.extend('test-key', null as unknown as string, 5000)
      ).rejects.toThrow(InvalidParameterError);
      await expect(
        lock.extend('test-key', undefined as unknown as string, 5000)
      ).rejects.toThrow(InvalidParameterError);
      await expect(lock.extend('test-key', '   ', 5000)).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should throw InvalidParameterError for invalid TTL', async () => {
      await expect(lock.extend('test-key', 'token', 0)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.extend('test-key', 'token', 0)).rejects.toThrow(
        'Invalid ttlMs: expected positive integer'
      );
      await expect(lock.extend('test-key', 'token', -1000)).rejects.toThrow(
        InvalidParameterError
      );
      await expect(lock.extend('test-key', 'token', 1.5)).rejects.toThrow(
        InvalidParameterError
      );
    });

    it('should handle Redis connection errors', async () => {
      const redisError = new Error('Redis connection failed');
      (mockRedisClient.eval).mockRejectedValue(redisError);

      await expect(lock.extend('test-key', 'token', 5000)).rejects.toThrow(
        RedisConnectionError
      );
      await expect(lock.extend('test-key', 'token', 5000)).rejects.toThrow(
        "Redis operation 'extend' failed: Redis connection failed"
      );
    });

    it('should handle unknown Redis errors', async () => {
      (mockRedisClient.eval).mockRejectedValue('Unknown error');

      await expect(lock.extend('test-key', 'token', 5000)).rejects.toThrow(
        RedisConnectionError
      );
      await expect(lock.extend('test-key', 'token', 5000)).rejects.toThrow(
        "Redis operation 'extend' failed: Unknown error"
      );
    });
  });
});
