# irs-automation

Fills repetitive tables on Portal das Finanças IRS forms (Anexo J, Anexo G,
etc.) by attaching to a Chrome tab you already have open and writing values
directly into the form's Angular scope. Each table you want to fill is described
by a single markdown file — front-matter for configuration, a markdown table
for row data.

This is scoped to the IRS form family (it relies on the `lf-table` / `vs-repeat`
patterns those pages use). It is not a generic web-form filler.

## Prerequisites

- Node 18+
- Google Chrome installed at `/Applications/Google Chrome.app/`
- The form already accessible to you (you log in inside the debug-port Chrome
  in [step 2](#2-launch-chrome-with-the-debug-port))

## Quick start

```bash
npm install
# follow step 2 below to launch Chrome
node fill-table.mjs examples/anexo-j-q92a.md
```

---

## 1. Install

```bash
npm install
```

## 2. Launch Chrome with the debug port

The script talks to your browser over the Chrome DevTools Protocol so it can
act inside your already-authenticated session. Chrome refuses to expose the
debug port on your default profile (Chrome security change in 2024), so we use
a throwaway profile directory.

```bash
# fully quit Chrome first — closing windows is not enough
pkill -a "Google Chrome"

/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-irs-debug
```

In a second terminal, confirm it's listening:

```bash
curl -s http://127.0.0.1:9222/json/version
```

You should see JSON with a `webSocketDebuggerUrl` field. If you see
"connection refused", Chrome ignored the flag — usually because another Chrome
process was already running. Kill it (`pkill -a "Google Chrome"`) and relaunch.

The temporary profile has no extensions or saved logins, so log into the IRS
portal again inside *this* Chrome window. When you're done, quit it and
`rm -rf /tmp/chrome-irs-debug` — your normal profile is untouched.

## 3. Find the table's technical ID

Each `lf-table` on the page has a unique technical `name` attribute (e.g.
`AnexoJq092AT01`) that the script uses to target the right table.

1. Navigate to the page containing the table you want to fill.
2. Manually click *Adicionar Linha* once so a `<tr>` exists.
3. Right-click any cell in that row → **Inspect**.
4. In DevTools, find the enclosing `<tr ...>` element. The `name` attribute
   looks like `name="SomeTableId_idx_1"`. The part **before** `_idx_` is the
   `tableId`.

Examples:
- `AnexoJq092AT01` → Anexo J · Quadro 9.2 A · Tabela 01
- `AnexoJq092AT02` → Anexo J · Quadro 9.2 A · Tabela 02

You can delete the manually-added row afterwards.

## 4. Write your markdown file

One file per table. Put it anywhere; the path is passed on the command line.

```markdown
---
url: https://irs.portaldasfinancas.gov.pt/app/entrega/v2026#!/anexo-j/quadro09/@id!305527258
section: Alienação Onerosa de Partes Sociais
tableId: AnexoJq092AT01
startLine:
  field: NLinha
  from: 951

fixedValues:
  CodPais: { value: 840, type: int }
  Codigo: { value: G01, type: string }
  ImpostoPagoNoEstrangeiro: { value: 0, type: int }

columnTypes:
  AnoRealizacao: int
  DiaRealizacao: int
  MesRealizacao: int
  ValorRealizacao: euroCents
  AnoAquisicao: int
  DiaAquisicao: int
  MesAquisicao: int
  ValorAquisicao: euroCents
---

| AnoRealizacao | DiaRealizacao | MesRealizacao | ValorRealizacao | AnoAquisicao | DiaAquisicao | MesAquisicao | ValorAquisicao |
|---|---|---|---|---|---|---|---|
| 2025 | 22 | 1 |   899,09 | 2024 | 24 | 12 | 879,91 |
| 2025 | 16 | 1 | 2.281,05 | 2025 |  7 |  1 | 2.246,18 |
```

### Front-matter fields

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | Substring matched against open Chrome tab URLs. Paste the full URL of the form page. |
| `section` | yes | Text of the section heading immediately above the table. Used as a secondary anchor for the *Adicionar Linha* button. |
| `tableId` | yes | Technical id from [step 3](#3-find-the-tables-technical-id). |
| `startLine.field` | no | Angular field name that receives an auto-incrementing line number. |
| `startLine.from` | no | First row gets this number; subsequent rows get `from+1`, `from+2`, … Omit the whole `startLine` block if the table has no manual line column. |
| `fixedValues` | no | `{ field: { value, type } }`. Applied to every row before merging row data. |
| `columnTypes` | no | `{ field: type }`. Coerces each column from the markdown table. Defaults to `string`. |

### Supported types

| Type | Behavior | Example input → stored |
|---|---|---|
| `int` | `parseInt(value, 10)` | `"22"` → `22` |
| `euroCents` | strip `.` and `,`, then `parseInt` (matches the form's raw-digit mask) | `"899,09"` → `89909`, `"1.177,96"` → `117796` |
| `float` | strip thousands `.`, swap `,` for `.`, then `parseFloat` | `"899,09"` → `899.09` |
| `string` | trimmed string (default) | `"G01"` → `"G01"` |

### Where do the field names come from?

The markdown table's column headers must exactly match the Angular model keys
on the row object. To find them, inspect any cell in the table on the form —
the `<td>` element has `name="..."` attribute. That is the field name. Use the
same approach for `fixedValues` keys.

## 5. Run

```bash
node fill-table.mjs path/to/your-file.md
```

Or via the npm alias:

```bash
npm run fill -- path/to/your-file.md
```

The script prints per-row progress and a summary like:

```
Summary (21 rows attempted):
  v 19 fully filled
  ! 1 partial
  x 1 could not be added

Row 5 (line 955): filled 10/11 fields. Errored:
  - ValorRealizacao: value_did_not_persist (sent 80440, got null)
Row 12 (line 962): could not add row (timeout)
```

Then **review the form before submitting** — the script writes through Angular's
model, but it's still your tax return.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `Connecting to Chrome…` then connection refused | Chrome not on port 9222. Re-do [step 2](#2-launch-chrome-with-the-debug-port). |
| `Could not find a Chrome tab whose URL contains "…"` | The `url` in front-matter doesn't match any open tab. Open the form page in the debug-port Chrome. |
| `findAddLineButton failed: label_not_visible` | The section is collapsed. Expand it in the form, then re-run. |
| `findAddLineButton failed: no_visible_buttons` | Wrong `tableId`, or the table is locked / read-only on this declaration. |
| `value_did_not_persist` for one column | Wrong `columnTypes` (e.g. using `float` where the mask wants `euroCents`), or a typo in the header. Compare your markdown column header against the `<td name="...">` you see in DevTools. |
| `could not add row (timeout)` | `Adicionar Linha` was disabled — usually because the previously-added row has unresolved validation errors. Clear those, then re-run. |

## Project layout

```
fill-table.mjs            # the generic script
examples/
  anexo-j-q92a.md         # working example (21 rows)
parsed-data.md            # reference notes from the original Anexo J fill
package.json
README.md
```
