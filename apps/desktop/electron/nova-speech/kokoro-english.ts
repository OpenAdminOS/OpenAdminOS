export type Lexicon = Record<string, string | Record<string, string>>;

const digits = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

const adminTerms: Record<string, string> = {
  microsoft: "mˈIkɹəsɔft", intune: "ɪntˈun", entra: "ˈɛntɹə",
  autopilot: "ˈɔɾəpIlət", autopatch: "ˈɔɾəpæʧ", bitlocker: "bˈɪtlɑkəɹ",
  defender: "dɪfˈɛndəɹ", endpoint: "ˈɛndpYnt", purview: "pˈɜɹvju",
  conditional: "kəndˈɪʃənəl", access: "ˈæksɛs", onedrive: "wˈʌndɹIv",
  sharepoint: "ʃˈɛɹpYnt", powershell: "pˈWəɹʃɛl",
  mfa: "ˌɛm ˌɛf ˈA", mdm: "ˌɛm ˌdi ˈɛm", mam: "ˌɛm ˌA ˈɛm",
  gpo: "ˌʤi ˌpi ˈO", "oma-uri": "ˌO ˌɛm ˌA ˌju ˌɑɹ ˈI",
  csp: "ˌsi ˌɛs ˈpi", upn: "ˌju ˌpi ˈɛn", sid: "sˈɪd",
  tpm: "ˌti ˌpi ˈɛm", ime: "ˌI ˌɛm ˈi",
};

const graphemes: Record<string, string> = {
  tion: "ʃən", sion: "ʒən", ough: "ʌf", tch: "ʧ", dge: "ʤ", igh: "I",
  ph: "f", th: "θ", sh: "ʃ", ch: "ʧ", ng: "ŋ", ck: "k", qu: "kw",
  ee: "i", ea: "i", oo: "u", ou: "W", ow: "W", ai: "A", ay: "A",
  oi: "Y", oy: "Y", au: "ɔ", aw: "ɔ", er: "ɜɹ", ir: "ɜɹ", ur: "ɜɹ",
  ar: "ɑɹ", or: "ɔɹ", kn: "n", wr: "ɹ",
  a: "æ", e: "ɛ", i: "ɪ", o: "ɑ", u: "ʌ", y: "i",
  c: "k", g: "g", j: "ʤ", r: "ɹ", x: "ks",
};
const longVowels: Record<string, string> = { a: "A", e: "i", i: "I", o: "O", u: "u" };

function guessPhonemes(word: string): string {
  const clean = word.normalize("NFD").replace(/[^a-z]/g, "");
  const silentE = /([aeiou])[^aeiou]e$/.exec(clean);
  let result = "";
  for (let index = 0; index < clean.length;) {
    const letter = clean[index]!;
    const next = clean[index + 1] ?? "";
    if (silentE && index === clean.length - 1) break;
    if (silentE && index === silentE.index) {
      result += longVowels[letter];
      index++;
      continue;
    }
    const group = [4, 3, 2].map(size => clean.slice(index, index + size))
      .find(part => part.length >= 2 && Object.hasOwn(graphemes, part));
    if (group) {
      result += graphemes[group];
      index += group.length;
    } else {
      if (letter !== clean[index - 1]) {
        result += letter === "c" && /^[eiy]/.test(next) ? "s"
          : letter === "g" && /^[eiy]/.test(next) ? "ʤ"
          : graphemes[letter] ?? letter;
      }
      index++;
    }
  }
  return result.replace(/[æɛɪɑʌiəuɔAIOWYɜ]/, vowel => "ˈ" + vowel);
}

export function englishPhonemes(text: string, gold: Lexicon, silver: Lexicon): string {
  function lookup(word: string) {
    const domain = adminTerms[word.toLowerCase()];
    if (Object.hasOwn(adminTerms, word.toLowerCase())) return domain;
    const value = (Object.hasOwn(gold, word) ? gold[word] : undefined) ??
      (Object.hasOwn(silver, word) ? silver[word] : undefined);
    return typeof value === "string" ? value : value?.DEFAULT;
  }

  return text.normalize("NFKC").replaceAll("’", "'")
    .replace(/[0-9]+/g, number => [...number].map(digit => digits[Number(digit)]).join(" "))
    .replace(/[\p{L}]+(?:['-][\p{L}]+)*/gu, word => {
      const lower = word.toLowerCase();
      const known = lookup(word) ?? lookup(lower);
      if (known) return known;
      for (const [suffix, phones] of [["s", "z"], ["'s", "z"], ["ed", "d"], ["ing", "ɪŋ"]]) {
        if (!word.endsWith(suffix!)) continue;
        const stem = lookup(lower.slice(0, -suffix!.length));
        if (stem) return stem + phones;
      }
      return lower.split("-").map(part => lookup(part) ?? guessPhonemes(part)).join(" ");
    })
    .replaceAll("ɡ", "g")
    .replaceAll("ᵻ", "ɪ");
}

export function withoutAdminTerms(text: string): string {
  return text.replace(/[\p{L}]+(?:-[\p{L}]+)*/gu, word =>
    Object.hasOwn(adminTerms, word.toLowerCase()) ? " " : word);
}
