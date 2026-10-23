flex latex2html.l
yacc -d -t latex2html.y
gcc -o latex2html y.tab.c lex.yy.c -lfl
