// Simple in-memory rate limiting is handled by @fastify/rate-limit
// This file exports custom key generator and error handler

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
