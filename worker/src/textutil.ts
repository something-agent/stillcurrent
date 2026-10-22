/** HTML/PDF text extraction, date detection and text normalisation (dependency-free, Workers-friendly). */

export const MIN_YEAR = 1990;

export const MODIFIED_META = new Set([
  "article:modified_time", "og:updated_time", "last-modified", "lastmod", "dcterms.modified",
  "dc.date.modified", "dc.modified", "modified", "revised", "dc.date.updated", "updated",
  "date-modified", "article.updated", "parsely-pub-date-modified",
]);
export const PUBLISHED_META = new Set([
  "article:published_time", "og:published_time", "date", "dcterms.date", "dc.date", "dcterms.created",
  "dc.date.issued", "dcterms.issued", "citation_publication_date", "citation_date",
  "citation_online_date", "pubdate", "publish-date", "publication_date", "sailthru.date",
]);

// ------------------------------------------------------------------ entities
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", middot: "·",
  bull: "•", laquo: "«", raquo: "»", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§", deg: "°",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾", shy: "\u00ad", thinsp: "\u2009",
  ensp: "\u2002", emsp: "\u2003", zwnj: "\u200c", zwj: "\u200d", minus: "−", prime: "′", Prime: "″",
  eacute: "é", egrave: "è", ecirc: "ê", aacute: "á", agrave: "à", acirc: "â", auml: "ä", ouml: "ö", uuml: "ü",
  Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ccedil: "ç", ntilde: "ñ", oacute: "ó", iacute: "í", uacute: "ú",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, g: string) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return m;
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED[g] ?? m;
  });
}

// ------------------------------------------------------------------ HTML
export interface ParsedHtml {
  title: string | null;
  metas: Array<{ key: string; content: string }>;
  jsonld: string[];
  times: Array<{ attrs: string; datetime: string | null; text: string }>;
  text: string;
}

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const inner = tag.replace(/^<\s*[a-zA-Z0-9:-]+/, "").replace(/\/?>$/, "");
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(inner))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(stripped).replace(/\s+/g, " ").trim();
}

export function parseHtml(html: string): ParsedHtml {
  const tm = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const title = tm ? decodeEntities(tm[1].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
  const metas: ParsedHtml["metas"] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const key = (a["property"] || a["name"] || a["itemprop"] || a["http-equiv"] || "").trim().toLowerCase();
    if (key && a["content"]) metas.push({ key, content: a["content"] });
    if (metas.length > 400) break;
  }
  const jsonld: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/type\s*=\s*["']?application\/ld\+json/i.test(m[1])) jsonld.push(m[2]);
    if (jsonld.length > 20) break;
  }
  const times: ParsedHtml["times"] = [];
  for (const m of html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time\s*>/gi)) {
    const a = parseAttrs("<time" + m[1] + ">");
    const attrs = [a["class"] || "", a["itemprop"] || "", a["id"] || ""].join(" ").toLowerCase();
    times.push({ attrs, datetime: a["datetime"] ?? null, text: htmlToText(m[2]) });
    if (times.length > 100) break;
  }
  return { title, metas, jsonld, times, text: htmlToText(html) };
}

// ------------------------------------------------------------------ dates
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MON = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_PAT =
  "(?<date>" +
  "\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?(?:Z|[+-]\\d{2}:?\\d{2})?)?" +
  `|\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}\\.?,?\\s+\\d{4}` +
  `|${MON}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}` +
  "|\\d{1,2}/\\d{1,2}/\\d{4}" +
  "|\\d{1,2}\\.\\d{1,2}\\.\\d{4}" +
  `|${MON}\\.?\\s+\\d{4}` +
  ")";
const UPDATED_TEXT_RE = new RegExp(
  "(?<label>(?:page\\s+)?last\\s+(?:updated|modified|revised|reviewed|edited|changed)(?:\\s+date)?(?:\\s+on)?" +
    "|(?:updated|modified|revised|reviewed)(?:\\s+on)?|as\\s+of|current\\s+as\\s+of|data\\s+as\\s+of)" +
    "\\s*[:\\-–—]?\\s*" + DATE_PAT,
  "gi",
);
const COPYRIGHT_RE = /(?:©|&copy;|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(?<year>(?:19|20)\d{2})/gi;

function mk(y: number, mo: number, d: number, hh = 0, mi = 0, ss = 0, offMin = 0): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, mo - 1, d, hh, mi, ss) - offMin * 60_000;
  const dt = new Date(t);
  if (dt.getUTCMonth() !== mo - 1 && offMin === 0) return null;
  return dt;
}

function monthNum(s: string): number | null {
  return MONTHS[s.slice(0, 3).toLowerCase()] ?? null;
}

