//! The byte-level CSV reader of csv-quickread, compiled to WebAssembly.
//!
//! It reads one case's CSV text straight out of its JSON-escaped form (the bytes between the quotes
//! of the case's "text" string in cases.json) and writes that case's answer, the JSON object
//! {columns, rows, errors}, as csv-reader 1.0.0 would give it. Field bytes are copied as they are
//! scanned: a JSON escape such as \t or é means the same thing in the output, so only the
//! changes csv-reader makes are made (a doubled quote read as one, a CR inside quotes read as LF,
//! a stray CR dropped). The same algorithm as rawcsv.js, which stays as the fallback.
#![no_std]

use core::arch::wasm32::{u8x16_bitmask, u8x16_eq, u8x16_splat, v128, v128_load, v128_or, v128_store};
use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

const BS: u8 = b'\\';
const DQ: u8 = b'"';
const COMMA: u8 = b',';

// Logical character classes of one token of a JSON string's contents.
const C_OTHER: u8 = 0;
const C_COMMA: u8 = 1;
const C_LF: u8 = 2;
const C_CR: u8 = 3;
const C_QUOTE: u8 = 4;
const C_END: u8 = 5;

// Results other than a byte count.
const E_OUT_FULL: i32 = -1;
const E_ERR_FULL: i32 = -2;
const E_FIELDS_FULL: i32 = -3;
const E_BROKEN: i32 = -4;

/// Copies bytes from src[p..te) to out[o..] up to the first byte equal to a or b (16 at a time
/// while it can); returns the new (p, o). It may write up to 15 bytes past the copied ones, which
/// the callers leave room for.
#[inline(always)]
unsafe fn copy_until2(src: *const u8, mut p: usize, te: usize, out: *mut u8, mut o: usize, a: u8, b: u8) -> (usize, usize) {
    let va = u8x16_splat(a);
    let vb = u8x16_splat(b);
    while p + 16 <= te {
        let v = v128_load(src.add(p) as *const v128);
        v128_store(out.add(o) as *mut v128, v);
        let m = u8x16_bitmask(v128_or(u8x16_eq(v, va), u8x16_eq(v, vb)));
        if m == 0 {
            p += 16;
            o += 16;
            continue;
        }
        let k = m.trailing_zeros() as usize;
        return (p + k, o + k);
    }
    while p < te {
        let c = *src.add(p);
        if c == a || c == b {
            break;
        }
        *out.add(o) = c;
        o += 1;
        p += 1;
    }
    (p, o)
}

/// Index of the first byte in src[p..te) equal to a or b, or te.
#[inline(always)]
unsafe fn find2(src: *const u8, mut p: usize, te: usize, a: u8, b: u8) -> usize {
    let va = u8x16_splat(a);
    let vb = u8x16_splat(b);
    while p + 16 <= te {
        let v = v128_load(src.add(p) as *const v128);
        let m = u8x16_bitmask(v128_or(u8x16_eq(v, va), u8x16_eq(v, vb)));
        if m != 0 {
            return p + m.trailing_zeros() as usize;
        }
        p += 16;
    }
    while p < te {
        let c = *src.add(p);
        if c == a || c == b {
            return p;
        }
        p += 1;
    }
    te
}

struct Reader {
    src: *const u8,
    te: usize,
    out: *mut u8,
    o: usize,
    err: *mut u8,
    eo: usize,
    err_cap: usize,
    fields: *mut u32,
    fields_cap: usize,
    line: u32,
    rec_line: u32,
    rec_row: i64,
    odd_found: isize,
    odd_scan: usize,
    p: usize,
    fail: i32,
}

#[inline(always)]
fn hexval(b: u8) -> i32 {
    match b {
        b'0'..=b'9' => (b - b'0') as i32,
        b'a'..=b'f' => (b - b'a' + 10) as i32,
        b'A'..=b'F' => (b - b'A' + 10) as i32,
        _ => -1,
    }
}

