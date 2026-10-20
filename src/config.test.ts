import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";
import { OverleafWeb } from "./web.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("a session cookie alone does not enable web mode", () => {
  withEnv({ OVERLEAF_SESSION_COOKIE: "abc", OVERLEAF_ENABLE_WEB: undefined }, () => {
    const web = new OverleafWeb(loadConfig());
    assert.equal(web.enabled, false);
    assert.throws(() => web.requireEnabled("Compiling"), /off by default.*OVERLEAF_ENABLE_WEB=1/s);
  });
});

test("web mode needs both the opt-in flag and a cookie", () => {
  withEnv({ OVERLEAF_SESSION_COOKIE: "abc", OVERLEAF_ENABLE_WEB: "1" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.sessionCookie, "overleaf_session2=abc");
    assert.equal(new OverleafWeb(cfg).enabled, true);
  });
  withEnv({ OVERLEAF_SESSION_COOKIE: undefined, OVERLEAF_ENABLE_WEB: "true" }, () => {
    const web = new OverleafWeb(loadConfig());
    assert.equal(web.enabled, false);
    assert.throws(() => web.requireEnabled("Compiling"), /needs OVERLEAF_SESSION_COOKIE/);
  });
  withEnv({ OVERLEAF_SESSION_COOKIE: "abc", OVERLEAF_ENABLE_WEB: "0" }, () => {
    assert.equal(new OverleafWeb(loadConfig()).enabled, false);
  });
});
