/**
 * Configuration options for Redlock distributed locking.
 */
export interface RedlockOptions {
  /** Clock drift compensation factor (default: 0.01) */
  driftFactor?: number;

  /** Base retry delay in milliseconds (default: 200) */
  retryDelayMs?: number;

  /** Random jitter added to retry delay (default: 100) */
  retryJitterMs?: number;

  /** Maximum retry attempts (default: 3) */
  maxRetryAttempts?: number;
}

/**
 * Result of a Redlock acquisition attempt.
 */
export type RedlockResult =
  | {
      /** The lock was successfully acquired */
      success: true;
      /** The unique lock token for this acquisition */
      token: string;
      /** When the lock expires */
      expiresAt: Date;
      /** Number of instances that granted the lock */
      acquiredInstances: number;
      /** Effective validity after drift compensation */
      effectiveValidityMs: number;
    }
  | {
      /** The lock could not be acquired */
      success: false;
    };
