import { useRef } from "react";

/** Returns a ref whose `.current` is always the most recent `value`.
 *  Useful inside event handlers / effects installed with `[]` deps that
 *  would otherwise close over stale props or state.
 *
 *  Only read `.current` from callbacks — reading during render defeats the
 *  purpose (just use `value` directly). */
export function useLatest<T>(value: T) {
  const ref = useRef<T>(value);
  ref.current = value;
  return ref;
}
