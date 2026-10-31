// Optional webhook routing by workspace name prefix (#103).
// OPENBOT_ORCA_ROUTES=alan-:ALAN,ubu-:UBU names routes; each route NAME reads its own
// OPENBOT_ORCA_WEBHOOK_URL_<NAME> / OPENBOT_ORCA_WEBHOOK_SECRET_<NAME>. Without OPENBOT_ORCA_ROUTES
// nothing here changes behavior. Errors and views name variables, never values.

export const ROUTES_KEY = 'OPENBOT_ORCA_ROUTES';
export const ROUTE_NAME_RE = /^[A-Z0-9][A-Z0-9_]{0,31}$/;
export const routeUrlKey = (name) => 'OPENBOT_ORCA_WEBHOOK_URL_' + name;
export const routeSecretKey = (name) => 'OPENBOT_ORCA_WEBHOOK_SECRET_' + name;

// "prefix:NAME" entries separated by commas; the last ':' splits, so a prefix may
// contain ':'. Entries are reported by position only: a pasted secret is never echoed.
export function parseRoutes(text) {
  const routes = [];
  const errors = [];
  const entries = String(text).split(',').map((e) => e.trim()).filter(Boolean);
  entries.forEach((entry, i) => {
    const at = entry.lastIndexOf(':');
    const prefix = at > 0 ? entry.slice(0, at).trim() : '';
    const name = at > 0 ? entry.slice(at + 1).trim() : '';
    if (!prefix || !name) errors.push(ROUTES_KEY + ' entry ' + (i + 1) + ' must be PREFIX:NAME');
    else if (!ROUTE_NAME_RE.test(name)) errors.push(ROUTES_KEY + ' entry ' + (i + 1) + ': route name must match [A-Z0-9][A-Z0-9_]{0,31}');
    else routes.push({ prefix, name });
  });
  if (!entries.length) errors.push(ROUTES_KEY + ' has no routes');
  return { routes, errors };
}

export const isRouted = (cfg) => Array.isArray(cfg?.routes);

// The webhook one event goes to. Without routes: the single configured webhook,
// exactly as before. With routes: the first route whose prefix starts the
// workspace name, else the default OPENBOT_ORCA_WEBHOOK_URL, else null (drop).
export function resolveTarget(cfg, workspaceName) {
  if (!isRouted(cfg)) return { url: cfg.url, secret: cfg.secret, route: null };
  const name = typeof workspaceName === 'string' ? workspaceName : '';
  const hit = name ? cfg.routes.find((r) => name.startsWith(r.prefix)) : undefined;
  if (hit) return { url: hit.url, secret: hit.secret, route: hit.name };
  if (cfg.url) return { url: cfg.url, secret: cfg.secret, route: 'default' };
  return null;
}

// Public, value-free description of the routes.
export function routesView(cfg) {
  if (!isRouted(cfg)) return null;
  return cfg.routes.map((r) => ({ prefix: r.prefix, route: r.name, url: r.url ? 'set' : 'unset', secret: r.secret ? 'set' : 'unset' }));
}
