// The fast path: reads cases.json as raw bytes and writes answers.json as raw bytes, reading each
// case's CSV text straight out of its JSON-escaped form in a single pass. No case text is decoded
// into a JS string and no answer object is built: field bytes are copied from the input as they
// are scanned (a JSON escape such as \t or é means the same thing in the output), with only
// the changes csv-reader makes (a doubled quote read as one, a CR inside quotes read as LF, a stray
// CR dropped). A record is written as it is read; a short row gets its padding appended, a long
// row has its extra fields moved to the error, a record that turns out to be empty is rolled back.
// The functions are kept small so the optimizing compiler handles each one quickly.
// transformCases(bytes) returns the answers.json bytes, or null when the input is not shaped as
// expected, so the caller can fall back to the plain reader (solve.js).

const BS = 92;
const DQ = 34;
const COMMA_BYTE = 44;

// Logical character classes of one token of a JSON string's contents.
const C_OTHER = 0;
const C_COMMA = 1;
const C_LF = 2;
const C_CR = 3;
const C_QUOTE = 4;
const C_END = 5;

let SRC = null; // input bytes
let OUT = null; // answers bytes
let O = 0;
let ERR = null; // the current case's error records
let EO = 0;
let P = 0; // read position after the last field
let LINE = 1;
let L = 1; // byte length of the token last classified
let REC_LINE = 1;
let REC_ROW = null;
let ODD_FOUND = -1;
let ODD_SCAN = 0;

function hex4(src, i) {
  let v = 0;
  for (let k = 0; k < 4; k++) {
    const b = src[i + k];
    let d;
    if (b >= 48 && b <= 57) d = b - 48;
    else if (b >= 97 && b <= 102) d = b - 87;
    else if (b >= 65 && b <= 70) d = b - 55;
    else return -1;
    v = v * 16 + d;
  }
  return v;
}

// Class of the escape token at i (src[i] is a backslash); sets L to its byte length.
function escClass(src, i) {
  const e = src[i + 1];
  L = 2;
  if (e === 110) return C_LF;
  if (e === 114) return C_CR;
  if (e === 34) return C_QUOTE;
  if (e === 117) {
    L = 6;
    const h = hex4(src, i + 2);
    if (h === 10) return C_LF;
    if (h === 13) return C_CR;
    if (h === 34) return C_QUOTE;
    if (h === 44) return C_COMMA;
  }
  return C_OTHER;
}

// Class of any token at i (i < end of text); sets L.
function cls(src, i) {
  const b = src[i];
  if (b === BS) return escClass(src, i);
  L = 1;
  return b === COMMA_BYTE ? C_COMMA : C_OTHER;
}

function grow(buf, used, need) {
  let size = buf.length * 2;
  while (size < used + need) size *= 2;
  const bigger = Buffer.allocUnsafe(size);
  buf.copy(bigger, 0, 0, used);
  return bigger;
}

function ensureErr(need) {
  if (EO + need > ERR.length) ERR = grow(ERR, EO, need);
}

function errAscii(text) {
  const err = ERR;
  let eo = EO;
  for (let k = 0; k < text.length; k++) err[eo++] = text.charCodeAt(k);
  EO = eo;
}

function outAscii(text) {
  const out = OUT;
  let o = O;
  for (let k = 0; k < text.length; k++) out[o++] = text.charCodeAt(k);
  O = o;
}

// Opens an error record {code, line, row (, ...)}; the caller closes it with '}'.
function openError(code) {
  ensureErr(96);
  if (EO > 0) ERR[EO++] = COMMA_BYTE;
  errAscii('{"code":"');
  errAscii(code);
  errAscii('","line":');
  errAscii(String(REC_LINE));
  errAscii(',"row":');
  errAscii(REC_ROW === null ? 'null' : String(REC_ROW));
}

function simpleError(code) {
  openError(code);
  ERR[EO++] = 125;
}

