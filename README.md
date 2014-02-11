Authors

-------

 - Bipul Islam
 - HIrak Sarkar
 - Ritankar Mandal

----------------

# Latex to Html Converter
Here flex (LEX) and bison (YACC) has been used to design a Html to Latex Converter. The parser part is tackled by a flex script, and the Bison takes care of the conversion grammer.


 * The converter is successful for moderately complex LaTeX files. Highly intricate preambles may cause the program to fail. 
 * Mathematical expressions have been tackled in the sense the greek alphabets are represented in their true form in the Html files, however, all Complex mathematical expressions may not be successfully converted. Grammer still needs work.
 * Standard latex Tables have been implemented, but there is a chance varied tabular depictions may fail. 
 * All shift-reduce, reduce reduce conflicts could not be completely removed. Implementation works reasonably well for the LaTeX files of the type of example .tex file that has been included.

>#####*Note: This was developed as a part of Second Year 1st semester Compiler design course assignment. Course was taken by Prof. Mandar Mitra.*


####Usage

-------

```
flex latex2html.l
yacc -d -t latex2html.y
gcc -o latex2html y.tab.c lex.yy.c -lfl
```

or you can use the included **command.sh** shell script
```
$sh command.sh
```
This will generate an object file named: **latex2html**
If for example we want to parse the example **.tex** file included we'll execute the following command
```
./latex2html turin-in-html.html < turing.tex > log.txt
```
The .tex file has to be included within left (<) and right (>) angular brackets, they are used as the redirecting operators.

Log file will be useful for debugging, incase of errors, where exactly in the input *.tex* file the parsing had failed.
