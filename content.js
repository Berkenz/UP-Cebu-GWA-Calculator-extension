// UP Cebu AMIS — GWA Calculator
// Columns: Course Code(0) | Title(1) | Units(2) | Grade(3) | Re-exam(4)

const UNITS_COL = 2;
const GRADE_COL = 3;

let _cachedTerm   = null;
let _lastSavedKey = '';   // term§gradesFingerprint — prevents duplicate saves
let _saveTimer    = null; // debounce handle for delayed auto-save

// ── Per-semester scholar status ──
function getScholarHonors(gwa) {
  if (gwa <= 1.45) return { title: 'University Scholar', cls: 'honor-univ' };
  if (gwa <= 1.75) return { title: 'College Scholar',    cls: 'honor-college' };
  return null;
}

// ── Graduation Latin Honors (cumulative GWA) ──
function getLatinHonors(gwa) {
  if (gwa <= 1.20) return { title: 'Summa Cum Laude', cls: 'honor-summa' };
  if (gwa <= 1.45) return { title: 'Magna Cum Laude', cls: 'honor-magna' };
  if (gwa <= 1.75) return { title: 'Cum Laude',       cls: 'honor-laude' };
  return null;
}

// ── Scrape grades from the visible table ──
function scrapeGrades() {
  const rows = document.querySelectorAll('table tbody tr');
  const subjects = [];
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 4) return;
    const units = parseFloat(cells[UNITS_COL]?.innerText.trim());
    const grade = parseFloat(cells[GRADE_COL]?.innerText.trim());
    if (!isNaN(units) && !isNaN(grade) && grade > 0) {
      subjects.push({
        code:  cells[0]?.innerText.trim(),
        title: cells[1]?.innerText.trim(),
        units,
        grade
      });
    }
  });
  return subjects;
}

// ── Get selected term label from the dropdown ──
function readTermFromDOM() {
  // Try every common dropdown component selector
  const selectors = [
    '.multiselect__single',
    '.vs__selected',
    '[class*="single-value"]',
    '[class*="selected"] span',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    const text = (el?.textContent || '').trim().replace(/\s+/g, ' ');
    if (text && text.length > 3 && !/^select/i.test(text)) return text;
  }
  // Fallback: native <select>
  const sel = document.querySelector('select');
  if (sel?.selectedIndex >= 0) {
    const text = (sel.options[sel.selectedIndex]?.text || '').trim();
    if (text && text.length > 3 && !/^select/i.test(text)) return text;
  }
  return null;
}

function getSelectedTerm() {
  return _cachedTerm || readTermFromDOM() || 'Unknown Term';
}

// ── Poll the dropdown every 500 ms to keep _cachedTerm fresh ──
function watchTermSelector() {
  const sync = () => {
    const term = readTermFromDOM();
    if (term) _cachedTerm = term;
  };
  setInterval(sync, 500);
  sync();
}

// ── Shorten a term name for compact display ──
// "First Semester 2023-2024" → "1st Sem 2023-24"
function shortTermName(term) {
  const t = term.toLowerCase();
  const sem = /first|1st/i.test(t)  ? '1st'
            : /second|2nd/i.test(t) ? '2nd'
            : /summer|mid/i.test(t) ? 'Sum'
            : '';
  const m = term.match(/(\d{4})-(\d{4})/);
  if (sem && m) return `${sem} Sem ${m[1]}-${m[2].slice(2)}`;
  return term.length > 22 ? term.slice(0, 22) + '…' : term;
}

// ── Chronological sort key for term names ──
// e.g. "First Semester 2023-2024" → 20231, "Second Semester 2024-2025" → 20242
function termSortKey(term) {
  const yearMatch = term.match(/(\d{4})-(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1]) : 9999;
  const t = term.toLowerCase();
  const sem = /first|1st/i.test(t) ? 1
            : /second|2nd/i.test(t) ? 2
            : /summer|mid/i.test(t) ? 3
            : 4;
  return year * 10 + sem;
}

// ── Compute GWA ──
function computeGWA(subjects) {
  const totalUnits  = subjects.reduce((s, x) => s + x.units, 0);
  const weightedSum = subjects.reduce((s, x) => s + x.grade * x.units, 0);
  return totalUnits > 0 ? (weightedSum / totalUnits) : null;
}