impl Reader {
    #[inline(always)]
    fn at(&self, i: usize) -> u8 {
        unsafe { *self.src.add(i) }
    }

    #[inline(always)]
    fn put(&mut self, b: u8) {
        unsafe { *self.out.add(self.o) = b };
        self.o += 1;
    }

    fn hex4(&self, i: usize) -> i32 {
        if i + 4 > self.te {
            return -1;
        }
        let mut v = 0;
        for k in 0..4 {
            let d = hexval(self.at(i + k));
            if d < 0 {
                return -1;
            }
            v = v * 16 + d;
        }
        v
    }

    /// Class and byte length of the escape token at i (src[i] is a backslash).
    #[inline(always)]
    fn esc_class(&self, i: usize) -> (u8, usize) {
        match self.at(i + 1) {
            b'n' => (C_LF, 2),
            b'r' => (C_CR, 2),
            b'"' => (C_QUOTE, 2),
            b'u' => {
                let c = match self.hex4(i + 2) {
                    10 => C_LF,
                    13 => C_CR,
                    34 => C_QUOTE,
                    44 => C_COMMA,
                    _ => C_OTHER,
                };
                (c, 6)
            }
            _ => (C_OTHER, 2),
        }
    }

    /// Class and byte length of any token at i (i < te).
    #[inline(always)]
    fn class(&self, i: usize) -> (u8, usize) {
        let b = self.at(i);
        if b == BS {
            self.esc_class(i)
        } else if b == COMMA {
            (C_COMMA, 1)
        } else {
            (C_OTHER, 1)
        }
    }

    fn err_ascii(&mut self, s: &[u8]) {
        for &b in s {
            unsafe { *self.err.add(self.eo) = b };
            self.eo += 1;
        }
    }

    fn err_int(&mut self, v: u64) {
        let mut buf = [0u8; 20];
        let mut n = 0;
        let mut x = v;
        loop {
            buf[n] = b'0' + (x % 10) as u8;
            n += 1;
            x /= 10;
            if x == 0 {
                break;
            }
        }
        while n > 0 {
            n -= 1;
            unsafe { *self.err.add(self.eo) = buf[n] };
            self.eo += 1;
        }
    }

    /// Opens an error record {code, line, row (, ...)}; the caller closes it with '}'.
    fn open_error(&mut self, code: &[u8], extra: usize) -> bool {
        if self.eo + 128 + extra > self.err_cap {
            self.fail = E_ERR_FULL;
            return false;
        }
        if self.eo > 0 {
            self.err_ascii(b",");
        }
        self.err_ascii(b"{\"code\":\"");
        self.err_ascii(code);
        self.err_ascii(b"\",\"line\":");
        self.err_int(self.rec_line as u64);
        self.err_ascii(b",\"row\":");
        if self.rec_row < 0 {
            self.err_ascii(b"null");
        } else {
            self.err_int(self.rec_row as u64);
        }
        true
    }

    fn simple_error(&mut self, code: &[u8]) {
        if self.open_error(code, 0) {
            self.err_ascii(b"}");
        }
    }

    /// Copies unquoted field bytes from p to the next comma or line break, dropping stray CRs.
    /// The field's opening quote is already written. Leaves self.p after the field.
    fn plain_run(&mut self, mut p: usize) -> u8 {
        let te = self.te;
        loop {
            // The hot loop: local copies of the pointers, so writes to the output cannot be taken
            // to change them.
            {
                let (np, no) = unsafe { copy_until2(self.src, p, te, self.out, self.o, COMMA, BS) };
                p = np;
                self.o = no;
            }
            if p >= te {
                self.p = p;
                return C_END;
            }
            if self.at(p) == COMMA {
                self.p = p + 1;
                return C_COMMA;
            }
            let (c, l) = self.esc_class(p);
            if c == C_OTHER || c == C_QUOTE {
                for k in 0..l {
                    let b = self.at(p + k);
                    self.put(b);
                }
                p += l;
                continue;
            }
            if c == C_COMMA {
                self.p = p + l;
                return C_COMMA;
            }
            if c == C_LF {
                self.p = p + l;
                self.line += 1;
                return C_LF;
            }
            // CR: the end of the record when LF follows, else a stray CR, dropped.
            if p + l < te {
                let (c2, l2) = self.class(p + l);
                if c2 == C_LF {
                    self.p = p + l + l2;
                    self.line += 1;
                    return C_LF;
                }
            }
            self.simple_error(b"stray_cr");
            p += l;
        }
    }

