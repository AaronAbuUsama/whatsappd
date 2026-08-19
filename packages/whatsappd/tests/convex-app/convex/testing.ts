/**
 * Emptying every table between conformance fixtures.
 *
 * @remarks
 * Deliberately not part of `whatsappd/convex`: each fixture needs a store with
 * nothing in it, and that is a property of the suite, not a capability an
 * application should be able to call on its own WhatsApp state.
 */
import { mutationGeneric } from "convex/server";
import { whatsappdTables } from "../../../src/convex.ts";

export const reset = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    for (const table of Object.keys(whatsappdTables)) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
    return null;
  },
});
