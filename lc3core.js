// LC-3 assembler, simulator and disassembler for the exam IDE (browser) and the tests (Node).
//
// Follows the rules of lc3tools, the simulator for Patt & Patel's 3rd edition, so a program
// assembles and runs here exactly as it does there:
//   - TRAP saves PSR and PC on the supervisor stack and does not touch R7; RTI returns.
//   - LEA does not set the condition codes.
//   - User-mode code that touches x0000-x2FFF or xFE00-xFFFF raises an access violation.
//   - Assembler syntax, number formats, error checks and encodings match lc3tools' assembler.
// lc3ide/grader/lc3.py is a line-for-line Python twin; keep the two in step.

// ---------------------------------------------------------------------------------------
// Tokenizer (lc3tools rules: ',' ':' space and tab separate tokens; ';' starts a comment
// unless inside double quotes; numbers are b/x/# or plain decimal, with an optional '-')
// ---------------------------------------------------------------------------------------

const DELIMS = ',: \t';
const INT32_MAX = 2147483647;

function toNum(s) {
  let i = 0, base = 10;
  const c = s[0];
  if (c === 'b' || c === 'B') { base = 2; i = 1; }
  else if (c === 'x' || c === 'X') { base = 16; i = 1; }
  else if (c === '#') { base = 10; i = 1; }
  let neg = false;
  if (s[i] === '-') { neg = true; i++; }
  const digits = s.slice(i);
  const re = base === 16 ? /^[0-9a-fA-F]+$/ : base === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!re.test(digits)) return null;          // also rejects "" (std::stoi would throw)
  const v = parseInt(digits, base);
  if (v > INT32_MAX) return null;             // std::stoi out_of_range -> not a number
  return neg ? -v : v;
}

