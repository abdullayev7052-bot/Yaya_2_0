import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import authRoutes from './auth.js';
import mobileRoutes from './routes/mobile.js';
import adminRoutes from './routes/admin.js';
import publicRoutes from './routes/public.js';
import erpRoutes from './routes/erp.js';
import productionRoutes from './routes/production.js';
import salesRoutes from './routes/sales.js';
import financeRoutes from './routes/finance.js';
import { createRateLimiter } from './ratelimit.js';

const ADMIN_DIR = fileURLToPath(new URL('../../admin', import.meta.url));
// Web build of the mobile app (same code as the APK), used to test from a laptop.
const WEBAPP_DIR = process.env.WEBAPP_DIR ?? fileURLToPath(new URL('../../mobile/dist', import.meta.url));

export function buildApp({ db, jwtSecret, logger = false, rateLimit = true }) {
  // Behind Railway's proxy: trust it so rate limiting sees real client IPs.
  const app = Fastify({ logger, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  app.register(fastifyJwt, { secret: jwtSecret });

  // Coarse flood protection for the whole API (login has its own stricter guard).
  const limiter = createRateLimiter({ max: 600, windowMs: 60_000 });
  app.addHook('onRequest', async (req, reply) => {
    if (rateLimit && req.url.startsWith('/api/') && !limiter.allow(req.ip)) {
      return reply.code(429).send({ error: 'Juda ko\'p so\'rov. Bir daqiqadan keyin urinib ko\'ring.' });
    }
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    // The panel embeds the web app in an iframe from the same origin; nobody else may.
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    if (req.url.startsWith('/admin')) {
      // Map tiles (OpenStreetMap) and address lookup (Nominatim) are the only
      // third-party hosts; Leaflet itself is served from our own origin.
      reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https://nominatim.openstreetmap.org; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'");
    }
    if (req.url.startsWith('/api/') && !req.url.startsWith('/api/public/logo')) reply.header('Cache-Control', 'no-store');
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/robots.txt', async (req, reply) => reply.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.register(authRoutes, { prefix: '/api/auth', db });
  app.register(mobileRoutes, { prefix: '/api/mobile', db });
  app.register(adminRoutes, { prefix: '/api/admin', db });
  app.register(publicRoutes, { prefix: '/api/public', db });
  app.register(erpRoutes, { prefix: '/api/erp', db });
  app.register(productionRoutes, { prefix: '/api/erp/prod', db });
  app.register(salesRoutes, { prefix: '/api/erp/sales', db });
  app.register(financeRoutes, { prefix: '/api/erp/finance', db });
  app.register(fastifyStatic, { root: ADMIN_DIR, prefix: '/admin/' });
  if (existsSync(WEBAPP_DIR)) {
    app.register(fastifyStatic, { root: WEBAPP_DIR, prefix: '/app/', decorateReply: false });
  }
  app.get('/', (_req, reply) => reply.redirect('/admin/'));
  return app;
}
