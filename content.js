// UP Cebu — AMIS: GWA calculator (content script)

const _popTimers = {};

/** In-memory: term label → { subjects, gwa, totalUnits, count, weightSum } (latest grades fetch). */
let _termPickerByLabel = {};
/** Active term key, or "" if none; drives the THIS TERM control. */
let _termPickerValue = '';
const _GWA_LAST_TERM_KEY = 'gwaLastSelectedTerm';
const _GWA_USER_EXCLUDED_KEY = 'gwaUserExcludedSubjects';

/** @type {Record<string, string[]>} term label → course codes omitted from GWA (user toggle). */
let _gwaUserExcluded = {};

// ── Trigger panel pop animation (debounced, double-rAF restart) ──
function popPanel(selector) {
  clearTimeout(_popTimers[selector]);
  _popTimers[selector] = setTimeout(() => {
    const panel = document.querySelector(selector);
    if (!panel) return;
    panel.classList.remove('gwa-panel-pop');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      panel.classList.add('gwa-panel-pop');
    }));
  }, 50);
}

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

function getTermButtonLabelEl() {
  return document.getElementById('gwa-term-button-label');
}
function getTermButtonEl() {
  return document.getElementById('gwa-term-button');
}
function getTermMenuEl() {
  return document.getElementById('gwa-term-menu');
}
function getTermComboEl() {
  return document.getElementById('gwa-term-combo');
}

function closeTermMenu() {
  const m = getTermMenuEl();
  const b = getTermButtonEl();
  const c = getTermComboEl();
  if (m) {
    m.hidden = true;
    m.classList.remove('gwa-term-menu--open');
    if (m.parentNode === document.body && c) {
      c.appendChild(m);
    }
  }
  if (b) b.setAttribute('aria-expanded', 'false');
  if (c) c.classList.remove('gwa-term-combo--open');
}

function positionTermMenu() {
  const btn = getTermButtonEl();
  const m   = getTermMenuEl();
  if (!btn || !m) return;
  const r  = btn.getBoundingClientRect();
  const o  = document.getElementById('gwa-overlay');
  const ob = o && o.getBoundingClientRect();
  const padV = 8;
  m.style.top = (r.bottom + 4) + 'px';

  /* Match the trigger width (narrower than full card) and align with the button’s left edge */
  if (ob) {
    const useW = Math.max(0, r.width);
    let left  = r.left;
    if (left + useW > ob.right) {
      left = Math.max(0, ob.right - useW);
    }
    if (left < ob.left) {
      left = ob.left;
    }
    m.style.minWidth = useW + 'px';
    m.style.width    = useW + 'px';
    m.style.maxWidth = useW + 'px';
    m.style.left     = left + 'px';
  } else {
    const wMin = 260;
    const maxW = Math.max(0, window.innerWidth - 2 * padV);
    const useW = Math.min(Math.max(r.width, wMin), maxW);
    m.style.minWidth  = useW + 'px';
    m.style.width     = useW + 'px';
    m.style.maxWidth  = maxW + 'px';
    let left = r.left;
    if (left + useW > window.innerWidth - padV) {
      left = Math.max(padV, window.innerWidth - padV - useW);
    }
    m.style.left = left + 'px';
  }
}

function openTermMenu() {
  const m = getTermMenuEl();
  const b = getTermButtonEl();
  const c = getTermComboEl();
  if (!m || !b || b.disabled) return;
  if (!m.querySelector('li')) return;
  /* Reparent to `document.body` for correct z-order above `#gwa-overlay` content. */
  document.body.appendChild(m);
  m.hidden = false;
  positionTermMenu();
  requestAnimationFrame(() => positionTermMenu());
  b.setAttribute('aria-expanded', 'true');
  m.classList.add('gwa-term-menu--open');
  if (c) c.classList.add('gwa-term-combo--open');
}

let _gwaTermOutsideClose = null;

function bindTermComboboxClicks() {
  const btn  = getTermButtonEl();
  const menu = getTermMenuEl();
  if (!btn || !menu) return;
  btn.onclick = (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    if (!menu.hidden) {
      closeTermMenu();
      if (_gwaTermOutsideClose) {
        document.removeEventListener('click', _gwaTermOutsideClose, true);
        _gwaTermOutsideClose = null;
      }
      return;
    }
    openTermMenu();
    if (_gwaTermOutsideClose) {
      document.removeEventListener('click', _gwaTermOutsideClose, true);
      _gwaTermOutsideClose = null;
    }
    const combo = getTermComboEl();
    setTimeout(() => {
      _gwaTermOutsideClose = (ev) => {
        const me = getTermMenuEl();
        const outsideCombo = !combo || !combo.contains(ev.target);
        const outsideMenu = !me || !me.contains(ev.target);
        if (outsideCombo && outsideMenu) {
          closeTermMenu();
          document.removeEventListener('click', _gwaTermOutsideClose, true);
          _gwaTermOutsideClose = null;
        }
      };
      document.addEventListener('click', _gwaTermOutsideClose, true);
    }, 0);
  };
}

/** @returns {string} stable term label (option value) or '' */
function getSelectedTermLabel() {
  return _termPickerValue || '';
}

/**
 * @param {object} [opts] — `panelPop: false` + `animate: false` for omit/include toggles (no pop animation).
 */
function renderSelectedTermFromPicker(opts = {}) {
  const label = getSelectedTermLabel();
  const d     = _termPickerByLabel[label];
  updateTermDisplay(d && d.subjects ? d.subjects : null, opts);
}

/**
 * Binds the THIS TERM list and in-memory index. Cumulative `termHistory` is written only
 * via Import all (not here).
 * @param {{ restoreLabel?: string }} [opts] — if `restoreLabel` still exists after fetch, keep it selected (e.g. after Refresh terms).
 */