// One source line -> tokens [{type:'num'|'str', num, str, col, len}] (col is 0-based)
export function tokenizeLine(raw) {
  let inStr = false, cut = raw.length;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '"') inStr = !inStr;       // note: an escaped \" also toggles, as in lc3tools
    if (raw[i] === ';' && !inStr) { cut = i; break; }
  }
  const line = raw.slice(0, cut).replace(/[ \t]+$/, '');
  const tokens = [];
  let col = 0;
  while (true) {
    while (col < line.length && DELIMS.includes(line[col])) col++;
    if (col >= line.length) break;
    let len = 0, quoted = false;
    if (line[col] === '"' && (col === 0 || line[col - 1] !== '\\')) {
      col++;
      while (col + len < line.length && !(line[col + len] === '"' && line[col + len - 1] !== '\\')) len++;
      quoted = true;
    } else {
      while (col + len < line.length && !DELIMS.includes(line[col + len])) len++;
    }
    const text = line.substr(col, len);
    const num = quoted ? null : toNum(text);
    tokens.push(num === null ? { type: 'str', str: text, col, len } : { type: 'num', num, str: text, col, len });
    col += len + 1;
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------
// Instruction set: operand patterns as lc3tools defines them
//   r = register, n = number (imm/offset), l = label or number (PC offset)
// ---------------------------------------------------------------------------------------

const INSTS = [];
function inst(name, ops, encode) { INSTS.push({ name, ops, encode }); }
const R = (v, at) => (v & 7) << at;
inst('add', 'rrr', (o) => 0x1000 | R(o[0], 9) | R(o[1], 6) | R(o[2], 0));
inst('add', 'rrn', (o) => 0x1020 | R(o[0], 9) | R(o[1], 6) | (o[2] & 0x1f));
inst('and', 'rrr', (o) => 0x5000 | R(o[0], 9) | R(o[1], 6) | R(o[2], 0));
inst('and', 'rrn', (o) => 0x5020 | R(o[0], 9) | R(o[1], 6) | (o[2] & 0x1f));
for (const [cc, bits] of [['', 7], ['n', 4], ['z', 2], ['p', 1], ['nz', 6], ['zp', 3], ['np', 5], ['nzp', 7]]) {
  inst('br' + cc, 'l', (o) => (bits << 9) | (o[0] & 0x1ff));
}
inst('nop', '', () => 0x0000);
inst('nop', 'l', (o) => o[0] & 0x1ff);
inst('jmp', 'r', (o) => 0xc000 | R(o[0], 6));
inst('jsr', 'l', (o) => 0x4800 | (o[0] & 0x7ff));
inst('jsrr', 'r', (o) => 0x4000 | R(o[0], 6));
inst('ld', 'rl', (o) => 0x2000 | R(o[0], 9) | (o[1] & 0x1ff));
inst('ldi', 'rl', (o) => 0xa000 | R(o[0], 9) | (o[1] & 0x1ff));
inst('ldr', 'rrn', (o) => 0x6000 | R(o[0], 9) | R(o[1], 6) | (o[2] & 0x3f));
inst('lea', 'rl', (o) => 0xe000 | R(o[0], 9) | (o[1] & 0x1ff));
inst('not', 'rr', (o) => 0x903f | R(o[0], 9) | R(o[1], 6));
inst('ret', '', () => 0xc1c0);
inst('rti', '', () => 0x8000);
inst('st', 'rl', (o) => 0x3000 | R(o[0], 9) | (o[1] & 0x1ff));
inst('sti', 'rl', (o) => 0xb000 | R(o[0], 9) | (o[1] & 0x1ff));
inst('str', 'rrn', (o) => 0x7000 | R(o[0], 9) | R(o[1], 6) | (o[2] & 0x3f));
inst('trap', 'n', (o) => 0xf000 | (o[0] & 0xff));
for (const [n, v] of [['getc', 0x20], ['out', 0x21], ['putc', 0x21], ['puts', 0x22], ['in', 0x23], ['putsp', 0x24], ['halt', 0x25]]) {
  inst(n, '', () => 0xf000 | v);
}
// Field width and signedness for each 'n'/'l' operand, by instruction name and position
const FIELD = {
  add: [null, null, [5, true]], and: [null, null, [5, true]],
  ldr: [null, null, [6, true]], str: [null, null, [6, true]], trap: [[8, false]],
  jsr: [[11, true]], ld: [null, [9, true]], ldi: [null, [9, true]], lea: [null, [9, true]],
  st: [null, [9, true]], sti: [null, [9, true]],
};
const fieldOf = (name, i) => (FIELD[name] && FIELD[name][i]) || [9, true]; // br*, nop: 9-bit offset
const INST_NAMES = [...new Set(INSTS.map((i) => i.name))];
export const MNEMONICS = INST_NAMES;
const REGS = new Set(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
const isReg = (s) => REGS.has(s.toLowerCase());

function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
const nearestInstDist = (s) => Math.min(...INST_NAMES.map((n) => lev(n, s.toLowerCase())));

// ---------------------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------------------

// Same statement classification as lc3tools' buildStatement (label / instruction / pseudo-op)
function buildStatement(tokens, row, text) {
  const st = { row, text, label: null, base: null, operands: [], pc: 0, valid: true };
  if (!tokens.length) return st;
  const t0 = tokens[0], t1 = tokens[1];
  const isPseudo = (t) => t && t.type === 'str' && t.str.startsWith('.');
  let start = 1;
  const asLabel = (t) => ({ ...t, kind: t.type === 'num' ? 'num' : 'label' });
  if (t0.type === 'str') {
    if (isPseudo(t0)) {
      st.base = { ...t0, kind: 'pseudo' };
    } else {
      const d = nearestInstDist(t0.str);
      if (d === 0) {
        if (isPseudo(t1)) { st.label = asLabel(t0); st.base = { ...t1, kind: 'pseudo' }; start = 2; }
        else st.base = { ...t0, kind: 'inst' };
      } else if (tokens.length > 1) {
        if (t1.type === 'str') {
          if (isPseudo(t1)) { st.label = asLabel(t0); st.base = { ...t1, kind: 'pseudo' }; start = 2; }
          else if (isReg(t1.str)) {
            if (d < 2) st.base = { ...t0, kind: 'inst' }; else st.label = asLabel(t0);
          } else {
            const d1 = nearestInstDist(t1.str);
            if (d1 < d) {
              st.label = asLabel(t0);
              if (d1 < 2) { st.base = { ...t1, kind: 'inst' }; start = 2; }
            } else if (d < 2) st.base = { ...t0, kind: 'inst' };
            else st.label = asLabel(t0);
          }
        } else if (d < 2) st.base = { ...t0, kind: 'inst' };
        else st.label = asLabel(t0);
      } else {
        st.label = asLabel(t0);
      }
    }
  } else {
    st.label = asLabel(t0);
  }
  for (const t of tokens.slice(start)) {
    st.operands.push({ ...t, kind: t.type === 'num' ? 'num' : isReg(t.str) ? 'reg' : 'str' });
  }
  return st;
}

class AsmError extends Error {}

// UTF-8 bytes of a string; lc3tools works on bytes and stores chars >= 0x80 sign-extended
function bytesOf(s) { return [...new TextEncoder().encode(s)]; }

function unescape(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      const m = { '\\': '\\', n: '\n', r: '\r', t: '\t', '"': '"' }[s[i + 1]];
      if (m !== undefined) { out += m; i++; } else out += '\\';
    } else out += s[i];
  }
  return out;
}

