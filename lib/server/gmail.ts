/**
 * @file lib/server/gmail.ts
 * FEATURE 8: Incremental Gmail OAuth and send.
 *
 * SCOPE DISCIPLINE: the only scope ever requested is
 *   https://www.googleapis.com/auth/gmail.send
 * which permits sending and nothing else -- it cannot read, list, or search the mailbox.
 * This is requested incrementally, separately from sign-in, so declining it costs the
 * user nothing else.
 *
 * The digest is sent FROM the user's own account TO the same address. No third-party
 * email vendor is involved, and the application never holds the message after send.
 *
 * Refresh tokens live at /gmailTokens/{uid}, which firestore.rules denies to every
 * client. They are read and written only with the service credential.
 */

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GMAIL_SEND_ENDPOINT = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export class GmailError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = 'GmailError';
  }
}

function oauthClient(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new GmailError(
      'Gmail OAuth is not configured: set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.',
      500
    );
  }
  return { clientId, clientSecret };
}

export interface ExchangedTokens {
  refreshToken: string | null;
  accessToken: string;
  expiresIn: number;
  grantedScopes: string[];
}

/**
 * Exchanges an authorization code for tokens and verifies that the granted scope set is
 * exactly what we asked for. A grant carrying more than gmail.send is rejected rather
 * than quietly accepted.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string
): Promise<ExchangedTokens> {
  const { clientId, clientSecret } = oauthClient();

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    cache: 'no-store',
  });

  const body = await res.text();
  if (!res.ok) {
    throw new GmailError(`OAuth code exchange failed (HTTP ${res.status}): ${body.slice(0, 300)}`, 502);
  }

  const data = JSON.parse(body);
  const grantedScopes: string[] = (data.scope || '').split(' ').filter(Boolean);

  if (!grantedScopes.includes(GMAIL_SEND_SCOPE)) {
    throw new GmailError('The gmail.send scope was not granted; the digest cannot be enabled.', 400);
  }

  // Defence in depth: refuse a grant that is broader than what the feature needs.
  const unexpected = grantedScopes.filter(
    (s) => s !== GMAIL_SEND_SCOPE && !s.startsWith('openid') && !/userinfo\.(email|profile)$/.test(s)
  );
  if (unexpected.length > 0) {
    await revokeToken(data.access_token).catch(() => undefined);
    throw new GmailError(
      `Refusing an over-broad Gmail grant. Unexpected scopes: ${unexpected.join(', ')}`,
      400
    );
  }

  return {
    refreshToken: data.refresh_token ?? null,
    accessToken: data.access_token,
    expiresIn: data.expires_in ?? 3600,
    grantedScopes,
  };
}

/** Mints a short-lived access token from a stored refresh token. */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = oauthClient();

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
    cache: 'no-store',
  });

  const body = await res.text();
  if (!res.ok) {
    throw new GmailError(
      `Gmail token refresh failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
      res.status === 400 || res.status === 401 ? 401 : 502
    );
  }
  return JSON.parse(body).access_token;
}

/** Revokes a refresh or access token, so disabling the digest truly releases access. */
export async function revokeToken(token: string): Promise<void> {
  await fetch(REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
    cache: 'no-store',
  });
}

/** Sends a prepared base64url RFC 2822 message via the user's own mailbox. */
export async function sendGmailMessage(accessToken: string, raw: string): Promise<string> {
  const res = await fetch(GMAIL_SEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
    cache: 'no-store',
  });

  const body = await res.text();
  if (!res.ok) {
    throw new GmailError(`Gmail send failed (HTTP ${res.status}): ${body.slice(0, 300)}`, 502);
  }
  return JSON.parse(body).id;
}
