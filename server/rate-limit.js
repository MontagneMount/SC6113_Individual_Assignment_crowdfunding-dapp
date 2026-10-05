/** Small in-memory rate limiter: at most `max` requests per IP in each `windowMs` window. */
export function rateLimit({ windowMs, max }) {
  const hits = new Map();

  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 5_000) {
      for (const [ip, entry] of hits) if (now - entry.start > windowMs) hits.delete(ip);
    }

    const entry = hits.get(req.ip);
    if (!entry || now - entry.start > windowMs) {
      hits.set(req.ip, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      return res.status(429).json({ error: "Too many requests. Please wait a moment and try again." });
    }
    next();
  };
}
