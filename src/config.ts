import os from "node:os";
import path from "node:path";

export interface Config {
  /** Overleaf web origin, e.g. https://www.overleaf.com or a self-hosted instance. */
  baseUrl: string;
  /** Git bridge origin, e.g. https://git.overleaf.com. */
  gitUrl: string;
  gitToken?: string;
  /** Full Cookie header value, e.g. "overleaf_session2=s%3A...". */
  sessionCookie?: string;
  /**
   * Explicit opt-in for web mode (OVERLEAF_ENABLE_WEB). Web mode uses Overleaf's internal endpoints,
   * which may conflict with Overleaf's Acceptable Use Policy, so a cookie alone never turns it on.
   */
  webOptIn: boolean;
  defaultProject?: string;
  cacheDir: string;
  authorName: string;
  authorEmail: string;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function loadConfig(): Config {
  const cookie = env("OVERLEAF_SESSION_COOKIE");
  return {
    baseUrl: (env("OVERLEAF_BASE_URL") ?? "https://www.overleaf.com").replace(/\/+$/, ""),
    gitUrl: (env("OVERLEAF_GIT_URL") ?? "https://git.overleaf.com").replace(/\/+$/, ""),
    gitToken: env("OVERLEAF_GIT_TOKEN"),
    // A bare value is assumed to be overleaf.com's session cookie; pass "name=value" for other instances.
    sessionCookie: cookie && !cookie.includes("=") ? `overleaf_session2=${cookie}` : cookie,
    webOptIn: /^(1|true|yes|on)$/i.test(env("OVERLEAF_ENABLE_WEB") ?? ""),
    defaultProject: env("OVERLEAF_PROJECT_ID"),
    cacheDir: env("OVERLEAF_MCP_CACHE_DIR") ?? path.join(os.homedir(), ".mcp-overleaf"),
    authorName: env("OVERLEAF_GIT_AUTHOR_NAME") ?? "Overleaf MCP",
    authorEmail: env("OVERLEAF_GIT_AUTHOR_EMAIL") ?? "mcp-overleaf@users.noreply.github.com",
  };
}
