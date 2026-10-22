/**
 * Small PDF text extractor for Workers (no pdf.js): resolves objects (incl. object streams), walks
 * pages -> /Resources /Font -> /ToUnicode CMaps, and decodes Tj/TJ/'/" strings per font. Handles the
 * common outputs of Word, LibreOffice, LaTeX and browsers' print-to-PDF; encrypted PDFs and fonts
 * without a ToUnicode map (custom encodings) yield little or no text. Work is bounded for the
 * Workers CPU budget (stream count and inflated bytes).
 */

const U16 = new TextDecoder("utf-16le");
export function latin1Decode(b: Uint8Array): string {
  // Widen bytes to UTF-16 code units (no surrogates possible below 0x100) and decode natively: ~10x
  // faster than String.fromCharCode chunks, which matters under the Workers CPU budget.
  try {
    const u16 = new Uint16Array(b.length);
    u16.set(b);
    return U16.decode(u16);
  } catch {
    /* fall through */
  }
  let out = "";
  for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return out;
}

async function inflate(data: Uint8Array, maxOut: number): Promise<Uint8Array | null> {
  for (const fmt of ["deflate", "deflate-raw"] as const) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const ds = new DecompressionStream(fmt);
      const writer = ds.writable.getWriter();
      writer.write(data).catch(() => {});
      writer.close().catch(() => {});
      const reader = ds.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
        if (total > maxOut) { try { await reader.cancel(); } catch { /* */ } break; }
      }
    } catch {
      // trailing junk / truncated data: keep what was inflated
    }
    if (total > 0) {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.byteLength; }
      return out;
    }
  }
  return null;
}

export function pdfString(lit: string): string {
  return lit.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_m, g: string) => {
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8) & 0xff);
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[g] ?? "";
  });
}

