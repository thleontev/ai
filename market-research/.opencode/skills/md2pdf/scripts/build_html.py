# -*- coding: utf-8 -*-
"""MD -> HTML with print-ready CSS. Usage: build_html.py <input.md> <output.html>"""
import os, re, sys
import markdown

CSS = """
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: 'Segoe UI', 'Arial', sans-serif; font-size: 11.5pt; line-height: 1.5; color: #222; margin: 0; }
h1 { font-size: 20pt; line-height: 1.25; margin: 0 0 6px 0; color: #12395e; }
h2 { font-size: 15pt; margin: 18px 0 8px 0; color: #12395e; border-bottom: 2px solid #12395e; padding-bottom: 3px; page-break-after: avoid; }
h3 { font-size: 12.5pt; margin: 14px 0 6px 0; color: #1f4e79; page-break-after: avoid; }
p { margin: 0 0 8px 0; }
ul, ol { margin: 0 0 8px 0; padding-left: 22px; }
ul ul, ul ol, ol ul, ol ol { margin: 3px 0; padding-left: 24px; }
li { margin-bottom: 3px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 12px 0; font-size: 10pt; }
thead { display: table-header-group; }
th { background: #12395e; color: #fff; text-align: left; padding: 5px 7px; border: 0.6pt solid #12395e; }
td { padding: 4px 7px; border: 0.6pt solid #9db4c8; vertical-align: top; }
tr { page-break-inside: avoid; }
tr:nth-child(even) td { background: #f4f8fb; }
hr { border: none; border-top: 1px solid #c5d3df; margin: 12px 0; }
code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f0f2f4; padding: 0 3px; }
strong { color: #0d2b47; }
a { color: #12395e; text-decoration: none; word-break: break-all; }
img { max-width: 100%; height: auto; margin: 4px 0 10px 0; break-inside: avoid; }
table { break-inside: avoid; }
"""

def main():
    if len(sys.argv) < 3:
        print('usage: build_html.py <input.md> <output.html>'); sys.exit(1)
    md_path, html_path = sys.argv[1], sys.argv[2]
    md_text = open(md_path, encoding='utf-8').read()
    warn_markdown_blocks(md_text)
    warn_tables(md_text)
    body = markdown.markdown(md_text, extensions=['tables', 'sane_lists'])
    print(f'OK tables: {body.count("<table>")}')
    m = re.search(r'<h1[^>]*>(.*?)</h1>', body, re.S)
    title = re.sub(r'<[^>]+>', '', m.group(1)).strip() if m else os.path.basename(md_path)
    html = ('<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
            f'<title>{title}</title>\n<style>{CSS}</style>\n</head>\n<body>\n{body}\n</body>\n</html>\n')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print('OK html:', os.path.abspath(html_path))

def warn_tables(md_text):
    """Warn when a table separator has more/fewer cells than the header row.

    python-markdown silently leaves such tables as raw text inside <p>, so the
    table disappears from the PDF. Emits ASCII WARN lines only."""
    sep_re = re.compile(r'^\|[\s:|-]+\|$')
    lines = md_text.splitlines()
    for i, line in enumerate(lines):
        if sep_re.match(line) and i > 0:
            hdr = len(lines[i - 1].split('|')[1:-1])
            sep = len(line.split('|')[1:-1])
            if hdr and hdr != sep:
                print(f'WARN table separator line {i + 1}: {sep} segments vs {hdr} header columns - table will NOT render')

def warn_markdown_blocks(md_text):
    """Warn when Python-Markdown is likely to merge a table or list into prose.

    The tables extension requires a blank line before a table that follows a
    paragraph. The same boundary keeps lists from becoming plain text in
    print-ready reports. Emits ASCII WARN lines only."""
    lines = md_text.splitlines()
    list_re = re.compile(r'^\s*(?:[-*+]|\d+[.)])\s+')
    nested_list_re = re.compile(r'^( +)(?:[-*+]|\d+[.)])\s+')
    heading_re = re.compile(r'^\s{0,3}#{1,6}\s+')
    for i, line in enumerate(lines):
        nested_match = nested_list_re.match(line)
        if nested_match and len(nested_match.group(1)) % 4:
            print(f'WARN nested list line {i + 1}: use 4 spaces per nesting level')
        if i == 0 or not line.strip() or not lines[i - 1].strip():
            continue
        previous = lines[i - 1]
        if heading_re.match(previous):
            continue
        if line.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i + 1]):
            print(f'WARN block boundary line {i + 1}: add a blank line before table header')
        elif list_re.match(line) and not list_re.match(previous):
            print(f'WARN block boundary line {i + 1}: add a blank line before list')

if __name__ == '__main__':
    main()
