/** Only curated, credential-free messages may cross the API boundary. */
export class ConnectionSetupError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}

export function robinhoodCallback(env: NodeJS.ProcessEnv = process.env): string {
  const privateUrl = env.PRIVATE_UI_URL?.trim();
  const webOrigin = env.WEB_ORIGIN?.trim();
  const origin = privateUrl || webOrigin || (env.NODE_ENV === 'production' ? '' : 'http://localhost:4010');
  let url: URL;
  try { url = new URL(origin); } catch {
    throw new ConnectionSetupError('PRIVATE_ADDRESS_MISSING', 'Your app address is missing or invalid. Set PRIVATE_UI_URL and WEB_ORIGIN to the same private HTTPS address from Tailscale Serve, then restart the app. No trading was enabled.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !['https:', 'http:'].includes(url.protocol)) {
    throw new ConnectionSetupError('PRIVATE_ADDRESS_INVALID', 'Use only the app origin in PRIVATE_UI_URL: https://your-pi.your-tailnet.ts.net, without a path, login, query, or fragment. Restart the app after updating it.');
  }
  if (url.protocol !== 'https:' && (!loopback || env.NODE_ENV === 'production')) {
    throw new ConnectionSetupError('PRIVATE_HTTPS_REQUIRED', 'Robinhood needs a secure return address. Enable Tailscale Serve HTTPS, set PRIVATE_UI_URL and WEB_ORIGIN to that address, then restart and open the app there. No trading was enabled.');
  }
  if (privateUrl && webOrigin && privateUrl.replace(/\/$/, '') !== webOrigin.replace(/\/$/, '')) {
    throw new ConnectionSetupError('PRIVATE_ADDRESS_MISMATCH', 'The app has two different addresses. Set PRIVATE_UI_URL and WEB_ORIGIN to the same private HTTPS origin, restart, and sign in at that address.');
  }
  return url.origin + '/api/v2/connections/robinhood/callback';
}

export function connectionSetup() {
  try { return { ready: true, callbackUrl: robinhoodCallback(), code: null, message: null }; }
  catch (error) {
    if (!(error instanceof ConnectionSetupError)) throw error;
    return { ready: false, callbackUrl: null, code: error.code, message: error.message };
  }
}

export function robinhoodFailure(error: unknown): ConnectionSetupError {
  if (error instanceof ConnectionSetupError) return error;
  const text = error instanceof Error ? error.message.toLowerCase() : '';
  if (/register|registration|client_id|invalid_client/.test(text)) return new ConnectionSetupError('BROKER_REGISTRATION', 'Robinhood did not accept this app registration. Check that your account has access to Robinhood’s official agent connection and that the configured callback is accepted. Retry Connect after correcting access; trading remains locked.', 502);
  if (/redirect/.test(text)) return new ConnectionSetupError('BROKER_CALLBACK', 'Robinhood rejected the return address. Check the callback shown in Connection details against your private HTTPS app address, then reconnect.', 502);
  if (/401|unauthorized|invalid_grant|expired/.test(text)) return new ConnectionSetupError('BROKER_AUTH_EXPIRED', 'Robinhood authorization expired or was declined. Choose Connect Robinhood and sign in again. Trading remains locked.', 401);
  if (/fetch|network|timeout|timed out|enotfound|econn/.test(text)) return new ConnectionSetupError('BROKER_UNREACHABLE', 'The app could not reach Robinhood. Check the Pi’s internet connection and clock, then retry Connect. No orders were sent.', 502);
  return new ConnectionSetupError('BROKER_CONNECTION_FAILED', 'Robinhood could not complete the connection. Check Connection details for the callback address, retry Connect, and use the diagnostic code when inspecting the server log. No orders were sent.', 502);
}
