#!/usr/bin/env node
// Command-line front end: latex2html input.tex [-o output.html] [--mathml] [--fragment]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { convert, renderDocument } from '../src/latex2html.js';

const KATEX_CSS = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Usage: latex2html [input.tex] [-o output.html] [--mathml] [--fragment]

Reads LaTeX from input.tex (or standard input) and writes HTML to
output.html (or standard output).

  -o, --output FILE  write to FILE
  --mathml           write math as MathML only (no KaTeX stylesheet needed)
  --fragment         write only the converted body, not a full HTML page`);
  process.exit(0);
}

let input = null, output = null;
for (let k = 0; k < args.length; k++) {
  const a = args[k];
  if (a === '-o' || a === '--output') output = args[++k];
  else if (!a.startsWith('--')) input = a;
}
const mathml = args.includes('--mathml');
const fragment = args.includes('--fragment');

const source = readFileSync(input && input !== '-' ? input : 0, 'utf8');
const baseDir = input && input !== '-' ? dirname(resolve(input)) : process.cwd();

// \input files are read from disk; images keep their relative path.
const files = name => {
  const path = resolve(baseDir, name);
  if (!existsSync(path)) return null;
  return extname(path).toLowerCase() === '.tex' ? readFileSync(path, 'utf8') : name;
};

let katex = null;
try {
  katex = (await import('katex')).default;
} catch {
  console.error('latex2html: KaTeX is not installed (run `npm install`); math will be left as TeX source.');
}
const renderMath = katex && ((tex, displayMode) => katex.renderToString(tex, {
  displayMode, throwOnError: true, strict: 'ignore', output: mathml ? 'mathml' : 'htmlAndMathml',
}));

const result = convert(source, { files, renderMath });
for (const w of result.warnings) console.error(`warning: ${w.message}${w.count > 1 ? ` (x${w.count})` : ''}`);

const stylesheets = result.hasMath && katex && !mathml ? [KATEX_CSS] : [];
const html = fragment ? result.body : renderDocument(result, { stylesheets });
if (output) writeFileSync(output, html);
else process.stdout.write(html);
