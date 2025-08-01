import type { RedisClientType } from 'redis';
import { LockResult, RedisLockOptions } from './types.js';
import { ACQUIRE_SCRIPT, RELEASE_SCRIPT, EXTEND_SCRIPT } from './scripts.js';
import { generateToken } from './token.js';
import { RedisConnectionError, InvalidParameterError } from './errors.js';

/**
 * Redis-based single instance lock implementation.
 * 
 * Provides simple, correct locking for single Redis instance deployments following
 * Redis's recommended "Correct Implementation with a Single Instance" pattern.
 * 
 * Features:
 * - Atomic lock operations using Lua scripts
 * - Automatic lock expiration to prevent deadlocks
 * - Cryptographically secure lock tokens
 * - Support for lock extension
 * - Comprehensive error handling
 * 
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 * import { RedisLock } from '@redis-kit/lock';
 * 
 * const redis = createClient();
 * await redis.connect();
 * 
 * const lock = new RedisLock(redis);
 * 
 * // Acquire a lock
 * const result = await lock.acquire('my-resource', 30000);
 * if (result.success) {
 *   try {
 *     // Do work while holding the lock
 *     console.log('Lock acquired:', result.token);
 *     
 *     // Optionally extend the lock
 *     await lock.extend('my-resource', result.token, 60000);
 *   } finally {
 *     // Always release the lock
 *     await lock.release('my-resource', result.token);
 *   }
 * }
 * ```
 * 
 * @public
 */
export class RedisLock {
  private readonly options: Required<RedisLockOptions>;

  /**
   * Creates a new RedisLock instance.
   * 
   * @param redisClient - Redis client instance from node-redis v5. Must be connected.
   * @param options - Configuration options for the lock behavior.
   * 
   * @throws {@link InvalidParameterError} When redisClient is null/undefined or options are invalid.
   * 
   * @example
   * ```typescript
   * import { createClient } from 'redis';
   * import { RedisLock } from '@redis-kit/lock';
   * 
   * const redis = createClient();
   * await redis.connect();
   * 
   * const lock = new RedisLock(redis, {
   *   defaultTtlMs: 60000,  // 1 minute default TTL
   *   tokenLength: 32       // 32-character tokens
   * });
   * ```
   */
  constructor(private readonly redisClient: RedisClientType, options: RedisLockOptions = {}) {
    if (!redisClient || !redisClient.isReady) {
      throw new InvalidParameterError('redisClient', redisClient, 'connected Redis client');
    }

    this.options = {
      defaultTtlMs: options.defaultTtlMs ?? 30000, // 30 seconds default
      tokenLength: options.tokenLength ?? 22, // 22 characters by default
    };

    // Validate options
    this.validateTtl(this.options.defaultTtlMs);

    if (!Number.isInteger(this.options.tokenLength) || this.options.tokenLength <= 0) {
      throw new InvalidParameterError('tokenLength', this.options.tokenLength, 'positive integer');
    }
  }

