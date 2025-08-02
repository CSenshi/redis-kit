import type { RedisClientType } from 'redis';
import type { RedlockResult, RedlockOptions } from './redlock-types.js';
import { InvalidParameterError } from './errors.js';
import { ACQUIRE_SCRIPT, RELEASE_SCRIPT, EXTEND_SCRIPT } from './scripts.js';
import { generateToken } from './token.js';

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
        'non-empty array of Redis clients'
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
  }

  /**
   * Attempts to acquire a distributed lock following the Redlock algorithm.
   *
   * Implements the 5-step process: get time, try all instances, check majority + timing,
   * return success or cleanup and retry.
   *
   * @param key Resource name to lock
   * @param ttlMs Lock time-to-live in milliseconds
   * @returns RedlockResult indicating success/failure
   * @see http://redis.io/topics/distlock/
   */
  async acquire(key: string, ttlMs: number): Promise<RedlockResult> {
    this.validateKey(key);
    this.validateTtl(ttlMs);

    for (let attempt = 0; attempt <= this.maxRetryAttempts; attempt++) {
      const token = generateToken();
      const startTime = Date.now();

      // Try to acquire lock on all instances
      const results = await Promise.allSettled(
        this.clients.map((client) =>
          this.acquireOnInstance(client, key, token, ttlMs)
        )
      );

      const successCount = results.filter(
        (r) => r.status === 'fulfilled' && r.value
      ).length;
      const elapsedTime = Date.now() - startTime;

      // Check majority consensus AND timing validity
      const evaluation = this.evaluateAcquisitionAttempt({
        successCount,
        ttlMs,
        elapsedTime,
      });

      if (evaluation.success) {
        return {
          success: true,
          token,
          expiresAt: new Date(Date.now() + evaluation.effectiveValidityMs),
          effectiveValidityMs: evaluation.effectiveValidityMs,
          acquiredInstances: successCount,
        };
      }

      // Failed - cleanup partial acquisitions
      await Promise.allSettled(
        this.clients.map((client) => this.releaseOnInstance(client, key, token))
      );

      // Retry with random delay
      if (attempt < this.maxRetryAttempts) {
        const delay = this.generateRetryDelay();
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return { success: false };
  }

  /**
   * Releases a distributed lock from all instances.
   * Safe to call regardless of acquisition status.
   */
  async release(key: string, token: string): Promise<boolean> {
    this.validateKey(key);
    this.validateToken(token);

    const results = await Promise.allSettled(
      this.clients.map((client) => this.releaseOnInstance(client, key, token))
    );

    const successCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value
    ).length;

    return successCount > 0;
  }

  /**
   * Extends the TTL of an existing lock.
   * Requires majority consensus for success.
   */
  async extend(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.validateKey(key);
    this.validateToken(token);
    this.validateTtl(ttlMs);

    const results = await Promise.allSettled(
      this.clients.map((client) =>
        this.extendOnInstance(client, key, token, ttlMs)
      )
    );

    const successCount = results.filter(
      (r) => r.status === 'fulfilled' && r.value
    ).length;

    return successCount >= this.quorum;
  }

  private async acquireOnInstance(
    client: RedisClientType,
    key: string,
    token: string,
    ttlMs: number
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
    token: string
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
    ttlMs: number
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
          'number between 0 and 0.1'
        );
      }
    }

    if (options.retryDelayMs !== undefined && options.retryDelayMs < 0) {
      throw new InvalidParameterError(
        'retryDelayMs',
        options.retryDelayMs,
        'non-negative number'
      );
    }

    if (
      options.maxRetryAttempts !== undefined &&
      options.maxRetryAttempts < 0
    ) {
      throw new InvalidParameterError(
        'maxRetryAttempts',
        options.maxRetryAttempts,
        'non-negative number'
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
      params.elapsedTime
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
      attempt.elapsedTime
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
