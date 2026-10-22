import { createHash } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Auth0Verifier } from "./auth.js";
import { loadConfig } from "./config.js";
import { CredentialStore } from "./credentials.js";
import { createServer } from "./index.js";

const config = loadConfig();
const publicUrl = required("MCP_PUBLIC_URL").replace(/\/+$/, "");
const verifier = new Auth0Verifier(required("AUTH0_DOMAIN"), required("AUTH0_AUDIENCE"));
const credentials = new CredentialStore(path.join(config.cacheDir, "credentials"), required("OVERLEAF_CREDENTIALS_KEY"));
const port = Number(process.env.MCP_HTTP_PORT ?? "3000");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when starting the HTTP server.`);
  return value;
}

function challenge(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "www-authenticate": `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${message.replaceAll('"', "'")}"`,
  });
  res.end(JSON.stringify({ error: message }));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id");
  res.setHeader("access-control-expose-headers", "mcp-session-id");
}

const app = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", publicUrl);
  cors(res);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();
  if (req.method === "GET" && url.pathname === "/healthz") return void res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
    return void res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        resource: publicUrl,
        authorization_servers: [`https://${required("AUTH0_DOMAIN").replace(/^https:\/\//, "").replace(/\/+$/, "")}/`],
        scopes_supported: ["overleaf:read", "overleaf:write"],
        resource_documentation: `${publicUrl}/docs`,
      }),
    );
  }

  let identity;
  try {
    identity = await verifier.verify(req.headers.authorization);
  } catch (error) {
    return challenge(res, 401, (error as Error).message);
  }

  if (url.pathname === "/credentials" && req.method === "POST") {
    try {
      const payload = await body(req) as { git_token?: unknown };
      if (typeof payload.git_token !== "string") throw new Error("git_token must be a string.");
      await credentials.put(identity.subject, payload.git_token);
      return void res.writeHead(204).end();
    } catch (error) {
      return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
    }
  }
  if (url.pathname === "/credentials" && req.method === "DELETE") {
    await credentials.delete(identity.subject);
    return void res.writeHead(204).end();
  }
  if (url.pathname !== "/mcp") return void res.writeHead(404).end("Not found");

  const credential = await credentials.get(identity.subject);
  if (!credential) return void res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Connect an Overleaf Git token before using this MCP server." }));
  const cacheKey = createHash("sha256").update(identity.subject).digest("hex");
  const userConfig = { ...config, gitToken: credential.gitToken, sessionCookie: undefined, webOptIn: false, cacheDir: path.join(config.cacheDir, "users", cacheKey) };
  const server = createServer(userConfig);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const authenticatedRequest = req as IncomingMessage & { auth: AuthInfo };
  authenticatedRequest.auth = identity.auth;
  res.on("close", () => void transport.close().then(() => server.close()));
  try {
    await server.connect(transport);
    await transport.handleRequest(authenticatedRequest, res);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500).end("Internal server error");
    console.error(error);
  }
});

app.listen(port, () => console.error(`mcp-overleaf HTTP server listening on ${publicUrl}/mcp (port ${port})`));