function applySummarizeTermsToPicker(terms, opts) {
  _termPickerByLabel = {};
  _termPickerValue   = '';
  const btn  = getTermButtonEl();
  const lbl  = getTermButtonLabelEl();
  const menu = getTermMenuEl();
  if (!btn || !lbl || !menu) return;

  closeTermMenu();
  if (_gwaTermOutsideClose) {
    try {
      document.removeEventListener('click', _gwaTermOutsideClose, true);
    } catch (e) { /* ignore */ }
    _gwaTermOutsideClose = null;
  }

  if (!terms || !terms.length) {
    btn.disabled = true;
    lbl.textContent = '— No terms —';
    menu.innerHTML  = '';
    updateTermDisplay(null);
    return;
  }

  const sorted = [...terms].sort((a, b) => termSortKey(a.label) - termSortKey(b.label));
  for (const t of sorted) {
    const rec = recomputeTermEntryFromSubjects(t.subjects || [], t.label);
    _termPickerByLabel[t.label] = {
      subjects: t.subjects || [],
      gwa: rec.gwa,
      totalUnits: rec.totalUnits,
      count: rec.count,
      weightSum: rec.weightSum
    };
  }

  btn.disabled   = false;
  menu.innerHTML = sorted.map(t => {
    const show = formatTermLabelForDisplay(t.label);
    return `<li role="option" class="gwa-term-menu-item" data-value="${escapeAttr(t.label)}" title="${escapeAttr(t.label)}">${escapeHtml(show)}</li>`;
  }).join('');

  menu.querySelectorAll('.gwa-term-menu-item').forEach((li) => {
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      const v = li.getAttribute('data-value') != null ? li.getAttribute('data-value') : '';
      _termPickerValue = v;
      lbl.textContent  = v ? formatTermLabelForDisplay(v) : 'Select a term…';
      if (btn) btn.title = v || '';
      try {
        if (v) {
          chrome.storage.local.set({ [_GWA_LAST_TERM_KEY]: v });
        } else {
          chrome.storage.local.remove(_GWA_LAST_TERM_KEY);
        }
      } catch (err) { /* ignore */ }
      closeTermMenu();
      if (_gwaTermOutsideClose) {
        try {
          document.removeEventListener('click', _gwaTermOutsideClose, true);
        } catch (err2) { /* ignore */ }
        _gwaTermOutsideClose = null;
      }
      renderSelectedTermFromPicker();
    });
  });

  const rlab = opts && typeof opts.restoreLabel === 'string' ? opts.restoreLabel.trim() : '';
  if (rlab && _termPickerByLabel[rlab]) {
    _termPickerValue = rlab;
    lbl.textContent  = formatTermLabelForDisplay(rlab);
    if (btn) btn.title = rlab;
    try {
      chrome.storage.local.set({ [_GWA_LAST_TERM_KEY]: rlab });
    } catch (err) { /* ignore */ }
  } else {
    if (rlab) {
      try {
        chrome.storage.local.remove(_GWA_LAST_TERM_KEY);
      } catch (err) { /* ignore */ }
    }
    _termPickerValue   = '';
    lbl.textContent  = 'Select a term…';
    if (btn) btn.title = '';
  }

  bindTermComboboxClicks();
  renderSelectedTermFromPicker();
}

async function loadTermPickerFromApi() {
  const btn = getTermButtonEl();
  const lbl = getTermButtonLabelEl();
  const m   = getTermMenuEl();
  const keepTerm = getSelectedTermLabel();
  if (btn) {
    btn.disabled = true;
  }
  if (lbl) {
    lbl.textContent = 'Loading…';
  }
  if (m) {
    m.innerHTML = '';
    closeTermMenu();
  }
  const { data, firstFailure } = await fetchGradesSummarizeJson();
  if (!data) {
    applySummarizeTermsToPicker([]);
    if (firstFailure) showMsg('Terms: ' + firstFailure, 'error');
    else showMsg('Could not load grades. Log in to AMIS in this tab, then click Refresh terms.', 'error');
    return;
  }
  const terms = parseStudentGradesJson(data);
  applySummarizeTermsToPicker(terms, { restoreLabel: keepTerm || undefined });
  if (!terms.length) {
    showMsg('No terms in the grades response.', 'error');
  }
}

/** Shorter display label (e.g. 1st Sem, 2nd Sem) while storage keys keep the full term string. */
function formatTermLabelForDisplay(label) {
  if (label == null) return '';
  const s0 = String(label).trim();
  if (!s0) return '';
  const m  = s0.match(/(\d{4})\s*[-–]\s*(\d{4})/);
  const tail = m ? ` ${m[1]}-${m[2]}` : '';
  if (/first\s+semester/i.test(s0)) {
    return ('1st Sem' + tail).trim();
  }
  if (/second\s+semester/i.test(s0)) {
    return ('2nd Sem' + tail).trim();
  }
  if (/mid[-\s]?year|mid-year\s+term/i.test(s0)) {
    return ('Mid' + tail).trim();
  }
  return s0;
}

// ── AMIS term code → label (4-digit keys like 1231 = First Sem. AY 2023–24, last digit: 1/2/3) ──
function formatAmisTermCodeToLabel(fourDigit) {
  const s = String(fourDigit).replace(/\D/g, '');
  if (s.length !== 4) return null;
  if (s[0] !== '1') return null;
  const yy = parseInt(s.slice(1, 3), 10);
  if (isNaN(yy) || yy < 0 || yy > 99) return null;
  const semD = s[3];
  const y0   = 2000 + yy;
  const y1   = y0 + 1;
  const yearRange = `${y0}-${y1}`;
  if (semD === '1') return `First Semester ${yearRange}`;
  if (semD === '2') return `Second Semester ${yearRange}`;
  if (semD === '3') return `Midyear ${yearRange}`;
  return null;
}

/** Cumulative / delete buttons: show readable name even for older "Term 1231" storage keys. */
function displayNameForTermKey(termKey) {
  if (termKey == null) return '';
  const t  = String(termKey).trim();
  const m1 = t.match(/^Term\s+(1\d{3})$/i);
  if (m1) {
    const lab = formatAmisTermCodeToLabel(m1[1]);
    if (lab) return formatTermLabelForDisplay(lab);
  }
  if (/^1\d{3}$/.test(t) && t.length === 4) {
    const lab = formatAmisTermCodeToLabel(t);
    return formatTermLabelForDisplay(lab || t);
  }
  return formatTermLabelForDisplay(t);
}

// ── Chronological sort key for term names ──
// e.g. "First Semester 2023-2024" → 20231, "Second Semester 2024-2025" → 20242, code 1231 → 20231
function termSortKey(term) {
  const t0 = String(term);
  // Plain 4-digit or "Term 1231"
  let d = t0;
  if (/^Term\s+/i.test(t0)) d = t0.replace(/^Term\s+/i, '').replace(/\D/g, '').slice(0, 4);
  if (/^1\d{3}$/.test(d) && d.length === 4) {
    const yy  = parseInt(d.slice(1, 3), 10);
    const s   = parseInt(d[3], 10) || 4;
    return (2000 + yy) * 10 + s;
  }
  const yearMatch = t0.match(/(\d{4})-(\d{4})/);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : 9999;
  const t    = t0.toLowerCase();
  const sem  = /first|1st/i.test(t)  ? 1
             : /second|2nd/i.test(t) ? 2
             : /summer|mid|midyear|third/i.test(t) ? 3
             : 4;
  return year * 10 + sem;
}

// ── Compute GWA ──
function computeGWA(subjects) {
  const totalUnits  = subjects.reduce((s, x) => s + x.units, 0);
  const weightedSum = subjects.reduce((s, x) => s + x.grade * x.units, 0);
  return totalUnits > 0 ? (weightedSum / totalUnits) : null;
}