// --------------------------------------------------------------- dict helpers
/** Raw value of /Key in a PDF dictionary string (balanced for << >>, [ ], ( )). */
export function dictGet(dict: string, key: string): string | null {
  const re = new RegExp(`/${key}(?=[\\s/<\\[(\\d-])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(dict))) {
    let i = m.index + m[0].length;
    while (i < dict.length && /\s/.test(dict[i])) i++;
    const c = dict[i];
    if (c === "<" && dict[i + 1] === "<") {
      let depth = 0, j = i;
      for (; j < dict.length; j++) {
        if (dict[j] === "<" && dict[j + 1] === "<") { depth++; j++; }
        else if (dict[j] === ">" && dict[j + 1] === ">") { depth--; j++; if (depth === 0) break; }
      }
      return dict.slice(i, j + 1);
    }
    if (c === "[") {
      let depth = 0, j = i;
      for (; j < dict.length; j++) { if (dict[j] === "[") depth++; else if (dict[j] === "]" && --depth === 0) break; }
      return dict.slice(i, j + 1);
    }
    if (c === "(") {
      let depth = 0, j = i;
      for (; j < dict.length; j++) {
        if (dict[j] === "\\") { j++; continue; }
        if (dict[j] === "(") depth++; else if (dict[j] === ")" && --depth === 0) break;
      }
      return dict.slice(i, j + 1);
    }
    const ref = dict.slice(i).match(/^(\d+)\s+(\d+)\s+R\b/);
    if (ref) return ref[0];
    const tok = dict.slice(i).match(/^(\/[^\s/<>\[\]()]+|[^\s/<>\[\]()]+)/);
    return tok ? tok[0] : null;
  }
  return null;
}

const refNum = (v: string | null): number | null => {
  const m = v && v.match(/^(\d+)\s+\d+\s+R$/);
  return m ? parseInt(m[1], 10) : null;
};

interface PdfObj { dict: string; streamStart?: number; streamEnd?: number; inStream?: string }

class PdfDoc {
  raw: string;
  data: Uint8Array;
  objs = new Map<number, PdfObj>();
  budget: number;
  streamsLeft: number;
  constructor(data: Uint8Array, budget: number, maxStreams: number) {
    this.data = data;
    this.raw = latin1Decode(data);
    this.budget = budget;
    this.streamsLeft = maxStreams;
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.raw))) {
      const start = m.index + m[0].length;
      const end = this.raw.indexOf("endobj", start);
      if (end < 0) break;
      const body = this.raw.slice(start, end);
      const sIdx = body.search(/\bstream\r?\n/);
      const num = parseInt(m[1], 10);
      if (sIdx >= 0) {
        let s = start + sIdx + 6;
        if (this.raw[s] === "\r") s++;
        if (this.raw[s] === "\n") s++;
        let e = this.raw.lastIndexOf("endstream", end);
        if (e < s) e = end;
        const dict = body.slice(0, sIdx);
        const len = dictGet(dict, "Length");
        if (len && /^\d+$/.test(len) && s + parseInt(len, 10) <= e) e = s + parseInt(len, 10);
        else while (e > s && (data[e - 1] === 10 || data[e - 1] === 13 || data[e - 1] === 32)) e--;
        this.objs.set(num, { dict, streamStart: s, streamEnd: e });
      } else {
        this.objs.set(num, { dict: body });
      }
      re.lastIndex = end + 6;
    }
  }

  async streamText(o: PdfObj): Promise<string | null> {
    if (o.streamStart === undefined || this.budget <= 0 || this.streamsLeft <= 0) return null;
    this.streamsLeft--;
    const filter = dictGet(o.dict, "Filter") || "";
    const bytes = this.data.subarray(o.streamStart, o.streamEnd);
    if (!filter) return latin1Decode(bytes);
    if (!/^\[?\s*\/FlateDecode\s*\]?$/.test(filter)) return null;
    const out = await inflate(bytes, Math.min(this.budget, 4_000_000));
    if (!out) return null;
    this.budget -= out.byteLength;
    return latin1Decode(out);
  }

  async loadObjectStreams(): Promise<void> {
    for (const [, o] of [...this.objs]) {
      if (!/\/Type\s*\/ObjStm\b/.test(o.dict)) continue;
      const content = await this.streamText(o);
      if (!content) continue;
      const n = parseInt(dictGet(o.dict, "N") || "0", 10);
      const first = parseInt(dictGet(o.dict, "First") || "0", 10);
      const nums = content.slice(0, first).trim().split(/\s+/).map(Number);
      for (let i = 0; i < n && 2 * i + 1 < nums.length; i++) {
        const num = nums[2 * i], off = nums[2 * i + 1];
        const next = 2 * i + 3 < nums.length ? nums[2 * i + 3] : content.length - first;
        if (!this.objs.has(num)) this.objs.set(num, { dict: content.slice(first + off, first + next), inStream: "objstm" });
      }
    }
  }

  get(v: string | null): string | null {
    const n = refNum(v);
    if (n === null) return v;
    return this.objs.get(n)?.dict ?? null;
  }
}

// --------------------------------------------------------------- CMaps
interface CMap { codeLen: number; map: Map<number, string> }

function hexToUtf16(hex: string): string {
  const h = hex.replace(/\s+/g, "");
  let s = "";
  for (let i = 0; i + 4 <= h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
  if (h.length === 2) s = String.fromCharCode(parseInt(h, 16));
  return s;
}

export function parseCMap(src: string): CMap {
  const map = new Map<number, string>();
  let codeLen = 1;
  const csr = src.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (csr) codeLen = Math.max(1, Math.ceil(csr[1].length / 2));
  for (const block of src.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f\s]*)>/g)) map.set(parseInt(m[1], 16), hexToUtf16(m[2]));
  }
  for (const block of src.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f\s]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16), hi = Math.min(parseInt(m[2], 16), lo + 65535);
      if (m[3].startsWith("[")) {
        const items = [...m[3].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((x) => hexToUtf16(x[1]));
        for (let c = lo; c <= hi && c - lo < items.length; c++) map.set(c, items[c - lo]);
      } else {
        const base = m[3].slice(1, -1).replace(/\s+/g, "");
        const head = base.slice(0, -4), last = parseInt(base.slice(-4) || "0", 16);
        for (let c = lo; c <= hi; c++) map.set(c, hexToUtf16(head) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
  return { codeLen, map };
}

const hexBytes = (h: string) => {
  const s = h.replace(/[^0-9A-Fa-f]/g, "");
  let out = "";
  for (let i = 0; i < s.length; i += 2) out += String.fromCharCode(parseInt((s.slice(i, i + 2) + "0").slice(0, 2), 16));
  return out;
};
const strBytes = (tok: string) => (tok[0] === "<" ? hexBytes(tok.slice(1, -1)) : pdfString(tok.slice(1, -1)));

interface FontInfo { cmap: CMap | null; widths: Map<number, number>; dw: number; codeLen: number }

const STR = String.raw`\((?:\\.|[^()\\]|\((?:\\.|[^()\\])*\))*\)|<[0-9A-Fa-f\s]*>`;
const NUM = String.raw`-?(?:\d+\.?\d*|\.\d+)`;
const CONTENT_RE = new RegExp(
  String.raw`\/([^\s\/\[\]()<>]+)\s+(${NUM})\s+Tf` +
    String.raw`|\[((?:${STR}|[^\]])*)\]\s*TJ` +
    String.raw`|(${STR})\s*(?:Tj|'|")` +
    String.raw`|(${NUM})\s+(${NUM})\s+(Td|TD)\b` +
    String.raw`|(?:${NUM}\s+){4}(${NUM})\s+(${NUM})\s+Tm\b` +
    String.raw`|\b(T\*|ET|BT)\b`,
  "g",
);
const TJ_ITEM_RE = new RegExp(String.raw`(${STR})|(${NUM})`, "g");

function codesOf(bytes: string, codeLen: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + codeLen <= bytes.length; i += codeLen) {
    let code = 0;
    for (let k = 0; k < codeLen; k++) code = (code << 8) | (bytes.charCodeAt(i + k) & 0xff);
    out.push(code);
  }
  return out;
}

