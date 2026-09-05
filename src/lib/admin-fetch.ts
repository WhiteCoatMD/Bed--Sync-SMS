/**
 * The bearer token every admin API call needs.
 *
 * The admin pages used to call these routes with no credentials, because the
 * routes had no auth. Adding canAccessDealer to them closed a real hole -- a
 * dealer_id in a query string was enough to read anyone's conversations -- but
 * it also turned eight of these calls into silent 401s, which the pages
 * rendered as "Conversation not found" and empty settings.
 *
 * One helper so a new call cannot forget it, and so the key is defined in a
 * single place: resolveAdminSession() stores it under `sms_auth_token`, and
 * `auth_token` is the Bed Sync key for a dealer who arrived with an existing
 * session.
 */
export function authHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const token =
    localStorage.getItem('sms_auth_token') || localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** fetch() with the admin token attached, preserving any headers given. */
export function adminFetch(input: string, init: RequestInit = {}) {
  return fetch(input, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
  });
}
