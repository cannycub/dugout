/**
 * Compile-time proof that a `switch` handled every variant of a discriminated union: the call
 * only type-checks when `x` has been narrowed to `never`. If control ever reaches it at runtime
 * (a variant added without updating the switch), it throws loudly rather than falling through.
 */
export function assertNever(x: never, context = "unhandled variant"): never {
  throw new Error(`${context}: ${JSON.stringify(x)}`);
}