function decodeCodes(codes: number[], f: FontInfo | null): string {
  let out = "";
  for (const code of codes) {
    const u = f?.cmap?.map.get(code);
    if (u !== undefined) out += u;
    else if (!f?.cmap) out += f && f.codeLen === 2 ? "" : String.fromCharCode(code);
    else if (f.codeLen === 1 && code >= 32 && code < 127) out += String.fromCharCode(code);
  }
  return out;
}

/**
 * Text of one content stream. Tracks the horizontal text position from glyph widths so that word
 * gaps produced by positioning operators (Td/Tm/TJ kerning) become spaces, while kerning inside a
 * word does not.
 */
export function textFromContent(cs: string, fonts: Map<string, FontInfo | null>): string {
  const parts: string[] = [];
  let font: FontInfo | null = null;
  let fs = 10;
  let x = 0, lineX = 0, lineY = 0, y = 0;
  const space = () => { if (parts.length && !/\s$/.test(parts[parts.length - 1])) parts.push(" "); };
  const advance = (codes: number[]) => {
    const f = font;
    for (const c of codes) x += ((f?.widths.get(c) ?? f?.dw ?? 500) / 1000) * fs;
  };
  const show = (bytes: string) => {
    const codes = codesOf(bytes, font?.codeLen ?? 1);
    parts.push(decodeCodes(codes, font));
    advance(codes);
  };
  const moveTo = (nx: number, ny: number) => {
    if (Math.abs(ny - y) > 0.01) space();
    else if (nx - x > 0.15 * fs || nx < x - 2 * fs) space();
    x = nx; y = ny;
  };
  CONTENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONTENT_RE.exec(cs))) {
    if (m[1] !== undefined) {
      font = fonts.get(m[1]) ?? null;
      fs = Math.abs(parseFloat(m[2])) || fs;
    } else if (m[3] !== undefined) {
      for (const it of m[3].matchAll(TJ_ITEM_RE)) {
        if (it[1] !== undefined) show(strBytes(it[1]));
        else {
          const adj = parseFloat(it[2]);
          if (adj < -150) space(); // > 0.15 em gap: word space (kerning is usually within +-100)
          x -= (adj / 1000) * fs;
        }
      }
    } else if (m[4] !== undefined) {
      show(strBytes(m[4]));
    } else if (m[7] !== undefined) {
      const tx = parseFloat(m[5]), ty = parseFloat(m[6]);
      lineX += tx; lineY += ty;
      moveTo(lineX, lineY);
    } else if (m[8] !== undefined) {
      lineX = parseFloat(m[8]); lineY = parseFloat(m[9]);
      moveTo(lineX, lineY);
    } else if (m[10] === "BT") {
      lineX = 0; lineY = 0;
      // keep x/y: a new text object at the same position continues the line
    } else {
      space();
    }
  }
  return parts.join("");
}

