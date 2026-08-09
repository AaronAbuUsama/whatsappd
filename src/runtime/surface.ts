/** Report an observer failure without rolling back a committed transition. */
export const surface = (error: unknown): void => {
  try {
    process.emitWarning(
      error instanceof Error ? error : new Error(String(error), { cause: error }),
    );
  } catch {
    process.emitWarning(new Error("an observer failed with a value that cannot be described"));
  }
};
