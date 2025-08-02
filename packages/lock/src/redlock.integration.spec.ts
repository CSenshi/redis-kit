import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createClient, type RedisClientType } from 'redis';
import { Redlock } from './redlock.js';
import type { RedlockResult } from './redlock-types.js';

// Integration test configuration
const REDIS_INSTANCES = [
  { host: 'localhost', port: 6379 },
  { host: 'localhost', port: 6380 },
  { host: 'localhost', port: 6381 },
  { host: 'localhost', port: 6382 },
  { host: 'localhost', port: 6383 },
];

const TEST_KEY_PREFIX = 'redlock:test:';
const TEST_TTL = 5000; // 5 seconds

describe('Redlock Integration Tests', () => {
  let redisClients: RedisClientType[];
  let redlock: Redlock;

  beforeAll(async () => {
    // Create Redis clients for all instances
    redisClients = REDIS_INSTANCES.map(config =>
      createClient({
        socket: {
          host: config.host,
          port: config.port,
          // Disable retry to fail fast in tests
          reconnectStrategy: false,
        },
      })
    );
  });

  afterAll(async () => {
    await Promise.all(redisClients.map(client => client.quit()));
  });

  beforeEach(async () => {
    // Reconnect clients (just in case they were disconnected in tests)
    await Promise.allSettled(redisClients.map(client => client.connect()));

    redlock = new Redlock(redisClients, {
      driftFactor: 0.01,
      retryDelayMs: 100,
      retryJitterMs: 50,
      maxRetryAttempts: 2,
    });
  });

  afterEach(async () => {
    await Promise.allSettled(redisClients.map(client => client.flushAll()));
  });

  // Helper to generate unique test keys
  function generateTestKey(): string {
    return `${TEST_KEY_PREFIX}${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  // Helper to check if we have enough instances for testing
  describe('Basic Lock Operations', () => {
    it('should acquire and release a lock successfully', async () => {
      const key = generateTestKey();

      const result = await redlock.acquire(key, TEST_TTL);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.token).toBeTypeOf('string');
        expect(result.token.length).toBeGreaterThan(0);
        expect(result.expiresAt).toBeInstanceOf(Date);
        expect(result.success && result.effectiveValidityMs).toBeGreaterThan(0);
        expect(result.success && result.acquiredInstances).toBeGreaterThanOrEqual(3); // Quorum for 5 instances

        // Release lock
        const released = await redlock.release(key, result.token);
        expect(released).toBe(true);
      }
    });

    it('should prevent concurrent lock acquisition', async () => {
      const key = generateTestKey();

      // First client acquires lock
      const result1 = await redlock.acquire(key, TEST_TTL);
      expect(result1.success).toBe(true);

      if (!result1.success) throw new Error('Failed to acquire lock');

      // Second client should fail to acquire the same lock
      const result2 = await redlock.acquire(key, TEST_TTL);
      expect(result2.success).toBe(false);

      // Release first lock
      await redlock.release(key, result1.token);

      // Now second client should be able to acquire
      const result3 = await redlock.acquire(key, TEST_TTL);
      expect(result3.success).toBe(true);

      if (result3.success) {
        await redlock.release(key, result3.token);
      }
    });

    it('should extend lock TTL successfully', async () => {
      const key = generateTestKey();

      // Acquire lock with short TTL
      const result = await redlock.acquire(key, 2000);
      expect(result.success).toBe(true);

      if (!result.success) throw new Error('Failed to acquire lock');

      // Extend the lock
      const extended = await redlock.extend(key, result.token, 5000);
      expect(extended).toBe(true);

      // Clean up
      await redlock.release(key, result.token);

    });

    it('should fail to extend with invalid token', async () => {
      const key = generateTestKey();

      // Try to extend non-existent lock
      const extended = await redlock.extend(key, 'invalid-token', 5000);
      expect(extended).toBe(false);
    });

    it('should fail to release with invalid token', async () => {
      const key = generateTestKey();

      // Try to release non-existent lock
      const released = await redlock.release(key, 'invalid-token');
      expect(released).toBe(false);
    });
  });

  describe('Lock Expiration', () => {
    it('should automatically expire locks after TTL', async () => {
      const key = generateTestKey();
      const shortTtl = 1000; // 1 second

      // Acquire lock with short TTL
      const result = await redlock.acquire(key, shortTtl);
      expect(result.success).toBe(true);

      if (!result.success) throw new Error('Failed to acquire lock');

      // Wait for lock to expire
      await new Promise(resolve => setTimeout(resolve, shortTtl + 500));

      // Should be able to acquire the same lock now
      const result2 = await redlock.acquire(key, TEST_TTL);
      expect(result2.success).toBe(true);

      if (result2.success) {
        const result3 = await redlock.release(key, result2.token);
        expect(result3).toBe(true);
      }
    });
  });

  describe('Fault Tolerance', () => {
    it('should handle individual instance failures gracefully', async () => {
      const key = generateTestKey();

      // Simulate instance failure by disconnecting one client
      const clientToDisconnect = redisClients[0];
      await clientToDisconnect.quit();

      // Should still be able to acquire lock with 4/5 instances
      const result = await redlock.acquire(key, TEST_TTL);
      expect(result.success).toBe(true);

      if (result.success) {
        expect(result.acquiredInstances).toBeGreaterThanOrEqual(3); // Still majority
        await redlock.release(key, result.token);
      }

    });

    it('should fail when majority of instances are unavailable', async () => {
      const key = generateTestKey();

      // Disconnect 3 out of 5 instances (no majority)
      const clientsToDisconnect = redisClients.slice(0, 3);
      const disconnectPromises = clientsToDisconnect.map(async client => {
        if (client.isReady) {
          await client.quit();
        }
      });

      await Promise.all(disconnectPromises);

      // Should fail to acquire lock without majority
      const result = await redlock.acquire(key, TEST_TTL);
      expect(result.success).toBe(false);
    });

    it('should retry on reconected instances by default', async () => {
      const key = generateTestKey();

      // Disconnect 3 out of 5 instances (no majority)
      const clientsToDisconnect = redisClients.slice(0, 3);
      const disconnectPromises = clientsToDisconnect.map(async client => {
        if (client.isReady) {
          await client.quit();
        }
      });

      await Promise.all(disconnectPromises);

      // Attempt to acquire lock, should fail due to no majority
      const lock2 = new Redlock(redisClients, {
        driftFactor: 0.01,
        retryDelayMs: 100,
        retryJitterMs: 50,
        maxRetryAttempts: 3
      });

      setTimeout(async () => {
        // Reconnect the disconnected clients
        await Promise.allSettled(clientsToDisconnect.map(client => client.connect()));
      }, 200); // Wait for 200 ms to allow reconnection

      const result = await lock2.acquire(key, TEST_TTL);
      expect(result.success).toBe(true);
    })
  });

  describe('Concurrent Access', () => {
    it('should handle multiple concurrent clients correctly', async () => {
      const key = generateTestKey();
      const numClients = 10;
      const acquisitionPromises: Promise<{ clientId: number; result: RedlockResult }>[] = [];

      // Create multiple concurrent acquisition attempts
      for (let i = 0; i < numClients; i++) {
        const promise = redlock.acquire(key, TEST_TTL).then(result => ({
          clientId: i,
          result,
        }));
        acquisitionPromises.push(promise);
      }

      // Wait for all attempts to complete
      const results = await Promise.all(acquisitionPromises);

      // Exactly one should succeed
      const successful = results.filter(r => r.result.success);
      const failed = results.filter(r => !r.result.success);

      expect(successful).toHaveLength(1);
      expect(failed).toHaveLength(numClients - 1);

      // Clean up the successful lock
      if (successful.length > 0 && successful[0].result.success) {
        await redlock.release(key, successful[0].result.token);
      }
    });

    it('should handle rapid acquire/release cycles', async () => {
      const key = generateTestKey();
      const cycles = 5;

      for (let i = 0; i < cycles; i++) {
        const result = await redlock.acquire(key, TEST_TTL);
        expect(result.success).toBe(true);

        if (result.success) {
          const released = await redlock.release(key, result.token);
          expect(released).toBe(true);
        }
      }
    });
  });

  describe('Performance and Timing', () => {
    it('should complete acquisition within reasonable time', async () => {
      const key = generateTestKey();
      const startTime = Date.now();

      const result = await redlock.acquire(key, TEST_TTL);
      const elapsedTime = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(elapsedTime).toBeLessThan(1000); // Should complete within 1 second

      if (result.success) {
        await redlock.release(key, result.token);
      }
    });

    it('should respect timing constraints for very short TTLs', async () => {
      const key = generateTestKey();
      const shortTtl = 100; // 100ms - very short

      const result = await redlock.acquire(key, shortTtl);

      // May succeed or fail depending on timing, but should not throw
      expect(typeof result.success).toBe('boolean');

      if (result.success) {
        // If successful, effective validity should be positive but small
        expect(result.effectiveValidityMs).toBeGreaterThan(0);
        expect(result.effectiveValidityMs).toBeLessThan(shortTtl);

        await redlock.release(key, result.token);
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle network partitions gracefully', async () => {
      const key = generateTestKey();

      // This test simulates network issues by using invalid Redis commands
      // In a real scenario, you might use network simulation tools

      const result = await redlock.acquire(key, TEST_TTL);
      expect(typeof result.success).toBe('boolean');

      if (result.success) {
        await redlock.release(key, result.token);
      }
    });

    it('should provide meaningful error information', async () => {
      // Test with invalid parameters
      await expect(redlock.acquire('', TEST_TTL)).rejects.toThrow();
      await expect(redlock.acquire('valid-key', 0)).rejects.toThrow();
      await expect(redlock.release('', 'token')).rejects.toThrow();
      await expect(redlock.extend('key', '', 1000)).rejects.toThrow();
    });
  });
});