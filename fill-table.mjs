import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import matter from 'gray-matter';

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const ADD_BUTTON_TEXT = 'Adicionar Linha';

function usage() {
  console.error('Usage: node fill-table.mjs <path-to-markdown>');
  console.error('  CDP_URL env var overrides http://127.0.0.1:9222');
  process.exit(2);
}

async function main() {
  const mdPath = process.argv[2];
  if (!mdPath) usage();
  const absPath = path.resolve(mdPath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(2);
  }

  const config = parseConfig(absPath);
  console.log(`Loaded ${config.rows.length} row(s) from ${path.basename(absPath)}`);
  console.log(`  url:     ${config.url}`);
  console.log(`  section: ${config.section}`);
  console.log(`  tableId: ${config.tableId}`);

  console.log(`\nConnecting to Chrome at ${CDP_URL}...`);
  const browser = await chromium.connectOverCDP(CDP_URL);

  const page = await findPage(browser, config.url);
  if (!page) {
    throw new Error(
      `Could not find a Chrome tab whose URL contains "${config.url}". ` +
        `Open it in the debug-port Chrome instance and try again.`
    );
  }
  await page.bringToFront();
  console.log(`Found page: ${page.url()}`);

  await findAddLineButton(page, config); // sanity check
  console.log(`Found "${ADD_BUTTON_TEXT}" button for ${config.tableId}.`);

  const report = [];

  for (let i = 0; i < config.rows.length; i++) {
    const rowReport = {
      rowIndex: i,
      humanIndex: i + 1,
      lineNumber: null,
      addRowFailed: false,
      addRowReason: null,
      filled: [],
      errored: [],
    };

    const values = buildRowValues(config, i);
    if (values.__startLine != null) {
      rowReport.lineNumber = values.__startLine;
      delete values.__startLine;
    }

    const tag = rowReport.lineNumber != null ? `line ${rowReport.lineNumber}` : `row ${i + 1}`;
    console.log(`\n[${i + 1}/${config.rows.length}] ${tag}`);

    try {
      const before = await getCollectionLength(page, config.tableId);
      const addBtn = await findAddLineButton(page, config);
      await addBtn.click({ force: true });
      await page.waitForFunction(
        ({ tableId, prev }) => {
          const isCtrl = (s) =>
            s && s.$ctrl && typeof s.$ctrl.name === 'string' &&
            s.$ctrl.name.includes(tableId) && Array.isArray(s.$ctrl.lfModel);
          for (const btn of document.querySelectorAll('button.btn-add')) {
            const s = angular.element(btn).scope();
            if (isCtrl(s)) return s.$ctrl.lfModel.length > prev;
          }
          for (const tr of document.querySelectorAll(`tr[name^="${tableId}_idx_"]`)) {
            let cur = angular.element(tr).scope();
            while (cur) {
              if (isCtrl(cur)) return cur.$ctrl.lfModel.length > prev;
              cur = cur.$parent;
            }
          }
          return false;
        },
        { tableId: config.tableId, prev: before },
        { timeout: 8000 }
      );
      await page.waitForTimeout(80);
    } catch (err) {
      rowReport.addRowFailed = true;
      rowReport.addRowReason = err.message.split('\n')[0];
      console.log(`  x add-row failed: ${rowReport.addRowReason}`);
      report.push(rowReport);
      continue;
    }

    const writeResult = await writeRow(page, config.tableId, values);
    if (writeResult.__error) {
      rowReport.addRowFailed = true;
      rowReport.addRowReason = writeResult.__error;
      console.log(`  x write failed: ${writeResult.__error}`);
      report.push(rowReport);
      continue;
    }
    rowReport.filled = writeResult.filled;
    rowReport.errored = writeResult.errored;

    const ok = rowReport.errored.length === 0;
    const marker = ok ? 'v' : '!';
    console.log(
      `  ${marker} filled ${rowReport.filled.length}/${rowReport.filled.length + rowReport.errored.length} fields` +
        (rowReport.errored.length ? ` (errored: ${rowReport.errored.map((e) => e.field).join(', ')})` : '')
    );
    report.push(rowReport);
  }

  printSummary(report);
  await browser.close();
}

// --------------------------------------------------------------------- config

function parseConfig(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  const parsed = matter(raw);
  const fm = parsed.data || {};

  const requiredKeys = ['url', 'section', 'tableId'];
  for (const k of requiredKeys) {
    if (!fm[k] || typeof fm[k] !== 'string') {
      throw new Error(`Front-matter is missing required string field: ${k}`);
    }
  }

  const fixedValuesRaw = fm.fixedValues || {};
  const fixedValues = {};
  for (const [field, spec] of Object.entries(fixedValuesRaw)) {
    if (spec == null || typeof spec !== 'object' || !('value' in spec)) {
      throw new Error(`fixedValues.${field} must be { value, type? }`);
    }
    fixedValues[field] = { value: spec.value, type: spec.type || 'string' };
  }

  const columnTypes = fm.columnTypes || {};

  let startLine = null;
  if (fm.startLine) {
    if (typeof fm.startLine.field !== 'string' || typeof fm.startLine.from !== 'number') {
      throw new Error('startLine must be { field: string, from: number }');
    }
    startLine = { field: fm.startLine.field, from: fm.startLine.from };
  }

  const { headers, rows } = parseMarkdownTable(parsed.content);
  if (headers.length === 0) {
    throw new Error('No markdown table found in the body. Expected a header row starting with `|`.');
  }

  return {
    url: fm.url,
    section: fm.section,
    tableId: fm.tableId,
    fixedValues,
    columnTypes,
    startLine,
    headers,
    rows,
  };
}

