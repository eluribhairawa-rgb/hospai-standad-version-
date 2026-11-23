/** Percentage discount helpers shared by the consultation payment screens. */

/** Keeps a typed discount to a valid 0-100 percentage with at most two decimals ("" stays empty). */
export function cleanPercent(raw: string): string {
  const cleaned = raw.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  const joined = rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
  if (joined === "" || joined === ".") return joined === "." ? "0." : "";
  return Number(joined) > 100 ? "100" : joined;
}

/** Discount amount and the payable amount after applying `percent` to `fee`, rounded to paise. */
export function applyPercentDiscount(fee: number | string | null | undefined, percent: number | string | null | undefined) {
  const gross = Number(fee) || 0;
  const pct = Math.min(100, Math.max(0, Number(percent) || 0));
  const discount = Math.round(gross * pct) / 100;
  return { gross, pct, discount, net: Math.round((gross - discount) * 100) / 100 };
}

export const formatRupees = (n: number) => `₹${n.toFixed(2).replace(/\.00$/, "")}`;
