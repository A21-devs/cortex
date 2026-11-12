/**
 * Personal-detail screening: what leaves this computer must not carry a person's card number, bank account,
 * national ID, home address, date of birth or a name the user asked to keep out. Shared by the runner's privacy
 * filter (agents/privacy.ts calls `screenPersonDetails` once) and the "Screened on this computer" list in the UI.
 * Pure: no Node, no DOM.
 *
 * Detectors (each one checks more than a shape, so a long number or an ordinary date is not a hit):
 *  - card numbers: 13-19 digits, a known card-network prefix and the Luhn check;
 *  - bank accounts: IBAN with the country's length and the mod-97 check;
 *  - national IDs: US SSN and UK NINO always; Canada SIN, Spain DNI, Netherlands BSN, France NIR, India Aadhaar
 *    and Italy codice fiscale only for the countries the user listed (each with its own check digit);
 *  - addresses: street lines ("12 Elm Street"), UK postcodes (real postcode areas only), US "City, ST 12345",
 *    German "Hauptstrasse 5";
 *  - dates of birth: a date straight after "born", "DOB", "date of birth" (never a bare date);
 *  - names: the user's own list (the local-model pass proposes, the user confirms; nothing is added unasked).
 * Every expression is bounded and runs in linear time on hostile input (it runs over gigabytes of transcripts).
 * A value the user un-screened is remembered as a salted hash ("kind:hash"), never as text.
 */
import { sha256Hex } from "./sha256";

export type PersonKind = "card" | "bank" | "id" | "address" | "birth" | "name";

export const PERSON_KINDS: readonly PersonKind[] = ["card", "bank", "id", "address", "birth", "name"];

/** Written in place of a screened value in text sent to a model. */
export const PERSON_MARKERS: Readonly<Record<PersonKind, string>> = {
  card: "[card number removed]",
  bank: "[bank account removed]",
  id: "[ID number removed]",
  address: "[address removed]",
  birth: "[birth date removed]",
  name: "[name removed]",
};

/** Countries whose ID shapes are screened only when listed (US and UK are always on). */
export const ID_COUNTRIES = ["ca", "es", "fr", "in", "it", "nl"] as const;
export type IdCountry = (typeof ID_COUNTRIES)[number];

export interface PersonScreenOptions {
  /** Extra national-ID shapes to screen (see ID_COUNTRIES). */
  idCountries?: readonly string[];
  /** Names to keep out, matched as whole words, any case. */
  names?: readonly string[];
  /** Per-install salt for the un-screen keys. */
  salt?: string;
  /** "kind:hash" keys of values the user un-screened. */
  allowed?: ReadonlySet<string>;
  /** Kinds switched off (all on by default). */
  off?: Partial<Record<PersonKind, boolean>>;
  /** Clock for the birth-year check (tests). */
  now?: number;
  /**
   * Hide the values the user kept behind one private-use character each, so rules that run afterwards (phone numbers)
   * cannot touch them; `restore` on the result puts them back. Without it a kept value is simply left in the text.
   */
  hold?: boolean;
}

export interface PersonSpan {
  start: number;
  end: number;
  kind: PersonKind;
  /** Which detector: "visa", "iban", "ssn", "nino", "street", "postcode-gb" … */
  sub: string;
  /** "kind:hash" for un-screening; set when a salt is given or a key was asked for. */
  key?: string;
}

export interface PersonScreen {
  text: string;
  /** Puts back the values the user kept (only when `hold` was asked for; the identity otherwise). */
  restore(text: string): string;
  count: number;
  spans: PersonSpan[];
  byKind: Partial<Record<PersonKind, number>>;
}

// ───────────────────────────── check digits ─────────────────────────────

