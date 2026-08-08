// groupAccess.js — pure group-membership access-control logic (the Audit
// feature's group scoping), extracted from server.js so it's unit-testable
// without spinning up Express/CFG/PRINTERS. server.js requires this rather
// than defining it inline; ensureGroupsSchema/group CRUD stay in server.js
// since those need fs/CFG, not pure logic.
const GROUP_EVERYONE_ID = "grp_everyone";

// Does `user` belong to any group `p` is scoped to? Admins (including the
// implicit admin under usersEnabled:false) always see/act on everything,
// regardless of their own group membership. A printer or user with no
// explicit assignment falls back to grp_everyone — this is the ONLY place
// that fallback is applied; callers should always read through this
// function rather than checking p.allowedGroups directly.
function printerVisibleTo(user, p) {
  if (!user || user.role === "admin") return true;
  const allowed = (p.allowedGroups && p.allowedGroups.length) ? p.allowedGroups : [GROUP_EVERYONE_ID];
  const groups = (user.groupIds && user.groupIds.length) ? user.groupIds : [GROUP_EVERYONE_ID];
  return groups.some(g => allowed.includes(g));
}

// Strips `groupId` out of every printer's allowedGroups and every user's
// groupIds, in place — the two membership edges a deleted group must not be
// left dangling in. Pure array mutation, no I/O — server.js wraps this call
// with its own backup/restore-on-save-failure logic (see DELETE
// /api/groups/:id) since persisting the result is a file-system concern this
// module deliberately knows nothing about.
function removeGroupReferences(groupId, printers, users) {
  printers.forEach(p => { if (Array.isArray(p.allowedGroups)) p.allowedGroups = p.allowedGroups.filter(gId => gId !== groupId); });
  users.forEach(u => { if (Array.isArray(u.groupIds)) u.groupIds = u.groupIds.filter(gId => gId !== groupId); });
}

module.exports = { GROUP_EVERYONE_ID, printerVisibleTo, removeGroupReferences };