/** AMIS row — prefer final grade; units may be `credited_unit` or `unit_taken`. */
function shouldSkipAmisGradeRow(v) {
  if (!v || typeof v !== 'object') return true;
  if (v.include_in_gwa === false || v.include_in_gwa === 0) return true;
  if (v.exclude_from_gwa === true || v.exclude_from_gwa === 1) return true;
  if (v.is_audit === true || v.audit === true) return true;
  return false;
}

function pickAmisRowUnits(v) {
  const u = v.unit_taken != null ? v.unit_taken : v.credited_unit != null ? v.credited_unit : v.credit_units != null ? v.credit_units : v.units;
  if (u == null || u === '') return null;
  const n = parseFloat(u);
  return isNaN(n) ? null : n;
}

function pickAmisRowGrade(v) {
  const g = v.final_grade != null ? v.final_grade
    : v.final_gwa != null ? v.final_gwa
    : v.grade;
  if (g == null || g === '') return null;
  if (typeof g === 'number') return isNaN(g) ? null : g;
  const t = String(g).trim();
  if (/^[\d.+\-eE]+$/.test(t)) return parseFloat(t);
  const n = parseFloat(t.replace(/[^\d.+\-eE]/g, ''));
  return isNaN(n) ? null : n;
}

/** UP AMIS/SAIS: PE and NSTP (CWTS, LTS, ROTC, etc.) do not count toward academic GWA. */
function isExcludedFromCumulativeGwaCourse(courseCode) {
  const c = (courseCode || '')
    .toString()
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  if (!c) return false;
  if (c === 'PE' || c.startsWith('PE ') || /^PE[\d-]/.test(c)) return true;
  if (c.startsWith('NSTP') || c.includes('NSTP-')) return true;
  return false;
}

