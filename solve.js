// A fast CSV reader that answers exactly as csv-reader 1.0.0 does: {columns, rows, errors}.
// The hot path (plain unquoted fields) is one tight loop over char codes held in locals, each field
// cut out with slice(); quoted fields, stray CRs and broken quotes take the slower paths below.
// Quote runs are measured once, so a quote that never closes never rescans the text.

const QUOTE = 34;
const COMMA = 44;
const LF = 10;
const CR = 13;

const ENDED_COMMA = 0;
const ENDED_BREAK = 1;
const ENDED_END = 2;

// State shared by the slow paths for the call in progress (run() is synchronous and not re-entrant).
let text = '';
let n = 0;
let pos = 0;
let line = 1;
let errors = null;
let recordLine = 1;
let recordRow = null;
let lastOddRun = -2;
let value = '';
let ended = ENDED_END;
let added = 0;

export function run(input) {
  text = String(input.text);
  n = text.length;
  const header = input.header === true;
  errors = [];
  lastOddRun = -2;
  const rows = [];
  let columns = null;
  let width = -1;
  const src = text;
  const len = n;
  let p = len > 0 && src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let ln = 1;

  for (;;) {
    // Lines with no characters are no records.
    while (p < len) {
      const c = src.charCodeAt(p);
      if (c === LF) {
        p++;
        ln++;
      } else if (c === CR && src.charCodeAt(p + 1) === LF) {
        p += 2;
        ln++;
      } else {
        break;
      }
    }
    if (p >= len) break;

    const row = header && columns === null ? null : rows.length;
    const startLine = ln;
    const fields = [];
    let quoted = false;
    let more = true;
    while (more) {
      let c = src.charCodeAt(p);
      if (c === QUOTE) {
        quoted = true;
        pos = p;
        line = ln;
        recordLine = startLine;
        recordRow = row;
        readQuoted();
        fields.push(value);
        p = pos;
        ln = line;
        more = ended === ENDED_COMMA;
        continue;
      }
      quoted = false;
      const start = p;
      while (p < len) {
        c = src.charCodeAt(p);
        if (c <= COMMA && (c === COMMA || c === LF || c === CR)) break;
        p++;
      }
      if (p >= len) {
        fields.push(src.slice(start, p));
        more = false;
      } else if (c === COMMA) {
        fields.push(src.slice(start, p));
        p++;
      } else if (c === LF) {
        fields.push(src.slice(start, p));
        p++;
        ln++;
        more = false;
      } else if (src.charCodeAt(p + 1) === LF) {
        fields.push(src.slice(start, p));
        p += 2;
        ln++;
        more = false;
      } else {
        // A lone CR: the slow path drops it, reports it and reads the rest of the field.
        pos = p;
        line = ln;
        recordLine = startLine;
        recordRow = row;
        readUnquoted(src.slice(start, p));
        fields.push(value);
        p = pos;
        ln = line;
        more = ended === ENDED_COMMA;
      }
    }

    // A line that held only stray CRs is left with no characters: no record (its errors stay).
    if (fields.length === 1 && !quoted && fields[0] === '') continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    const count = fields.length;
    if (count < width) {
      errors.push({ code: 'short_row', line: startLine, row, fields: count });
      for (let k = count; k < width; k++) fields.push('');
    } else if (count > width) {
      errors.push({ code: 'long_row', line: startLine, row, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  const answer = { columns: header ? (columns ?? []) : null, rows, errors };
  text = '';
  errors = null;
  return answer;
}

// Start of the last run of quotes with an odd length at or after `from`, or -1. An opened quoted
// field can only close on a quote left unpaired, which needs an odd run somewhere after it.
function findLastOddRun(from) {
  let last = -1;
  let i = text.indexOf('"', from);
  while (i !== -1) {
    let j = i + 1;
    while (j < n && text.charCodeAt(j) === QUOTE) j++;
    if ((j - i) & 1) last = i;
    i = text.indexOf('"', j);
  }
  return last;
}

// Unquoted characters from pos up to the next comma or line break, after `prefix`; a CR that is
// not followed by LF is dropped and reported (stray_cr). Sets value, ended and added.
function readUnquoted(prefix) {
  let out = prefix;
  let start = pos;
  let kept = 0;
  while (pos < n) {
    const c = text.charCodeAt(pos);
    if (c > COMMA || (c !== COMMA && c !== LF && c !== CR)) {
      pos++;
      continue;
    }
    if (c === CR && text.charCodeAt(pos + 1) !== LF) {
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      kept += pos - start;
      if (start !== pos) out += text.slice(start, pos);
      pos++;
      start = pos;
      continue;
    }
    kept += pos - start;
    value = start === pos ? out : out + text.slice(start, pos);
    added = kept;
    if (c === COMMA) {
      pos++;
      ended = ENDED_COMMA;
    } else {
      pos += c === CR ? 2 : 1;
      line++;
      ended = ENDED_BREAK;
    }
    return;
  }
  kept += pos - start;
  value = start === pos ? out : out + text.slice(start, pos);
  added = kept;
  ended = ENDED_END;
}

// A quoted field whose opening quote is at pos. Sets value and ended.
function readQuoted() {
  const open = pos;
  let runEnd = open + 1;
  while (runEnd < n && text.charCodeAt(runEnd) === QUOTE) runEnd++;
  if (((runEnd - open - 1) & 1) === 0) {
    if (lastOddRun === -2) lastOddRun = findLastOddRun(runEnd);
    if (lastOddRun <= open) {
      // The quote never closes: it is a literal character and the rest is read as unquoted.
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      pos = open + 1;
      readUnquoted('"');
      return;
    }
  }
  let out = '';
  let i = open + 1;
  let start = i;
  for (;;) {
    const c = text.charCodeAt(i);
    if (c === QUOTE) {
      if (text.charCodeAt(i + 1) === QUOTE) {
        out += text.slice(start, i + 1);
        i += 2;
        start = i;
        continue;
      }
      if (start !== i) out += text.slice(start, i);
      pos = i + 1;
      break;
    }
    if (c === LF) {
      line++;
    } else if (c === CR) {
      // CRLF and a lone CR inside quotes are each one LF.
      out += text.slice(start, i) + '\n';
      line++;
      i += text.charCodeAt(i + 1) === LF ? 2 : 1;
      start = i;
      continue;
    }
    i++;
  }
  value = out;
  if (pos >= n) {
    ended = ENDED_END;
    return;
  }
  const c = text.charCodeAt(pos);
  if (c === COMMA) {
    pos++;
    ended = ENDED_COMMA;
    return;
  }
  if (c === LF) {
    pos++;
    line++;
    ended = ENDED_BREAK;
    return;
  }
  if (c === CR && text.charCodeAt(pos + 1) === LF) {
    pos += 2;
    line++;
    ended = ENDED_BREAK;
    return;
  }
  // What follows the closing quote is appended as it stands, up to the next comma or line break.
  readUnquoted(out);
  if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
}
