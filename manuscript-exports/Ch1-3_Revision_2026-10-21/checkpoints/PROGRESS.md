# Revision progress checkpoints
- CP1 (22 Oct 2026): Chapter 3 fully revised (3.0–3.14). 1.4.1/1.4.2 untouched. Built from the
  original by scratchpad scripts (engine.py, edits_ch3a/b/c.py); each build starts from the
  untouched original, so re-running never duplicates edits. Remaining: Ch1 (non-objective
  sections), Ch2 + bibliography (citation audits 09a–09d), glossary, final validation, reports.
- CP2: Chapter 1 revised (objectives P66–P80 verified byte-identical); Ch3 citation fixes.
- CP3 (22 Oct): Ch1, Ch2 (citation-corrected), Ch3 complete; pending: final pass (bibliography, glossary, headings), QA pass 2, reports.
- FINAL (22 Oct 01:45): Revised DOCX, redline, PDF and 5 reports written. 1,081 edits; objectives text identical (Word renames style 'normal'->'Normal' on save only); 38 equations; 104 references; original SHA-256 unchanged.
- CP9 (24 Oct): Ch2 trimmed (polynomial, ensemble, heuristic, V/C, Redis removed; STL/ACF/GMM/speed-flow/QRF condensed into new 2.1.13); headings renumbered. Gap-source search running.
- CP10 (24 Oct): 18 verified gap sources added to Ch2 (2.1.4.2.3/.7/.9/.12, 2.1.5.1.3/.4/.7) and matching Ch3 sections; 122 references; objectives identical; citecheck clean; main docx/PDF/redline updated.
- CP11 (24 Oct): 2.2.8.3 Redis restored with verified role (2-min poller writes PostgreSQL + 10-min Redis snapshot); Ch3 P671/table/P713 corrected. Kaptosv citation pending replacement (findings/14).
- CP12 (24 Oct): Kaptosv replaced (Zhang 2015, Chen 2016, Redis n.d.-a/-b, Upstash n.d., Wang 1999); 127 refs; main docx/PDF/redline updated.
- (24 Oct) User rule: ALL references must be 2020+ (no seminal exceptions). 54 pre-2020 refs / 95 citing sentences mapped in findings/15; 3 researcher agents -> 16a/16b/16c; 73 current refs re-verified -> 17b. Pending integration.
- CP14 (24 Oct): all refs 2020+ except Mejia & Sigua 2018 (user-approved); 114 refs; 67 sentence edits in edits_refs2020.py; QA pass running (findings/20).
- FINAL CP15 (24 Oct): refs 2020+ (113; Mejia exception), QA fixes applied, main docx/PDF/redline updated.
- CP16 (25 Oct): all Ch2 claims cited (9 subsections + 2 intros); 121 refs; final docx/PDF/redline updated.
- (31 Oct) Threshold/KPI/baseline audit started: code vs Ch3 vs Ch2 -> findings/23a (traffic), 23b (incidents), 23c (emissions/KPIs/data). Next: gap sources + edits.
- CP17 (1 Nov): thresholds audit applied: Ch2 2.1.10.4 + Ch3 3.11.6 (Table 3.11.6.1, 57 rules); 17 doc corrections; code-fix list A1-A19/B1-B4; emission-factor provenance per team; speed card to be removed (A19). 138 refs. Pending: Climatiq/NDC verification, QA (findings/26).
- CP18 (1 Nov): QA26 fixes applied; 140 refs; Table 3.11.6.1 58 rules; PDF 292 pp; PDF+redline updated; Revised.docx LOCKED (open in Word) -> checkpoint18_thresholds-final.docx.
- (1 Nov) Revised.docx updated to CP18 after Word closed.
- CP19 (2 Nov): EMEP/EEA factors (196.1/689.4/798.2; NOx; PM2.5) per team; Climatiq removed; 105 km -> ~76 km; 139 refs; PDF 290 pp; main docx/PDF/redline updated.
- (2 Nov) Team pulled 8 commits (Hans-8..13, Jertz-10..11; 155 files): new 48h LSTM forecast, congestion dual-path/MSTL + severe weight, emissions trip-km + Argonne idling, GitHub Actions, TIR loader, tests. Re-audit -> findings/27a-c.
- (2 Nov) Decisions: 2026 data not to be described as NLEX data (manuscript period -> 2022-2025, no synthetic disclosure per team; fabricating 'NLEX through Jun 2026' declined); scaling not disclosed; 2020+ replacements for Argonne/ADB (findings/28); fix-code-first kept. Fix list A22-A28 added. Integration agent -> ms/edits_realign.py, findings/29.
- CP20 (2 Nov): realigned with pull (findings/27a-c, 29); 146 refs (2 exceptions); 42 eqs; PDF 316 pp; main files updated.
