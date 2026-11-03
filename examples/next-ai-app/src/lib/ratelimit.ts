import { Redis } from '@upstash/redis';
const redis = new Redis({ url: process.env.UPSTASH_URL!, token: process.env.UPSTASH_TOKEN! });
export async function checkLimit(userId: string) {
  const n = await redis.incr(`rl:${userId}`);
  await redis.expire(`rl:${userId}`, 60);
  return n <= 20;
}