// Copies unquoted field bytes from p to the next comma or line break, dropping stray CRs. The
// field's opening quote is already written. Returns how the field ended; leaves P, O and LINE.
function plainRun(src, out, p, te, o) {
  for (;;) {
    while (p < te) {
      const b = src[p];
      if (b === COMMA_BYTE || b === BS) break;
      out[o++] = b;
      p++;
    }
    if (p >= te) {
      P = p;
      O = o;
      return C_END;
    }
    if (src[p] === COMMA_BYTE) {
      P = p + 1;
      O = o;
      return C_COMMA;
    }
    const c = escClass(src, p);
    const l = L;
    if (c === C_OTHER || c === C_QUOTE) {
      for (let k = 0; k < l; k++) out[o++] = src[p + k];
      p += l;
      continue;
    }
    if (c === C_COMMA) {
      P = p + l;
      O = o;
      return C_COMMA;
    }
    if (c === C_LF) {
      P = p + l;
      O = o;
      LINE++;
      return C_LF;
    }
    if (p + l < te && cls(src, p + l) === C_LF) {
      P = p + l + L;
      O = o;
      LINE++;
      return C_LF;
    }
    O = o;
    simpleError('stray_cr');
    p += l;
  }
}

// Whether an odd-length run of quote tokens starts after the quote run open..runEnd: only such a
// run can close a quoted field whose own run pairs up. The search only goes forward and keeps the
// last odd run it found, so the searches of one text read it once in all.
function oddRunAfter(src, open, runEnd, te) {
  if (ODD_FOUND > open) return true;
  let i = ODD_SCAN > runEnd ? ODD_SCAN : runEnd;
  while (i < te) {
    if (src[i] !== BS) {
      i++;
      continue;
    }
    let c = escClass(src, i);
    if (c !== C_QUOTE) {
      i += L;
      continue;
    }
    const start = i;
    let run = 0;
    while (c === C_QUOTE) {
      i += L;
      run++;
      if (i >= te) break;
      c = cls(src, i);
    }
    if (run & 1) {
      ODD_FOUND = start;
      ODD_SCAN = i;
      return true;
    }
  }
  ODD_SCAN = te;
  return false;
}

// A field opening with a quote token at p (its opening quote byte already written to OUT).
// Returns how the field ended; leaves P, O and LINE.
function quotedField(src, out, p, te) {
  const open = p;
  escClass(src, open);
  const ql = L;
  let runEnd = open + ql;
  let run = 1;
  while (runEnd < te && src[runEnd] === BS && escClass(src, runEnd) === C_QUOTE) {
    runEnd += L;
    run++;
  }
  if ((run & 1) === 1 && !oddRunAfter(src, open, runEnd, te)) {
    // The quote never closes: a literal character, and the rest is read as unquoted.
    simpleError('unterminated_quote');
    let o = O;
    for (let k = 0; k < ql; k++) out[o++] = src[open + k];
    return plainRun(src, out, open + ql, te, o);
  }
  let o = O;
  let i = open + ql;
  for (;;) {
    // Inside quotes only escape tokens matter: copy up to the next backslash in one go.
    const next = src.indexOf(BS, i);
    if (next < 0 || next >= te) throw new Error('quoted field ran past the text');
    if (next - i > 32) {
      src.copy(out, o, i, next);
      o += next - i;
    } else {
      for (let k = i; k < next; k++) out[o++] = src[k];
    }
    i = next;
    const c = escClass(src, i);
    const l = L;
    if (c === C_QUOTE) {
      if (i + l < te && src[i + l] === BS && escClass(src, i + l) === C_QUOTE) {
        // A doubled quote is one quote.
        out[o++] = BS;
        out[o++] = DQ;
        i += l + L;
        continue;
      }
      i += l;
      break;
    }
    if (c === C_CR) {
      // CRLF and a lone CR inside quotes are each one LF.
      out[o++] = BS;
      out[o++] = 110;
      LINE++;
      i += l;
      if (i < te && src[i] === BS && escClass(src, i) === C_LF) i += L;
      continue;
    }
    if (c === C_LF) LINE++;
    for (let k = 0; k < l; k++) out[o++] = src[i + k];
    i += l;
  }
  if (i >= te) {
    P = i;
    O = o;
    return C_END;
  }
  const c1 = cls(src, i);
  const l1 = L;
  if (c1 === C_COMMA) {
    P = i + l1;
    O = o;
    return C_COMMA;
  }
  if (c1 === C_LF) {
    P = i + l1;
    O = o;
    LINE++;
    return C_LF;
  }
  if (c1 === C_CR && i + l1 < te && cls(src, i + l1) === C_LF) {
    P = i + l1 + L;
    O = o;
    LINE++;
    return C_LF;
  }
  // What follows the closing quote is appended as it stands, up to the next comma or line break.
  // quote_junk is recorded when the field ends, after any stray_cr inside the junk.
  const before = o;
  const ended = plainRun(src, out, i, te, o);
  if (O > before) simpleError('quote_junk');
  return ended;
}