function parseMarkdownTable(body) {
  const lines = body.split('\n');
  let i = 0;
  // find first table line
  while (i < lines.length && !lines[i].trimStart().startsWith('|')) i++;
  if (i >= lines.length) return { headers: [], rows: [] };

  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const headers = splitRow(lines[i++]);
  // skip separator
  if (i < lines.length && /^\s*\|[\s\-:|]+\|?\s*$/.test(lines[i])) i++;

  const rows = [];
  while (i < lines.length && lines[i].trimStart().startsWith('|')) {
    const cells = splitRow(lines[i]);
    if (cells.length > 0 && cells.some((c) => c.length > 0)) {
      rows.push(cells);
    }
    i++;
  }
  return { headers, rows };
}

function buildRowValues(config, rowIdx) {
  const out = {};

  for (const [field, spec] of Object.entries(config.fixedValues)) {
    const coerced = coerce(spec.value, spec.type);
    if (coerced != null) out[field] = coerced;
  }

  if (config.startLine) {
    const v = config.startLine.from + rowIdx;
    out[config.startLine.field] = v;
    out.__startLine = v;
  }

  const cells = config.rows[rowIdx] || [];
  for (let c = 0; c < config.headers.length; c++) {
    const field = config.headers[c];
    if (!field) continue;
    const raw = cells[c];
    if (raw == null || raw === '') continue;
    const type = config.columnTypes[field] || 'string';
    const v = coerce(raw, type);
    if (v != null) out[field] = v;
  }
  return out;
}

function coerce(raw, type) {
  if (raw == null) return null;
  const s = typeof raw === 'string' ? raw.trim() : String(raw);
  switch (type) {
    case 'int': {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'float': {
      const n = parseFloat(s.replace(/\./g, '').replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'euroCents': {
      const n = parseInt(s.replace(/[.,]/g, ''), 10);
      return Number.isFinite(n) ? n : null;
    }
    case 'string':
    default:
      return s;
  }
}

// ------------------------------------------------------------- page helpers

async function findPage(browser, urlSubstring) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      if (p.url().includes(urlSubstring)) return p;
    }
  }
  // also try matching only the host so the user can pass a full URL even if
  // the open tab has a different fragment/path
  try {
    const u = new URL(urlSubstring);
    const host = u.host;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (p.url().includes(host)) return p;
      }
    }
  } catch {}
  return null;
}

async function getCollectionLength(page, tableId) {
  return await page.evaluate(({ tableId }) => {
    const isCtrl = (s) =>
      s && s.$ctrl && typeof s.$ctrl.name === 'string' &&
      s.$ctrl.name.includes(tableId) && Array.isArray(s.$ctrl.lfModel);
    for (const btn of document.querySelectorAll('button.btn-add')) {
      const s = angular.element(btn).scope();
      if (isCtrl(s)) return s.$ctrl.lfModel.length;
    }
    for (const tr of document.querySelectorAll(`tr[name^="${tableId}_idx_"]`)) {
      let cur = angular.element(tr).scope();
      while (cur) {
        if (isCtrl(cur)) return cur.$ctrl.lfModel.length;
        cur = cur.$parent;
      }
    }
    return 0;
  }, { tableId });
}

