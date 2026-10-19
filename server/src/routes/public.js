import { getSetting } from '../settings.js';

// Unauthenticated branding, so the login screens can show the company logo.
export default async function publicRoutes(app, { db }) {
  app.get('/brand', async () => {
    const logo = db.prepare("SELECT updated_at FROM files WHERE key = 'logo'").get();
    const intro = db.prepare("SELECT mime FROM files WHERE key = 'intro'").get();
    const version = getSetting(db, 'brand_version') ?? '0';
    return {
      companyName: getSetting(db, 'company_name') ?? '',
      greeting: getSetting(db, 'greeting') ?? '',
      version,
      logoUrl: logo ? `/api/public/logo.png?v=${version}` : null,
      introUrl: intro ? `/api/public/intro?v=${version}` : null,
      introMime: intro?.mime ?? null,
      locationEnabled: getSetting(db, 'location_enabled') !== '0',
      cancelEnabled: getSetting(db, 'cancel_enabled') !== '0',
      listFields: {
        name: getSetting(db, 'list_show_name') !== '0',
        address: getSetting(db, 'list_show_address') !== '0',
        phone: getSetting(db, 'list_show_phone') !== '0',
      },
    };
  });

  // The entry video. Native players (ExoPlayer/AVPlayer) stream with a Range
  // request and need 206 + Accept-Ranges, or they show a blank placeholder.
  app.get('/intro', async (req, reply) => {
    const f = db.prepare("SELECT mime, data FROM files WHERE key = 'intro'").get();
    if (!f) return reply.code(404).send({ error: 'Yo\'q' });
    const buf = f.data; // Buffer
    const total = buf.length;
    reply.header('Content-Type', f.mime);
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    const range = req.headers.range;
    const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        reply.header('Content-Range', `bytes */${total}`);
        return reply.code(416).send();
      }
      if (end >= total) end = total - 1;
      reply.code(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
      reply.header('Content-Length', end - start + 1);
      return buf.subarray(start, end + 1);
    }
    reply.header('Content-Length', total);
    return buf;
  });

  app.get('/logo.png', async (req, reply) => {
    const f = db.prepare("SELECT mime, data FROM files WHERE key = 'logo'").get();
    if (!f) return reply.code(404).send({ error: 'Logo yo\'q' });
    reply.header('Content-Type', f.mime);
    // Versioned URL: safe to cache long; a new upload changes ?v=.
    reply.header('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    return f.data;
  });
}
