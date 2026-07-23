const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createRegistrationSession, getRegistrationSessionStatus,
  provisionHub, getHubStatus, rotateTunnelToken, disableHub,
  CODES, ProvisioningError
} = require("../../remote-access/RemoteAccessApiClient");
const Ed25519Identity = require("../../remote-access/Ed25519Identity");

function withFetch(impl, fn) {
  const prev = global.fetch;
  global.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = prev; });
}

function jsonResponse(status, body, extraHeaders) {
  return { ok: status >= 200 && status < 300, status, headers: { get: h => (extraHeaders && extraHeaders[h]) || null }, json: async () => body };
}

async function fakeIdentity() {
  const { privateKey } = await Ed25519Identity.generateKeypair();
  return { installationId: "inst_test", privateKey };
}

// ---- createRegistrationSession ----

test("createRegistrationSession succeeds and returns the full session shape", async () => {
  await withFetch(async () => jsonResponse(201, {
    sessionId: "regsess_1", installationId: "inst_1",
    registerUrl: "https://api.snapcon.app/register/regsess_1", expiresAt: "2026-07-21T15:00:00.000Z"
  }), async () => {
    const result = await createRegistrationSession({ publicKey: "abc" });
    assert.equal(result.sessionId, "regsess_1");
    assert.equal(result.installationId, "inst_1");
  });
});

test("createRegistrationSession maps 400 invalid_public_key to INVALID_PUBLIC_KEY", async () => {
  await withFetch(async () => jsonResponse(400, { error: "invalid_public_key", message: "bad key" }), async () => {
    await assert.rejects(
      () => createRegistrationSession({ publicKey: "not-valid" }),
      e => e instanceof ProvisioningError && e.code === CODES.INVALID_PUBLIC_KEY
    );
  });
});

test("createRegistrationSession rejects a registerUrl that isn't https://", async () => {
  for (const badUrl of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://api.snapcon.app/register/x", "ftp://api.snapcon.app/register/x"]) {
    await withFetch(async () => jsonResponse(201, { sessionId: "s", installationId: "i", registerUrl: badUrl, expiresAt: "2026-07-21T15:00:00.000Z" }), async () => {
      await assert.rejects(
        () => createRegistrationSession({ publicKey: "abc" }),
        e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE,
        JSON.stringify(badUrl) + " must be rejected"
      );
    });
  }
});

test("createRegistrationSession rejects a response missing sessionId/installationId/expiresAt", async () => {
  const base = { sessionId: "s", installationId: "i", registerUrl: "https://api.snapcon.app/register/s", expiresAt: "2026-07-21T15:00:00.000Z" };
  for (const field of ["sessionId", "installationId", "expiresAt"]) {
    await withFetch(async () => jsonResponse(201, { ...base, [field]: "" }), async () => {
      await assert.rejects(
        () => createRegistrationSession({ publicKey: "abc" }),
        e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE
      );
    });
  }
});

test("createRegistrationSession maps a network failure/timeout to AMBIGUOUS_TIMEOUT", async () => {
  await withFetch(async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; }, async () => {
    await assert.rejects(
      () => createRegistrationSession({ publicKey: "abc" }),
      e => e instanceof ProvisioningError && e.code === CODES.AMBIGUOUS_TIMEOUT
    );
  });
});

// ---- getRegistrationSessionStatus ----

test("getRegistrationSessionStatus returns the status shape for a valid known status", async () => {
  for (const status of ["pending", "approved", "expired", "rejected"]) {
    await withFetch(async () => jsonResponse(200, { sessionId: "s", status, installationId: "i", expiresAt: "2026-07-21T15:00:00.000Z" }), async () => {
      const result = await getRegistrationSessionStatus("s");
      assert.equal(result.status, status);
    });
  }
});

test("getRegistrationSessionStatus rejects an unrecognized status value", async () => {
  await withFetch(async () => jsonResponse(200, { sessionId: "s", status: "some-future-status", installationId: "i" }), async () => {
    await assert.rejects(
      () => getRegistrationSessionStatus("s"),
      e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE
    );
  });
});