export function luhnOk(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** The card network for a digit string (prefix and length), or undefined. */
export function cardNetwork(d: string): string | undefined {
  const n = d.length;
  const p = (k: number): number => Number(d.slice(0, k));
  if (d[0] === "4" && (n === 13 || n === 16 || n === 19)) return "visa";
  if (n === 16 && ((p(2) >= 51 && p(2) <= 55) || (p(4) >= 2221 && p(4) <= 2720))) return "mastercard";
  if (n === 15 && (p(2) === 34 || p(2) === 37)) return "amex";
  if (n >= 16 && n <= 19 && (p(4) === 6011 || p(2) === 65 || (p(3) >= 644 && p(3) <= 649))) return "discover";
  if (n >= 16 && n <= 19 && p(4) >= 3528 && p(4) <= 3589) return "jcb";
  if (n >= 14 && n <= 19 && ((p(3) >= 300 && p(3) <= 305) || p(2) === 36 || p(2) === 38 || p(2) === 39)) return "diners";
  if (n >= 16 && n <= 19 && p(2) === 62) return "unionpay";
  if (n >= 16 && n <= 19 && p(4) >= 2200 && p(4) <= 2204) return "mir";
  if (n >= 12 && n <= 19 && (p(4) === 5018 || p(4) === 5020 || p(4) === 5038 || p(4) === 6304 || p(4) === 6759 || (p(3) >= 676 && p(3) <= 679))) return "maestro";
  return undefined;
}

const IBAN_LENGTH: Readonly<Record<string, number>> = Object.fromEntries(
  "AD24 AE23 AL28 AT20 AZ28 BA20 BE16 BG22 BH22 BR29 BY28 CH21 CR22 CY28 CZ24 DE22 DK18 DO28 EE20 EG29 ES24 FI18 FO18 FR27 GB22 GE22 GI23 GL18 GR27 GT28 HR21 HU28 IE22 IL23 IQ23 IS26 IT27 JO30 KW30 KZ20 LB28 LC32 LI21 LT20 LU20 LV21 MC27 MD24 ME22 MK19 MR27 MT31 MU30 NL18 NO15 PK24 PL28 PS29 PT25 QA29 RO24 RS22 SA24 SC31 SE24 SI19 SK24 SM27 ST25 SV28 TL23 TN24 TR26 UA29 VA22 VG24 XK20".split(" ").map((s) => [s.slice(0, 2), Number(s.slice(2))]),
);

/** IBAN: the country's length and the ISO 7064 mod-97 check. `compact` has no spaces. */
export function ibanOk(compact: string): boolean {
  const want = IBAN_LENGTH[compact.slice(0, 2)];
  if (want === undefined || compact.length !== want) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const c = ch.charCodeAt(0);
    const v = c >= 65 ? c - 55 : c - 48;
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

export function verhoeffOk(digits: string): boolean {
  let c = 0;
  const n = digits.length;
  for (let i = 0; i < n; i++) {
    const d = digits.charCodeAt(n - 1 - i) - 48;
    if (d < 0 || d > 9) return false;
    c = VERHOEFF_D[c]?.[VERHOEFF_P[i % 8]?.[d] ?? 0] ?? 0;
  }
  return n > 0 && c === 0;
}

const DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CF_ODD = [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23];

function codiceFiscaleOk(cf: string): boolean {
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const c = cf.charCodeAt(i);
    const idx = c >= 65 ? c - 65 : c - 48;
    sum += i % 2 === 0 ? (CF_ODD[idx] ?? 0) : idx;
  }
  return cf.charCodeAt(15) - 65 === sum % 26;
}

function bsnOk(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (d.charCodeAt(i) - 48) * (9 - i);
  sum -= d.charCodeAt(8) - 48;
  return sum % 11 === 0 && d !== "000000000";
}

// ───────────────────────────── detectors ─────────────────────────────

type Hit = Omit<PersonSpan, "key">;

const CARD = /(?<!\d)\d(?:[ -]?\d){11,21}(?!\d)/g;

function cardHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(CARD)) {
    const at = m.index ?? 0;
    const raw = m[0];
    // The digits with their offsets in `raw`; a card may be followed by more digits, so shorter prefixes are tried.
    const pos: number[] = [];
    let digits = "";
    for (let i = 0; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        pos.push(i);
        digits += raw[i];
      }
    }
    for (let len = Math.min(19, digits.length); len >= 12; len--) {
      const d = digits.slice(0, len);
      const net = cardNetwork(d);
      if (!net || !luhnOk(d)) continue;
      if (/^(\d)\1+$/.test(d)) continue;
      // A prefix must end at a group boundary (the next character is a separator) unless it is the whole run.
      const endIdx = (pos[len - 1] ?? 0) + 1;
      if (len < digits.length && raw[endIdx] !== " " && raw[endIdx] !== "-") continue;
      if (joinedToToken(text, at, at + endIdx)) continue;
      out.push({ start: at, end: at + endIdx, kind: "card", sub: net });
      break;
    }
  }
}

