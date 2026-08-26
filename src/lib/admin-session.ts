/**
 * Works out, for an admin page, which token to use and whose dealer to show.
 *
 * There are two ways in, and they differ by one parameter:
 *
 *   - A dealer opens the SMS dashboard from their own Bed Sync admin panel:
 *     `?token=...` and NO dealer_id. They should see their own store.
 *   - A super-admin opens someone else's from the super-admin switcher:
 *     `?token=...&dealer_id=...`. They should see that store.
 *
 * The override used to be written to localStorage and never cleared. So once a
 * super-admin had looked at one dealer, every later visit kept sending that
 * stale id -- including arriving fresh from a different dealer's own admin --
 * and the switcher honoured it, because the viewer really is an admin. RestPoint
 * opened its SMS page and got MBA Demo City.
 *
 * So: arriving with a fresh token and no dealer_id means "my own dealer", and
 * clears the override. Ordinary navigation between admin pages carries neither
 * parameter and leaves it alone, so a super-admin's session survives a click
 * from the dashboard to settings.
 *
 * Client-side only -- it touches window and localStorage.
 */
export interface AdminSession {
  token: string | null;
  overrideDealerId?: string;
}

const TOKEN_KEY = 'sms_auth_token';
const OVERRIDE_KEY = 'sms_dealer_override';

/**
 * @param returnPath where to rewrite the address bar once the parameters have
 *                   been consumed, e.g. '/admin/settings'.
 */
export function resolveAdminSession(returnPath: string): AdminSession {
  const sp = new URLSearchParams(window.location.search);
  const tokenParam = sp.get('token');
  const dealerParam = sp.get('dealer_id');

  if (tokenParam) localStorage.setItem(TOKEN_KEY, tokenParam);

  if (dealerParam) {
    localStorage.setItem(OVERRIDE_KEY, dealerParam);
  } else if (tokenParam) {
    // A fresh entry that names no dealer is a dealer opening their own page.
    localStorage.removeItem(OVERRIDE_KEY);
  }

  if (tokenParam || dealerParam) {
    window.history.replaceState({}, '', returnPath);
  }

  return {
    token: localStorage.getItem(TOKEN_KEY) || localStorage.getItem('auth_token'),
    overrideDealerId: localStorage.getItem(OVERRIDE_KEY) || undefined,
  };
}
