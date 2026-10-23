import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { convert, renderDocument } from '../src/latex2html.js';

// A stand-in math renderer so the tests don't depend on KaTeX.
const renderMath = (tex, display) => `<m${display ? ' d' : ''}>${tex}</m>`;
const html = (src, opts = {}) => convert(src, { renderMath, ...opts }).body;
const doc = body => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;

test('paragraphs, quotes, dashes and escaping', () => {
  const out = html("First ``quoted'' line --- with 1--2 & <b>.\n\nSecond paragraph.");
  assert.equal(out, '<p>First “quoted” line — with 1–2 &amp; &lt;b&gt;.</p>\n<p>Second paragraph.</p>\n');
});

test('comments are removed but \\% is kept', () => {
  assert.equal(html('50\\% done % hidden\nnext'), '<p>50% done next</p>\n');
});

test('title block from the preamble', () => {
  const out = html('\\title{On \\emph{Things}}\\author{A \\and B}\\date{2024}\n\\begin{document}\\maketitle\nHi\\end{document}');
  assert.match(out, /<h1 class="title">On <em>Things<\/em><\/h1>/);
  assert.match(out, /<span class="author">A<\/span><span class="author">B<\/span>/);
  assert.match(out, /<p class="date">2024<\/p>/);
  assert.equal(convert('\\title{On \\emph{Things}}').title, 'On Things');
});

test('title block is shown even without \\maketitle', () => {
  assert.match(html('\\title{T}\\begin{document}x\\end{document}'), /<h1 class="title">T<\/h1>/);
});

test('sections are numbered and referenced', () => {
  const out = html(doc('\\section{Intro}\\label{s:i}\\subsection{Detail}\\section*{Plain}See \\ref{s:i}.'));
  assert.match(out, /<h2 id="sec-1"><span class="secnum">1<\/span> Intro<\/h2>/);
  assert.match(out, /<h3 id="sec-1.1"><span class="secnum">1.1<\/span> Detail<\/h3>/);
  assert.match(out, /<h2 id="sec-x\d+">Plain<\/h2>/);
  assert.match(out, /See <a href="#sec-1" class="ref">1<\/a>\./);
});

test('table of contents', () => {
  const out = html(doc('\\tableofcontents\\section{A}\\subsection{B}\\section{C}'));
  assert.match(out, /<nav class="toc">[\s\S]*<a href="#sec-1">.*A<\/a><ul><li><a href="#sec-1.1">.*B<\/a><\/li><\/ul><\/li><li><a href="#sec-2">/);
});

test('font commands and scoped declarations', () => {
  assert.equal(html('\\textbf{b} \\textit{i} \\texttt{t} {\\bfseries x y} z'),
    '<p><strong>b</strong> <i>i</i> <code>t</code> <strong>x y</strong> z</p>\n');
});

test('accents and symbols', () => {
  assert.equal(html("caf\\'e na\\\"ive \\c{c} \\ldots{} \\S"), '<p>café naïve ç … §</p>\n');
});

test('nested lists, custom labels and description lists', () => {
  const out = html('\\begin{itemize}\\item a\\begin{enumerate}\\item x\\label{i:x}\\end{enumerate}\\item[*] b\\end{itemize} \\ref{i:x}');
  assert.match(out, /<ul>\n<li><p>a<\/p>\n<ol>\n<li id="item-\d+">x<\/li>\n<\/ol><\/li>/);
  assert.match(out, /<li class="labeled"><span class="item-label">\*<\/span> b<\/li>/);
  assert.match(out, /class="ref">a<\/a>/); // second-level enumerate items are lettered
  assert.match(html('\\begin{description}\\item[Key] value\\end{description}'), /<dt>Key<\/dt>\n<dd>value<\/dd>/);
});

test('inline and display math', () => {
  assert.equal(html('$x^2$ and \\(y\\)'), '<p><m>x^2</m> and <m>y</m></p>\n');
  const out = html('a\\[ E=mc^2 \\]b');
  assert.match(out, /<p>a<\/p>\n<div class="math-display"><div class="eqn"><m d>E=mc\^2<\/m><\/div><\/div>\n<p>b<\/p>/);
  assert.equal(html('cost: \\$5'), '<p>cost: $5</p>\n');
});

