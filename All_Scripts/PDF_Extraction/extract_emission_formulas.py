import PyPDF2
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

pdf_path = r'C:\Users\Hans\.gemini\antigravity\scratch\[Revised] 3ISB_Group4_CP-1_Manuscript (1).pdf'

with open(pdf_path, 'rb') as file:
    reader = PyPDF2.PdfReader(file)
    
    # Section 2.1.8 is about emissions - check pages around 65-90
    # Section 3.9.3.2d is about emissions computation
    keywords = ['emission', 'co2', 'carbon', 'climatiq', 'rith', 'sunio', 'ipcc', 
                'baseline', 'idling', 'penalty', 'ef_api', 'emission factor',
                'g/km', 'g co2', 'vehicle class', 'segment distance']
    
    for page_num in range(len(reader.pages)):
        text = reader.pages[page_num].extract_text()
        if not text:
            continue
        text_lower = text.lower()
        
        # Look for formula-related content
        has_formula = any(k in text_lower for k in ['e_baseline', 'e_penalty', 'ef_api', 'idling penalty', 
                                                      'baseline emission', 'delay-induced', 'carbon excess',
                                                      'rith et al', 'sunio et al', 'emission formula',
                                                      'v_class', 'segment_distance', 'v_impacted'])
        
        if has_formula:
            print(f"\n{'='*80}")
            print(f"PAGE {page_num + 1}")
            print(f"{'='*80}")
            print(text[:3000])