/** Digits that sit inside a longer token (a hash, a UUID, an id like abc-4111...) are not a card number. */
function joinedToToken(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? "";
  const after = text[end] ?? "";
  if (/[A-Za-z_]/.test(before) || /[A-Za-z_]/.test(after)) return true;
  if (before === "-" && /[A-Za-z0-9]/.test(text[start - 2] ?? "")) return true;
  return after === "-" && /[A-Za-z0-9]/.test(text[end + 1] ?? "");
}

const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2} ?[A-Z0-9]{4}(?: ?[A-Z0-9]{4}){1,6}(?: ?[A-Z0-9]{1,4})?(?![A-Za-z0-9])/gi;

function ibanHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(IBAN)) {
    const at = m.index ?? 0;
    const compact = m[0].replace(/ /g, "").toUpperCase();
    if (ibanOk(compact)) out.push({ start: at, end: at + m[0].length, kind: "bank", sub: "iban" });
  }
}

const SSN_DASHED = /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g;
const SSN_LABELLED = /\b(?:ssn|social security(?: number| no\.?| #)?)[ \t]{0,3}[:#]?[ \t]{0,3}(?:is[ \t]{1,3})?(\d{3}[ -]?\d{2}[ -]?\d{4})(?!\d)/gi;
const NINO = /(?<![A-Za-z0-9])([A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]) ?(\d{2}) ?(\d{2}) ?(\d{2}) ?([A-D])(?![A-Za-z0-9])/g;
const NINO_BAD = new Set(["BG", "GB", "NK", "KN", "TN", "NT", "ZZ"]);

function ssnOk(area: string, group: string, serial: string): boolean {
  const a = Number(area);
  return a !== 0 && a !== 666 && a < 900 && group !== "00" && serial !== "0000";
}

const CA_SIN = /(?<![\d-])\d{3}[- ]\d{3}[- ]\d{3}(?![\d-])/g;
const ES_DNI = /(?<![A-Za-z0-9])(\d{8})[- ]?([A-Z])(?![A-Za-z0-9])/g;
const NL_BSN = /\b(?:bsn|burgerservicenummer)[ \t]{0,3}[:#]?[ \t]{0,3}(\d{9})(?!\d)/gi;
const FR_NIR = /(?<!\d)([12]) ?(\d{2}) ?(0[1-9]|1[0-2]|[2-9]\d) ?(\d{2}|2[AB]) ?(\d{3}) ?(\d{3}) ?(\d{2})(?!\d)/g;
const IN_AADHAAR = /(?<!\d)[2-9]\d{3}[- ]\d{4}[- ]\d{4}(?![\d-])/g;
const IT_CF = /(?<![A-Za-z0-9])[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z](?![A-Za-z0-9])/g;

function idHits(text: string, countries: ReadonlySet<string>, out: Hit[]): void {
  for (const m of text.matchAll(SSN_DASHED)) {
    if (ssnOk(m[1] ?? "", m[2] ?? "", m[3] ?? "")) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "ssn" });
  }
  for (const m of text.matchAll(SSN_LABELLED)) {
    const g = m[1] ?? "";
    const d = g.replace(/\D/g, "");
    if (ssnOk(d.slice(0, 3), d.slice(3, 5), d.slice(5))) out.push({ start: (m.index ?? 0) + m[0].length - g.length, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "ssn" });
  }
  for (const m of text.matchAll(NINO)) {
    if (NINO_BAD.has(m[1] ?? "")) continue;
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "nino" });
  }
  if (countries.has("ca")) {
    for (const m of text.matchAll(CA_SIN)) {
      const d = m[0].replace(/\D/g, "");
      if (d[0] !== "0" && d[0] !== "8" && luhnOk(d)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "sin" });
    }
  }
  if (countries.has("es")) {
    for (const m of text.matchAll(ES_DNI)) {
      if (DNI_LETTERS[Number(m[1]) % 23] === m[2]) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "dni" });
    }
  }
  if (countries.has("nl")) {
    for (const m of text.matchAll(NL_BSN)) {
      const g = m[1] ?? "";
      if (bsnOk(g)) out.push({ start: (m.index ?? 0) + m[0].length - g.length, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "bsn" });
    }
  }
  if (countries.has("fr")) {
    for (const m of text.matchAll(FR_NIR)) {
      const dept = m[4] ?? "";
      const corsica = dept === "2A" || dept === "2B" ? dept : "";
      const base = `${m[1]}${m[2]}${m[3]}${corsica === "" ? dept : corsica === "2A" ? "19" : "18"}${m[5]}${m[6]}${m[7]}`;
      const n = BigInt(base.slice(0, 13));
      if (97 - Number(n % 97n) === Number(base.slice(13, 15))) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "nir" });
    }
  }
  if (countries.has("in")) {
    for (const m of text.matchAll(IN_AADHAAR)) {
      if (verhoeffOk(m[0].replace(/\D/g, ""))) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "aadhaar" });
    }
  }
  if (countries.has("it")) {
    for (const m of text.matchAll(IT_CF)) {
      if (codiceFiscaleOk(m[0])) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "id", sub: "cf" });
    }
  }
}