/** Parse the date shapes the extractors produce (ISO, RFC 2822, "12 March 2024", "March 12, 2024", m/d/Y, d.m.Y, "March 2024"). */
export function parseDate(input: string | null | undefined, now: Date = new Date()): Date | null {
  const s = (input || "").trim();
  if (!s || s.length > 64) return null;
  let dt: Date | null = null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i))) {
    let off = 0;
    if (m[7] && m[7].toUpperCase() !== "Z") {
      const sign = m[7][0] === "-" ? -1 : 1;
      const digits = m[7].slice(1).replace(":", "");
      off = sign * (parseInt(digits.slice(0, 2), 10) * 60 + parseInt(digits.slice(2, 4) || "0", 10));
    }
    dt = mk(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), off);
  } else if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) {
    dt = mk(+m[1], +m[2], +m[3]);
  } else if ((m = s.match(new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})\\.?,?\\s+(\\d{4})$`, "i")))) {
    dt = mk(+m[3], monthNum(m[2])!, +m[1]);
  } else if ((m = s.match(new RegExp(`^(${MON})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, "i")))) {
    dt = mk(+m[3], monthNum(m[1])!, +m[2]);
  } else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) {
    dt = mk(+m[3], +m[1], +m[2]); // month-first, like dateutil's default
  } else if ((m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/))) {
    dt = mk(+m[3], +m[2], +m[1]); // day-first
  } else if ((m = s.match(new RegExp(`^(${MON})\\.?\\s+(\\d{4})$`, "i")))) {
    dt = mk(+m[2], monthNum(m[1])!, 1);
  } else if ((m = s.match(/^(\d{4})$/))) {
    dt = mk(+m[1], 1, 1);
  } else {
    const t = Date.parse(s); // RFC 2822 / other engine-supported forms
    if (!Number.isNaN(t)) dt = new Date(t);
  }
  if (!dt || Number.isNaN(dt.getTime())) return null;
  if (dt.getUTCFullYear() < MIN_YEAR) return null;
  if ((dt.getTime() - now.getTime()) / 86_400_000 > 1) return null; // future (beyond 1 day)
  return dt;
}

export function iso(dt: Date): string {
  return new Date(Math.floor(dt.getTime() / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

export function pdfDate(s: string | null | undefined, now: Date = new Date()): Date | null {
  const m = (s || "").match(/^D:(\d{4})(\d{2})?(\d{2})?/);
  if (!m) return null;
  const dt = mk(+m[1], +(m[2] || 1), +(m[3] || 1));
  if (!dt) return null;
  return dt.getUTCFullYear() >= MIN_YEAR && dt.getTime() <= now.getTime() ? dt : null;
}

export interface DateCandidate {
  kind: "modified" | "published" | "copyright";
  source: string;
  raw: string;
  date: string;
}

function walkJsonld(obj: unknown, out: Array<[string, string]>, depth = 0): void {
  if (depth > 12 || out.length > 50) return;
  if (Array.isArray(obj)) {
    for (const v of obj) walkJsonld(v, out, depth + 1);
  } else if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    for (const k of ["dateModified", "datePublished", "dateCreated", "uploadDate"]) {
      if (typeof o[k] === "string") out.push([k, o[k] as string]);
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walkJsonld(v, out, depth + 1);
  }
}

/** Candidate dates from markup (meta / JSON-LD / <time>) and/or visible text. */
export function extractDateCandidates(html: ParsedHtml | null, text: string | null, now: Date = new Date()): DateCandidate[] {
  const cands: DateCandidate[] = [];
  const add = (kind: DateCandidate["kind"], source: string, raw: string, dt: Date | null) => {
    if (dt) cands.push({ kind, source, raw: raw.slice(0, 80), date: iso(dt) });
  };
  if (html) {
    for (const { key, content } of html.metas) {
      if (MODIFIED_META.has(key) || key === "datemodified") add("modified", `meta[${key}]`, content, parseDate(content, now));
      else if (PUBLISHED_META.has(key) || key === "datepublished") add("published", `meta[${key}]`, content, parseDate(content, now));
    }
    for (const raw of html.jsonld) {
      let data: unknown;
      try { data = JSON.parse(raw.trim()); } catch { continue; }
      const found: Array<[string, string]> = [];
      walkJsonld(data, found);
      for (const [k, v] of found.slice(0, 20)) add(k === "dateModified" ? "modified" : "published", `json-ld.${k}`, v, parseDate(v, now));
    }
    for (const t of html.times) {
      const dtv = t.datetime || t.text;
      if (["updated", "modified", "revised"].some((w) => t.attrs.includes(w))) add("modified", "time[updated]", dtv, parseDate(dtv, now));
      else if (["published", "pubdate", "datepublished"].some((w) => t.attrs.includes(w))) add("published", "time[published]", dtv, parseDate(dtv, now));
    }
  }
  if (text) {
    let seen = 0;
    UPDATED_TEXT_RE.lastIndex = 0;
    const hay = text.length > 2_000_000 ? text.slice(0, 2_000_000) : text;
    for (const m of hay.matchAll(UPDATED_TEXT_RE)) {
      const label = m.groups!.label.toLowerCase().split(/\s+/).join(" ");
      add("modified", `text['${label}']`, m[0], parseDate(m.groups!.date, now));
      if (++seen >= 10) break;
    }
    const tail = text.length > 20000 ? text.slice(-20000) : text;
    const years: number[] = [];
    for (const m of (tail + " " + text.slice(0, 5000)).matchAll(COPYRIGHT_RE)) {
      const y = parseInt(m.groups!.year, 10);
      if (y >= MIN_YEAR && y <= now.getUTCFullYear()) years.push(y);
    }
    if (years.length) {
      const y = Math.max(...years);
      cands.push({ kind: "copyright", source: "copyright notice", raw: `© ${y}`, date: `${y}-01-01T00:00:00Z` });
    }
  }
  return cands;
}

// --------------------------------------------------------------- normalisation
const TRANS: Record<string, string> = {
  "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
  "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"',
  "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u2010": "-", "\u2011": "-",
  "\u00a0": " ", "\u2009": " ", "\u202f": " ", "\u200b": "", "\u00ad": "",
  "\u2026": "...",
};
const TRANS_RE = new RegExp("[" + Object.keys(TRANS).join("") + "]", "g");

export function normalize(s: string): string {
  return s.normalize("NFKC").replace(TRANS_RE, (c) => TRANS[c]).replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ PDF
export { latin1Decode, pdfExtract } from "./pdf";
