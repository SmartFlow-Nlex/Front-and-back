"""
SmartFlow NLEX - Executive Presentation Generator
Requires: pip install python-pptx
Run: python generate_smartflow_deck.py
Outputs: SmartFlow_NLEX_Presentation.pptx
"""

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

# ---------------------------------------------------------------------------
# THEME
# ---------------------------------------------------------------------------
NAVY = RGBColor(0x0A, 0x1F, 0x44)       # deep corporate navy (backgrounds/titles)
BLUE = RGBColor(0x1E, 0x5A, 0xC8)       # primary accent blue
LIGHT_BLUE = RGBColor(0xE8, 0xEF, 0xFA) # subtle panel fill
SLATE = RGBColor(0x3C, 0x46, 0x59)      # body text
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
MUTED = RGBColor(0x8A, 0x93, 0xA6)      # footer / muted text

FONT_HEAD = "Calibri"
FONT_BODY = "Calibri"

SLIDE_W = Inches(13.333)
SLIDE_H = Inches(7.5)


def add_background(slide, color):
    bg = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, SLIDE_W, SLIDE_H)
    bg.fill.solid()
    bg.fill.fore_color.rgb = color
    bg.line.fill.background()
    bg.shadow.inherit = False
    # send to back
    spTree = bg._element.getparent()
    spTree.remove(bg._element)
    spTree.insert(2, bg._element)
    return bg


def add_accent_bar(slide, top=Inches(0), height=Inches(0.12)):
    bar = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, top, SLIDE_W, height)
    bar.fill.solid()
    bar.fill.fore_color.rgb = BLUE
    bar.line.fill.background()
    bar.shadow.inherit = False
    return bar


def add_title(slide, text, top=Inches(0.45), size=32, color=NAVY, left=Inches(0.6), width=None):
    width = width or (SLIDE_W - Inches(1.2))
    box = slide.shapes.add_textbox(left, top, width, Inches(1.0))
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = True
    run.font.color.rgb = color
    run.font.name = FONT_HEAD
    return box


def add_subtitle(slide, text, top, size=16, color=SLATE, left=Inches(0.6), width=None, italic=False):
    width = width or (SLIDE_W - Inches(1.2))
    box = slide.shapes.add_textbox(left, top, width, Inches(0.7))
    tf = box.text_frame
    tf.word_wrap = True
    p = tf.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.italic = italic
    run.font.color.rgb = color
    run.font.name = FONT_BODY
    return box


def add_page_number(slide, n, total=3):
    box = slide.shapes.add_textbox(SLIDE_W - Inches(1.3), SLIDE_H - Inches(0.55), Inches(1.0), Inches(0.4))
    p = box.text_frame.paragraphs[0]
    run = p.add_run()
    run.text = f"{n} / {total}"
    run.font.size = Pt(11)
    run.font.color.rgb = MUTED
    run.font.name = FONT_BODY
    p.alignment = PP_ALIGN.RIGHT


def add_image_placeholder(slide, left, top, width, height, label="IMAGE PLACEHOLDER"):
    box = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    box.fill.solid()
    box.fill.fore_color.rgb = LIGHT_BLUE
    box.line.color.rgb = BLUE
    box.line.width = Pt(1.25)
    box.line.dash_style = None
    box.shadow.inherit = False

    # dashed border via XML (python-pptx has no direct dash API pre-0.6.21 for this shortcut)
    ln = box.line._get_or_add_ln()
    prstDash = ln.makeelement(qn('a:prstDash'), {'val': 'dash'})
    ln.append(prstDash)

    tf = box.text_frame
    tf.word_wrap = True
    box.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    run = p.add_run()
    run.text = label
    run.font.size = Pt(13)
    run.font.color.rgb = BLUE
    run.font.italic = True
    run.font.name = FONT_BODY
    return box


def add_bullets(slide, left, top, width, height, items, size=14, color=SLATE, bold_lead=True, line_spacing=1.15):
    """
    items: list of (text, level, bold) tuples.
    level 0 = main bullet, level 1 = sub-bullet.
    """
    box = slide.shapes.add_textbox(left, top, width, height)
    tf = box.text_frame
    tf.word_wrap = True

    for i, (text, level, bold) in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.level = level
        p.line_spacing = line_spacing
        p.space_after = Pt(10 if level == 0 else 4)

        bullet_char = "\u25A0  " if level == 0 else "\u2013  "
        run = p.add_run()
        run.text = f"{bullet_char}{text}"
        run.font.size = Pt(size if level == 0 else size - 1)
        run.font.bold = bold if level == 0 else False
        run.font.color.rgb = color if level == 0 else MUTED
        run.font.name = FONT_BODY

    return box