// Assemble LC-3 source. Returns
//   { ok, errors: [{line, col, len, message}], regions: [{orig, words: [], lines: []}],
//     symbols: {lowercase label: address}, labels: {lowercase: as written}, entry }
// line and col in errors are 1-based; lines[] gives the source line (1-based) of each word.
export function assemble(source) {
  const errors = [];
  const err = (st, piece, message) => errors.push({
    line: st ? st.row + 1 : 0, col: piece ? piece.col + 1 : 1, len: piece ? Math.max(1, piece.len) : 0, message,
  });
  const fail = (st, piece, message) => { err(st, piece, message); throw new AsmError(message); };

  const lines = source.split(/\r\n|\r|\n/);
  const statements = [];
  lines.forEach((text, row) => {
    const tokens = tokenizeLine(text);
    if (tokens.length) statements.push(buildStatement(tokens, row, text));
  });
  const lower = (p) => p.str.toLowerCase();
  const pseudoName = (st) => (st.base && st.base.kind === 'pseudo' ? lower(st.base) : null);
  const getNum = (st, piece, width, sext, log = true) => {
    const v = piece.num;
    if (sext) {
      if (v < -(1 << (width - 1)) || v > (1 << (width - 1)) - 1) {
        if (log) err(st, piece, `cannot encode as ${width}-bit 2's complement number`);
        return null;
      }
    } else if ((v >>> 0) > 2 ** width - 1) {     // negative numbers compare as huge unsigned
      if (log) err(st, piece, `cannot encode as ${width}-bit unsigned number`);
      return null;
    }
    return v & ((1 << width) - 1);
  };
  const operandsOk = (st, name, types, count, log) => {
    const ops = st.operands;
    if (ops.length < count) { if (log) err(st, null, `${name} requires ${count - ops.length} more operand(s)`); return false; }
    if (ops.length > count) { if (log) for (const o of ops.slice(count)) err(st, o, `extraneous operand to ${name}`); return false; }
    let ok = true;
    for (const o of ops) {
      if (!types.includes(o.kind)) {
        ok = false;
        if (log) err(st, o, 'operand should be ' + types.map((t) => (t === 'num' ? 'numeric' : 'a string')).join(' or'));
      }
    }
    return ok;
  };
  const validOrig = (st, log = false) => pseudoName(st) === '.orig' && operandsOk(st, '.orig', ['num'], 1, log)
    && getNum(st, st.operands[0], 16, false, log) !== null;
  const validEnd = (st, log = false) => pseudoName(st) === '.end' && operandsOk(st, '.end', [], 0, log);
  const validBlock = (st, log = false) => {
    if (pseudoName(st) !== '.blkw' || !operandsOk(st, '.blkw', ['num'], 1, false)) return false;
    if (getNum(st, st.operands[0], 16, false, log) === null) return false;
    if (st.operands[0].num === 0) { if (log) err(st, st.operands[0], 'operand to .blkw must be > 0'); return false; }
    return true;
  };
  const validString = (st, log = false) => pseudoName(st) === '.stringz' && operandsOk(st, '.stringz', ['str'], 1, log);
  const stringValue = (st) => bytesOf(unescape(st.operands[0].str));

  try {
    // Pass 0: addresses
    let foundOrig = false, regionEnded = false, pc = 0;
    for (const st of statements) {
      if (st.base && st.base.kind === 'pseudo') {
        if (validOrig(st)) {
          if (foundOrig && !regionEnded) fail(st, st.base, 'new .orig found, but previous region did not have .end');
          regionEnded = false;
          foundOrig = true;
          pc = st.operands[0].num;
          st.pc = 0;
          continue;
        } else if (validEnd(st)) {
          if (!foundOrig) st.valid = false;
          regionEnded = true;
          st.pc = 0;
          continue;
        }
      }
      if (st.label && !st.base) {
        if (!foundOrig) st.valid = false;
        st.pc = pc;
        continue;
      }
      if (foundOrig) {
        if (pc >= 0xfe00) fail(st, null, 'cannot write code into memory-mapped I/O region');
        if (regionEnded) { st.valid = false; continue; }
        st.pc = pc;
        pc++;
      } else {
        st.valid = false;
      }
      if (validBlock(st)) pc += st.operands[0].num - 1;
      else if (validString(st)) pc += stringValue(st).length;
    }
    if (!foundOrig) fail(null, null, 'could not find valid .orig');
    if (!regionEnded) fail(null, null, 'no .end at end of file');
  } catch (e) {
    if (e instanceof AsmError) return { ok: false, errors, regions: [], symbols: {}, labels: {}, entry: 0 };
    throw e;
  }

  // Pass 1: symbol table
  const symbols = {}, labels = {};
  for (const st of statements) {
    if (!st.label) continue;
    if (st.label.kind === 'num') { err(st, st.label, 'label cannot be a numeric value'); continue; }
    if (!st.base && st.operands.length) {
      for (const o of st.operands) err(st, o, 'illegal operand to a label');
      continue;
    }
    const key = lower(st.label);
    if (key in symbols) {
      err(st, st.label, `attempting to redefine label '${st.label.str}' from x${hex4(symbols[key])} to x${hex4(st.pc)}`);
      continue;
    }
    if (/^[0-9]/.test(st.label.str)) { err(st, st.label, 'label cannot begin with number'); continue; }
    if (nearestInstDist(st.label.str) === 0) { err(st, st.label, 'label cannot be an instruction'); continue; }
    if (isReg(st.label.str)) { err(st, st.label, 'label cannot be a register'); continue; }
    symbols[key] = st.pc;
    labels[key] = st.label.str;
  }

  // Pass 2: machine code
  const regions = [];
  let cur = null;
  const emit = (value, row) => { cur.words.push(value & 0xffff); cur.lines.push(row + 1); };
  for (const st of statements) {
    if (!st.valid) { err(st, null, 'cannot determine address for statement'); continue; }
    if (!st.base) continue;
    if (st.base.kind === 'pseudo') {
      const name = lower(st.base);
      if (name === '.orig') {
        if (validOrig(st, true)) { cur = { orig: st.operands[0].num, words: [], lines: [] }; regions.push(cur); }
      } else if (name === '.fill') {
        if (!operandsOk(st, '.fill', ['num', 'str'], 1, true)) continue;
        const o = st.operands[0];
        if (o.kind === 'num') {
          const v = getNum(st, o, 16, o.num < 0);
          if (v !== null && cur) emit(v, st.row);
        } else if (!(lower(o) in symbols)) err(st, o, 'could not find label');
        else if (cur) emit(symbols[lower(o)], st.row);
      } else if (name === '.blkw') {
        if (validBlock(st, true) && cur) for (let i = 0; i < st.operands[0].num; i++) emit(0, st.row);
        else if (pseudoName(st) === '.blkw' && !operandsOk(st, '.blkw', ['num'], 1, false)) err(st, st.base, 'invalid usage of .blkw');
      } else if (name === '.stringz') {
        if (validString(st, true) && cur) {
          for (const b of stringValue(st)) emit(b >= 0x80 ? 0xff00 | b : b, st.row);
          emit(0, st.row);
        }
      } else if (name === '.end') {
        validEnd(st, true);
      } else {
        err(st, st.base, 'invalid pseudo-op');
      }
      continue;
    }
    // Instruction: pick the candidate with the closest name and operand pattern, as lc3tools does
    const opStr = st.operands.map((o) => (o.kind === 'num' ? 'n' : o.kind === 'reg' ? 'r' : 's')).join('');
    const name = lower(st.base);
    const cands = [];
    for (const c of INSTS) {
      const nd = lev(name, c.name);
      if (nd >= 2) continue;
      const od = c.ops.includes('l')
        ? Math.min(lev(opStr, c.ops.replace(/l/g, 's')), lev(opStr, c.ops.replace(/l/g, 'n')))
        : lev(opStr, c.ops);
      cands.push({ c, nd, od });
    }
    cands.sort((a, b) => a.nd + a.od - (b.nd + b.od));
    if (!cands.length || cands[0].nd !== 0) {
      const sugg = [...new Set(cands.map((x) => x.c.name))].slice(0, 3);
      err(st, st.base, `invalid instruction '${st.base.str}'` + (sugg.length ? ` (did you mean ${sugg.map((s) => s.toUpperCase()).join(', ')}?)` : ''));
      continue;
    }
    if (cands[0].od !== 0) {
      const forms = cands.filter((x) => x.c.name === name).map((x) => formatOf(x.c));
      err(st, st.base, `invalid usage of '${st.base.str}' instruction` + (forms.length ? ` (expected: ${forms.join(' or ')})` : ''));
      continue;
    }
    const pattern = cands[0].c;
    const vals = [];
    let bad = false;
    pattern.ops.split('').forEach((kind, i) => {
      const o = st.operands[i];
      if (kind === 'r') { vals.push(+o.str.slice(1)); return; }
      const [width, sext] = fieldOf(pattern.name.replace(/^br.*/, 'br'), i);
      if (kind === 'n' || o.kind === 'num') {
        const v = getNum(st, o, width, kind === 'n' ? sext : true);
        if (v === null) bad = true; else vals.push(v);
      } else {
        if (!(lower(o) in symbols)) { err(st, o, 'could not find label'); bad = true; return; }
        const v = getNum(st, { ...o, num: symbols[lower(o)] - (st.pc + 1) }, width, true);
        if (v === null) bad = true; else vals.push(v);
      }
    });
    if (!bad && cur) emit(pattern.encode(vals), st.row);
  }

  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  const ok = errors.length === 0;
  return { ok, errors, regions: ok ? regions : [], symbols, labels, entry: regions.length ? regions[0].orig : 0x3000 };
}

