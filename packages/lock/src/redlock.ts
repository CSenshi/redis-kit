import type { RedisClientType } from 'redis';
import { InvalidParameterError } from './errors.js';
import {
  ACQUIRE_SCRIPT,
  EXTEND_SCRIPT,
  RELEASE_SCRIPT,
} from './lua-scripts.js';
import { generateToken } from './token.js';
import type { RedlockOptions } from './types.js';

// Symbol for internal access control - only RedlockInstance can use this
/**
 * Internal interface for RedlockInstance to access private methods
 */
interface RedlockInternalAccess {
  release(key: string, token: string): Promise<boolean>;
  extend(key: string, token: string, ttlMs: number): Promise<boolean>;
}

const INTERNAL_ACCESS = Symbol.for('redlock-internal-access');

/**
 * Represents an individual distributed lock instance with self-managing lifecycle.
 *
 * This class encapsulates the state and behavior of a single distributed lock,
 * providing methods for release, extension, and auto-extension management.
 */
export class RedlockInstance {
  private _isReleased = false;
  private extensionTimer?: NodeJS.Timeout;
  private autoExtensionEnabled = false;
  private autoExtensionThresholdMs = 1000;

  constructor(
    private readonly redlock: Redlock,
    private readonly key: string,
    private readonly token: string,
    private expiresAt: Date,
    private readonly ttlMs: number,
  ) {
    this.validateConstructorParams();
  }

  /**
   * Whether this lock has been explicitly released.
   */
  get isReleased(): boolean {
    return this._isReleased;
  }

  /**
   * Whether this lock has expired based on its TTL.
   */
  get isExpired(): boolean {
    return Date.now() > this.expiresAt.getTime();
  }

  /**
   * Whether this lock is currently valid (not released and not expired).
   */
  get isValid(): boolean {
    return !this.isReleased && !this.isExpired;
  }

  /**
   * When this lock expires.
   */
  get expirationTime(): Date {
    return new Date(this.expiresAt.getTime());
  }

  /**
   * The resource key this lock protects.
   */
  get resourceKey(): string {
    return this.key;
  }

  /**
   * Releases this lock from all Redis instances.
   * This operation is idempotent - calling it multiple times is safe.
   *
   * @returns Promise resolving to true if the lock was released, false if it was already released
   */
  async release(): Promise<boolean> {
    if (this._isReleased) {
      return true; // Already released, idempotent operation
    }

    this._isReleased = true;
    this.stopAutoExtension();

    try {
      return await this.redlock[INTERNAL_ACCESS].release(this.key, this.token);
    } catch (error) {
      // Log error but don't throw - release should be best-effort
      console.warn(`Failed to release lock ${this.key}:`, error);
      return false;
    }
  }

