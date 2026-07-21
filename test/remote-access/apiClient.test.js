const test = require("node:test");
const assert = require("node:assert/strict");
const { provisionHub, CODES, ProvisioningError } = require("../../remote-access/RemoteAccessApiClient");

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) { prev[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k];
    }
  });
}

function withFetch(impl, fn) {
  const prev = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = prev; });
}

test("provisionHub refuses cleanly with no network call when SNAPCON_PROVISIONING_KEY is unset", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "" }, async () => {
    let called = false;
    await withFetch(() => { called = true; return Promise.reject(new Error("should not be called")); }, async () => {
      await assert.rejects(
        () => provisionHub({ installationId: "abc", localOrigin: "http://localhost:4545" }),
        e => e instanceof ProvisioningError && e.code === CODES.NO_PROVISIONING_KEY
      );
      assert.equal(called, false);
    });
  });
});

test("provisionHub sends a stable Idempotency-Key derived from installationId", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    const seenKeys = [];
    await withFetch(async (url, opts) => {
      seenKeys.push(opts.headers["Idempotency-Key"]);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ hubId: "h1", hostname: "h1.snapcon.app", publicUrl: "https://h1.snapcon.app", tunnelId: "t1", tunnelToken: "tok", status: "provisioned" }) };
    }, async () => {
      await provisionHub({ installationId: "same-install-id", localOrigin: "http://localhost:4545" });
      await provisionHub({ installationId: "same-install-id", localOrigin: "http://localhost:4545" });
    });
    assert.equal(seenKeys.length, 2);
    assert.equal(seenKeys[0], seenKeys[1]);
    assert.match(seenKeys[0], /^[0-9a-f]{64}$/);
  });
});

test("provisionHub maps 401 to AUTH_FAILED", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    await withFetch(async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) }), async () => {
      await assert.rejects(
        () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
        e => e instanceof ProvisioningError && e.code === CODES.AUTH_FAILED
      );
    });
  });
});

test("provisionHub maps 429 to RATE_LIMITED and surfaces Retry-After", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    await withFetch(async () => ({ ok: false, status: 429, headers: { get: h => h === "retry-after" ? "30" : null }, json: async () => ({}) }), async () => {
      await assert.rejects(
        () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
        e => e instanceof ProvisioningError && e.code === CODES.RATE_LIMITED && e.retryAfter === "30"
      );
    });
  });
});

test("provisionHub maps 500/502 to BACKEND_ERROR", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    for (const status of [500, 502]) {
      await withFetch(async () => ({ ok: false, status, headers: { get: () => null }, json: async () => ({}) }), async () => {
        await assert.rejects(
          () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
          e => e instanceof ProvisioningError && e.code === CODES.BACKEND_ERROR
        );
      });
    }
  });
});

test("provisionHub maps invalid JSON to INVALID_RESPONSE", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    await withFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } }), async () => {
      await assert.rejects(
        () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
        e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE
      );
    });
  });
});

test("provisionHub maps a missing tunnelToken to MISSING_TOKEN", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    await withFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ hubId: "h1" }) }), async () => {
      await assert.rejects(
        () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
        e => e instanceof ProvisioningError && e.code === CODES.MISSING_TOKEN
      );
    });
  });
});

// Hardening: found by code review. A response with a tunnelToken but a
// missing/blank hostname or publicUrl wouldn't fail anywhere downstream —
// it'd get persisted as-is, and the periodic public probe would silently
// skip an empty publicUrl forever (treated as "not configured" rather than
// "backend sent garbage"), leaving the state stuck with no explanation.
test("provisionHub rejects a response with a tunnelToken but a missing/blank hostname, publicUrl, or hubId", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    const base = { hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "t1", tunnelToken: "tok", status: "provisioned" };
    for (const field of ["hubId", "hostname", "publicUrl"]) {
      await withFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ...base, [field]: "" }) }), async () => {
        await assert.rejects(
          () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
          e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE,
          "missing '" + field + "' must be rejected"
        );
      });
    }
  });
});

// Hardening: found by code review. publicUrl gets set as a clickable
// anchor's href in the browser (Settings → Remote Access → Open Remote
// URL) — a javascript:/data: scheme there would turn our own UI into a
// self-XSS vector the moment an admin clicked it. Only https:// (the only
// scheme a real Cloudflare Tunnel hostname would ever use) is accepted.
test("provisionHub rejects a publicUrl that isn't an https:// URL", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    const base = { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "t1", tunnelToken: "tok", status: "provisioned" };
    for (const badUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://hub1.snapcon.app", "ftp://hub1.snapcon.app"]) {
      await withFetch(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ...base, publicUrl: badUrl }) }), async () => {
        await assert.rejects(
          () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
          e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE,
          JSON.stringify(badUrl) + " must be rejected"
        );
      });
    }
  });
});

test("provisionHub maps a network failure / timeout to AMBIGUOUS_TIMEOUT, not any 'retry-safe' code", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    await withFetch(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, async () => {
      await assert.rejects(
        () => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }),
        e => e instanceof ProvisioningError && e.code === CODES.AMBIGUOUS_TIMEOUT
      );
    });
  });
});

test("provisionHub succeeds and returns the full hub shape on a valid response", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    await withFetch(async () => ({
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ hubId: "hub_1", hostname: "hub1.snapcon.app", publicUrl: "https://hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "secret-token", status: "provisioned" })
    }), async () => {
      const result = await provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" });
      assert.equal(result.hubId, "hub_1");
      assert.equal(result.tunnelToken, "secret-token");
    });
  });
});

test("provisionHub never retries internally on AMBIGUOUS_TIMEOUT — exactly one fetch call per invocation", async () => {
  await withEnv({ SNAPCON_PROVISIONING_KEY: "dev-key" }, async () => {
    let calls = 0;
    await withFetch(async () => { calls++; const e = new Error("timeout"); e.name = "AbortError"; throw e; }, async () => {
      await assert.rejects(() => provisionHub({ installationId: "i", localOrigin: "http://localhost:4545" }));
    });
    assert.equal(calls, 1);
  });
});