const STREET_TYPES = "Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd|Court|Ct|Way|Place|Pl|Close|Crescent|Terrace|Square|Gardens|Grove|Walk|Park|Hill|Row|Highway|Hwy|Parkway|Pkwy|Mews|Gate";
const STREET = new RegExp(`(?<![\\w.])(\\d{1,4}[A-Za-z]?) +(?:[A-Z][A-Za-z'.-]{1,24} +){1,3}?(?:${STREET_TYPES})\\b\\.?`, "g");
const GB_AREAS = new Set(
  "AB AL B BA BB BD BH BL BN BR BS BT CA CB CF CH CM CO CR CT CV CW DA DD DE DG DH DL DN DT DY E EC EH EN EX FK FY G GL GU GY HA HD HG HP HR HS HU HX IG IM IP IV JE KA KT KW KY L LA LD LE LL LN LS LU M ME MK ML N NE NG NN NP NR NW OL OX PA PE PH PL PO PR RG RH RM S SA SE SG SK SL SM SN SO SP SR SS ST SW SY TA TD TF TN TQ TR TS TW UB W WA WC WD WF WN WR WS WV YO ZE".split(" "),
);
const GB_POSTCODE = /(?<![A-Za-z0-9])([A-Z]{1,2})\d[A-Z\d]? ?\d[A-Z]{2}(?![A-Za-z0-9])/g;
const US_STATES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|PR|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_CITY_ZIP = new RegExp(`(?<![A-Za-z])(?:[A-Z][A-Za-z.'-]{0,24} ){0,2}[A-Z][A-Za-z.'-]{1,24}, ?(?:${US_STATES}) \\d{5}(?:-\\d{4})?(?!\\d)`, "g");
const DE_STREET = /(?<![\p{L}])[A-ZÄÖÜ][a-zäöüß]{2,25}(?:stra(?:ß|ss)e|weg|gasse|platz|allee|damm) \d{1,4}[a-z]?(?![\p{L}\d])/gu;

