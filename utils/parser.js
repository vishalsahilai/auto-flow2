/* ============================================================================
 * utils/parser.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * Prompt parsing (two blank lines = new prompt) plus dependency-free .txt and
 * .pdf import. No remote libraries — MV3 forbids remote code — so PDF text
 * extraction is implemented here using the browser's native DecompressionStream
 * for FlateDecode plus a content-stream text operator parser.
 *
 * Exposes: globalThis.APParser
 * ==========================================================================*/

var APParser = (function () {
  'use strict';

  const SEP = /\n[ \t]*\n[ \t]*\n/;          // TWO blank lines (v13 behaviour)
  const PARA_BREAK = '\n\n\n';               // what we emit to mean "new prompt"

  /* ==================================================================== */
  /*  PROMPT PARSING                                                      */
  /* ==================================================================== */

  /**
   * Split raw text into prompts on TWO blank lines.
   * ONE blank line stays inside the same prompt.
   * Prompt text is otherwise returned byte-for-byte (only outer whitespace
   * is trimmed) — prompts are never rewritten, reworded or padded.
   */
  function parsePrompts(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    const normalised = normaliseNewlines(raw);
    return normalised
      .split(SEP)
      .map(function (b) { return b.replace(/^[\r\n]+|[ \t\r\n]+$/g, ''); })
      .filter(function (p) { return p.length > 0; });
  }

  function normaliseNewlines(s) {
    return s
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\u00a0/g, ' ')          // non-breaking space -> plain space
      .replace(/[\u2028\u2029]/g, '\n'); // unicode line/paragraph separators
  }

  /** Re-join prompts so the textarea round-trips exactly. */
  function joinPrompts(list) {
    return (list || []).join(PARA_BREAK);
  }

  /* ==================================================================== */
  /*  FILE IMPORT                                                         */
  /* ==================================================================== */

  function readAsText(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(normaliseNewlines(String(fr.result || ''))); };
      fr.onerror = function () { reject(new Error('Could not read "' + file.name + '".')); };
      fr.readAsText(file, 'UTF-8');
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(new Error('Could not read "' + file.name + '".')); };
      fr.readAsArrayBuffer(file);
    });
  }

  /**
   * Import any supported file and return { text, prompts, kind }.
   * Throws Error with a human-readable, actionable message on failure.
   */
  async function importFile(file) {
    const name = (file && file.name ? file.name : '').toLowerCase();
    const isPdf = name.endsWith('.pdf') || file.type === 'application/pdf';

    let text;
    if (isPdf) {
      const buf = await readAsArrayBuffer(file);
      text = await extractPdfText(buf);
      // A PDF has no real "blank lines" — extractPdfText reconstructs
      // paragraph breaks from vertical gaps and emits PARA_BREAK for them.
    } else {
      text = await readAsText(file);
      if (looksBinary(text)) {
        throw new Error(
          'This file is not readable UTF-8 text. If it is a PDF, rename it with ' +
          'a .pdf extension so it is parsed as one, or export it as .txt.'
        );
      }
    }

    const prompts = parsePrompts(text);
    if (!prompts.length) {
      throw new Error('No prompts found in "' + file.name + '". Separate prompts with TWO blank lines.');
    }
    return { text: text, prompts: prompts, kind: isPdf ? 'pdf' : 'txt' };
  }

  function looksBinary(s) {
    if (!s) return true;
    const sample = s.slice(0, 4000);
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) bad++;
    }
    return bad / Math.max(1, sample.length) > 0.05;
  }

  /* ==================================================================== */
  /*  PDF TEXT EXTRACTION                                                 */
  /* ==================================================================== */

  async function extractPdfText(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);

    if (!hasPdfHeader(bytes)) {
      throw new Error('That file is not a valid PDF (missing %PDF header).');
    }
    if (indexOfBytes(bytes, strToBytes('/Encrypt'), 0) !== -1) {
      throw new Error(
        'This PDF is encrypted or password-protected, so its text cannot be read. ' +
        'Please remove the protection, or copy the prompts into a .txt file.'
      );
    }

    const streams = await collectContentStreams(bytes);
    if (!streams.length) {
      throw new Error(
        'No readable text streams were found in this PDF. It is most likely a scan ' +
        '(images only). Run OCR on it, or paste the prompts in as text.'
      );
    }

    /* Collect positioned text lines from every content stream. */
    let lines = [];
    for (let i = 0; i < streams.length; i++) {
      lines = lines.concat(parseContentStream(streams[i], i));
    }
    lines = lines.filter(function (l) { return l.text.trim().length > 0; });

    if (!lines.length) {
      throw new Error(
        'This PDF contains no extractable text (its fonts may be fully embedded ' +
        'as outlines). Please export the prompts as a .txt file instead.'
      );
    }

    const text = linesToText(lines);

    if (!isReadable(text)) {
      throw new Error(
        'The text in this PDF could not be decoded into readable characters ' +
        '(it likely uses embedded CID fonts without a Unicode map). ' +
        'Please export the prompts as a .txt file and import that instead.'
      );
    }
    return normaliseNewlines(text);
  }

  function hasPdfHeader(bytes) {
    const head = strToBytes('%PDF-');
    return indexOfBytes(bytes.subarray(0, 1024), head, 0) !== -1;
  }

  /** Pull out and inflate every stream that looks like a page content stream. */
  async function collectContentStreams(bytes) {
    const out = [];
    const streamKw = strToBytes('stream');
    const endKw = strToBytes('endstream');

    let pos = 0;
    while (pos < bytes.length) {
      const sIdx = indexOfBytes(bytes, streamKw, pos);
      if (sIdx === -1) break;

      // Guard: must be the keyword "stream", not the tail of "endstream".
      const prevByte = sIdx > 0 ? bytes[sIdx - 1] : 32;
      if (prevByte === 0x64 /* d */) { pos = sIdx + 6; continue; }

      // Data begins after the EOL that follows the keyword.
      let dStart = sIdx + streamKw.length;
      if (bytes[dStart] === 0x0d) dStart++;
      if (bytes[dStart] === 0x0a) dStart++;

      const eIdx = indexOfBytes(bytes, endKw, dStart);
      if (eIdx === -1) break;

      let dEnd = eIdx;
      if (bytes[dEnd - 1] === 0x0a) dEnd--;
      if (bytes[dEnd - 1] === 0x0d) dEnd--;

      // The dictionary is the bytes immediately before the "stream" keyword.
      const dictStart = Math.max(0, sIdx - 1600);
      const dict = bytesToLatin1(bytes.subarray(dictStart, sIdx));

      pos = eIdx + endKw.length;

      // Skip anything that clearly isn't text: images and other binary filters.
      if (/\/Subtype\s*\/Image/.test(dict)) continue;
      if (/\/(DCTDecode|JPXDecode|CCITTFaxDecode|JBIG2Decode|RunLengthDecode)/.test(dict)) continue;

      const raw = bytes.subarray(dStart, dEnd);
      let data = null;

      if (/\/FlateDecode/.test(dict)) {
        data = await inflate(raw);
      } else if (!/\/Filter/.test(dict)) {
        data = raw;                        // uncompressed content stream
      } else if (/\/ASCIIHexDecode/.test(dict)) {
        data = asciiHexDecode(raw);
      }
      if (!data || !data.length) continue;

      const txt = bytesToLatin1(data);

      // A page content stream always contains a BT…ET text block with a
      // text-showing operator. Everything else (fonts, metadata) is skipped.
      if (txt.indexOf('BT') !== -1 && /\b(Tj|TJ)\b|\)\s*'|\)\s*"/.test(txt)) {
        out.push(txt);
      }
    }
    return out;
  }

  async function inflate(bytes) {
    if (typeof DecompressionStream === 'undefined') return null;
    const formats = ['deflate', 'deflate-raw'];
    for (let i = 0; i < formats.length; i++) {
      try {
        const ds = new DecompressionStream(formats[i]);
        const stream = new Blob([bytes]).stream().pipeThrough(ds);
        const buf = await new Response(stream).arrayBuffer();
        if (buf && buf.byteLength) return new Uint8Array(buf);
      } catch (e) { /* try the next format */ }
    }
    return null;
  }

  function asciiHexDecode(bytes) {
    const s = bytesToLatin1(bytes).replace(/[^0-9a-fA-F]/g, '');
    const n = Math.floor(s.length / 2);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  /* -------------------------------------------------------------------- */
  /*  CONTENT-STREAM TEXT OPERATORS                                       */
  /* -------------------------------------------------------------------- */
  /**
   * Walks a content stream and returns positioned lines:
   *   [{ page, y, order, text }]
   * Tracks Tm / Td / TD / T* / TL so that vertical gaps survive — that is what
   * lets us rebuild "two blank lines" from a PDF's absolute layout.
   */
  function parseContentStream(src, pageIndex) {
    const lines = [];
    let stack = [];          // pending numeric/string operands
    let y = 0, leading = 0;
    let cur = '';            // text accumulated on the current line
    let curY = null;
    let order = 0;

    function flush() {
      if (cur.length) {
        lines.push({ page: pageIndex, y: curY === null ? y : curY, order: order++, text: cur });
      }
      cur = '';
      curY = null;
    }
    function newline(newY) {
      flush();
      y = newY;
    }
    function put(s) {
      if (!s) return;
      if (curY === null) curY = y;
      cur += s;
    }

    let i = 0;
    const n = src.length;

    while (i < n) {
      const ch = src[i];

      /* ---- literal string ( ... ) ---- */
      if (ch === '(') {
        const r = readLiteralString(src, i);
        stack.push({ t: 's', v: r.value });
        i = r.next;
        continue;
      }
      /* ---- hex string < ... >  (but not the dict token "<<") ---- */
      if (ch === '<' && src[i + 1] !== '<') {
        const end = src.indexOf('>', i + 1);
        if (end === -1) break;
        stack.push({ t: 's', v: decodeHexString(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
      /* ---- skip dictionaries ---- */
      if (ch === '<' && src[i + 1] === '<') { i += 2; continue; }
      if (ch === '>' && src[i + 1] === '>') { i += 2; continue; }

      /* ---- array ---- */
      if (ch === '[') { stack.push({ t: '[' }); i++; continue; }
      if (ch === ']') {
        // Collapse the array back into one operand list marker.
        const items = [];
        while (stack.length && stack[stack.length - 1].t !== '[') items.unshift(stack.pop());
        if (stack.length) stack.pop();
        stack.push({ t: 'arr', v: items });
        i++;
        continue;
      }

      /* ---- comment ---- */
      if (ch === '%') {
        while (i < n && src[i] !== '\n' && src[i] !== '\r') i++;
        continue;
      }

      /* ---- number ---- */
      if (ch === '-' || ch === '+' || ch === '.' || (ch >= '0' && ch <= '9')) {
        let j = i + 1;
        while (j < n && /[0-9.eE+\-]/.test(src[j])) j++;
        const num = parseFloat(src.slice(i, j));
        stack.push({ t: 'n', v: isNaN(num) ? 0 : num });
        i = j;
        continue;
      }

      /* ---- whitespace ---- */
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === '\f' || ch === '\0') { i++; continue; }

      /* ---- name /Foo ---- */
      if (ch === '/') {
        let j = i + 1;
        while (j < n && !/[\s/\[\]<>()%]/.test(src[j])) j++;
        stack.push({ t: 'name', v: src.slice(i + 1, j) });
        i = j;
        continue;
      }

      /* ---- operator ---- */
      let j = i;
      while (j < n && /[A-Za-z*'"0-9]/.test(src[j])) j++;
      if (j === i) { i++; continue; }
      const op = src.slice(i, j);
      i = j;

      switch (op) {
        case 'BT':
          flush(); stack = []; break;

        case 'ET':
          flush(); stack = []; break;

        case 'TL': {
          const a = nums(stack, 1);
          if (a.length) leading = a[0];
          stack = []; break;
        }
        case 'Td': {
          const a = nums(stack, 2);
          if (a.length === 2) { if (a[1] !== 0) newline(y + a[1]); }
          stack = []; break;
        }
        case 'TD': {
          const a = nums(stack, 2);
          if (a.length === 2) { leading = -a[1]; if (a[1] !== 0) newline(y + a[1]); }
          stack = []; break;
        }
        case 'Tm': {
          const a = nums(stack, 6);
          if (a.length === 6) { if (a[5] !== y) newline(a[5]); }
          stack = []; break;
        }
        case 'T*':
          newline(y - leading); stack = []; break;

        case 'Tj': {
          const s = lastString(stack);
          put(s); stack = []; break;
        }
        case "'": {
          newline(y - leading);
          put(lastString(stack)); stack = []; break;
        }
        case '"': {
          newline(y - leading);
          put(lastString(stack)); stack = []; break;
        }
        case 'TJ': {
          // [ (a) -250 (b) ] TJ  — large negative kerns are word gaps.
          const arr = lastArray(stack);
          let s = '';
          for (let k = 0; k < arr.length; k++) {
            const it = arr[k];
            if (it.t === 's') s += it.v;
            else if (it.t === 'n' && it.v <= -120) s += ' ';
          }
          put(s); stack = []; break;
        }
        default:
          stack = [];
      }
    }
    flush();
    return lines;
  }

  function nums(stack, count) {
    const out = [];
    for (let i = stack.length - 1; i >= 0 && out.length < count; i--) {
      if (stack[i].t === 'n') out.unshift(stack[i].v);
      else break;
    }
    return out.length === count ? out : [];
  }
  function lastString(stack) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].t === 's') return stack[i].v;
    return '';
  }
  function lastArray(stack) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].t === 'arr') return stack[i].v;
    return [];
  }

  /** PDF literal string with balanced parens, escapes and octal codes. */
  function readLiteralString(src, start) {
    let i = start + 1;
    let depth = 1;
    let out = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        const nx = src[i + 1];
        if (nx === undefined) break;
        if (nx >= '0' && nx <= '7') {
          let oct = '';
          let k = i + 1;
          while (k < src.length && oct.length < 3 && src[k] >= '0' && src[k] <= '7') { oct += src[k]; k++; }
          out += String.fromCharCode(parseInt(oct, 8));
          i = k;
          continue;
        }
        switch (nx) {
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case '(': out += '('; break;
          case ')': out += ')'; break;
          case '\\': out += '\\'; break;
          case '\n': break;                 // line continuation
          case '\r': if (src[i + 2] === '\n') i++; break;
          default: out += nx;
        }
        i += 2;
        continue;
      }
      if (c === '(') { depth++; out += c; i++; continue; }
      if (c === ')') {
        depth--;
        if (depth === 0) { i++; break; }
        out += c; i++; continue;
      }
      out += c;
      i++;
    }
    return { value: out, next: i };
  }

  function decodeHexString(hex) {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    const padded = clean.length % 2 ? clean + '0' : clean;
    const codes = [];
    for (let i = 0; i < padded.length; i += 2) codes.push(parseInt(padded.substr(i, 2), 16));

    // UTF-16BE byte-order mark
    if (codes.length >= 2 && codes[0] === 0xfe && codes[1] === 0xff) {
      let s = '';
      for (let i = 2; i + 1 < codes.length; i += 2) s += String.fromCharCode((codes[i] << 8) | codes[i + 1]);
      return s;
    }
    let s = '';
    for (let i = 0; i < codes.length; i++) s += String.fromCharCode(codes[i]);
    return s;
  }

  /* -------------------------------------------------------------------- */
  /*  LINES -> TEXT (rebuild paragraph breaks from vertical gaps)          */
  /* -------------------------------------------------------------------- */
  function linesToText(lines) {
    // Group by page, then order top-to-bottom (PDF y grows upward).
    const byPage = new Map();
    for (const l of lines) {
      if (!byPage.has(l.page)) byPage.set(l.page, []);
      byPage.get(l.page).push(l);
    }
    const pageKeys = Array.from(byPage.keys()).sort(function (a, b) { return a - b; });

    // Median line gap across the whole document, used as the paragraph
    // threshold. Two blank lines in the source become a much larger gap.
    const gaps = [];
    for (const p of pageKeys) {
      const ls = byPage.get(p).slice().sort(function (a, b) {
        return (b.y - a.y) || (a.order - b.order);
      });
      byPage.set(p, ls);
      for (let i = 1; i < ls.length; i++) {
        const g = ls[i - 1].y - ls[i].y;
        if (g > 0.5 && g < 400) gaps.push(g);
      }
    }
    gaps.sort(function (a, b) { return a - b; });
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const paraGap = median > 0 ? median * 1.65 : Infinity;

    const chunks = [];
    for (const p of pageKeys) {
      const ls = byPage.get(p);
      let block = [];
      for (let i = 0; i < ls.length; i++) {
        if (i > 0) {
          const gap = ls[i - 1].y - ls[i].y;
          if (gap >= paraGap) {
            chunks.push(block.join('\n'));
            block = [];
          }
        }
        block.push(cleanLine(ls[i].text));
      }
      if (block.length) chunks.push(block.join('\n'));
    }

    // Separate detected paragraphs with the "new prompt" marker.
    return chunks
      .map(function (c) { return c.replace(/[ \t]+$/gm, '').trim(); })
      .filter(function (c) { return c.length > 0; })
      .join(PARA_BREAK);
  }

  function cleanLine(s) {
    return s
      .replace(/\u0000/g, '')
      .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u00ad]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+$/g, '')
      .replace(/[ \t]{2,}/g, ' ');
  }

  /** Reject gibberish (undecodable CID glyph codes) rather than generating from it. */
  function isReadable(text) {
    const s = (text || '').replace(/\s/g, '');
    if (s.length < 4) return false;
    let good = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
          (c >= 0x20 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || c >= 0x00c0) good++;
    }
    return good / s.length >= 0.75;
  }

  /* ==================================================================== */
  /*  BYTE HELPERS                                                        */
  /* ==================================================================== */
  function strToBytes(s) {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  }
  function bytesToLatin1(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return s;
  }
  function indexOfBytes(hay, needle, from) {
    const n = needle.length;
    const limit = hay.length - n;
    outer:
    for (let i = from; i <= limit; i++) {
      for (let j = 0; j < n; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  }

  /* ==================================================================== */
  return {
    SEP: SEP,
    PARA_BREAK: PARA_BREAK,
    parsePrompts: parsePrompts,
    joinPrompts: joinPrompts,
    normaliseNewlines: normaliseNewlines,
    importFile: importFile,
    readAsText: readAsText,
    extractPdfText: extractPdfText,
    looksBinary: looksBinary,
    _isReadable: isReadable,
    _linesToText: linesToText,
    _parseContentStream: parseContentStream
  };
})();

if (typeof globalThis !== 'undefined') globalThis.APParser = APParser;
if (typeof module !== 'undefined' && module.exports) module.exports = APParser;
