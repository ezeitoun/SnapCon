// fixtures/fake-cloudflared.js — stands in for the real `cloudflared` binary
// in tests. Lives outside test/ deliberately: node --test's default file
// discovery treats anything under a directory named "test" as a candidate
// test file, and this script's argv-mode-driven, sometimes-never-exits
// behavior would otherwise get "run" as if it were a test itself. Never
// named "cloudflared"; tests point a spawnFn override at this script
// instead of a real binary. Modes selected via argv[2]:
//
//   connected  prints a line CONNECTION_EVIDENCE_RE matches, stays alive
//              until SIGTERM, then exits 0 (clean stop).
//   crash      prints a startup line, then exits 1 after 200ms unprompted
//              (simulates an unexpected crash — should trigger a scheduled
//              restart in the real manager).
//   hang       ignores SIGTERM entirely, only dies to SIGKILL (tests the
//              stop() escalation path).
//   error      writes to stderr and exits 1 immediately.
//
// Deliberately echoes TUNNEL_TOKEN into a stdout line if set — this is the
// key integration-test assertion: the real CloudflaredManager reading this
// fixture's actual stdout must never let that raw value reach any logged or
// stored string.
const mode = process.argv[2] || "connected";
const token = process.env.TUNNEL_TOKEN || "";

if (token) console.log("debug: got token " + token);

if (mode === "connected") {
  console.log("Registered tunnel connection");
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1000 * 60 * 60); // stay alive
} else if (mode === "crash") {
  console.log("starting up...");
  setTimeout(() => process.exit(1), 200);
} else if (mode === "hang") {
  console.log("Registered tunnel connection");
  process.on("SIGTERM", () => {}); // deliberately ignore
  setInterval(() => {}, 1000 * 60 * 60);
} else if (mode === "error") {
  console.error("fatal: could not connect");
  process.exit(1);
} else {
  console.error("unknown fixture mode: " + mode);
  process.exit(2);
}
