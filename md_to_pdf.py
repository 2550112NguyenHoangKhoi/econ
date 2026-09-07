#!/usr/bin/env python3
"""
Convert ARCHITECTURE.md to PDF using markdown + xhtml2pdf (pure Python, no native deps).
"""
import subprocess
import sys
import os

# Ensure dependencies
for pkg in ["markdown", "xhtml2pdf"]:
    try:
        __import__(pkg)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", pkg, "-q"])

import markdown
from xhtml2pdf import pisa

INPUT = "ARCHITECTURE.md"
OUTPUT = "ARCHITECTURE.pdf"

print(f"Reading {INPUT}...")
with open(INPUT, "r", encoding="utf-8") as f:
    md_text = f.read()

print("Converting Markdown to HTML...")
html_body = markdown.markdown(
    md_text,
    extensions=["tables", "fenced_code", "toc", "md_in_html"],
)

html_doc = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<style>
  @page {{
    size: A3 portrait;
    margin: 1.5cm 1.5cm 2cm 1.5cm;
    @frame footer {{
      -pdf-frame-content: footerContent;
      bottom: 0.5cm;
      margin-left: 1.5cm;
      margin-right: 1.5cm;
      height: 1cm;
    }}
  }}
  body {{
    font-family: Helvetica, Arial, sans-serif;
    font-size: 10pt;
    line-height: 1.5;
    color: #1a1a1a;
  }}
  h1 {{
    font-size: 20pt;
    color: #111;
    border-bottom: 2px solid #333;
    padding-bottom: 4pt;
    page-break-after: avoid;
  }}
  h2 {{
    font-size: 16pt;
    color: #222;
    border-bottom: 1px solid #999;
    padding-bottom: 3pt;
    margin-top: 16pt;
    page-break-after: avoid;
  }}
  h3 {{
    font-size: 12pt;
    color: #333;
    margin-top: 12pt;
    page-break-after: avoid;
  }}
  h4 {{
    font-size: 10.5pt;
    color: #444;
    page-break-after: avoid;
  }}
  table {{
    -pdf-keep-in-frame-mode: shrink;
    border-collapse: collapse;
    width: 100%;
    margin: 8pt 0;
    font-size: 8pt;
    line-height: 1.35;
  }}
  th {{
    background-color: #2d2d2d;
    color: white;
    padding: 5pt;
    text-align: left;
    font-weight: bold;
    border: 1px solid #444;
  }}
  td {{
    padding: 4pt 5pt;
    border: 1px solid #ccc;
    vertical-align: top;
  }}
  code {{
    font-family: Courier, monospace;
    font-size: 8.5pt;
    background-color: #f0f0f0;
    padding: 1pt 3pt;
    color: #c7254e;
  }}
  pre {{
    background-color: #1e1e1e;
    color: #d4d4d4;
    padding: 8pt 10pt;
    font-family: Courier, monospace;
    font-size: 7.5pt;
    line-height: 1.4;
    white-space: pre-wrap;
    word-wrap: break-word;
    page-break-inside: avoid;
    border: 1px solid #555;
  }}
  pre code {{
    background-color: transparent;
    color: inherit;
    padding: 0;
    font-size: inherit;
  }}
  blockquote {{
    border-left: 3px solid #0969da;
    margin: 8pt 0;
    padding: 5pt 10pt;
    background-color: #f0f7ff;
    color: #333;
    font-size: 9pt;
  }}
  hr {{
    border: none;
    border-top: 1px solid #ccc;
    margin: 12pt 0;
  }}
  strong {{
    color: #111;
  }}
  a {{
    color: #0969da;
    text-decoration: none;
  }}
</style>
</head>
<body>
{html_body}
<div id="footerContent" style="text-align: center; font-size: 8pt; color: #666;">
  ECON Architecture Reference — Page <pdf:pagenumber/>
</div>
</body>
</html>
"""

print("Generating PDF (A3 portrait)...")
with open(OUTPUT, "w+b") as pdf_file:
    status = pisa.CreatePDF(html_doc, dest=pdf_file, encoding="utf-8")

if status.err:
    print(f"Error generating PDF: {status.err}")
    sys.exit(1)

size_kb = os.path.getsize(OUTPUT) / 1024
print(f"Done! PDF saved to: {os.path.abspath(OUTPUT)}")
print(f"Size: {size_kb:.0f} KB")