    /// Whether an odd-length run of quote tokens starts after the run open..run_end: only such a
    /// run can close a quoted field whose own run pairs up. Forward-only, so linear in all.
    fn odd_run_after(&mut self, open: usize, run_end: usize) -> bool {
        if self.odd_found > open as isize {
            return true;
        }
        let te = self.te;
        let mut i = if self.odd_scan > run_end { self.odd_scan } else { run_end };
        while i < te {
            if self.at(i) != BS {
                i = unsafe { find2(self.src, i, te, BS, BS) };
                continue;
            }
            let (mut c, mut l) = self.esc_class(i);
            if c != C_QUOTE {
                i += l;
                continue;
            }
            let start = i;
            let mut run = 0u32;
            while c == C_QUOTE {
                i += l;
                run += 1;
                if i >= te {
                    break;
                }
                let t = self.class(i);
                c = t.0;
                l = t.1;
            }
            if run & 1 == 1 {
                self.odd_found = start as isize;
                self.odd_scan = i;
                return true;
            }
        }
        self.odd_scan = te;
        false
    }

    /// A field opening with a quote token at p (its opening quote byte already written).
    fn quoted_field(&mut self, p: usize) -> u8 {
        let te = self.te;
        let open = p;
        let (_, ql) = self.esc_class(open);
        let mut run_end = open + ql;
        let mut run = 1u32;
        while run_end < te && self.at(run_end) == BS {
            let (c, l) = self.esc_class(run_end);
            if c != C_QUOTE {
                break;
            }
            run_end += l;
            run += 1;
        }
        if run & 1 == 1 && !self.odd_run_after(open, run_end) {
            // The quote never closes: a literal character, and the rest is read as unquoted.
            self.simple_error(b"unterminated_quote");
            for k in 0..ql {
                let b = self.at(open + k);
                self.put(b);
            }
            return self.plain_run(open + ql);
        }
        let mut i = open + ql;
        loop {
            if i >= te {
                self.fail = E_BROKEN;
                self.p = te;
                return C_END;
            }
            if self.at(i) != BS {
                let (ni, no) = unsafe { copy_until2(self.src, i, te, self.out, self.o, BS, BS) };
                i = ni;
                self.o = no;
                continue;
            }
            let (c, l) = self.esc_class(i);
            if c == C_QUOTE {
                if i + l < te && self.at(i + l) == BS {
                    let (c2, l2) = self.esc_class(i + l);
                    if c2 == C_QUOTE {
                        // A doubled quote is one quote.
                        self.put(BS);
                        self.put(DQ);
                        i += l + l2;
                        continue;
                    }
                }
                i += l;
                break;
            }
            if c == C_CR {
                // CRLF and a lone CR inside quotes are each one LF.
                self.put(BS);
                self.put(b'n');
                self.line += 1;
                i += l;
                if i < te && self.at(i) == BS {
                    let (c2, l2) = self.esc_class(i);
                    if c2 == C_LF {
                        i += l2;
                    }
                }
                continue;
            }
            if c == C_LF {
                self.line += 1;
            }
            for k in 0..l {
                let b = self.at(i + k);
                self.put(b);
            }
            i += l;
        }
        if i >= te {
            self.p = i;
            return C_END;
        }
        let (c1, l1) = self.class(i);
        if c1 == C_COMMA {
            self.p = i + l1;
            return C_COMMA;
        }
        if c1 == C_LF {
            self.p = i + l1;
            self.line += 1;
            return C_LF;
        }
        if c1 == C_CR && i + l1 < te {
            let (c2, l2) = self.class(i + l1);
            if c2 == C_LF {
                self.p = i + l1 + l2;
                self.line += 1;
                return C_LF;
            }
        }
        // What follows the closing quote is appended as it stands, up to the next comma or line
        // break; quote_junk is recorded when the field ends, after any stray_cr inside the junk.
        let before = self.o;
        let ended = self.plain_run(i);
        if self.o > before {
            self.simple_error(b"quote_junk");
        }
        ended
    }

