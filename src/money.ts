/**
 * Money — integer minor-unit representation for all financial arithmetic.
 *
 * All Tollgate billing uses this type internally. External APIs accept
 * number | string | Money for ergonomics, but convert immediately.
 *
 * 0.1 + 0.2 = 0.30000000000000004 in IEEE 754.
 * With Money: 10n + 20n = 30n.  Exact.
 */

// ─── Core Type ────────────────────────────────────────────

export interface Money {
  /** Integer amount in minor units (cents for USD, base units for USDC). */
  readonly minorUnits: bigint;
  /** ISO 4217 code or crypto asset identifier ("USD", "USDC", "ETH"). */
  readonly currency: string;
  /** Decimal places (2 for USD, 6 for USDC, 8 for BTC). */
  readonly decimals: number;
}

// ─── TransactionId ────────────────────────────────────────

/** String UUID assigned to every ledger mutation for audit purposes. */
export type TransactionId = string;

// ─── PriceInput — developer-facing (backward compatible) ─

export type PriceInput =
  | number // legacy: 0.1 → usd("0.10"). Logs deprecation warning.
  | string // "0.10" → parsed as USD
  | Money // pass-through
  | { amount: string; currency: string; decimals?: number } // explicit
  | ((input: unknown) => PriceInput | Promise<PriceInput>); // dynamic

// ─── Construction helpers ─────────────────────────────────

/**
 * Create a USD Money value. Accepts number or decimal string.
 * `usd(0.1)` and `usd("0.10")` both produce `{ minorUnits: 10n, currency: "USD", decimals: 2 }`.
 */
export function usd(amount: string | number): Money {
  return money(amount, "USD", 2);
}

/**
 * Create a USDC Money value (6 decimals).
 * `usdc("0.001")` → `{ minorUnits: 1000n, currency: "USDC", decimals: 6 }`.
 */
export function usdc(amount: string | number): Money {
  return money(amount, "USDC", 6);
}

/**
 * Create a Money value from amount, currency and decimal precision.
 * Number input is converted to string via toFixed(decimals) first
 * to avoid IEEE 754 drift before the bigint conversion.
 */
export function money(
  amount: string | number,
  currency: string,
  decimals: number,
): Money {
  const str =
    typeof amount === "number" ? amount.toFixed(decimals) : amount.trim();
  const minorUnits = decimalStringToMinorUnits(str, decimals);
  return { minorUnits, currency: currency.toUpperCase(), decimals };
}

// ─── Arithmetic ───────────────────────────────────────────

/** Add two Money values. Throws if currencies differ. */
export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { minorUnits: a.minorUnits + b.minorUnits, currency: a.currency, decimals: a.decimals };
}

/** Subtract b from a. Throws if currencies differ or result would be negative. */
export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  if (b.minorUnits > a.minorUnits) {
    throw new Error(
      `Money underflow: cannot subtract ${toDecimalString(b)} from ${toDecimalString(a)}`,
    );
  }
  return { minorUnits: a.minorUnits - b.minorUnits, currency: a.currency, decimals: a.decimals };
}

/**
 * Multiply a Money value by a numeric factor.
 * Uses half-up rounding (standard commercial rounding).
 */
export function multiply(m: Money, factor: number): Money {
  // Work in high precision using bigint scaled arithmetic
  const PRECISION = 1_000_000n;
  const factorBig = BigInt(Math.round(factor * Number(PRECISION)));
  const raw = m.minorUnits * factorBig;
  // Round half-up
  const halfUp = PRECISION / 2n;
  const rounded = (raw + halfUp) / PRECISION;
  return { minorUnits: rounded, currency: m.currency, decimals: m.decimals };
}

/** Returns true if a >= b. Throws if currencies differ. */
export function gte(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.minorUnits >= b.minorUnits;
}

/** Returns true if a > b. Throws if currencies differ. */
export function gt(a: Money, b: Money): boolean {
  assertSameCurrency(a, b);
  return a.minorUnits > b.minorUnits;
}

/** Returns true if minorUnits === 0n. */
export function isZero(m: Money): boolean {
  return m.minorUnits === 0n;
}

// ─── Display ──────────────────────────────────────────────

