import { describe, expect, it } from "vitest";
import { allowedKeys, allowedRow, allowedViews, cardNetwork, detailKey, findPersonDetails, ibanOk, luhnOk, maskDetail, PERSON_MARKERS, screenPersonDetails, verhoeffOk, type PersonKind } from "../src/shared/personDetail";

const NOW = Date.UTC(2026, 5, 1);
const kinds = (text: string, opts: Parameters<typeof findPersonDetails>[1] = {}): string[] => findPersonDetails(text, { now: NOW, ...opts }).map((s) => `${s.kind}:${s.sub}`);
const hit = (text: string, kind: PersonKind, opts: Parameters<typeof findPersonDetails>[1] = {}): boolean => findPersonDetails(text, { now: NOW, ...opts }).some((s) => s.kind === kind);

describe("check digits", () => {
  it("Luhn", () => {
    expect(luhnOk("4111111111111111")).toBe(true);
    expect(luhnOk("4111111111111112")).toBe(false);
    expect(luhnOk("")).toBe(false);
  });
  it("IBAN mod 97", () => {
    expect(ibanOk("GB82WEST12345698765432")).toBe(true);
    expect(ibanOk("GB82WEST12345698765433")).toBe(false);
    expect(ibanOk("GB82WEST1234569876543")).toBe(false);
  });
  it("Verhoeff", () => {
    expect(verhoeffOk("234123412346")).toBe(true);
    expect(verhoeffOk("234123412347")).toBe(false);
  });
  it("card networks need a prefix and a length", () => {
    expect(cardNetwork("4111111111111111")).toBe("visa");
    expect(cardNetwork("5555555555554444")).toBe("mastercard");
    expect(cardNetwork("378282246310005")).toBe("amex");
    expect(cardNetwork("1111111111111117")).toBeUndefined();
  });
});

describe("card numbers", () => {
  it.each([
    ["Visa", "my card is 4111 1111 1111 1111 thanks"],
    ["Visa dashes", "card 4111-1111-1111-1111."],
    ["Visa plain", "4111111111111111"],
    ["Mastercard", "pay with 5555 5555 5555 4444"],
    ["Amex", "amex 3782 822463 10005"],
    ["Discover", "6011111111111117"],
    ["JCB", "3530 1113 3330 0000"],
    ["Diners", "30569309025904"],
  ])("finds %s", (_n, text) => {
    expect(hit(text, "card")).toBe(true);
  });
  it("leaves out numbers that only look like cards", () => {
    expect(hit("4111 1111 1111 1112", "card")).toBe(false); // Luhn fails
    expect(hit("epoch 1700000000000 ms", "card")).toBe(false); // no network prefix
    expect(hit("order 1234 5678 1234 5678", "card")).toBe(false);
    expect(hit("id 0000 0000 0000 0000", "card")).toBe(false);
    expect(hit("call 07700 900123", "card")).toBe(false);
    expect(hit("a 24 digit id 411111111111111111111111", "card")).toBe(false);
  });
  it("takes the card and not the digits that follow it", () => {
    const s = screenPersonDetails("card 4111 1111 1111 1111 123 456", { now: NOW });
    expect(s.text).toBe(`card ${PERSON_MARKERS.card} 123 456`);
  });
  it("replaces only the number", () => {
    expect(screenPersonDetails("use 4111 1111 1111 1111 today", { now: NOW }).text).toBe(`use ${PERSON_MARKERS.card} today`);
  });
});

describe("bank accounts", () => {
  it("finds an IBAN typed in lower case, and still not a lower-case lookalike that fails the check", () => {
    expect(hit("iban gb82west12345698765432 thanks", "bank")).toBe(true);
    expect(hit("iban gb82west12345698765433 thanks", "bank")).toBe(false);
  });
  it.each(["GB82 WEST 1234 5698 7654 32", "GB82WEST12345698765432", "DE89 3704 0044 0532 0130 00", "FR14 2004 1010 0505 0001 3M02 606", "NL91 ABNA 0417 1643 00"])("finds %s", (iban) => {
    expect(hit(`send it to ${iban} please`, "bank")).toBe(true);
  });
  it("leaves out wrong checks and wrong lengths", () => {
    expect(hit("GB82 WEST 1234 5698 7654 33", "bank")).toBe(false);
    expect(hit("DE89 3704 0044", "bank")).toBe(false);
    expect(hit("ZZ99 ABCD EFGH IJKL", "bank")).toBe(false);
    expect(hit("the HTTP2 PROTOCOL VERSION", "bank")).toBe(false);
  });
});

