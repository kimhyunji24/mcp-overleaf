import type { Config } from "./config.js";

const USER_AGENT = "overleaf-mcp (+https://github.com/overleaf-mcp)";

export interface ProjectSummary {
  id: string;
  name: string;
  lastUpdated?: string;
  accessLevel?: string;
  archived?: boolean;
  trashed?: boolean;
}

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function metaContent(html: string, name: string): string | undefined {
  const m = html.match(new RegExp(`<meta\\s+name="${name}"[^>]*?\\scontent="([^"]*)"`));
  return m ? decodeHtml(m[1]) : undefined;
}

/**
 * Client for Overleaf's (unofficial) web endpoints, authenticated with a browser session cookie.
 * Used for things the Git bridge cannot do: listing projects, compiling, and reading comments.
 */
export class OverleafWeb {
  private readonly cookies = new Map<string, string>();
  private csrfToken?: string;

  constructor(private readonly cfg: Config) {
    for (const part of cfg.sessionCookie?.split(";") ?? []) {
      const i = part.indexOf("=");
      if (i > 0) this.cookies.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
  }

  get enabled(): boolean {
    return this.cookies.size > 0;
  }

  requireEnabled(feature: string): void {
    if (!this.enabled) {
      throw new Error(
        `${feature} requires OVERLEAF_SESSION_COOKIE (your Overleaf browser session cookie). See the README for how to get it.`,
      );
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(res: Response): void {
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async request(urlOrPath: string, init: RequestInit = {}, redirects = 0): Promise<Response> {
    const url = new URL(urlOrPath, this.cfg.baseUrl);
    const headers = new Headers(init.headers);
    headers.set("User-Agent", USER_AGENT);
    // Never leak the session cookie to other hosts (e.g. the PDF download domain).
    if (url.host === new URL(this.cfg.baseUrl).host) headers.set("Cookie", this.cookieHeader());

    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    if (url.host === new URL(this.cfg.baseUrl).host) this.storeCookies(res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location") ?? "";
      if (/\/login\b/.test(location)) {
        throw new Error(
          "Overleaf session cookie is invalid or expired. Copy a fresh OVERLEAF_SESSION_COOKIE from your browser.",
        );
      }
      if (redirects >= 5 || !location) throw new Error(`Too many redirects fetching ${url.pathname}`);
      return this.request(new URL(location, url).toString(), init, redirects + 1);
    }
    return res;
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const res = await this.request(path, { ...init, headers });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private async getCsrf(refresh = false): Promise<string> {
    if (this.csrfToken && !refresh) return this.csrfToken;
    const html = await (await this.request("/project")).text();
    const token = metaContent(html, "ol-csrfToken");
    if (!token) throw new Error("Could not find a CSRF token on the Overleaf dashboard. Is the session cookie valid?");
    this.csrfToken = token;
    return token;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    this.requireEnabled("Listing projects");
    const res = await this.request("/user/projects", { headers: { Accept: "application/json" } });
    if (res.ok && res.headers.get("content-type")?.includes("json")) {
      const data = (await res.json()) as { projects?: Array<{ _id?: string; id?: string; name: string; accessLevel?: string }> };
      if (data.projects) {
        return data.projects.map((p) => ({ id: p._id ?? p.id ?? "", name: p.name, accessLevel: p.accessLevel }));
      }
    }

    // Fallback: the dashboard page embeds the project list as JSON.
    const html = await (await this.request("/project")).text();
    this.csrfToken ??= metaContent(html, "ol-csrfToken");
    const blob = metaContent(html, "ol-prefetchedProjectsBlob");
    if (!blob) throw new Error("Could not read the project list from Overleaf.");
    const data = JSON.parse(blob) as { projects: Array<ProjectSummary & { _id?: string }> };
    return data.projects.map((p) => ({
      id: p.id ?? p._id ?? "",
      name: p.name,
      lastUpdated: p.lastUpdated,
      accessLevel: p.accessLevel,
      archived: p.archived,
      trashed: p.trashed,
    }));
  }

  async downloadZip(projectId: string): Promise<Uint8Array> {
    this.requireEnabled("Downloading a project without Git");
    const res = await this.request(`/project/${projectId}/download/zip`);
    if (!res.ok) throw new Error(`Downloading project ${projectId} failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