/**
 * Convert to decimal string with correct precision.
 * `toDecimalString(usd(0.1))` → `"0.10"`.
 */
export function toDecimalString(m: Money): string {
  const divisor = 10n ** BigInt(m.decimals);
  const intPart = m.minorUnits / divisor;
  const fracPart = m.minorUnits % divisor;
  const fracStr = fracPart.toString().padStart(m.decimals, "0");
  return `${intPart}.${fracStr}`;
}

/** Return the raw minor-unit bigint. */
export function toMinorUnits(m: Money): bigint {
  return m.minorUnits;
}

/**
 * Convert Money to a plain JS number (lossy — only use for display/logging).
 * Do NOT use for arithmetic.
 */
export function toNumber(m: Money): number {
  return Number(m.minorUnits) / 10 ** m.decimals;
}

// ─── Parsing ──────────────────────────────────────────────

/**
 * Parse a developer-provided PriceInput into a Money value.
 * Handles all input forms. Dynamic functions are NOT resolved here —
 * call resolvePriceInput() for async resolution.
 */
export function parsePriceInput(
  input: Exclude<PriceInput, (...args: unknown[]) => unknown>,
): Money {
  if (isMoney(input)) return input;

  if (typeof input === "number") {
    console.warn(
      "[tollgate] Deprecation: price as number will be removed in v1.0. " +
        `Use usd("${input.toFixed(2)}") or the string form "${input.toFixed(2)}" instead.`,
    );
    return usd(input);
  }

  if (typeof input === "string") {
    return usd(input); // string shorthand assumes USD
  }

  if (typeof input === "object" && "amount" in input && "currency" in input) {
    const decimals = input.decimals ?? decimalsForCurrency(input.currency);
    return money(input.amount, input.currency, decimals);
  }

  throw new Error(`[tollgate] Invalid PriceInput: ${JSON.stringify(input)}`);
}

/**
 * Resolve a PriceInput (including async dynamic functions) to a Money value.
 * Handles the function form that parsePriceInput cannot.
 */
export async function resolvePriceInput(
  input: PriceInput,
  toolInput: unknown,
): Promise<Money> {
  if (typeof input === "function") {
    const resolved = await input(toolInput);
    return resolvePriceInput(resolved, toolInput);
  }
  return parsePriceInput(input);
}

// ─── Type guard ───────────────────────────────────────────

export function isMoney(value: unknown): value is Money {
  return (
    typeof value === "object" &&
    value !== null &&
    "minorUnits" in value &&
    typeof (value as Money).minorUnits === "bigint" &&
    "currency" in value &&
    "decimals" in value
  );
}

// ─── Internal helpers ─────────────────────────────────────

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(
      `Currency mismatch: ${a.currency} vs ${b.currency}. ` +
        "Convert to the same currency before arithmetic.",
    );
  }
}

/**
 * Convert a decimal string like "0.10" to minor units bigint.
 * Handles strings without decimal point and trailing/leading whitespace.
 */
function decimalStringToMinorUnits(str: string, decimals: number): bigint {
  const dotIndex = str.indexOf(".");
  let intStr: string;
  let fracStr: string;

  if (dotIndex === -1) {
    intStr = str;
    fracStr = "";
  } else {
    intStr = str.slice(0, dotIndex);
    fracStr = str.slice(dotIndex + 1);
  }

  // Pad or truncate fractional part to `decimals` digits
  if (fracStr.length < decimals) {
    fracStr = fracStr.padEnd(decimals, "0");
  } else if (fracStr.length > decimals) {
    // Truncate (don't silently lose money — log a warning)
    console.warn(
      `[tollgate] Money precision loss: "${str}" has more than ${decimals} decimal places. Truncating.`,
    );
    fracStr = fracStr.slice(0, decimals);
  }

  const combined = intStr + fracStr;
  return BigInt(combined);
}

/** Best-guess decimal places for common currencies. */
function decimalsForCurrency(currency: string): number {
  switch (currency.toUpperCase()) {
    case "USD":
    case "EUR":
    case "GBP":
    case "CAD":
    case "AUD":
      return 2;
    case "USDC":
    case "USDT":
      return 6;
    case "ETH":
      return 18;
    case "BTC":
      return 8;
    default:
      return 2;
  }
}
