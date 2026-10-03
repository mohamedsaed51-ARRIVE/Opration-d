#!/usr/bin/env python3
"""Inline the ARRIVE Design System into index.html.

The dashboard ships as ONE file (Apps Script HtmlService), so the design system lives in
design-system/*.css|js and is inlined between marker comments in index.html.

    python3 design-system/build.py            # re-inline after editing any design-system file

Markers in index.html (do not remove):
    /*ARRIVE-DS-CSS:BEGIN*/ ... /*ARRIVE-DS-CSS:END*/
    /*ARRIVE-DS-JS:BEGIN*/  ... /*ARRIVE-DS-JS:END*/
    /*ARRIVE-LOGOS:BEGIN*/  ... /*ARRIVE-LOGOS:END*/
To re-colour the product, edit design-system/arrive-tokens.css only, then run this script.
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, 'index.html')


def read(name):
    with open(os.path.join(HERE, name), encoding='utf8') as f:
        return f.read().rstrip() + '\n'


def swap(html, tag, payload):
    pat = re.compile(r'(/\*' + tag + r':BEGIN\*/)(.*?)(/\*' + tag + r':END\*/)', re.S)
    if not pat.search(html):
        sys.exit('marker not found: ' + tag)
    return pat.sub(lambda m: m.group(1) + '\n' + payload + m.group(3), html, count=1)


def main():
    with open(INDEX, encoding='utf8') as f:
        html = f.read()
    css = read('arrive-tokens.css') + read('arrive-components.css') + read('arrive-dashboard.css')
    html = swap(html, 'ARRIVE-DS-CSS', css)
    html = swap(html, 'ARRIVE-DS-JS', read('arrive-ds.js'))
    logos = read('logos.js')
    html = swap(html, 'ARRIVE-LOGOS', logos)
    with open(INDEX, 'w', encoding='utf8') as f:
        f.write(html)
    print('index.html updated:', len(html), 'bytes')


if __name__ == '__main__':
    main()