// --------------------------------------------------------------- top level
export async function pdfExtract(data: Uint8Array, opts: { maxStreams?: number; maxInflated?: number; maxPages?: number } = {}): Promise<{ text: string; meta: Record<string, string> }> {
  const doc = new PdfDoc(data, opts.maxInflated ?? 12_000_000, opts.maxStreams ?? 600);
  await doc.loadObjectStreams();
  const meta: Record<string, string> = {};
  for (const [, o] of doc.objs) {
    if (!/\/(ModDate|CreationDate)\s*\(/.test(o.dict)) continue;
    for (const k of ["ModDate", "CreationDate", "Title"]) {
      const v = dictGet(o.dict, k);
      if (v && v.startsWith("(") && !meta[k]) meta[k] = pdfString(v.slice(1, -1)).slice(0, 300);
    }
  }
  if (!meta["ModDate"]) {
    const x = doc.raw.match(/<xmp:ModifyDate>([^<]+)<\/xmp:ModifyDate>/);
    if (x) meta["XmpModifyDate"] = x[1];
  }
  const fontCache = new Map<number, FontInfo | null>();
  const numList = (v: string | null) => (v ? [...v.matchAll(/-?\d+(?:\.\d+)?/g)].map((x) => parseFloat(x[0])) : []);
  const fontInfo = async (fontRef: string): Promise<FontInfo | null> => {
    const n = refNum(fontRef);
    if (n !== null && fontCache.has(n)) return fontCache.get(n)!;
    const fd = doc.get(fontRef);
    if (!fd) return null;
    let cmap: CMap | null = null;
    const tn = refNum(dictGet(fd, "ToUnicode"));
    const to = tn !== null ? doc.objs.get(tn) : undefined;
    if (to) {
      const src = await doc.streamText(to);
      if (src) cmap = parseCMap(src);
    }
    const widths = new Map<number, number>();
    let dw = 500;
    let codeLen = 1;
    if (/\/Subtype\s*\/Type0/.test(fd)) {
      codeLen = 2;
      dw = 1000;
      const desc = doc.get(dictGet(fd, "DescendantFonts")) || "";
      const cid = doc.get((desc.match(/(\d+\s+\d+\s+R)/) || [])[1] || null) || desc;
      const dwv = dictGet(cid, "DW");
      if (dwv && /^\d/.test(dwv)) dw = parseFloat(dwv);
      const w = doc.get(dictGet(cid, "W")) || "";
      // [c [w1 w2 ...]  cFirst cLast w ...]
      const toks = w.replace(/^\[|\]$/g, "").match(/\[[^\]]*\]|-?\d+(?:\.\d+)?/g) || [];
      for (let i = 0; i < toks.length && widths.size < 70000; ) {
        const c0 = parseFloat(toks[i]);
        if (toks[i + 1]?.startsWith("[")) {
          numList(toks[i + 1]).forEach((wv, k) => widths.set(c0 + k, wv));
          i += 2;
        } else if (toks[i + 2] !== undefined) {
          const c1 = parseFloat(toks[i + 1]), wv = parseFloat(toks[i + 2]);
          for (let c = c0; c <= c1 && c - c0 < 70000; c++) widths.set(c, wv);
          i += 3;
        } else break;
      }
    } else {
      const first = parseInt(dictGet(fd, "FirstChar") || "0", 10);
      numList(doc.get(dictGet(fd, "Widths"))).forEach((wv, k) => widths.set(first + k, wv));
      const fdesc = doc.get(dictGet(fd, "FontDescriptor")) || "";
      const mw = dictGet(fdesc, "MissingWidth") || dictGet(fdesc, "AvgWidth");
      if (mw && /^\d/.test(mw)) dw = parseFloat(mw);
    }
    if (cmap && cmap.codeLen) codeLen = cmap.codeLen;
    const info: FontInfo = { cmap, widths, dw, codeLen };
    if (n !== null) fontCache.set(n, info);
    return info;
  };
  // page order: follow /Root /Pages /Kids when possible, else object number order
  const pageNums: number[] = [];
  const rootRef = doc.raw.match(/\/Root\s+(\d+\s+\d+\s+R)/);
  const walk = (ref: string | null, depth: number) => {
    if (!ref || depth > 30 || pageNums.length > 5000) return;
    const n = refNum(ref);
    const d = doc.get(ref);
    if (n === null || !d) return;
    if (/\/Type\s*\/Pages\b/.test(d)) {
      const kids = doc.get(dictGet(d, "Kids")) || "";
      for (const k of kids.matchAll(/(\d+\s+\d+\s+R)/g)) walk(k[1], depth + 1);
    } else if (/\/Type\s*\/Page(?![a-zA-Z])/.test(d)) pageNums.push(n);
  };
  if (rootRef) walk(dictGet(doc.get(rootRef[1]) || "", "Pages"), 0);
  let pages = pageNums.map((n) => [n, doc.objs.get(n)!] as [number, PdfObj]).filter(([, o]) => o);
  if (!pages.length) pages = [...doc.objs.entries()].filter(([, o]) => /\/Type\s*\/Page(?![a-zA-Z])/.test(o.dict)).sort((a, b) => a[0] - b[0]);
  const texts: string[] = [];
  const maxPages = opts.maxPages ?? 300;
  for (const [, page] of pages.slice(0, maxPages)) {
    let res = dictGet(page.dict, "Resources");
    let parent = dictGet(page.dict, "Parent");
    for (let i = 0; !res && parent && i < 8; i++) {
      const pd = doc.get(parent);
      if (!pd) break;
      res = dictGet(pd, "Resources");
      parent = dictGet(pd, "Parent");
    }
    const resDict = doc.get(res) || "";
    const fontDict = doc.get(dictGet(resDict, "Font")) || "";
    const fonts = new Map<string, FontInfo | null>();
    for (const fm of fontDict.matchAll(/\/([^\s/<>\[\]()]+)\s+(\d+\s+\d+\s+R)/g)) fonts.set(fm[1], await fontInfo(fm[2]));
    const contents = dictGet(page.dict, "Contents");
    const refs = contents ? [...contents.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => parseInt(x[1], 10)) : [];
    // /Contents may point to an array object of refs
    if (refs.length === 1) {
      const arr = doc.objs.get(refs[0]);
      if (arr && arr.streamStart === undefined && arr.dict.trim().startsWith("[")) refs.splice(0, 1, ...[...arr.dict.matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => parseInt(x[1], 10)));
    }
    let pageText = "";
    for (const r of refs) {
      const o = doc.objs.get(r);
      if (!o) continue;
      const cs = await doc.streamText(o);
      if (cs) pageText += textFromContent(cs, fonts) + " ";
    }
    texts.push(pageText);
    if (doc.budget <= 0 || doc.streamsLeft <= 0) break;
  }
  if (!pages.length) {
    // no page tree found: scan every content-like stream with the default (byte) encoding
    for (const [, o] of doc.objs) {
      if (o.streamStart === undefined || /\/Subtype\s*\/(Image|XML)|\/FontFile|\/Length[123]\b|\/Type\s*\/(XRef|ObjStm)/.test(o.dict)) continue;
      const cs = await doc.streamText(o);
      if (cs && /\bBT\b/.test(cs)) texts.push(textFromContent(cs, new Map()));
    }
  }
  return { text: texts.join(" ").replace(/\s+/g, " ").trim(), meta };
}
