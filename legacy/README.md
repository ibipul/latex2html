# Original flex/bison converter

These are the original sources, kept for history. They are not used by the
current converter in [`../src/latex2html.js`](../src/latex2html.js).

The lexer (`latex2html.l`) and grammar (`latex2html.y`) were written for a
second-year Compiler Design course taught by Prof. Mandar Mitra. They handle a
fixed document shape (`\documentclass`, `\title`, `\author`, `\date`, body) with
sections, bold/italic, `enumerate`, simple `tabular`, `thebibliography`, and a
small subset of math written out as MathML.

To build and run them (needs flex, bison and a C compiler):

```sh
sh command.sh                       # flex + yacc + gcc -> ./latex2html
./latex2html out.html < ../examples/turing.tex > log.txt
```

The output file name is the first argument; the LaTeX source is read from
standard input; `log.txt` receives the token trace, useful for finding where a
parse failed.