function formatOf(c) {
  const names = { r: 'reg', n: 'imm', l: 'label' };
  return (c.name.toUpperCase() + ' ' + c.ops.split('').map((k) => names[k]).join(', ')).trim();
}

// A number in assembler syntax (x1F, #-5, b101, 12); null if it isn't one
export function parseNumber(s) { return toNum(s); }

export const HALT_MESSAGE = '\n\n--- Halting the LC-3 ---\n\n';

// Assemble the OS source; it must assemble cleanly
export function assembleOS(source) {
  const os = assemble(source);
  if (!os.ok) throw new Error('OS failed to assemble: ' + os.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; '));
  return os;
}

export const hex4 = (v) => (v & 0xffff).toString(16).toUpperCase().padStart(4, '0');

// ---------------------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------------------

export const KBSR = 0xfe00, KBDR = 0xfe02, DSR = 0xfe04, DDR = 0xfe06, PSR_ADDR = 0xfffc, MCR = 0xfffe;
const sext = (v, bits) => ((v & (1 << (bits - 1))) ? (v | (-1 << bits)) : (v & ((1 << bits) - 1))) & 0xffff;

class Exception { constructor(vector) { this.vector = vector; } }

export class Machine {
  // os: assembled OS ({regions}) loaded into low memory on every reset
  constructor({ os, ignorePrivilege = false } = {}) {
    this.os = os;
    this.ignorePrivilege = ignorePrivilege;
    this.mem = new Uint16Array(0x10000);
    this.reg = new Uint16Array(8);
    this.onOutput = null;      // (text) => void
    this.breakpoints = new Set();
    this.reset(null);
  }

  // Load the OS and a program (or programs) and set up the start state as lc3tools does
  reset(program) {
    const programs = !program ? [] : Array.isArray(program) ? program : [program];
    this.mem.fill(0);
    this.reg.fill(0);
    if (this.os) this.load(this.os);
    for (const p of programs) this.load(p);
    this.pc = programs.length ? programs[0].entry : 0x0200;
    this.psr = 0; this.ssp = 0; this.mcr = 0x8000;   // clock running
    if (this.pc >= 0x3000 && this.pc <= 0xfdff) {
      this.psr = 0x8002;              // user mode, Z
      this.reg[6] = this.ssp;          // R6 <- saved SSP (0 on first start)
      this.ssp = 0x3000;
    } else {
      this.psr = 0x0002;
      this.ssp = this.reg[6];
      this.reg[6] = 0x3000;
    }
    this.kbStatus = 0; this.kbData = 0; this.kbBuffer = []; this.input = [];
    this.dsr = 0;
    this.interrupts = [];
    this.calls = [];                  // 'sub' | 'trap' | 'int' frames, for step over/out
    this.steps = 0;
    this.output = '';
    this.halted = false;
    this.lastKbPollEmpty = false;
  }

  load(p) {
    for (const r of p.regions) r.words.forEach((w, i) => { this.mem[(r.orig + i) & 0xffff] = w; });
  }

  addInput(text) {
    for (const b of bytesOf(text)) this.input.push(b >= 0x80 ? 0xff00 | b : b);
    this.lastKbPollEmpty = false;
  }
  waitingForInput() { return this.lastKbPollEmpty && this.input.length === 0 && this.kbBuffer.length === 0; }

  get user() { return (this.psr & 0x8000) !== 0; }
  get cc() { return this.psr & 4 ? 'N' : this.psr & 2 ? 'Z' : this.psr & 1 ? 'P' : '-'; }
  acv(addr) { return !this.ignorePrivilege && this.user && (addr <= 0x2fff || addr >= 0xfe00); }

  readMem(addr) {
    if (addr < 0xfe00) return this.mem[addr];
    switch (addr) {
      case KBSR: this.lastKbPollEmpty = !(this.kbStatus & 0x8000); return this.kbStatus;
      case KBDR:
        if (this.kbStatus & 0x8000) {
          const v = this.kbData;
          this.kbStatus &= 0x7fff;
          this.kbBuffer.shift();
          return v;
        }
        return this.kbData;
      case DSR: return this.dsr;
      case PSR_ADDR: return this.psr;
      case MCR: return this.mcr;
      default: return 0;
    }
  }

  writeMem(addr, value) {
    if (addr < 0xfe00) { this.mem[addr] = value; return; }
    switch (addr) {
      case KBSR: this.kbStatus = value & 0x4000; break;
      case DSR: this.dsr = value & 0x4000; break;
      case DDR: {
        this.dsr &= 0x7fff;
        const c = value & 0xff;
        const text = c === 10 || c === 13 ? '\n' : String.fromCharCode(c);
        this.output += text;
        if (this.onOutput) this.onOutput(text);
        break;
      }
      case PSR_ADDR: this.psr = value; break;
      case MCR: this.mcr = value; break;
      default: break;
    }
  }

  // Data access with the access-violation check
  load16(addr) { if (this.acv(addr)) throw new Exception(0x02); return this.readMem(addr); }
  store16(addr, v) { if (this.acv(addr)) throw new Exception(0x02); this.writeMem(addr, v); }

  setCC(v) { this.psr = (this.psr & 0xfff8) | (v & 0x8000 ? 4 : v === 0 ? 2 : 1); }

  // Enter supervisor mode through a vector table (TRAP, interrupt, exception)
  enter(table, vector, priority, kind) {
    if (this.psr & 0x8000) { const t = this.reg[6]; this.reg[6] = this.ssp; this.ssp = t; }
    this.reg[6] = (this.reg[6] - 1) & 0xffff;
    const old = this.psr;
    this.psr = ((old & 0xf1ff) + ((priority & 7) << 8)) & 0xffff;   // lc3tools' exact arithmetic
    if (this.psr & 0x8000) this.psr &= 0x7fff;
    this.writeMem(this.reg[6], old);
    this.reg[6] = (this.reg[6] - 1) & 0xffff;
    this.writeMem(this.reg[6], this.pc);
    this.pc = this.readMem((table + vector) & 0xffff);
    this.calls.push(kind);
  }

  tickDevices() {
    if (this.input.length) this.kbBuffer.push({ value: this.input.shift(), fired: false });
    if (this.kbBuffer.length) {
      this.kbStatus |= 0x8000;
      this.kbData = this.kbBuffer[0].value & 0xffff;
      if (!this.kbBuffer[0].fired && (this.kbStatus & 0x4000)) {
        this.kbBuffer[0].fired = true;
        this.interrupts.push(0x80);
      }
    }
    this.dsr |= 0x8000;
    if (this.interrupts.length && 4 > ((this.psr >> 8) & 7)) {
      this.interrupts.shift();
      this.enter(0x0100, 0x80, 4, 'int');
    }
  }

  // One instruction cycle. Returns false once the machine has halted.
  step() {
    this.tickDevices();
    const pri = (this.psr >> 8) & 7;
    if (this.acv(this.pc)) {
      this.enter(0x0100, 0x02, pri, 'int');
    } else {
      const ir = this.readMemRaw(this.pc);
      this.pc = (this.pc + 1) & 0xffff;
      try {
        this.execute(ir);
      } catch (e) {
        if (!(e instanceof Exception)) throw e;
        this.pc = (this.pc - 1) & 0xffff;
        this.enter(0x0100, e.vector, pri, 'int');
      }
    }
    this.steps++;
    if (!(this.mcr & 0x8000)) this.halted = true;
    return !this.halted;
  }

  // Read without device side effects (instruction fetch, memory view)
  readMemRaw(addr) {
    if (addr < 0xfe00) return this.mem[addr];
    return { [KBSR]: this.kbStatus, [KBDR]: this.kbData, [DSR]: this.dsr, [PSR_ADDR]: this.psr, [MCR]: this.mcr }[addr] || 0;
  }

  execute(ir) {
    const r = this.reg;
    const dr = (ir >> 9) & 7, sr1 = (ir >> 6) & 7;
    switch (ir >> 12) {
      case 0x0: // BR
        if (((ir >> 9) & 7) & (this.psr & 7)) this.pc = (this.pc + sext(ir, 9)) & 0xffff;
        break;
      case 0x1: case 0x5: { // ADD, AND
        let b;
        if (ir & 0x20) b = sext(ir, 5);
        else if (ir & 0x18) throw new Exception(0x01);
        else b = r[ir & 7];
        r[dr] = (ir >> 12) === 1 ? (r[sr1] + b) & 0xffff : r[sr1] & b;
        this.setCC(r[dr]);
        break;
      }
      case 0x2: r[dr] = this.load16((this.pc + sext(ir, 9)) & 0xffff); this.setCC(r[dr]); break;
      case 0x3: this.store16((this.pc + sext(ir, 9)) & 0xffff, r[dr]); break;
      case 0x4: // JSR, JSRR
        if (ir & 0x800) { r[7] = this.pc; this.pc = (this.pc + sext(ir, 11)) & 0xffff; }
        else {
          if (ir & 0x63f) throw new Exception(0x01);
          const t = r[sr1]; r[7] = this.pc; this.pc = t;
        }
        this.calls.push('sub');
        break;
      case 0x6: r[dr] = this.load16((r[sr1] + sext(ir, 6)) & 0xffff); this.setCC(r[dr]); break;
      case 0x7: this.store16((r[sr1] + sext(ir, 6)) & 0xffff, r[dr]); break;
      case 0x8: // RTI
        if (ir & 0xfff) throw new Exception(0x01);
        if (this.psr & 0x8000) throw new Exception(0x00);
        this.pc = this.load16(r[6]);
        r[6] = (r[6] + 1) & 0xffff;
        this.psr = this.load16(r[6]);
        r[6] = (r[6] + 1) & 0xffff;
        if (this.psr & 0x8000) { const t = r[6]; r[6] = this.ssp; this.ssp = t; }
        this.calls.pop();
        break;
      case 0x9: // NOT
        if ((ir & 0x3f) !== 0x3f) throw new Exception(0x01);
        r[dr] = ~r[sr1] & 0xffff; this.setCC(r[dr]);
        break;
      case 0xa: r[dr] = this.load16(this.load16((this.pc + sext(ir, 9)) & 0xffff)); this.setCC(r[dr]); break;
      case 0xb: this.store16(this.load16((this.pc + sext(ir, 9)) & 0xffff), r[dr]); break;
      case 0xc: // JMP, RET
        if (ir & 0xe3f) throw new Exception(0x01);
        this.pc = r[sr1];
        if (sr1 === 7 && this.calls.at(-1) === 'sub') this.calls.pop();
        break;
      case 0xd: throw new Exception(0x01);
      case 0xe: r[dr] = (this.pc + sext(ir, 9)) & 0xffff; break;   // LEA: no condition codes
      case 0xf: // TRAP
        if (ir & 0xf00) throw new Exception(0x01);
        this.enter(0x0000, ir & 0xff, (this.psr >> 8) & 7, 'trap');
        break;
    }
  }

  // Run until HALT, a breakpoint (not on the first instruction), or maxSteps more instructions.
  // Returns 'halted' | 'breakpoint' | 'limit'.
  run(maxSteps = Infinity) {
    for (let n = 0; n < maxSteps; n++) {
      if (n > 0 && this.breakpoints.has(this.pc)) return 'breakpoint';
      if (!this.step()) return 'halted';
    }
    return 'limit';
  }
}

// ---------------------------------------------------------------------------------------
// Disassembler (for the memory view)
// ---------------------------------------------------------------------------------------

export function disassemble(ir, addr, symbolAt = () => null) {
  const r = (n) => `R${n & 7}`;
  const target = (bits) => {
    const t = (addr + 1 + (sext(ir, bits) << 16 >> 16)) & 0xffff;
    return symbolAt(t) || `x${hex4(t)}`;
  };
  const imm = (bits) => `#${sext(ir, bits) << 16 >> 16}`;
  const dr = (ir >> 9) & 7, sr1 = (ir >> 6) & 7;
  switch (ir >> 12) {
    case 0x0: {
      const cc = (ir >> 9) & 7;
      if (cc === 0) return 'NOP';
      return 'BR' + (cc === 7 ? '' : (cc & 4 ? 'n' : '') + (cc & 2 ? 'z' : '') + (cc & 1 ? 'p' : '')) + ' ' + target(9);
    }
    case 0x1: case 0x5: {
      const op = ir >> 12 === 1 ? 'ADD' : 'AND';
      if (ir & 0x20) return `${op} ${r(dr)}, ${r(sr1)}, ${imm(5)}`;
      return ir & 0x18 ? '(illegal)' : `${op} ${r(dr)}, ${r(sr1)}, ${r(ir)}`;
    }
    case 0x2: return `LD ${r(dr)}, ${target(9)}`;
    case 0x3: return `ST ${r(dr)}, ${target(9)}`;
    case 0x4: return ir & 0x800 ? `JSR ${target(11)}` : ir & 0x63f ? '(illegal)' : `JSRR ${r(sr1)}`;
    case 0x6: return `LDR ${r(dr)}, ${r(sr1)}, ${imm(6)}`;
    case 0x7: return `STR ${r(dr)}, ${r(sr1)}, ${imm(6)}`;
    case 0x8: return ir & 0xfff ? '(illegal)' : 'RTI';
    case 0x9: return (ir & 0x3f) === 0x3f ? `NOT ${r(dr)}, ${r(sr1)}` : '(illegal)';
    case 0xa: return `LDI ${r(dr)}, ${target(9)}`;
    case 0xb: return `STI ${r(dr)}, ${target(9)}`;
    case 0xc: return ir & 0xe3f ? '(illegal)' : sr1 === 7 ? 'RET' : `JMP ${r(sr1)}`;
    case 0xd: return '(illegal)';
    case 0xe: return `LEA ${r(dr)}, ${target(9)}`;
    case 0xf: {
      if (ir & 0xf00) return '(illegal)';
      const names = { 0x20: 'GETC', 0x21: 'OUT', 0x22: 'PUTS', 0x23: 'IN', 0x24: 'PUTSP', 0x25: 'HALT' };
      return names[ir & 0xff] || `TRAP x${(ir & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return '';
}
