/**
 * Result of a lock acquisition attempt.
 *
 * @public
 */
export type LockResult =
  | {
      /** The lock was successfully acquired */
      success: true;
      /**
       * The unique lock token for this acquisition.
       * This token must be used for subsequent release or extend operations.
       */
      token: string;
      /** When the lock expires */
      expiresAt: Date;
    }
  | {
      /** The lock could not be acquired (already held by another process) */
      success: false;
    };

/**
 * Configuration options for RedisLock.
 *
 * @public
 */
export interface RedisLockOptions {
  /**
   * Default TTL in milliseconds for locks when not specified in acquire().
   * Must be a positive integer.
   * @defaultValue 30000 (30 seconds)
   */
  defaultTtlMs?: number;

  /**
   * Length of generated tokens in characters.
   * Longer tokens provide better security but use more memory.
   * Must be a positive integer.
   * @defaultValue 22 characters
   */
  tokenLength?: number;
}
