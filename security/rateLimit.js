// ═══════════════════════════════════════════════════════════════════
//  Rate Limiter - In-memory sliding window rate limiter
//  Protects public endpoints from spam, bots, and abuse
// ═══════════════════════════════════════════════════════════════════

// Store: { key: { count: N, resetTime: timestamp } }
const store = new Map();

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetTime) store.delete(key);
  }
}, 5 * 60 * 1000);

/**
 * Create a rate limiter middleware
 * @param {Object} options
 * @param {number} options.windowMs - Time window in milliseconds
 * @param {number} options.maxRequests - Maximum requests allowed in the window
 * @param {string} options.keyPrefix - Prefix for the rate limit key
 * @param {string} options.message - Error message when rate limited
 * @param {Function} options.keyGenerator - Custom key generator (req => string)
 */
function createRateLimiter(options = {}) {
  const {
    windowMs = 60 * 1000,       // 1 minute default
    maxRequests = 30,
    keyPrefix = 'rl',
    message = 'Too many requests. Please try again later.',
    keyGenerator = null,
  } = options;

  return (req, res, next) => {
    // Generate key from IP + prefix
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const customKey = keyGenerator ? keyGenerator(req) : null;
    const key = `${keyPrefix}:${customKey || ip}`;
    const now = Date.now();

    let entry = store.get(key);

    if (!entry || now > entry.resetTime) {
      // New window
      entry = { count: 1, resetTime: now + windowMs };
      store.set(key, entry);
      return next();
    }

    if (entry.count >= maxRequests) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        error: message,
        retryAfterSeconds: retryAfter,
      });
    }

    entry.count++;
    next();
  };
}

// ─── Pre-configured rate limiters ───────────────────────────────

// Public order creation: 10 orders per hour per IP
const orderLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,    // 1 hour
  maxRequests: 10,
  keyPrefix: 'order',
  message: 'Too many orders placed. Please wait before placing another order.',
});

// General API rate limit: 60 requests per minute per IP
const apiLimiter = createRateLimiter({
  windowMs: 60 * 1000,         // 1 minute
  maxRequests: 60,
  keyPrefix: 'api',
  message: 'Too many requests. Please slow down.',
});

// Login/auth endpoint: 10 attempts per 15 minutes per IP
const authLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,    // 15 minutes
  maxRequests: 10,
  keyPrefix: 'auth',
  message: 'Too many authentication attempts. Please try again later.',
});

// Menu/booking public reads: 30 per minute
const publicReadLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'pubread',
  message: 'Too many requests. Please slow down.',
});

module.exports = {
  createRateLimiter,
  orderLimiter,
  apiLimiter,
  authLimiter,
  publicReadLimiter,
};