    /// Skips lines with no characters (LF or CRLF).
    fn skip_blank(&mut self, mut p: usize) -> usize {
        let te = self.te;
        while p < te {
            if self.at(p) != BS {
                return p;
            }
            let (c, l) = self.esc_class(p);
            if c == C_LF {
                p += l;
                self.line += 1;
            } else if c == C_CR && p + l < te {
                let (c2, l2) = self.class(p + l);
                if c2 != C_LF {
                    return p;
                }
                p += l + l2;
                self.line += 1;
            } else {
                return p;
            }
        }
        p
    }

    /// Reads one record from p and writes it as a JSON array; returns its field count and
    /// whether it is a single empty unquoted field (no record).
    fn read_record(&mut self, mut p: usize) -> (usize, bool) {
        let te = self.te;
        self.put(b'[');
        let mut nf = 0usize;
        let mut ended = C_COMMA;
        let mut quoted = false;
        while ended == C_COMMA {
            if nf > 0 {
                self.put(COMMA);
            }
            if nf == self.fields_cap {
                self.fail = E_FIELDS_FULL;
                self.p = te;
                return (nf, false);
            }
            unsafe { *self.fields.add(nf) = self.o as u32 };
            nf += 1;
            self.put(DQ);
            if p < te && self.at(p) == BS && self.esc_class(p).0 == C_QUOTE {
                quoted = true;
                ended = self.quoted_field(p);
            } else {
                quoted = false;
                ended = self.plain_run(p);
            }
            self.put(DQ);
            p = self.p;
        }
        self.p = p;
        let first = unsafe { *self.fields } as usize;
        (nf, nf == 1 && !quoted && self.o == first + 2)
    }
}

