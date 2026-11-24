"""Seed the Lab/Diagnostics test catalogue from the Swecha rate card (10-08-2026) and attach
the related result parameters.

Writes to diag_services, diag_service_pricing_history and diag_service_parameters.

Idempotent and non-destructive:
  * a test whose code OR (case-insensitive) name already exists is skipped; its rate is
    never overwritten;
  * parameters are only added to a service that currently has none.

Usage (from the repo root, against the existing standardversion stack):
  python3 backend/seed_lab_catalogue.py --sql > seed.sql          # emit SQL only
  python3 backend/seed_lab_catalogue.py --sql | docker exec -i standardversion-db psql -U hospai -d hospai -v ON_ERROR_STOP=1
  python3 backend/seed_lab_catalogue.py --report                  # print test -> parameter mapping

Reference ranges are typical adult values, for the clinical lead to review: analyser and
reagent kits differ. Where the range depends on sex/age/cycle the full detail is in ref_text
or comments and the numeric low/high is the combined adult range.
"""
import re
import sys

CODE_PREFIX = "SW-"

DEPTS = {
    "RAD": "Radiology", "SER": "Serology & Immunology", "IMM": "Immunoassay",
    "EBF": "Examination of Body Fluid", "MOL": "Molecular Biology", "BIO": "Biochemistry",
    "URI": "Urine Examination", "HAE": "Haematology", "END": "Endocrinology",
    "MIS": "Miscellaneous", "CLP": "Clinical Pathology", "MIC": "Microbiology",
    "COA": "Coagulation Study", "CBC": "Clinical Biochemistry", "SPU": "Sputum Examination",
    "HOR": "Hormonal Assay", "STO": "Stool Examination", "HIS": "Histopathology",
    "ELE": "Electrolytes", "PRO": "Profile Test", "CYT": "Cytology",
}

