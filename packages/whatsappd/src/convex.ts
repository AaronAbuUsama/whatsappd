/**
 * Everything one Convex deployment needs to hold WhatsApp Accounts: the table
 * definitions, and the functions {@link convexBackend} calls.
 *
 * @remarks
 * The application owns its Convex directory, so this is contributed to it
 * rather than replacing it:
 *
 * ```ts
 * // convex/schema.ts
 * import { defineSchema } from "convex/server";
 * import { whatsappdTables } from "whatsappd/convex";
 *
 * export default defineSchema({ ...whatsappdTables, ...myOwnTables });
 * ```
 *
 * ```ts
 * // convex/whatsappd.ts
 * export * from "whatsappd/convex";
 * ```
 *
 * This entry point is separate from the package root because it is bundled for
 * the Convex runtime, which is not Node. Nothing reachable from here imports
 * `node:crypto` or `node:util`, and the root entry does.
 *
 * @packageDocumentation
 */
export { whatsappdTables } from "./runtime/convex-schema.ts";
export * from "./runtime/convex-functions.ts";