// Skips lines with no characters (LF or CRLF); returns the new read position.
function skipBlank(src, p, te) {
  while (p < te) {
    const b = src[p];
    if (b !== BS) return p;
    const c = escClass(src, p);
    const l = L;
    if (c === C_LF) {
      p += l;
      LINE++;
    } else if (c === C_CR && p + l < te && cls(src, p + l) === C_LF) {
      p += l + L;
      LINE++;
    } else return p;
  }
  return p;
}

let FIELD_AT = new Int32Array(256); // output offset of each field's opening quote

// Reads one record from p and writes it to OUT as a JSON array; returns the number of fields
// (the record's bytes are OUT[recordStart..O)). Sets ONLY_EMPTY when it is a single empty
// unquoted field.
let ONLY_EMPTY = false;
function readRecord(src, p, te) {
  const out = OUT;
  out[O++] = 91;
  let nf = 0;
  let ended = C_COMMA;
  let quoted = false;
  while (ended === C_COMMA) {
    if (nf > 0) out[O++] = COMMA_BYTE;
    if (nf === FIELD_AT.length) {
      const bigger = new Int32Array(nf * 2);
      bigger.set(FIELD_AT);
      FIELD_AT = bigger;
    }
    FIELD_AT[nf++] = O;
    out[O++] = DQ;
    if (p < te && src[p] === BS && escClass(src, p) === C_QUOTE) {
      quoted = true;
      ended = quotedField(src, out, p, te);
    } else {
      quoted = false;
      ended = plainRun(src, out, p, te, O);
    }
    out[O++] = DQ;
    p = P;
  }
  P = p;
  ONLY_EMPTY = nf === 1 && !quoted && O === FIELD_AT[0] + 2;
  return nf;
}

function ensureOut(need) {
  if (O + need > OUT.length) OUT = grow(OUT, O, need);
}

// Closes a row whose field count is not the first record's: pads a short row with empty fields,
// moves a long row's extra fields into its long_row error.
function fixWidth(nf, width) {
  if (nf < width) {
    const out = OUT;
    for (let k = nf; k < width; k++) {
      out[O++] = COMMA_BYTE;
      out[O++] = DQ;
      out[O++] = DQ;
    }
    openError('short_row');
    errAscii(',"fields":');
    errAscii(String(nf));
    ERR[EO++] = 125;
  } else {
    const cut = FIELD_AT[width];
    openError('long_row');
    ensureErr(O - cut + 16);
    errAscii(',"extra":[');
    OUT.copy(ERR, EO, cut, O);
    EO += O - cut;
    ERR[EO++] = 93;
    ERR[EO++] = 125;
    O = cut - 1;
  }
  OUT[O++] = 93;
}