# S.No | dept | test name | sample type | price | description   (verbatim from the rate card;
# junk descriptions such as "A", "OBS", "100" are dropped, "null" sample type is blank)
ROWS = """
1|RAD|2D ECHO||1800|
2|RAD|ECG||200|
3|RAD|NST|DOPPLER|300|BABY MOVEMENTS
4|RAD|observation|observation|4000|
5|SER|Anti Nuclear Antibodies|serum|650|
6|SER|ASO Titre|serum|400|
7|SER|Chikungunia|serum|1000|
8|SER|DENGUE PROFILE|serum|1300|
9|SER|MANTOUX TEST|serum|300|
10|SER|HCV -HEPATITIS C VIRUS ANTIBODIES||600|
11|SER|HCV Rapid|serum|300|
12|SER|HCV SCREENING TEST|blood|300|
13|SER|Helicobacter Pylorii IgG|serum|700|
14|SER|Helicobacter Pylorii IgM|serum|700|
15|SER|Hepatitis A virus - IgG|serum|600|
16|SER|Hepatitis A virus - IgM||600|
17|SER|Hepatitis A virus - Total (HAV Total)|serum|800|
18|SER|Hepatitis B Surface Antibodies|serum|500|
19|SER|Hepatitis B surface antigen|serum|500|
20|SER|Hepatitis B surface antigen- Quantitative (Anti Hbs)|serum|500|
21|SER|Herpes Simplex Virus (HSV) 1-IgG|serum|400|
22|SER|Herpes Simplex Virus (HSV) 1-IgM|serum|300|
23|SER|Herpes Simplex Virus (HSV) 2-IgG|serum|300|
24|SER|Herpes Simplex Virus (HSV) 2-IgM|serum|300|
25|SER|HIV ELISA|serum|300|
26|SER|HIV I & II|serum|300|
27|SER|Immunoglobulin M (IgM)|serum|600|
28|SER|Leptospira antibodies|serum|1000|
29|SER|Measles (Rubeola) Antibody IgG|serum|600|
30|SER|Measles (Rubeola) Antibody IgM|serum|600|
31|SER|MT MANTOUX||300|
32|SER|Mumps Virus Antibody IgG|serum|1200|
33|SER|Mumps Virus Antibody IgM|serum|1200|
34|SER|RH Antibody Titre|serum|300|
35|SER|Rheumatoid Factor (RA Qualitative)|serum|400|
36|SER|Rheumatoid Factor (RA Quantitative)|serum|400|
37|SER|Rheumatoid Factor|serum|400|
38|SER|Rubella -IgG|serum|600|
39|SER|Rubella -IgM|serum|600|
40|SER|Scrub Typhus||1500|
41|SER|Scrub Typhus IgG and IgM||1500|
42|SER|Torch IgG|serum|700|
43|SER|Torch IgM||700|
44|SER|Toxoplasma-IgG|serum|250|
45|SER|Toxoplasma-IgM|serum|250|
46|SER|TPHA (Treponema Pallidum Hemagglutination Assay)|serum|400|
47|SER|Typhi dot IgG/IgM|serum|400|
48|SER|URINE COTININE|urine|400|
49|SER|Urine Pregnancy Test|urine|200|
50|SER|VDRL|serum|300|
51|SER|HIV,HBsAG,HCV|blood|900|
52|SER|HIV,HCV,HBsAg|blood|1000|
53|SER|BLOOD FOR HBsAG ESTIMATION|blood|300|
54|SER|WIDAL Test|serum|350|
55|SER|ABG||2000|
56|SER|Blood for RA Factor||300|
57|SER|Enterocheck||400|
58|SER|Serum Cholinesterase level||1000|
59|SER|MP|blood|200|
60|SER|HIV||300|
61|SER|HBSAg||300|
62|SER|T3T4|blood|500|
63|SER|OBS|obs|2500|
64|SER|puss culture||1500|
65|SER|HB%||50|
66|SER|SERUM FERTIN|blood|900|
67|IMM|25 Hydroxy (OH) Vit D||800|
68|IMM|AMH (Anti Mullerian Hormone)|serum|2500|
69|IMM|Anti CCP Antibody|serum|2500|
70|IMM|ANTI-TPO AB(ANTITHYROID PEROXIDASE ANTIBODIES)|serum|1500|
71|IMM|Antiphospholipid Antibodies||1500|
72|IMM|Beta Human Chorionic Gonadotropin (BHCG)|serum|800|
73|IMM|Beta-2-Microglobulin|serum|1500|
74|IMM|CA -19-9|serum|2500|
75|IMM|Ca 15.3-Breast Cancer Marker|serum|850|
76|IMM|CA-125|serum|1500|
77|IMM|Double Marker Test|serum|3600|
78|IMM|Estradiol E2|edta wb|500|
79|IMM|Ferritin|serum|500|
80|IMM|FREE PSA:TOTAL PSA RATIO|serum|300|
81|IMM|Free Testosterone|serum|600|
82|IMM|FT3-TRIIODOTHYRONINE FREE||300|
83|IMM|FT4 (THYROXINE)-SERUM||300|
84|IMM|FT4 & TSH||400|
85|IMM|Insulin|serum|1000|
86|IMM|Interleukin- 6 (IL - 6)|serum|1200|
87|IMM|LH FSH Prolactin||700|
88|IMM|Procalcitonin|serum|750|
89|IMM|PSA (PROSTATE SPECIFIC ANTIGEN)-Serum|serum|600|
90|IMM|Quadruple Marker Test|serum|4000|
91|IMM|T3||150|
92|IMM|T4||150|
93|IMM|TB GOLD|serum|550|
94|IMM|Thyroid Function Test (TFT)|serum|300|
95|IMM|THYROID STIMULATING HORMONE (TSH)|serum|300|
96|IMM|TOTAL IGE|serum|600|
97|IMM|PSA|serum|800|
98|IMM|Triple Marker Test|serum|5000|
99|IMM|TROPONIN - I (Card)|serum|1500|
100|IMM|TROPONIN - I (Quantity)|serum|1500|
101|IMM|Troponin T (Card)|serum|1500|
102|IMM|Troponin T (Quantity)|serum|1500|
103|IMM|VITAMIN B12||1200|
104|IMM|VITAMIN D - TOTAL (25-OH-VIT D)- SERUM||2500|
105|IMM|Vitamin D3 level|serum|1200|
106|EBF|MEDICAL EXAMINATION||1000|
107|MOL|COVID- 19 ANTIGEN TEST||800|
108|MOL|PTINR||600|
109|MOL|NIPT|blood|14000|NIPT
110|BIO|(24HOURS URINE)|urine|500|
111|BIO|24 HOURS URINE MICROALBUMIN|urine|200|
112|BIO|24 HRS URINE PROTEINS|urine|200|
113|BIO|FLUID ANALYSIS|Ascitic Fluid|200|
114|BIO|FBS & PBLS||100|
115|BIO|ADA (ADENOSINE DEAMINASE)-BODY FLUID|body fluid|250|
116|BIO|ANTINATAL PROFILE|blood|1500|
117|BIO|COMPLETE URINE EXAMINATION(CUE)|urine|100|
118|BIO|Alkaline phosphatase (ALP)|serum|200|
119|BIO|ELECTROLYTES|serum|500|
120|BIO|Amylase|serum|800|
121|BIO|Surgical Profile|serum|2500|
122|BIO|SMEAR FOR MALARIAL PARASITE (M.P)|blood|500|
123|BIO|RENAL FUNCTION TESTS (RFT)|blood|500|
124|BIO|Semen Analysis||700|
125|BIO|Bilirubin- Total, Direct, Indirect|serum|250|
126|BIO|BLOOD SUGAR (FASTING)|fluoride plasma|60|
127|BIO|BLOOD SUGAR (PP)|fluoride plasma|60|
128|BIO|BLOOD SUGAR FASTING & PP (BSF & PP)|fluoride plasma|120|
129|BIO|BLOOD SUGAR= RANDOM|fluoride plasma|60|
130|BIO|C- Reactive Protein (CRP) Qualitative|serum|300|
131|BIO|C- Reactive Protein (CRP) Quantitative|serum|300|
132|BIO|Cholesterol|serum|300|
133|BIO|COPPER-SERUM|serum|300|
134|BIO|CPK MB|serum|300|
135|BIO|Creatine Phosphokinase (CPK)|serum|300|
136|BIO|CREATININE (URINE SPOT TEST)|urine|250|
137|BIO|CREATININE CLEARANCE TEST - URINE TEST|urine|300|
138|BIO|Creatinine, 24hrs Urine|urine|250|
139|BIO|ESTIMATED GLOMERULAR FILTRATION RATE(EGFR)|serum|300|
140|BIO|Fasting Urine Sugar|urine|80|
141|BIO|Folic Acid|serum|300|
142|BIO|Gamma Glutamyl Transferase - GGT/GGTP|serum|200|
143|BIO|Globulin||250|
144|BIO|Glucose - Fasting/Postprandial, Urine||120|
145|BIO|HbA1c / Glycosylated|edta wb|500|
146|BIO|HDL Cholesterol|serum|250|
147|BIO|Ionic Calcium|serum|400|
148|BIO|IRON|serum|200|
149|BIO|Iron Profile Test|serum|800|
150|BIO|IRON STUDIES|serum|300|
151|BIO|Lactate Dehydrogenase- Serum (LDH)|serum|300|
152|BIO|LDL Cholesterol|serum|300|
153|BIO|Lipase|serum|800|
154|BIO|LIPID PROFILE|serum|600|
155|BIO|LIVER FUNCTION TEST (LFT)|serum|500|
156|BIO|MICROALBUMINURIA, 24 HR URINE|urine|800|
157|BIO|Oral Glucose Challenge Test (OGCT)|serum|350|
158|BIO|ORAL GLUCOSE TOLERANCE TEST (OGTT)|fluoride plasma|350|
159|BIO|GLUCOSE TOLERANCE TEST (GTT)|urine|350|
160|BIO|OSMOLALITY-URINE|urine|600|
161|BIO|POST GLUCOSE BLOOD SUGAR (2HRS)|fluoride plasma|100|
162|BIO|Post Prandial Urine Sugar|urine|100|
163|BIO|POTASSIUM (K+)|serum|200|
164|BIO|Prostatic Acid Phosphatase|serum|600|
165|BIO|PROTEIN (URINE SPOT TEST)||400|
166|BIO|Random Blood Sugar Test (RBS)|fluoride plasma|100|
167|BIO|Random Blood Sugar Glucometer (RBS)|fluoride plasma|100|
168|BIO|UREA & RBS|fluoride plasma|300|
169|BIO|SAAG||300|
170|BIO|Serum Calcium|serum|300|
171|BIO|SERUM CREATININE||200|
172|BIO|SERUM CREATININE & RBS||300|
173|BIO|Magnesium|serum|200|
174|BIO|Serum Transferrin|serum|700|
175|BIO|SGOT (AST)- SERUM|serum|150|
176|BIO|SGPT(ALT) - SERUM|serum|150|
177|BIO|Sodium (Na)|serum|200|
178|BIO|TORCH PROFILE||5000|
179|BIO|Total Iron Binding Capacity|serum|500|
180|BIO|Serum Total Protein|serum|500|
181|BIO|Transferrin Saturation|serum|700|
182|BIO|Triglycerides|serum|100|
183|BIO|Unsaturated Iron Binding Capacity (UIBC)|serum|300|
184|BIO|UREA|serum|150|
185|BIO|Serum URIC ACID|serum|300|
186|BIO|URINE PROTEIN/CREATININE RATIO|urine|500|
187|BIO|VLDL Cholesterol|serum|300|
188|BIO|VENOUS BLOOD GAS (VBG)||1500|
189|BIO|ARTERIAL BLOOD GAS (ABG)||1500|
190|BIO|PTINR||600|
191|BIO|PTAPTT||600|
192|BIO|Blood for CRP||300|
193|BIO|Urine culture and senstivity||1500|
194|BIO|ICT|blood|1500|
195|BIO|LIQUID PROFILE|blood|800|
196|BIO|FNSC|fluid|2000|
197|BIO|S. BILEACID|blood|3000|
198|BIO|CEA|blood serum|1500|
199|BIO|KARYOTYPING|blood|7000|KARYOTYPING
200|BIO|KARYOTYPING COUPLE|blood|7000|KARYOTYPING
201|BIO|APLA|blood|4900|APLA
202|BIO|SERUM AMYLASE|blood|700|AMYLASE
203|BIO|AFP|blood|1500|AFP
204|BIO|LDH|blood|800|LDH
205|URI|URINE ALBUMIN||100|
206|URI|URINE BS & BP|urine|100|
207|URI|URINE KETONE||300|
208|URI|URINE MICRO-ALBUMIN|urine|400|
209|URI|URINE CULTURE|urine|800|UC
210|URI|urine ketone body|urine|500|
211|HAE|Absolute Eosinophils Count (AEC)|edta wb|300|
212|HAE|Complete Blood Picture(CBP)||200|
213|HAE|Bleeding Time & Clotting Time|edta wb|100|
214|HAE|Haemogram||100|
215|HAE|BLOOD GROUPING|blood|300|
216|HAE|Blood Group & Rh factor|edta wb|100|
217|HAE|CD4 Absolute Count|edta plasma|1100|
218|HAE|CD4 Count|edta plasma|1000|
219|HAE|Direct Coombs Test (DCT)|edta wb|500|
220|HAE|DLC- Differential Leucocytes Count|edta wb|200|
221|HAE|Erythrocyte Sedimentation Rate (ESR)||300|
222|HAE|Fibrinogen|edta plasma|800|
223|HAE|Glucose-6-Phosphate Dehydrogenase|edta wb|500|
224|HAE|Haemoglobin (Hb)|edta wb|100|
225|HAE|HAEMOGLOBIN ELECTROPHORESIS (HPLC)||1200|
226|HAE|HLA B27|edta wb|1600|
227|HAE|Immature Platelet Fraction (IPF)|edta wb|5000|
228|HAE|Indirect Coomb's Test (ICT)|edta wb|600|
229|HAE|LE Cells||500|
230|HAE|LUPUS ANTICOAGULANT||1100|
231|HAE|Malaria Parasite|edta wb|300|
232|HAE|Malarial Antigen|edta wb|500|
233|HAE|Microfilaria Test QBC|edta wb|600|
234|HAE|PCV (Haematocrit)|edta wb|0|
235|HAE|Peripheral Blood Smear/ GBP|edta wb|600|
236|HAE|Platelet Count (PL Count)|edta wb|150|
237|HAE|Reticulocyte Count|edta wb|300|
238|HAE|Sickling Test|edta wb|450|
239|HAE|TLC- Total Leucocytes Count|edta wb|300|
240|HAE|COAGULATION PROFILE||1500|
241|END|17 - Hydroxyprogesterone ( 17-OHP)|serum|1500|
242|END|Androstenedione|serum|800|
243|END|C-PEPTIDE|serum|1000|
244|END|Cortisol AM|serum|700|
245|END|Cortisol PM|serum|700|
246|END|Dihydrotestosterone (DHT)||2500|
247|END|PLGF (Placental Growth Factor)||6000|
248|END|Progesterone||800|
249|MIS|Carcino Embryonic Antigen-CEA||600|
250|MIS|Nt- ProBNP (N-Terminal Pro B Type Natriuretic Peptide)||2500|
251|CLP|Glomerular Filtration Rate- GFR||400|
252|CLP|CUE|URINE|100|
253|MIC|Blood Culture & Sensitivity|wb in culture bottle|1500|
254|MIC|Gene Expert||400|
255|MIC|Motion Culture|stool|400|
256|MIC|PUS CULTURE TEST||1000|
257|MIC|Sputum Culture & Sensitivity|sputum|300|
258|MIC|Urine Alubmin & Creatnine Ratio (ACR)|urine|600|
259|MIC|Vaginal Swab for Culture & Sensitivity|vaginal swab|1000|
260|MIC|Wound Swab|wound swab|1000|
261|MIC|MALARIAL PARASITE (PF/PV)||400|
262|MIC|Leptocheck||3000|
263|MIC|Pus for culture and sensitivity||1500|
264|MIC|SMALL BIOPSY|specimen|2500|BIOPSY
265|COA|D-Dimer|sodium citrate 3.2 % plasma specimen|3000|
266|CBC|Apolipoprotein A1 (APO-A1)|serum|600|
267|CBC|Apolipoprotein B (APO-B)|serum|600|
268|CBC|Protein Electrophoresis|serum|1200|
269|CBC|Rh Factor (Quantity)|edta wb|300|
270|CBC|Rh Factor (Slide)|edta wb|300|
271|CBC|Serum Zinc|serum|400|
272|CBC|THYROID ANTIBODIES||800|
273|CBC|THYROID PROFILE I||500|
274|SPU|Gram Stain|sputum|300|
275|SPU|SPUTUM FOR ACID FAST BACILLI ( AFB )|sputum|600|
276|HOR|Growth Hormone|serum|650|
277|HOR|Luteinizing Hormone (LH)|serum|350|
278|HOR|PARATHYROID HORMONE (PTH)|serum|1000|
279|HOR|APLA PROFLIE|blood|5000|
280|STO|Stool for Hanging Drop|stool|400|
281|STO|Stool for Occult Blood|stool|400|
282|STO|Stool for Reducing Substances|stool|400|
283|HIS|Histopathology Small||800|
284|HIS|BIOPSY|specimen|4000|
285|ELE|Chlorides|serum|200|
286|ELE|Electrolytes Panel|serum|500|
287|ELE|PHOSPHROUS (PO4)|serum|200|
288|ELE|Sodium Potassium (Na,K)|serum|400|
289|PRO|FSH (FOLLICLE STIMULATING HORMONE)-SERUM||750|
290|PRO|LH (LEUTNISING HORMONE)-SERUM||750|
291|PRO|SERUM PROLACTIN||750|
292|CYT|FNAC (Fine needle aspiration cytology)||1000|
293|CYT|PAP SMEAR (GYNEC CYTOLOGY)||1500|
""".strip().splitlines()

