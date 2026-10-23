%{ /* ISI@CAL */ 

#include <stdio.h>
#include <ctype.h>
#include <string.h>

int yydebug = 1;
FILE *newHtml ;
int mathflag = 0;
int tablewidth = 0;
int inhtml=0,inbody=0;

%}

%union 
{
  char*	arr;
	int	val;
}

%start latexstatement

%token  DBLBS    BACKSL    LCURLYB    RCURLYB    END	PIPE HLINE	AMPERSAND 
%token  SPECCHAR LSQRB     RSQRB      LBEGIN      SECTION    TABLE	SUPERSCRIPT LANGLE RANGLE
%token  TABULAR  VSPACE    B          C           H          L		BEGINTABULAR ENDTABULAR
%token  T        R         DOCUMENTCLASS	SUBSCRIPT	DOLLARMATH BEGINTABLE ENDTABLE
%token  ARTICLE  PROC      LETTER     TITLE       LBEGINDOCU  LENDDOCU STARTBIB ENDBIB
%token	SQRT	FRAC  BOLDFACE ITALICS	WS	HSPACE SWORD STARTLIST ENDLIST ITEM BIBITEM
%token <arr> DATE
%token <arr> AUTHOR
%type <arr> operand
%token <arr> WORD 
%token <arr> GREEK
%token <arr> LETTERS
%token <arr> OPERATOR
%token <val> INTEGER

%%

latexstatement   :  documenttype{fprintf(newHtml,"<html><head> <title>  \n"); inhtml=1;}  titletype author date LBEGINDOCU{fprintf(newHtml,"<body>\n");inbody=1; }  mainbody {fprintf(newHtml,"</body>\n"); } LENDDOCU {fprintf(newHtml,"</html> \n"); }
                 ;
author      : AUTHOR LCURLYB{fprintf(newHtml,"<i> Author:: "); } formattedtextoption RCURLYB{fprintf(newHtml,"</i></br> "); }
            |
            ;
date        : DATE LCURLYB{fprintf(newHtml,"<i> Date:: "); } formattedtextoption RCURLYB{fprintf(newHtml,"</i></br><hr> "); }
            |
              ;
ignore      :SWORD LCURLYB bword RCURLYB LSQRB bword RSQRB ignore
            | SWORD LSQRB bword RSQRB LCURLYB bword RCURLYB ignore 
            |SWORD LCURLYB bword RCURLYB ignore 
            | LCURLYB bword RCURLYB ignore
            | SWORD LCURLYB bword RCURLYB
            | LCURLYB bword RCURLYB
            | SWORD ignore
            |
            ;
listoption        : STARTLIST {fprintf(newHtml,"<ol> "); } listitem ENDLIST {fprintf(newHtml,"</ol> "); }
            | 
            ;
listitem    : ITEM{fprintf(newHtml,"<li> "); } listoption formattedtextoption {fprintf(newHtml,"</li> "); } listitem
            |
            ; 

bword      :  bword WORD 
		 |  bword INTEGER
		 | bword ignore
		 |  WORD
		 |  INTEGER
		 | LETTERS
		 | bword mathoption
		 |
		 ;
bibliography: STARTBIB LCURLYB textoption RCURLYB{fprintf(newHtml,"<hr> <b>The References</b></br><ol> "); } biblist  ENDBIB {fprintf(newHtml,"</ol> "); }
            ;

biblist: BIBITEM LSQRB bword RSQRB LCURLYB bword RCURLYB {fprintf(newHtml,"<li> "); } formattedtextoption {fprintf(newHtml,"</li> "); } biblist
        |
        ;
		 
documenttype     :  DOCUMENTCLASS  LCURLYB  type  RCURLYB ignore
                 |  DOCUMENTCLASS LSQRB bword RSQRB LCURLYB type RCURLYB ignore
           		 ;

type		 : ARTICLE
               |PROC
               |LETTER              
               ;   
          

titletype        :  TITLE  LCURLYB  formattedtextoption RCURLYB {fprintf(newHtml,"</title>\n"); }
		          |{fprintf(newHtml,"</title>\n");}
                 ;


mainbody         :  mainbody  mainoption
                 |  mainoption
                 ;

mainoption       :  formattedtextoption
		 |  tableoption
		 |  mathoption
		 | listoption
		 |bibliography
		 |section
                 ;

formattedtextoption:	BOLDFACE LCURLYB {fprintf(newHtml,"<b>\n");} formattedtextoption RCURLYB {fprintf(newHtml,"</b>\n");} formattedtextoption
           |    ITALICS LCURLYB {fprintf(newHtml,"<i>\n");} formattedtextoption RCURLYB {fprintf(newHtml,"</i>\n");} formattedtextoption
           |    ignore textoption ignore
		   ;
section: SECTION LCURLYB{fprintf(newHtml,"<hr><b>\n");} formattedtextoption RCURLYB {fprintf(newHtml,"</b></br>\n");}
        ;

	

mathoption	 :  DOLLARMATH {fprintf(newHtml,"&nbsp;<math>\n");}  mathstatement {fprintf(newHtml,"</mrow>\n"); } DOLLARMATH {fprintf(newHtml,"</math>\n");}
		 ;

set : BACKSL LCURLYB {fprintf(newHtml,"<mi>{</mi>"); }  setmath BACKSL RCURLYB {fprintf(newHtml,"<mi>}</mi>"); }
    | LANGLE {fprintf(newHtml,"<mi> [ </mi>"); }  setmath RANGLE {fprintf(newHtml,"<mi> ] </mi>"); }
    ;

