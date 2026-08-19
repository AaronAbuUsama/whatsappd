/**
 * What an application's own `convex/schema.ts` looks like — the adapter
 * contributes tables, the application owns the file.
 */
import { defineSchema } from "convex/server";
import { whatsappdTables } from "../../../src/convex.ts";

export default defineSchema({ ...whatsappdTables });