/// Writes the answer of the case whose JSON-escaped text is src[ts..te) at memory[out..]:
/// {"columns":...,"rows":[...],"errors":[...]}. Returns the number of bytes written, or a negative
/// code when a buffer is too small or the text is not what was expected (the caller falls back).
#[no_mangle]
pub extern "C" fn answer_case(
    src: u32,
    ts: u32,
    te: u32,
    header: u32,
    out: u32,
    out_cap: u32,
    err: u32,
    err_cap: u32,
    fields: u32,
    fields_cap: u32,
) -> i32 {
    let mut r = Reader {
        src: src as usize as *const u8,
        te: te as usize,
        out: out as usize as *mut u8,
        o: 0,
        err: err as usize as *mut u8,
        eo: 0,
        err_cap: err_cap as usize,
        fields: fields as usize as *mut u32,
        fields_cap: fields_cap as usize,
        line: 1,
        rec_line: 1,
        rec_row: -1,
        odd_found: -1,
        odd_scan: ts as usize,
        p: 0,
        fail: 0,
    };
    let out_cap = out_cap as usize;
    let header = header != 0;
    let te = te as usize;
    let mut p = ts as usize;
    if te - p >= 3 && r.at(p) == 0xef && r.at(p + 1) == 0xbb && r.at(p + 2) == 0xbf {
        p += 3;
    } else if te - p >= 6 && r.at(p) == BS && r.at(p + 1) == b'u' && r.hex4(p + 2) == 0xfeff {
        p += 6;
    }
    let head: &[u8] = if header { b"{\"columns\":" } else { b"{\"columns\":null,\"rows\":[" };
    if out_cap < 64 {
        return E_OUT_FULL;
    }
    for &b in head {
        r.put(b);
    }
    let mut row_count: u64 = 0;
    let mut width: usize = usize::MAX;
    let mut have_columns = !header;
    loop {
        p = r.skip_blank(p);
        if p >= te {
            break;
        }
        let is_header = !have_columns;
        r.rec_line = r.line;
        r.rec_row = if is_header { -1 } else { row_count as i64 };
        let w = if width == usize::MAX { 0 } else { width };
        if r.o + 3 * (te - p) + 3 * w + 96 > out_cap {
            return E_OUT_FULL;
        }
        let before = r.o;
        if !is_header && row_count > 0 {
            r.put(COMMA);
        }
        let (nf, only_empty) = r.read_record(p);
        if r.fail != 0 {
            return r.fail;
        }
        p = r.p;
        if only_empty {
            // A line that held only stray CRs is no record (its errors stay).
            r.o = before;
            continue;
        }
        if width == usize::MAX {
            width = nf;
        }
        if is_header {
            r.put(b']');
            have_columns = true;
            for &b in b",\"rows\":[" {
                r.put(b);
            }
            continue;
        }
        if nf < width {
            for _ in nf..width {
                r.put(COMMA);
                r.put(DQ);
                r.put(DQ);
            }
            if r.open_error(b"short_row", 0) {
                r.err_ascii(b",\"fields\":");
                r.err_int(nf as u64);
                r.err_ascii(b"}");
            }
        } else if nf > width {
            let cut = unsafe { *r.fields.add(width) } as usize;
            let len = r.o - cut;
            if r.open_error(b"long_row", len) {
                r.err_ascii(b",\"extra\":[");
                unsafe { core::ptr::copy_nonoverlapping(r.out.add(cut), r.err.add(r.eo), len) };
                r.eo += len;
                r.err_ascii(b"]}");
            }
            r.o = cut - 1;
        }
        if r.fail != 0 {
            return r.fail;
        }
        r.put(b']');
        row_count += 1;
    }
    if r.o + r.eo + 32 > out_cap {
        return E_OUT_FULL;
    }
    let tail: &[u8] = if have_columns { b"],\"errors\":[" } else { b"[],\"rows\":[],\"errors\":[" };
    for &b in tail {
        r.put(b);
    }
    unsafe { core::ptr::copy_nonoverlapping(r.err, r.out.add(r.o), r.eo) };
    r.o += r.eo;
    r.put(b']');
    r.put(b'}');
    r.o as i32
}

/// Index (relative to src) of the closing quote of the JSON string whose opening quote is at pos,
/// or -1 when the string does not end before len.
#[no_mangle]
pub extern "C" fn string_end(src: u32, pos: u32, len: u32) -> i32 {
    let src = src as usize as *const u8;
    let len = len as usize;
    let mut i = pos as usize + 1;
    while i < len {
        let b = unsafe { *src.add(i) };
        if b == DQ {
            return i as i32;
        }
        i += if b == BS { 2 } else { 1 };
    }
    -1
}

// ---- The outer JSON: an array of {id, input: {text, header}} ----

struct Json {
    src: *const u8,
    len: usize,
    j: usize,
}

impl Json {
    #[inline(always)]
    fn at(&self, i: usize) -> u8 {
        if i < self.len {
            unsafe { *self.src.add(i) }
        } else {
            0
        }
    }

    fn ws(&mut self) {
        while matches!(self.at(self.j), b' ' | b'\n' | b'\r' | b'\t') {
            self.j += 1;
        }
    }