// Reads the CSV text whose JSON-escaped contents are SRC[ts..te) and writes its answer.
function answerCase(ts, te, header) {
  const src = SRC;
  EO = 0;
  LINE = 1;
  ODD_FOUND = -1;
  ODD_SCAN = ts;
  let p = ts;
  if (te - ts >= 3 && src[p] === 0xef && src[p + 1] === 0xbb && src[p + 2] === 0xbf) p += 3;
  else if (te - ts >= 6 && src[p] === BS && src[p + 1] === 117 && hex4(src, p + 2) === 0xfeff) p += 6;

  let rowCount = 0;
  let width = -1;
  let haveColumns = !header;
  ensureOut(64);
  outAscii(header ? '{"columns":' : '{"columns":null,"rows":[');

  for (;;) {
    p = skipBlank(src, p, te);
    if (p >= te) break;
    const isHeader = !haveColumns;
    REC_LINE = LINE;
    REC_ROW = isHeader ? null : rowCount;
    ensureOut(3 * (te - p) + 3 * (width > 0 ? width : 0) + 64);
    const before = O;
    if (!isHeader && rowCount > 0) OUT[O++] = COMMA_BYTE;
    const nf = readRecord(src, p, te);
    p = P;
    if (ONLY_EMPTY) {
      // A line that held only stray CRs is no record (its errors stay).
      O = before;
      continue;
    }
    if (width < 0) width = nf;
    if (isHeader) {
      OUT[O++] = 93;
      haveColumns = true;
      outAscii(',"rows":[');
      continue;
    }
    if (nf === width) OUT[O++] = 93;
    else fixWidth(nf, width);
    rowCount++;
  }

  ensureOut(EO + 32);
  if (!haveColumns) outAscii('[],"rows":[');
  outAscii('],"errors":[');
  ERR.copy(OUT, O, 0, EO);
  O += EO;
  outAscii(']}');
}

// ---- The outer JSON: an array of {id, input: {text, header}} ----

let J = 0;
let STRING_END = null; // optional faster finder of a case text's closing quote (from J)

function ws() {
  const src = SRC;
  for (;;) {
    const b = src[J];
    if (b === 32 || b === 10 || b === 13 || b === 9) J++;
    else return;
  }
}

// Index of the closing quote of the JSON string whose opening quote is at J, or -1.
// A quote byte ends the string unless an odd number of backslashes stands right before it.
function stringEnd() {
  const src = SRC;
  let from = J + 1;
  for (;;) {
    const q = src.indexOf(DQ, from);
    if (q < 0) return -1;
    let k = q - 1;
    while (k >= from - 1 && src[k] === BS) k--;
    if (((q - 1 - k) & 1) === 0) return q;
    from = q + 1;
  }
}

function readKey() {
  if (SRC[J] !== DQ) return null;
  const end = stringEnd();
  if (end < 0) return null;
  const raw = SRC.toString('latin1', J + 1, end);
  J = end + 1;
  return raw.includes('\\') ? JSON.parse(`"${raw}"`) : raw;
}

function skipValue() {
  ws();
  const src = SRC;
  const b = src[J];
  if (b === DQ) {
    const end = stringEnd();
    if (end < 0) return false;
    J = end + 1;
    return true;
  }
  if (b === 123 || b === 91) {
    let depth = 0;
    while (J < src.length) {
      const c = src[J];
      if (c === DQ) {
        const end = stringEnd();
        if (end < 0) return false;
        J = end + 1;
        continue;
      }
      if (c === 123 || c === 91) depth++;
      else if (c === 125 || c === 93) {
        depth--;
        if (depth === 0) {
          J++;
          return true;
        }
      }
      J++;
    }
    return false;
  }
  const start = J;
  while (J < src.length) {
    const c = src[J];
    if (c === COMMA_BYTE || c === 125 || c === 93 || c === 32 || c === 10 || c === 13 || c === 9) break;
    J++;
  }
  return J > start;
}

// Reads one object's members, handing each key to `member` (which reads the value); false on any
// shape it does not expect.
function readObject(member) {
  ws();
  if (SRC[J] !== 123) return false;
  J++;
  ws();
  if (SRC[J] === 125) {
    J++;
    return true;
  }
  for (;;) {
    ws();
    const key = readKey();
    if (key === null) return false;
    ws();
    if (SRC[J] !== 58) return false;
    J++;
    ws();
    if (!member(key)) return false;
    ws();
    if (SRC[J] === COMMA_BYTE) {
      J++;
      continue;
    }
    if (SRC[J] === 125) {
      J++;
      return true;
    }
    return false;
  }
}