test("getRegistrationSessionStatus maps a 404 to SESSION_INVALID", async () => {
  await withFetch(async () => jsonResponse(404, { error: "session_not_found" }), async () => {
    await assert.rejects(
      () => getRegistrationSessionStatus("does-not-exist"),
      e => e instanceof ProvisioningError && e.code === CODES.SESSION_INVALID
    );
  });
});

// ---- provisionHub ----

test("provisionHub sends signed headers", async () => {
  let seenHeaders;
  await withFetch(async (url, opts) => {
    seenHeaders = opts.headers;
    return jsonResponse(201, { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false });
  }, async () => {
    await provisionHub({ identity: await fakeIdentity() });
  });
  assert.ok(seenHeaders["X-SnapCon-Installation-Id"]);
  assert.ok(seenHeaders["X-SnapCon-Timestamp"]);
  assert.ok(seenHeaders["X-SnapCon-Nonce"]);
  assert.ok(seenHeaders["X-SnapCon-Signature"]);
});

test("provisionHub 201 builds publicUrl from hostname and returns the full shape", async () => {
  await withFetch(async () => jsonResponse(201, { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false }), async () => {
    const result = await provisionHub({ identity: await fakeIdentity() });
    assert.equal(result.hubId, "hub_1");
    assert.equal(result.publicUrl, "https://hub1.snapcon.app");
    assert.equal(result.tunnelToken, "tok_1");
    assert.equal(result.existing, false);
  });
});

test("provisionHub rejects a hostname containing a scheme/path/whitespace before it's ever used to build a URL", async () => {
  for (const badHost of ["evil.com/../attacker", "javascript:alert(1)", "hub1.snapcon.app/x", "hub1.snapcon.app "]) {
    await withFetch(async () => jsonResponse(201, { hubId: "hub_1", hostname: badHost, tunnelId: "tun_1", tunnelToken: "tok_1", status: "provisioned", existing: false }), async () => {
      await assert.rejects(
        async () => provisionHub({ identity: await fakeIdentity() }),
        e => e instanceof ProvisioningError && e.code === CODES.INVALID_RESPONSE,
        JSON.stringify(badHost) + " must be rejected"
      );
    });
  }
});

test("provisionHub 200 existing:true with tunnelToken:null is treated as success, not MISSING_TOKEN", async () => {
  await withFetch(async () => jsonResponse(200, { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: null, status: "provisioned", existing: true }), async () => {
    const result = await provisionHub({ identity: await fakeIdentity() });
    assert.equal(result.existing, true);
    assert.equal(result.tunnelToken, null);
  });
});

test("provisionHub 201 with a blank tunnelToken is MISSING_TOKEN", async () => {
  await withFetch(async () => jsonResponse(201, { hubId: "hub_1", hostname: "hub1.snapcon.app", tunnelId: "tun_1", tunnelToken: "", status: "provisioned", existing: false }), async () => {
    await assert.rejects(
      async () => provisionHub({ identity: await fakeIdentity() }),
      e => e instanceof ProvisioningError && e.code === CODES.MISSING_TOKEN
    );
  });
});

test("provisionHub maps 401 sub-codes to their specific CODES, not a generic AUTH_FAILED", async () => {
  const cases = [
    ["invalid_signature", CODES.INVALID_SIGNATURE],
    ["stale_timestamp", CODES.STALE_TIMESTAMP],
    ["replay_detected", CODES.REPLAY_DETECTED],
    ["unknown_installation", CODES.UNKNOWN_INSTALLATION],
    ["installation_suspended", CODES.INSTALLATION_SUSPENDED],
    ["installation_revoked", CODES.INSTALLATION_REVOKED]
  ];
  for (const [errorCode, expectedCode] of cases) {
    await withFetch(async () => jsonResponse(401, { error: errorCode, message: "nope" }), async () => {
      await assert.rejects(
        async () => provisionHub({ identity: await fakeIdentity() }),
        e => e instanceof ProvisioningError && e.code === expectedCode,
        errorCode + " must map to " + expectedCode
      );
    });
  }
});

