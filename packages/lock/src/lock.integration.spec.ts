import { createClient, RedisClientType } from 'redis';
import { RedisLock } from './lock.js';

// Helper function to parse REDIS_HOSTS environment variable
function getRedisConfig(): Array<{ host: string; port: number }> {
  const redisHosts = process.env.REDIS_HOSTS ?? 'localhost,localhost,localhost,localhost,localhost';
  const redisPorts = process.env.REDIS_PORTS ?? '6379,6380,6381,6382,6383';

  const hosts = redisHosts.split(',').map(host => host.trim());
  const ports = redisPorts.split(',').map(port => parseInt(port.trim(), 10));
  if (hosts.length !== ports.length) {
    throw new Error('REDIS_HOSTS and REDIS_PORTS must have the same number of entries');
  }

  return hosts.map((host, index) => ({
    host,
    port: ports[index],
  }));
}


test.concurrent('Integration tests', () => {
  // Integration tests require a running Redis instance
  // These tests can be skipped if Redis is not available
  describe('RedisLock Integration Tests', () => {
    let redisClient: RedisClientType;
    let lock: RedisLock;

    beforeAll(async () => {
      const config = getRedisConfig();
      const firstConfig = config[0];
      if (!firstConfig) {
        throw new Error('No Redis configuration found. Please set REDIS_HOSTS and REDIS_PORTS environment variables.');
      }
      redisClient = createClient({
        socket: {
          host: firstConfig.host,
          port: firstConfig.port,
        },
      });

      await redisClient.connect();
      lock = new RedisLock(redisClient);
    });

    afterAll(async () => {
      await redisClient.quit();
    });

    beforeEach(async () => {
      await redisClient.flushAll();
    });

    describe('Lock Acquisition', () => {
      it('should acquire a lock successfully', async () => {
        const result = await lock.acquire('test:lock1', 5000);

        if (!result.success) throw new Error('Lock acquisition failed');
        expect(result.token).toBeDefined();
        expect(result.expiresAt).toBeInstanceOf(Date);

        // Verify the lock exists in Redis
        const value = await redisClient.get('test:lock1');
        expect(value).toBe(result.token);

        // Verify TTL is set
        const ttl = await redisClient.pTTL('test:lock1');
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(5000);
      });

      it('should fail to acquire an already held lock', async () => {
        // First acquisition should succeed
        const result1 = await lock.acquire('test:lock2', 5000);
        expect(result1.success).toBe(true);

        // Second acquisition should fail
        const result2 = await lock.acquire('test:lock2', 5000);
        expect(result2.success).toBe(false);
      });

      it('should acquire lock after previous one expires', async () => {
        // Acquire lock with very short TTL
        const result1 = await lock.acquire('test:lock3', 100);
        expect(result1.success).toBe(true);

        // Wait for lock to expire
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Should be able to acquire again
        const result2 = await lock.acquire('test:lock3', 5000);
        expect(result2.success).toBe(true);
        if (!result2.success || !result1.success)
          throw new Error('Lock acquisition failed');
        expect(result2.token).not.toBe(result1.token);
      });
    });

    describe('Lock Release', () => {
      it('should release a lock with valid token', async () => {
        // Acquire lock
        const result = await lock.acquire('test:lock4', 5000);
        expect(result.success).toBe(true);

        // Release lock
        if (!result.success) throw new Error('Lock acquisition failed');
        const released = await lock.release('test:lock4', result.token);
        expect(released).toBe(true);

        // Verify lock is gone from Redis
        const value = await redisClient.get('test:lock4');
        expect(value).toBeNull();

        // Should be able to acquire again immediately
        const result2 = await lock.acquire('test:lock4', 5000);
        expect(result2.success).toBe(true);
      });

      it('should fail to release lock with invalid token', async () => {
        // Acquire lock
        const result = await lock.acquire('test:lock5', 5000);
        expect(result.success).toBe(true);

        // Try to release with wrong token
        const released = await lock.release('test:lock5', 'wrong-token');
        expect(released).toBe(false);

        // Verify lock still exists
        if (!result.success) throw new Error('Lock acquisition failed');
        const value = await redisClient.get('test:lock5');
        expect(value).toBe(result.token);
      });

      it('should fail to release non-existent lock', async () => {
        const released = await lock.release('test:nonexistent', 'some-token');
        expect(released).toBe(false);
      });
    });

    describe('Lock Extension', () => {
      it('should extend a lock with valid token', async () => {
        // Acquire lock
        const key = `test:lock:${Math.ceil(Math.random() * 100000)}`;
        const result = await lock.acquire(key, 1000);
        expect(result.success).toBe(true);

        // Get initial TTL
        const initialTtl = await redisClient.pTTL(key);

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Extend lock
        if (!result.success) throw new Error('Lock acquisition failed');
        const extended = await lock.extend(key, result.token, 5000);
        expect(extended).toBe(true);

        // Verify TTL was updated
        const newTtl = await redisClient.pTTL(key);
        expect(newTtl).toBeGreaterThan(initialTtl);
        expect(newTtl).toBeLessThanOrEqual(5000);
      });

      it('should fail to extend lock with invalid token', async () => {
        // Acquire lock
        const result = await lock.acquire('test:lock7', 5000);
        expect(result.success).toBe(true);

        // Try to extend with wrong token
        const extended = await lock.extend('test:lock7', 'wrong-token', 10000);
        expect(extended).toBe(false);

        // Verify original TTL is unchanged
        const ttl = await redisClient.pTTL('test:lock7');
        expect(ttl).toBeLessThanOrEqual(5000);
      });

      it('should fail to extend non-existent lock', async () => {
        const extended = await lock.extend(
          'test:nonexistent',
          'some-token',
          5000
        );
        expect(extended).toBe(false);
      });
    });

    describe('TTL Expiration Behavior', () => {
      it('should automatically clean up expired locks', async () => {
        // Acquire lock with short TTL
        const result = await lock.acquire('test:lock8', 200);
        expect(result.success).toBe(true);

        // Verify lock exists
        if (!result.success) throw new Error('Lock acquisition failed');
        let value = await redisClient.get('test:lock8');
        expect(value).toBe(result.token);

        // Wait for expiration
        await new Promise((resolve) => setTimeout(resolve, 250));

        // Verify lock is gone
        value = await redisClient.get('test:lock8');
        expect(value).toBeNull();
      });

      it('should handle operations on expired locks correctly', async () => {
        // Acquire lock with short TTL
        const result = await lock.acquire('test:lock9', 100);
        expect(result.success).toBe(true);

        // Wait for expiration
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Try to release expired lock
        if (!result.success) throw new Error('Lock acquisition failed');

        const released = await lock.release('test:lock9', result.token);
        expect(released).toBe(false);

        // Try to extend expired lock
        const extended = await lock.extend('test:lock9', result.token, 5000);
        expect(extended).toBe(false);
      });
    });

    describe('Lua Script Execution', () => {
      it('should execute acquire script atomically', async () => {
        // This test verifies that the Lua script is executed atomically
        // by checking that the lock is either fully acquired or not at all
        const promises = Array.from({ length: 10 }, (_, i) =>
          lock.acquire(`test:atomic${i}`, 5000)
        );

        const results = await Promise.all(promises);

        // All should succeed since they're different keys
        results.forEach((result) => {
          if (!result.success) throw new Error('Lock acquisition failed');

          expect(result.success).toBe(true);
          expect(result.token).toBeDefined();
        });
      });

      it('should execute release script atomically', async () => {
        // Acquire multiple locks
        const locks = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            lock.acquire(`test:release${i}`, 5000)
          )
        );

        // Release all locks
        const releases = await Promise.all(
          locks.map((lockResult, i) => {
            if (!lockResult.success) throw new Error('Lock acquisition failed');

            return lock.release(`test:release${i}`, lockResult.token);
          })
        );

        // All releases should succeed
        releases.forEach((released) => {
          expect(released).toBe(true);
        });

        // Verify all locks are gone
        for (let i = 0; i < 5; i++) {
          const value = await redisClient.get(`test:release${i}`);
          expect(value).toBeNull();
        }
      });

      it('should execute extend script atomically', async () => {
        // Acquire multiple locks
        const locks = await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            lock.acquire(`test:extend${i}`, 1000)
          )
        );

        // Extend all locks
        const extensions = await Promise.all(
          locks.map((lockResult, i) => {
            if (!lockResult.success) throw new Error('Lock acquisition failed');

            return lock.extend(`test:extend${i}`, lockResult.token, 5000);
          })
        );

        // All extensions should succeed
        extensions.forEach((extended) => {
          expect(extended).toBe(true);
        });

        // Verify all locks have extended TTL
        for (let i = 0; i < 5; i++) {
          const ttl = await redisClient.pTTL(`test:extend${i}`);
          expect(ttl).toBeGreaterThan(1000);
          expect(ttl).toBeLessThanOrEqual(5000);
        }
      });
    });
  });
});