# ---------------------------------------------------------------------------
# BUILD PRESENTATION
# ---------------------------------------------------------------------------
prs = Presentation()
prs.slide_width = SLIDE_W
prs.slide_height = SLIDE_H
BLANK = prs.slide_layouts[6]

# ============================== SLIDE 1 ====================================
s1 = prs.slides.add_slide(BLANK)
add_background(s1, WHITE)
add_accent_bar(s1, top=Inches(0), height=Inches(0.12))

add_title(s1, "SmartFlow NLEX", top=Inches(0.4), size=36, color=NAVY)
add_subtitle(s1, "Where Traffic Meets Intelligence", top=Inches(0.95), size=20, color=BLUE, italic=False)

col_top = Inches(1.85)
col_height = Inches(4.9)
gutter = Inches(0.4)
col_width = (SLIDE_W - Inches(1.2) - gutter) / 2
left_x = Inches(0.6)
right_x = left_x + col_width + gutter

# Left column ---------------------------------------------------------------
add_subtitle(s1, "The Vision", top=col_top, size=16, color=BLUE, left=left_x, width=col_width)
vision_box = slide_body = s1.shapes.add_textbox(left_x, col_top + Inches(0.4), col_width, Inches(1.1))
tf = vision_box.text_frame
tf.word_wrap = True
p = tf.paragraphs[0]
run = p.add_run()
run.text = ("A dual-interface platform that transforms NLEX traffic management "
            "from reactive to proactive using Machine Learning.")
run.font.size = Pt(13.5)
run.font.color.rgb = SLATE
run.font.name = FONT_BODY

add_subtitle(s1, "For Operators (Web Dashboard)", top=col_top + Inches(1.55), size=15, color=NAVY, left=left_x, width=col_width)
add_bullets(
    s1, left_x, col_top + Inches(1.95), col_width, Inches(1.6),
    [
        ("Predicts congestion hotspots up to 48 hours in advance", 0, False),
        ("Forecasts incident probabilities", 0, False),
        ("Provides a spatial AI sandbox", 0, False),
    ],
    size=13
)

add_image_placeholder(s1, left_x, col_top + Inches(3.6), col_width, Inches(1.15), "WEB DASHBOARD SCREENSHOT")

# Right column ---------------------------------------------------------------
add_subtitle(s1, "For Commuters (Mobile App)", top=col_top, size=16, color=BLUE, left=right_x, width=col_width)
add_bullets(
    s1, right_x, col_top + Inches(0.4), col_width, Inches(1.6),
    [
        ("Predictive travel times", 0, False),
        ("AI Traffic Assistant for trip planning", 0, False),
        ("Crowdsourced community updates", 0, False),
    ],
    size=13.5
)

add_image_placeholder(s1, right_x, col_top + Inches(1.9), col_width, Inches(1.5), "MOBILE APP SCREENSHOT")
add_image_placeholder(s1, right_x, col_top + Inches(3.6), col_width, Inches(1.15), "PRODUCT / TEAM LOGO")

add_page_number(s1, 1)

# ============================== SLIDE 2 ====================================
s2 = prs.slides.add_slide(BLANK)
add_background(s2, WHITE)
add_accent_bar(s2, top=Inches(0), height=Inches(0.12))

add_title(s2, "Data Requirements for Predictive Modeling", top=Inches(0.45), size=30)
add_subtitle(
    s2,
    "To train our machine learning models accurately, we respectfully request historical "
    "datasets (ideally 2020-2023) covering:",
    top=Inches(1.15), size=15, color=SLATE, width=SLIDE_W - Inches(1.2)
)

# Two panel cards for the two main data categories
panel_top = Inches(2.05)
panel_height = Inches(3.7)
panel_gutter = Inches(0.4)
panel_width = (SLIDE_W - Inches(1.2) - panel_gutter) / 2
panel_left1 = Inches(0.6)
panel_left2 = panel_left1 + panel_width + panel_gutter

