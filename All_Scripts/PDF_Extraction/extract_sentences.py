import PyPDF2
import re

pdf_path = r'C:\Users\Hans\.gemini\antigravity\scratch\[Revised] 3ISB_Group4_CP-1_Manuscript (1).pdf'

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