# ---------------------------------------------------------------------------
# Parameter builders: n=numeric, q=qualitative, t=free text
# ---------------------------------------------------------------------------

def n(name, unit, lo=None, hi=None, text=None, cl=None, ch=None, cm=None, method=None):
    return dict(name=name, data_type="numeric", unit=unit, ref_low=lo, ref_high=hi, ref_text=text,
                critical_low=cl, critical_high=ch, comments=cm, method=method)


def q(name, ref="Non-reactive", cm=None):
    return dict(name=name, data_type="qualitative", ref_text=ref, comments=cm)


def t(name, ref=None):
    return dict(name=name, data_type="text", ref_text=ref)


NEG = "Negative"
NR = "Non-reactive"

# --- reusable parameter groups ---------------------------------------------------------
LIPID = [
    n("Total Cholesterol", "mg/dL", None, 200, "<200 desirable"),
    n("Triglycerides", "mg/dL", None, 150, "<150 normal"),
    n("HDL Cholesterol", "mg/dL", 40, 60, ">40 (M), >50 (F)"),
    n("LDL Cholesterol", "mg/dL", None, 100, "<100 optimal"),
    n("VLDL Cholesterol", "mg/dL", 2, 30),
    n("Total Cholesterol / HDL Ratio", "", None, 5, "<5.0"),
]
CBP = [
    n("Haemoglobin", "g/dL", 12, 17, cl=7, ch=20, cm="Male 13-17, Female 12-15"),
    n("Total Leucocyte Count", "cells/cumm", 4000, 11000, cl=2000, ch=30000),
    n("Neutrophils", "%", 40, 75),
    n("Lymphocytes", "%", 20, 45),
    n("Eosinophils", "%", 1, 6),
    n("Monocytes", "%", 2, 10),
    n("Basophils", "%", 0, 1),
    n("RBC Count", "million/cumm", 3.8, 5.5, cm="Male 4.5-5.5, Female 3.8-4.8"),
    n("PCV (Haematocrit)", "%", 36, 50, cm="Male 40-50, Female 36-46"),
    n("MCV", "fL", 83, 101),
    n("MCH", "pg", 27, 32),
    n("MCHC", "g/dL", 31.5, 34.5),
    n("RDW-CV", "%", 11.6, 14),
    n("Platelet Count", "lakh/cumm", 1.5, 4.5, cl=0.5, ch=10),
    t("Peripheral Smear"),
]
DLC = [n("Neutrophils", "%", 40, 75), n("Lymphocytes", "%", 20, 45), n("Eosinophils", "%", 1, 6),
       n("Monocytes", "%", 2, 10), n("Basophils", "%", 0, 1)]
