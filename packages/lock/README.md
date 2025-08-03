<div align="center">

<img src="https://raw.githubusercontent.com/CSenshi/redis-kit/main/docs/images/logo.png" alt="Redis Kit Logo" height="200">

# @redis-kit/lock

**Production-ready distributed locking for Redis with automatic lifecycle management**

[![npm version](https://badge.fury.io/js/%40redis-kit%2Flock.svg)](https://www.npmjs.com/package/@redis-kit/lock)
[![npm downloads](https://img.shields.io/npm/dm/@redis-kit/lock.svg)](https://www.npmjs.com/package/@redis-kit/lock)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

_Fault-tolerant • Auto-extension • Redlock algorithm • Production-tested_

</div>

## Features

- **Distributed Locking**: Implements the official [Redlock]() algorithm for multi-instance Redis deployments
- **Automatic Extension**: Prevents lock expiration during long-running operations with built-in auto-extension
- **Fault Tolerance**: Requires majority consensus from Redis instances, works even when some instances fail
- **TypeScript Native**: Full type safety with comprehensive TypeScript definitions included
- **Flexible API**: Choose between manual lock management or automatic lifecycle with `withLock`
- **Production Ready**: Clock drift compensation, retry logic with jitter, and battle-tested reliability

## Installation

```bash
npm install @redis-kit/lock
```

## Quick Start

```typescript
import { Redlock } from '@redis-kit/lock';
import { createClient } from 'redis';

const clients = [
  createClient({ host: 'redis1.example.com' }),
  createClient({ host: 'redis2.example.com' }),
  createClient({ host: 'redis3.example.com' }),
];

await Promise.all(clients.map((client) => client.connect()));

const redlock = new Redlock(clients);
await redlock.withLock('user:123:profile', 30000, async () => {
  // Critical section - only one process can execute this
  await updateUserProfile(userId, profileData);
});
```

## API Reference

### `Redlock`

#### Constructor

```typescript
new Redlock(redisClients: RedisClientType[], options?: RedlockOptions)
```

#### Methods

##### `acquire(key: string, ttlMs: number): Promise<RedlockInstance | null>`

Attempts to acquire a distributed lock.

##### `withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>`

Executes a function within a lock context with automatic management.

### `RedlockInstance`

#### Properties

- `isValid: boolean` - Whether the lock is currently valid
- `resourceKey: string` - The resource key this lock protects

#### Methods

- `release(): Promise<boolean>` - Releases the lock
- `extend(newTtlMs?: number): Promise<boolean>` - Extends the lock's TTL
- `startAutoExtension(thresholdMs?: number): void` - Starts automatic extension

### Configuration

```typescript
interface RedlockOptions {
  driftFactor?: number; // Clock drift compensation (default: 0.01)
  retryDelayMs?: number; // Base retry delay (default: 200)
  retryJitterMs?: number; // Random jitter (default: 100)
  maxRetryAttempts?: number; // Maximum retries (default: 3)
}
```

## Advanced Usage

### Manual Lock Management

```typescript
const lock = await redlock.acquire('payment:order:456', 10000);

if (lock) {
  try {
    await processPayment(orderId);
    await updateInventory(items);
  } finally {
    await lock.release();
  }
} else {
  throw new Error('Could not acquire lock for payment processing');
}
```

### Auto-Extension for Long Operations

```typescript
const lock = await redlock.acquire('data-migration', 30000);

if (lock) {
  lock.startAutoExtension(5000); // Extend 5 seconds before expiry

  try {
    for (const batch of dataBatches) {
      await migrateBatch(batch);
    }
  } finally {
    await lock.release(); // Stops auto-extension automatically
  }
}
```

### Custom Configuration

```typescript
const redlock = new Redlock(clients, {
  driftFactor: 0.01,
  retryDelayMs: 200,
  retryJitterMs: 100,
  maxRetryAttempts: 5,
});

try {
  await redlock.withLock('critical-resource', 60000, async () => {
    await performCriticalOperation();
  });
} catch (error) {
  console.error('Lock operation failed:', error.message);
}
```

MIT