  /**
   * Extends the TTL of this lock.
   * Requires majority consensus from Redis instances to succeed.
   *
   * @param newTtlMs Optional new TTL in milliseconds. If not provided, uses the original TTL.
   * @returns Promise resolving to true if extension succeeded, false otherwise
   */
  async extend(newTtlMs?: number): Promise<boolean> {
    if (this._isReleased) {
      throw new Error('Cannot extend a released lock');
    }

    const ttlToUse = newTtlMs ?? this.ttlMs;

    if (!Number.isInteger(ttlToUse) || ttlToUse <= 0) {
      throw new InvalidParameterError('newTtlMs', ttlToUse, 'positive integer');
    }

    try {
      const success = await this.redlock[INTERNAL_ACCESS].extend(
        this.key,
        this.token,
        ttlToUse,
      );

      if (success) {
        this.expiresAt = new Date(Date.now() + ttlToUse);
      }

      return success;
    } catch (error) {
      // Extension failures should be propagated as they indicate lock issues
      throw new Error(
        `Failed to extend lock ${this.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Starts automatic extension of this lock.
   * The lock will be extended automatically when it approaches expiration.
   *
   * @param thresholdMs Time in milliseconds before expiration to trigger extension (default: 1000)
   */
  startAutoExtension(thresholdMs = 1000): void {
    if (this._isReleased) {
      throw new Error('Cannot start auto-extension on a released lock');
    }

    if (thresholdMs <= 0 || !Number.isInteger(thresholdMs)) {
      throw new InvalidParameterError(
        'thresholdMs',
        thresholdMs,
        'positive integer',
      );
    }

    this.autoExtensionThresholdMs = thresholdMs;
    this.autoExtensionEnabled = true;
    this.scheduleExtension();
  }

  /**
   * Stops auto-extension if it's currently running.
   * This is called automatically when the lock is released.
   */
  stopAutoExtension(): void {
    if (this.extensionTimer) {
      clearTimeout(this.extensionTimer);
      this.extensionTimer = undefined;
    }
    this.autoExtensionEnabled = false;
  }

  /**
   * Schedules the next auto-extension attempt.
   */
  private scheduleExtension(): void {
    if (!this.autoExtensionEnabled || this._isReleased) return;

    const timeUntilExtension =
      this.expiresAt.getTime() - Date.now() - this.autoExtensionThresholdMs;

    if (timeUntilExtension <= 0) {
      void this.performExtension();
      return;
    }

    this.extensionTimer = setTimeout(() => {
      void this.performExtension();
    }, timeUntilExtension);
  }

  /**
   * Performs the actual extension operation in the background.
   */
  private async performExtension(): Promise<void> {
    if (!this.autoExtensionEnabled || this._isReleased) return;

    this.extensionTimer = undefined;

    try {
      const success = await this.extend(this.ttlMs);

      if (success) {
        // Extension succeeded, schedule the next one
        this.scheduleExtension();
      } else {
        // Extension failed - stop auto-extension
        this.autoExtensionEnabled = false;
        console.warn(
          `Auto-extension failed for lock ${this.key} - stopping auto-extension`,
        );
      }
    } catch (error) {
      // Extension error - stop auto-extension
      this.autoExtensionEnabled = false;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.warn(
        `Auto-extension error for lock ${this.key}: ${errorMessage} - stopping auto-extension`,
      );
    }
  }

  private validateConstructorParams(): void {
    if (!this.key || typeof this.key !== 'string') {
      throw new InvalidParameterError('key', this.key, 'non-empty string');
    }
    if (!this.token || typeof this.token !== 'string') {
      throw new InvalidParameterError('token', this.token, 'non-empty string');
    }
    if (
      !this.expiresAt ||
      !(this.expiresAt instanceof Date) ||
      isNaN(this.expiresAt.getTime())
    ) {
      throw new InvalidParameterError(
        'expiresAt',
        this.expiresAt,
        'valid Date object',
      );
    }
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new InvalidParameterError('ttlMs', this.ttlMs, 'positive integer');
    }
  }
}

/**
 * Redlock distributed lock implementation following the official Redis Redlock algorithm.
 *
 * Provides distributed locking with mutual exclusion, deadlock freedom, and fault tolerance.
 * Requires majority consensus from N independent Redis instances (recommended N=5).
 *
 * @see http://redis.io/topics/distlock/ - Official Redlock Algorithm
 * @see https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html - Martin Kleppmann's analysis
 * @see http://antirez.com/news/101 - Antirez's response
 *
 * @example
 * ```typescript
 * const redlock = new Redlock([client1, client2, client3, client4, client5]);
 * const result = await redlock.acquire('my-resource', 30000);
 * if (result.success) {
 *   try {
 *     // Critical section
 *   } finally {
 *     await redlock.release('my-resource', result.token);
 *   }
 * }
 * ```
 */
export class Redlock {
  /**
   * Internal access point for RedlockInstance. Not part of public API.
   * @internal
   */
  [INTERNAL_ACCESS]: RedlockInternalAccess;
  private readonly clients: RedisClientType[];
  private readonly quorum: number;
  private readonly driftFactor: number;
  private readonly retryDelayMs: number;
  private readonly retryJitterMs: number;
  private readonly maxRetryAttempts: number;

  constructor(redisClients: RedisClientType[], options: RedlockOptions = {}) {
    if (!Array.isArray(redisClients) || redisClients.length === 0) {
      throw new InvalidParameterError(
        'redisClients',
        redisClients,
        'non-empty array of Redis clients',
      );
    }

    this.validateOptions(options);
    this.clients = redisClients;

    // Majority consensus: N/2+1 instances required
    this.quorum = Math.floor(redisClients.length / 2) + 1;

    // Clock drift compensation (default: 1% of TTL)
    this.driftFactor = options.driftFactor ?? 0.01;

    // Retry mechanism with jitter
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.retryJitterMs = options.retryJitterMs ?? 100;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 3;

    // Set up internal access for RedlockInstance
    this[INTERNAL_ACCESS] = {
      release: this.release.bind(this),
      extend: this.extend.bind(this),
    };
  }

  /**
   * Attempts to acquire a distributed lock following the Redlock algorithm.
   *
   * Implements the 5-step process: get time, try all instances, check majority + timing,
   * return success or cleanup and retry.
   *
   * @param key Resource name to lock
   * @param ttlMs Lock time-to-live in milliseconds
   * @returns RedlockInstance if acquisition succeeds, null otherwise
   * @see http://redis.io/topics/distlock/
   */
  async acquire(key: string, ttlMs: number): Promise<RedlockInstance | null> {
    this.validateKey(key);
    this.validateTtl(ttlMs);

    for (let attempt = 0; attempt <= this.maxRetryAttempts; attempt++) {
      const token = generateToken();
      const startTime = Date.now();

      // Try to acquire lock on all instances
      const results = await Promise.allSettled(
        this.clients.map((client) =>
          this.acquireOnInstance(client, key, token, ttlMs),
        ),
      );

      const successCount = results.filter(
        (r) => r.status === 'fulfilled' && r.value,
      ).length;
      const elapsedTime = Date.now() - startTime;

      // Check majority consensus AND timing validity
      const evaluation = this.evaluateAcquisitionAttempt({
        successCount,
        ttlMs,
        elapsedTime,
      });

      if (evaluation.success) {
        const expiresAt = new Date(Date.now() + evaluation.effectiveValidityMs);
        return new RedlockInstance(this, key, token, expiresAt, ttlMs);
      }

      // Failed - cleanup partial acquisitions
      await Promise.allSettled(
        this.clients.map((client) =>
          this.releaseOnInstance(client, key, token),
        ),
      );

      // Retry with random delay
      if (attempt < this.maxRetryAttempts) {
        const delay = this.generateRetryDelay();
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return null;
  }

  /**
   * Executes a function within a lock context with automatic lifecycle management.
   *
   * Provides automatic lock acquisition, extension, and release. The lock is extended
   * automatically when approaching expiration to ensure the function can complete.
   *
   * @param key Resource name to lock
   * @param ttlMs Lock time-to-live in milliseconds
   * @param fn Function to execute within the lock context
   * @param options Optional configuration for auto-extension behavior
   * @returns Promise resolving to the function's return value
   *
   * @example
   * ```typescript
   * const result = await redlock.withLock('my-resource', 30000, async () => {
   *   return performWork();
   * });
   * ```
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
    options: { extensionThresholdMs?: number } = {},
  ): Promise<T> {
    if (typeof fn !== 'function') {
      throw new InvalidParameterError('fn', fn, 'function');
    }

    // Acquire lock
    const lock = await this.acquire(key, ttlMs);
    if (!lock) {
      throw new Error(`Failed to acquire lock for resource: ${key}`);
    }

    // Start auto-extension if threshold is provided
    if (options.extensionThresholdMs !== undefined) {
      lock.startAutoExtension(options.extensionThresholdMs);
    }

    try {
      return await fn();
    } finally {
      // Always stop auto-extension and release lock
      lock.stopAutoExtension();
      await lock.release();
    }
  }

  /**
   * Internal method for releasing locks. Only accessible by RedlockInstance.
   */
  private async release(key: string, token: string): Promise<boolean> {
    this.validateKey(key);
    this.validateToken(token);

    const results = await Promise.allSettled(
      this.clients.map((client) => this.releaseOnInstance(client, key, token)),
    );

    const successCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value,
    ).length;

    return successCount > 0;
  }

  /**
   * Internal method for extending locks. Only accessible by RedlockInstance.
   */
  private async extend(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    this.validateKey(key);
    this.validateToken(token);
    this.validateTtl(ttlMs);

    const results = await Promise.allSettled(
      this.clients.map((client) =>
        this.extendOnInstance(client, key, token, ttlMs),
      ),
    );

    const successCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value,
    ).length;

    return successCount >= this.quorum;
  }

  private async acquireOnInstance(
    client: RedisClientType,
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      const result = (await client.eval(ACQUIRE_SCRIPT, {
        keys: [key],
        arguments: [token, ttlMs.toString()],
      })) as number;

      return result === 1;
    } catch {
      return false;
    }
  }

  private async releaseOnInstance(
    client: RedisClientType,
    key: string,
    token: string,
  ): Promise<boolean> {
    try {
      const result = (await client.eval(RELEASE_SCRIPT, {
        keys: [key],
        arguments: [token],
      })) as number;

      return result === 1;
    } catch {
      return false;
    }
  }

  private async extendOnInstance(
    client: RedisClientType,
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    try {
      const result = (await client.eval(EXTEND_SCRIPT, {
        keys: [key],
        arguments: [token, ttlMs.toString()],
      })) as number;

      return result === 1;
    } catch {
      return false;
    }
  }

  private validateOptions(options: RedlockOptions): void {
    if (options.driftFactor !== undefined) {
      if (options.driftFactor < 0 || options.driftFactor > 0.1) {
        throw new InvalidParameterError(
          'driftFactor',
          options.driftFactor,
          'number between 0 and 0.1',
        );
      }
    }

    if (options.retryDelayMs !== undefined && options.retryDelayMs < 0) {
      throw new InvalidParameterError(
        'retryDelayMs',
        options.retryDelayMs,
        'non-negative number',
      );
    }

    if (
      options.maxRetryAttempts !== undefined &&
      options.maxRetryAttempts < 0
    ) {
      throw new InvalidParameterError(
        'maxRetryAttempts',
        options.maxRetryAttempts,
        'non-negative number',
      );
    }
  }

  private calculateEffectiveValidity(ttlMs: number, elapsedMs: number): number {
    const driftTime = Math.round(this.driftFactor * ttlMs);
    return ttlMs - elapsedMs - driftTime;
  }

  private generateRetryDelay(): number {
    return this.retryDelayMs + Math.random() * this.retryJitterMs;
  }

  private hasMajorityConsensus(result: { successCount: number }): boolean {
    return result.successCount >= this.quorum;
  }

  private isTimingValid(params: {
    ttlMs: number;
    elapsedTime: number;
  }): boolean {
    const effectiveValidity = this.calculateEffectiveValidity(
      params.ttlMs,
      params.elapsedTime,
    );

    return effectiveValidity > 1;
  }

  /**
   * Evaluates whether a lock acquisition attempt should be considered successful.
   *
   * This is the core decision-making function that implements the two critical
   * requirements of the Redlock algorithm.
   *
   * 1. Majority consensus: Did we acquire locks from majority of instances?
   * 2. Timing validity: Did acquisition happen fast enough for meaningful validity?
   */
  private evaluateAcquisitionAttempt(attempt: {
    successCount: number;
    ttlMs: number;
    elapsedTime: number;
  }):
    | {
        success: true;
        effectiveValidityMs: number;
      }
    | {
        success: false;
        failureReason?: string;
      } {
    if (!this.hasMajorityConsensus(attempt)) {
      return {
        success: false,
        failureReason: `Insufficient consensus: ${attempt.successCount}/${this.quorum} required`,
      };
    }

    if (!this.isTimingValid(attempt)) {
      return {
        success: false,
        failureReason: 'Timing constraint violated: effective validity too low',
      };
    }

    const effectiveValidityMs = this.calculateEffectiveValidity(
      attempt.ttlMs,
      attempt.elapsedTime,
    );
    return { success: true, effectiveValidityMs };
  }

  private validateKey(key: string): void {
    if (!key || typeof key !== 'string' || key.trim() === '') {
      throw new InvalidParameterError('key', key, 'non-empty string');
    }
  }

  private validateToken(token: string): void {
    if (!token || typeof token !== 'string' || token.trim() === '') {
      throw new InvalidParameterError('token', token, 'non-empty string');
    }
  }

  private validateTtl(ttlMs: number): void {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new InvalidParameterError('ttlMs', ttlMs, 'positive integer');
    }
  }
}
