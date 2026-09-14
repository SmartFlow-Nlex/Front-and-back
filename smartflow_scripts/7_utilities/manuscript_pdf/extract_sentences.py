import PyPDF2
import re

import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[2] / "config"))
from db import setting  # noqa: E402
pdf_path = setting("MANUSCRIPT_PDF", required=True)   # set in config/.env

try:
    with open(pdf_path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        
        full_text = ""
        for page in reader.pages:
            text = page.extract_text()
            if text:
                # remove line breaks to form paragraphs
                full_text += text.replace('\n', ' ') + " "
                
        # find sentences with our keywords
        sentences = re.split(r'(?<=[.!?]) +', full_text)
        
        print("=== MENTIONS OF TRAIN/TEST SPLIT, HOLDOUT, OR WALK-FORWARD ===")
        found = False
        for s in sentences:
            s_lower = s.lower()
            if ('train' in s_lower and 'test' in s_lower) or \
               ('split' in s_lower) or \
               'holdout' in s_lower or \
               'walk-forward' in s_lower or \
               '80/20' in s_lower:
                
                # filter out false positives
                if 'split' in s_lower and not any(x in s_lower for x in ['data', 'train', 'test', 'time', 'series']):
                    continue
                
                print(f"- {s.strip()}\n")
                found = True
                
        if not found:
            print("No detailed methodology sentences found.")

except Exception as e:
    print(f"Error reading PDF: {e}")
