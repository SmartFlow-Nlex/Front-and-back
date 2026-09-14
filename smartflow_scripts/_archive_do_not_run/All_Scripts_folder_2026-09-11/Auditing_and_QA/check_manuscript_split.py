import PyPDF2
import re
import sys

pdf_path = r'C:\Users\Hans\.gemini\antigravity\scratch\[Revised] 3ISB_Group4_CP-1_Manuscript (1).pdf'

try:
    with open(pdf_path, 'rb') as file:
        reader = PyPDF2.PdfReader(file)
        print(f"Total pages: {len(reader.pages)}")
        
        keywords = ['80', '20', 'split', 'train', 'test', 'holdout', 'validation', 'walk-forward']
        
        matches = []
        for page_num in range(len(reader.pages)):
            text = reader.pages[page_num].extract_text()
            if text:
                lines = text.split('\n')
                for line in lines:
                    line_lower = line.lower()
                    if ('train' in line_lower and 'test' in line_lower) or \
                       ('split' in line_lower and ('80' in line_lower or 'train' in line_lower)) or \
                       'holdout' in line_lower or \
                       'walk-forward' in line_lower:
                        matches.append(f"Page {page_num + 1}: {line.strip()}")
        
        if matches:
            print("\nFound relevant mentions:")
            for m in matches:
                print(m)
        else:
            print("\nNo explicit mentions of train/test splits, 80/20, or holdout found in the text.")

except Exception as e:
    print(f"Error reading PDF: {e}")
