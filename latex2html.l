%{ /* ISI@CAL */ 


#include "y.tab.h"
#include<stdio.h>
#include<string.h>

int intext = 0, incomment = 0, inmath = 0, inlist=0, inbib=0;
%}

ws  	[ \t]+
integer		[0-9]+
letters		[a-zA-Z]
punc            (\.|\,|\!|\?|\:|\;|"'")

sword       ("\\"[a-zA-Z]+|"\\"[a-zA-Z*]+)
special         (\_|"\&"|"\$"|"\#"|"@")
operator	("+"|"-"|"=")
greek       ("\\alpha"|"\\beta"|"\\gamma"|"\\delta"|"\\epsilon"|"\\zeta"|"\\eta"|"\\theta"|"\\iota"|"\\kappa"|"\\lambda"|"\\mu"|"\\nu"|"\\xi"|"\\omicron"|"\\pi"|"\\rho"|"\\sigma"|"\\tau"|"\\upsilon"|"\\phi"|"\\psi"|"\\omega"|"\\Alpha"|"\\Beta"|"\\Gamma"|"\\Delta"|"\\Epsilon"|"\\Zeta"|"\\Eta"|"\\Theta"|"\\Iota"|"\\Kappa"|"\\Lambda"|"\\Mu"|"\\Nu"|"\\Xi"|"\\Omicron"|"\\Pi"|"\\Rho"|"\\Sigma"|"\\Tau"|"\\Upsilon"|"\\Phi"|"\\Psi"|"\\Omega"|"\\int"|"\\inf"|"\\exp"|"\\cup")
word		(({punc}|[a-zA-Z0-9]|{greek})+|"("|")")
%%
"\\\\" 			{if(incomment==1); else{printf(" %s \n", yytext);; return(DBLBS);}}
"\\"			{printf(" %s ", yytext);; return(BACKSL);}
"{"			{printf(" %s ", yytext);;return(LCURLYB);}
"}"			{printf(" %s ", yytext);;return(RCURLYB);}
"\\ "       {}
"\\documentclass"         {printf(" %s ", yytext);; return(DOCUMENTCLASS);}
"article"		{printf(" %s ", yytext);; return(ARTICLE);}
"proc"			{printf(" %s ", yytext);; return(PROC);}
"letter"		{printf(" %s ", yytext);; return(LETTER);}
"\\title"                 {printf(" %s ", yytext);; return(TITLE);}
"\\date"        {printf(" %s ",yytext);; return(DATE);}
"\\author"      {printf(" %s ",yytext);; return(AUTHOR);}
"\\langle"       { printf(" %s ",yytext);; if(inmath==1) return (LANGLE);else return(WORD);}
"\\rangle"       { printf(" %s ",yytext);; if(inmath==1) return (RANGLE);else return(WORD);}
"\\%"            { if(inmath==1) return (OPERATOR);else{printf(" %s ",yytext);yytext="%";return(WORD);}}
"|"			{printf(" %s ", yytext);; return(PIPE);}
"&"                     {printf(" %s ", yytext);; return(AMPERSAND);}
"$"                     {printf(" %s ", yytext);; if(inmath == 0) inmath = 1;else inmath= 0; return(DOLLARMATH);}
"^"                     {printf(" %s ", yytext);; return(SUPERSCRIPT);}
"_"                     {printf(" %s ", yytext);; return(SUBSCRIPT);}
{special}		{printf(" %s ", yytext);; return(WORD);}
{operator}              {printf(" %s ", yytext);;yylval.arr = strdup(yytext); if(inmath == 1) return(OPERATOR); else return(WORD);}
"["			{printf(" %s ", yytext);; return(LSQRB);}
"]"			{printf(" %s ", yytext);; return(RSQRB);}
"\\begin{math}"                     {printf(" %s ", yytext);; inmath = 1; return(DOLLARMATH);}
"\\end{math}"                     {printf(" %s ", yytext);; inmath = 0; return(DOLLARMATH);}
"\\begin{enumerate}"                     {printf(" %s ", yytext);;inlist++; return(STARTLIST);}
"\\end{enumerate}"                     {printf(" %s ", yytext);; inlist--; return(ENDLIST);}
"\\begin{list1}"                     {printf(" %s ", yytext);;inlist++; return(STARTLIST);}
"\\end{list1}"                     {printf(" %s ", yytext);; inlist--; return(ENDLIST);}
"\\begin{list2}"                     {printf(" %s ", yytext);;inlist++; return(STARTLIST);}
"\\end{list2}"                     {printf(" %s ", yytext);; inlist--; return(ENDLIST);}
"\\begin{thebibliography}"                     {printf(" %s ", yytext);;inbib=1; return(STARTBIB);}
"\\end{thebibliography}"                     {printf(" %s ", yytext);;inbib=0; return(ENDBIB);}
"\\item"                 {printf(" %s ", yytext);;if(inlist>0) return(ITEM);else return(SWORD);}
"\\item[]"                 {printf(" %s ", yytext);;if(inlist>0) return(ITEM);else return(SWORD);}
"\\bibitem"                 {printf(" %s ", yytext);;if(inbib==1) return(BIBITEM);else return(SWORD);}
"\\begin{document}"     {printf(" %s ", yytext);; intext = 1;return(LBEGINDOCU);}
"\\end{document}"     {printf(" %s ", yytext);; intext = 0;return(LENDDOCU);}
"\\section"              {printf(" %s ", yytext);; intext = 1;return(SECTION);}
"\\begin{table}"     {printf(" %s ", yytext);; intext = 1;return(BEGINTABLE);}
"\\end{table}"     {printf(" %s ", yytext);; intext = 0;return(ENDTABLE);}
"\\begin{tabular}"     {printf(" %s ", yytext);; intext = 1;return(BEGINTABULAR);}
"\\end{tabular}"     {printf(" %s ", yytext);;return(ENDTABULAR);}
"\\textbf"			{printf(" %s ", yytext);; return(BOLDFACE);}
"\\bf"			{printf(" %s ", yytext);; return(BOLDFACE);}
"\\textit"			{printf(" %s ", yytext);; return(ITALICS);}
"\\em"			{printf(" %s ", yytext);; return(ITALICS);}
"\\emph"			{printf(" %s ", yytext);; return(ITALICS);}
"\\param"			{printf(" %s ", yytext);; return(ITALICS);}
"\\hspace"			{printf(" %s ", yytext);; return(HSPACE);}
"\\hline"		{printf(" %s ", yytext);; return(HLINE);}
"b"			{printf(" %s ", yytext);; if(inmath == 0) return(B); else {yylval.arr = strdup(yytext); return(LETTERS);}}
"c"			{printf(" %s ", yytext);; if(inmath == 0) return(C); else {yylval.arr = strdup(yytext); return(LETTERS);}}
"h"			{printf(" %s ", yytext);; if(inmath == 0) return(H); else {yylval.arr = strdup(yytext); return(LETTERS);}}
"l"			{printf(" %s ", yytext);; if(inmath == 0) return(L); else {yylval.arr = strdup(yytext); return(LETTERS);}}
"r"			{printf(" %s ", yytext);; if(inmath == 0) return(R); else {yylval.arr = strdup(yytext); return(LETTERS);}}
"t"			{printf(" %s ", yytext);; if(inmath == 0) return(T); else {yylval.arr = strdup(yytext); return(LETTERS);}}
"\\frac"		{printf(" %s ", yytext);; return(FRAC);}
"\\sqrt"		{printf(" %s ", yytext);; return(SQRT);}
"\\infty"       {printf(" %s ", yytext);;  if(inmath == 1){ yytext="&inf"; yylval.arr = strdup(yytext);return(GREEK);}else{ yylval.arr = strdup(yytext); return(LETTERS);}}
{greek}         {printf(" %s ", yytext);;  if(inmath == 1){ yytext[0]='&'; yylval.arr = strdup(yytext);return(GREEK);}else{ yylval.arr = strdup(yytext); return(LETTERS);}}
{letters}		{printf(" %s ", yytext);; if(inmath == 1) {yylval.arr = strdup(yytext); return(LETTERS);}else{yylval.arr = strdup(yytext); return(WORD);}}
{integer}		{printf(" %s ", yytext);; /* if(incomment == 0) */ yylval.val = atoi(yytext); return(INTEGER);}

{word}			{printf(" %s ", yytext);; yylval.arr = strdup(yytext); if(inmath == 1) return(LETTERS); else return(WORD); }
{ws}                    {/* printf(" %s ", yytext);;  return(WS); */}
"\\n"			{}

{sword}         {printf(" %s",yytext);; yytext=" ";return(SWORD);}
.               {printf("Cannot Parse. \n");;}
%%
