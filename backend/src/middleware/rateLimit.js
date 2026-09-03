// Simple in-memory rate limiting is handled by @fastify/rate-limit
// This file exports custom key generator and error handler
import { extractToken, verifyToken } from './auth.js';
import { config } from '../config.js';

export const rateLimitConfig = {
  global: false, // Don't apply globally, apply per route
  max: 100,
  timeWindow: '15 minutes',
  keyGenerator: (request) => {
    return request.ip;
  },
  errorResponseBuilder: (request, context) => {
    return {
      error: 'Rate limit exceeded',
      message: `Too many requests, retry after ${context.after}`,
      retryAfter: context.after,
    };
  }
};

export const strictRateLimit = {
  max: 10,
  timeWindow: '1 minute',
};

export const aiRateLimit = {
  max: 20,
  timeWindow: '5 minutes',
};

/**
 * Which bucket a request counts against: a verified session gets one of its
 * own, everything else shares the IP bucket.
 *
 * Why not one bucket per IP for everything? Because the admin area is chatty
 * by design - Monitoring alone polls every 5 seconds, and opening File pages
 * fires five requests - so a global 100-requests-per-15-minutes bucket was
 * exhausted a few minutes into any real session. Once it was, every panel
 * showed a 429, which looks exactly like the panels being broken.
 *
 * The token is *verified*, not merely looked for: a request can say
 * `Authorization: Bearer anything` and still land in the IP bucket, so the
 * bigger allowance cannot be bought with a header.
 */
export function rateLimitKey(request) {
  const token = extractToken(request);
  if (!token) return request.ip;
  try {
    const decoded = verifyToken(token);
    return decoded?.id ? `session:${decoded.id}` : request.ip;
  } catch {
    return request.ip; // expired, forged, or superseded by a password change
  }
}

/** The allowance for a bucket: sessions get the larger one. */
export function rateLimitMax(key) {
  return String(key).startsWith('session:')
    ? config.rateLimit.authMax
    : config.rateLimit.max;
}
