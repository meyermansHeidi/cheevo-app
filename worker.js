/**
 * CheevO! API Proxy — Cloudflare Worker
 *
 * CORS-proxy die API-requests doorstuurt en API-keys veilig bewaart.
 * Deploy via Cloudflare Dashboard > Workers & Pages > Create Worker.
 *
 * Environment Variables (stel in via Cloudflare Dashboard > Worker > Settings > Variables):
 *   ALLOWED_ORIGIN  = https://meyermansheidi.github.io
 *   CBEAPI_TOKEN    = jouw CBEAPI Bearer token (gratis account op cbeapi.be)
 *   GNEWS_API_KEY   = jouw GNews API key
 *   FINNHUB_KEY     = jouw Finnhub API key
 *   ANTHROPIC_KEY   = jouw Anthropic API key (voor server-side proxy)
 */

// ─── Rate Limiter (in-memory per Worker instance) ───
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minuut
const RATE_LIMIT_MAX = 20; // max 20 requests per IP per minuut

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + RATE_LIMIT_WINDOW;
  }
  entry.count++;
  rateLimitMap.set(ip, entry);
  // Cleanup old entries periodically
  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap) {
      if (now > val.resetAt) rateLimitMap.delete(key);
    }
  }
  return entry.count <= RATE_LIMIT_MAX;
}

// ─── Simple Response Cache (KBO/Wikipedia data, 5 min TTL) ───
const responseCache = new Map();
const CACHE_TTL = 300000; // 5 minuten
const CACHEABLE_PREFIXES = ['/api/kbo'];

function getCached(key) {
  const entry = responseCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry;
  if (entry) responseCache.delete(key);
  return null;
}

function setCache(key, body, status, contentType) {
  if (responseCache.size > 500) {
    // Evict oldest entries
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now > v.expiresAt) responseCache.delete(k);
    }
  }
  responseCache.set(key, { body, status, contentType, expiresAt: Date.now() + CACHE_TTL });
}

