// library/permissions.js — Library capabilities (docs/library-design.md §11).
//
// Routes check capabilities, never roles. Which role, group or user holds a
// capability lives in the permission_grants table, seeded with the role
// defaults below. Finer control later is new rows, not new code or schema.
//
// Revoking a default means writing allow=0, never deleting the row: seeding
// uses INSERT OR IGNORE, so a deleted default would silently come back on the
// next start.
"use strict";

const CAPABILITIES = [
  "library.view", "library.download",
  "library.edit.metadata", "library.edit.collections", "library.edit.cover", "library.edit.grouping",
  "library.review", "library.hide",
  "library.sources.manage", "library.backup", "library.diagnostics", "library.files.delete",
  "library.rescan",
];

const VIEW = ["library.view", "library.download"];
const EDIT = ["library.edit.metadata", "library.edit.collections", "library.edit.cover", "library.edit.grouping",
  "library.review", "library.hide"];
// library.files.delete is future work (D2) and is seeded for no role.
const ADMIN_ONLY = ["library.sources.manage", "library.backup", "library.diagnostics"];
// Rescan a location from the Library page: re-reads what is there, changes
// nothing a person decided. Managing locations (add, remove, change) stays
// library.sources.manage.
const RESCAN = ["library.rescan"];

const ROLE_DEFAULTS = {
  view: [...VIEW],
  regular: [...VIEW, ...EDIT, ...RESCAN],
  admin: [...VIEW, ...EDIT, ...RESCAN, ...ADMIN_ONLY],
};

function seedRoleDefaults(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO permission_grants (subject_type, subject_id, capability, allow) VALUES ('role', ?, ?, 1)");
  for (const [role, caps] of Object.entries(ROLE_DEFAULTS)) for (const cap of caps) ins.run(role, cap);
}

// Grants are read once and cached; call invalidate() after changing them.
function createAuthorizer(db) {
  let cache = null;
  const load = () => {
    cache = new Map();
    for (const r of db.prepare("SELECT subject_type, subject_id, capability, allow FROM permission_grants").all()) {
      cache.set(`${r.subject_type}|${r.subject_id}|${r.capability}`, r.allow ? 1 : 0);
    }
  };
  // Most specific wins: a user row, then any group row (a group deny beats a
  // group allow), then the role row. No row at all means no.
  function can(user, capability) {
    if (!CAPABILITIES.includes(capability)) throw new Error("unknown library capability: " + capability);
    if (!user) return false;
    if (user.implicit) return true;   // users disabled: everyone is the implicit admin, as elsewhere in SnapCon
    if (!cache) load();
    const u = user.id != null ? cache.get(`user|${user.id}|${capability}`) : undefined;
    if (u !== undefined) return u === 1;
    const groups = (user.groupIds || []).map(g => cache.get(`group|${g}|${capability}`)).filter(v => v !== undefined);
    if (groups.length) return !groups.includes(0);
    return cache.get(`role|${user.role}|${capability}`) === 1;
  }
  return { can, invalidate: () => { cache = null; } };
}

module.exports = { CAPABILITIES, ROLE_DEFAULTS, seedRoleDefaults, createAuthorizer };
