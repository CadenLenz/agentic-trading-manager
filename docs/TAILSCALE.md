# Private Tailscale Serve networking

Recommended production path: authenticated browser → tailnet ACLs → Tailscale Serve HTTPS → Fastify bound to 127.0.0.1:4010. Never bind publicly or enable Funnel. Tailscale is not a substitute for application login, session authorization, CSRF, reauthentication or proposal approvals.

On the actual Pi, authenticate the installed official Tailscale client, restrict tailnet ACLs to authorized operators and enable private Serve using the current [official Serve guide](https://tailscale.com/docs/features/tailscale-serve). The documented CLI is:

```bash
sudo tailscale serve --bg http://127.0.0.1:4010
tailscale serve status
```

Set BIND_HOST=127.0.0.1, PORT=4010 and WEB_ORIGIN/PRIVATE_UI_URL to the same generated private HTTPS origin. Keep secure cookies enabled in production. Verify from an authorized second tailnet device that HTTPS, login, CSRF-protected changes and authenticated SSE work. Verify an unauthorized tailnet identity cannot reach the service. Verify Serve status has no enabled AllowFunnel. **Do not run tailscale funnel.** No public domain, Cloudflare or internet-facing port is needed.

The Connections network card reports bound configuration and observed request socket/forwarded protocol. trustProxy remains false: forwarded headers are observation, not an authorization decision. Host acceptance checks actual tailscale status/Serve configuration; second-device reachability is a separately audited operator observation, never inferred from localhost success. No tailnet change was performed on this development machine.