LFT = [
    n("Total Bilirubin", "mg/dL", 0.3, 1.2),
    n("Direct Bilirubin", "mg/dL", 0, 0.3),
    n("Indirect Bilirubin", "mg/dL", 0.2, 0.9),
    n("SGOT (AST)", "U/L", 5, 40),
    n("SGPT (ALT)", "U/L", 5, 40),
    n("Alkaline Phosphatase (ALP)", "U/L", 44, 147),
    n("Total Protein", "g/dL", 6.4, 8.3),
    n("Albumin", "g/dL", 3.5, 5.2),
    n("Globulin", "g/dL", 2.0, 3.5),
    n("A/G Ratio", "", 1.1, 2.2),
]
NA = n("Sodium (Na+)", "mmol/L", 135, 145, cl=120, ch=160)
K = n("Potassium (K+)", "mmol/L", 3.5, 5.1, cl=2.5, ch=6.5)
CL = n("Chloride (Cl-)", "mmol/L", 98, 107)
UREA = n("Blood Urea", "mg/dL", 15, 45)
CREAT = n("Serum Creatinine", "mg/dL", 0.6, 1.3, ch=10, cm="Male 0.7-1.3, Female 0.6-1.1")
URIC = n("Serum Uric Acid", "mg/dL", 2.6, 7.2, cm="Male 3.5-7.2, Female 2.6-6.0")
RBS = n("Random Blood Sugar", "mg/dL", 70, 140, cl=40, ch=500)
FBS = n("Fasting Blood Sugar", "mg/dL", 70, 100, cl=40, ch=500)
PPBS = n("Post Prandial Blood Sugar", "mg/dL", 70, 140, cl=40, ch=500)
HB = n("Haemoglobin", "g/dL", 12, 17, cl=7, ch=20, cm="Male 13-17, Female 12-15")
TLC = n("Total Leucocyte Count", "cells/cumm", 4000, 11000, cl=2000, ch=30000)
PLT = n("Platelet Count", "lakh/cumm", 1.5, 4.5, cl=0.5, ch=10)
PT = [n("Prothrombin Time (PT) - Test", "sec", 11, 13.5), n("PT - Control", "sec"),
      n("INR", "", 0.8, 1.2, ch=5)]
APTT = n("APTT", "sec", 25, 35)
HIV = q("HIV 1 & 2 Antibodies", NR)
HBSAG = q("HBsAg", NR)
HCV = q("HCV Antibodies", NR)
VDRL = q("VDRL", NR)
BLOODGROUP = [t("ABO Blood Group"), q("Rh (D) Factor", "Positive / Negative")]
URINE_ROUTINE = [
    t("Colour", "Pale yellow"), t("Appearance", "Clear"),
    n("Specific Gravity", "", 1.005, 1.030), n("Urine pH", "", 4.6, 8.0),
    q("Urine Albumin", "Nil"), q("Urine Sugar", "Nil"), q("Urine Ketones", "Nil"),
    q("Bile Salts", "Nil"), q("Bile Pigments", "Nil"), q("Urobilinogen", "Normal"),
    n("Pus Cells", "/HPF", 0, 5), n("Epithelial Cells", "/HPF", 0, 5), n("RBCs", "/HPF", 0, 2, "Nil"),
    q("Casts", "Nil"), q("Crystals", "Nil"), t("Others"),
]
CULTURE = [t("Culture Result"), t("Organism Isolated"), t("Colony Count"), t("Antibiotic Sensitivity")]
TORCH_G = [q("Toxoplasma IgG", NEG), q("Rubella IgG", NEG), q("Cytomegalovirus (CMV) IgG", NEG), q("Herpes Simplex (HSV) IgG", NEG)]
TORCH_M = [q("Toxoplasma IgM", NEG), q("Rubella IgM", NEG), q("Cytomegalovirus (CMV) IgM", NEG), q("Herpes Simplex (HSV) IgM", NEG)]
TFT = [n("T3 (Total Triiodothyronine)", "ng/mL", 0.8, 2.0), n("T4 (Total Thyroxine)", "ug/dL", 5.1, 14.1),
       n("TSH", "uIU/mL", 0.27, 4.2)]
IRON = [n("Serum Iron", "ug/dL", 60, 170, cm="Male 65-175, Female 50-170"),
        n("TIBC", "ug/dL", 250, 450), n("UIBC", "ug/dL", 110, 370),
        n("Transferrin Saturation", "%", 20, 50)]
GLUC_CURVE = [n("Fasting", "mg/dL", 70, 100), n("1 Hour", "mg/dL", None, 180), n("2 Hour", "mg/dL", None, 140)]
APLA = [n("Anticardiolipin IgG", "GPL", None, 12), n("Anticardiolipin IgM", "MPL", None, 12),
        n("Beta-2 Glycoprotein I IgG", "U/mL", None, 20), n("Beta-2 Glycoprotein I IgM", "U/mL", None, 20)]
MARKER_RISK = [t("Risk for Trisomy 21 (Down syndrome)"), t("Risk for Trisomy 18 (Edwards syndrome)")]
HISTO = [t("Specimen / Clinical Details"), t("Gross Examination"), t("Microscopic Examination"), t("Impression / Diagnosis")]
FAST_SUGAR_NIL = q("Urine Sugar", "Nil")
CRP_Q = n("C-Reactive Protein (CRP)", "mg/L", None, 6, "<6")
MALARIA_Q = [q("Plasmodium falciparum (PF)", NEG), q("Plasmodium vivax (PV)", NEG)]
ABG = [n("pH", "", 7.35, 7.45, cl=7.2, ch=7.6), n("pCO2", "mmHg", 35, 45), n("pO2", "mmHg", 80, 100, cl=50),
       n("HCO3", "mmol/L", 22, 26), n("Base Excess", "mmol/L", -2, 2), n("SaO2", "%", 95, 100, cl=85)]
VBG = [n("pH", "", 7.31, 7.41, cl=7.2, ch=7.6), n("pCO2", "mmHg", 41, 51), n("pO2", "mmHg", 25, 40),
       n("HCO3", "mmol/L", 22, 28), n("Base Excess", "mmol/L", -2, 2), n("SaO2", "%", 60, 85)]