test("provisionHub maps an unrecognized 401 sub-code to AUTH_FAILED (fail-safe default)", async () => {
  await withFetch(async () => jsonResponse(401, { error: "some_future_code", message: "nope" }), async () => {
    await assert.rejects(
      async () => provisionHub({ identity: await fakeIdentity() }),
      e => e instanceof ProvisioningError && e.code === CODES.AUTH_FAILED
    );
  });
});

test("provisionHub maps 429 to RATE_LIMITED and surfaces Retry-After", async () => {
  await withFetch(async () => jsonResponse(429, {}, { "retry-after": "30" }), async () => {
    await assert.rejects(
      async () => provisionHub({ identity: await fakeIdentity() }),
      e => e instanceof ProvisioningError && e.code === CODES.RATE_LIMITED && e.retryAfter === "30"
    );
  });
});

test("provisionHub maps a network failure/timeout to AMBIGUOUS_TIMEOUT and never retries internally", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; const e = new Error("timeout"); e.name = "AbortError"; throw e; }, async () => {
    await assert.rejects(
      async () => provisionHub({ identity: await fakeIdentity() }),
      e => e instanceof ProvisioningError && e.code === CODES.AMBIGUOUS_TIMEOUT
    );
  });
  assert.equal(calls, 1);
});

// ---- rotateTunnelToken ----

test("rotateTunnelToken's 503 token_rotation_unavailable maps to ROTATION_UNAVAILABLE, not BACKEND_ERROR", async () => {
  await withFetch(async () => jsonResponse(503, { error: "token_rotation_unavailable", message: "temporarily unavailable" }), async () => {
    await assert.rejects(
      async () => rotateTunnelToken({ identity: await fakeIdentity(), hubId: "hub_1" }),
      e => e instanceof ProvisioningError && e.code === CODES.ROTATION_UNAVAILABLE
    );
  });
});

test("rotateTunnelToken succeeds and returns the new token when enabled", async () => {
  await withFetch(async () => jsonResponse(200, { hubId: "hub_1", tunnelToken: "new-tok", status: "provisioned" }), async () => {
    const result = await rotateTunnelToken({ identity: await fakeIdentity(), hubId: "hub_1" });
    assert.equal(result.tunnelToken, "new-tok");
  });
});

// ---- getHubStatus ----

test("getHubStatus's 404 maps to HUB_NOT_FOUND", async () => {
  await withFetch(async () => jsonResponse(404, { error: "hub_not_found" }), async () => {
    await assert.rejects(
      async () => getHubStatus({ identity: await fakeIdentity(), hubId: "hub_missing" }),
      e => e instanceof ProvisioningError && e.code === CODES.HUB_NOT_FOUND
    );
  });
});

test("getHubStatus never surfaces a token-shaped field even if the backend sends one", async () => {
  await withFetch(async () => jsonResponse(200, { hubId: "hub_1", hostname: "hub1.snapcon.app", status: "provisioned", createdAt: "x", updatedAt: "y", tunnelToken: "should-never-appear" }), async () => {
    const result = await getHubStatus({ identity: await fakeIdentity(), hubId: "hub_1" });
    assert.equal(result.tunnelToken, undefined);
    assert.ok(!JSON.stringify(result).includes("should-never-appear"));
  });
});

// ---- disableHub ----

test("disableHub returns the idempotent-success shape", async () => {
  await withFetch(async () => jsonResponse(200, { hubId: "hub_1", status: "revoked", deletionStatus: "complete" }), async () => {
    const result = await disableHub({ identity: await fakeIdentity(), hubId: "hub_1" });
    assert.equal(result.status, "revoked");
    assert.equal(result.deletionStatus, "complete");
  });
});

test("disableHub on a second call (already gone) still succeeds — same 200 shape", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return jsonResponse(200, { hubId: "hub_1", status: "revoked", deletionStatus: "complete" }); }, async () => {
    const identity = await fakeIdentity();
    await disableHub({ identity, hubId: "hub_1" });
    const result = await disableHub({ identity, hubId: "hub_1" });
    assert.equal(result.status, "revoked");
  });
  assert.equal(calls, 2);
});
