// remote-access/serialize.js — serializes a group of async functions through
// one shared operation queue. A call to any wrapped function waits for
// whatever previous call (to ANY function in the same group) to fully settle
// before its own body runs, rather than racing it.
//
// Used by RemoteAccessService (enable()/disable()/startupInit() all mutate
// the same persisted state and the same CloudflaredManager instance across
// multiple `await` points — without this, two overlapping calls, e.g. a
// double-clicked Enable button, or Disable clicked mid-provision, could
// interleave unsafely) and by CloudflaredManager (start()/stop()/restart()
// have the identical problem one layer down: start() awaits
// InstanceLock.resolveBeforeStart() before `running` ever becomes true, so a
// stop() landing in that window would otherwise see "nothing running" and
// resolve immediately while the in-flight start() spawns a child anyway).
//
// IMPORTANT: createSerializer() must be called ONCE per group of functions
// that need to serialize against each other, and every function in that
// group wrapped through the SAME returned `serialize`. Calling
// createSerializer() separately for each function would give each its own
// independent queue and silently defeat the cross-function guarantee this
// exists for (e.g. a concurrent enable() and disable() would no longer wait
// for each other).
function createSerializer() {
  let opChain = Promise.resolve();
  return function serialize(fn) {
    return (...args) => {
      const run = () => fn(...args);
      const started = opChain.then(run, run);
      opChain = started.then(() => {}, () => {}); // keep the chain alive for the next call even if this one rejects
      return started;
    };
  };
}

module.exports = { createSerializer };