# --- ordered rules: first regex (on lower-cased test name) that matches wins -------------
RULES = [
    # panels / profiles
    (r"^complete blood picture|^haemogram", CBP),
    (r"^dlc", DLC),
    (r"coagulation profile", PT + [APTT]),
    (r"^ptaptt", PT + [APTT]),
    (r"^ptinr", PT),
    (r"lipid profile|liquid profile", LIPID),
    (r"liver function", LFT),
    (r"renal function", [UREA, CREAT, URIC, NA, K, CL]),
    (r"electrolytes|sodium potassium", None),  # handled below (panel vs. na,k)
    (r"antinatal profile", [HB, *BLOODGROUP, RBS, HIV, HBSAG, VDRL, q("Urine Albumin", "Nil"), q("Urine Sugar", "Nil")]),
    (r"surgical profile", [HB, TLC, PLT, *BLOODGROUP, n("Bleeding Time", "min", 2, 7), n("Clotting Time", "min", 4, 9),
                           RBS, UREA, CREAT, HIV, HBSAG, HCV]),
    (r"^torch profile", [*TORCH_G, *TORCH_M]),
    (r"^torch igg", TORCH_G),
    (r"^torch igm", TORCH_M),
    (r"apla profl?ie|^apla$|antiphospholipid", APLA),
    (r"iron profile|iron studies", IRON + [n("Serum Ferritin", "ng/mL", 13, 400, cm="Male 30-400, Female 13-150")]),
    (r"^thyroid function test|^thyroid profile", TFT),
    (r"^t3t4", [TFT[0], TFT[1]]),
    (r"^ft4 & tsh", [n("Free T4 (FT4)", "ng/dL", 0.8, 1.8), TFT[2]]),
    (r"^lh fsh prolactin", None),
    (r"^thyroid antibodies", [n("Anti-TPO Antibodies", "IU/mL", None, 35), n("Anti-Thyroglobulin Antibodies", "IU/mL", None, 40)]),
    (r"double marker", [n("Free Beta hCG", "MoM", text="Reported as MoM"), n("PAPP-A", "MoM", text="Reported as MoM"), *MARKER_RISK[:2]]),
    (r"triple marker", [n("AFP", "MoM", text="Reported as MoM"), n("hCG", "MoM", text="Reported as MoM"),
                        n("Unconjugated Estriol (uE3)", "MoM", text="Reported as MoM"), *MARKER_RISK]),
    (r"quadruple marker", [n("AFP", "MoM", text="Reported as MoM"), n("hCG", "MoM", text="Reported as MoM"),
                           n("Unconjugated Estriol (uE3)", "MoM", text="Reported as MoM"),
                           n("Inhibin A", "MoM", text="Reported as MoM"), *MARKER_RISK]),
    (r"^nipt", [t("Trisomy 21 (Down syndrome)", "Low risk"), t("Trisomy 18 (Edwards syndrome)", "Low risk"),
                t("Trisomy 13 (Patau syndrome)", "Low risk"), t("Sex chromosome aneuploidy", "Not detected"), t("Fetal fraction")]),
    (r"karyotyping", [t("Karyotype"), n("Number of Metaphases Counted", "", None, None), t("Interpretation")]),
    (r"complete urine examination|^cue$", URINE_ROUTINE),
    (r"semen analysis", [n("Volume", "mL", 1.5, None, ">=1.5"), n("Liquefaction Time", "min", None, 60),
                         n("pH", "", 7.2, 8.0), n("Sperm Concentration", "million/mL", 15, None, ">=15"),
                         n("Total Motility", "%", 40, None, ">=40"), n("Progressive Motility", "%", 32, None, ">=32"),
                         n("Normal Morphology", "%", 4, None, ">=4"), n("Vitality", "%", 58, None, ">=58"),
                         n("Pus Cells", "/HPF", 0, 5)]),
    (r"^bilirubin", [LFT[0], LFT[1], LFT[2]]),
    (r"^chikungunia|^chikungunya", [q("Chikungunya IgM", NEG)]),
    (r"dengue profile", [q("Dengue NS1 Antigen", NEG), q("Dengue IgM", NEG), q("Dengue IgG", NEG)]),
    (r"^widal", [t("S. Typhi O (TO) titre", "<1:80"), t("S. Typhi H (TH) titre", "<1:80"),
                 t("S. Paratyphi AH titre", "<1:80"), t("S. Paratyphi BH titre", "<1:80")]),
    (r"typhi dot|scrub typhus|^leptocheck", [q("IgM", NEG), q("IgG", NEG)]),
    (r"^hiv,|^hiv,h", [HIV, HBSAG, HCV]),
    # blood sugar family
    (r"fbs & pbls|fasting & pp", [FBS, PPBS]),
    (r"^blood sugar \(fasting\)", [FBS]),
    (r"^blood sugar \(pp\)|^post glucose blood sugar", [PPBS]),
    (r"^blood sugar= random|^random blood sugar", [RBS]),
    (r"^urea & rbs", [UREA, RBS]),
    (r"^serum creatinine & rbs", [CREAT, RBS]),
    (r"oral glucose challenge", [n("Blood Glucose 1 Hour (after 50 g glucose)", "mg/dL", None, 140)]),
    (r"glucose tolerance test", GLUC_CURVE),
    (r"^hba1c", [n("HbA1c", "%", 4.0, 5.6, "<5.7 normal; 5.7-6.4 pre-diabetes; >=6.5 diabetes"),
                 n("Estimated Average Glucose (eAG)", "mg/dL")]),
    (r"^arterial blood gas|^abg", ABG),
    (r"^venous blood gas", VBG),
    # microbiology
    (r"culture|^puss culture|^wound swab", CULTURE),
    (r"^gene expert", [q("MTB (M. tuberculosis) detection", "Not detected"), q("Rifampicin resistance", "Not detected")]),
    (r"^gram stain", [t("Gram stain findings"), t("Pus cells"), t("Organisms seen")]),
    (r"acid fast", [q("AFB Smear", "Negative (no AFB seen)"), t("Grading")]),
    (r"hanging drop", [t("Motile organisms", "Not seen")]),
    (r"occult blood", [q("Occult Blood", NEG)]),
    (r"reducing substances", [q("Reducing Substances", NEG)]),
    (r"malarial antigen|pf/pv", MALARIA_Q),
    (r"malaria|^mp$|^mp blood", [q("Malaria Parasite", "Not seen")]),
    (r"microfilaria", [q("Microfilaria", "Not seen")]),
    (r"sickling", [q("Sickling Test", NEG)]),
    # haematology
    (r"blood group|blood grouping", BLOODGROUP),
    (r"^rh factor", [q("Rh (D) Factor", "Positive / Negative")]),
    (r"bleeding time", [n("Bleeding Time", "min", 2, 7), n("Clotting Time", "min", 4, 9)]),
    (r"^cd4", [n("CD4 Count", "cells/uL", 500, 1500, cl=200)]),
    (r"coombs|^ict", [q("Result", NEG)]),
    (r"sedimentation", [n("ESR (1st hour)", "mm/hr", 0, 20, cm="Male 0-15, Female 0-20")]),
    (r"^fibrinogen", [n("Fibrinogen", "mg/dL", 200, 400)]),
    (r"glucose-6-phosphate", [n("G6PD", "U/g Hb", 4.6, 13.5)]),
    (r"^haemoglobin \(hb\)|^hb%", [HB]),
    (r"electrophoresis \(hplc\)", [n("HbA", "%", 95, 98), n("HbA2", "%", 1.5, 3.5), n("HbF", "%", None, 2), t("Abnormal variants (HbS / HbD / HbC etc.)", "Not detected")]),
    (r"^hla b27", [q("HLA B27", NEG)]),
    (r"immature platelet", [n("Immature Platelet Fraction (IPF)", "%", 1.1, 6.1)]),
    (r"^le cells", [q("LE Cells", "Not seen")]),
    (r"lupus anticoagulant", [n("Lupus Anticoagulant (dRVVT ratio)", "", 0.8, 1.2)]),
    (r"^pcv", [n("PCV (Haematocrit)", "%", 36, 50)]),
    (r"peripheral blood smear", [t("RBC Morphology"), t("WBC Morphology"), t("Platelets"), t("Impression")]),
    (r"^platelet count", [PLT]),
    (r"^reticulocyte", [n("Reticulocyte Count", "%", 0.5, 2.5)]),
    (r"^tlc", [TLC]),
    (r"absolute eosinophils", [n("Absolute Eosinophil Count", "cells/cumm", 40, 440)]),
    (r"d-dimer", [n("D-Dimer", "ng/mL FEU", None, 500, "<500")]),
    # serology / viral markers
    (r"anti nuclear", [q("ANA", NEG, "Report titre and pattern if positive")]),
    (r"^aso titre", [n("ASO Titre", "IU/mL", None, 200, "<200")]),
    (r"mantoux", [n("Induration at 48-72 hrs", "mm", None, 10, "<10 mm negative")]),
    (r"hepatitis b surface antibodies|\(anti hbs\)", [n("Anti-HBs (quantitative)", "mIU/mL", 10, None, ">10 protective")]),
    (r"hepatitis b surface antigen|^hbsag|hbsag estimation", [HBSAG]),
    (r"^hcv", [HCV]),
    (r"^hiv", [HIV]),
    (r"hepatitis a virus - total", [q("HAV Total Antibodies", NR)]),
    (r"hepatitis a virus - igg", [q("HAV IgG", NR)]),
    (r"hepatitis a virus - igm", [q("HAV IgM", NR)]),
    (r"helicobacter pylorii igg", [q("H. pylori IgG", NEG)]),
    (r"helicobacter pylorii igm", [q("H. pylori IgM", NEG)]),
    (r"herpes simplex.*igg", [q("HSV IgG", NEG)]),
    (r"herpes simplex.*igm", [q("HSV IgM", NEG)]),
    (r"^immunoglobulin m", [n("Immunoglobulin M (IgM)", "mg/dL", 40, 230)]),
    (r"leptospira", [q("Leptospira IgM", NEG)]),
    (r"measles.*igg", [q("Measles IgG", "Positive indicates immunity")]),
    (r"measles.*igm", [q("Measles IgM", NEG)]),
    (r"mumps.*igg", [q("Mumps IgG", "Positive indicates immunity")]),
    (r"mumps.*igm", [q("Mumps IgM", NEG)]),
    (r"^mt mantoux", [n("Induration at 48-72 hrs", "mm", None, 10, "<10 mm negative")]),
    (r"rh antibody titre", [t("Rh Antibody Titre", "No antibodies detected")]),
    (r"rheumatoid factor \(ra qualitative\)", [q("RA Factor", NEG)]),
    (r"rheumatoid factor|ra factor", [n("RA Factor", "IU/mL", None, 14, "<14")]),
    (r"rubella -igg", [q("Rubella IgG", "Positive indicates immunity")]),
    (r"rubella -igm", [q("Rubella IgM", NEG)]),
    (r"toxoplasma-igg", [q("Toxoplasma IgG", NEG)]),
    (r"toxoplasma-igm", [q("Toxoplasma IgM", NEG)]),
    (r"^tpha", [q("TPHA", NR)]),
    (r"^vdrl", [VDRL]),
    (r"urine cotinine", [q("Urine Cotinine", NEG)]),
    (r"urine pregnancy", [q("Urine Pregnancy Test (UPT)", NEG)]),
    (r"^enterocheck", [q("Typhoid IgM", NEG), q("Typhoid IgG", NEG)]),
    (r"^serum cholinesterase", [n("Serum Cholinesterase", "U/L", 5300, 12900)]),
    (r"^tb gold", [q("Interferon-Gamma Release Assay (IGRA)", NEG)]),
    (r"covid", [q("SARS-CoV-2 Antigen", NEG)]),
    # immunoassay / hormones / markers
    (r"vit d|vitamin d", [n("Vitamin D (25-OH)", "ng/mL", 30, 100, "<20 deficient; 20-29 insufficient; 30-100 sufficient", cl=None)]),
    (r"^amh", [n("AMH", "ng/mL", 1.0, 3.5, cm="Age dependent; low <1.0")]),
    (r"anti ccp", [n("Anti-CCP", "U/mL", None, 20, "<20 negative")]),
    (r"anti-tpo", [n("Anti-TPO Antibodies", "IU/mL", None, 35, "<35")]),
    (r"beta human chorionic", [n("Beta hCG", "mIU/mL", None, 5, "<5 non-pregnant")]),
    (r"beta-2-microglobulin", [n("Beta-2 Microglobulin", "mg/L", 0.8, 2.4)]),
    (r"ca -19-9", [n("CA 19-9", "U/mL", None, 37, "<37")]),
    (r"ca 15\.3", [n("CA 15.3", "U/mL", None, 31.3, "<31.3")]),
    (r"^ca-125", [n("CA-125", "U/mL", None, 35, "<35")]),
    (r"^estradiol", [n("Estradiol (E2)", "pg/mL", text="Male 11-44; Female follicular 19-144, luteal 55-214, post-menopausal <32")]),
    (r"^ferritin|^serum fertin", [n("Serum Ferritin", "ng/mL", 13, 400, cm="Male 30-400, Female 13-150")]),
    (r"free psa", [n("Total PSA", "ng/mL", 0, 4), n("Free PSA", "ng/mL"), n("Free / Total PSA Ratio", "%", text=">25% suggests benign; <10% suggests higher malignancy risk")]),
    (r"free testosterone", [n("Free Testosterone", "pg/mL", text="Male 5.2-20.7; Female 0.3-1.9")]),
    (r"^ft3", [n("Free T3 (FT3)", "pg/mL", 2.0, 4.4)]),
    (r"^ft4", [n("Free T4 (FT4)", "ng/dL", 0.8, 1.8)]),
    (r"^insulin", [n("Insulin (Fasting)", "uIU/mL", 2.6, 24.9)]),
    (r"interleukin", [n("Interleukin-6 (IL-6)", "pg/mL", None, 7, "<7")]),
    (r"procalcitonin", [n("Procalcitonin", "ng/mL", None, 0.5, "<0.5 low risk of sepsis")]),
    (r"^psa", [n("PSA (Total)", "ng/mL", 0, 4)]),
    (r"^t3$", [TFT[0]]),
    (r"^t4$", [TFT[1]]),
    (r"stimulating hormone \(tsh\)", [TFT[2]]),
    (r"total ige", [n("Total IgE", "IU/mL", None, 100, "<100")]),
    (r"troponin - i \(card\)|troponin t \(card\)", [q("Troponin", NEG)]),
    (r"troponin - i \(quantity\)", [n("Troponin I", "ng/mL", None, 0.04, "<0.04", ch=0.4)]),
    (r"troponin t \(quantity\)", [n("Troponin T", "ng/mL", None, 0.014, "<0.014")]),
    (r"vitamin b12", [n("Vitamin B12", "pg/mL", 200, 900)]),
    (r"^folic acid", [n("Folic Acid", "ng/mL", 3.1, 17.5)]),
    (r"cortisol am", [n("Cortisol (AM)", "ug/dL", 6.2, 19.4)]),
    (r"cortisol pm", [n("Cortisol (PM)", "ug/dL", 2.3, 11.9)]),
    (r"17-ohp|hydroxyprogesterone", [n("17-OH Progesterone", "ng/mL", text="Male <2.5; Female follicular 0.2-1.0, luteal 0.5-3.0")]),
    (r"androstenedione", [n("Androstenedione", "ng/mL", text="Male 0.4-1.7; Female 0.3-3.3")]),
    (r"c-peptide", [n("C-Peptide", "ng/mL", 1.1, 4.4)]),
    (r"dihydrotestosterone", [n("Dihydrotestosterone (DHT)", "pg/mL", text="Male 250-990; Female 24-368")]),
    (r"plgf", [n("PLGF", "pg/mL", text="20-35 weeks: >=100 normal; 12-99 reduced; <12 high risk of pre-eclampsia")]),
    (r"^progesterone", [n("Progesterone", "ng/mL", text="Follicular <1.5; luteal 5-20; male <1.4")]),
    (r"^growth hormone", [n("Growth Hormone", "ng/mL", 0, 8, cm="Male <3, Female <8")]),
    (r"^luteinizing|^lh \(", [n("LH", "mIU/mL", text="Male 1.7-8.6; Female follicular 2.4-12.6, mid-cycle 14-96, luteal 1.0-11.4, post-menopausal 7.7-58")]),
    (r"^fsh", [n("FSH", "mIU/mL", text="Male 1.5-12.4; Female follicular 3.5-12.5, mid-cycle 4.7-21.5, luteal 1.7-7.7, post-menopausal 25.8-134.8")]),
    (r"prolactin", [n("Prolactin", "ng/mL", 4, 25, cm="Male 4-15, Female 4-25")]),
    (r"parathyroid", [n("Parathyroid Hormone (PTH)", "pg/mL", 15, 65)]),
    (r"^carcino|^cea$", [n("CEA", "ng/mL", 0, 5, cm="Smokers up to 10")]),
    (r"probnp", [n("NT-proBNP", "pg/mL", None, 125, "<125")]),
    (r"^afp", [n("Alpha Fetoprotein (AFP)", "ng/mL", None, 10, "<10 (non-pregnant)")]),
    (r"^apolipoprotein a1", [n("Apolipoprotein A1", "mg/dL", 110, 215)]),
    (r"^apolipoprotein b", [n("Apolipoprotein B", "mg/dL", 55, 140)]),
    (r"protein electrophoresis", [n("Total Protein", "g/dL", 6.4, 8.3), n("Albumin", "g/dL", 3.5, 5.2), n("Alpha-1 Globulin", "g/dL", 0.1, 0.4),
                                  n("Alpha-2 Globulin", "g/dL", 0.4, 0.9), n("Beta Globulin", "g/dL", 0.6, 1.1),
                                  n("Gamma Globulin", "g/dL", 0.7, 1.6), n("A/G Ratio", "", 1.1, 2.2), t("M-band", "Not detected")]),
    (r"serum zinc", [n("Serum Zinc", "ug/dL", 70, 120)]),
    (r"^copper", [n("Serum Copper", "ug/dL", 70, 155, cm="Male 70-140, Female 80-155")]),
    # biochemistry singles
    (r"^alkaline phosphatase", [LFT[5]]),
    (r"amylase", [n("Amylase", "U/L", 28, 100)]),
    (r"^lipase", [n("Lipase", "U/L", 13, 60)]),
    (r"crp\)? qualitative", [q("C-Reactive Protein (CRP)", NEG)]),
    (r"crp|^blood for crp", [CRP_Q]),
    (r"^cholesterol", [LIPID[0]]),
    (r"^cpk mb", [n("CPK-MB", "U/L", None, 25, "<25")]),
    (r"creatine phosphokinase", [n("CPK (Total)", "U/L", 26, 308, cm="Male 39-308, Female 26-192")]),
    (r"creatinine \(urine spot", [n("Urine Creatinine (spot)", "mg/dL", text="20-320")]),
    (r"creatinine clearance", [n("Creatinine Clearance", "mL/min", 85, 125, cm="Male 97-137, Female 88-128")]),
    (r"creatinine, 24hrs", [n("24 hr Urine Creatinine", "mg/24 hr", text="Male 955-2936; Female 601-1689"), n("Total Urine Volume", "mL")]),
    (r"glomerular filtration|egfr", [n("eGFR", "mL/min/1.73m2", 90, None, ">=90", cl=15)]),
    (r"fasting urine sugar|post prandial urine sugar|glucose - fasting/postprandial, urine", [FAST_SUGAR_NIL]),
    (r"gamma glutamyl", [n("GGT", "U/L", 9, 64, cm="Male 12-64, Female 9-36")]),
    (r"^globulin", [LFT[8]]),
    (r"^hdl", [LIPID[2]]),
    (r"^ldl", [LIPID[3]]),
    (r"^vldl", [LIPID[4]]),
    (r"^triglycerides", [LIPID[1]]),
    (r"ionic calcium", [n("Ionic Calcium", "mmol/L", 1.12, 1.32)]),
    (r"^iron$", [IRON[0]]),
    (r"total iron binding", [IRON[1]]),
    (r"unsaturated iron", [IRON[2]]),
    (r"transferrin saturation", [IRON[3]]),
    (r"serum transferrin", [n("Transferrin", "mg/dL", 200, 360)]),
    (r"lactate dehydrogenase|^ldh$", [n("LDH", "U/L", 140, 280)]),
    (r"^microalbuminuria|24 hours urine microalbumin", [n("Urine Microalbumin (24 hr)", "mg/24 hr", 0, 30), n("Total Urine Volume", "mL")]),
    (r"^urine micro-albumin", [n("Urine Microalbumin", "mg/L", 0, 30)]),
    (r"osmolality", [n("Urine Osmolality", "mOsm/kg", 50, 1200)]),
    (r"^potassium", [K]),
    (r"^sodium \(na\)", [NA]),
    (r"^chlorides", [CL]),
    (r"phosphrous", [n("Phosphorus (Inorganic)", "mg/dL", 2.5, 4.5)]),
    (r"^magnesium", [n("Magnesium", "mg/dL", 1.6, 2.6)]),
    (r"^serum calcium", [n("Calcium", "mg/dL", 8.6, 10.2)]),
    (r"prostatic acid", [n("Prostatic Acid Phosphatase", "ng/mL", 0, 3.5)]),
    (r"protein \(urine spot", [n("Urine Protein (spot)", "mg/dL", 0, 14)]),
    (r"protein/creatinine ratio", [n("Urine Protein / Creatinine Ratio", "mg/mg", None, 0.2, "<0.2")]),
    (r"alubmin & creatnine|albumin.*creatinine ratio", [n("Urine Albumin / Creatinine Ratio (ACR)", "mg/g", None, 30, "<30")]),
    (r"^24 hrs urine proteins", [n("24 hr Urine Protein", "mg/24 hr", 0, 150), n("Total Urine Volume", "mL")]),
    (r"^\(24hours urine\)", [n("Total Urine Volume (24 hr)", "mL"), t("Result")]),
    (r"^saag", [n("SAAG (Serum-Ascites Albumin Gradient)", "g/dL", text=">=1.1 suggests portal hypertension; <1.1 non-portal")]),
    (r"^sgot", [LFT[3]]),
    (r"^sgpt", [LFT[4]]),
    (r"^serum total protein", [LFT[6]]),
    (r"^urea$", [UREA]),
    (r"^serum creatinine$", [CREAT]),
    (r"^serum uric", [URIC]),
    (r"s\. bileacid", [n("Serum Bile Acids", "umol/L", 0.5, 10)]),
    (r"^ada ", [n("ADA (Adenosine Deaminase)", "U/L", None, 30, "Pleural fluid >40 suggestive of TB")]),
    (r"^fluid analysis", [t("Appearance"), n("Protein", "g/dL"), n("Glucose", "mg/dL"), n("Total Cell Count", "cells/cumm"),
                          t("Differential Count"), t("Impression")]),
    (r"urine albumin", [q("Urine Albumin", "Nil")]),
    (r"urine bs & bp", [q("Urine Sugar", "Nil"), q("Bile Pigments", "Nil")]),
    (r"urine ketone", [q("Urine Ketones", "Nil")]),
    # cytology / histopathology
    (r"biopsy|^histopathology", HISTO),
    (r"^fnac", [t("Site / Clinical Details"), t("Cytomorphology"), t("Impression")]),
    (r"pap smear", [t("Specimen Adequacy"), t("Cytomorphology"), t("Impression (Bethesda System)")]),
]