// ── Storage helpers ──
function saveTermGWA(term, gwa, totalUnits, count) {
  chrome.storage.local.get(['termHistory'], res => {
    const history = res.termHistory || {};
    history[term] = { gwa: gwa.toFixed(4), totalUnits, count };
    chrome.storage.local.set({ termHistory: history });
  });
}

function loadHistory(callback) {
  chrome.storage.local.get(['termHistory'], res => callback(res.termHistory || {}));
}

function deleteTerm(term) {
  chrome.storage.local.get(['termHistory'], res => {
    const history = res.termHistory || {};
    delete history[term];
    chrome.storage.local.set({ termHistory: history });
  });
}

// ── Show flash message ──
function showMsg(text, type) {
  const el = document.getElementById('gwa-msg');
  if (!el) return;
  el.textContent = text;
  el.className = 'gwa-msg ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.textContent = ''; el.className = 'gwa-msg'; }, 3000);
}

// ── Render honors badge ──
function honorsHTML(gwa, fn = getLatinHonors) {
  const h = fn(gwa);
  if (!h) return '';
  return `<span class="gwa-honors ${h.cls}">${h.title}</span>`;
}

// ── Update term display (UI only — no saving) ──
function updateTermDisplay(subjects) {
  const resultEl = document.getElementById('gwa-term-result');
  const listEl   = document.getElementById('gwa-term-list');
  if (!resultEl) return;

  const termNameEl = document.getElementById('gwa-term-name');

  if (!subjects.length) {
    resultEl.innerHTML = '<span class="gwa-na">Select a term above to load grades</span>';
    listEl.innerHTML = '';
    if (termNameEl) termNameEl.textContent = '';
    return;
  }

  const gwa        = computeGWA(subjects);
  const totalUnits = subjects.reduce((s, x) => s + x.units, 0);

  if (termNameEl) {
    const term = getSelectedTerm();
    termNameEl.textContent = term !== 'Unknown Term' ? shortTermName(term) : '';
  }

  resultEl.innerHTML = `
    <span class="gwa-big">${gwa.toFixed(4)}</span>
    <span class="gwa-sub">${subjects.length} subjects · ${totalUnits} units</span>
    ${honorsHTML(gwa, getScholarHonors)}
  `;

  listEl.innerHTML = subjects.map(s => `
    <div class="gwa-row">
      <span class="gwa-code">${s.code}</span>
      <span class="gwa-units">${s.units}u</span>
      <span class="gwa-grade">${s.grade.toFixed(2)}</span>
    </div>
  `).join('');
}

// ── Schedule auto-save 600 ms after grade change ──
// Delay > term-poll interval (500 ms) so _cachedTerm is always up-to-date when we save.
function scheduleAutoSave(subjects) {
  clearTimeout(_saveTimer);
  if (!subjects.length) return;

  // Snapshot values now — if user switches again the save will be rescheduled
  const gwa        = computeGWA(subjects);
  const totalUnits = subjects.reduce((s, x) => s + x.units, 0);
  const gradesKey  = subjects.map(s => s.code + ':' + s.grade).join('|');

  _saveTimer = setTimeout(() => {
    const term = getSelectedTerm();
    if (!term || term === 'Unknown Term') return;

    const key = term + '§' + gradesKey;
    if (key === _lastSavedKey) return;   // already saved this exact combination
    _lastSavedKey = key;

    saveTermGWA(term, gwa, totalUnits, subjects.length);
    showMsg(`Saved: ${term}`, 'success');
    setTimeout(updateCumulative, 300);
  }, 600);
}

// ── Update cumulative section ──
function updateCumulative() {
  loadHistory(history => {
    const termsEl  = document.getElementById('gwa-cumulative-terms');
    const resultEl = document.getElementById('gwa-cumulative-result');
    if (!resultEl) return;

    const keys = Object.keys(history).sort((a, b) => termSortKey(a) - termSortKey(b));
    if (!keys.length) {
      resultEl.innerHTML = '<span class="gwa-na">Browse your terms above to auto-track them</span>';
      termsEl.innerHTML = '';
      return;
    }

    let totalWeighted = 0, totalUnits = 0;
    keys.forEach(k => {
      const t = history[k];
      totalWeighted += parseFloat(t.gwa) * t.totalUnits;
      totalUnits    += t.totalUnits;
    });
    const cumulative = totalWeighted / totalUnits;

    resultEl.innerHTML = `
      <span class="gwa-big">${cumulative.toFixed(4)}</span>
      <span class="gwa-sub">${keys.length} term${keys.length > 1 ? 's' : ''} · ${totalUnits} total units</span>
      ${honorsHTML(cumulative)}
    `;

    termsEl.innerHTML = keys.map(k => `
      <div class="gwa-row">
        <span class="gwa-code" style="font-size:10px;max-width:130px">${k}</span>
        <span class="gwa-grade">${history[k].gwa}</span>
        <button class="gwa-del" data-term="${k}" title="Remove term">✕</button>
      </div>
    `).join('');

    // Bind delete buttons
    termsEl.querySelectorAll('.gwa-del').forEach(btn => {
      btn.onclick = () => {
        deleteTerm(btn.dataset.term);
        showMsg('Term removed.', 'success');
        setTimeout(updateCumulative, 200);
      };
    });
  });
}

