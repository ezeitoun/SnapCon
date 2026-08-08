// test/groupAccess.test.js — unit tests for the Audit feature's pure
// group-membership logic (groupAccess.js), extracted from server.js
// specifically so this is testable without spinning up Express/CFG/PRINTERS.
const test = require("node:test");
const assert = require("node:assert/strict");
const { GROUP_EVERYONE_ID, printerVisibleTo, removeGroupReferences } = require("../groupAccess");

test("printerVisibleTo: admin always sees every printer, regardless of their own group membership", () => {
  const admin = { role: "admin", groupIds: ["grp_other"] };
  const printer = { allowedGroups: ["grp_a"] };
  assert.equal(printerVisibleTo(admin, printer), true);
});

test("printerVisibleTo: the implicit admin (usersEnabled:false) always sees every printer", () => {
  const implicitAdmin = { role: "admin", implicit: true };
  const printer = { allowedGroups: ["grp_a"] };
  assert.equal(printerVisibleTo(implicitAdmin, printer), true);
});

test("printerVisibleTo: a regular user in one of the printer's allowed groups can see it", () => {
  const user = { role: "regular", groupIds: ["grp_a", "grp_b"] };
  const printer = { allowedGroups: ["grp_b", "grp_c"] };
  assert.equal(printerVisibleTo(user, printer), true);
});

test("printerVisibleTo: a regular user in NONE of the printer's allowed groups cannot see it", () => {
  const user = { role: "regular", groupIds: ["grp_a"] };
  const printer = { allowedGroups: ["grp_b", "grp_c"] };
  assert.equal(printerVisibleTo(user, printer), false);
});

test("printerVisibleTo: a printer with no allowedGroups falls back to Everyone", () => {
  const inEveryone = { role: "regular", groupIds: [GROUP_EVERYONE_ID] };
  const inOther = { role: "regular", groupIds: ["grp_other"] };
  const printer = {}; // no allowedGroups at all
  assert.equal(printerVisibleTo(inEveryone, printer), true);
  assert.equal(printerVisibleTo(inOther, printer), false);
});

test("printerVisibleTo: a printer with an explicit but EMPTY allowedGroups array also falls back to Everyone", () => {
  const inEveryone = { role: "regular", groupIds: [GROUP_EVERYONE_ID] };
  const printer = { allowedGroups: [] };
  assert.equal(printerVisibleTo(inEveryone, printer), true);
});

test("printerVisibleTo: a user with no groupIds falls back to Everyone membership", () => {
  const user = { role: "regular", groupIds: [] };
  const everyonePrinter = { allowedGroups: [GROUP_EVERYONE_ID] };
  const otherPrinter = { allowedGroups: ["grp_other"] };
  assert.equal(printerVisibleTo(user, everyonePrinter), true);
  assert.equal(printerVisibleTo(user, otherPrinter), false);
});

test("printerVisibleTo: a view-role (non-admin, non-regular) user is still subject to the same group check", () => {
  const user = { role: "view", groupIds: ["grp_a"] };
  assert.equal(printerVisibleTo(user, { allowedGroups: ["grp_a"] }), true);
  assert.equal(printerVisibleTo(user, { allowedGroups: ["grp_b"] }), false);
});

test("removeGroupReferences: strips a deleted group id out of every printer's allowedGroups", () => {
  const printers = [
    { id: "p1", allowedGroups: ["grp_a", "grp_b"] },
    { id: "p2", allowedGroups: ["grp_b"] },
    { id: "p3" } // no allowedGroups at all — must be left untouched, not crash
  ];
  removeGroupReferences("grp_b", printers, []);
  assert.deepEqual(printers[0].allowedGroups, ["grp_a"]);
  assert.deepEqual(printers[1].allowedGroups, []);
  assert.equal(printers[2].allowedGroups, undefined);
});

test("removeGroupReferences: strips a deleted group id out of every user's groupIds", () => {
  const users = [
    { id: "u1", groupIds: ["grp_a", "grp_b"] },
    { id: "u2", groupIds: ["grp_a"] },
    { id: "u3" } // no groupIds at all — must be left untouched, not crash
  ];
  removeGroupReferences("grp_b", [], users);
  assert.deepEqual(users[0].groupIds, ["grp_a"]);
  assert.deepEqual(users[1].groupIds, ["grp_a"]);
  assert.equal(users[2].groupIds, undefined);
});

test("removeGroupReferences: a group id that isn't referenced anywhere is a no-op", () => {
  const printers = [{ id: "p1", allowedGroups: ["grp_a"] }];
  const users = [{ id: "u1", groupIds: ["grp_a"] }];
  removeGroupReferences("grp_nonexistent", printers, users);
  assert.deepEqual(printers[0].allowedGroups, ["grp_a"]);
  assert.deepEqual(users[0].groupIds, ["grp_a"]);
});
