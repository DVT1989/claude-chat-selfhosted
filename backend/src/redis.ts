import Redis from 'ioredis';
import { config } from './config';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

// Session management helpers
export const sessions = {
  set: (tokenHash: string, userId: string, ttlMs: number) =>
    redis.set(`session:${tokenHash}`, userId, 'PX', ttlMs),

  get: (tokenHash: string) =>
    redis.get(`session:${tokenHash}`),

  del: (tokenHash: string) =>
    redis.del(`session:${tokenHash}`),

  // Delete all sessions for a user (logout all devices)
  delAll: async (userId: string) => {
    const keys = await redis.keys(`session:*`);
    for (const key of keys) {
      const uid = await redis.get(key);
      if (uid === userId) await redis.del(key);
    }
  },
};

// Rate limiting helpers
export const rateLimit = {
  increment: (key: string, windowMs: number) =>
    redis
      .multi()
      .incr(`rl:${key}`)
      .pexpire(`rl:${key}`, windowMs)
      .exec(),

  get: (key: string) =>
    redis.get(`rl:${key}`),
};
