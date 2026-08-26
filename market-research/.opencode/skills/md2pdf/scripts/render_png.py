# -*- coding: utf-8 -*-
"""Render PDF pages to PNG + extract text and verify key phrases (ASCII-only stdout).
Usage: render_png.py <input.pdf> <outdir> [expected-phrases.txt]
Check results are written to <outdir>/_check.txt (UTF-8)."""
import os, re, sys
import pymupdf


def main():
    if len(sys.argv) < 3:
        print('usage: render_png.py <input.pdf> <outdir> [expected-phrases.txt]')
        sys.exit(1)
    pdf_path, outdir = sys.argv[1], sys.argv[2]
    phrases_file = sys.argv[3] if len(sys.argv) > 3 else None
    os.makedirs(outdir, exist_ok=True)

    doc = pymupdf.open(pdf_path)
    print('pages:', doc.page_count)
    pages_text = []
    for i, page in enumerate(doc, 1):
        pix = page.get_pixmap(dpi=130)
        png = os.path.join(outdir, f'page-{i:02d}.png')
        pix.save(png)
        pages_text.append(page.get_text())
        print(f'page {i}: png={os.path.getsize(png)} chars={len(pages_text[-1])}')

    text = re.sub(r'\s+', ' ', ' '.join(pages_text))
    checks = []
    if phrases_file and os.path.exists(phrases_file):
        phrases = [l.strip() for l in open(phrases_file, encoding='utf-8') if l.strip()]
        for ph in phrases:
            ok = ph in text
            checks.append(f'{ph} -> {ok}')
            print('ok' if ok else 'MISS')
        print('checked:', len(phrases))
    with open(os.path.join(outdir, '_check.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(checks) + '\n\n--- sample ---\n' + text[:600] + '\n')
    print('OK check:', os.path.join(outdir, '_check.txt'))


if __name__ == '__main__':
    main()