function normalizeCourseCodeForKey(courseCode) {
  return (courseCode || '')
    .toString()
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function isUserExcludedForTerm(termLabel, courseCode) {
  if (!termLabel) return false;
  const c = normalizeCourseCodeForKey(courseCode);
  if (!c) return false;
  const arr = _gwaUserExcluded[termLabel];
  if (!arr || !arr.length) return false;
  return arr.some((x) => normalizeCourseCodeForKey(x) === c);
}

function subjectsForGwa(subjects, termLabel) {
  if (!subjects || !subjects.length) return [];
  return subjects.filter(s => {
    if (!s) return false;
    if (isExcludedFromCumulativeGwaCourse(s.code)) return false;
    if (termLabel && isUserExcludedForTerm(termLabel, s.code)) return false;
    return true;
  });
}

function recomputeTermEntryFromSubjects(subjects, termLabel) {
  const forGwa = subjectsForGwa(subjects, termLabel);
  if (!forGwa.length) {
    return { gwa: null, totalUnits: 0, count: 0, weightSum: null };
  }
  const gwa = computeGWA(forGwa);
  return {
    gwa,
    totalUnits: forGwa.reduce((s, x) => s + x.units, 0),
    count: forGwa.length,
    weightSum: subjectListWeightSum(forGwa)
  };
}

function subjectListWeightSum(subjects) {
  if (!subjects || !subjects.length) return null;
  return subjects.reduce((s, x) => s + x.grade * x.units, 0);
}

function loadHistory(callback) {
  chrome.storage.local.get(['termHistory'], (res) => callback(res.termHistory || {}));
}

function deleteTerm(term) {
  chrome.storage.local.get(['termHistory', _GWA_USER_EXCLUDED_KEY], (res) => {
    const history = res.termHistory || {};
    delete history[term];
    const ex = { ...(res[_GWA_USER_EXCLUDED_KEY] || {}) };
    delete ex[term];
    _gwaUserExcluded = ex;
    chrome.storage.local.set({ termHistory: history, [_GWA_USER_EXCLUDED_KEY]: ex });
  });
}

function recomputeAndPersistTerm(termLabel) {
  if (!termLabel) return;
  chrome.storage.local.get(['termHistory'], (res) => {
    const h  = { ...(res.termHistory || {}) };
    const t0 = h[termLabel];
    const fromPicker = _termPickerByLabel[termLabel];
    const subjects =
      t0 && t0.subjects && t0.subjects.length
        ? t0.subjects
        : fromPicker && fromPicker.subjects && fromPicker.subjects.length
          ? fromPicker.subjects
          : null;
    if (!subjects || !subjects.length) {
      showMsg('No course data for this term. Refresh terms or use Import all.', 'success');
      return;
    }
    const rec = recomputeTermEntryFromSubjects(subjects, termLabel);
    if (rec.gwa == null || !rec.totalUnits) {
      h[termLabel] = {
        ...t0,
        gwa: '0.0000',
        totalUnits: 0,
        count: 0,
        weightSum: 0,
        subjects
      };
    } else {
      h[termLabel] = {
        ...t0,
        gwa: rec.gwa.toFixed(4),
        totalUnits: rec.totalUnits,
        count: rec.count,
        weightSum: rec.weightSum,
        subjects
      };
    }
    chrome.storage.local.set({ termHistory: h }, () => updateCumulative({ force: true }));
  });
}

function toggleUserExclusion(termLabel, courseCode, done) {
  const c = normalizeCourseCodeForKey(courseCode);
  if (!termLabel || !c) {
    if (done) done();
    return;
  }
  const prev = _gwaUserExcluded[termLabel] || [];
  let arr = prev.map((x) => normalizeCourseCodeForKey(x));
  const idx = arr.indexOf(c);
  if (idx >= 0) {
    arr = arr.filter((_, i) => i !== idx);
  } else {
    arr = arr.concat(c);
  }
  const next = { ..._gwaUserExcluded };
  if (arr.length) next[termLabel] = arr;
  else delete next[termLabel];
  _gwaUserExcluded = next;
  try {
    chrome.storage.local.set({ [_GWA_USER_EXCLUDED_KEY]: _gwaUserExcluded }, () => {
      if (typeof done === 'function') done();
    });
  } catch (e) {
    if (typeof done === 'function') done();
  }
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Render honors badge ──
function honorsHTML(gwa, fn = getLatinHonors) {
  const h = fn(gwa);
  if (!h) return '';
  return `<span class="gwa-honors ${h.cls}">${h.title}</span>`;
}

// ── Update term display (UI only — no saving) ──
function updateTermDisplay(subjects, opts = {}) {
  const panelPop = opts.panelPop !== false;
  const animate  = opts.animate !== false;
  const resultEl = document.getElementById('gwa-term-result');
  const listEl   = document.getElementById('gwa-term-list');
  if (!resultEl) return;

  if (!subjects || !subjects.length) {
    const btnLabel  = (getTermButtonLabelEl()?.textContent || '').trim();
    const isLoading = /loading/i.test(btnLabel);
    const hasRealTerms = Object.keys(_termPickerByLabel).length > 0;
    const picked    = getSelectedTermLabel();
    if (isLoading) {
      resultEl.innerHTML = '<span class="gwa-na">Loading terms…</span>';
    } else if (hasRealTerms && !picked) {
      resultEl.innerHTML = '<span class="gwa-na">Select a term to view grades</span>';
    } else if (picked) {
      resultEl.innerHTML = '<span class="gwa-na">No course rows for this term</span>';
    } else {
      resultEl.innerHTML = '<span class="gwa-na">Log in to AMIS, then use Refresh terms</span>';
    }
    if (listEl) listEl.innerHTML = '';
    return;
  }

  const termLabel = getSelectedTermLabel();
  const gwaRows   = subjectsForGwa(subjects, termLabel);

  if (panelPop) {
    popPanel('.gwa-panel-term');
  }

  const pIn  = animate ? ' gwa-pop-in' : '';
  const subAD = animate ? ' style="animation-delay:40ms"' : '';

  if (!gwaRows.length) {
    const uAll = subjects.reduce((s, x) => s + x.units, 0);
    resultEl.innerHTML = `
      <span class="gwa-na${pIn}">No GWA-qualifying load (e.g. only PE / NSTP, or all omitted)</span>
      <span class="gwa-sub" style="display:block;margin-top:4px;opacity:0.85">${subjects.length} course${subjects.length > 1 ? 's' : ''} shown · ${uAll} u total</span>
    `;
  } else {
    const gwa     = computeGWA(gwaRows);
    const uGwa    = gwaRows.reduce((s, x) => s + x.units, 0);
    const subLine = gwaRows.length === subjects.length
      ? `${gwaRows.length} subjects · ${uGwa} units`
      : `${gwaRows.length} of ${subjects.length} in GWA · ${uGwa} u`;
    resultEl.innerHTML = `
    <span class="gwa-big${pIn}">${gwa != null ? gwa.toFixed(4) : '—'}</span>
    <span class="gwa-sub${pIn}"${subAD}>${subLine}</span>
    ${gwa != null ? honorsHTML(gwa, getScholarHonors) : ''}
  `;
  }

  const rowIn = animate ? ' gwa-pop-in' : '';
  listEl.innerHTML = subjects.map((s, i) => {
    const gStr = s.grade != null && !isNaN(Number(s.grade)) ? Number(s.grade).toFixed(2) : '—';
    const policyExcl = isExcludedFromCumulativeGwaCourse(s.code);
    const userExcl   = !policyExcl && termLabel && isUserExcludedForTerm(termLabel, s.code);
    const showAsExcluded = policyExcl || userExcl;
    const gradeText  = showAsExcluded ? `(${gStr})` : gStr;
    const omitCell   = policyExcl
      ? '<span class="gwa-omit-slot" aria-hidden="true"></span>'
      : `<button type="button" class="gwa-omit" data-code="${escapeAttr(String(s.code))}" aria-pressed="${userExcl ? 'true' : 'false'}" aria-label="${userExcl ? 'Include in GWA' : 'Omit from GWA'}" title="${userExcl ? 'Include in GWA' : 'Omit from GWA'}">${userExcl ? '+' : '−'}</button>`;
    const rowSt = animate ? ` style="animation-delay:${60 + i * 35}ms"` : '';
    return `
    <div class="gwa-row gwa-term-course-row${rowIn}${showAsExcluded ? ' gwa-row-excl' : ''}"${rowSt}>
      <span class="gwa-code">${escapeHtml(String(s.code))}</span>
      <span class="gwa-units">${s.units}u</span>
      <span class="gwa-grade${showAsExcluded ? ' gwa-grade-excl' : ''}">${gradeText}</span>
      ${omitCell}
    </div>
  `;
  }).join('');
}

function buildCumulativeExclusionSig() {
  const o = _gwaUserExcluded || {};
  return Object.keys(o)
    .sort()
    .map((k) => {
      const arr = o[k] || [];
      return k + '§' + arr.map((c) => normalizeCourseCodeForKey(c)).filter(Boolean).sort().join(',');
    })
    .join('|');
}

function buildCumulativeDataSig(history) {
  if (!history || !Object.keys(history).length) return 'EMPTY||' + buildCumulativeExclusionSig();
  const keys = Object.keys(history).sort((a, b) => termSortKey(a) - termSortKey(b));
  const body = keys
    .map((k) => {
      const t = history[k];
      return [
        k,
        t && t.gwa != null ? String(t.gwa) : '',
        t && t.totalUnits != null ? String(t.totalUnits) : '',
        t && t.weightSum != null ? String(t.weightSum) : ''
      ].join('§');
    })
    .join('\n');
  return buildCumulativeExclusionSig() + '||' + body;
}

/**
 * `termHistory` drives this panel. Skip DOM updates when `data-cum-sig` and the readout
 * already match storage (e.g. init after a navigation with unchanged data).
 */
function canSkipCumulativeRender(resultEl, targetSig, cumStr, force) {
  if (force) return false;
  if (resultEl.getAttribute('data-cum-sig') !== targetSig) return false;
  if (String(targetSig).indexOf('EMPTY||') === 0) {
    return resultEl.textContent && resultEl.textContent.indexOf('Import all') >= 0;
  }
  const big = resultEl.querySelector('.gwa-big');
  return big != null && big.textContent.trim() === cumStr;
}

// ── Cumulative: Import all, Clear all, per-row remove ──
function updateCumulative(options = {}) {
  const force  = options.force === true;
  const doPop  = options.pop === true;
  const rowCls = doPop ? 'gwa-row gwa-pop-in' : 'gwa-row';
  const numCls = doPop ? 'gwa-big gwa-pop-in' : 'gwa-big';
  const subCls = doPop ? 'gwa-sub gwa-pop-in' : 'gwa-sub';

  loadHistory(history => {
    const termsEl  = document.getElementById('gwa-cumulative-terms');
    const resultEl = document.getElementById('gwa-cumulative-result');
    if (!resultEl) return;

    const keys = Object.keys(history).sort((a, b) => termSortKey(a) - termSortKey(b));
    if (!keys.length) {
      const emptySig = buildCumulativeDataSig({});
      if (canSkipCumulativeRender(resultEl, emptySig, null, force)) return;
      resultEl.setAttribute('data-cum-sig', emptySig);
      resultEl.innerHTML  = '<span class="gwa-na">Use Import all to load terms from AMIS</span>';
      if (termsEl) termsEl.innerHTML = '';
      if (doPop) popPanel('.gwa-panel-cumul');
      return;
    }

    let totalWeighted = 0, totalUnits = 0;
    keys.forEach((k) => {
      const t = history[k];
      if (!t || t.totalUnits <= 0) return;
      if (t.weightSum != null && t.totalUnits > 0) {
        totalWeighted += t.weightSum;
      } else {
        totalWeighted += parseFloat(t.gwa) * t.totalUnits;
      }
      totalUnits += t.totalUnits;
    });
    const cumulative  = totalUnits > 0 ? totalWeighted / totalUnits : 0;
    const cumStr      = cumulative.toFixed(4);
    const dataSig     = buildCumulativeDataSig(history);

    if (canSkipCumulativeRender(resultEl, dataSig, cumStr, force)) {
      if (doPop) popPanel('.gwa-panel-cumul');
      return;
    }

    if (doPop) popPanel('.gwa-panel-cumul');

    resultEl.setAttribute('data-cum-sig', dataSig);
    resultEl.innerHTML = `
      <span class="${numCls}">${cumStr}</span>
      <span class="${subCls}" ${doPop ? 'style="animation-delay:40ms"' : ''}>${keys.length} term${keys.length > 1 ? 's' : ''} · ${totalUnits} total units</span>
      ${honorsHTML(cumulative)}
    `;

    if (!termsEl) return;
    const delayStyle = (i) => (doPop ? ` style="animation-delay:${60 + i * 35}ms"` : '');
    termsEl.innerHTML = keys.map((k, i) => {
      const th = history[k];
      const u  = th && th.totalUnits != null ? th.totalUnits : 0;
      const g  = th && th.gwa != null ? String(th.gwa) : '—';
      const gShow = u > 0 ? g : '—';
      return `
      <div class="${rowCls}"${delayStyle(i)}>
        <button class="gwa-del" data-term="${escapeAttr(k)}" title="Remove term">✕</button>
        <span class="gwa-code">${escapeHtml(displayNameForTermKey(k))}</span>
        <span class="gwa-grade">${escapeHtml(gShow)}</span>
      </div>
    `;
    }).join('');

    termsEl.querySelectorAll('.gwa-del').forEach(btn => {
      btn.onclick = () => {
        deleteTerm(btn.dataset.term);
        showMsg('Term removed.', 'success');
        setTimeout(() => updateCumulative(), 200);
      };
    });
  });
}

// ── Grades API discovery and bulk import ──

function isXhrOrFetchType(entry) {
  const t = entry.initiatorType;
  if (t === 'script' || t === 'link' || t === 'img' || t === 'css' || t === 'beacon' || t === 'font') {
    return false;
  }
  return true;
}

function isGradesApiResourceUrl(n) {
  try {
    const u = new URL(n, location.origin);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname;
    if (h !== 'amis.upcebu.edu.ph' && h !== 'api-amis.upcebu.edu.ph') return false;
    if (!/summarize/i.test(u.search) && !/summarize/i.test(n)) return false;
    if (!/grades/i.test(u.pathname) && !/grades/i.test(u.search)) return false;
    if (/\/_nuxt\//.test(u.pathname) || /\.(js|mjs|css|map|ico|png|svg|woff2?)(\?|#|$)/i.test(u.pathname)) {
      return false;
    }
    // App shell / catch-all: root `/grades?…` on api host often returns HTML
    if (h === 'api-amis.upcebu.edu.ph' && u.pathname === '/grades') return false;
    if (h === 'amis.upcebu.edu.ph' && u.pathname === '/grades') return false;
    return u.pathname.includes('/api/') || /\/students\/grades/i.test(u.pathname);
  } catch (e) {
    return false;
  }
}

/** Amis may proxy `/api/...` same-origin; extension can hit either host with cookies. */
function toApiAmisUrl(n) {
  return n.replace(/^https:\/\/amis\.upcebu\.edu\.ph(?=\/)/, 'https://api-amis.upcebu.edu.ph');
}

function getPerformanceGradesApiUrls() {
  const out = [];
  const seen = new Set();
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
  try {
    const list = performance.getEntriesByType('resource');
    const scored = [];
    for (const e of list) {
      const n = e.name;
      if (!isGradesApiResourceUrl(n) || !isXhrOrFetchType(e)) continue;
      const pri = (e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') ? 0 : 1;
      scored.push({ n, pri });
    }
    scored.sort((a, b) => a.pri - b.pri);
    for (const { n } of scored) {
      const apiN = toApiAmisUrl(n);
      // Prefer same origin as the tab (amis) first — app XHRs there; api-amis may return Nuxt for some paths
      if (apiN !== n) {
        add(n);
        add(apiN);
      } else {
        add(n);
      }
    }
  } catch (_) {}
  return out;
}

const _SUMMARIZE_URL_FALLBACKS = [
  'https://amis.upcebu.edu.ph/api/students/grades?summarize=true',
  'https://api-amis.upcebu.edu.ph/api/students/grades?summarize=true',
  'https://amis.upcebu.edu.ph/api/grades?summarize=true',
  'https://api-amis.upcebu.edu.ph/api/grades?summarize=true',
  'https://amis.upcebu.edu.ph/api/v1/grades?summarize=true',
  'https://api-amis.upcebu.edu.ph/api/v1/grades?summarize=true',
  'https://api-amis.upcebu.edu.ph/grades?summarize=true',
];

function labelFromGradeTerm(gt) {
  if (gt == null) return null;
  if (typeof gt === 'number' && gt >= 1000 && gt <= 19999) {
    return formatAmisTermCodeToLabel(String(Math.floor(gt))) || null;
  }
  if (typeof gt === 'string') {
    const raw = gt.trim();
    if (raw.length >= 4 && /^1\d{3}$/.test(raw.replace(/\D/g, '').slice(0, 4))) {
      const dig = raw.replace(/\D/g, '').slice(0, 4);
      if (/^1\d{3}$/.test(dig)) {
        const lab = formatAmisTermCodeToLabel(dig);
        if (lab) return lab;
      }
    }
    if (raw.length > 2) return raw.replace(/\s+/g, ' ').trim();
  }
  if (typeof gt === 'object') {
    const pickCode = (v) => {
      if (v == null) return null;
      const s = String(v).replace(/\D/g, '');
      if (s.length >= 4) {
        const four = s.slice(-4);
        if (/^1\d{3}$/.test(four)) return formatAmisTermCodeToLabel(four);
      }
      return null;
    };
    for (const k of ['name', 'semester_name', 'semester', 'label', 'title', 'description', 'academic_term', 'academicTerm', 'term']) {
      const v = gt[k];
      if (v != null && String(v).trim().length > 2) {
        const str = String(v).trim();
        if (/^1\d{3}$/.test(str.replace(/\D/g, '').slice(0, 4))) {
          const lab = pickCode(str);
          if (lab) return lab;
        }
        if (/(\d{4})\s*[-–]\s*(\d{4})/.test(str) || /20\d{2}/.test(str)) {
          return str.replace(/\s+/g, ' ').trim();
        }
      }
    }
    for (const k of ['code', 'id', 'academic_term_id', 'term_id', 'grade_term_id', 'academic_term_code']) {
      const v = gt[k];
      if (v != null) {
        const lab = pickCode(v) || (typeof v === 'number' ? formatAmisTermCodeToLabel(String(Math.floor(v))) : null);
        if (lab) return lab;
      }
    }
    const name = (gt.name || gt.semester_name || gt.semester || gt.term || '').toString();
    // AMIS uses `ay` (e.g. "2023-2024") alongside `term` (e.g. "Second Semester")
    const ay   = (gt.academic_year || gt.academicYear || gt.school_year || gt.year || gt.ay || '').toString();
    if (name && ay) return `${name} ${ay}`.replace(/\s+/g, ' ').trim();
    if (name && /20\d{2}/.test(name)) return name.replace(/\s+/g, ' ').trim();
  }
  return null;
}

/**
 * @returns { { label: string, gwa: number, totalUnits: number, count: number, weightSum: number|null, subjects: { code: string, title: string, units: number, grade: number }[] }[] }
 * `subjects` lists all displayable courses (incl. PE/NSTP); GWA fields use academic rows only.
 */
function parseStudentGradesJson(json) {
  const root = json && (json.student_grades || (json.data && json.data.student_grades));
  if (!root || typeof root !== 'object') return [];

  const out = [];
  for (const key of Object.keys(root)) {
    const bucket = root[key];
    const meta   = !Array.isArray(bucket) && bucket && typeof bucket === 'object' ? bucket : null;
    const values = Array.isArray(bucket) ? bucket : (bucket && bucket.values);
    if (!Array.isArray(values) || !values.length) continue;

    const forGwa = [];
    const forDisplay = [];
    let label = null;
    if (meta && typeof meta.term === 'string' && meta.term.trim().length > 1) {
      label = meta.term.replace(/\s+/g, ' ').trim();
    }

    for (const v of values) {
      if (shouldSkipAmisGradeRow(v)) continue;
      const code = (v.course && (v.course.course_code || v.course.code)) || v.course_code || '';
      const title = (v.course && (v.course.title || v.course.name || v.course.course_title)) || '';

      const units = pickAmisRowUnits(v);
      const grade = pickAmisRowGrade(v);
      if (units == null || units <= 0 || grade == null || grade <= 0) continue;

      if (!label) label = labelFromGradeTerm(v.grade_term);

      const row = { code: String(code).trim(), title: String(title).trim(), units, grade };
      forDisplay.push(row);
      if (!isExcludedFromCumulativeGwaCourse(code)) forGwa.push(row);
    }

    if (!forGwa.length) continue;
    if (!label) {
      const kStr = String(key);
      const four = (kStr.replace(/\D/g, '').match(/1\d{3}/) || [])[0] || (kStr.length === 4 && /^1\d{3}$/.test(kStr) ? kStr : null);
      label = (four && formatAmisTermCodeToLabel(four)) || `Term ${key}`;
    }

    const gwa    = computeGWA(forGwa);
    const tUnits = forGwa.reduce((s, x) => s + x.units, 0);
    const wSum   = subjectListWeightSum(forGwa);
    if (gwa == null) continue;

    out.push({
      label,
      gwa,
      totalUnits: tUnits,
      count: forGwa.length,
      weightSum: wSum,
      subjects: forDisplay
    });
  }
  return out;
}

let _bulkImportRunning = false;

/** True after Clear all in this tab (session): blocks automatic bulk re-import until the next manual Import all. */
function isBulkAmisBackfillDisabled() {
  try {
    return sessionStorage.getItem('gwaSkipApiSummarize') === '1';
  } catch (e) {
    return false;
  }
}

/**
 * Replace `termHistory` with the current API payload (no merge with prior storage).
 * Per-term GWA/weights are recomputed with the same PE/NSTP and user-omit rules as the UI.
 */
function mergeApiTermsIntoStorage(terms) {
  if (isBulkAmisBackfillDisabled()) return;
  if (!terms || !terms.length) return;
  chrome.storage.local.get(['termHistory'], () => {
    if (isBulkAmisBackfillDisabled()) return;
    const history = {};
    for (const t of terms) {
      const rec = recomputeTermEntryFromSubjects(t.subjects || [], t.label);
      if (!t.subjects || !t.subjects.length) continue;
      if (rec.gwa == null || !rec.totalUnits) {
        history[t.label] = {
          gwa: '0.0000',
          totalUnits: 0,
          count: 0,
          weightSum: 0,
          subjects: t.subjects
        };
        continue;
      }
      const row = {
        gwa: rec.gwa.toFixed(4),
        totalUnits: rec.totalUnits,
        count: rec.count,
        subjects: t.subjects || []
      };
      if (rec.weightSum != null && !isNaN(Number(rec.weightSum))) {
        row.weightSum = Number(rec.weightSum);
      }
      history[t.label] = row;
    }
    if (isBulkAmisBackfillDisabled()) return;
    chrome.storage.local.set({ termHistory: history });
  });
}

function isUnauthenticatedPayload(j) {
  if (j == null || typeof j !== 'object') return false;
  const m = j.message;
  return typeof m === 'string' && /unauthenticated|unauthor/i.test(m);
}

/** Message for a failed or unusable grades API response. */
function describeGradesApiFailure(res, j) {
  if (j && j._gwaNotJson) {
    return `Not JSON (HTTP ${res.status}): ${String(j.raw || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)}`;
  }
  if (j != null && typeof j === 'object' && isUnauthenticatedPayload(j)) {
    return `Not logged in (HTTP ${res.status}): ${j.message || 'Unauthenticated'}`;
  }
  if (!res.ok) {
    const m = j && (j.message || (typeof j.error === 'string' ? j.error : ''));
    return 'HTTP ' + res.status + (m ? ' — ' + m : '');
  }
  if (j == null || typeof j !== 'object') {
    return 'Empty or invalid body (HTTP ' + res.status + ')';
  }
  if (j.student_grades || (j.data && j.data.student_grades)) {
    return 'No usable term rows in student_grades (empty or invalid shape)';
  }
  const keys = Object.keys(j)
    .slice(0, 12)
    .join(', ');
  return 'Missing student_grades (HTTP ' + res.status + (keys ? '). Response keys: ' + keys : ')');
}

let _pageBearerInjectPromise = null;

/** Injects the bearer helper script; CSP only allows this extension’s scripts in the page. */
function ensurePageBearerScript() {
  if (_pageBearerInjectPromise) return _pageBearerInjectPromise;
  const existing = document.getElementById('gwa-upcebu-bearer-hook');
  if (existing) {
    if (existing.getAttribute('data-gwa-ready') === '1') {
      return (_pageBearerInjectPromise = Promise.resolve());
    }
    return (_pageBearerInjectPromise = new Promise((resolve, reject) => {
      const tryReady = () => existing.getAttribute('data-gwa-ready') === '1';
      if (tryReady()) {
        resolve();
        return;
      }
      const onError = () => {
        _pageBearerInjectPromise = null;
        reject(new Error('gwa: page-bearer.js failed to load'));
      };
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', onError, { once: true });
      const t0 = performance.now();
      const poll = setInterval(() => {
        if (tryReady()) {
          clearInterval(poll);
          resolve();
        } else if (performance.now() - t0 > 15000) {
          clearInterval(poll);
          onError();
        }
      }, 25);
    }));
  }
  _pageBearerInjectPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.id = 'gwa-upcebu-bearer-hook';
    s.src = chrome.runtime.getURL('page-bearer.js');
    s.onload = () => resolve();
    s.onerror = () => {
      _pageBearerInjectPromise = null;
      reject(new Error('gwa: page-bearer.js failed to load'));
    };
    (document.documentElement || document.head).appendChild(s);
  });
  return _pageBearerInjectPromise;
}

/** Ask page context for a Bearer value (for background fetch). */
function getBearerFromPage() {
  return new Promise((resolve) => {
    const id = 'gwaB' + Date.now() + Math.random().toString(36).slice(2);
    const t = setTimeout(() => resolve(null), 4000);
    const onMessage = (e) => {
      if (e.origin !== window.location.origin) return;
      if (!e.data || e.data.gwaType !== 'GWA_BEARER' || e.data.gwaBearerId !== id) return;
      clearTimeout(t);
      window.removeEventListener('message', onMessage, true);
      resolve(e.data.bearerValue || null);
    };
    window.addEventListener('message', onMessage, true);
    void (async () => {
      try {
        await ensurePageBearerScript();
      } catch (e) {
        clearTimeout(t);
        window.removeEventListener('message', onMessage, true);
        resolve(null);
        return;
      }
      window.postMessage({ gwaType: 'GWA_GET_BEARER', gwaBearerId: id }, '*');
    })();
  });
}

/** Grades API via service worker: bypasses page CORS; uses chrome.cookies + optional Bearer. */
function apiFetchViaBackground(url, authorization) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'GWA_API_FETCH', url, authorization: authorization || undefined },
      res => {
        if (chrome.runtime.lastError) {
          resolve({
            error: true,
            lastError: chrome.runtime.lastError.message
          });
          return;
        }
        resolve(res);
      }
    );
  });
}