describe("national IDs", () => {
  it("US SSN in the dashed form", () => {
    expect(kinds("ssn 123-45-6789")).toContain("id:ssn");
    expect(hit("000-12-3456", "id")).toBe(false);
    expect(hit("666-12-3456", "id")).toBe(false);
    expect(hit("987-65-4321", "id")).toBe(false);
    expect(hit("123-00-6789", "id")).toBe(false);
    expect(hit("123-45-0000", "id")).toBe(false);
    expect(hit("2024-01-02-1234", "id")).toBe(false);
  });
  it("US SSN without dashes only after a label", () => {
    const t = "My SSN is 123456789.";
    expect(screenPersonDetails(t, { now: NOW }).text).toBe(`My SSN is ${PERSON_MARKERS.id}.`);
    expect(hit("order 123456789 shipped", "id")).toBe(false);
  });
  it("UK NINO", () => {
    expect(kinds("NI number AB 12 34 56 C")).toContain("id:nino");
    expect(kinds("ab123456c")).toEqual([]); // lower case is not a NINO shape here
    expect(hit("BG 12 34 56 A", "id")).toBe(false); // banned prefix
    expect(hit("AB 12 34 56 E", "id")).toBe(false); // suffix is A-D only
  });
  it("other countries only when listed", () => {
    const sin = "SIN 130 692 544";
    expect(hit(sin, "id")).toBe(false);
    expect(hit(sin, "id", { idCountries: ["ca"] })).toBe(true);
    expect(hit("130 692 545", "id", { idCountries: ["ca"] })).toBe(false);
    expect(hit("DNI 12345678Z", "id", { idCountries: ["es"] })).toBe(true);
    expect(hit("DNI 12345678A", "id", { idCountries: ["es"] })).toBe(false);
    expect(hit("BSN: 111222333", "id", { idCountries: ["nl"] })).toBe(true);
    expect(hit("BSN: 111222334", "id", { idCountries: ["nl"] })).toBe(false);
    expect(hit("111222333", "id", { idCountries: ["nl"] })).toBe(false);
    expect(hit("1 85 05 78 006 084 91", "id", { idCountries: ["fr"] })).toBe(true);
    expect(hit("1 85 05 78 006 084 92", "id", { idCountries: ["fr"] })).toBe(false);
    expect(hit("Aadhaar 2341 2341 2346", "id", { idCountries: ["in"] })).toBe(true);
    expect(hit("Aadhaar 2341 2341 2347", "id", { idCountries: ["in"] })).toBe(false);
    expect(hit("RSSMRA85T10A562S", "id", { idCountries: ["it"] })).toBe(true);
    expect(hit("RSSMRA85T10A562X", "id", { idCountries: ["it"] })).toBe(false);
  });
});

describe("addresses", () => {
  it("street lines", () => {
    expect(screenPersonDetails("I live at 221 Baker Street, London.", { now: NOW }).text).toBe(`I live at ${PERSON_MARKERS.address}, London.`);
    expect(hit("Ship to 12B Elm Park Road", "address")).toBe(true);
    expect(hit("1600 Pennsylvania Avenue", "address")).toBe(true);
    expect(hit("Hauptstraße 12", "address")).toBe(true);
  });
  it("UK postcodes with a real area", () => {
    expect(hit("SW1A 1AA", "address")).toBe(true);
    expect(hit("M1 1AE", "address")).toBe(true);
    expect(hit("XX1 1AA", "address")).toBe(false);
    expect(hit("build A1B2C3", "address")).toBe(false);
  });
  it("US city, state and ZIP", () => {
    expect(screenPersonDetails("Springfield, IL 62704", { now: NOW }).text).toBe(PERSON_MARKERS.address);
    expect(hit("Salt Lake City, UT 84101-1234", "address")).toBe(true);
    expect(hit("Springfield, XX 62704", "address")).toBe(false);
  });
  it("leaves out ordinary sentences", () => {
    expect(hit("I bought 5 Big Macs", "address")).toBe(false);
    expect(hit("in 1999 Hacker Way opened", "address")).toBe(false);
    expect(hit("here are 10 ways to park", "address")).toBe(false);
    expect(hit("the 3 Hill Climb event", "address")).toBe(false);
    expect(hit("Version 2 of the Street Fighter game", "address")).toBe(false);
  });
});

describe("dates of birth", () => {
  it.each(["born on 12/03/1985", "DOB: 1985-03-12", "Date of birth: 12.03.1985", "born 5 March 1985", "date of birth is March 5, 1985", "he was born 5th of May 1990", "born in March 1985"])("finds %s", (t) => {
    const s = screenPersonDetails(t, { now: NOW });
    expect(s.count).toBe(1);
    expect(s.text).toContain(PERSON_MARKERS.birth);
  });
  it("keeps the label and replaces only the date", () => {
    expect(screenPersonDetails("DOB: 12/03/1985 (UK)", { now: NOW }).text).toBe(`DOB: ${PERSON_MARKERS.birth} (UK)`);
  });
  it("leaves out bare dates and impossible ones", () => {
    expect(hit("meeting on 12/03/1985", "birth")).toBe(false);
    expect(hit("born in 1985", "birth")).toBe(false);
    expect(hit("born 12/03/2999", "birth")).toBe(false);
    expect(hit("born 45/13/1985", "birth")).toBe(false);
    expect(hit("a bird born 21 April 753 BC", "birth")).toBe(false);
    expect(hit("the dobermann 5 March 1985", "birth")).toBe(false);
  });
});