async function findAddLineButton(page, config) {
  const handle = await page.evaluateHandle(
    ({ labelText, buttonText, tableId }) => {
      const isVisible = (el) => {
        if (!el || !el.isConnected) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;
        return el.offsetParent !== null || style.position === 'fixed';
      };

      const allButtons = Array.from(document.querySelectorAll('button.btn-add')).filter(
        (b) => (b.textContent || '').includes(buttonText) && isVisible(b)
      );

      // Prefer a button whose Angular scope's $ctrl.name matches the requested tableId
      if (typeof angular !== 'undefined') {
        for (const btn of allButtons) {
          let cur = angular.element(btn).scope();
          while (cur) {
            if (
              cur.$ctrl &&
              typeof cur.$ctrl.name === 'string' &&
              cur.$ctrl.name.includes(tableId)
            ) {
              return btn;
            }
            cur = cur.$parent;
          }
        }
      }

      // Fall back to the section-label ordering
      if (allButtons.length === 0) {
        return { __error: 'no_visible_buttons', totalMatchingButtons: document.querySelectorAll('button.btn-add').length };
      }

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const labelEls = [];
      let textNode;
      while ((textNode = walker.nextNode())) {
        if (
          textNode.nodeValue &&
          textNode.nodeValue.includes(labelText) &&
          textNode.parentElement &&
          isVisible(textNode.parentElement)
        ) {
          labelEls.push(textNode.parentElement);
        }
      }
      if (labelEls.length === 0) {
        return { __error: 'label_not_visible', visibleButtons: allButtons.length };
      }

      for (const labelEl of labelEls) {
        for (const btn of allButtons) {
          if (labelEl.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return btn;
          }
        }
      }
      return { __error: 'no_button_after_label', visibleButtons: allButtons.length };
    },
    { labelText: config.section, buttonText: ADD_BUTTON_TEXT, tableId: config.tableId }
  );

  const diag = await handle.evaluate((v) => (v && typeof v === 'object' && '__error' in v ? v : null));
  if (diag) {
    throw new Error(
      `findAddLineButton failed: ${diag.__error}. Diagnostics: ${JSON.stringify(diag)}. ` +
        `Make sure section "${config.section}" is expanded and tableId "${config.tableId}" is correct.`
    );
  }

  const element = handle.asElement();
  if (!element) throw new Error('Could not resolve add-button handle to element');
  return element;
}

async function writeRow(page, tableId, values) {
  return await page.evaluate(({ tableId, values }) => {
    if (typeof angular === 'undefined') return { __error: 'angular_not_loaded' };

    const isCtrl = (s) =>
      s && s.$ctrl && typeof s.$ctrl.name === 'string' &&
      s.$ctrl.name.includes(tableId) && Array.isArray(s.$ctrl.lfModel);

    let controllerScope = null;
    for (const btn of document.querySelectorAll('button.btn-add')) {
      const s = angular.element(btn).scope();
      if (isCtrl(s)) { controllerScope = s; break; }
    }
    if (!controllerScope) {
      for (const tr of document.querySelectorAll(`tr[name^="${tableId}_idx_"]`)) {
        let cur = angular.element(tr).scope();
        while (cur) {
          if (isCtrl(cur)) { controllerScope = cur; break; }
          cur = cur.$parent;
        }
        if (controllerScope) break;
      }
    }
    if (!controllerScope) return { __error: 'no_controller_found' };

    const collection = controllerScope.$ctrl.lfModel;
    const newRow = collection[collection.length - 1];
    if (!newRow || typeof newRow !== 'object') {
      return { __error: 'last_row_not_object', collectionLength: collection.length };
    }

    const filled = [];
    const errored = [];

    for (const [field, value] of Object.entries(values)) {
      try {
        newRow[field] = value;
        const after = newRow[field];
        // Loose equality so 89909 === '89909' would still pass; strict for objects
        if (after === value || String(after) === String(value)) {
          filled.push(field);
        } else {
          errored.push({
            field,
            reason: 'value_did_not_persist',
            attempted: value,
            actual: after === undefined ? null : after,
          });
        }
      } catch (e) {
        errored.push({ field, reason: 'set_threw', message: String(e && e.message || e) });
      }
    }

    const phase = controllerScope.$root.$$phase || controllerScope.$$phase;
    if (phase) {
      controllerScope.$evalAsync(() => {});
    } else {
      controllerScope.$apply();
    }

    return {
      collectionLength: collection.length,
      filled,
      errored,
    };
  }, { tableId, values });
}

function printSummary(report) {
  const total = report.length;
  const failed = report.filter((r) => r.addRowFailed);
  const partial = report.filter((r) => !r.addRowFailed && r.errored.length > 0);
  const ok = report.filter((r) => !r.addRowFailed && r.errored.length === 0);

  console.log('\n' + '='.repeat(60));
  console.log(`Summary (${total} row${total === 1 ? '' : 's'} attempted):`);
  console.log(`  v ${ok.length} fully filled`);
  console.log(`  ! ${partial.length} partial`);
  console.log(`  x ${failed.length} could not be added`);

  for (const r of partial) {
    const tag = r.lineNumber != null ? `line ${r.lineNumber}` : `row ${r.humanIndex}`;
    console.log(
      `\nRow ${r.humanIndex} (${tag}): filled ${r.filled.length}/${r.filled.length + r.errored.length} fields. Errored:`
    );
    for (const e of r.errored) {
      const detail =
        e.reason === 'value_did_not_persist'
          ? `${e.reason} (sent ${JSON.stringify(e.attempted)}, got ${JSON.stringify(e.actual)})`
          : `${e.reason}${e.message ? `: ${e.message}` : ''}`;
      console.log(`  - ${e.field}: ${detail}`);
    }
  }

  for (const r of failed) {
    const tag = r.lineNumber != null ? `line ${r.lineNumber}` : `row ${r.humanIndex}`;
    console.log(`\nRow ${r.humanIndex} (${tag}): could not add row (${r.addRowReason})`);
  }

  console.log('\nReview the form before submitting.');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
