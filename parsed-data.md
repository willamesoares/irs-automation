# Parsed data for Anexo J · Quadro 9.2 A

This is exactly what the script will write. Columns match the form's order
(year/month/day for both realização and aquisição). Values use Portuguese
formatting (comma decimal).

Row layout used by the script: `[anoRealiz, diaRealiz, mesRealiz, valorRealiz, anoAquis, diaAquis, mesAquis, valorAquis]` — note **dia comes before mês in this list** because that's how your source listed them; the form column order is *ano, mês, dia, valor*.

## Block 1 — from the unspaced string

| Linha | Ano Realiz | Dia Realiz | Mês Realiz | Valor Realiz | Ano Aquis | Dia Aquis | Mês Aquis | Valor Aquis |
|------:|:----------:|:----------:|:----------:|-------------:|:---------:|:---------:|:---------:|------------:|
| 951   | 2025 | 22 |  1 |    899,09 | 2024 | 24 | 12 |    879,91 |
| 952   | 2025 | 16 |  1 |  2.281,05 | 2025 |  7 |  1 |  2.246,18 |
| 953   | 2025 |  7 | 10 |    864,89 | 2025 |  7 | 10 |    853,31 |
| 954   | 2025 | 17 | 10 |  1.199,13 | 2025 | 17 | 10 |  1.182,15 |
| 955   | 2025 |  7 | 10 |    804,40 | 2025 |  7 | 10 |    788,66 |
| 956   | 2025 |  6 |  1 |  1.177,96 | 2025 |  6 |  1 |  1.173,75 |
| 957   | 2025 |  7 |  1 |  1.184,54 | 2025 |  6 |  1 |  1.179,01 |
| 958   | 2025 |  7 | 10 |  2.367,57 | 2025 |  7 |  1 |  2.336,95 |
| 959   | 2025 | 13 |  1 |  2.367,14 | 2025 | 10 |  1 |  2.337,01 |
| 960   | 2025 | 22 |  1 |  1.402,44 | 2025 |  7 |  1 |  1.364,05 |
| 961   | 2025 | 22 |  1 |  1.402,44 | 2025 |  7 |  1 |  1.365,97 |
| 962   | 2025 | 16 |  6 |  1.506,32 | 2025 | 21 |  2 |  1.442,95 |

## Block 2 — from the tab-separated table

| Linha | Ano Realiz | Dia Realiz | Mês Realiz | Valor Realiz | Ano Aquis | Dia Aquis | Mês Aquis | Valor Aquis |
|------:|:----------:|:----------:|:----------:|-------------:|:---------:|:---------:|:---------:|------------:|
| 963   | 2025 | 16 |  6 |      0,11 | 2025 |  2 |  4 |      0,09 |
| 964   | 2025 | 15 |  1 |    120,47 | 2024 | 20 | 12 |    118,58 |
| 965   | 2025 | 23 |  6 |  1.577,76 | 2025 | 20 |  6 |  1.556,38 |
| 966   | 2025 | 17 |  1 |    422,76 | 2024 | 27 | 12 |    419,91 |
| 967   | 2025 | 29 |  9 |    386,36 | 2024 | 27 | 12 |    380,94 |
| 968   | 2025 |  1 | 10 |    784,49 | 2024 | 26 | 12 |    781,79 |
| 969   | 2025 | 17 | 10 |  1.462,04 | 2025 | 16 | 10 |  1.447,46 |
| 970   | 2025 | 28 | 10 |  2.708,01 | 2025 | 28 | 10 |  2.668,77 |
| 971   | 2025 | 12 | 12 |  2.969,00 | 2025 | 29 | 10 |  2.921,43 |

## Things to verify

The Block 1 source string was unspaced. I had to infer where day, month, and value boundaries were. The decision rules I used:

- Year is always 4 digits.
- Day is 1 or 2 digits, 1–31.
- Month is 1 or 2 digits, 1–12.
- Values containing a `.` are thousands-separated (so `1.177,96` means €1,177.96 and the parser splits the prefix as `day=6, mês=1` not `day=6, mês=11, valor=177,96`).
- Where two parsings were both technically valid, I preferred the one yielding values most consistent with the paired counterpart in the same row.

### Rows worth a sanity check

| Linha | Source fragment | My read | Alternate parse I rejected |
|------:|:----------------|:--------|:---------------------------|
| 956 | `2025611.177,96` | 2025 / dia 6 / mês 1 / €1.177,96 | 2025 / dia 6 / mês 11 / €177,96 (rejected because then the source wouldn't contain the thousands dot) |
| 957 | `2025711.184,54` | 2025 / dia 7 / mês 1 / €1.184,54 | dia 7 / mês 11 / €184,54 (same reason) |
| 958 | `20257102.367,57` paired with `2025712.336,95` | sale dia 7 mês 10, buy dia 7 mês 1 | buy could be mês 12 with €336,95 — looked wrong by magnitude |
| 959 | `20251312.367,14` paired with `20251012.337,01` | dia 13 mês 1 / €2.367,14, dia 10 mês 1 / €2.337,01 | dia 1 mês 3 / €12.367,14 — rejected by magnitude |
| 960 / 961 | both end `20252211.402,44` | both sales: dia 22 mês 1 / €1.402,44 | duplicate sale; may be intentional partial fills — please confirm |

### Rows 960 and 961 specifically

Row 960 and 961 both have the **same sale leg** (22 Jan, €1.402,44) paired with slightly different acquisition values (€1.364,05 vs €1.365,97). If that's not what you intended, the source text repeated the segment `20252211.402,44` twice. Worth double-checking against the original spreadsheet.

If any row above is wrong, edit `data.mjs` directly (each entry is `[anoRealiz, diaRealiz, mesRealiz, valorRealiz, anoAquis, diaAquis, mesAquis, valorAquis]` — the script reorders to *ano, mês, dia, valor* internally when assigning to the form).
