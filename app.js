// LC-3 exam IDE that runs entirely in the browser: Monaco editor, LC-3 assembler and simulator
// (lc3tools rules), registers and memory view. Opened as index.html?exam=<id>; the exam is exams/<id>.json.

import { assemble, assembleOS, Machine, disassemble, hex4, MNEMONICS } from './lc3core.js';
import { runTest } from './lc3tests.js';
import OS_SOURCE from './lc3os.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const examId = (params.get('exam') || '').replace(/[^\w.-]/g, '');
const STORE_KEY = `lc3exam:${examId}:v1`;
const OS = assembleOS(OS_SOURCE);
const OS_ADDR = {
  [OS.symbols.e_acv]: 'access violation', [OS.symbols.e_ill]: 'illegal opcode',
  [OS.symbols.e_priv]: 'privilege violation', [OS.symbols.bad_trap]: 'undefined trap',
};

let exam = null;
let editor = null;
let monaco = null;
const models = new Map();       // path -> monaco model
let active = null;
let openTabs = [];

// ---- console --------------------------------------------------------------------

const con = $('console');
const cursor = document.createElement('span');
cursor.className = 'cursor';
cursor.textContent = ' ';
con.appendChild(cursor);

function print(text, cls = '') {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  con.insertBefore(span, cursor);
  con.scrollTop = con.scrollHeight;
  return span;
}

function printLink(text, cls, onclick) {
  const a = document.createElement('a');
  a.className = `diag ${cls}`;
  a.textContent = text;
  a.href = '#';
  a.onclick = (e) => { e.preventDefault(); onclick(); };
  con.insertBefore(a, cursor);
  con.insertBefore(document.createTextNode('\n'), cursor);
}

// Program output arrives a character at a time; batch it per animation frame
let pendingOut = '';
function programOutput(text) {
  if (!pendingOut) requestAnimationFrame(() => { print(pendingOut); pendingOut = ''; });
  pendingOut += text;
}

$('btn-clear').onclick = () => { con.replaceChildren(cursor); };

// Typing in the console sends keys to the LC-3 keyboard (no echo, as on the real machine)
con.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key === 'Enter' ? '\n' : e.key === 'Tab' ? '\t' : e.key === 'Backspace' ? '\b' : e.key.length === 1 ? e.key : null;
  if (key === null) return;
  e.preventDefault();
  sendKeys(key);
});
con.addEventListener('paste', (e) => {
  e.preventDefault();
  sendKeys((e.clipboardData || window.clipboardData).getData('text').replace(/\r\n?/g, '\n'));
});
function sendKeys(text) {
  if (!loaded || machine.halted) { setRunState('Run the program first, then type here.', ''); return; }
  machine.addInput(text);
  if (!running) setRunState(`${text.length} key(s) waiting for the program`, 'waiting');
}

function setRunState(text, cls = '') {
  $('run-state').textContent = text;
  $('run-state').className = cls || 'muted';
}

// ---- files & persistence ---------------------------------------------------------

const isAsm = (p) => /\.(asm|s)$/i.test(p);
function languageFor(p) {
  if (isAsm(p)) return 'lc3';
  if (/\.md$/.test(p)) return 'markdown';
  return 'plaintext';
}

function currentFiles() {
  const out = {};
  for (const [p, m] of models) out[p] = m.getValue();
  return out;
}

let saveTimer = null;
function scheduleSave() {
  $('save-state').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
function save() {
  try {
    const bps = Object.fromEntries([...breakpoints].map(([p, s]) => [p, [...s]]));
    localStorage.setItem(STORE_KEY, JSON.stringify({ files: currentFiles(), active, breakpoints: bps, savedAt: Date.now() }));
    $('save-state').textContent = 'Saved';
  } catch {
    $('save-state').textContent = 'Not saved (browser storage unavailable)';
  }
}
function loadSaved() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
}

function addModel(p, text) {
  const model = monaco.editor.createModel(text, languageFor(p), monaco.Uri.file('/' + p));
  model.onDidChangeContent(() => { scheduleSave(); refreshDecorations(); });
  models.set(p, model);
}