test('numbered equations, labels and \\eqref', () => {
  const out = html('\\begin{equation}a=b\\label{e:1}\\end{equation}\\begin{align}x&=1\\\\y&=2\\end{align}\\eqref{e:1}');
  assert.match(out, /<m d>a=b<\/m><\/div><span class="eqno">\(1\)<\/span>/);
  assert.match(out, /<m d>\\begin\{aligned\}x&=1\\\\y&=2\\end\{aligned\}<\/m><\/div><span class="eqno">\(2\)<\/span>/);
  assert.match(out, /<a href="#eq-\d+" class="ref">\(1\)<\/a>/);
  assert.doesNotMatch(html('\\begin{equation*}a\\end{equation*}'), /eqno/);
});

test('math errors become warnings, not crashes', () => {
  const r = convert('$\\bad$', { renderMath: () => { throw new Error('KaTeX parse error: Undefined control sequence'); } });
  assert.match(r.body, /<code class="math-error"/);
  assert.equal(r.warnings[0].message, 'Math error: Undefined control sequence');
});

test('without a renderer, math stays as escaped TeX', () => {
  assert.equal(convert('$a<b$').body, '<p><span class="math-tex">\\(a&lt;b\\)</span></p>\n');
});

test('user macros with arguments and defaults', () => {
  const src = '\\newcommand{\\pair}[2]{(#1, #2)}\\newcommand\\hi[1][World]{Hello #1}\\def\\x{X}\\DeclareMathOperator{\\tr}{tr}'
    + '\\pair{a}{b} \\hi \\hi[You] \\x $\\tr A$';
  assert.equal(html(src), '<p>(a, b) Hello World Hello You X <m>\\operatorname{tr} A</m></p>\n');
});

test('custom environments', () => {
  const out = html('\\newenvironment{note}[1]{\\textbf{#1:} }{ (end)}\\begin{note}{Tip}text\\end{note}');
  assert.equal(out, '<p><strong>Tip:</strong> text (end)</p>\n');
});

test('verbatim, \\verb and listings are left untouched', () => {
  const out = html('\\verb|\\x{%}| \\begin{verbatim}\n$a$ % not a comment\n\\end{verbatim}\n\\begin{lstlisting}[language=Python]\nx = 1\n\\end{lstlisting}');
  assert.match(out, /<code>\\x\{%\}<\/code>/);
  assert.match(out, /<pre><code>\$a\$ % not a comment<\/code><\/pre>/);
  assert.match(out, /<pre><code class="language-python">x = 1<\/code><\/pre>/);
});

test('tabular with rules, borders and spanning cells', () => {
  const out = html('\\begin{tabular}{|l|c|}\\hline\\multicolumn{2}{|c|}{Head}\\\\\\hline a & b\\\\ c & d\\\\\\hline\\end{tabular}');
  assert.match(out, /<td class="center bl br bt" colspan="2">Head<\/td>/);
  assert.match(out, /<tr><td class="left bl bt">a<\/td><td class="center bl br bt">b<\/td><\/tr>/);
  assert.match(out, /<tr><td class="left bl bb">c<\/td><td class="center bl br bb">d<\/td><\/tr>/);
});

test('multirow cells skip the placeholder cells below them', () => {
  const out = html('\\begin{tabular}{ll}\\multirow{2}{*}{X} & a \\\\ & b \\\\\\end{tabular}');
  assert.match(out, /<td class="left" rowspan="2">X<\/td><td class="left">a<\/td><\/tr>\n<tr><td class="left">b<\/td><\/tr>/);
});

test('figures and tables get numbered captions', () => {
  const out = html('\\begin{figure}\\includegraphics[width=0.5\\textwidth]{p.png}\\caption{Plot}\\label{f}\\end{figure}Fig.~\\ref{f}',
    { files: { 'p.png': 'data:image/png;base64,AAAA' } });
  assert.match(out, /<img src="data:image\/png;base64,AAAA" alt="p" style="width:50%">/);
  assert.match(out, /<figcaption id="figure-1"><span class="caption-label">Figure 1:<\/span> Plot<\/figcaption>/);
  assert.match(out, /Fig\.&nbsp;<a href="#figure-1" class="ref">1<\/a>/);
});