const PO_BOX = /(?<![A-Za-z])P\.? ?O\.? ?Box \d{1,7}(?!\d)/gi;
const FR_STREET = /(?<![\p{L}\d])\d{1,4}(?:bis|ter)? (?:rue|avenue|boulevard|chemin|impasse|all\u00e9e|place|quai) (?:(?:de la|de l'|du|des|de|d'|la|le|l')? ?)[A-Z\u00c0-\u00dd][\p{L}'-]{1,24}(?: [A-Z\u00c0-\u00dd][\p{L}'-]{1,24}){0,2}/gu;

function addressHits(text: string, out: Hit[]): void {
  for (const m of text.matchAll(PO_BOX)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "address", sub: "po-box" });
  for (const m of text.matchAll(FR_STREET)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "address", sub: "street-fr" });
  for (const m of text.matchAll(STREET)) {
    const n = m[1] ?? "";
    const num = Number(n.replace(/\D/g, ""));
    // "In 1999 Hacker Way" reads as a year, not a house number.
    if (n.length === 4 && /^\d{4}$/.test(n) && num >= 1900 && num <= 2100) continue;
    out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "address", sub: "street" });
  }
  for (const m of text.matchAll(GB_POSTCODE)) {
    if (GB_AREAS.has(m[1] ?? "")) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "address", sub: "postcode-gb" });
  }
  for (const m of text.matchAll(US_CITY_ZIP)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "address", sub: "city-zip" });
  for (const m of text.matchAll(DE_STREET)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: "address", sub: "street-de" });
}

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const BIRTH = new RegExp(
  `(?<![A-Za-z])(?:date of birth|birth ?date|born(?: on)?|dob|d\\.o\\.b\\.?|birthday)(?![A-Za-z])[ \\t:,-]{0,6}(?:(?:is|was|in) )?(?:the )?(\\d{1,2}[/.-]\\d{1,2}[/.-](?:\\d{4}|\\d{2})(?!\\d)|\\d{4}-\\d{1,2}-\\d{1,2}(?!\\d)|\\d{1,2}(?:st|nd|rd|th)?(?: of)? ${MONTH}\\.?,? \\d{4}(?!\\d)|${MONTH}\\.? \\d{1,2}(?:st|nd|rd|th)?,? \\d{4}(?!\\d)|${MONTH}\\.?,? \\d{4}(?!\\d))`,
  "gi",
);

function birthHits(text: string, now: number, out: Hit[]): void {
  const thisYear = new Date(now).getUTCFullYear();
  for (const m of text.matchAll(BIRTH)) {
    const g = m[1] ?? "";
    const years = g.match(/\d{4}/);
    const year = years ? Number(years[0]) : undefined;
    if (year !== undefined && (year < 1900 || year > thisYear)) continue;
    const nums = g.match(/^(\d{1,2})[/.-](\d{1,2})[/.-]/);
    if (nums && (Number(nums[1]) > 31 || Number(nums[2]) > 31 || Number(nums[1]) === 0 || Number(nums[2]) === 0)) continue;
    const end = (m.index ?? 0) + m[0].length;
    out.push({ start: end - g.length, end, kind: "birth", sub: "birth" });
  }
}

/** A listed phrase is a name, or an address when the row starts with "address:" (what the local-model pass proposes). */
export const ADDRESS_ROW = "address:";

function nameHits(text: string, names: readonly string[], out: Hit[]): void {
  for (const raw of names.slice(0, 200)) {
    const isAddress = raw.startsWith(ADDRESS_ROW);
    const name = (isAddress ? raw.slice(ADDRESS_ROW.length) : raw).trim();
    if (name.length < 3 || name.length > 120) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, kind: isAddress ? "address" : "name", sub: "listed" });
  }
}

// ───────────────────────────── keys, previews, the screen ─────────────────────────────

