// public/rediscover.js — Settings > Printers "Rediscover": what changed about
// each saved printer since it was added (docs/TODO.md §35).
//
// A plain script shared by both sides, like printer-identity.js: the browser
// loads it with a <script> tag (global Rediscover) and server.js requires it,
// so the rule that an update may not leave two printers with one address,
// serial or name is the same rule in the report and in the route that saves.
//
// The serial is the printer's identity, the address is what a router changes.
// So a saved serial found at a new address is an ADDRESS correction, and only
// a serial found nowhere, with a different one answering at the saved address,
// is a SERIAL correction. Copying whatever serial the saved address answers
// with would cement an address swap: each row would then carry the right
// serial and the wrong printer's history.
//
// Evidence is what the printers said: the network scan, plus a direct reading
// of each saved address. Nothing here guesses past it. A correction the
// evidence does not settle is offered for a person to confirm and never
// included in Update all: a serial saved on two printers, an address saved on
// two printers, or a scan that did not finish on a network the correction
// depends on. A scan that failed on some other network doesn't count against
// it — what was seen elsewhere is still seen.
//
// Which networks a correction depends on: an address move is safe only if no
// other device reports the same serial, which a complete scan of the network
// it left and the one it moved to rules out. A serial correction is safe only
// if the old serial isn't still on the printer's own network (where a router
// would have moved it), which a complete scan of that network rules out.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Rediscover = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Same rule as server.js's normPrinterName, which the slicer hook
  // (--printer <name>) uses to find a printer: two names it can't tell apart
  // are the same name.
  const normName = s => String(s || "").replace(/_/g, " ").trim().toLowerCase();
  const normSerial = s => String(s || "").trim().toUpperCase();
  const normHost = s => String(s || "").trim().toLowerCase();
  const urlKey = u => String(u || "").trim().replace(/\/+$/, "").toLowerCase();
  const subnetOf = ip => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(String(ip || "").trim())
    ? String(ip).trim().split(".").slice(0, 3).join(".") : null;

  // The saved url with only its host replaced: scheme and port stay the
  // printer's own. null when the url can't be taken apart.
  function withHost(url, host) {
    try {
      const u = new URL(url);
      u.hostname = host;
      return u.toString().replace(/\/+$/, "");
    } catch { return null; }
  }

  // The printer list as it would be after `changes` ([{ id, ip?, serial?,
  // name? }]). Copies; the input is left alone.
  function applyChanges(printers, changes) {
    const byId = new Map(changes.map(c => [c.id, c]));
    return printers.map(p => {
      const c = byId.get(p.id);
      if (!c) return p;
      const o = { ...p };
      if (c.ip !== undefined) { o.ip = c.ip; o.url = withHost(p.url, c.ip) || p.url; }
      if (c.serial !== undefined) o.serial = c.serial;
      if (c.name !== undefined) o.name = c.name;
      return o;
    });
  }

  // What `changes` would duplicate in `after` (the list with them applied).
  // Only the fields a change sets are checked: a duplicate that was already
  // there before is not this change's doing, and must not block it.
  function conflicts(after, changes) {
    const out = [];
    for (const c of changes) {
      const me = after.find(p => p.id === c.id);
      if (!me) { out.push({ id: c.id, field: "id" }); continue; }
      for (const o of after) {
        if (o.id === me.id) continue;
        if (c.ip !== undefined && urlKey(o.url) && urlKey(o.url) === urlKey(me.url)) out.push({ id: me.id, field: "address", other: o.id });
        if (c.serial !== undefined && normSerial(me.serial) && normSerial(o.serial) === normSerial(me.serial)) out.push({ id: me.id, field: "serial", other: o.id });
        if (c.name !== undefined && normName(o.name) === normName(me.name)) out.push({ id: me.id, field: "name", other: o.id });
      }
    }
    return out;
  }

  // The changes a fix applies, in the shape the save route takes.
  const fixChanges = fix => fix.moves.map(m => m.field === "address" ? { id: m.id, ip: m.to } : { id: m.id, serial: m.to });

  // printers: every saved printer, [{ id, name, url, ip, serial, checkable,
  //   fixedHost }] — checkable when its connector can be asked for a serial.
  // live: { [id]: { online, serial, name } }, each checkable printer's saved
  //   address read directly.
  // scans: [{ subnet: "192.168.40", label, complete, error, found: [{ ip,
  //   url, serial, device_name }] }] — complete only when the scan said done.
  function plan({ printers, live = {}, scans = [] }) {
    const checkable = printers.filter(p => p.checkable);
    const allComplete = scans.length > 0 && scans.every(s => s.complete);
    const scanned = new Set(scans.filter(s => s.complete).map(s => s.subnet));
    const tried = new Set(scans.map(s => s.subnet));
    const labelOf = sub => (scans.find(s => s.subnet === sub) || {}).label || sub + ".0/24";
    // The networks among `ips` that weren't scanned to the end. An address
    // that isn't an IPv4 address belongs to no network the scan can cover.
    const unverified = ips => [...new Set(ips.map(subnetOf))].filter(sub => sub && !scanned.has(sub)).map(labelOf);

    // What each address answered. The direct reading is the newer one, so it
    // replaces the scan's for the same address.
    const atHost = new Map();
    const record = (ip, serial, name) => {
      const host = normHost(ip);
      if (!host) return;
      atHost.set(host, { ip: String(ip).trim(), serial: normSerial(serial) ? String(serial).trim() : null, name: name ? String(name) : null });
    };
    for (const s of scans) for (const f of s.found || []) record(f.ip, f.serial, f.device_name);
    for (const p of checkable) {
      const r = live[p.id];
      if (r && r.online && p.ip) record(p.ip, r.serial, r.name);
    }
    const seenAt = new Map();   // serial -> hosts that answered with it
    for (const [host, r] of atHost) {
      if (!r.serial) continue;
      const k = normSerial(r.serial);
      if (!seenAt.has(k)) seenAt.set(k, []);
      seenAt.get(k).push(host);
    }
    const savedWithSerial = k => printers.filter(p => normSerial(p.serial) === k);
    const savedAtHost = h => printers.filter(p => normHost(p.ip) === h);

    const out = { checked: checkable.length, unchanged: [], fixes: [], blocked: [], conflicts: [],
      renames: [], notFound: [], notChecked: [], duplicates: [], newPrinters: [], updateAll: [],
      scanIssues: scans.filter(s => !s.complete).map(s => ({ label: s.label, error: s.error || null })) };

    // Saved twice: listed on its own, whatever else is found.
    const dupSerials = new Map(), dupHosts = new Map();
    for (const p of checkable) {
      const k = normSerial(p.serial), h = normHost(p.ip);
      if (k && savedWithSerial(k).length > 1) dupSerials.set(k, savedWithSerial(k).map(x => x.id));
      if (h && savedAtHost(h).length > 1) dupHosts.set(h, savedAtHost(h).map(x => x.id));
    }
    for (const [k, ids] of dupSerials) out.duplicates.push({ field: "serial", value: savedWithSerial(k)[0].serial, ids });
    for (const [h, ids] of dupHosts) out.duplicates.push({ field: "address", value: savedAtHost(h)[0].ip, ids });

    const absent = p => {
      const sub = subnetOf(p.ip);
      if (!p.ip) out.notChecked.push({ id: p.id, reason: "no-address" });
      else if (sub && scanned.has(sub) && allComplete) out.notFound.push(p.id);
      else out.notChecked.push({ id: p.id, reason: sub && tried.has(sub) ? "scan-incomplete" : "not-scanned" });
    };
    const rename = (p, reading) => {
      if (!reading || !reading.name || !reading.name.trim() || normName(reading.name) === normName(p.name)) return;
      const clash = printers.find(o => o.id !== p.id && normName(o.name) === normName(reading.name));
      out.renames.push({ id: p.id, from: p.name, to: reading.name.trim(), clash: clash ? clash.id : null });
    };
    // A serial nobody has saved, seen at exactly one address.
    const freeSerial = s => s && !savedWithSerial(normSerial(s)).length && (seenAt.get(normSerial(s)) || []).length === 1;

    const moves = [];
    for (const p of checkable) {
      const S = normSerial(p.serial), host = normHost(p.ip);
      const here = host ? atHost.get(host) : null;
      if (S && here && normSerial(here.serial) === S) { out.unchanged.push(p.id); rename(p, here); continue; }
      const hosts = S ? (seenAt.get(S) || []) : [];
      if (S && dupSerials.has(S)) {
        // Which of the printers saved with this serial is it? Only a person
        // can say. One whose own address answers with a serial nobody has is
        // offered that serial, to confirm.
        if (here && freeSerial(here.serial)) {
          out.fixes.push({ key: "s:" + p.id, moves: [{ id: p.id, field: "serial", from: p.serial, to: here.serial }], ambiguous: true, reason: "shared-serial" });
          rename(p, here);
        } else absent(p);
        continue;
      }
      if (hosts.length > 1) { out.conflicts.push({ id: p.id, reason: "serial-at-several", ips: hosts.map(h => atHost.get(h).ip) }); continue; }
      if (hosts.length === 1) {
        const to = atHost.get(hosts[0]);
        if (p.fixedHost) out.conflicts.push({ id: p.id, reason: "fixed-host", ips: [to.ip] });
        else { moves.push({ id: p.id, field: "address", from: p.ip, to: to.ip, byName: !subnetOf(p.ip), unverified: unverified([p.ip, to.ip]) }); rename(p, to); }
        continue;
      }
      // The saved serial (if any) answered nowhere.
      if (here && freeSerial(here.serial)) {
        // Nothing saved to lose, or a printer that always runs on this
        // machine (nothing else can answer there): settled by the reading.
        // Saved by host name, it has no network of its own: every scan counts.
        const open = !S || p.fixedHost ? []
          : subnetOf(p.ip) ? unverified([p.ip])
          : scans.length ? scans.filter(x => !x.complete).map(x => x.label) : [p.ip];
        const shared = dupHosts.has(host);
        out.fixes.push({ key: "s:" + p.id, moves: [{ id: p.id, field: "serial", from: p.serial || "", to: here.serial }],
          ambiguous: shared || open.length > 0, reason: shared ? "shared-address" : open.length ? "scan-incomplete" : null, unverified: open });
        rename(p, here);
        continue;
      }
      absent(p);
    }

    // An address correction onto an address another printer still has saved
    // would leave two printers on one address. Allowed only when that printer
    // is moving away in the same update (a swap, or a chain), so those apply
    // together. Dropping one can strand another, hence the loop.
    let active = moves.slice();
    for (let changed = true; changed;) {
      changed = false;
      for (const m of active.slice()) {
        const target = urlKey(withHost(printers.find(p => p.id === m.id).url, m.to));
        const holders = printers.filter(o => o.id !== m.id && urlKey(o.url) === target);
        const stays = holders.find(o => !active.some(x => x.id === o.id));
        if (stays) {
          out.blocked.push({ id: m.id, reason: "address-taken", other: stays.id, move: m });
          active = active.filter(x => x !== m);
          changed = true;
        }
      }
    }
    // Group moves that free each other's address.
    const parent = new Map(active.map(m => [m.id, m.id]));
    const find = x => (parent.get(x) === x ? x : find(parent.get(x)));
    for (const m of active) {
      const target = urlKey(withHost(printers.find(p => p.id === m.id).url, m.to));
      for (const o of printers) if (o.id !== m.id && urlKey(o.url) === target && parent.has(o.id)) parent.set(find(m.id), find(o.id));
    }
    const groups = new Map();
    for (const m of active) {
      const r = find(m.id);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(m);
    }
    // A printer saved by host name that answered nowhere by that name: the
    // scan found its serial at an IP, but whether the name stopped resolving
    // for good is for a person to say.
    // A move into or out of a network whose scan didn't finish: another
    // device there could report the same serial.
    for (const g of groups.values()) {
      const byName = g.some(m => m.byName);
      const open = [...new Set(g.flatMap(m => m.unverified))];
      out.fixes.push({ key: "a:" + g.map(m => m.id).sort().join(","), moves: g, ambiguous: byName || open.length > 0,
        reason: byName ? "host-name" : open.length ? "move-unverified" : null, unverified: open });
    }

    // Each fix on its own must leave no duplicate; one that would is shown,
    // not offered.
    out.fixes = out.fixes.filter(f => {
      const ch = fixChanges(f);
      const bad = conflicts(applyChanges(printers, ch), ch);
      if (!bad.length) return true;
      for (const m of f.moves) out.blocked.push({ id: m.id, reason: bad[0].field + "-taken", other: bad[0].other, move: m });
      return false;
    });
    // Update all: the settled fixes, as long as together they still leave no
    // duplicate. A fix that would clash with one already taken stays on its
    // own Update button.
    let taken = [];
    for (const f of out.fixes.filter(f => !f.ambiguous)) {
      const ch = fixChanges({ moves: [...taken, ...f.moves] });
      if (conflicts(applyChanges(printers, ch), ch).length) continue;
      taken = taken.concat(f.moves);
      out.updateAll.push(f.key);
    }

    // U1s the scan found that no saved printer is, at an address none has.
    const known = new Set(printers.map(p => normHost(p.ip)).filter(Boolean));
    for (const s of scans) for (const f of s.found || []) {
      if (!normSerial(f.serial) || savedWithSerial(normSerial(f.serial)).length || known.has(normHost(f.ip))) continue;
      if (out.newPrinters.some(n => normHost(n.ip) === normHost(f.ip))) continue;
      out.newPrinters.push(f);
    }
    return out;
  }

  return { plan, conflicts, applyChanges, fixChanges, withHost, normName, normSerial, subnetOf };
});