    /// Index of the closing quote of the string whose opening quote is at j, or None.
    fn string_end(&self) -> Option<usize> {
        let mut i = self.j + 1;
        while i < self.len {
            i = unsafe { find2(self.src, i, self.len, DQ, BS) };
            if i >= self.len {
                return None;
            }
            if self.at(i) == DQ {
                return Some(i);
            }
            i += 2;
        }
        None
    }

    /// A key without escapes (a key with one is left to the JavaScript locator).
    fn key(&mut self) -> Option<(usize, usize)> {
        if self.at(self.j) != DQ {
            return None;
        }
        let end = self.string_end()?;
        let start = self.j + 1;
        for i in start..end {
            if self.at(i) == BS {
                return None;
            }
        }
        self.j = end + 1;
        Some((start, end))
    }

    fn key_is(&self, k: (usize, usize), name: &[u8]) -> bool {
        if k.1 - k.0 != name.len() {
            return false;
        }
        for (n, &b) in name.iter().enumerate() {
            if self.at(k.0 + n) != b {
                return false;
            }
        }
        true
    }

    fn skip_value(&mut self) -> bool {
        self.ws();
        let b = self.at(self.j);
        if b == DQ {
            match self.string_end() {
                Some(end) => {
                    self.j = end + 1;
                    return true;
                }
                None => return false,
            }
        }
        if b == b'{' || b == b'[' {
            let mut depth = 0i32;
            while self.j < self.len {
                let c = self.at(self.j);
                if c == DQ {
                    match self.string_end() {
                        Some(end) => {
                            self.j = end + 1;
                            continue;
                        }
                        None => return false,
                    }
                }
                if c == b'{' || c == b'[' {
                    depth += 1;
                } else if c == b'}' || c == b']' {
                    depth -= 1;
                    if depth == 0 {
                        self.j += 1;
                        return true;
                    }
                }
                self.j += 1;
            }
            return false;
        }
        let start = self.j;
        while self.j < self.len && !matches!(self.at(self.j), b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t') {
            self.j += 1;
        }
        self.j > start
    }

    /// Walks one object's members; `member` reads each value. False on any unexpected shape.
    fn object(&mut self, member: &mut dyn FnMut(&mut Json, (usize, usize)) -> bool) -> bool {
        self.ws();
        if self.at(self.j) != b'{' {
            return false;
        }
        self.j += 1;
        self.ws();
        if self.at(self.j) == b'}' {
            self.j += 1;
            return true;
        }
        loop {
            self.ws();
            let k = match self.key() {
                Some(k) => k,
                None => return false,
            };
            self.ws();
            if self.at(self.j) != b':' {
                return false;
            }
            self.j += 1;
            self.ws();
            if !member(self, k) {
                return false;
            }
            self.ws();
            match self.at(self.j) {
                b',' => self.j += 1,
                b'}' => {
                    self.j += 1;
                    return true;
                }
                _ => return false,
            }
        }
    }
}

