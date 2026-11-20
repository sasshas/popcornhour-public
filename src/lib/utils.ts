import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Australian date format: DD-MM-YYYY
export function formatDateAU(input?: string | Date | null): string {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// Watch dates, month spelt out: "11 November 2026, 10:35"
const MONTHS_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
export function formatDateTimeAU(input?: string | Date | null): string {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${MONTHS_FULL[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The everyday English name for a language or country code ("en" -> "English", "US" -> "United States"). */
export function displayName(type: "language" | "region", code: string): string | null {
  try {
    const name = new Intl.DisplayNames(["en"], { type }).of(type === "region" ? code.toUpperCase() : code);
    return name && name !== code ? name : null;
  } catch {
    return null; // a code the browser does not know
  }
}

// Long Australian date: "1 May 2026"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatDateAULong(input?: string | Date | null): string {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