test('missing images and inputs produce warnings', () => {
  const r = convert('\\input{defs}\\includegraphics{missing}');
  assert.deepEqual(r.warnings.map(w => w.message), ['File not provided: defs (from \\input)', 'Image not provided: missing']);
});

test('\\input reads provided files', () => {
  assert.equal(html('A \\input{part} C', { files: { 'chapters/part.tex': 'B' } }), '<p>A B C</p>\n');
});

test('footnotes', () => {
  const out = html('Text\\footnote{Note \\emph{here}.} more.');
  assert.match(out, /Text<sup class="fnref"><a href="#fn-1" id="fnref-1">1<\/a><\/sup> more\./);
  assert.match(out, /<li id="fn-1">Note <em>here<\/em>\. <a href="#fnref-1"/);
});

test('citations and bibliography', () => {
  const out = html('See \\cite[p.~2]{a,b}.\\begin{thebibliography}{9}\\bibitem{a} First.\\bibitem[Kn]{b} Second.\\end{thebibliography}');
  assert.match(out, /See \[<a href="#bib-1" class="cite">1<\/a>, <a href="#bib-2" class="cite">Kn<\/a>, p\.&nbsp;2\]\./);
  assert.match(out, /<li id="bib-2"><span class="bib-label">\[Kn\]<\/span> Second\.<\/li>/);
});

test('undefined references and citations are flagged', () => {
  const r = convert('\\ref{nope} \\cite{gone}');
  assert.equal(r.body, '<p>?? [?]</p>\n');
  assert.deepEqual(r.warnings.map(w => w.message).sort(), ['Undefined citation: gone', 'Undefined reference: nope']);
});

test('theorems, shared counters and proofs', () => {
  const src = '\\newtheorem{theorem}{Theorem}[section]\\newtheorem{lemma}[theorem]{Lemma}'
    + '\\section{S}\\begin{theorem}[Main]\\label{t}Claim.\\end{theorem}\\begin{lemma}L.\\end{lemma}'
    + '\\begin{proof}Done.\\end{proof}\\autoref{t}';
  const out = html(src);
  assert.match(out, /<div class="theorem theorem-plain" id="theorem-1-1">\n<p><span class="thm-head">Theorem 1\.1 \(Main\)\.<\/span> Claim\.<\/p>/);
  assert.match(out, /<span class="thm-head">Lemma 1\.2\.<\/span>/);
  assert.match(out, /<p><span class="proof-head">Proof\.<\/span> Done\. <span class="qed"/);
  assert.match(out, /Theorem&nbsp;1\.1<\/a>/);
});

test('unknown commands keep their text and are reported', () => {
  const r = convert('\\mystery{kept} text \\mystery');
  assert.equal(r.body, '<p>kept text</p>\n');
  assert.deepEqual(r.warnings, [{ message: 'Unsupported command: \\mystery', count: 2 }]);
});

test('unknown environments keep their content', () => {
  const r = convert('\\begin{weird}inside\\end{weird}');
  assert.equal(r.body, '<div class="env-weird">\n<p>inside</p>\n</div>\n');
});

test('unsafe link targets are neutralised', () => {
  assert.match(html('\\href{javascript:alert(1)}{x}'), /<a href="#">x<\/a>/);
  assert.match(html('\\url{https://a.b/c\\_d?e=1\\&f}'), /href="https:\/\/a\.b\/c_d\?e=1&amp;f"/);
});

test('renderDocument wraps the body in a full page', () => {
  const page = renderDocument({ title: 'A & B', body: '<p>x</p>\n' }, { stylesheets: ['k.css'] });
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<title>A &amp; B<\/title>/);
  assert.match(page, /<link rel="stylesheet" href="k.css">/);
  assert.match(page, /<main class="latex-doc">\n<p>x<\/p>\n<\/main>/);
});

test('the bundled examples convert', () => {
  for (const name of ['turing', 'showcase']) {
    const src = readFileSync(new URL(`../examples/${name}.tex`, import.meta.url), 'utf8');
    const r = convert(src, { renderMath });
    assert.ok(r.body.length > 1000, name);
    assert.doesNotMatch(r.body, /[\u0001-\u0005]/, `${name}: internal markers leaked`);
  }
  const showcase = convert(readFileSync(new URL('../examples/showcase.tex', import.meta.url), 'utf8'), { renderMath });
  assert.deepEqual(showcase.warnings, []);
});
