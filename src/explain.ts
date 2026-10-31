// Plain-English explanations of common LaTeX errors, matched against the log message. Free and
// instant; Claude is asked only when these don't fit or a fix is wanted.

const RULES: [RegExp, (m: RegExpExecArray) => string][] = [
  [/Undefined control sequence/, () => "A command isn't defined. Usually a typo in its name, or the package that provides it isn't loaded with \\usepackage{…}."],
  [/Missing \$ inserted/, () => "A maths-only symbol (_, ^, \\alpha, …) is outside maths mode. Wrap it in $…$, or write \\_ for an underscore in text."],
  [/File [`'](.+?)' not found/, (m) => `LaTeX can't find ${m[1]}. Check the name and path; if it's a package, install it (on BasicTeX: sudo tlmgr install <package>).`],
  [/Missing \\begin\{document\}/, () => "Something in the preamble prints text, e.g. a stray character or a command that typesets. Move it after \\begin{document}."],
  [/Extra \}, or forgotten (\\\w+)/, (m) => `A } has no matching {, or an environment was closed early (LaTeX expected ${m[1]}).`],
  [/Extra \}/, () => "A } has no matching {."],
  [/Missing \} inserted/, () => "A { is never closed, often inside maths or a command's argument."],
  [/Too many \}'s/, () => "There are more } than { here."],
  [/Misplaced alignment tab character &/, () => "An & outside a table or align environment. Write \\& for an ampersand in text."],
  [/Runaway argument/, () => "A command's argument has no closing }, so LaTeX read on into the following text."],
  [/Paragraph ended before (\\\S+) was complete/, (m) => `A blank line inside the argument of ${m[1]}: usually a missing }.`],
  [/\\begin\{(.+?)\} on input line (\d+) ended by \\end\{(.+?)\}/, (m) => `The ${m[1]} environment opened on line ${m[2]} is closed by \\end{${m[3]}}: an \\end is missing or mismatched.`],
  [/Environment (\S+) undefined/, (m) => `There's no environment called ${m[1]}: a typo, or its package isn't loaded.`],
  [/There's no line here to end/, () => "A \\\\ line break where there's no line to end, e.g. after a blank line or straight after \\begin{…}. Remove it or use \\par."],
  [/Double (subscript|superscript)/, (m) => `Two ${m[1]}s in a row. Group them with braces, e.g. x_{i_j} or {x^2}^3.`],
  [/Illegal unit of measure/, () => "A length is missing its unit: write 2cm, 0.5\\linewidth, 10pt, not just a number."],
  [/Missing number, treated as zero/, () => "A number or length was expected but something else came, e.g. a \\\\ followed by [ on the next line."],
  [/Option clash for package (\S+)/, (m) => `${m[1]} is loaded twice with different options (perhaps once by the class). Load it once, or pass options with \\PassOptionsToPackage before \\documentclass.`],
  [/Unknown option [`'](.+?)' for (?:class|package) [`'](.+?)'/, (m) => `${m[2]} has no option called ${m[1]}.`],
  [/Unicode character (.+?) \(U\+([0-9A-F]+)\)/, (m) => `The character ${m[1]} (U+${m[2]}) has no definition in this font setup. Add \\usepackage[T1]{fontenc}, write it as a LaTeX command, or compile with XeLaTeX or LuaLaTeX (% !TEX program = xelatex).`],
  [/Can be used only in preamble/, () => "A command that belongs before \\begin{document} (\\usepackage and friends) appears in the body."],
  [/Lonely \\item/, () => "\\item outside itemize, enumerate or description."],
  [/Something's wrong--perhaps a missing \\item/, () => "A list has text before its first \\item, or an empty list, or \\\\ after a list item."],
  [/Not in outer par mode/, () => "A float (figure, table) or \\marginpar inside a box, minipage or another float."],
  [/Too many unprocessed floats/, () => "Too many figures and tables waiting for a place. Use [!htbp] placement, \\clearpage, or fewer floats in a row."],
  [/I can't write on file/, () => "The output file is locked or the folder isn't writable."],
  [/Emergency stop/, () => "LaTeX stopped early. The error before this one is the real cause."],
  [/Command (\\\S+) already defined/, (m) => `${m[1]} is already defined (perhaps by a package). Use \\renewcommand, or pick another name.`],
  [/LaTeX Error: \\verb ended by end of line|\\verb illegal/, () => "\\verb can't span lines or sit inside another command's argument. Use \\texttt{…} there."],
  [/Dimension too large/, () => "A length is too big, often a figure scaled from a bad size or a division by zero in a plot."],
  [/Arithmetic overflow/, () => "A calculation overflowed, often a zero width or height somewhere."],
];

/** An explanation for a LaTeX error message, or null if none of the rules fit. */
export function explain(message: string): string | null {
  for (const [pattern, text] of RULES) {
    const m = pattern.exec(message);
    if (m) return text(m);
  }
  return null;
}