  /**
   * Attempts to acquire a lock on the specified key.
   * 
   * This operation is atomic and will either succeed completely or fail without
   * side effects. If successful, the lock will automatically expire after the
   * specified TTL to prevent deadlocks.
   * 
   * @param key - Unique identifier for the lock. Must be a non-empty string.
   * @param ttlMs - Time-to-live in milliseconds. If not specified, uses defaultTtlMs.
   *                Must be a positive integer within reasonable bounds.
   * 
   * @returns Promise that resolves to a {@link LockResult} indicating success or failure.
   * 
   * @throws {@link InvalidParameterError} When key or ttlMs parameters are invalid.
   * @throws {@link RedisConnectionError} When Redis operation fails due to connection issues.
   * 
   * @example
   * ```typescript
   * // Acquire lock with custom TTL
   * const result = await lock.acquire('user:123', 30000);
   * if (result.success) {
   *   console.log('Lock acquired, expires at:', result.expiresAt);
   *   // Use result.token for release/extend operations
   * } else {
   *   console.log('Lock is already held by another process');
   * }
   * 
   * // Acquire lock with default TTL
   * const result2 = await lock.acquire('resource:abc');
   * ```
   */
  async acquire(key: string, ttlMs?: number): Promise<LockResult> {
    this.validateKey(key);

    const effectiveTtlMs = ttlMs ?? this.options.defaultTtlMs;
    this.validateTtl(effectiveTtlMs);

    try {
      // Generate a unique token for this lock
      const token = generateToken(this.options.tokenLength);

      // Use Lua script to atomically acquire lock with TTL in milliseconds
      const result = (await this.redisClient.eval(ACQUIRE_SCRIPT, {
        keys: [key],
        arguments: [token, effectiveTtlMs.toString()],
      })) as number;

      if (result === 1) {
        // Lock acquired successfully
        const expiresAt = new Date(Date.now() + effectiveTtlMs);
        return {
          success: true,
          token,
          expiresAt,
        };
      } else {
        // Lock already exists (held by another process)
        return {
          success: false,
        };
      }
    } catch (error) {
      // Handle Redis connection or operation errors
      throw new RedisConnectionError(
        'acquire',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Releases a lock using the provided token.
   * 
   * This operation is atomic and uses a Lua script to verify token ownership
   * before releasing the lock. Only the process that acquired the lock (with
   * the correct token) can release it.
   * 
   * @param key - The lock key that was used during acquisition.
   * @param token - The token returned from a successful acquire() call.
   * 
   * @returns Promise that resolves to true if the lock was released,
   *          false if the token was invalid or the lock doesn't exist.
   * 
   * @throws {@link InvalidParameterError} When key or token parameters are invalid.
   * @throws {@link RedisConnectionError} When Redis operation fails due to connection issues.
   * 
   * @example
   * ```typescript
   * const result = await lock.acquire('my-lock', 30000);
   * if (result.success) {
   *   try {
   *     // Do work...
   *   } finally {
   *     const released = await lock.release('my-lock', result.token);
   *     if (released) {
   *       console.log('Lock released successfully');
   *     } else {
   *       console.log('Failed to release lock (may have expired)');
   *     }
   *   }
   * }
   * ```
   */
  async release(key: string, token: string): Promise<boolean> {
    this.validateKey(key);
    this.validateToken(token);

    try {
      // Use Lua script to atomically verify ownership and delete
      const result = (await this.redisClient.eval(RELEASE_SCRIPT, {
        keys: [key],
        arguments: [token],
      })) as number;

      // Script returns 1 if lock was released, 0 if token didn't match
      return result === 1;
    } catch (error) {
      // Handle Redis connection or operation errors
      throw new RedisConnectionError(
        'release',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Extends the TTL of a lock using the provided token.
   * 
   * This operation is atomic and uses a Lua script to verify token ownership
   * before updating the lock's expiration time. Only the process that acquired
   * the lock (with the correct token) can extend it.
   * 
   * @param key - The lock key that was used during acquisition.
   * @param token - The token returned from a successful acquire() call.
   * @param ttlMs - New time-to-live in milliseconds from now.
   *                Must be a positive integer within reasonable bounds.
   * 
   * @returns Promise that resolves to true if the lock TTL was extended,
   *          false if the token was invalid or the lock doesn't exist.
   * 
   * @throws {@link InvalidParameterError} When parameters are invalid.
   * @throws {@link RedisConnectionError} When Redis operation fails due to connection issues.
   * 
   * @example
   * ```typescript
   * const result = await lock.acquire('long-task', 30000);
   * if (result.success) {
   *   // Start long-running task
   *   setTimeout(async () => {
   *     // Extend lock before it expires
   *     const extended = await lock.extend('long-task', result.token, 60000);
   *     if (extended) {
   *       console.log('Lock extended for another 60 seconds');
   *     } else {
   *       console.log('Failed to extend lock (may have expired)');
   *     }
   *   }, 25000);
   * }
   * ```
   */
  async extend(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.validateKey(key);
    this.validateToken(token);
    this.validateTtl(ttlMs);

    try {
      // Use Lua script to atomically verify ownership and update TTL in milliseconds
      const result = (await this.redisClient.eval(EXTEND_SCRIPT, {
        keys: [key],
        arguments: [token, ttlMs.toString()],
      })) as number;

      // Script returns 1 if lock was extended, 0 if token didn't match
      return result === 1;
    } catch (error) {
      // Handle Redis connection or operation errors
      throw new RedisConnectionError(
        'extend',
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  /**
   * Validates a lock key parameter
   * @private
   */
  private validateKey(key: string): void {
    if (!key || typeof key !== 'string' || key.trim().length === 0) {
      throw new InvalidParameterError('key', key, 'non-empty string');
    }
  }

  /**
   * Validates a lock token parameter
   * @private
   */
  private validateToken(token: string): void {
    if (!token || typeof token !== 'string' || token.trim().length === 0) {
      throw new InvalidParameterError('token', token, 'non-empty string');
    }
  }

  /**
   * Validates a TTL parameter
   * @private
   */
  private validateTtl(ttlMs: number): void {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new InvalidParameterError('ttlMs', ttlMs, 'positive integer');
    }
  }
}