mathstatement	 :  operand  OPERATOR {fprintf(newHtml,"\n<mo>%s</mo>\n",$2); }  mathstatement 
        | SWORD mathstatement 
        |LSQRB mathstatement RSQRB
		 |  squareroot 
		 |  fractional
		 |  operand mathstatement
		 | set
		 | operand OPERATOR {fprintf(newHtml,"\n<mo>%s</mo>\n",$2); } set
		 | operand
		 | SWORD
		  ;

setmath	 :  operand  OPERATOR {fprintf(newHtml,"\n<mo>%s</mo>\n",$2); }  setmath 
        | SWORD setmath
		|  operand setmath
		| operand
		| SWORD
		  ;

fractional	 :  FRAC {fprintf(newHtml,"<mrow><mfrac>\n");} fracbody {fprintf(newHtml,"</mfrac></mrow>\n");}
		 ;

fracbody	 : fracpart fracpart
		 ;

fracpart	 : LCURLYB {fprintf(newHtml,"<mrow>\n"); } mathstatement {fprintf(newHtml,"</mrow>\n"); } RCURLYB
		 ;

squareroot	 : SQRT {fprintf(newHtml,"<msqrt>\n"); } LCURLYB mathstatement RCURLYB {fprintf(newHtml,"</msqrt>\n"); }
		 ;

operand		 : LETTERS SUPERSCRIPT {fprintf(newHtml,"<mrow><msup>\n<mi>%s</mi>",$1); } operand {fprintf(newHtml,"</msup></mrow>");}
		 | INTEGER SUPERSCRIPT {fprintf(newHtml,"<mrow><msup>\n<mn>%d</mn>",$1); } operand {fprintf(newHtml,"</msup></mrow>");}
		 | LETTERS SUBSCRIPT {fprintf(newHtml,"<mrow><msub>\n<mi>%s</mi>",$1); } operand {fprintf(newHtml,"</msub></mrow>");}
		 | INTEGER SUBSCRIPT {fprintf(newHtml,"<mrow><msub>\n<mn>%d</mn>",$1); } operand {fprintf(newHtml,"</msub></mrow>");}
		 | GREEK SUPERSCRIPT {fprintf(newHtml,"<mrow><msup>\n<mi>%s;</mi>",$1); } operand {fprintf(newHtml,"</msup></mrow>");}
		 | GREEK SUBSCRIPT {fprintf(newHtml,"<mrow><msub>\n<mi>%s;</mi>",$1); } operand {fprintf(newHtml,"</msub></mrow>");}
		 | LETTERS {fprintf(newHtml,"<mi>%s</mi>",$1); }
		 | GREEK {fprintf(newHtml,"<mi>%s;</mi>",$1); } 
	     |INTEGER {fprintf(newHtml,"<mn>%d</mn>",$1); }
	     ;



tableoption	 :  starttable tablebody endtable
            | tablebody
		 ;

starttable	 :  BEGINTABLE LSQRB position RSQRB
		 ;

position 	 : T
		 | H
		 | B
		 ;
		
tablebody	 : starttabular tabularbody endtabular tablebody
		 | starttabular tabularbody endtabular
		 ;

starttabular	 : BEGINTABULAR LCURLYB tablespec RCURLYB {fprintf(newHtml,"<table border=\"%d\">\n",tablewidth); }
		 ;

endtabular	 : ENDTABULAR {fprintf(newHtml,"</table>\n"); tablewidth = 0; }
		 ;

endtable	 : ENDTABLE
		 ;

tabularbody	 : hline {fprintf(newHtml,"<tr>\n<td> "); } row tabularbody
		 | hline
		 ;

hline		 : HLINE hline
		 |
		 ;

row		 : tabletextoption AMPERSAND {fprintf(newHtml," </td> <td>"); } row
		 | tabletextoption DBLBS {fprintf(newHtml," </td>\n</tr>\n"); }
		 ;

tablespec	 : tablespec colspec 
		 | colspec
		 ;

colspec		 : L
		 | C
		 | R
		 | PIPE {tablewidth = 1;}
		 ;


tabletextoption  :  tabletextoption WORD {fprintf(newHtml," %s",$2);} 
		 |  tabletextoption INTEGER {fprintf(newHtml," %d",$2);}
                 |  WORD {fprintf(newHtml,"%s",$1); }
		 |  INTEGER {fprintf(newHtml,"%d",$1); }
		 |mathoption;
		 ;

textoption       :  textoption WORD {fprintf(newHtml," %s",$2);} 
		 |  textoption INTEGER {fprintf(newHtml," %d",$2);}
                 |  WORD {fprintf(newHtml,"%s",$1); }
		 |  INTEGER {fprintf(newHtml,"%d",$1); }
		 |  textoption DBLBS {fprintf(newHtml,"<br/>"); }textoption
		 |  textoption HSPACE {fprintf(newHtml,"&nbsp;"); }
		 |
		 ;
		 

%%

int main(int argc, char *argv[]){
    char fname[100];
    strcpy(fname,argv[1]);
    newHtml = fopen(fname,"w+");
	return yyparse();
	}

int yyerror (char *msg) {
    if((inhtml==1)&&(inbody==0))
       fprintf(newHtml,"ERROR in TITLE</title></html>");
    
    if((inbody==1)&&(inbody==1))fprintf(newHtml," ERROR in BODY</body></html>");
    
	return fprintf (stderr, "YACC: %s\n ", msg);
	}
