import type { Transaction } from "@libsql/client";
import type { LazyLibsqlClient } from "../stores/libsql.ts";

export async function transact<T>(
  client: LazyLibsqlClient,
  mode: "read" | "write",
  work: (transaction: Transaction) => Promise<T>,
): Promise<T> {
  return client.run(async (opened) => {
    const transaction = await opened.transaction(mode);
    try {
      const result = await work(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      if (!transaction.closed) await transaction.rollback().catch(() => {});
      throw error;
    } finally {
      transaction.close();
    }
  }, mode);
}