/** What identifies a value for un-screening: digits and letters only for numbers, lower-cased words otherwise. */
export function normaliseDetail(kind: PersonKind, value: string): string {
  return kind === "card" || kind === "bank" || kind === "id" ? value.replace(/[^A-Za-z0-9]/g, "").toLowerCase() : value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** "kind:hash": a salted SHA-256 of the value (16 hex digits). Never reversible to the text without guessing it. */
export function detailKey(kind: PersonKind, value: string, salt: string): string {
  return `${kind}:${sha256Hex(`${salt}|${kind}|${normaliseDetail(kind, value)}`).slice(0, 16)}`;
}

/** A preview that shows enough to recognise the value and not enough to use it ("4111 •••• •••• 1111"). */
export function maskDetail(kind: PersonKind, value: string): string {
  const v = value.trim();
  if (kind === "name") return v;
  if (kind === "card") {
    const d = v.replace(/\D/g, "");
    return `${d.slice(0, 4)} •••• •••• ${d.slice(-4)}`;
  }
  if (kind === "bank" || kind === "id") {
    const c = v.replace(/\s+/g, "");
    return c.length <= 6 ? "••••" : `${c.slice(0, 2)}•••• ${c.slice(-2)}`;
  }
  if (kind === "birth") return v.replace(/\d/g, "•");
  return v.replace(/\d/g, "•");
}

/** The spans of `text` that hold personal details, sorted and merged. Allowed (un-screened) values are skipped. */
export function findPersonDetails(text: string, opts: PersonScreenOptions = {}, kept?: PersonSpan[]): PersonSpan[] {
  if (text.length < 5) return [];
  const off = opts.off ?? {};
  const hits: Hit[] = [];
  if (!off.card) cardHits(text, hits);
  if (!off.bank) ibanHits(text, hits);
  if (!off.id) idHits(text, new Set(opts.idCountries ?? []), hits);
  if (!off.address) addressHits(text, hits);
  if (!off.birth) birthHits(text, opts.now ?? Date.now(), hits);
  if (!off.name && opts.names && opts.names.length > 0) nameHits(text, opts.names, hits);
  if (hits.length === 0) return [];
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Hit[] = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start < last.end) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  const allowed = opts.allowed;
  const wantKey = opts.salt !== undefined || (allowed !== undefined && allowed.size > 0);
  const out: PersonSpan[] = [];
  for (const h of merged) {
    const span: PersonSpan = { ...h };
    if (wantKey) {
      span.key = detailKey(h.kind, text.slice(h.start, h.end), opts.salt ?? "");
      if (allowed?.has(span.key)) {
        kept?.push(span);
        continue;
      }
    }
    out.push(span);
  }
  return out;
}

/** Replace personal details with their markers. The single entry point the privacy filter calls. */
export function screenPersonDetails(text: string, opts: PersonScreenOptions = {}): PersonScreen {
  const kept: PersonSpan[] = [];
  const spans = findPersonDetails(text, opts, opts.hold ? kept : undefined);
  const byKind: Partial<Record<PersonKind, number>> = {};
  const identity = (t: string): string => t;
  if (spans.length === 0 && kept.length === 0) return { text, restore: identity, count: 0, spans, byKind };
  const held = new Map<string, string>();
  let code = 0xe100;
  const holder = (original: string): string => {
    while (text.includes(String.fromCharCode(code))) code++;
    const ch = String.fromCharCode(code++);
    held.set(ch, original);
    return ch;
  };
  const edits = [...spans.map((h) => ({ h, keep: false })), ...kept.map((h) => ({ h, keep: true }))].sort((a, b) => a.h.start - b.h.start);
  let out = "";
  let pos = 0;
  for (const { h, keep } of edits) {
    if (h.start < pos) continue;
    out += text.slice(pos, h.start) + (keep ? holder(text.slice(h.start, h.end)) : PERSON_MARKERS[h.kind]);
    pos = h.end;
    if (!keep) byKind[h.kind] = (byKind[h.kind] ?? 0) + 1;
  }
  out += text.slice(pos);
  const restore = held.size === 0 ? identity : (t: string): string => t.replace(/[\ue100-\uf8ff]/g, (ch) => held.get(ch) ?? ch);
  return { text: out, restore, count: spans.length, spans, byKind };
}

// ───────────────────────────── the un-screened list (settings) ─────────────────────────────

/** A row of `privacy.screening.allowed`: "kind:hash:hint". */
export function allowedRow(kind: PersonKind, value: string, salt: string): string {
  return `${detailKey(kind, value, salt)}:${maskDetail(kind, value).replace(/:/g, " ")}`;
}

