/**
 * @fileoverview Redis-based distributed lock library for Node.js
 *
 * This library provides both single-instance and distributed (Redlock) implementations
 * of Redis-based locking. Choose the appropriate implementation based on your needs:
 *
 * - **RedisLock**: Simple, fast locking for single Redis instance deployments
 * - **Redlock**: Distributed locking across multiple Redis instances with stronger safety guarantees
 *
 * @example Distributed locking with manual acquire/release
 * ```typescript
 * import { createClient } from 'redis';
 * import { Redlock } from '@redis-kit/lock';
 *
 * // Set up multiple Redis instances (or single instance)
 * const clients = [
 *   createClient({ host: 'redis1.example.com' }),
 *   createClient({ host: 'redis2.example.com' }),
 *   createClient({ host: 'redis3.example.com' })
 * ];
 *
 * await Promise.all(clients.map(client => client.connect()));
 *
 * const redlock = new Redlock(clients);
 * const lock = await redlock.acquire('my-resource', 30000);
 *
 * if (lock) {
 *   try {
 *     // Critical section
 *     console.log('Working with exclusive access');
 *
 *     // Optional: start auto-extension
 *     lock.startAutoExtension(5000); // extend 5 seconds before expiry
 *   } finally {
 *     await lock.release();
 *   }
 * }
 * ```
 *
 * @example Distributed locking with withLock (Redlock)
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
 * const result = await redlock.withLock('my-resource', 30000, async () => {
 *   console.log('Distributed lock acquired with automatic management');
 *
 *   // Long-running operation - lock is automatically managed
 *   for (let i = 0; i < 100; i++) {
 *     await processItem(i);
 *   }
 *
 *   return 'processing completed';
 * }, { extensionThresholdMs: 5000 }); // Auto-extend 5 seconds before expiry
 * ```
 *
 * @packageDocumentation
 */

// Distributed lock implementation (Redlock algorithm)
export { Redlock, type RedlockInstance } from './redlock.js';
export type { RedlockOptions } from './types.js';

// Common error classes
export { RedisConnectionError, InvalidParameterError } from './errors.js';