describe("names the user listed", () => {
  it("matches whole words, any case", () => {
    const opts = { names: ["Ada Lovelace", "Bo"] };
    expect(screenPersonDetails("ask ada  lovelace about it", { now: NOW, ...opts }).text).toBe(`ask ${PERSON_MARKERS.name} about it`);
    expect(hit("Ada Lovelacey", "name", opts)).toBe(false);
    expect(hit("the boat", "name", opts)).toBe(false); // too short to list
  });
  it("escapes what the user typed", () => {
    expect(() => findPersonDetails("x (a+) y", { names: ["(a+)+", "[x"] })).not.toThrow();
  });
});

describe("un-screening", () => {
  it("a stored key hides one value and not another", () => {
    const salt = "s1";
    const text = "cards 4111 1111 1111 1111 and 5555 5555 5555 4444";
    const spans = findPersonDetails(text, { now: NOW, salt });
    expect(spans).toHaveLength(2);
    const row = allowedRow("card", "4111 1111 1111 1111", salt);
    const keys = allowedKeys([row]);
    expect(keys.has(spans[0]?.key ?? "")).toBe(true);
    const after = screenPersonDetails(text, { now: NOW, salt, allowed: keys });
    expect(after.count).toBe(1);
    expect(after.text).toContain("4111 1111 1111 1111");
    expect(after.text).not.toContain("5555");
  });
  it("the key ignores spacing, depends on the salt and is not the number", () => {
    expect(detailKey("card", "4111 1111 1111 1111", "a")).toBe(detailKey("card", "4111-1111-1111-1111", "a"));
    expect(detailKey("card", "4111111111111111", "a")).not.toBe(detailKey("card", "4111111111111111", "b"));
    expect(detailKey("card", "4111111111111111", "a")).not.toContain("4111");
  });
  it("a stored row holds a masked hint, never the value", () => {
    const row = allowedRow("card", "4111 1111 1111 1111", "s");
    expect(row).not.toContain("4111 1111");
    expect(allowedViews([row, "junk", "card"])).toEqual([{ key: row.split(":").slice(0, 2).join(":"), kind: "card", hint: "4111 •••• •••• 1111" }]);
  });
  it("previews hide the middle", () => {
    expect(maskDetail("id", "123-45-6789")).toBe("12•••• 89");
    expect(maskDetail("address", "221 Baker Street")).toBe("••• Baker Street");
  });
});

describe("safety", () => {
  it("kinds can be switched off", () => {
    expect(hit("4111 1111 1111 1111", "card", { off: { card: true } })).toBe(false);
  });
  it("hostile input stays fast", () => {
    const t0 = Date.now();
    const evil = [`${"4 ".repeat(20_000)}`, `GB82 ${"WEST ".repeat(20_000)}`, `${"1 Ab ".repeat(20_000)}`, `born ${"1/".repeat(20_000)}`, `${"Aa, ".repeat(20_000)}`, "9".repeat(100_000)];
    for (const e of evil) findPersonDetails(e, { now: NOW, idCountries: ["ca", "es", "fr", "in", "it", "nl"], names: ["Ada Lovelace"] });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });
  it("empty and short text is returned as it came", () => {
    expect(screenPersonDetails("", {}).text).toBe("");
    expect(screenPersonDetails("hi", {}).count).toBe(0);
  });
});

describe("verification additions", () => {
  it("leaves digits that sit inside a hash, a UUID or an identifier alone, and still takes a real card", () => {
    expect(hit("commit 4111111111111111abcdef", "card")).toBe(false);
    expect(hit("id 41111111-1111-1111-1111-111111111111", "card")).toBe(false);
    expect(hit("ref_4111111111111111", "card")).toBe(false);
    expect(hit("pay with 4111 1111 1111 1111, thanks", "card")).toBe(true);
    expect(hit("`4111111111111111`", "card")).toBe(true);
  });
  it("takes a P.O. box and a French street line, not a sentence about roads", () => {
    expect(kinds("write to P.O. Box 1234, Springfield")).toEqual(["address:po-box"]);
    expect(kinds("12 rue de la Paix, 75002 Paris")).toEqual(["address:street-fr"]);
    expect(hit("chapter 12 Road to nowhere", "address")).toBe(false);
    expect(hit("the box 1234 was empty", "address")).toBe(false);
  });
});