function sortedPaths() {
  return [...models.keys()].sort((a, b) => {
    const rank = (p) => (/^readme/i.test(p) ? 0 : p === exam.main ? 1 : isAsm(p) ? 2 : 3);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
}

function renderFiles() {
  const ul = $('file-list');
  ul.replaceChildren();
  for (const p of sortedPaths()) {
    const li = document.createElement('li');
    li.className = p === active ? 'active' : '';
    const name = document.createElement('span');
    name.textContent = p;
    name.className = 'fname ' + (isAsm(p) ? 'asm' : '');
    li.appendChild(name);
    li.onclick = () => openFile(p);
    if (!/^readme/i.test(p)) {
      const del = document.createElement('button');
      del.className = 'icon del';
      del.title = `Delete ${p}`;
      del.textContent = '×';
      del.onclick = (e) => { e.stopPropagation(); confirmDialog(`Delete ${p}?`, 'This cannot be undone.', 'Delete', () => deleteFile(p)); };
      li.appendChild(del);
    }
    ul.appendChild(li);
  }
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.replaceChildren();
  for (const p of openTabs) {
    const t = document.createElement('div');
    t.className = 'tab' + (p === active ? ' active' : '');
    t.textContent = p;
    t.onclick = () => openFile(p);
    const x = document.createElement('span');
    x.className = 'tab-x';
    x.textContent = '×';
    x.onclick = (e) => {
      e.stopPropagation();
      openTabs = openTabs.filter((q) => q !== p);
      if (active === p) openFile(openTabs.at(-1) || sortedPaths()[0]);
      else renderTabs();
    };
    t.appendChild(x);
    tabs.appendChild(t);
  }
}

function openFile(p) {
  if (!models.has(p)) return;
  active = p;
  if (!openTabs.includes(p)) openTabs.push(p);
  editor.setModel(models.get(p));
  renderFiles();
  renderTabs();
  refreshDecorations();
  scheduleSave();
}

function deleteFile(p) {
  models.get(p).dispose();
  models.delete(p);
  breakpoints.delete(p);
  openTabs = openTabs.filter((q) => q !== p);
  if (active === p) openFile(openTabs.at(-1) || sortedPaths()[0]);
  renderFiles();
  renderTabs();
  scheduleSave();
}

$('btn-new').onclick = () => {
  $('new-file-row').hidden = false;
  const input = $('new-file-name');
  input.value = '';
  input.focus();
};
$('new-file-name').onkeydown = (e) => {
  if (e.key === 'Escape') { $('new-file-row').hidden = true; return; }
  if (e.key !== 'Enter') return;
  const name = e.target.value.trim();
  if (!/^[\w.-]+$/.test(name) || name.includes('..')) { e.target.classList.add('bad'); return; }
  e.target.classList.remove('bad');
  $('new-file-row').hidden = true;
  if (!models.has(name)) addModel(name, isAsm(name) ? '        .ORIG x4000\n\n        .END\n' : '');
  openFile(name);
};

$('btn-reset').onclick = () => confirmDialog('Reset to starter code?',
  'All your changes in every file will be lost.', 'Reset', () => {
    stopRun();
    for (const m of models.values()) m.dispose();
    models.clear();
    breakpoints.clear();
    openTabs = [];
    loadFiles(exam.files);
    unload();
    save();
  });

// ---- assemble ------------------------------------------------------------------------

const machine = new Machine({ os: OS });
let programs = [];          // assembled programs, main file first
let lineOf = new Map();     // address -> {file, line}
let addrOf = new Map();     // "file:line" -> address (first word on that line)
let symbolAt = new Map();   // address -> label as written
let loadedVersions = null;  // model versions the machine was loaded from
let loaded = false;

const asmFiles = () => sortedPaths().filter(isAsm).sort((a, b) => (a === mainFile() ? -1 : b === mainFile() ? 1 : 0));
const mainFile = () => (exam.main && models.has(exam.main) ? exam.main : sortedPaths().find(isAsm));
const versions = () => asmFiles().map((p) => `${p}@${models.get(p).getAlternativeVersionId()}`).join(',');

function assembleAll(announce) {
  const out = [];
  let errorCount = 0;
  for (const p of asmFiles()) {
    const model = models.get(p);
    const prog = assemble(model.getValue());
    const markers = prog.errors.map((e) => ({
      startLineNumber: e.line || 1, startColumn: e.col, endLineNumber: e.line || 1, endColumn: e.col + (e.len || 1),
      message: e.message, severity: monaco.MarkerSeverity.Error,
    }));
    monaco.editor.setModelMarkers(model, 'lc3', markers);
    for (const e of prog.errors) {
      errorCount++;
      printLink(`${p}:${e.line}:${e.col}: error: ${e.message}`, 'err', () => {
        openFile(p);
        editor.revealLineInCenter(e.line || 1);
        editor.setPosition({ lineNumber: e.line || 1, column: e.col });
        editor.focus();
      });
    }
    out.push({ path: p, prog });
  }
  if (errorCount) {
    print(`Assembly failed: ${errorCount} error(s).\n`, 'err');
    return null;
  }
  if (!out.length) { print('There is no .asm file to assemble.\n', 'err'); return null; }
  lineOf = new Map(); addrOf = new Map(); symbolAt = new Map();
  for (const { path, prog } of out) {
    for (const r of prog.regions) {
      r.words.forEach((_, i) => {
        const a = (r.orig + i) & 0xffff;
        lineOf.set(a, { file: path, line: r.lines[i] });
        const key = `${path}:${r.lines[i]}`;
        if (!addrOf.has(key)) addrOf.set(key, a);
      });
    }
    for (const [k, a] of Object.entries(prog.symbols)) if (!symbolAt.has(a)) symbolAt.set(a, prog.labels[k]);
  }
  if (announce) {
    const words = out.reduce((t, { prog }) => t + prog.regions.reduce((s, r) => s + r.words.length, 0), 0);
    print(`Assembled ${out.map((o) => o.path).join(', ')}: ${words} words, starting at x${hex4(out[0].prog.entry)}.\n`, 'ok');
  }
  return out.map((o) => o.prog);
}

// Assemble and load the machine, ready to run from the start
function loadProgram(announce = true) {
  stopRun();
  print(`\n$ assemble ${asmFiles().join(' ')}\n`, 'cmd');
  const progs = assembleAll(announce);
  if (!progs) { unload(); return false; }
  programs = progs;
  machine.ignorePrivilege = Boolean(exam.ignorePrivilege);
  machine.reset(programs);
  machine.onOutput = programOutput;
  syncBreakpoints();
  loadedVersions = versions();
  loaded = true;
  warnedPuts = false;
  memFollow = true;
  prevRegs = null;
  setRunState(`Ready at x${hex4(machine.pc)}`);
  updateMachineView(true);
  return true;
}

function unload() {
  loaded = false;
  programs = [];
  lineOf = new Map();
  setRunState('');
  updateMachineView(true);
}

// ---- breakpoints and the current line --------------------------------------------------

const breakpoints = new Map();   // file -> Set(line)
let decos = null;                // editor decorations: breakpoints and the current line

function toggleBreakpoint(file, line) {
  if (!breakpoints.has(file)) breakpoints.set(file, new Set());
  const s = breakpoints.get(file);
  if (s.has(line)) s.delete(line); else s.add(line);
  syncBreakpoints();
  refreshDecorations();
  scheduleSave();
}

// Breakpoints are kept by line; each maps to the first instruction on or after that line
function syncBreakpoints() {
  const addrs = new Set();
  for (const [file, lines] of breakpoints) {
    for (const line of lines) {
      for (let l = line; l < line + 200; l++) {
        const a = addrOf.get(`${file}:${l}`);
        if (a !== undefined) { addrs.add(a); break; }
      }
    }
  }
  machine.breakpoints = addrs;
}

function refreshDecorations() {
  if (!editor || !active) return;
  const model = models.get(active);
  const decs = [];
  for (const line of breakpoints.get(active) || []) {
    if (line <= model.getLineCount()) {
      decs.push({ range: new monaco.Range(line, 1, line, 1), options: { glyphMarginClassName: 'bp-glyph', glyphMarginHoverMessage: { value: 'Breakpoint (click to remove)' } } });
    }
  }
  const here = loaded && !running && !machine.halted ? lineOf.get(machine.pc) : null;
  if (here && here.file === active && here.line <= model.getLineCount()) {
    decs.push({ range: new monaco.Range(here.line, 1, here.line, 1), options: { isWholeLine: true, className: 'pc-line', linesDecorationsClassName: 'pc-glyph' } });
  }
  decos.set(decs);
}

function revealPC() {
  const here = lineOf.get(machine.pc);
  if (!here) return;
  if (here.file !== active) openFile(here.file);
  editor.revealLineInCenterIfOutsideViewport(here.line);
  refreshDecorations();
}

// ---- running --------------------------------------------------------------------------

let running = false;
let runToken = 0;
let warnedPuts = false;

function setButtons() {
  $('btn-stop').disabled = !running;
  for (const id of ['btn-assemble', 'btn-step', 'btn-over', 'btn-out', 'btn-tests']) $(id).disabled = running;
  $('btn-run').textContent = running ? '▶ Running…' : loaded && !machine.halted && machine.steps > 0 ? '▶ Continue' : '▶ Run';
  $('btn-run').disabled = running;
}

// Get a machine that matches the current source: load (or reload) if needed. Returns false on errors.
function ensureLoaded() {
  if (loaded && !machine.halted && loadedVersions === versions()) return true;
  if (loaded && loadedVersions !== versions() && machine.steps > 0) print('\nThe code changed, so the program starts over.\n', 'dim');
  return loadProgram(true);
}

function where(addr) {
  const here = lineOf.get(addr);
  return here ? `${here.file} line ${here.line}` : `x${hex4(addr)}`;
}

// Checks run before each instruction: friendly notes for common mistakes
function beforeStep() {
  if (!machine.user || warnedPuts) return;
  const ir = machine.mem[machine.pc];
  if ((ir === 0xf022 || ir === 0xf024) && machine.reg[0] < 0x3000) {
    warnedPuts = true;
    print(`\n[note] ${ir === 0xf022 ? 'PUTS' : 'PUTSP'} at ${where(machine.pc)} was called with R0 = x${hex4(machine.reg[0])}, ` +
      'which points into the operating system, so it prints whatever is stored there. Did you forget LEA R0, <your string>?\n', 'warn');
  }
}
function afterStep(pcBefore) {
  const what = OS_ADDR[machine.pc];
  if (what && !machine.user) {
    flushOutput();
    print(`\n[note] ${what} at ${where(pcBefore)}${what === 'access violation'
      ? ': user programs may not read, write or jump to x0000-x2FFF (the operating system) or xFE00-xFFFF (device registers)'
      : what === 'privilege violation' ? ': RTI only works in supervisor mode' : ''}.\n`, 'warn');
  }
}
function flushOutput() { if (pendingOut) { print(pendingOut); pendingOut = ''; } }

// stop: () => bool, checked after each instruction (for step over/out)
function startRun(stop = null, label = 'Running…') {
  running = true;
  setButtons();
  setRunState(label);
  const token = ++runToken;
  let first = true;
  const t0 = performance.now();
  const startSteps = machine.steps;
  const slice = () => {
    if (token !== runToken) return;
    const waiting = machine.waitingForInput();
    const budget = waiting ? 2000 : 200000;
    const until = performance.now() + 14;
    let outcome = null;
    for (let i = 0; i < budget; i++) {
      if (!first && machine.breakpoints.has(machine.pc)) { outcome = 'breakpoint'; break; }
      first = false;
      const pc = machine.pc;
      beforeStep();
      if (!machine.step()) { outcome = 'halted'; break; }
      afterStep(pc);
      if (stop && stop()) { outcome = 'stepped'; break; }
      if ((i & 4095) === 4095 && performance.now() > until) break;
    }
    if (outcome) return finishRun(outcome, performance.now() - t0, machine.steps - startSteps);
    if (machine.waitingForInput()) setRunState('Waiting for keyboard input: click the console below and type', 'waiting');
    else setRunState(`Running… ${machine.steps.toLocaleString()} instructions`);
    if (performance.now() - lastView > 250) updateMachineView(false);
    setTimeout(slice, waiting ? 30 : 0);
  };
  slice();
}

let lastView = 0;
function finishRun(outcome, ms, n) {
  running = false;
  runToken++;
  flushOutput();
  if (outcome === 'halted') {
    print(`\n[halted after ${machine.steps.toLocaleString()} instructions]\n`, 'ok');
    setRunState(`Halted after ${machine.steps.toLocaleString()} instructions. Run starts over.`);
  } else if (outcome === 'breakpoint') {
    setRunState(`Breakpoint at ${where(machine.pc)}`);
  } else if (outcome === 'paused') {
    setRunState(`Paused at ${where(machine.pc)}${machine.user ? '' : ' (inside the operating system)'}`);
  } else {
    setRunState(`At ${where(machine.pc)}${machine.user ? '' : ' (inside the operating system)'}`);
  }
  setButtons();
  updateMachineView(true);
  if (outcome !== 'halted') revealPC(); else refreshDecorations();
}

function stopRun() {
  if (!running) return;
  running = false;
  runToken++;
  setButtons();
}

$('btn-assemble').onclick = () => { save(); loadProgram(true); };
$('btn-run').onclick = () => {
  save();
  if (!ensureLoaded()) return;
  if (machine.steps === 0) print(`$ run\n`, 'cmd');
  startRun();
};
$('btn-stop').onclick = () => { if (running) { stopRun(); finishRun('paused'); } };

// Step: one instruction, but a TRAP or interrupt runs to completion
function stepInto() {
  if (!ensureLoaded()) return;
  const depth = machine.calls.length;
  startRun(() => machine.calls.length <= depth || (machine.user && machine.calls.at(-1) === 'sub'), 'Stepping…');
}
function stepOver() {
  if (!ensureLoaded()) return;
  const depth = machine.calls.length;
  startRun(() => machine.calls.length <= depth, 'Stepping…');
}
function stepOut() {
  if (!ensureLoaded()) return;
  const depth = machine.calls.length;
  if (depth === 0) { print('\nNot inside a subroutine; Step out runs to the end.\n', 'dim'); }
  startRun(() => machine.calls.length < depth, 'Running to the end of the subroutine…');
}
$('btn-step').onclick = stepInto;
$('btn-over').onclick = stepOver;
$('btn-out').onclick = stepOut;

// ---- registers and memory --------------------------------------------------------------

let prevRegs = null;
let memBase = 0x3000;
let memFollow = true;

function updateMachineView(full) {
  lastView = performance.now();
  const r = machine.reg;
  const cur = [...r, machine.pc, machine.psr];
  const rows = [];
  const cell = (name, v, i) => {
    const changed = prevRegs && full && prevRegs[i] !== cur[i];
    return `<td class="name">${name}</td><td class="${changed ? 'changed' : ''}">x${hex4(v)}</td><td class="${changed ? 'changed' : ''}">${String((v << 16) >> 16).padStart(6)}</td>`;
  };
  for (let i = 0; i < 8; i += 2) rows.push(`<tr>${cell('R' + i, r[i], i)}</tr><tr>${cell('R' + (i + 1), r[i + 1], i + 1)}</tr>`);
  const mode = machine.user ? 'user' : 'supervisor';
  rows.push(`<tr>${cell('PC', machine.pc, 8)}</tr>`);
  rows.push(`<tr><td class="name">PSR</td><td>x${hex4(machine.psr)}</td><td>CC ${machine.cc}, ${mode}</td></tr>`);
  rows.push(`<tr><td class="name">steps</td><td colspan="2">${machine.steps.toLocaleString()}</td></tr>`);
  if (loaded && machine.halted) {
    rows.push('<tr><td colspan="3" class="note">After HALT the LC-3 is in supervisor mode: R6 is the supervisor stack ' +
      'pointer and HALT changed R0 and R1. To see your values, set a breakpoint before HALT.</td></tr>');
  }
  $('regs').innerHTML = loaded ? rows.join('') : '<tr><td class="name">Assemble or run to see the registers.</td></tr>';
  if (full) prevRegs = cur;

  const mem = $('memory');
  if (!loaded) { mem.replaceChildren(); return; }
  if (memFollow && full) {
    const pc = machine.pc;
    if (pc < memBase || pc >= memBase + 48) memBase = Math.max(0, pc - 8);
  }
  const frag = document.createDocumentFragment();
  for (let a = memBase; a < Math.min(0x10000, memBase + 64); a++) {
    const w = machine.readMemRaw(a);
    const row = document.createElement('div');
    row.className = 'row' + (a === machine.pc ? ' pc' : '') + (machine.breakpoints.has(a) ? ' bp' : '');
    const lbl = symbolAt.get(a) || '';
    row.innerHTML = `<span class="addr">x${hex4(a)}</span><span>x${hex4(w)}</span><span class="lbl"></span><span class="dis"></span>`;
    row.children[2].textContent = lbl;
    row.children[3].textContent = lineOf.has(a) || a < 0x3000 ? disassemble(w, a, (t) => symbolAt.get(t) || null) : '';
    row.title = lineOf.has(a) ? where(a) : '';
    frag.appendChild(row);
  }
  mem.replaceChildren(frag);
}

$('mem-goto').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const v = e.target.value.trim();
  if (!v) { memFollow = true; updateMachineView(true); return; }
  let a = null;
  for (const p of programs) if (v.toLowerCase() in p.symbols) a = p.symbols[v.toLowerCase()];
  if (a === null) {
    const m = v.match(/^(?:x|0x)?([0-9a-f]{1,4})$/i);
    if (m) a = parseInt(m[1], 16);
  }
  if (a === null) { e.target.classList.add('bad'); return; }
  e.target.classList.remove('bad');
  memFollow = false;
  memBase = a;
  updateMachineView(true);
};

// ---- tests -------------------------------------------------------------------------------

$('btn-tests').onclick = () => {
  save();
  const tests = exam.tests || [];
  if (!tests.length) { print('\nThis exam has no sample tests.\n', 'dim'); return; }
  print(`\n$ run tests\n`, 'cmd');
  const progs = assembleAll(false);
  if (!progs) return;
  const results = tests.map((t) => runTest(progs, t, { os: OS, ignorePrivilege: exam.ignorePrivilege, maxSteps: exam.maxSteps || 100000 }));
  const passed = results.filter((r) => r.passed).length;
  print(`${passed} of ${results.length} sample tests passed.\n`, passed === results.length ? 'ok' : 'warn');
  const body = document.createElement('div');
  body.innerHTML = `<p>${passed} of ${results.length} sample tests passed. Your instructor grades with more tests than these.</p>`;
  const table = document.createElement('table');
  table.className = 'tests';
  table.innerHTML = '<tr><th>Test</th><th>Result</th><th>Details</th></tr>';
  for (const r of results) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td></td><td class="${r.passed ? 'ok' : 'err'}">${r.passed ? 'pass' : 'FAIL'}</td><td class="detail"></td>`;
    tr.children[0].textContent = r.name;
    tr.children[2].textContent = r.passed ? '' : r.details.join('\n');
    table.appendChild(tr);
  }
  body.appendChild(table);
  openModal('Sample tests', body, [['Close', 'primary', () => true]]);
};

// ---- submit ------------------------------------------------------------------------

function submissionText() {
  const files = currentFiles();
  return sortedPaths()
    .filter((p) => !/^readme/i.test(p))
    .map((p) => `===== ${p} =====\n${files[p].replace(/\s+$/, '')}\n`)
    .join('\n');
}

// Copy to the clipboard; falls back to selecting the text box (which must be on the page)
async function copyToClipboard(text, ta) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  ta.focus();
  ta.select();
  try { return document.execCommand('copy'); } catch { return false; }
}

$('btn-copy').onclick = async () => {
  save();
  const text = submissionText();
  const body = document.createElement('div');
  const msg = document.createElement('div');
  body.appendChild(msg);
  const ta = document.createElement('textarea');
  ta.className = 'submission';
  ta.readOnly = true;
  ta.value = text;
  body.appendChild(ta);
  const status = document.createElement('p');
  status.className = 'small';
  body.appendChild(status);
  const showResult = (ok) => {
    msg.innerHTML = ok ? `
      <p><strong>Your code is copied.</strong> Switch to the <strong>quiz tab</strong>, click in the answer box,
      and paste (Ctrl+V or ⌘V). Check that all your code appears, then submit the quiz.</p>
      <p class="muted small">This is what was copied:</p>` : `
      <p><strong>Copying was blocked.</strong> Click in the box below, select all (Ctrl+A or ⌘A), copy (Ctrl+C or ⌘C),
      then paste it into the answer box in the <strong>quiz tab</strong>.</p>`;
  };
  openModal('Paste your code into the quiz', body, [
    ['Copy again', '', async () => { showResult(await copyToClipboard(text, ta)); return false; }],
    ['Close', 'primary', () => true],
  ]);
  showResult(await copyToClipboard(text, ta));
};

// ---- modal -------------------------------------------------------------------------

function openModal(title, bodyNode, actions) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(bodyNode);
  const bar = $('modal-actions');
  bar.replaceChildren();
  for (const [label, cls, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = async () => { if ((await fn()) !== false) closeModal(); };
    bar.appendChild(b);
  }
  $('modal').hidden = false;
}
function closeModal() { $('modal').hidden = true; editor && editor.focus(); }
function confirmDialog(title, text, okLabel, onOk) {
  const p = document.createElement('p');
  p.textContent = text;
  openModal(title, p, [[okLabel, 'danger', () => { onOk(); return true; }], ['Cancel', '', () => true]]);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });

// ---- panel resizer -----------------------------------------------------------------

(function resizer() {
  const panel = $('panel');
  const area = $('editor-area');
  let startY = 0, startH = 0;
  $('resizer').onpointerdown = (e) => {
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    $('resizer').setPointerCapture(e.pointerId);
    $('resizer').onpointermove = (ev) => {
      const h = Math.min(area.clientHeight - 120, Math.max(80, startH + startY - ev.clientY));
      panel.style.flexBasis = `${h}px`;
      editor && editor.layout();
    };
  };
  $('resizer').onpointerup = (e) => { $('resizer').onpointermove = null; $('resizer').releasePointerCapture(e.pointerId); };
})();

// ---- editor language --------------------------------------------------------------------

function registerLanguage() {
  monaco.languages.register({ id: 'lc3', extensions: ['.asm'] });
  monaco.languages.setLanguageConfiguration('lc3', { comments: { lineComment: ';' } });
  monaco.languages.setMonarchTokensProvider('lc3', {
    ignoreCase: true,
    opcodes: MNEMONICS,
    tokenizer: {
      root: [
        [/;.*$/, 'comment'],
        [/"([^"\\]|\\.)*"?/, 'string'],
        [/\.[a-zA-Z]+/, 'keyword.directive'],
        [/\b[rR][0-7]\b/, 'variable.register'],
        [/#-?\d+\b|\b[xX]-?[0-9a-fA-F]+\b|\b[bB]-?[01]+\b|\b\d+\b/, 'number'],
        [/[a-zA-Z_][\w]*/, { cases: { '@opcodes': 'keyword', '@default': 'identifier' } }],
      ],
    },
  });
  monaco.editor.defineTheme('lc3-dark', {
    base: 'vs-dark', inherit: true, colors: {},
    rules: [
      { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
      { token: 'keyword.directive', foreground: 'c586c0' },
      { token: 'variable.register', foreground: '9cdcfe' },
      { token: 'identifier', foreground: 'dcdcaa' },
      { token: 'number', foreground: 'b5cea8' },
    ],
  });
}

// ---- startup -----------------------------------------------------------------------

function loadFiles(files, activeHint) {
  for (const [p, text] of Object.entries(files)) addModel(p, text);
  const paths = sortedPaths();
  const first = (activeHint && models.has(activeHint) && activeHint) || paths.find((p) => /^readme/i.test(p)) || paths[0];
  openTabs = [];
  if (first) openFile(first);
  const main = mainFile();
  if (main && !openTabs.includes(main)) { openTabs.push(main); renderTabs(); }
}

function fail(title, text) {
  document.body.innerHTML = `<div class="fatal"><h1></h1><p></p></div>`;
  document.querySelector('.fatal h1').textContent = title;
  document.querySelector('.fatal p').textContent = text;
}

async function start() {
  if (!examId) return fail('No exam selected', 'Open this page from the link in your Canvas quiz.');
  try {
    const res = await fetch(`exams/${examId}.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    exam = await res.json();
  } catch {
    return fail('Exam not found', 'Check the link in your Canvas quiz, or ask your instructor.');
  }
  document.title = exam.title;
  $('exam-title').textContent = exam.title;
  $('btn-tests').hidden = !(exam.tests && exam.tests.length);

  self.MonacoEnvironment = { getWorkerUrl: () => new URL('monaco-worker.js', location.href).href };
  window.require.config({ paths: { vs: 'vendor/monaco/vs' } });
  monaco = await new Promise((resolve) => window.require(['vs/editor/editor.main'], () => resolve(window.monaco)));
  registerLanguage();

  editor = monaco.editor.create($('editor'), {
    theme: 'lc3-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    tabSize: 8,
    insertSpaces: true,
    glyphMargin: true,
    renderWhitespace: 'selection',
    scrollBeyondLastLine: false,
    // No AI or network features exist here; keep suggestions to words in the open files
    quickSuggestions: { other: true, comments: false, strings: false },
    wordBasedSuggestions: 'currentDocument',
  });
  decos = editor.createDecorationsCollection();
  editor.onMouseDown((e) => {
    const t = e.target.type;
    if (t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || t === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) {
      if (active && isAsm(active) && e.target.position) toggleBreakpoint(active, e.target.position.lineNumber);
    }
  });
  const K = monaco.KeyCode, M = monaco.KeyMod;
  editor.addCommand(M.CtrlCmd | K.Enter, () => $('btn-run').click());
  editor.addCommand(M.CtrlCmd | K.KeyB, () => $('btn-assemble').click());
  editor.addCommand(M.CtrlCmd | K.KeyS, save);
  editor.addCommand(K.F10, () => !running && stepOver());
  editor.addCommand(K.F11, () => !running && stepInto());
  editor.addCommand(M.Shift | K.F11, () => !running && stepOut());
  editor.addCommand(K.F9, () => { const p = editor.getPosition(); if (p && isAsm(active)) toggleBreakpoint(active, p.lineNumber); });

  const saved = loadSaved();
  if (saved && saved.breakpoints) for (const [p, lines] of Object.entries(saved.breakpoints)) breakpoints.set(p, new Set(lines));
  loadFiles(saved && saved.files ? saved.files : exam.files, saved && saved.active);
  if (saved) print(`Restored your work from ${new Date(saved.savedAt).toLocaleString()}.\n`, 'dim');
  print('Assemble with Ctrl+B, run with Ctrl+Enter. Click left of a line number to set a breakpoint.\n' +
    'When the program reads the keyboard (GETC, IN), click here and type.\n', 'dim');
  setButtons();
  updateMachineView(true);
}

// Don't lose the last half-second of typing if the page closes or the lockdown browser restarts
addEventListener('pagehide', () => editor && save());
document.addEventListener('visibilitychange', () => { if (document.hidden && editor) save(); });

document.addEventListener('keydown', (e) => {
  // Keep the browser's own Save/Print dialogs out of the way
  if ((e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key)) e.preventDefault();
  if (e.key === 'F10' || e.key === 'F11') e.preventDefault();
});

start();
