/*
 * latex2html — convert LaTeX source to HTML.
 *
 * A plain ES module with no dependencies, so it runs unchanged in the browser
 * and in Node. Math is passed to a pluggable renderer (the web app and the CLI
 * use KaTeX); without one, math is kept as escaped TeX source.
 *
 *   import { convert, renderDocument } from './latex2html.js';
 *   const result = convert(source, { renderMath, files });
 *   const page = renderDocument(result);
 */

// Markers used inside intermediate HTML. They never survive into the output.
const PAR = '\u0001';          // paragraph break
const BLOCK_OPEN = '\u0002';   // start of a block-level element
const BLOCK_CLOSE = '\u0003';  // end of a block-level element
const DEFER = '\u0004';        // reference resolved after the whole document is read
const VERB = '\u0005';         // protected verbatim text

const TEXT_RUN = /[^\\{}$~\s\-`'&^_#\u0001-\u0005]+/y;
const CONTROL = /\\([a-zA-Z@]+|[\s\S]?)/y;
const SPLIT_BLOCKS = /(\u0002[^\u0002\u0003]*\u0003|\u0001)/;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ESCAPES[c]);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.pdf', '.eps'];

/* ------------------------------------------------------------------------ */
/* Readers that work on raw LaTeX strings                                    */
/* ------------------------------------------------------------------------ */

function skipSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

// s[i] is '{'. Returns the group's inner text and the index after its '}'.
function readGroup(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') k++;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { text: s.slice(i + 1, k), end: k + 1 };
  }
  return { text: s.slice(i + 1), end: s.length };
}

// An optional [argument], or null if the next non-space character isn't '['.
function readOptional(s, i) {
  const j = skipSpace(s, i);
  if (s[j] !== '[') return null;
  let depth = 0;
  for (let k = j + 1; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') k++;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) return { text: s.slice(j + 1, k), end: k + 1 };
  }
  return null;
}

// A required argument: a {group}, a control sequence, or a single character.
function readArgument(s, i) {
  const j = skipSpace(s, i);
  if (j >= s.length) return { text: '', end: j };
  if (s[j] === '{') return readGroup(s, j);
  if (s[j] === '\\') {
    CONTROL.lastIndex = j;
    const m = CONTROL.exec(s);
    return { text: m[0], end: CONTROL.lastIndex };
  }
  return { text: s[j], end: j + 1 };
}

// Find the \end{name} matching an environment whose body starts at i.
function findEnvEnd(s, i, name) {
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${escapeRe(name)}\\}`, 'g');
  re.lastIndex = i;
  let depth = 1, m;
  while ((m = re.exec(s))) {
    if (m[1] === 'begin') depth++;
    else if (--depth === 0) return { body: s.slice(i, m.index), end: m.index + m[0].length };
  }
  return { body: s.slice(i), end: s.length, unterminated: true };
}

// Split s at matches of a sticky `pattern` that sit outside braces and nested
// environments. Each part records the separator match that preceded it.
function splitTopLevel(s, pattern) {
  const parts = [];
  let depth = 0, env = 0, start = 0, sep = null;
  for (let i = 0; i < s.length;) {
    if (depth === 0 && env === 0) {
      pattern.lastIndex = i;
      const m = pattern.exec(s);
      if (m) {
        parts.push({ sep, text: s.slice(start, i) });
        sep = m;
        i += m[0].length;
        start = i;
        continue;
      }
    }
    const c = s[i];
    if (c === '\\') {
      if (/^\\begin(?![a-zA-Z])/.test(s.slice(i, i + 7))) env++;
      else if (/^\\end(?![a-zA-Z])/.test(s.slice(i, i + 5))) env--;
      i += 2;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  parts.push({ sep, text: s.slice(start) });
  return parts;
}

function findUnescaped(s, ch, from) {
  for (let k = s.indexOf(ch, from); k >= 0; k = s.indexOf(ch, k + 1)) {
    let slashes = 0;
    while (s[k - 1 - slashes] === '\\') slashes++;
    if (slashes % 2 === 0) return k;
  }
  return -1;
}

// Remove % comments. A comment also swallows its line break and the next
// line's indentation, as in TeX.
function stripComments(text) {
  const lines = text.split('\n');
  let out = '';
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    let cut = -1;
    for (let j = 0; j < line.length; j++) {
      if (line[j] === '\\') j++;
      else if (line[j] === '%') { cut = j; break; }
    }
    if (cut >= 0) {
      out += line.slice(0, cut);
      if (k + 1 < lines.length) lines[k + 1] = lines[k + 1].replace(/^[ \t]+/, '');
    } else {
      out += line + (k < lines.length - 1 ? '\n' : '');
    }
  }
  return out;
}

// Group inline HTML into <p> elements; block elements pass through.
function paragraphize(html) {
  let out = '', buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t) out += `<p>${t}</p>\n`;
    buf = '';
  };
  for (const part of html.split(SPLIT_BLOCKS)) {
    if (part === PAR) flush();
    else if (part[0] === BLOCK_OPEN) { flush(); out += part.slice(1, -1) + '\n'; }
    else buf += part;
  }
  flush();
  return out;
}

// Wrap each inline run of `html` in open/close, leaving blocks untouched.
function wrapInline(html, open, close) {
  return html.split(SPLIT_BLOCKS)
    .map(p => (p === PAR || p[0] === BLOCK_OPEN || !p.trim()) ? p : open + p + close)
    .join('');
}

const stripMarkers = html => html.replace(/\u0001/g, ' ').replace(/[\u0002\u0003]/g, '');
const stripTags = html => html.replace(/<[^>]*>/g, '');

const roman = n => {
  let out = '';
  for (const [v, r] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]) {
    while (n >= v) { out += r; n -= v; }
  }
  return out;
};
const alpha = n => (n >= 1 && n <= 26 ? String.fromCharCode(96 + n) : String(n));

// LaTeX length -> CSS length, or null if it can't be expressed.
function cssLength(value) {
  const v = value.trim();
  let m = /^([\d.]*)\s*\\(textwidth|linewidth|columnwidth|hsize)$/.exec(v);
  if (m) return `${+(parseFloat(m[1] || '1') * 100).toFixed(2)}%`;
  m = /^([\d.]+)\s*(cm|mm|in|pt|pc|em|ex|px)$/.exec(v);
  if (m) return `${m[1]}${m[2]}`;
  return null;
}