function candidateSummarizeUrls() {
  const out = [];
  const seen = new Set();
  const add = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u); } };
  // API JSON paths first — Performance entries are hints only; wrong/missing route returns Nuxt HTML.
  _SUMMARIZE_URL_FALLBACKS.forEach(add);
  getPerformanceGradesApiUrls().forEach(add);
  return out;
}

/** @returns { { data: any, firstFailure?: string } } data = parsed JSON with student_grades, or null */
async function fetchGradesSummarizeJson() {
  const urls = candidateSummarizeUrls();
  const bearer  = await getBearerFromPage();
  let firstFailure = null;
  for (const u of urls) {
    if (!u) continue;
    const res = await apiFetchViaBackground(u, bearer);
    if (res && res.lastError) {
      firstFailure = 'Extension: ' + res.lastError;
      continue;
    }
    if (!res || res.error) {
      firstFailure = (res && res.error) ? String(res.error) : 'No response from extension';
      continue;
    }
    const j = res.json;
    if (
      j &&
      (j.student_grades || (j.data && j.data.student_grades)) &&
      !isUnauthenticatedPayload(j)
    ) {
      return { data: j, firstFailure: null };
    }
    firstFailure = describeGradesApiFailure(res, j);
  }
  return { data: null, firstFailure };
}

