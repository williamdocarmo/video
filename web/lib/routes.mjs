/**
 * Route table for the Video Studio HTTP server.
 *
 * Each entry: [method, pattern, handler]
 *   - pattern can be a literal string or contain `:param` segments
 *   - handler signature: (req, res, ctx) => Promise<void>
 *     ctx = { url, pathname, params, sendJson, serveStaticFile, ... }
 */

/**
 * @typedef {Object} RouteContext
 * @property {URL} url
 * @property {string} pathname
 * @property {Record<string, string>} params
 */

/**
 * @typedef {[string, string, (req: import('http').IncomingMessage, res: import('http').ServerResponse, ctx: RouteContext) => Promise<void>]} RouteEntry
 */

/** @type {RouteEntry[]} */
export const routes = [];

/**
 * Register a route. Called by server.mjs after wiring up the shared context.
 * @param {string} method
 * @param {string} pattern
 * @param {RouteEntry[2]} handler
 */
export const addRoute = (method, pattern, handler) => {
  routes.push([method, pattern, handler]);
};

/**
 * Match a request method + pathname against the route table.
 * Returns { handler, params } or null.
 *
 * @param {string} method
 * @param {string} pathname
 * @returns {{ handler: RouteEntry[2], params: Record<string, string> } | null}
 */
export const matchRoute = (method, pathname) => {
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;

    // Fast path: exact match (no params)
    if (!pattern.includes(":")) {
      if (pattern === pathname) return {handler, params: {}};
      continue;
    }

    const params = matchPattern(pattern, pathname);
    if (params) return {handler, params};
  }
  return null;
};

/**
 * Match a pattern like "/api/jobs/:id/stream" against a pathname.
 * Returns params object or null.
 */
const matchPattern = (pattern, pathname) => {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
};