function safeUrl(url) {
  const u = url.trim().replace(/\\([#%_&~$])/g, '$1');
  return /^\s*(javascript|vbscript|data):/i.test(u) ? '#' : u;
}

function colorValue(model, spec) {
  const s = spec.trim();
  if (model === 'HTML' && /^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
  if (model === 'rgb') {
    const p = s.split(',').map(Number);
    if (p.length === 3 && p.every(x => x >= 0 && x <= 1)) return `rgb(${p.map(x => Math.round(x * 255)).join(',')})`;
  }
  if (model === 'RGB') {
    const p = s.split(',').map(Number);
    if (p.length === 3 && p.every(x => x >= 0 && x <= 255)) return `rgb(${p.join(',')})`;
  }
  if (model === 'gray' && +s >= 0 && +s <= 1) return `rgb(${Array(3).fill(Math.round(+s * 255)).join(',')})`;
  const name = s.split('!')[0];
  return /^[a-zA-Z]+$/.test(name) ? name.toLowerCase() : null;
}

/* ------------------------------------------------------------------------ */
/* Tables                                                                    */
/* ------------------------------------------------------------------------ */

function parseColumns(spec) {
  // Expand *{n}{cols}.
  for (let guard = 0; guard < 20; guard++) {
    const m = /\*\s*\{(\d+)\}\s*/.exec(spec);
    if (!m) break;
    const start = m.index + m[0].length;
    const g = spec[start] === '{' ? readGroup(spec, start) : { text: spec[start] || '', end: start + 1 };
    spec = spec.slice(0, m.index) + g.text.repeat(Math.min(+m[1], 50)) + spec.slice(g.end);
  }
  const cols = [];
  let bar = false;
  for (let i = 0; i < spec.length;) {
    const c = spec[i++];
    if (c === '|') { bar = true; continue; }
    if ('@!><'.includes(c)) {
      const j = skipSpace(spec, i);
      if (spec[j] === '{') i = readGroup(spec, j).end;
      continue;
    }
    const align = { l: 'left', c: 'center', r: 'right', L: 'left', C: 'center', R: 'right', S: 'center', X: 'left' }[c];
    if (align) { cols.push({ align, left: bar }); bar = false; continue; }
    if ('pmb'.includes(c)) {
      const j = skipSpace(spec, i);
      let width = null;
      if (spec[j] === '{') { const g = readGroup(spec, j); width = cssLength(g.text); i = g.end; }
      cols.push({ align: 'left', left: bar, width });
      bar = false;
    }
  }
  if (bar && cols.length) cols[cols.length - 1].right = true;
  return cols;
}

const ROW_SEPARATOR = /\\\\\*?(\s*\[[^\]]*\])?|\\tabularnewline(?![a-zA-Z])|\\(endhead|endfirsthead|endfoot|endlastfoot)(?![a-zA-Z])/y;
const RULE = /^\s*\\(hline|toprule|midrule|bottomrule|cline|cmidrule|specialrule|addlinespace|hhline)(?![a-zA-Z])/;

// Strip leading rule commands from a table row; return the rules found.
function takeRules(text) {
  const rules = [];
  for (let m; (m = RULE.exec(text));) {
    let k = m[0].length;
    const kind = m[1];
    let range = null;
    if (kind === 'cmidrule') {
      const paren = /^\s*\([^)]*\)/.exec(text.slice(k));
      if (paren) k += paren[0].length;
    }
    if (kind === 'addlinespace') {
      const o = readOptional(text, k);
      if (o) k = o.end;
    } else if (kind === 'specialrule') {
      for (let n = 0; n < 3; n++) k = readArgument(text, k).end;
    } else if (kind === 'cline' || kind === 'cmidrule' || kind === 'hhline') {
      const a = readArgument(text, k);
      k = a.end;
      const r = /^(\d+)\s*-\s*(\d+)$/.exec(a.text.trim());
      if (r) range = [+r[1], +r[2]];
    }
    if (kind !== 'addlinespace') rules.push(range);
    text = text.slice(k);
  }
  return { rules, text };
}

function ruleClass(rules, col, span, prefix) {
  let count = 0;
  for (const r of rules) if (!r || (col + span - 1 >= r[0] - 1 && col <= r[1] - 1)) count++;
  return count >= 2 ? `${prefix}2` : count ? prefix : '';
}

/* ------------------------------------------------------------------------ */
/* Command and environment tables                                            */
/* ------------------------------------------------------------------------ */

const SECTION_LEVELS = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

const FONT_COMMANDS = {
  textbf: ['<strong>', '</strong>'], textit: ['<i>', '</i>'], textsl: ['<i>', '</i>'],
  emph: ['<em>', '</em>'], texttt: ['<code>', '</code>'], textsc: ['<span class="sc">', '</span>'],
  textsf: ['<span class="sf">', '</span>'], textrm: ['<span class="rm">', '</span>'],
  textup: ['<span class="rm">', '</span>'], textmd: ['<span class="rm">', '</span>'],
  textnormal: ['<span class="rm">', '</span>'], underline: ['<u>', '</u>'], uline: ['<u>', '</u>'],
  sout: ['<s>', '</s>'], st: ['<s>', '</s>'], hl: ['<mark>', '</mark>'],
  textsuperscript: ['<sup>', '</sup>'], textsubscript: ['<sub>', '</sub>'],
  mbox: ['<span class="nowrap">', '</span>'], hbox: ['<span class="nowrap">', '</span>'],
  fbox: ['<span class="fbox">', '</span>'], enquote: ['“', '”'], text: ['', ''],
};

const DECLARATIONS = {
  bfseries: ['<strong>', '</strong>'], bf: ['<strong>', '</strong>'],
  itshape: ['<i>', '</i>'], it: ['<i>', '</i>'], slshape: ['<i>', '</i>'], sl: ['<i>', '</i>'],
  em: ['<em>', '</em>'], ttfamily: ['<code>', '</code>'], tt: ['<code>', '</code>'],
  scshape: ['<span class="sc">', '</span>'], sc: ['<span class="sc">', '</span>'],
  sffamily: ['<span class="sf">', '</span>'], sf: ['<span class="sf">', '</span>'],
  rmfamily: ['<span class="rm">', '</span>'], rm: ['<span class="rm">', '</span>'],
  normalfont: ['<span class="rm">', '</span>'], upshape: ['<span class="rm">', '</span>'],
  mdseries: ['<span class="rm">', '</span>'],
};
for (const size of ['tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge']) {
  DECLARATIONS[size] = [`<span class="size-${size.toLowerCase()}${/^[A-Z]{2}/.test(size) ? '-3' : /^[A-Z]/.test(size) ? '-2' : ''}">`, '</span>'];
}

const SYMBOLS = {
  ldots: '…', dots: '…', textellipsis: '…', textendash: '–', textemdash: '—', textbullet: '•',
  dag: '†', ddag: '‡', textdagger: '†', textdaggerdbl: '‡', S: '§', P: '¶', textsection: '§',
  textparagraph: '¶', copyright: '©', textcopyright: '©', textregistered: '®', texttrademark: '™',
  pounds: '£', textsterling: '£', euro: '€', texteuro: '€', textdegree: '°', textasciitilde: '~',
  textasciicircum: '^', textbackslash: '\\', textbar: '|', textless: '<', textgreater: '>',
  textunderscore: '_', textquotedblleft: '“', textquotedblright: '”', textquoteleft: '‘',
  textquoteright: '’', guillemotleft: '«', guillemotright: '»', guillemetleft: '«', guillemetright: '»',
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł',
  i: 'ı', j: 'ȷ', textperiodcentered: '·', textexclamdown: '¡', textquestiondown: '¿',
  quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ',
  hfill: ' ', hfil: ' ', dotfill: ' … ', space: ' ', slash: '/', checkmark: '✓',
};

const LOGOS = {
  TeX: '<span class="tex-logo">T<sub>e</sub>X</span>',
  LaTeX: '<span class="tex-logo">L<sup>a</sup>T<sub>e</sub>X</span>',
  LaTeXe: '<span class="tex-logo">L<sup>a</sup>T<sub>e</sub>X&nbsp;2<sub>ε</sub></span>',
  BibTeX: '<span class="tex-logo"><span class="sc">Bib</span>T<sub>e</sub>X</span>',
};

// Combining marks for accent commands.
const ACCENTS = {
  "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄',
  '.': '̇', u: '̆', v: '̌', H: '̋', c: '̧', k: '̨', r: '̊',
  d: '̣', b: '̱', t: '͡',
};

// Commands that are dropped, with the arguments they take:
// 's' = optional star, '[' = optional argument, '{' = required argument.
const IGNORED = {
  documentclass: '[{', usepackage: '[{', RequirePackage: '[{', pagestyle: '{', thispagestyle: '{',
  setlength: '{{', addtolength: '{{', setcounter: '{{', addtocounter: '{{', stepcounter: '{',
  refstepcounter: '{', newcounter: '{[', newlength: '{', settowidth: '{{', geometry: '{',
  hypersetup: '{', bibliographystyle: '{', graphicspath: '{', numberwithin: '[{{', pagenumbering: '{',
  addcontentsline: '{{{', markboth: '{{', markright: '{', hyphenation: '{', selectlanguage: '{',
  vspace: 's{', setstretch: '{', linespread: '{', definecolor: '{{{', captionsetup: '[{', lstset: '{',
  usetikzlibrary: '{', tikzset: '{', pgfplotsset: '{', DeclareGraphicsExtensions: '{', nocite: '{',
  phantom: '{', hphantom: '{', vphantom: '{', index: '{', glossary: '{', allowdisplaybreaks: '[',
  urlstyle: '{', fontsize: '{{', addbibresource: '[{', enlargethispage: 's{', pagebreak: '[',
  nopagebreak: '[', nolinebreak: '[', twocolumn: '[', theoremstyle: '{',
  selectfont: '', centering: '', raggedright: '', raggedleft: '', protect: '', relax: '',
  sloppy: '', fussy: '', frenchspacing: '', nonfrenchspacing: '', makeatletter: '', makeatother: '',
  noindent: '', indent: '', newpage: '', clearpage: '', cleardoublepage: '', vfill: '', break: '',
  null: '', onecolumn: '', FloatBarrier: '', qedhere: '', frontmatter: '', mainmatter: '',
  backmatter: '', printindex: '', makeindex: '', ignorespaces: '', unskip: '', hline: '',
  displaystyle: '', textstyle: '', normalsize: '', onehalfspacing: '', doublespacing: '',
  singlespacing: '', smallbreak: '', medbreak: '', bigbreak: '', listoffigures: '', listoftables: '',
  justifying: '', leavevmode: '', nobreak: '', vskip: '', hskip: '',
};

// Theorem-like environments recognised without a \newtheorem.
const DEFAULT_THEOREMS = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary',
  conjecture: 'Conjecture', definition: 'Definition', remark: 'Remark', example: 'Example',
  claim: 'Claim', note: 'Note', exercise: 'Exercise', problem: 'Problem', solution: 'Solution',
  fact: 'Fact', observation: 'Observation', assumption: 'Assumption', notation: 'Notation',
  question: 'Question', axiom: 'Axiom', hypothesis: 'Hypothesis',
};
const ITALIC_THEOREMS = new Set(['theorem', 'lemma', 'proposition', 'corollary', 'conjecture', 'claim', 'axiom', 'hypothesis']);

const MATH_ENVS = {
  equation: null, displaymath: null, align: 'aligned', flalign: 'aligned', alignat: 'alignedat',
  xalignat: 'alignedat', gather: 'gathered', multline: 'gathered', eqnarray: 'eqnarray',
};

const PASS_THROUGH_ENVS = new Set([
  'document', 'titlepage', 'sloppypar', 'landscape', 'spacing', 'singlespace', 'onehalfspace',
  'doublespace', 'adjustbox', 'samepage', 'otherlanguage', 'refsection', 'small', 'footnotesize',
  'scriptsize', 'large', 'Large', 'normalsize', 'tiny', 'huge', 'Huge',
]);

/* ------------------------------------------------------------------------ */
/* Converter                                                                 */
/* ------------------------------------------------------------------------ */

class Converter {
  constructor(options) {
    this.files = options.files || null;
    this.renderMath = options.renderMath || null;
    this.warnings = new Map();
    this.macros = new Map();
    this.envDefs = new Map();
    this.theorems = new Map();
    this.theoremStyle = 'plain';
    this.verbatim = [];
    this.meta = {};
    this.labels = new Map();
    this.bib = new Map();
    this.counters = { equation: 0, figure: 0, table: 0 };
    this.sections = [0, 0, 0, 0, 0, 0, 0];
    this.parts = 0;
    this.appendix = false;
    this.footnotes = [];
    this.toc = [];
    this.floats = [];
    this.listDepth = 0;
    this.current = null;
    this.uid = 0;
    this.hasMath = false;
    this.quiet = false;
    this.s = '';
    this.i = 0;
  }

  run(source) {
    let src = source.replace(/\r\n?/g, '\n').replace(/[\u0001-\u0005]/g, '');
    src = this.prepare(src, 0);
    src = this.collectDefinitions(src);
    src = this.expandMacros(src);
    this.chapters = /\\chapter(?![a-zA-Z])/.test(src);

    let body = src;
    const begin = /\\begin\s*\{document\}/.exec(src);
    if (begin) {
      // Read the preamble only for \title, \author and \date.
      this.quiet = true;
      this.convert(src.slice(0, begin.index));
      this.quiet = false;
      body = findEnvEnd(src, begin.index + begin[0].length, 'document').body;
    }

    // Show the title block even when the document forgets \maketitle.
    if (this.meta.title && !/\\maketitle(?![a-zA-Z])/.test(body)) body = `\\maketitle\n${body}`;

    let html = this.blocks(body) + this.renderFootnotes();
    html = this.resolve(html);

    this.quiet = true;
    const title = this.meta.title ? stripTags(this.inline(this.meta.title)).replace(/\s+/g, ' ').trim() : '';
    this.quiet = false;

    return {
      title,
      body: html,
      hasMath: this.hasMath,
      warnings: [...this.warnings].map(([message, count]) => ({ message, count })),
    };
  }

  warn(message) {
    if (!this.quiet) this.warnings.set(message, (this.warnings.get(message) || 0) + 1);
  }

  /* ---- Preprocessing --------------------------------------------------- */

  lookupFile(name, exts) {
    if (!this.files) return null;
    const candidates = [name, ...exts.map(e => name + e)];
    if (typeof this.files === 'function') {
      for (const c of candidates) {
        const f = this.files(c);
        if (f != null) return f;
      }
      return null;
    }
    const base = n => n.replace(/^.*\//, '').replace(/^\.\//, '');
    for (const c of candidates) {
      if (c in this.files) return this.files[c];
      const b = base(c);
      for (const key of Object.keys(this.files)) if (base(key) === b) return this.files[key];
    }
    return null;
  }

  prepare(text, depth) {
    text = stripComments(this.protectVerbatim(text));
    return text.replace(/\\(input|include|subfile)\s*\{([^}]*)\}/g, (m, cmd, name) => {
      const f = depth < 10 ? this.lookupFile(name.trim(), ['.tex']) : null;
      if (f == null) {
        this.warn(`File not provided: ${name.trim()} (from \\${cmd})`);
        return '';
      }
      return this.prepare(f, depth + 1);
    });
  }

  // Replace verbatim content with placeholders before anything else reads it.
  protectVerbatim(text) {
    const store = html => {
      this.verbatim.push(html);
      return `${VERB}${this.verbatim.length - 1}${VERB}`;
    };
    text = text.replace(/\\begin\{(verbatim\*?|Verbatim|lstlisting|minted|comment)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) => {
      if (env === 'comment') return '';
      let lang = '';
      if (env === 'lstlisting' || env === 'Verbatim') {
        const o = /^\s*\[([^\]]*)\]/.exec(body);
        if (o) {
          body = body.slice(o[0].length);
          lang = (/language\s*=\s*\{?([\w+#-]+)/i.exec(o[1]) || [])[1] || '';
        }
      } else if (env === 'minted') {
        const o = /^\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(body);
        if (o) { body = body.slice(o[0].length); lang = o[2]; }
      }
      body = body.replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
      const cls = lang ? ` class="language-${slug(lang)}"` : '';
      return store(`${BLOCK_OPEN}<pre><code${cls}>${escapeHtml(body)}</code></pre>${BLOCK_CLOSE}`);
    });
    return text.replace(/\\(verb|lstinline)\*?([^a-zA-Z\s{])(.*?)\2/g,
      (m, cmd, delim, body) => store(`<code>${escapeHtml(body)}</code>`));
  }

  collectDefinitions(src) {
    const re = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|def|gdef|edef|let|DeclareMathOperator|newtheorem|newenvironment|renewenvironment|theoremstyle)(\*?)(?![a-zA-Z])/g;
    let out = '', last = 0, m;
    while ((m = re.exec(src))) {
      const end = this.define(m[1], m[2] === '*', src, re.lastIndex);
      if (end < 0) continue;
      out += src.slice(last, m.index);
      last = end;
      re.lastIndex = end;
    }
    return out + src.slice(last);
  }

  define(kind, star, s, i) {
    if (kind === 'theoremstyle') {
      const a = readArgument(s, i);
      this.theoremStyle = a.text.trim();
      return a.end;
    }
    if (kind === 'newtheorem') {
      const env = readArgument(s, i);
      let k = env.end;
      const shared = readOptional(s, k);
      if (shared) k = shared.end;
      const title = readArgument(s, k);
      k = title.end;
      const within = readOptional(s, k);
      if (within) k = within.end;
      const name = env.text.trim();
      this.theorems.set(name, {
        title: title.text,
        counter: shared ? shared.text.trim() : name,
        within: within ? within.text.trim() : null,
        numbered: !star,
        italic: this.theoremStyle === 'plain',
      });
      return k;
    }
    if (kind === 'newenvironment' || kind === 'renewenvironment') {
      const name = readArgument(s, i);
      let k = name.end;
      const n = readOptional(s, k);
      if (n) k = n.end;
      const optional = n ? readOptional(s, k) : null;
      if (optional) k = optional.end;
      const begin = readArgument(s, k);
      const end = readArgument(s, begin.end);
      this.envDefs.set(name.text.trim(), {
        args: n ? parseInt(n.text, 10) || 0 : 0,
        optional: optional ? optional.text : null,
        begin: begin.text,
        end: end.text,
      });
      return end.end;
    }
    if (kind === 'let') {
      const name = readArgument(s, i);
      let k = skipSpace(s, name.end);
      if (s[k] === '=') k++;
      const target = readArgument(s, k);
      if (!/^\\[a-zA-Z@]+$/.test(name.text)) return -1;
      this.macros.set(name.text.slice(1), { args: 0, optional: null, body: target.text });
      return target.end;
    }
    if (kind === 'def' || kind === 'gdef' || kind === 'edef') {
      const k0 = skipSpace(s, i);
      CONTROL.lastIndex = k0;
      const nm = CONTROL.exec(s);
      if (!nm || s[k0] !== '\\') return -1;
      const brace = s.indexOf('{', CONTROL.lastIndex);
      if (brace < 0) return -1;
      const params = s.slice(CONTROL.lastIndex, brace);
      if (!/^(\s*#\d)*\s*$/.test(params)) return -1;
      const body = readGroup(s, brace);
      this.macros.set(nm[1], { args: (params.match(/#\d/g) || []).length, optional: null, body: body.text });
      return body.end;
    }
    if (kind === 'DeclareMathOperator') {
      const name = readArgument(s, i);
      const text = readArgument(s, name.end);
      if (!/^\\[a-zA-Z@]+$/.test(name.text.trim())) return -1;
      this.macros.set(name.text.trim().slice(1), { args: 0, optional: null, body: `\\operatorname${star ? '*' : ''}{${text.text}}` });
      return text.end;
    }
    // \newcommand and friends
    const name = readArgument(s, i);
    const cmd = name.text.trim();
    if (!/^\\([a-zA-Z@]+|.)$/.test(cmd)) return -1;
    let k = name.end;
    const n = readOptional(s, k);
    if (n) k = n.end;
    const optional = n ? readOptional(s, k) : null;
    if (optional) k = optional.end;
    const body = readArgument(s, k);
    if (!(kind === 'providecommand' && this.macros.has(cmd.slice(1)))) {
      this.macros.set(cmd.slice(1), {
        args: n ? parseInt(n.text, 10) || 0 : 0,
        optional: optional ? optional.text : null,
        body: body.text,
      });
    }
    return body.end;
  }

  readMacroArgs(s, i, def) {
    const args = [];
    let k = i, count = def.args;
    if (def.optional !== null) {
      const o = readOptional(s, k);
      if (o) { args.push(o.text); k = o.end; } else args.push(def.optional);
      count--;
    }
    for (; count > 0; count--) {
      const a = readArgument(s, k);
      args.push(a.text);
      k = a.end;
    }
    return { args, end: k };
  }

  expandMacros(src) {
    if (!this.macros.size && !this.envDefs.size) return src;
    const substitute = (body, args) => body.replace(/##|#([1-9])/g, (t, d) => (d ? args[d - 1] ?? '' : '#'));
    for (let pass = 0; pass < 32; pass++) {
      const re = /\\([a-zA-Z@]+|[\s\S])/g;
      let out = '', last = 0, changed = false, m;
      while ((m = re.exec(src))) {
        const name = m[1];
        let rep = null, end = re.lastIndex;
        if ((name === 'begin' || name === 'end') && src[skipSpace(src, end)] === '{') {
          const arg = readGroup(src, skipSpace(src, end));
          const env = this.envDefs.get(arg.text.trim());
          if (env) {
            if (name === 'begin') {
              const { args, end: k } = this.readMacroArgs(src, arg.end, env);
              rep = substitute(env.begin, args);
              end = k;
            } else {
              rep = env.end;
              end = arg.end;
            }
          }
        } else if (this.macros.has(name)) {
          const def = this.macros.get(name);
          const { args, end: k } = this.readMacroArgs(src, end, def);
          rep = substitute(def.body, args);
          end = k;
        }
        if (rep !== null) {
          out += src.slice(last, m.index) + rep;
          last = end;
          re.lastIndex = end;
          changed = true;
        }
      }
      src = out + src.slice(last);
      if (!changed) return src;
      if (src.length > 5e6) break;
    }
    this.warn('Macro expansion stopped early (a macro may be recursive)');
    return src;
  }

  /* ---- Core parsing ---------------------------------------------------- */

  within(text, fn) {
    const saved = [this.s, this.i];
    this.s = text;
    this.i = 0;
    try {
      return fn();
    } finally {
      [this.s, this.i] = saved;
    }
  }

  // Convert a fragment. The result may still contain paragraph/block markers.
  convert(text) {
    return this.within(text, () => {
      let out = '';
      while (this.i < this.s.length) out += this.step();
      return out;
    });
  }

  inline(text) { return stripMarkers(this.convert(text)); }
  blocks(text) { return paragraphize(this.convert(text)); }

  // Block content with a lone paragraph unwrapped (for list items, cells, notes).
  blockContent(text) {
    const html = this.blocks(text).trim();
    const m = /^<p>([\s\S]*)<\/p>$/.exec(html);
    return m && !m[1].includes('<p>') ? m[1] : html;
  }

  block(html) { return BLOCK_OPEN + html.replace(/[\u0001-\u0003]/g, '') + BLOCK_CLOSE; }

  rest() {
    const r = this.s.slice(this.i);
    this.i = this.s.length;
    return r;
  }

  arg() {
    const a = readArgument(this.s, this.i);
    this.i = a.end;
    return a.text;
  }

  opt() {
    const o = readOptional(this.s, this.i);
    if (!o) return null;
    this.i = o.end;
    return o.text;
  }

  takeStar() {
    if (this.s[this.i] !== '*') return false;
    this.i++;
    return true;
  }

  consume(spec) {
    for (const c of spec) {
      if (c === 's') this.takeStar();
      else if (c === '[') this.opt();
      else this.arg();
    }
  }

  step() {
    const s = this.s;
    TEXT_RUN.lastIndex = this.i;
    const run = TEXT_RUN.exec(s);
    if (run) {
      this.i = TEXT_RUN.lastIndex;
      return escapeHtml(run[0]);
    }
    const c = s[this.i];
    switch (c) {
      case '\\': return this.command();
      case '{': {
        const g = readGroup(s, this.i);
        this.i = g.end;
        return this.convert(g.text);
      }
      case '}': this.i++; return '';
      case '$': return this.dollarMath();
      case '~': this.i++; return '&nbsp;';
      case '-': {
        let n = 0;
        while (s[this.i] === '-' && n < 3) { this.i++; n++; }
        return ['', '-', '–', '—'][n];
      }
      case '`':
        if (s[this.i + 1] === '`') { this.i += 2; return '“'; }
        this.i++;
        return '‘';
      case "'":
        if (s[this.i + 1] === "'") { this.i += 2; return '”'; }
        this.i++;
        return '’';
      case VERB: {
        const end = s.indexOf(VERB, this.i + 1);
        const html = this.verbatim[+s.slice(this.i + 1, end)];
        this.i = end + 1;
        return html;
      }
      default:
        if (/\s/.test(c)) {
          const m = /\s+/y;
          m.lastIndex = this.i;
          const ws = m.exec(s)[0];
          this.i += ws.length;
          return (ws.match(/\n/g) || []).length >= 2 ? PAR : ' ';
        }
        this.i++;
        return escapeHtml(c);
    }
  }

  command() {
    CONTROL.lastIndex = this.i;
    const name = CONTROL.exec(this.s)[1];
    this.i = CONTROL.lastIndex;
    if (!/^[a-zA-Z@]+$/.test(name)) return this.controlSymbol(name);

    // Spaces after a control word are skipped, but not a paragraph break.
    const sp = /[ \t]*(?:\n(?![ \t]*\n)[ \t]*)?/y;
    sp.lastIndex = this.i;
    this.i += sp.exec(this.s)[0].length;

    const handler = COMMANDS[name];
    if (handler) return handler.call(this, name);
    if (name in FONT_COMMANDS) {
      const [open, close] = FONT_COMMANDS[name];
      return open + this.inline(this.arg()) + close;
    }
    if (name in DECLARATIONS) {
      const [open, close] = DECLARATIONS[name];
      return wrapInline(this.convert(this.rest()), open, close);
    }
    if (name in SYMBOLS) return escapeHtml(SYMBOLS[name]);
    if (name in LOGOS) return LOGOS[name];
    if (name in SECTION_LEVELS) return this.heading(SECTION_LEVELS[name]);
    if (name in IGNORED) { this.consume(IGNORED[name]); return ''; }
    if (name in ACCENTS) return this.accent(ACCENTS[name]);
    return this.unknownCommand(name);
  }

  controlSymbol(ch) {
    switch (ch) {
      case '\\':
        this.takeStar();
        if (this.s[this.i] === '[' || /^\s*\[/.test(this.s.slice(this.i, this.i + 8))) this.opt();
        return '<br>';
      case '[': {
        const end = this.s.indexOf('\\]', this.i);
        if (end < 0) { this.warn('Unterminated \\[ display math'); return ''; }
        const tex = this.s.slice(this.i, end);
        this.i = end + 2;
        return this.displayMath(tex, null);
      }
      case '(': {
        const end = this.s.indexOf('\\)', this.i);
        if (end < 0) { this.warn('Unterminated \\( math'); return ''; }
        const tex = this.s.slice(this.i, end);
        this.i = end + 2;
        return this.renderTex(tex, false);
      }
      case ',': case ':': case '>': return ' ';
      case ';': return ' ';
      case ' ': case '\n': case '\t': return ' ';
      case ']': case ')': case '!': case '/': case '-': case '@': case '': return '';
      default:
        if (ch in ACCENTS) return this.accent(ACCENTS[ch]);
        return escapeHtml(ch);
    }
  }

  accent(mark) {
    const base = this.arg().trim();
    const text = base === '\\i' ? 'ı' : base === '\\j' ? 'ȷ' : stripTags(this.inline(base));
    if (!text) return mark;
    return (text[0] + mark + text.slice(1)).normalize('NFC');
  }

  unknownCommand(name) {
    this.warn(`Unsupported command: \\${name}`);
    // Keep the text of any braced arguments so no content is lost.
    let out = '';
    while (this.s[this.i] === '{') {
      const g = readGroup(this.s, this.i);
      this.i = g.end;
      out += this.convert(g.text);
    }
    return out;
  }

  /* ---- Structure ------------------------------------------------------- */

  heading(level) {
    const star = this.takeStar();
    this.opt();
    const title = this.inline(this.arg()).trim();
    const base = this.chapters ? 1 : 2;

    if (level >= 5) return `${PAR}<strong class="run-in">${title}</strong> `;

    let number = '';
    if (!star) {
      if (level === 0) {
        number = roman(++this.parts).toUpperCase();
      } else if (level >= base) {
        this.sections[level]++;
        this.sections.fill(0, level + 1);
        number = this.sections.slice(base, level + 1)
          .map((n, k) => (k === 0 && this.appendix ? alpha(n).toUpperCase() : n))
          .join('.');
      }
    }
    const id = number ? `sec-${number}` : `sec-x${++this.uid}`;
    if (number && level > 0) {
      this.current = { id, text: number, kind: level === 1 ? 'Chapter' : level === base && this.appendix ? 'Appendix' : 'Section' };
    }
    if (!star && level >= base && level <= base + 1) this.toc.push({ level, number, title, id });

    if (level === 0) {
      return this.block(`<h2 class="part" id="${id}">${number ? `Part ${number}<br>` : ''}${title}</h2>`);
    }
    const tag = `h${Math.min(6, level - base + 2)}`;
    const num = number ? `<span class="secnum">${number}</span> ` : '';
    return this.block(`<${tag} id="${id}">${num}${title}</${tag}>`);
  }

  titleBlock() {
    const { title, author, date } = this.meta;
    let h = '';
    if (title) h += `<h1 class="title">${this.inline(title).trim()}</h1>\n`;
    if (author) {
      const authors = splitTopLevel(author, /\\and(?![a-zA-Z])/y)
        .map(p => `<span class="author">${this.inline(p.text).trim()}</span>`);
      h += `<div class="authors">${authors.join('')}</div>\n`;
    }
    if (date) {
      const d = this.inline(date).trim();
      if (d) h += `<p class="date">${d}</p>\n`;
    }
    return h ? this.block(`<header class="title-block">\n${h}</header>`) : '';
  }

  renderToc() {
    if (!this.toc.length) return '';
    const min = Math.min(...this.toc.map(t => t.level));
    let h = '', depth = -1;
    for (const t of this.toc) {
      const d = Math.min(t.level - min, depth + 1);
      if (d > depth) h += '<ul>';
      else {
        h += '</li>';
        for (; depth > d; depth--) h += '</ul></li>';
      }
      depth = d;
      const title = t.title.replace(/<sup class="fnref">.*?<\/sup>/g, '');
      h += `<li><a href="#${t.id}">${t.number ? `<span class="secnum">${t.number}</span> ` : ''}${title}</a>`;
    }
    h += '</li>';
    for (; depth > 0; depth--) h += '</ul></li>';
    return `<nav class="toc">\n<h2>Contents</h2>\n${h}</ul>\n</nav>`;
  }

  renderFootnotes() {
    if (!this.footnotes.length) return '';
    const items = this.footnotes.map((html, k) =>
      `<li id="fn-${k + 1}">${html} <a href="#fnref-${k + 1}" class="fnback" aria-label="Back to text">↩</a></li>`);
    return `<section class="footnotes">\n<ol>\n${items.join('\n')}\n</ol>\n</section>\n`;
  }

  resolve(html) {
    return html.replace(/\u0004(\w+):([^\u0004]*)\u0004/g, (m, kind, key) => {
      if (kind === 'toc') return this.renderToc();
      if (kind === 'cite') {
        const b = this.bib.get(key);
        if (!b) { this.warn(`Undefined citation: ${key}`); return '?'; }
        return `<a href="#${b.id}" class="cite">${b.text}</a>`;
      }
      const l = this.labels.get(key);
      if (!l) { this.warn(`Undefined reference: ${key}`); return '??'; }
      let text = l.text || '??';
      if (kind === 'eqref') text = `(${text})`;
      if (kind === 'autoref' && l.kind) text = `${l.kind}&nbsp;${text}`;
      return l.id ? `<a href="#${l.id}" class="ref">${text}</a>` : text;
    });
  }

  /* ---- Environments ---------------------------------------------------- */

  environment(name, body) {
    const base = name.replace(/\*$/, '');
    const star = name !== base;
    return this.within(body, () => {
      const handler = ENVIRONMENTS[name] || ENVIRONMENTS[base];
      if (handler) return handler.call(this, name);
      if (base in MATH_ENVS) return this.displayMath(this.rest(), name);
      if (this.theorems.has(base) || base in DEFAULT_THEOREMS) return this.theorem(base, star);
      if (PASS_THROUGH_ENVS.has(base)) {
        const decl = DECLARATIONS[base];
        const html = this.blocks(this.rest());
        return this.block(decl ? `<div class="${/class="([^"]*)"/.exec(decl[0])[1]}">${html}</div>` : html);
      }
      this.warn(`Unsupported environment: ${name}`);
      return this.block(`<div class="env-${slug(name)}">\n${this.blocks(this.rest())}</div>`);
    });
  }

  list(kind) {
    const items = splitTopLevel(this.rest(), /\\item(?![a-zA-Z])/y).slice(1);
    const tag = { enumerate: 'ol', description: 'dl' }[kind] || 'ul';
    this.listDepth++;
    let html = '', n = 0;
    for (const item of items) {
      html += this.within(item.text, () => {
        const label = this.s.trimStart()[0] === '[' ? this.opt() : null;
        let id = '';
        if (kind === 'enumerate' && label === null) {
          n++;
          const text = [String(n), alpha(n), roman(n), alpha(n).toUpperCase()][(this.listDepth - 1) % 4];
          this.current = { id: `item-${++this.uid}`, text, kind: 'Item' };
          id = ` id="${this.current.id}"`;
        }
        const content = this.blockContent(this.rest());
        if (kind === 'description') return `<dt>${this.inline(label || '')}</dt>\n<dd>${content}</dd>\n`;
        if (label !== null) return `<li class="labeled"><span class="item-label">${this.inline(label)}</span> ${content}</li>\n`;
        return `<li${id}>${content}</li>\n`;
      });
    }
    this.listDepth--;
    return this.block(`<${tag}>\n${html}</${tag}>`);
  }

  tabular(name) {
    if (name === 'tabular*' || name === 'tabularx' || name === 'tabulary') this.arg();
    this.opt();
    const cols = parseColumns(this.arg());
    return this.block(this.table(cols, this.rest()));
  }

  table(cols, body) {
    const segments = splitTopLevel(body, ROW_SEPARATOR).map(p => p.text);
    const rows = [];
    let carry = [];
    segments.forEach((segment, k) => {
      const { rules, text } = takeRules(segment);
      if (!text.trim()) {
        if (k === segments.length - 1 && rows.length) rows[rows.length - 1].bottom = rules;
        else carry.push(...rules);
        return;
      }
      rows.push({ top: [...carry, ...rules], bottom: [], text });
      carry = [];
    });

    const spans = [];
    let html = '';
    for (const row of rows) {
      let col = 0, cells = '';
      for (const part of splitTopLevel(row.text, /&/y)) {
        // A cell covered by a \multirow above is a placeholder in LaTeX; HTML omits it.
        if (spans[col] > 0) { spans[col]--; col++; continue; }
        let text = part.text.trim();
        let colspan = 1, rowspan = 1, spec = cols[col] || { align: 'left' };
        let left = spec.left, right = spec.right;
        if (/^\\multicolumn(?![a-zA-Z])/.test(text)) {
          const [n, colSpec, content] = this.within(text.slice(12), () => [this.arg(), this.arg(), this.rest()]);
          colspan = Math.max(1, parseInt(n, 10) || 1);
          const mc = parseColumns(colSpec);
          spec = mc[0] || spec;
          left = spec.left;
          right = mc.length && mc[mc.length - 1].right;
          text = content.trim();
        }
        if (/^\\multirow(?![a-zA-Z])/.test(text)) {
          const [n, content] = this.within(text.slice(9), () => {
            this.opt();
            const count = this.arg();
            this.arg();
            this.opt();
            return [count, this.arg()];
          });
          rowspan = Math.max(1, parseInt(n, 10) || 1);
          if (rowspan > 1) for (let c = 0; c < colspan; c++) spans[col + c] = rowspan - 1;
          text = content;
        }
        const classes = [spec.align, left && 'bl', right && 'br',
          ruleClass(row.top, col, colspan, 'bt'), ruleClass(row.bottom, col, colspan, 'bb')].filter(Boolean);
        const attrs = (colspan > 1 ? ` colspan="${colspan}"` : '') + (rowspan > 1 ? ` rowspan="${rowspan}"` : '') +
          (spec.width ? ` style="width:${spec.width}"` : '');
        cells += `<td class="${classes.join(' ')}"${attrs}>${this.inline(text).trim()}</td>`;
        col += colspan;
      }
      html += `<tr>${cells}</tr>\n`;
    }
    return `<table class="tabular">\n<tbody>\n${html}</tbody>\n</table>`;
  }

  float(name) {
    const kind = name.replace(/\*$/, '').replace(/^wrap/, '').replace(/^sub/, '');
    if (name.startsWith('wrap')) { this.opt(); this.arg(); this.opt(); this.arg(); } else this.opt();
    this.floats.push(kind === 'table' ? 'table' : 'figure');
    const inner = this.blocks(this.rest());
    this.floats.pop();
    return this.block(`<figure class="float ${kind}">\n${inner}</figure>`);
  }

  theorem(name, star) {
    const def = this.theorems.get(name) ||
      { title: DEFAULT_THEOREMS[name], counter: name, numbered: true, italic: ITALIC_THEOREMS.has(name) };
    const note = this.opt();
    let head = this.inline(def.title).trim(), id = '';
    if (def.numbered && !star) {
      // Counters numbered within a section restart in each one (Theorem 2.1, 2.2, ...).
      const owner = this.theorems.get(def.counter) || def;
      const level = SECTION_LEVELS[owner.within];
      const base = this.chapters ? 1 : 2;
      const prefix = level >= base ? this.sections.slice(base, level + 1).join('.') : '';
      const key = `thm:${def.counter}@${prefix}`;
      const n = this.counters[key] = (this.counters[key] || 0) + 1;
      const number = prefix ? `${prefix}.${n}` : String(n);
      head += ` ${number}`;
      id = `${slug(name)}-${number.replace(/\./g, '-')}`;
      this.current = { id, text: number, kind: this.inline(def.title).trim() };
    }
    if (note) head += ` (${this.inline(note).trim()})`;
    const content = this.blocks(this.rest());
    const cls = `theorem ${def.italic ? 'theorem-plain' : 'theorem-upright'}`;
    return this.block(`<div class="${cls}"${id ? ` id="${id}"` : ''}>\n${runIn(`<span class="thm-head">${head}.</span>`, content)}</div>`);
  }

  bibliography() {
    this.arg();
    const items = splitTopLevel(this.rest(), /\\bibitem(?![a-zA-Z])/y).slice(1);
    let html = '';
    for (const item of items) {
      html += this.within(item.text, () => {
        const label = this.opt();
        const key = this.arg().trim();
        const n = this.bib.size + 1;
        const id = `bib-${n}`;
        const text = label !== null ? this.inline(label).trim() : String(n);
        this.bib.set(key, { id, text });
        return `<li id="${id}"><span class="bib-label">[${text}]</span> ${this.blockContent(this.rest())}</li>\n`;
      });
    }
    const heading = this.chapters ? 'Bibliography' : 'References';
    return this.block(`<section class="bibliography">\n<h2>${heading}</h2>\n<ol>\n${html}</ol>\n</section>`);
  }

  /* ---- Math ------------------------------------------------------------ */

  renderTex(tex, display) {
    this.hasMath = true;
    tex = tex.trim();
    if (!this.renderMath) {
      return `<span class="math-tex">${escapeHtml(display ? `\\[${tex}\\]` : `\\(${tex}\\)`)}</span>`;
    }
    try {
      return this.renderMath(tex, display);
    } catch (e) {
      const msg = String(e && e.message || e).replace(/^KaTeX parse error:\s*/, '');
      this.warn(`Math error: ${msg}`);
      return `<code class="math-error" title="${escapeHtml(msg)}">${escapeHtml(tex)}</code>`;
    }
  }

  dollarMath() {
    const s = this.s;
    if (s[this.i + 1] === '$') {
      const end = s.indexOf('$$', this.i + 2);
      if (end < 0) { this.warn('Unterminated $$ display math'); this.i += 2; return ''; }
      const tex = s.slice(this.i + 2, end);
      this.i = end + 2;
      return this.displayMath(tex, null);
    }
    const end = findUnescaped(s, '$', this.i + 1);
    if (end < 0) { this.warn('Unterminated $ math'); this.i++; return '$'; }
    const tex = s.slice(this.i + 1, end);
    this.i = end + 1;
    return this.renderTex(tex, false);
  }

  displayMath(tex, env) {
    const base = env ? env.replace(/\*$/, '') : null;
    let numbered = !!env && !env.endsWith('*') && base !== 'displaymath';
    const labels = [];
    tex = tex.replace(/\\label\s*\{([^}]*)\}/g, (m, key) => { labels.push(key.trim()); return ''; });
    const noNumber = /\\(nonumber|notag)(?![a-zA-Z])/g;
    if (noNumber.test(tex)) {
      tex = tex.replace(noNumber, '');
      if (!/\\\\/.test(tex)) numbered = false;
    }
    let number = null;
    const tag = /\\tag(\*?)\s*\{([^}]*)\}/.exec(tex);
    if (tag) {
      tex = tex.replace(/\\tag\*?\s*\{[^}]*\}/g, '');
      number = tag[1] ? tag[2] : `(${tag[2]})`;
    } else if (numbered) {
      number = `(${++this.counters.equation})`;
    }

    const wrap = base && MATH_ENVS[base];
    if (wrap === 'alignedat') {
      const n = readArgument(tex, 0);
      tex = `\\begin{alignedat}{${n.text}}${tex.slice(n.end)}\\end{alignedat}`;
    } else if (wrap === 'eqnarray') {
      tex = `\\begin{array}{rcl}${tex}\\end{array}`;
    } else if (wrap) {
      tex = `\\begin{${wrap}}${tex}\\end{${wrap}}`;
    }

    let id = '';
    if (number) {
      id = `eq-${++this.uid}`;
      const text = number.replace(/^\((.*)\)$/, '$1');
      this.current = { id, text, kind: 'Equation' };
      for (const key of labels) if (!this.quiet) this.labels.set(key, this.current);
    }
    const eqno = number ? `<span class="eqno">${escapeHtml(number)}</span>` : '';
    return this.block(`<div class="math-display"${id ? ` id="${id}"` : ''}><div class="eqn">${this.renderTex(tex, true)}</div>${eqno}</div>`);
  }
}

function runIn(head, html) {
  return html.startsWith('<p>') ? `<p>${head} ${html.slice(3)}` : `<p>${head}</p>\n${html}`;
}

/* ------------------------------------------------------------------------ */
/* Command handlers (called with `this` bound to the Converter)              */
/* ------------------------------------------------------------------------ */

const COMMANDS = Object.assign(Object.create(null), {
  title() { this.opt(); this.meta.title = this.arg(); return ''; },
  author() { this.opt(); this.meta.author = this.arg(); return ''; },
  date() { this.meta.date = this.arg(); return ''; },
  maketitle() { return this.titleBlock(); },
  tableofcontents() { return this.block(`${DEFER}toc:${DEFER}`); },
  appendix() { this.appendix = true; this.sections.fill(0); return ''; },

  begin() {
    const name = this.arg().trim();
    const { body, end, unterminated } = findEnvEnd(this.s, this.i, name);
    this.i = end;
    if (unterminated) this.warn(`Missing \\end{${name}}`);
    return this.environment(name, body);
  },
  end() { this.warn(`Unmatched \\end{${this.arg().trim()}}`); return ''; },
  item() { this.opt(); this.warn('\\item used outside a list'); return ''; },
  bibitem() { this.opt(); this.arg(); this.warn('\\bibitem used outside thebibliography'); return ''; },

  par() { return PAR; },
  smallskip() { return PAR; },
  medskip() { return PAR; },
  bigskip() { return PAR; },
  newline() { return '<br>'; },
  linebreak() { this.opt(); return '<br>'; },
  hspace() { this.takeStar(); this.arg(); return ' '; },
  today() {
    return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  },
  centerline() { return this.block(`<div class="center">${this.inline(this.arg())}</div>`); },
  framebox() { this.opt(); this.opt(); return `<span class="fbox">${this.inline(this.arg())}</span>`; },
  makebox() { this.opt(); this.opt(); return this.inline(this.arg()); },
  raisebox() { this.arg(); this.opt(); this.opt(); return this.inline(this.arg()); },
  parbox() { this.opt(); this.opt(); this.opt(); this.arg(); return this.inline(this.arg()); },
  ensuremath() { return this.renderTex(this.arg(), false); },

  textcolor() {
    const model = this.opt();
    const color = colorValue(model, this.arg());
    const text = this.inline(this.arg());
    return color ? `<span style="color:${color}">${text}</span>` : text;
  },
  color() {
    const model = this.opt();
    const color = colorValue(model, this.arg());
    const html = this.convert(this.rest());
    return color ? wrapInline(html, `<span style="color:${color}">`, '</span>') : html;
  },
  colorbox() {
    const model = this.opt();
    const color = colorValue(model, this.arg());
    const text = this.inline(this.arg());
    return color ? `<span class="colorbox" style="background:${color}">${text}</span>` : text;
  },
  fcolorbox() {
    const model = this.opt();
    const frame = colorValue(model, this.arg());
    const bg = colorValue(model, this.arg());
    const text = this.inline(this.arg());
    return `<span class="colorbox" style="${frame ? `border:1px solid ${frame};` : ''}${bg ? `background:${bg}` : ''}">${text}</span>`;
  },

  href() {
    const url = safeUrl(this.arg());
    return `<a href="${escapeHtml(url)}">${this.inline(this.arg())}</a>`;
  },
  url() {
    const url = safeUrl(this.arg());
    return `<a href="${escapeHtml(url)}" class="url">${escapeHtml(url)}</a>`;
  },
  nolinkurl() { return `<span class="url">${escapeHtml(safeUrl(this.arg()))}</span>`; },

  footnote() {
    this.opt();
    const text = this.arg();
    if (this.quiet) return '';
    const n = this.footnotes.push('');
    this.footnotes[n - 1] = this.blockContent(text);
    return `<sup class="fnref"><a href="#fn-${n}" id="fnref-${n}">${n}</a></sup>`;
  },
  thanks() { return COMMANDS.footnote.call(this); },

  label() {
    const key = this.arg().trim();
    if (this.quiet) return '';
    if (this.current) {
      this.labels.set(key, this.current);
      return '';
    }
    const id = `label-${slug(key) || ++this.uid}`;
    this.labels.set(key, { id, text: '', kind: '' });
    return `<span id="${id}"></span>`;
  },
  ref() { return refs(this, 'ref'); },
  pageref() { return refs(this, 'ref'); },
  nameref() { return refs(this, 'ref'); },
  eqref() { return refs(this, 'eqref'); },
  autoref() { return refs(this, 'autoref'); },
  cref() { return refs(this, 'autoref'); },
  Cref() { return refs(this, 'autoref'); },

  cite() {
    const first = this.opt();
    const second = this.opt();
    const note = second !== null ? second : first;
    const keys = this.arg().split(',').map(k => k.trim()).filter(Boolean);
    const links = keys.map(k => `${DEFER}cite:${k}${DEFER}`).join(', ');
    return `[${links}${note ? `, ${this.inline(note)}` : ''}]`;
  },
  bibliography() {
    this.arg();
    this.warn('BibTeX files (\\bibliography{…}) are not processed; use a thebibliography environment instead');
    return '';
  },
  printbibliography() {
    this.opt();
    this.warn('biblatex (\\printbibliography) is not supported; use a thebibliography environment instead');
    return '';
  },

  caption() {
    this.opt();
    const text = this.inline(this.arg()).trim();
    const kind = this.floats[this.floats.length - 1];
    if (!kind) return this.block(`<p class="caption">${text}</p>`);
    return this.captionFor(kind, text);
  },
  captionof() {
    const kind = this.arg().trim() === 'table' ? 'table' : 'figure';
    this.opt();
    return this.captionFor(kind, this.inline(this.arg()).trim());
  },
  includegraphics() {
    this.takeStar();
    const options = this.opt() || '';
    const file = this.arg().trim();
    let src = this.lookupFile(file, IMAGE_EXTS);
    if (src == null) {
      src = file;
      if (!/^(https?:)?\/\//.test(file)) this.warn(`Image not provided: ${file}`);
    } else if (/^data:application\/(pdf|postscript)/.test(src) || /\.(pdf|eps)$/i.test(src)) {
      this.warn(`Image ${file} is a PDF/EPS, which browsers can't show inline; use PNG, JPG or SVG`);
    }
    const width = /(?:^|,)\s*width\s*=\s*([^,]+)/.exec(options);
    const height = /(?:^|,)\s*height\s*=\s*([^,]+)/.exec(options);
    const style = [width && cssLength(width[1]) && `width:${cssLength(width[1])}`,
      height && cssLength(height[1]) && `height:${cssLength(height[1])}`].filter(Boolean).join(';');
    const alt = file.replace(/^.*\//, '').replace(/\.[a-z]+$/i, '');
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${style ? ` style="${style}"` : ''}>`;
  },
});

Object.assign(Converter.prototype, {
  captionFor(kind, text) {
    const n = ++this.counters[kind];
    const name = kind === 'table' ? 'Table' : 'Figure';
    const id = `${kind}-${n}`;
    this.current = { id, text: String(n), kind: name };
    return this.block(`<figcaption id="${id}"><span class="caption-label">${name} ${n}:</span> ${text}</figcaption>`);
  },
});

function refs(conv, kind) {
  const keys = conv.arg().split(',').map(k => k.trim()).filter(Boolean);
  return keys.map(k => `${DEFER}${kind}:${k}${DEFER}`).join(', ');
}

const ENVIRONMENTS = Object.assign(Object.create(null), {
  center() { return this.block(`<div class="center">\n${this.blocks(this.rest())}</div>`); },
  flushleft() { return this.block(`<div class="flushleft">\n${this.blocks(this.rest())}</div>`); },
  flushright() { return this.block(`<div class="flushright">\n${this.blocks(this.rest())}</div>`); },
  quote() { return this.block(`<blockquote>\n${this.blocks(this.rest())}</blockquote>`); },
  quotation() { return this.block(`<blockquote>\n${this.blocks(this.rest())}</blockquote>`); },
  verse() { return this.block(`<blockquote class="verse">\n${this.blocks(this.rest())}</blockquote>`); },
  abstract() {
    return this.block(`<div class="abstract">\n<p class="abstract-title">Abstract</p>\n${this.blocks(this.rest())}</div>`);
  },
  itemize() { return this.list('itemize'); },
  enumerate() { return this.list('enumerate'); },
  description() { return this.list('description'); },
  compactitem() { return this.list('itemize'); },
  compactenum() { return this.list('enumerate'); },
  tabular(name) { return this.tabular(name); },
  'tabular*'(name) { return this.tabular(name); },
  tabularx(name) { return this.tabular(name); },
  tabulary(name) { return this.tabular(name); },
  longtable(name) { return this.tabular(name); },
  table(name) { return this.float(name); },
  figure(name) { return this.float(name); },
  wrapfigure(name) { return this.float(name); },
  wraptable(name) { return this.float(name); },
  subfigure() {
    this.opt();
    this.arg();
    return this.block(`<div class="subfigure">\n${this.blocks(this.rest())}</div>`);
  },
  minipage() {
    this.opt(); this.opt(); this.opt();
    const width = cssLength(this.arg());
    const style = width ? ` style="width:${width}"` : '';
    return this.block(`<div class="minipage"${style}>\n${this.blocks(this.rest())}</div>`);
  },
  multicols() {
    const n = parseInt(this.arg(), 10) || 2;
    this.opt();
    return this.block(`<div class="multicols" style="columns:${n}">\n${this.blocks(this.rest())}</div>`);
  },
  thebibliography() { return this.bibliography(); },
  proof() {
    const title = this.opt();
    const head = `<span class="proof-head">${title !== null ? this.inline(title).trim() : 'Proof'}.</span>`;
    let html = runIn(head, this.blocks(this.rest()));
    const qed = '<span class="qed" aria-hidden="true">∎</span>';
    html = /<\/p>\s*$/.test(html) ? html.replace(/<\/p>(\s*)$/, ` ${qed}</p>$1`) : `${html}<p>${qed}</p>`;
    return this.block(`<div class="proof">\n${html}</div>`);
  },
  math() { return this.renderTex(this.rest(), false); },
});

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Convert LaTeX source to HTML.
 *
 * options.renderMath(tex, displayMode) -> HTML string; may throw on bad input.
 * options.files: { name: content } or name => content|null. Used for \input
 *   (text) and \includegraphics (a URL or data: URL).
 *
 * Returns { title, body, hasMath, warnings: [{ message, count }] }.
 */
export function convert(source, options = {}) {
  return new Converter(options).run(String(source));
}

export const DOCUMENT_CSS = `
:root { color-scheme: light dark; --text: #1d1f23; --muted: #5d6470; --bg: #ffffff; --rule: #c9ced6; --link: #0b57d0; --soft: #f4f6f8; }
@media (prefers-color-scheme: dark) {
  :root { --text: #e3e5e8; --muted: #a2a9b4; --bg: #15171b; --rule: #3b414b; --link: #8ab4f8; --soft: #20242a; }
}
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--text); font: 18px/1.6 "Latin Modern Roman", "CMU Serif", Charter, "Bitstream Charter", Georgia, "Times New Roman", serif; -webkit-text-size-adjust: 100%; }
.latex-doc { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; overflow-wrap: break-word; }
a { color: var(--link); }
p { margin: 0 0 1em; text-align: justify; hyphens: auto; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.8em 0 .6em; font-weight: 700; }
h2 { font-size: 1.45em; } h3 { font-size: 1.2em; } h4 { font-size: 1.05em; } h5, h6 { font-size: 1em; }
.secnum { margin-right: .6em; }
h2.part { text-align: center; font-size: 1.8em; }
.run-in { margin-right: .4em; }
.title-block { text-align: center; margin: 1rem 0 2.5rem; }
.title-block .title { font-size: 2em; margin: 0 0 .6em; }
.authors { display: flex; flex-wrap: wrap; justify-content: center; gap: .3em 2.5em; font-size: 1.1em; }
.date { margin: .8em 0 0; text-align: center; color: var(--muted); }
.abstract { margin: 0 auto 2em; max-width: 36rem; font-size: .92em; }
.abstract-title { text-align: center; font-weight: 700; margin-bottom: .4em; }
.toc { margin: 0 0 2em; }
.toc h2 { margin-top: 0; }
.toc ul { list-style: none; padding-left: 0; margin: 0; }
.toc ul ul { padding-left: 1.6em; }
.toc a { text-decoration: none; color: inherit; }
.toc a:hover { text-decoration: underline; }
.center { text-align: center; }
.center p { text-align: center; }
.flushleft, .flushleft p { text-align: left; }
.flushright, .flushright p { text-align: right; }
blockquote { margin: 0 0 1em; padding: 0 2em; }
blockquote.verse p { text-align: left; }
ul, ol, dl { margin: 0 0 1em; padding-left: 1.8em; }
li { margin: .25em 0; }
li > p:last-child, dd > p:last-child { margin-bottom: 0; }
ol ol { list-style-type: lower-alpha; } ol ol ol { list-style-type: lower-roman; } ol ol ol ol { list-style-type: upper-alpha; }
li.labeled { list-style: none; }
.item-label { display: inline-block; min-width: 1.4em; margin-left: -1.6em; margin-right: .2em; font-weight: 700; }
dt { font-weight: 700; } dd { margin: 0 0 .6em 1.8em; }
code, pre { font-family: "Latin Modern Mono", "CMU Typewriter Text", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em; }
pre { background: var(--soft); padding: .8em 1em; border-radius: 6px; overflow-x: auto; line-height: 1.45; margin: 0 0 1em; }
.sc { font-variant: small-caps; } .sf { font-family: system-ui, sans-serif; } .rm { font-style: normal; font-weight: normal; }
.nowrap { white-space: nowrap; }
.fbox { border: 1px solid currentColor; padding: 0 .25em; }
.colorbox { padding: 0 .25em; }
.size-tiny { font-size: .5em; } .size-scriptsize { font-size: .7em; } .size-footnotesize { font-size: .8em; }
.size-small { font-size: .9em; } .size-normalsize { font-size: 1em; } .size-large { font-size: 1.2em; }
.size-large-2 { font-size: 1.44em; } .size-large-3 { font-size: 1.73em; } .size-huge { font-size: 2.07em; } .size-huge-2 { font-size: 2.49em; }
.tex-logo { font-family: inherit; white-space: nowrap; }
.tex-logo sub, .tex-logo sup { text-transform: uppercase; font-size: .8em; line-height: 0; }
.tex-logo sup { vertical-align: .3em; margin: 0 -.1em 0 -.3em; font-size: .72em; }
.tex-logo sub { vertical-align: -.42em; margin: 0 -.06em 0 -.12em; font-size: 1em; }
.math-display { display: flex; align-items: center; gap: 1em; margin: 0 0 1em; }
.math-display .eqn { flex: 1; min-width: 0; overflow-x: auto; overflow-y: hidden; text-align: center; padding: .2em 0; }
.math-display .katex-display { margin: 0; }
.eqno { flex: none; }
.math-tex, .math-error { font-family: ui-monospace, Menlo, monospace; font-size: .88em; }
.math-error { color: #c62828; }
figure.float { margin: 1.5em 0; text-align: center; }
figure.float img { max-width: 100%; height: auto; }
figure.float p { text-align: center; }
img { max-width: 100%; height: auto; }
figcaption, .caption { font-size: .92em; margin: .6em auto; max-width: 36rem; text-align: left; }
.caption-label { font-weight: 700; }
.subfigure, .minipage { display: inline-block; vertical-align: top; text-align: left; max-width: 100%; }
.subfigure { margin: 0 .5em; }
table.tabular { border-collapse: collapse; margin: 0 auto 1em; font-size: .95em; }
table.tabular td { padding: .25em .7em; vertical-align: top; }
td.left { text-align: left; } td.center { text-align: center; } td.right { text-align: right; }
td.bl { border-left: 1px solid var(--text); } td.br { border-right: 1px solid var(--text); }
td.bt { border-top: 1px solid var(--text); } td.bb { border-bottom: 1px solid var(--text); }
td.bt2 { border-top: 3px double var(--text); } td.bb2 { border-bottom: 3px double var(--text); }
.theorem { margin: 0 0 1em; }
.theorem-plain p { font-style: italic; }
.thm-head { font-weight: 700; font-style: normal; }
.proof-head { font-style: italic; }
.qed { float: right; }
.fnref a, .cite, .ref { text-decoration: none; }
.footnotes { margin-top: 3em; padding-top: 1em; border-top: 1px solid var(--rule); font-size: .88em; }
.footnotes ol { padding-left: 1.4em; }
.fnback { text-decoration: none; }
.bibliography ol { list-style: none; padding-left: 0; }
.bibliography li { padding-left: 2.6em; text-indent: -2.6em; margin: .4em 0; }
.bib-label { display: inline-block; min-width: 2.2em; text-indent: 0; }
@media print { body { font-size: 11pt; } .latex-doc { max-width: none; padding: 0; } a { color: inherit; } }
`;

/**
 * Wrap a conversion result in a complete HTML page.
 * options.stylesheets: extra stylesheet URLs (e.g. KaTeX's CSS).
 */
export function renderDocument(result, options = {}) {
  const links = (options.stylesheets || [])
    .map(href => `<link rel="stylesheet" href="${escapeHtml(href)}">\n`).join('');
  return `<!doctype html>
<html lang="${escapeHtml(options.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="latex2html (https://github.com/ibipul/latex2html)">
<title>${escapeHtml(result.title || 'Document')}</title>
${links}<style>${DOCUMENT_CSS}</style>
</head>
<body>
<main class="latex-doc">
${result.body}</main>
</body>
</html>
`;
}