// ── Build overlay ──
function createOverlay() {
  if (document.getElementById('gwa-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id = 'gwa-overlay';
  overlay.innerHTML = `
    <div id="gwa-header">
      <span class="gwa-header-title">GWA Calculator</span>
      <div class="gwa-header-actions">
        <button id="gwa-toggle" class="gwa-icon-btn" title="Collapse">−</button>
      </div>
    </div>
    <div id="gwa-body">

      <div class="gwa-panel gwa-panel-term">
        <div class="gwa-panel-hd">
          <span class="gwa-section-label">THIS TERM</span>
          <span id="gwa-term-name" class="gwa-term-name"></span>
        </div>
        <div id="gwa-term-result"><span class="gwa-na">Select a term to load grades</span></div>
        <div id="gwa-term-list"></div>
      </div>

      <div class="gwa-panel gwa-panel-cumul">
        <div class="gwa-panel-hd">
          <span class="gwa-section-label">CUMULATIVE GWA</span>
          <span class="gwa-auto-label">auto-tracked</span>
        </div>
        <div id="gwa-cumulative-result"><span class="gwa-na">Browse your terms above to auto-track them</span></div>
        <div id="gwa-cumulative-terms"></div>
      </div>

      <div id="gwa-actions">
        <button id="gwa-clear">Clear all</button>
      </div>

      <div class="gwa-panel gwa-panel-info">
        <div class="gwa-panel-hd">
          <span class="gwa-section-label">SEMESTRAL HONORS</span>
        </div>
        <div class="gwa-honors-row"><span class="clr-univ">Univ. Scholar</span><span>≤ 1.45</span></div>
        <div class="gwa-honors-row"><span class="clr-college">College Scholar</span><span>≤ 1.75</span></div>
        <div class="gwa-panel-hd" style="margin-top:8px">
          <span class="gwa-section-label">GRADUATION HONORS</span>
        </div>
        <div class="gwa-honors-row"><span class="clr-summa">Summa Cum Laude</span><span>≤ 1.20</span></div>
        <div class="gwa-honors-row"><span class="clr-magna">Magna Cum Laude</span><span>≤ 1.45</span></div>
        <div class="gwa-honors-row"><span class="clr-laude">Cum Laude</span><span>≤ 1.75</span></div>
      </div>

      <div id="gwa-msg" class="gwa-msg"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Collapse/expand
  let collapsed = false;
  document.getElementById('gwa-toggle').onclick = () => {
    collapsed = !collapsed;
    document.getElementById('gwa-body').style.display = collapsed ? 'none' : 'block';
    document.getElementById('gwa-toggle').textContent = collapsed ? '+' : '−';
  };

  // Clear all history
  document.getElementById('gwa-clear').onclick = () => {
    if (!confirm('Clear all saved terms?')) return;
    chrome.storage.local.set({ termHistory: {} });
    showMsg('History cleared.', 'success');
    setTimeout(updateCumulative, 300);
  };
}

// ── Poll the grade table every 250 ms for changes ──
function watchForGrades() {
  let lastKey = '';

  setInterval(() => {
    const subjects = scrapeGrades();
    const key = subjects.map(s => s.code + ':' + s.grade).join('|');
    if (key !== lastKey) {
      lastKey = key;
      updateTermDisplay(subjects);   // update UI immediately
      scheduleAutoSave(subjects);    // save after 600 ms (term poll will have caught up)
    }
  }, 250);
}

// ── Init ──
function init() {
  createOverlay();
  watchTermSelector();
  updateCumulative();
  watchForGrades();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 1500);
}