/** The keys ("kind:hash") of the stored rows. */
export function allowedKeys(rows: readonly string[]): Set<string> {
  const s = new Set<string>();
  for (const r of rows) {
    const parts = r.split(":");
    if (parts.length >= 2 && (PERSON_KINDS as readonly string[]).includes(parts[0] ?? "")) s.add(`${parts[0]}:${parts[1]}`);
  }
  return s;
}

export interface AllowedView {
  key: string;
  kind: PersonKind;
  hint: string;
}

export function allowedViews(rows: readonly string[]): AllowedView[] {
  const out: AllowedView[] = [];
  for (const r of rows) {
    const parts = r.split(":");
    const kind = parts[0] as PersonKind;
    if (parts.length >= 2 && PERSON_KINDS.includes(kind)) out.push({ key: `${kind}:${parts[1]}`, kind, hint: parts.slice(2).join(":") });
  }
  return out;
}

// ───────────────────────────── the "Screened on this computer" list ─────────────────────────────

/** One value the screen replaces: what kind, a masked preview, the text around it with the replacement shown. */
export interface ScreenedItem {
  kind: PersonKind;
  sub: string;
  /** "kind:hash": what "Keep this one" stores. */
  key: string;
  hint: string;
  /** Text around the first sighting with the marker in place of the value. */
  snippet: string;
  /** The entry it was first seen in. */
  entry: string;
  /** How many times it appears in what would be sent. */
  count: number;
}

export interface ScreenedSummary {
  /** Screening is off (Settings > Privacy); nothing below was looked at. */
  off?: boolean;
  scanned: number;
  total: number;
  /** The look stopped at its time or size limit. */
  partial: boolean;
  kinds: { kind: PersonKind; count: number; values: number }[];
  items: ScreenedItem[];
  /** Phrases the local model proposed (names and addresses); never applied until the user confirms. */
  proposals?: { kind: "name" | "address"; text: string }[];
}

/** Counts what the screen replaces across many texts: per kind, and one row per distinct value with its first context. */
export class ScreenTally {
  private readonly counts = new Map<PersonKind, { count: number; values: Set<string> }>();
  private readonly rows = new Map<string, ScreenedItem>();

  constructor(
    private readonly opts: PersonScreenOptions,
    private readonly maxItems = 300,
    private readonly context = 36,
  ) {}

  add(entry: string, text: string): void {
    const oneLine = (s: string): string => s.replace(/\s+/g, " ");
    for (const sp of findPersonDetails(text, { ...this.opts, salt: this.opts.salt ?? "" })) {
      const c = this.counts.get(sp.kind) ?? { count: 0, values: new Set<string>() };
      c.count++;
      const key = sp.key ?? `${sp.kind}:${sp.start}`;
      c.values.add(key);
      this.counts.set(sp.kind, c);
      const seen = this.rows.get(key);
      if (seen) {
        seen.count++;
        continue;
      }
      if (this.rows.size >= this.maxItems) continue;
      const before = screenPersonDetails(oneLine(text.slice(Math.max(0, sp.start - this.context), sp.start)), this.opts).text;
      const after = screenPersonDetails(oneLine(text.slice(sp.end, sp.end + this.context)), this.opts).text;
      this.rows.set(key, {
        kind: sp.kind,
        sub: sp.sub,
        key,
        hint: maskDetail(sp.kind, text.slice(sp.start, sp.end)),
        snippet: `${sp.start > this.context ? "…" : ""}${before}${PERSON_MARKERS[sp.kind]}${after}${text.length - sp.end > this.context ? "…" : ""}`,
        entry,
        count: 1,
      });
    }
  }

  summary(scanned: number, total: number, partial: boolean): ScreenedSummary {
    return {
      scanned,
      total,
      partial,
      kinds: PERSON_KINDS.filter((k) => this.counts.has(k)).map((k) => ({ kind: k, count: this.counts.get(k)?.count ?? 0, values: this.counts.get(k)?.values.size ?? 0 })),
      items: [...this.rows.values()].sort((a, b) => PERSON_KINDS.indexOf(a.kind) - PERSON_KINDS.indexOf(b.kind) || b.count - a.count),
    };
  }
}