for px, num, heading, subitems in [
    (panel_left1, "1", "Incident Data", [
        "Historical logs of accidents, stalled vehicles, and roadworks",
        "Key fields: timestamp",
        "Specific location / exit",
        "Incident type",
        "Clearance duration",
    ]),
    (panel_left2, "2", "Traffic Volume Data", [
        "Hourly throughput at major NLEX toll plazas",
        "Segmented by vehicle class to analyze heavy fleet impact",
    ]),
]:
    panel = s2.shapes.add_shape(MSO_SHAPE.RECTANGLE, px, panel_top, panel_width, panel_height)
    panel.fill.solid()
    panel.fill.fore_color.rgb = LIGHT_BLUE
    panel.line.color.rgb = BLUE
    panel.line.width = Pt(0.75)
    panel.shadow.inherit = False

    # number badge
    badge = s2.shapes.add_shape(MSO_SHAPE.OVAL, px + Inches(0.3), panel_top + Inches(0.3), Inches(0.5), Inches(0.5))
    badge.fill.solid()
    badge.fill.fore_color.rgb = BLUE
    badge.line.fill.background()
    badge.shadow.inherit = False
    badge.text_frame.paragraphs[0].alignment = PP_ALIGN.CENTER
    badge.text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    brun = badge.text_frame.paragraphs[0].add_run()
    brun.text = num
    brun.font.size = Pt(20)
    brun.font.bold = True
    brun.font.color.rgb = WHITE
    brun.font.name = FONT_HEAD

    add_subtitle(s2, heading, top=panel_top + Inches(0.35), size=18, color=NAVY,
                 left=px + Inches(1.0), width=panel_width - Inches(1.3))

    bullet_items = [(subitems[0], 0, False)] + [(t, 1, False) for t in subitems[1:]]
    add_bullets(s2, px + Inches(0.3), panel_top + Inches(1.05), panel_width - Inches(0.6),
                panel_height - Inches(1.3), bullet_items, size=13)

# Footer note
footer_box = s2.shapes.add_textbox(Inches(0.6), SLIDE_H - Inches(0.9), SLIDE_W - Inches(1.2), Inches(0.5))
tf = footer_box.text_frame
tf.word_wrap = True
p = tf.paragraphs[0]
run = p.add_run()
run.text = ("Note: Data will be securely managed, fully anonymized if required, and strictly "
            "used for academic research and prototype development.")
run.font.size = Pt(11)
run.font.italic = True
run.font.color.rgb = MUTED
run.font.name = FONT_BODY

add_page_number(s2, 2)

# ============================== SLIDE 3 ====================================
s3 = prs.slides.add_slide(BLANK)
add_background(s3, NAVY)
add_accent_bar(s3, top=Inches(0), height=Inches(0.12))

add_title(s3, "Value Proposition for NLEX Corporation", top=Inches(0.45), size=30, color=WHITE)
add_subtitle(
    s3,
    "By granting data access, NLEX directly benefits from our team developing a working, "
    "data-driven prototype at zero cost, which will deliver:",
    top=Inches(1.2), size=15, color=RGBColor(0xC7, 0xD3, 0xEA), width=SLIDE_W - Inches(1.2)
)

value_items = [
    ("Proactive Incident Management",
     "ML models that identify high-risk timeframes and locations for preemptive patrol deployment."),
    ("Optimized Traffic Flow",
     "Advanced congestion forecasting for data-backed interventions."),
    ("Enhanced Commuter Satisfaction",
     "A proof-of-concept mobile application giving motorists AI-driven travel advisories."),
    ("Environmental Analytics",
     "Baseline tracking of vehicular carbon emissions for sustainability goals."),
]

grid_top = Inches(2.1)
card_gutter = Inches(0.35)
card_w = (SLIDE_W - Inches(1.2) - card_gutter) / 2
card_h = Inches(2.1)
positions = [
    (Inches(0.6), grid_top),
    (Inches(0.6) + card_w + card_gutter, grid_top),
    (Inches(0.6), grid_top + card_h + Inches(0.3)),
    (Inches(0.6) + card_w + card_gutter, grid_top + card_h + Inches(0.3)),
]

for (cx, cy), (heading, body) in zip(positions, value_items):
    card = s3.shapes.add_shape(MSO_SHAPE.RECTANGLE, cx, cy, card_w, card_h)
    card.fill.solid()
    card.fill.fore_color.rgb = RGBColor(0x12, 0x2B, 0x5C)
    card.line.color.rgb = BLUE
    card.line.width = Pt(0.75)
    card.shadow.inherit = False

    tf = card.text_frame
    tf.word_wrap = True
    tf.margin_left = Inches(0.25)
    tf.margin_right = Inches(0.25)
    tf.margin_top = Inches(0.2)
    card.vertical_anchor = MSO_ANCHOR.TOP

    p1 = tf.paragraphs[0]
    r1 = p1.add_run()
    r1.text = heading
    r1.font.size = Pt(15)
    r1.font.bold = True
    r1.font.color.rgb = WHITE
    r1.font.name = FONT_HEAD
    p1.space_after = Pt(8)

    p2 = tf.add_paragraph()
    p2.line_spacing = 1.15
    r2 = p2.add_run()
    r2.text = body
    r2.font.size = Pt(12.5)
    r2.font.color.rgb = RGBColor(0xC7, 0xD3, 0xEA)
    r2.font.name = FONT_BODY

add_page_number(s3, 3)

# ---------------------------------------------------------------------------
prs.save("SmartFlow_NLEX_Presentation.pptx")
print("Saved SmartFlow_NLEX_Presentation.pptx")
