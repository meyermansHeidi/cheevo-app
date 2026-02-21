/**
 * CheevO! API Proxy — Cloudflare Worker
 *
 * Een simpele CORS-proxy die API-requests doorstuurt en API-keys veilig bewaart.
 * Deploy via Cloudflare Dashboard > Workers & Pages > Create Worker.
 *
 * Environment Variables (stel in via Cloudflare Dashboard > Worker > Settings > Variables):
 *   ALLOWED_ORIGIN  = https://meyermansheidi.github.io  (of * voor development)
 *   CBEAPI_TOKEN    = jouw CBEAPI Bearer token (gratis account op cbeapi.be)
 *   GNEWS_API_KEY   = jouw GNews API key (optioneel, voor Fase 3)
 *   FINNHUB_KEY     = jouw Finnhub API key (optioneel, voor Fase 3)
 *
 * CBEAPI endpoints (base: https://cbeapi.be/api):
 *   GET /v1/company/search?name=ACME          — Zoek bedrijven op naam
 *   GET /v1/company/search/address?city=...    — Zoek op adres
 *   GET /v1/company/{cbeNumber}                — Bedrijfsinfo op BCE-nummer
 *   GET /v1/juridical-situations               — Alle juridische situaties
 *   GET /v1/nace/hierarchy                     — NACE-codes hiërarchie
 *   GET /v1/nace/{code}                        — Specifieke NACE-code
 */

const API_ROUTES = {
  // Fase 2: Belgische data (CBEAPI.be — Bearer Auth vereist)
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
  // Fase 3: Nieuws
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
  // Fase 3: Financiële data
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
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' || url.pathname === '/health') {
      return corsResponse(env, Response.json({
        status: 'ok',
        service: 'CheevO! API Proxy',
        routes: Object.keys(API_ROUTES),
        timestamp: new Date().toISOString()
      }));
    }

    // Match route
    const matchedRoute = Object.entries(API_ROUTES).find(([prefix]) =>
      url.pathname.startsWith(prefix)
    );

    if (!matchedRoute) {
      return corsResponse(env, Response.json(
        { error: 'Route niet gevonden', routes: Object.keys(API_ROUTES) },
        { status: 404 }
      ));
    }

    const [prefix, route] = matchedRoute;

    // Build target URL: vervang het prefix door de echte API URL
    const remainingPath = url.pathname.slice(prefix.length);
    let targetUrl = route.target + remainingPath + url.search;

    // Voeg API key toe als dat nodig is
    if (route.addKey) {
      targetUrl = route.addKey(targetUrl, env);
    }

    try {
      // Bouw headers op voor de API-request
      const requestHeaders = {
        'Accept': 'application/json',
        'User-Agent': 'CheevO-Decision-Intelligence/1.0'
      };

      // Voeg route-specifieke headers toe (bijv. Bearer Auth voor CBEAPI)
      if (route.addHeaders) {
        Object.assign(requestHeaders, route.addHeaders(env));
      }

      // Stuur request door naar de echte API
      const apiResponse = await fetch(targetUrl, {
        method: request.method,
        headers: requestHeaders
      });

      // Maak een nieuwe response met CORS-headers
      const responseBody = await apiResponse.text();
      return corsResponse(env, new Response(responseBody, {
        status: apiResponse.status,
        headers: {
          'Content-Type': apiResponse.headers.get('Content-Type') || 'application/json'
        }
      }));

    } catch (error) {
      return corsResponse(env, Response.json(
        { error: 'API request mislukt', detail: error.message },
        { status: 502 }
      ));
    }
  }
};

function corsResponse(env, response) {
  const origin = env.ALLOWED_ORIGIN || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  headers.set('Access-Control-Max-Age', '86400');

  return new Response(response.body, {
    status: response.status,
    headers
  });
}