/// Finds each case's text in cases.json (src[0..len)) and writes, per case, three u32s at `out`:
/// the text's first byte, its closing quote and 1 when header is true. Returns the number of cases,
/// or -1 when the file is shaped otherwise (the JavaScript locator then takes it).
#[no_mangle]
pub extern "C" fn locate_cases(src: u32, len: u32, out: u32, max: u32) -> i32 {
    let mut p = Json { src: src as usize as *const u8, len: len as usize, j: 0 };
    let out = out as usize as *mut u32;
    p.ws();
    if p.at(p.j) != b'[' {
        return -1;
    }
    p.j += 1;
    p.ws();
    if p.at(p.j) == b']' {
        return 0;
    }
    let mut count = 0usize;
    loop {
        if count as u32 >= max {
            return -1;
        }
        let mut text: Option<(usize, usize)> = None;
        let mut header = false;
        let mut has_input = false;
        let ok = p.object(&mut |p: &mut Json, k| {
            if !p.key_is(k, b"input") {
                return p.skip_value();
            }
            has_input = true;
            text = None;
            header = false;
            p.object(&mut |p: &mut Json, k| {
                if p.key_is(k, b"text") {
                    if p.at(p.j) != DQ {
                        // A text that is not a string is left to the JavaScript readers.
                        return false;
                    }
                    match p.string_end() {
                        Some(end) => {
                            text = Some((p.j + 1, end));
                            p.j = end + 1;
                            true
                        }
                        None => false,
                    }
                } else if p.key_is(k, b"header") {
                    let start = p.j;
                    if !p.skip_value() {
                        return false;
                    }
                    header = p.j - start == 4
                        && p.at(start) == b't'
                        && p.at(start + 1) == b'r'
                        && p.at(start + 2) == b'u'
                        && p.at(start + 3) == b'e';
                    true
                } else {
                    p.skip_value()
                }
            })
        });
        if !ok || !has_input {
            return -1;
        }
        let (ts, te) = match text {
            Some(t) => t,
            None => return -1,
        };
        unsafe {
            *out.add(count * 3) = ts as u32;
            *out.add(count * 3 + 1) = te as u32;
            *out.add(count * 3 + 2) = header as u32;
        }
        count += 1;
        p.ws();
        match p.at(p.j) {
            b',' => p.j += 1,
            b']' => return count as i32,
            _ => return -1,
        }
    }
}

/// Reads the next case of cases.json from src[pos..len), the bytes in memory so far: with `first`,
/// the array's opening bracket comes first. Writes the case's text start, its closing quote, 1 when
/// header is true, 1 when a case was read and 1 when the array ended after it, as five u32s at out
/// (positions relative to src). Returns the position after the case and its separator, or -1 when
/// the bytes so far do not hold a whole case (more input may, or the file is shaped otherwise).
#[no_mangle]
pub extern "C" fn locate_next(src: u32, len: u32, pos: u32, first: u32, out: u32) -> i32 {
    let mut p = Json { src: src as usize as *const u8, len: len as usize, j: pos as usize };
    let out = out as usize as *mut u32;
    let put = |k: usize, v: u32| unsafe { *out.add(k) = v };
    put(3, 0);
    put(4, 0);
    p.ws();
    if first != 0 {
        if p.at(p.j) != b'[' {
            return -1;
        }
        p.j += 1;
        p.ws();
        if p.j >= p.len {
            return -1;
        }
        if p.at(p.j) == b']' {
            put(4, 1);
            return (p.j + 1) as i32;
        }
    }
    let mut text: Option<(usize, usize)> = None;
    let mut header = false;
    let mut has_input = false;
    let ok = p.object(&mut |p: &mut Json, k| {
        if !p.key_is(k, b"input") {
            return p.skip_value();
        }
        has_input = true;
        text = None;
        header = false;
        p.object(&mut |p: &mut Json, k| {
            if p.key_is(k, b"text") {
                if p.at(p.j) != DQ {
                    return false;
                }
                match p.string_end() {
                    Some(end) => {
                        text = Some((p.j + 1, end));
                        p.j = end + 1;
                        true
                    }
                    None => false,
                }
            } else if p.key_is(k, b"header") {
                let start = p.j;
                if !p.skip_value() || p.j >= p.len {
                    return false;
                }
                header = p.j - start == 4
                    && p.at(start) == b't'
                    && p.at(start + 1) == b'r'
                    && p.at(start + 2) == b'u'
                    && p.at(start + 3) == b'e';
                true
            } else {
                p.skip_value() && p.j < p.len
            }
        })
    });
    if !ok || !has_input {
        return -1;
    }
    let (ts, te) = match text {
        Some(t) => t,
        None => return -1,
    };
    p.ws();
    let end = match p.at(p.j) {
        b',' => 0,
        b']' => 1,
        _ => return -1,
    };
    put(0, ts as u32);
    put(1, te as u32);
    put(2, header as u32);
    put(3, 1);
    put(4, end);
    (p.j + 1) as i32
}
