# ChatGPT remote MCP with Auth0

This deployment mode serves a public Streamable HTTP MCP endpoint at `/mcp`. It is for a shared service: every request carries an Auth0 access token, and every user has a separate encrypted Overleaf Git token and cache directory.

## Before deploying

Use the Overleaf Git integration as the supported connection method. Do not enable `OVERLEAF_ENABLE_WEB` for the shared service: web mode relies on a browser session cookie and is intentionally disabled for authenticated HTTP users.

Create an Auth0 API whose Identifier is exactly `MCP_PUBLIC_URL`, then enable RBAC and add these permissions:

- `overleaf:read`
- `overleaf:write`

Configure Auth0 for the OAuth authorization-code flow with PKCE and its OIDC discovery document. Add the precise ChatGPT redirect URI shown when you create the custom MCP connection; do not guess it. If your Auth0 configuration supports the stable OpenAI callback, it is `https://chatgpt.com/connector_platform_oauth_redirect`.

## Deploy

Set the following secrets in the deployment platform, and mount persistent storage at `/data` when using the included Dockerfile.

```text
MCP_PUBLIC_URL=https://mcp.example.com
AUTH0_DOMAIN=your-tenant.us.auth0.com
AUTH0_AUDIENCE=https://mcp.example.com
OVERLEAF_CREDENTIALS_KEY=<base64 32-byte random key>
```

`MCP_PUBLIC_URL` must be the HTTPS origin only, not the `/mcp` path. Generate the vault key once with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Then deploy:

```bash
docker build -t mcp-overleaf .
docker run --rm -p 3000:3000 --env-file .env -v mcp-overleaf-data:/data mcp-overleaf
```

Use a TLS-terminating host or reverse proxy in production. The server exposes `GET /healthz`, `GET /.well-known/oauth-protected-resource`, and `POST|GET|DELETE /mcp`.

## Store a user's Overleaf token

The deployment exposes an authenticated credential API for a trusted settings page or backend. It is deliberately not an MCP tool: an Overleaf Git token is a secret and must never be pasted into a ChatGPT conversation.

```http
POST /credentials
Authorization: Bearer <Auth0 access token>
Content-Type: application/json

{ "git_token": "olp_..." }
```

Tokens are AES-256-GCM encrypted at rest using `OVERLEAF_CREDENTIALS_KEY`, keyed to the Auth0 `sub` claim. For multi-replica production deployments, replace the file-backed `CredentialStore` with a database plus a managed KMS before scaling out.

## Connect ChatGPT

1. In ChatGPT, open **Plugins** and choose **Add custom MCP server**.
2. Enter `https://mcp.example.com/mcp` and select OAuth.
3. Complete the Auth0 login and grant the requested permissions.
4. Add the Overleaf Git token through your trusted settings page, then install the plugin and test it in a new chat.

The server advertises protected-resource metadata and validates every JWT's signature, issuer, audience, expiry, and `overleaf:read` permission before serving MCP requests.
