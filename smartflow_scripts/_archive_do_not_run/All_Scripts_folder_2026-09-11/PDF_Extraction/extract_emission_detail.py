import PyPDF2
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

pdf_path = r'C:\Users\Hans\.gemini\antigravity\scratch\[Revised] 3ISB_Group4_CP-1_Manuscript (1).pdf'

with open(pdf_path, 'rb') as file:
    reader = PyPDF2.PdfReader(file)
    
    # Extract pages 196-200 (0-indexed: 195-199) for the emission formulas section
    for page_num in [195, 196, 197, 198, 199]:
        text = reader.pages[page_num].extract_text()
        if text:
            # Clean up the excessive spacing
            cleaned = ' '.join(text.split())
            print(f"\n{'='*80}")
            print(f"PAGE {page_num + 1}")
            print(f"{'='*80}")
            print(cleaned)
    
    # Also check pages around section 2.1.8 (around page 70-80) for RoL citations
    print("\n\n### CHECKING SECTION 2.1.8 (Review of Literature - Emissions) ###")
    for page_num in range(68, 82):
        text = reader.pages[page_num].extract_text()
        if text:
            text_lower = text.lower()
            if any(k in text_lower for k in ['rith', 'sunio', 'climatiq', 'emission factor', 'ipcc', 'co2', 'carbon']):
                cleaned = ' '.join(text.split())
                print(f"\n{'='*80}")
                print(f"PAGE {page_num + 1}")
                print(f"{'='*80}")
                print(cleaned)
