/**
 * xojoScope.ts — How Xojo encodes Public/Private/Protected, in one place.
 *
 * A leaf module with no imports: both the parser (which reads scope) and the creator (which
 * writes it) depend on it, and neither can depend on the other.
 */

/** Scope as Xojo encodes it in `<ItemFlags>`. */
export type XojoScope = 'Public' | 'Private' | 'Protected';

/**
 * Scope lives in the low bits of `<ItemFlags>`; the source line never carries
 * Public/Private/Protected, only `Shared`. Across 11,024 corpus methods the attested values
 * are 0 (8734), 33 (1023) and 1 (939), plus a separate 4096 bit that occurs only on
 * `Constructor` and is left alone.
 */
const SCOPE_FLAGS: Record<XojoScope, number> = { Public: 0, Private: 1, Protected: 33 };

/** The `<ItemFlags>` value for a scope, defaulting to Xojo's own default of Public. */
export function scopeFlags(scope?: XojoScope): string {
  return String(SCOPE_FLAGS[scope ?? 'Public']);
}

/**
 * Inverse of scopeFlags. Bit 0 is Private and bit 5 promotes it to Protected; every other
 * bit (4096 on Constructor, the legacy 64 on constants) is unrelated to scope and ignored.
 */
export function scopeFromFlags(flags: string | number | undefined): XojoScope {
  const n = typeof flags === 'number' ? flags : parseInt(String(flags ?? ''), 10);
  if (!Number.isFinite(n)) return 'Public';
  if (n & 32) return 'Protected';
  if (n & 1)  return 'Private';
  return 'Public';
}

/** Control `<PropertyVal Name="Scope">` uses a plain 0/1/2 enum, not `<ItemFlags>` bits. */
export function scopeFromControlValue(value: string | undefined): XojoScope {
  switch (String(value ?? '').trim()) {
    case '1':  return 'Protected';
    case '2':  return 'Private';
    default:   return 'Public';
  }
}
