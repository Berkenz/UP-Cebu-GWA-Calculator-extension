// UP Cebu AMIS — GWA Calculator with Latin Honors
// Columns: Course Code(0) | Title(1) | Units(2) | Grade(3) | Re-exam(4)

const UNITS_COL = 2;
const GRADE_COL = 3;

// ── UP Diliman Latin Honors thresholds (used by UP system) ──
function getLatinHonors(gwa) {
  if (gwa <= 1.20) return { title: 'Summa Cum Laude', color: '#f9e2af', icon: '🥇' };
  if (gwa <= 1.45) return { title: 'Magna Cum Laude', color: '#cba6f7', icon: '🥈' };
  if (gwa <= 1.75) return { title: 'Cum Laude',       color: '#89dceb', icon: '🥉' };
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
function getSelectedTerm() {
  const sel =
    document.querySelector('.multiselect__single') ||
    document.querySelector('[class*="multiselect"] input') ||
    document.querySelector('input[placeholder*="Semester"]');
  return sel?.innerText?.trim() || sel?.value?.trim() || 'Unknown Term';
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
function honorsHTML(gwa) {
  const h = getLatinHonors(gwa);
  if (!h) return '';
  return `<div class="gwa-honors" style="border-color:${h.color};color:${h.color}">
    ${h.icon} ${h.title}
  </div>`;
}

// ── Update term section ──
function updateTermDisplay() {
  const subjects = scrapeGrades();
  const resultEl = document.getElementById('gwa-term-result');
  const listEl   = document.getElementById('gwa-term-list');
  if (!resultEl) return;

  if (!subjects.length) {
    resultEl.innerHTML = '<span class="gwa-na">Select a term above to load grades</span>';
    listEl.innerHTML = '';
    return;
  }

  const gwa        = computeGWA(subjects);
  const totalUnits = subjects.reduce((s, x) => s + x.units, 0);

  resultEl.innerHTML = `
    <span class="gwa-big">${gwa.toFixed(4)}</span>
    <span class="gwa-sub">${subjects.length} subjects · ${totalUnits} units</span>
    ${honorsHTML(gwa)}
  `;

  listEl.innerHTML = subjects.map(s => `
    <div class="gwa-row">
      <span class="gwa-code">${s.code}</span>
      <span class="gwa-units">${s.units}u</span>
      <span class="gwa-grade">${s.grade.toFixed(2)}</span>
    </div>
  `).join('');
}

// ── Update cumulative section ──
function updateCumulative() {
  loadHistory(history => {
    const termsEl  = document.getElementById('gwa-cumulative-terms');
    const resultEl = document.getElementById('gwa-cumulative-result');
    if (!resultEl) return;

    const keys = Object.keys(history);
    if (!keys.length) {
      resultEl.innerHTML = '<span class="gwa-na">Save terms below to see cumulative</span>';
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
      <span>📊 GWA Calculator</span>
      <button id="gwa-toggle" title="Collapse">−</button>
    </div>
    <div id="gwa-body">

      <div class="gwa-section-label">THIS TERM</div>
      <div id="gwa-term-result"><span class="gwa-na">Select a term to load grades</span></div>
      <div id="gwa-term-list"></div>

      <div class="gwa-divider"></div>

      <div class="gwa-section-label">CUMULATIVE GWA</div>
      <div id="gwa-cumulative-result"><span class="gwa-na">No terms saved yet</span></div>
      <div id="gwa-cumulative-terms"></div>

      <div class="gwa-divider"></div>

      <div id="gwa-actions">
        <button id="gwa-save">💾 Save this term</button>
        <button id="gwa-clear">🗑 Clear all</button>
      </div>

      <div class="gwa-honors-info">
        <div class="gwa-section-label" style="margin-top:10px">UP LATIN HONORS</div>
        <div class="gwa-honors-row"><span style="color:#f9e2af">Summa</span><span>≤ 1.20</span></div>
        <div class="gwa-honors-row"><span style="color:#cba6f7">Magna</span><span>≤ 1.45</span></div>
        <div class="gwa-honors-row"><span style="color:#89dceb">Cum Laude</span><span>≤ 1.75</span></div>
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

  // Save current term
  document.getElementById('gwa-save').onclick = () => {
    const subjects = scrapeGrades();
    if (!subjects.length) { showMsg('No grades found to save!', 'error'); return; }
    const term  = getSelectedTerm();
    const gwa   = computeGWA(subjects);
    const units = subjects.reduce((s, x) => s + x.units, 0);
    saveTermGWA(term, gwa, units, subjects.length);
    showMsg(`✅ Saved: ${term}`, 'success');
    setTimeout(updateCumulative, 300);
  };

  // Clear all history
  document.getElementById('gwa-clear').onclick = () => {
    if (!confirm('Clear all saved terms?')) return;
    chrome.storage.local.set({ termHistory: {} });
    showMsg('History cleared.', 'success');
    setTimeout(updateCumulative, 300);
  };
}

// ── Watch for grade table loading dynamically ──
function watchForGrades() {
  let lastRowCount = 0;
  const observer = new MutationObserver(() => {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length !== lastRowCount) {
      lastRowCount = rows.length;
      setTimeout(updateTermDisplay, 400);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Init ──
function init() {
  createOverlay();
  updateTermDisplay();
  updateCumulative();
  watchForGrades();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 1500);
}