function readCases() {
  const cases = [];
  J = 0;
  ws();
  if (SRC[J] !== 91) return null;
  J++;
  ws();
  if (SRC[J] === 93) return cases;
  for (;;) {
    const found = { text: -1, textEnd: -1, header: false, hasInput: false };
    const inputMember = (key) => {
      if (key === 'text') {
        if (SRC[J] !== DQ) {
          found.text = -2;
          return skipValue();
        }
        const end = STRING_END === null ? stringEnd() : STRING_END(J);
        if (end < 0) return false;
        found.text = J + 1;
        found.textEnd = end;
        J = end + 1;
        return true;
      }
      if (key === 'header') {
        const start = J;
        if (!skipValue()) return false;
        found.header = SRC.toString('latin1', start, J) === 'true';
        return true;
      }
      return skipValue();
    };
    const ok = readObject((key) => {
      if (key !== 'input') return skipValue();
      found.text = -1;
      found.header = false;
      found.hasInput = true;
      return readObject(inputMember);
    });
    // Only a string text is read here; anything else goes to the plain reader.
    if (!ok || !found.hasInput || found.text < 0) return null;
    cases.push(found);
    ws();
    if (SRC[J] === COMMA_BYTE) {
      J++;
      continue;
    }
    if (SRC[J] === 93) return cases;
    return null;
  }
}

export function transformCases(bytes) {
  SRC = bytes;
  const cases = readCases();
  if (cases === null) {
    SRC = null;
    return null;
  }
  OUT = Buffer.allocUnsafe(3 * bytes.length + (1 << 20));
  ERR = Buffer.allocUnsafe(1 << 16);
  O = 0;
  OUT[O++] = 91;
  for (let k = 0; k < cases.length; k++) {
    if (k > 0) {
      ensureOut(1);
      OUT[O++] = COMMA_BYTE;
    }
    answerCase(cases[k].text, cases[k].textEnd, cases[k].header);
  }
  ensureOut(1);
  OUT[O++] = 93;
  const result = OUT.subarray(0, O);
  SRC = null;
  OUT = null;
  ERR = null;
  return result;
}

// Runs the reader over a small sample that takes every branch (escapes in both forms, quoted and
// broken fields, stray CRs, short and long rows, BOMs, both header settings), so the engine has
// seen every path before it optimizes the hot functions and does not have to throw that work away.
// The sample is written with ~ for each backslash of its JSON escapes.
const WARM_TEXTS = [
  'a,b,c~r~nd,~"e ~"~"f~"~" g~",h~n1,2~n3,4,5,6~r~n~"x~r~ny~",z,w',
  '~ufeffh1,h2~n~"q~"junk,~~~"p~r,s~n~r~n~r~n,,~n~"open,~ttab~u00e9~n~"a~"~"b~"~u002c~u0022c~u0022,d~u000d~u000a',
  'x~ry,~"z~"~r~n~"unterminated~n~~ back~/slash,~u2028~n~"a~rb~",~"c~r~",d~n,,,,~n',
  '~u0022~u0022~u0022a~u0022~u0022~u0022,b~u000dc~n',
  '~uFEFF~"~"~"~",~u000D~u000Ax~u002C~"y~r~"',
].map((t) => t.replaceAll('~', String.fromCharCode(92)));
export function warmUp() {
  let json = '[';
  for (let r = 0; r < 60; r++) {
    WARM_TEXTS.forEach((t, k) => {
      if (r + k > 0) json += ',';
      json += '{"id":"w","input":{"text":"' + t + '","header":' + ((r + k) % 2 === 0) + '}}';
    });
  }
  transformCases(Buffer.from(json + ']', 'latin1'));
}

// Where each case's text sits in the cases.json bytes ({text, textEnd, header} per case), or null
// when the file is not shaped as expected. Used by the WebAssembly reader too, which passes its
// own finder for the end of each (long) text string.
export function locateCases(bytes, stringEndAt = null) {
  SRC = bytes;
  STRING_END = stringEndAt;
  const cases = readCases();
  SRC = null;
  STRING_END = null;
  return cases;
}