# panels whose rule is context-dependent
ELECTROLYTE_RULES = [
    (r"sodium potassium", [NA, K]),
    (r"electrolytes", [NA, K, CL]),
]
LH_FSH_PRL = [
    n("LH", "mIU/mL", text="Male 1.7-8.6; Female follicular 2.4-12.6, mid-cycle 14-96, luteal 1.0-11.4, post-menopausal 7.7-58"),
    n("FSH", "mIU/mL", text="Male 1.5-12.4; Female follicular 3.5-12.5, mid-cycle 4.7-21.5, luteal 1.7-7.7, post-menopausal 25.8-134.8"),
    n("Prolactin", "ng/mL", 4, 25, cm="Male 4-15, Female 4-25"),
]



def service_type(dept, name):
    if dept == "RAD":
        return "OTHER" if name.lower() == "observation" else "IMAGING"
    return "LAB"


def parameters_for(name, dept):
    low = name.lower().strip()
    if service_type(dept, name) != "LAB":
        return None
    if low in ("medical examination", "fnsc", "obs"):
        return None
    if re.search(r"^lh fsh prolactin", low):
        return LH_FSH_PRL
    for rx, params in ELECTROLYTE_RULES:
        if re.search(rx, low):
            return params
    for rx, params in RULES:
        if params is not None and re.search(rx, low):
            return params
    return [t("Result")]  # fallback so every lab test has a result field


