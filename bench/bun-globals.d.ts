/**
 * Minimal ambient declaration for the Bun globals the benchmarks use.
 *
 * Benchmarks are excluded from the package tsconfig (which has rootDir "src" and emits
 * declarations), so they get their own config. Without this they fail to typecheck and
 * silently rot.
 */
declare const Bun: {
  gc(force?: boolean): void;
};
