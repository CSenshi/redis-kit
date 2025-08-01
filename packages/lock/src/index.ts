/**
 * @fileoverview Redis-based distributed lock library for Node.js
 *
 * This library provides a simple, correct implementation of distributed locking
 * using Redis as the coordination service. It follows Redis's recommended
 * "Correct Implementation with a Single Instance" pattern.
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
 * const result = await lock.acquire('my-resource', 30000);
 *
 * if (result.success) {
 *   try {
 *     // Critical section
 *     console.log('Working with exclusive access');
 *   } finally {
 *     await lock.release('my-resource', result.token);
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

// Main classes and interfaces
export { RedisLock } from './lock.js';
export type { LockResult, RedisLockOptions } from './types.js';

// Error classes for error handling
export { RedisConnectionError, InvalidParameterError } from './errors.js';
