import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export interface Auth0Identity {
  subject: string;
  auth: AuthInfo;
}

export class Auth0Verifier {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(domain: string, private readonly audience: string) {
    this.issuer = `https://${domain.replace(/^https:\/\//, "").replace(/\/+$/, "")}/`;
    this.jwks = createRemoteJWKSet(new URL(`${this.issuer}.well-known/jwks.json`));
  }

  async verify(authorization: string | undefined): Promise<Auth0Identity> {
    const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) throw new Error("Missing bearer token.");
    const { payload } = await jwtVerify(token, this.jwks, { issuer: this.issuer, audience: this.audience });
    const subject = payload.sub;
    if (!subject) throw new Error("Auth0 token does not include a subject.");
    const scopes = scopesOf(payload);
    if (!scopes.includes("overleaf:read")) throw new Error("Auth0 token is missing the overleaf:read permission.");
    return {
      subject,
      auth: { token, clientId: String(payload.azp ?? payload.client_id ?? "chatgpt"), scopes, expiresAt: payload.exp, extra: { subject } },
    };
  }
}

function scopesOf(payload: JWTPayload): string[] {
  const scope = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  const permissions = Array.isArray(payload.permissions) ? payload.permissions.filter((p): p is string => typeof p === "string") : [];
  return [...new Set([...scope, ...permissions])];
}