def report_template(name, dept):
    if re.search(r"culture|^wound swab", name.lower()):
        return "microbiology"
    return "generic"


# ---------------------------------------------------------------------------

def parse_rows():
    out = []
    for line in ROWS:
        sno, dept, name, sample, price, desc = line.split("|")
        out.append(dict(sno=int(sno), dept=dept, name=name, sample=sample.strip().lower() or None,
                        price=float(price), desc=desc.strip() or None))
    assert len(out) == 293, len(out)
    return out


def sql_lit(v):
    if v is None or v == "":
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def emit_sql():
    L = ["BEGIN;"]
    for r in parse_rows():
        code = f"{CODE_PREFIX}{r['sno']:04d}"
        stype = service_type(r["dept"], r["name"])
        dept = DEPTS[r["dept"]]
        L.append(f"""
-- #{r['sno']} {r['name']}
INSERT INTO diag_services (code, name, service_type, department, rate, active, specimen_type, preparation_requirements, report_template, created_by)
SELECT {sql_lit(code)}, {sql_lit(r['name'])}, {sql_lit(stype)}, {sql_lit(dept)}, {r['price']!r}, true, {sql_lit(r['sample'])}, {sql_lit(r['desc'])}, {sql_lit(report_template(r['name'], r['dept']))}, 'seed:swecha-rate-card-2026-08-10'
WHERE NOT EXISTS (SELECT 1 FROM diag_services WHERE code = {sql_lit(code)} OR lower(trim(name)) = lower(trim({sql_lit(r['name'])})));""")
        L.append(f"""INSERT INTO diag_service_pricing_history (service_id, rate, payer_type, changed_by)
SELECT s.id, s.rate, 'standard', 'seed:swecha-rate-card-2026-08-10' FROM diag_services s
WHERE s.code = {sql_lit(code)} AND NOT EXISTS (SELECT 1 FROM diag_service_pricing_history h WHERE h.service_id = s.id);""")
        params = parameters_for(r["name"], r["dept"])
        # attach to the service created above, or to a same-named pre-existing service that has none
        match = f"(s.code = {sql_lit(code)} OR lower(trim(s.name)) = lower(trim({sql_lit(r['name'])})))"
        if params:
            values = ",\n  ".join(
                "({i}, {name}, {dt}, {unit}, {method}, {lo}, {hi}, {txt}, {cl}, {ch}, {cm})".format(
                    i=i + 1, name=sql_lit(p["name"]), dt=sql_lit(p.get("data_type", "numeric")),
                    unit=sql_lit(p.get("unit")), method=sql_lit(p.get("method")),
                    lo=sql_lit(p.get("ref_low")), hi=sql_lit(p.get("ref_high")), txt=sql_lit(p.get("ref_text")),
                    cl=sql_lit(p.get("critical_low")), ch=sql_lit(p.get("critical_high")), cm=sql_lit(p.get("comments")))
                for i, p in enumerate(params))
            # one statement per test: "service has no parameters yet" is evaluated once, so the whole
            # set goes in together (and a re-run adds nothing)
            L.append(f"""INSERT INTO diag_service_parameters (service_id, name, data_type, unit, method, ref_low, ref_high, ref_text, critical_low, critical_high, comments, display_order)
SELECT s.id, v.name, v.data_type, v.unit, v.method, v.ref_low::real, v.ref_high::real, v.ref_text, v.critical_low::real, v.critical_high::real, v.comments, v.ord
FROM diag_services s,
 (VALUES
  {values}
 ) AS v(ord, name, data_type, unit, method, ref_low, ref_high, ref_text, critical_low, critical_high, comments)
WHERE {match} AND s.service_type = 'LAB'
  AND NOT EXISTS (SELECT 1 FROM diag_service_parameters x WHERE x.service_id = s.id);""")
    L.append("COMMIT;")
    return "\n".join(L)


def report():
    for r in parse_rows():
        ps = parameters_for(r["name"], r["dept"])
        names = "—" if ps is None else ", ".join(p["name"] for p in ps)
        print(f"{r['sno']:>3} {r['name'][:46]:<46} -> {names}")


if __name__ == "__main__":
    if "--report" in sys.argv:
        report()
    elif "--sql" in sys.argv:
        print(emit_sql())
    else:
        print(__doc__)