// ─── API Routes ───
const API_ROUTES = {
  '/api/kbo': {
    target: 'https://cbeapi.be/api',
    description: 'KBO/CBE - Belgische bedrijfsdata',
    addHeaders: (env) => {
      const headers = {};
      if (env.CBEAPI_TOKEN) {
        headers['Authorization'] = 'Bearer ' + env.CBEAPI_TOKEN;
      }
      headers['Accept-Language'] = 'nl';
      return headers;
    }
  },
  '/api/gnews': {
    target: 'https://gnews.io/api/v4',
    description: 'GNews - Nieuwsartikelen',
    addKey: (url, env) => {
      if (env.GNEWS_API_KEY) {
        const sep = url.includes('?') ? '&' : '?';
        return url + sep + 'apikey=' + env.GNEWS_API_KEY;
      }
      return url;
    }
  },
  '/api/finnhub': {
    target: 'https://finnhub.io/api/v1',
    description: 'Finnhub - Beursdata',
    addKey: (url, env) => {
      if (env.FINNHUB_KEY) {
        const sep = url.includes('?') ? '&' : '?';
        return url + sep + 'token=' + env.FINNHUB_KEY;
      }
      return url;
    }
  }
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(env, origin, new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Rate limiting
    if (!checkRateLimit(clientIP)) {
      return corsResponse(env, origin, Response.json(
        { error: 'Rate limit overschreden. Probeer het over een minuut opnieuw.' },
        { status: 429 }
      ));
    }

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return corsResponse(env, origin, Response.json({
        status: 'ok',
        service: 'CheevO! API Proxy v2',
        routes: [...Object.keys(API_ROUTES), '/api/anthropic'],
        features: ['rate-limiting', 'cors-whitelist', 'response-cache', 'anthropic-proxy'],
        timestamp: new Date().toISOString()
      }));
    }

    // ─── Anthropic Proxy Route ───
    if (url.pathname === '/api/anthropic' && request.method === 'POST') {
      if (!env.ANTHROPIC_API_KEY) {
        return corsResponse(env, origin, Response.json(
          { error: 'Anthropic API key niet geconfigureerd op server' },
          { status: 503 }
        ));
      }

      try {
        const body = await request.json();

        // Validate request structure
        if (!body.messages || !Array.isArray(body.messages)) {
          return corsResponse(env, origin, Response.json(
            { error: 'Ongeldig request: messages array vereist' },
            { status: 400 }
          ));
        }

        // Enforce max_tokens limit
        const maxTokens = Math.min(body.max_tokens || 2048, 4096);

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: body.model || 'claude-sonnet-4-5-20250929',
            max_tokens: maxTokens,
            temperature: Math.min(body.temperature || 0.7, 1.0),
            system: body.system || '',
            messages: body.messages.slice(0, 10) // Max 10 messages
          })
        });

        const responseBody = await anthropicResponse.text();
        return corsResponse(env, origin, new Response(responseBody, {
          status: anthropicResponse.status,
          headers: { 'Content-Type': 'application/json' }
        }));

      } catch (error) {
        return corsResponse(env, origin, Response.json(
          { error: 'Anthropic proxy mislukt', detail: error.message },
          { status: 502 }
        ));
      }
    }

    // ─── Standard API Routes ───
    const matchedRoute = Object.entries(API_ROUTES).find(([prefix]) =>
      url.pathname.startsWith(prefix)
    );

    if (!matchedRoute) {
      return corsResponse(env, origin, Response.json(
        { error: 'Route niet gevonden', routes: [...Object.keys(API_ROUTES), '/api/anthropic'] },
        { status: 404 }
      ));
    }

    const [prefix, route] = matchedRoute;

    // Build target URL
    const remainingPath = url.pathname.slice(prefix.length);
    let targetUrl = route.target + remainingPath + url.search;

    // Add API key if needed
    if (route.addKey) {
      targetUrl = route.addKey(targetUrl, env);
    }

    // Check cache for GET requests on cacheable routes
    const cacheKey = url.pathname + url.search;
    if (request.method === 'GET' && CACHEABLE_PREFIXES.some(p => url.pathname.startsWith(p))) {
      const cached = getCached(cacheKey);
      if (cached) {
        return corsResponse(env, origin, new Response(cached.body, {
          status: cached.status,
          headers: {
            'Content-Type': cached.contentType || 'application/json',
            'X-Cache': 'HIT'
          }
        }));
      }
    }

    try {
      const requestHeaders = {
        'Accept': 'application/json',
        'User-Agent': 'CheevO-Decision-Intelligence/2.0'
      };

      if (route.addHeaders) {
        Object.assign(requestHeaders, route.addHeaders(env));
      }

      const apiResponse = await fetch(targetUrl, {
        method: request.method,
        headers: requestHeaders
      });

      const responseBody = await apiResponse.text();
      const contentType = apiResponse.headers.get('Content-Type') || 'application/json';

      // Cache successful GET responses for cacheable routes
      if (request.method === 'GET' && apiResponse.ok && CACHEABLE_PREFIXES.some(p => url.pathname.startsWith(p))) {
        setCache(cacheKey, responseBody, apiResponse.status, contentType);
      }

      return corsResponse(env, origin, new Response(responseBody, {
        status: apiResponse.status,
        headers: {
          'Content-Type': contentType,
          'X-Cache': 'MISS'
        }
      }));

    } catch (error) {
      return corsResponse(env, origin, Response.json(
        { error: 'API request mislukt', detail: error.message },
        { status: 502 }
      ));
    }
  }
};

function corsResponse(env, origin, response) {
  const headers = new Headers(response.headers);

  // CORS whitelist — alleen toegestane origins
  const allowedOrigins = [
    'https://meyermansheidi.github.io',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
  ];

  // Add custom ALLOWED_ORIGIN from env if set
  if (env.ALLOWED_ORIGIN && !allowedOrigins.includes(env.ALLOWED_ORIGIN)) {
    allowedOrigins.push(env.ALLOWED_ORIGIN);
  }

  if (allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
  } else if (!origin || origin === 'null') {
    // Allow requests without origin (e.g. direct API calls for testing)
    headers.set('Access-Control-Allow-Origin', allowedOrigins[0]);
  } else {
    // Unknown origin — still return CORS but log warning
    headers.set('Access-Control-Allow-Origin', allowedOrigins[0]);
  }

  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');

  return new Response(response.body, {
    status: response.status,
    headers
  });
}
