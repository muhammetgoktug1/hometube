import { CATEGORY_ERRORS, NOTICE, renamePlan, sameName } from "./categoryRules.js";

// Editing categories: category:rename { id, name } renames one, and category:add given a name there's a
// category for already answers that one ({ id, existed: true }) instead of making a second. Off unless
// HOMETUBE_CATEGORY_EDIT=1, and then nothing here runs: no event, no notice, no log line, and category:add
// makes a new category for every name, as before. With profiles on, lib/profileGate.js does the same with
// the profile's own categories.
export const ON = /^(1|true|yes)$/i.test(process.env.HOMETUBE_CATEGORY_EDIT || "");

// The rules over the library's own categories, with the database passed in so they can be tested without
// one. db: { list() → [{ id, name }], rename(id, name) → whether it was still there }.
export function createCategoryEdit(db, log = console) {
  // one at a time, so two renames sent together can't both get past the name check
  let turn = Promise.resolve();
  const inTurn = (fn) => {
    const run = turn.then(fn);
    turn = run.catch(() => {});
    return run;
  };
  return {
    // category:add's check: { id, existed: true } when a category has the name, else null (as without it)
    existing: (name) =>
      inTurn(async () => {
        const same = sameName(await db.list(), name);
        return same ? { id: same.id, existed: true } : null;
      }).catch((err) => {
        log.error("category check failed", err.message);
        return null;
      }),
    // category:rename { id, name } → { id, name }, or { error }
    rename: (data) =>
      inTurn(async () => {
        const plan = renamePlan(await db.list(), data && typeof data === "object" ? data : {});
        if (plan.error) return plan;
        if (!(await db.rename(data.id, plan.name))) return { error: CATEGORY_ERRORS.gone };
        return { id: data.id, name: plan.name };
      }).catch((err) => ({ error: err.message })),
  };
}

// category:add's check while the feature is off: never looks.
const OFF = { existing: async () => null };

// The event and the notice on every connection; with profiles on the gate answers the event first.
// core: createCategoryEdit's (or a promise of it); changed() as server.js has it (sends the library out).
export function wireCategoryEdit(io, core, { changed }) {
  io.on("connection", (socket) => {
    socket.on("category:rename", async (data, ack) => {
      const res = await (await core).rename(data);
      if (typeof ack === "function") ack(res);
      if (!res.error) await changed();
    });
    socket.emit(NOTICE);
  });
}

// io: the socket.io server; changed() from server.js. Returns category:add's check ({ existing }).
export function startCategoryEdit(io, { changed }) {
  if (!ON) return OFF;
  // loaded only when it's on (and so the rules above can be tested without a database)
  const core = import("./models.js").then(({ Category }) =>
    createCategoryEdit({
      list: async () => (await Category.find({}, { name: 1 }).lean()).map((c) => ({ id: String(c._id), name: c.name })),
      rename: async (id, name) => (await Category.updateOne({ _id: id }, { name })).matchedCount > 0,
    }),
  );
  core.catch((err) => console.error("category editing failed", err.message));
  wireCategoryEdit(io, core, { changed });
  console.log("category editing on");
  return { existing: async (name) => (await core.catch(() => OFF)).existing(name) };
}
