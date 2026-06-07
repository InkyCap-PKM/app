#!/usr/bin/env python3
"""Code-aware sanitizer for the assembled docs notebox.

Run AFTER assemble-docs.py. Fixes markup that would fail Typst compilation,
touching only prose (never fenced/inline code or string literals):

1. #wikilink("X")[Y]      -> #wikilink("X", display: "Y")
2. #ref(<x>)[Y]           -> #link(<x>)[Y]
3. Bold keycaps/spans that contain Typst-special chars ([ ] # \\ or the
   comment openers /* //) -> inline code, so e.g. *Ctrl+/* and *Ctrl+Shift+]*
   become `Ctrl+/` and `Ctrl+Shift+]`.
"""
import glob, re, os

ROOT = "/home/jchalif/.config/inkycap/InkyCap-Documentation"

# Protected (do-not-touch) spans: fenced code and inline code only. Bare
# "..." is NOT protected — in Typst *markup* mode double quotes are literal
# characters, not string literals (real strings live only in code, inside
# #func(...), whose URL/path args don't contain bold * or spaced <...>).
PROTECT = re.compile(r'```[\s\S]*?```|`[^`]*`')

BOLD = re.compile(r'\*([^*\n]+)\*')
SPECIAL = re.compile(r'[\[\]#\\]|/\*|//')
# A space-containing <...> group is parsed as an (invalid) Typst label.
ANGLE_LABEL = re.compile(r'<([^>\n]*\s[^>\n]*)>')

def fix_bold_in_prose(prose: str) -> str:
    def repl(m):
        content = m.group(1)
        # Special chars inside, OR a trailing '/' that forms '/*' with the
        # closing '*' delimiter (e.g. *Ctrl+/*). Convert the keycap to code.
        if SPECIAL.search(content) or content.endswith('/'):
            # In bold, '\\' meant one literal backslash; raw inline code shows
            # backslashes verbatim, so collapse to a single one.
            return '`' + content.replace('\\\\', '\\') + '`'
        return m.group(0)
    prose = BOLD.sub(repl, prose)
    # Escape placeholder angle brackets so they render literally instead of
    # being parsed as a label (e.g. _<note name>_).
    prose = ANGLE_LABEL.sub(lambda m: '\\<' + m.group(1) + '>', prose)
    return prose

def process(text: str) -> str:
    # Whole-text function-call fixes (safe; operate on the call syntax itself).
    text = re.sub(r'#wikilink\("([^"]*)"\)\[([^\]\[]*)\]',
                  lambda m: f'#wikilink("{m.group(1)}", display: "{m.group(2)}")', text)
    text = re.sub(r'#ref\((<[^>]+>)\)\[', r'#link(\1)[', text)

    # Bold-span fixes, prose-only (skip protected spans).
    out, last = [], 0
    for m in PROTECT.finditer(text):
        out.append(fix_bold_in_prose(text[last:m.start()]))
        out.append(m.group(0))
        last = m.end()
    out.append(fix_bold_in_prose(text[last:]))
    return "".join(out)

# One-off semantic fixes (broken/stale wikilink targets), keyed by relative path.
TARGETED = {
    "The InkyCap Interface/Settings.typ": [
        ('see #wikilink("Behaviour") under the Behaviour tab below',
         'see the Behaviour tab below'),
    ],
    "Importing and Extending/Extensions.typ": [
        ('#wikilink("Sharing and Extending")',
         '#wikilink("Importing and Extending")'),
    ],
}

changed = 0
for f in sorted(glob.glob(os.path.join(ROOT, "**/*.typ"), recursive=True)):
    if ".inkycap" in f:
        continue
    s = open(f).read()
    s2 = process(s)
    for old, new in TARGETED.get(os.path.relpath(f, ROOT), []):
        s2 = s2.replace(old, new)
    if s2 != s:
        open(f, "w").write(s2)
        changed += 1
        print("fixed", os.path.relpath(f, ROOT))
print(f"{changed} files modified")
