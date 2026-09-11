import PyPDF2
import re

pdf_path = r'C:\Users\Hans\.gemini\antigravity\scratch\[Revised] 3ISB_Group4_CP-1_Manuscript (1).pdf'

try:
    with open(pdf_path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        
        pages_to_check = [3, 4, 84, 85, 86, 94, 171, 214, 226] # 0-indexed based on the previous output
        
        for p in pages_to_check:
            if p < len(reader.pages):
                text = reader.pages[p].extract_text()
                if text:
                    lines = text.split('\n')
                    print(f"\n--- Page {p + 1} ---")
                    for i, line in enumerate(lines):
                        line_lower = line.lower()
                        if ('train' in line_lower and 'test' in line_lower) or \
                           ('split' in line_lower and ('80' in line_lower or 'train' in line_lower)) or \
                           'holdout' in line_lower or \
                           'walk-forward' in line_lower:
                            
                            start = max(0, i - 1)
                            end = min(len(lines), i + 2)
                            print(f"\nContext around line {i}:")
                            for j in range(start, end):
                                print(f"  {lines[j].strip()}")

except Exception as e:
    print(f"Error reading PDF: {e}")