/** Fetches all terms from the API, updates storage and UI; includes retries and state cleanup. */
async function runAmisBulkImport() {
  if (_bulkImportRunning) {
    showMsg('Import already running, please wait…', 'success');
    return;
  }
  try {
    sessionStorage.removeItem('gwaSkipApiSummarize');
  } catch (e) { /* ignore */ }
  _bulkImportRunning = true;
  showMsg('Importing from AMIS…', 'success');

  try {
    for (let i = 0; i < 10; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1000));
      if (isBulkAmisBackfillDisabled()) {
        showMsg('Import cancelled (storage flag).', 'error');
        return;
      }
      const { data, firstFailure } = await fetchGradesSummarizeJson();
      if (!data) {
        if (i === 0 && firstFailure) {
          showMsg('Import: ' + firstFailure, 'error');
        }
        if (i === 9) {
          const detail = firstFailure
            ? 'Extension: ' + firstFailure
            : 'API returned no grades. Log in to AMIS, then try Import all again.';
          showMsg('Import failed. ' + detail, 'error');
        }
        continue;
      }
      const terms = parseStudentGradesJson(data);
      if (!terms.length) {
        showMsg('Import failed: no term data in the response.', 'error');
        return;
      }
      if (isBulkAmisBackfillDisabled()) {
        showMsg('Import cancelled.', 'error');
        return;
      }
      mergeApiTermsIntoStorage(terms);
      applySummarizeTermsToPicker(terms);
      setTimeout(() => {
        if (!isBulkAmisBackfillDisabled()) {
          updateCumulative({ force: true, pop: true });
          showMsg('Loaded all terms from AMIS', 'success');
        }
      }, 50);
      return;
    }
  } finally {
    _bulkImportRunning = false;
  }
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
        <button id="gwa-toggle" class="gwa-icon-btn" title="Collapse">▾</button>
      </div>
    </div>
    <div id="gwa-body">

      <div class="gwa-panel gwa-panel-term" title="Per-term GWA and course list (AMIS API).">
        <div class="gwa-panel-hd gwa-panel-hd-term">
          <span class="gwa-section-label">THIS TERM</span>
        </div>
        <div class="gwa-term-select-row">
          <div class="gwa-term-combo" id="gwa-term-combo">
            <button type="button" id="gwa-term-button" class="gwa-term-select" disabled aria-label="Academic term" aria-haspopup="listbox" aria-expanded="false">
              <span class="gwa-term-button-label" id="gwa-term-button-label">Loading…</span>
            </button>
            <ul class="gwa-term-menu" id="gwa-term-menu" role="listbox" hidden></ul>
          </div>
          <button type="button" id="gwa-refresh-terms" class="gwa-refresh-terms" title="Reload term list">↻</button>
        </div>
        <div id="gwa-term-result"><span class="gwa-na">Loading terms…</span></div>
        <div id="gwa-term-list"></div>
      </div>

      <div class="gwa-panel gwa-panel-cumul" title="Cumulative GWA from saved terms (Import all, Clear, remove row).">
        <div class="gwa-panel-hd">
          <span class="gwa-section-label">CUMULATIVE GWA</span>
          <span class="gwa-auto-label">import</span>
        </div>
        <div id="gwa-cumulative-result"><span class="gwa-na">Use Import all to load cumulative data</span></div>
        <div id="gwa-cumulative-terms"></div>
      </div>

      <div id="gwa-actions">
        <button type="button" id="gwa-import-all" title="Fetches grades for every term from the server at once">Import all</button>
        <button id="gwa-clear">Clear all</button>
      </div>

      <div class="gwa-panel gwa-panel-info">
        <div class="gwa-panel-hd">
          <span class="gwa-section-label">SEMESTRAL HONORS</span>
        </div>
        <div class="gwa-honors-row"><span class="clr-univ">University Scholar</span><span>≤ 1.45</span></div>
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
  const refreshTermsBtn = document.getElementById('gwa-refresh-terms');
  if (refreshTermsBtn) {
    refreshTermsBtn.onclick = () => {
      void loadTermPickerFromApi();
    };
  }
  updateTermDisplay(null);
  const gwaBody = document.getElementById('gwa-body');
  if (gwaBody) {
    gwaBody.addEventListener('scroll', () => closeTermMenu(), { passive: true });
  }
  window.addEventListener('resize', () => closeTermMenu());
  document.addEventListener('keydown', (e) => {
    const m = getTermMenuEl();
    if (e.key === 'Escape' && m && !m.hidden) {
      e.stopPropagation();
      closeTermMenu();
    }
  });

  // Collapse/expand with smooth height + opacity animation
  let collapsed = false;
  const toggleBtn = document.getElementById('gwa-toggle');
  const body      = document.getElementById('gwa-body');

  function clampToViewport(gap) {
    const rect    = overlay.getBoundingClientRect();
    const maxLeft = window.innerWidth  - overlay.offsetWidth  - gap;
    const maxTop  = window.innerHeight - overlay.offsetHeight - gap;
    const newLeft = Math.max(gap, Math.min(rect.left, maxLeft));
    const newTop  = Math.max(gap, Math.min(rect.top,  maxTop));
    if (newLeft !== rect.left || newTop !== rect.top) {
      overlay.style.bottom = 'auto';
      overlay.style.right  = 'auto';
      overlay.style.left   = newLeft + 'px';
      overlay.style.top    = newTop  + 'px';
    }
  }

  // Track the active transitionend listener so rapid toggles can cancel it
  let pendingTransition = null;

  function cancelPending() {
    if (!pendingTransition) return;
    body.removeEventListener('transitionend', pendingTransition);
    pendingTransition = null;
  }

  toggleBtn.onclick = () => {
    collapsed = !collapsed;
    toggleBtn.classList.toggle('gwa-collapsed', collapsed);

    // Cancel any in-flight animation before starting a new one
    cancelPending();

    if (collapsed) {
      // Freeze at current mid-animation height, then animate to 0
      body.style.height   = getComputedStyle(body).height;
      body.style.overflow = 'hidden';
      body.offsetHeight;  // force reflow so the freeze registers
      requestAnimationFrame(() => {
        body.style.height  = '0';
        body.style.opacity = '0';
      });
      pendingTransition = e => {
        if (e.propertyName !== 'height') return;
        cancelPending();
        body.style.display = 'none';
        body.style.opacity = '';
      };
      body.addEventListener('transitionend', pendingTransition);

    } else {
      // Ensure visible, freeze at current height (may be mid-collapse or 0), animate to full
      body.style.display  = 'block';
      body.style.height   = getComputedStyle(body).height;
      body.style.overflow = 'hidden';
      body.offsetHeight;  // force reflow
      requestAnimationFrame(() => {
        body.style.height  = body.scrollHeight + 'px';
        body.style.opacity = '1';
      });
      pendingTransition = e => {
        if (e.propertyName !== 'height') return;
        cancelPending();
        body.style.height   = '';
        body.style.overflow = '';
        clampToViewport(EDGE_GAP);
      };
      body.addEventListener('transitionend', pendingTransition);
    }
  };

  // One-shot bulk import (not automatic — prevents cleared history from being refilled in the background)
  document.getElementById('gwa-import-all').onclick = () => {
    void runAmisBulkImport().catch(e => {
      _bulkImportRunning = false;
      showMsg('Import error: ' + (e && e.message ? e.message : String(e)), 'error');
    });
  };

  document.getElementById('gwa-clear').onclick = () => {
    try {
      sessionStorage.setItem('gwaSkipApiSummarize', '1');
    } catch (e) { /* ignore */ }
    _gwaUserExcluded = {};
    chrome.storage.local.set({ termHistory: {}, [_GWA_USER_EXCLUDED_KEY]: {} }, () => {
      showMsg('History cleared.', 'success');
      updateCumulative({ force: true });
    });
  };

  const termListEl = document.getElementById('gwa-term-list');
  if (termListEl) {
    termListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.gwa-omit');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const code = btn.getAttribute('data-code');
      if (!code) return;
      const label = getSelectedTermLabel();
      if (!label) return;
      if (isExcludedFromCumulativeGwaCourse(code)) return;
      toggleUserExclusion(label, code, () => {
        renderSelectedTermFromPicker({ panelPop: false, animate: false });
        recomputeAndPersistTerm(label);
      });
    });
  }

  // Draggable overlay — constrained to viewport with edge gap
  const header = document.getElementById('gwa-header');
  const EDGE_GAP = 20;
  let dragging = false, dragX, dragY, startLeft, startTop;

  header.addEventListener('mousedown', e => {
    if (e.target.closest('button')) return;

    // Convert bottom/right anchor to top/left for drag math
    const rect = overlay.getBoundingClientRect();
    overlay.style.bottom = 'auto';
    overlay.style.right  = 'auto';
    overlay.style.top    = rect.top  + 'px';
    overlay.style.left   = rect.left + 'px';

    dragging  = true;
    dragX     = e.clientX;
    dragY     = e.clientY;
    startLeft = rect.left;
    startTop  = rect.top;
    header.style.cursor = 'grabbing';
    overlay.classList.add('gwa-lifted', 'gwa-dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;

    const newLeft = startLeft + (e.clientX - dragX);
    const newTop  = startTop  + (e.clientY - dragY);
    const maxLeft = window.innerWidth  - overlay.offsetWidth  - EDGE_GAP;
    const maxTop  = window.innerHeight - overlay.offsetHeight - EDGE_GAP;

    overlay.style.left = Math.max(EDGE_GAP, Math.min(newLeft, maxLeft)) + 'px';
    overlay.style.top  = Math.max(EDGE_GAP, Math.min(newTop,  maxTop))  + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    header.style.cursor = 'grab';
    overlay.classList.remove('gwa-lifted', 'gwa-dragging');
  });
}

// ── Init ──
function init() {
  chrome.storage.local.get([_GWA_USER_EXCLUDED_KEY], (res) => {
    const ex = res[_GWA_USER_EXCLUDED_KEY];
    _gwaUserExcluded = ex && typeof ex === 'object' ? { ...ex } : {};
    createOverlay();
    updateCumulative();
    void loadTermPickerFromApi();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  setTimeout(init, 1500);
}
