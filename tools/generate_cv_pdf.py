"""
generate_cv_pdf.py — Convert a tailored CV .docx into a clean PDF using fpdf2.

Reads structure from the .docx (headings, paragraphs, bullet points) and
renders a properly formatted PDF that mirrors the original CV layout.

Usage:
    python tools/generate_cv_pdf.py \
        --input  ".tmp/cv_barclays_aml.docx" \
        --output ".tmp/cv_barclays_aml.pdf"

Returns: path to the generated PDF
"""

import sys
import re
import argparse
import logging
import unicodedata
from pathlib import Path

from docx import Document
from fpdf import FPDF
from fpdf.enums import XPos, YPos

logging.basicConfig(level=logging.INFO, format="%(asctime)s [generate_cv_pdf] %(message)s")
logger = logging.getLogger(__name__)


# ── PDF styling constants ──────────────────────────────────────────────────────
MARGIN         = 18
LINE_HEIGHT    = 5.5
HEADING_GAP    = 3
FOOTER_HEIGHT  = 10
PAGE_WIDTH     = 210
CONTENT_WIDTH  = PAGE_WIDTH - 2 * MARGIN

FONT_NAME      = 14
FONT_CONTACT   = 9
FONT_HEADING   = 10
FONT_BODY      = 9
FONT_BULLET    = 9


def _safe(text: str) -> str:
    """Replace characters unsupported by Helvetica with ASCII equivalents."""
    replacements = {
        "\u2013": "-",   # en dash
        "\u2014": "-",   # em dash
        "\u2018": "'",   # left single quote
        "\u2019": "'",   # right single quote
        "\u201c": '"',   # left double quote
        "\u201d": '"',   # right double quote
        "\u2022": "*",   # bullet
        "\u2026": "...", # ellipsis
        "\u00a0": " ",   # non-breaking space
        "\u00b7": "-",   # middle dot
        "\t":     "  |  ",  # tab (role-header date separator) \u2014 render as ATS-friendly pipe
    }
    for src, dst in replacements.items():
        text = text.replace(src, dst)
    # Strip any remaining non-latin-1
    return text.encode("latin-1", errors="replace").decode("latin-1")


class CVPDF(FPDF):
    def header(self):
        pass

    def footer(self):
        self.set_y(-FOOTER_HEIGHT)
        self.set_font("Helvetica", "I", 7)
        self.set_text_color(160, 160, 160)
        self.cell(0, 5, f"Page {self.page_no()}", new_x=XPos.LMARGIN, new_y=YPos.NEXT, align="C")
        self.set_text_color(0, 0, 0)


def _parse_docx(docx_path: str) -> list:
    doc = Document(docx_path)
    items = []
    first_para = True

    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue

        style = para.style.name or ""

        # First paragraph = name + contact
        if first_para:
            first_para = False
            lines = text.split("\n")
            items.append({"type": "name", "text": lines[0].strip()})
            if len(lines) > 1:
                contact = " | ".join(l.strip() for l in lines[1:] if l.strip())
                if contact:
                    items.append({"type": "contact", "text": contact})
            continue

        # Section headings
        if "Heading" in style or (text.isupper() and len(text) < 60):
            items.append({"type": "heading", "text": text})
            continue

        # Lines that may contain multiple entries separated by \n
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            if line.startswith(("- ", "* ", "\u2022 ")):
                items.append({"type": "bullet", "text": line.lstrip("-* \u2022").strip()})
            else:
                items.append({"type": "body", "text": line})

    return items


def generate_cv_pdf(input_path: str, output_path: str = None) -> str:
    input_path = str(input_path)
    if not output_path:
        output_path = input_path.replace(".docx", ".pdf")

    items = _parse_docx(input_path)

    pdf = CVPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=FOOTER_HEIGHT + 5)
    pdf.add_page()
    pdf.set_margins(MARGIN, 15, MARGIN)

    x_left = MARGIN

    for item in items:
        t = item["type"]
        text = _safe(item["text"])

        if t == "name":
            pdf.set_font("Helvetica", "B", FONT_NAME)
            pdf.set_text_color(20, 20, 20)
            pdf.cell(0, 8, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT, align="C")

        elif t == "contact":
            pdf.set_font("Helvetica", "", FONT_CONTACT)
            pdf.set_text_color(80, 80, 80)
            pdf.cell(0, 5, text, new_x=XPos.LMARGIN, new_y=YPos.NEXT, align="C")
            pdf.ln(3)

        elif t == "heading":
            pdf.ln(HEADING_GAP)
            pdf.set_font("Helvetica", "B", FONT_HEADING)
            pdf.set_text_color(0, 70, 140)
            pdf.cell(0, 6, text.upper(), new_x=XPos.RIGHT, new_y=YPos.TOP)
            pdf.ln(6)
            y = pdf.get_y()
            pdf.set_draw_color(0, 70, 140)
            pdf.set_line_width(0.4)
            pdf.line(x_left, y, x_left + CONTENT_WIDTH, y)
            pdf.ln(2)
            pdf.set_text_color(0, 0, 0)

        elif t == "body":
            # multi_cell leaves the cursor at the cell's right edge (new_x=RIGHT
            # default), so always reset to the left margin before printing —
            # otherwise any body line following a bullet is clipped off-page.
            pdf.set_x(x_left)
            pdf.set_font("Helvetica", "", FONT_BODY)
            pdf.set_text_color(30, 30, 30)
            pdf.multi_cell(CONTENT_WIDTH, LINE_HEIGHT, text)
            pdf.ln(1)

        elif t == "bullet":
            pdf.set_font("Helvetica", "", FONT_BULLET)
            pdf.set_text_color(30, 30, 30)
            pdf.set_x(x_left + 3)
            pdf.multi_cell(CONTENT_WIDTH - 3, LINE_HEIGHT, f"*  {text}",
                           new_x=XPos.LMARGIN, new_y=YPos.NEXT)

    pdf.output(output_path)
    logger.info(f"PDF saved: {output_path}")
    return output_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input",  required=True)
    parser.add_argument("--output", default=None)
    args = parser.parse_args()
    path = generate_cv_pdf(args.input, args.output)
    print(path)


if __name__ == "__main__":
    main()
