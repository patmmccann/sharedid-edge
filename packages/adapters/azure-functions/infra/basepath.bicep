// SID_BASE_PATH as core's resolveConfig checks and normalizes it, for main.bicep and frontdoor.bicep. The function
// registers its route from the normalized path (identity/{*path} for /identity/), so the Front Door patterns must be
// built from the same value, or they don't match.
//
// normalizeBasePath: a leading /, then letters, digits, ., _, ~, - and single slashes (core's rule), with the trailing
// slash removed and / kept as the root. Core rejects //, so there's at most one trailing slash to remove. For a value
// core would reject, the int() call fails the deployment with the message, rather than deploying a function that
// answers every request with a 500 (ARM evaluates only the branch of a condition that's taken).

@export()
@description('SID_BASE_PATH as core normalizes it; fails the deployment for a value core would reject.')
func normalizeBasePath(path string) string => startsWith(path, '/') && !contains(path, '//') && empty(filter(range(0, length(path)), i => !contains('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-/', substring(path, i, 1)))) ? (path != '/' && endsWith(path, '/') ? substring(path, 0, length(path) - 1) : path) : string(int('Invalid sidBasePath: use / or a path like /_sid (a leading /, then letters, digits, ., _, ~, - and single slashes)'))

// frontDoorPatterns: the base path and everything under it; for the root path, only core's own routes (ROUTES in
// packages/core/src/handler.ts), so the rest of the site stays on its origin. Front Door matches the most specific
// pattern, so these win over the site's own /* route on the same domain.

@export()
@description('The Front Door route patterns for a normalized base path.')
func frontDoorPatterns(basePath string) array => basePath == '/' ? flatten(map(['/sync', '/v1', '/optout', '/optin'], p => [p, '${p}/'])) : [basePath, '${basePath}/*']
