/**
 * @fileoverview Redis-based distributed lock library for Node.js
 *
 * This library provides both single-instance and distributed (Redlock) implementations
 * of Redis-based locking. Choose the appropriate implementation based on your needs:
 * 
 * - **RedisLock**: Simple, fast locking for single Redis instance deployments
 * - **Redlock**: Distributed locking across multiple Redis instances with stronger safety guarantees
 *
 * @example Single-instance locking
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
 * @example Distributed locking (Redlock)
 * ```typescript
 * import { createClient } from 'redis';
 * import { Redlock } from '@redis-kit/lock';
 *
 * // Set up multiple Redis instances
 * const clients = [
 *   createClient({ host: 'redis1.example.com' }),
 *   createClient({ host: 'redis2.example.com' }),
 *   createClient({ host: 'redis3.example.com' }),
 *   createClient({ host: 'redis4.example.com' }),
 *   createClient({ host: 'redis5.example.com' })
 * ];
 * 
 * await Promise.all(clients.map(client => client.connect()));
 * 
 * const redlock = new Redlock(clients);
 * const result = await redlock.acquire('my-resource', 30000);
 * 
 * if (result.success) {
 *   try {
 *     console.log(`Distributed lock acquired on ${result.acquiredInstances} instances`);
 *     // Critical section with stronger safety guarantees
 *   } finally {
 *     await redlock.release('my-resource', result.token);
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

// Single-instance lock implementation
export { RedisLock } from './lock.js';
export type { LockResult, RedisLockOptions } from './types.js';

// Distributed lock implementation (Redlock algorithm)
export { Redlock } from './redlock.js';
export type { RedlockOptions, RedlockResult } from './redlock-types.js';

// Common error classes
export { RedisConnectionError, InvalidParameterError } from './errors.js';

// Utility functions (for advanced usage)
export { generateToken } from './token.js';
export { ACQUIRE_SCRIPT, RELEASE_SCRIPT, EXTEND_SCRIPT } from './scripts.js';
