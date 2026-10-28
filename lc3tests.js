// Runs an exam's test cases (exam.json "tests") on a student's programs.
// The Python grader (grader/grade.py) implements the same rules; keep them in step.
//
// A test:
//   { "name": "x00FF",
//     "set": { "INPUT_WORD": "x00FF" },          labels (or addresses) to patch before running
//     "input": "ab\n",                          keyboard input
//     "checkAt": "PRINT_RESULTS",               check registers when execution first reaches this label
//                                               (omit to check them when the program halts)
//     "expect": { "R6": 8, "R7": 8, "mem": { "RESULT": 5 } },
//     "output": "8\n8\n",                       expected output (the HALT message is ignored)
//     "points": 1 }

import { Machine, parseNumber, HALT_MESSAGE, hex4 } from './lc3core.js';

export function stripHalt(output) {
  return output.endsWith(HALT_MESSAGE) ? output.slice(0, -HALT_MESSAGE.length) : output;
}

function valueOf(v) {
  const n = typeof v === 'number' ? v : parseNumber(String(v).trim());
  if (n === null) throw new Error(`bad number: ${v}`);
  return n & 0xffff;
}

// Find a label (case-insensitive) in any of the programs, or parse an address like x3100
function addressOf(programs, where) {
  for (const p of programs) if (where.toLowerCase() in p.symbols) return p.symbols[where.toLowerCase()];
  const n = parseNumber(where);
  return n === null ? null : n & 0xffff;
}

const show = (s) => JSON.stringify(s);
const regText = (v) => `${(v << 16) >> 16} (x${hex4(v)})`;

export function runTest(programs, test, { os, ignorePrivilege = false, maxSteps = 100000 } = {}) {
  const result = { name: test.name || 'test', points: test.points ?? 1, passed: false, details: [] };
  const m = new Machine({ os, ignorePrivilege });
  m.reset(programs);
  for (const [where, v] of Object.entries(test.set || {})) {
    const addr = addressOf(programs, where);
    if (addr === null) { result.details.push(`label ${where} not found (don't rename or remove it)`); return result; }
    m.mem[addr] = valueOf(v);
  }
  m.addInput(test.input || '');

  let snap = null;
  let status;
  if (test.checkAt) {
    const addr = addressOf(programs, test.checkAt);
    if (addr === null) { result.details.push(`label ${test.checkAt} not found (don't rename or remove it)`); return result; }
    if (m.pc === addr) snap = [...m.reg];
    m.breakpoints = new Set([addr]);
    status = m.run(maxSteps);
    if (status === 'breakpoint') {
      snap = [...m.reg];
      m.breakpoints = new Set();
      status = m.run(Math.max(0, maxSteps - m.steps));
    }
  } else {
    status = m.run(maxSteps);
    snap = [...m.reg];
  }
  result.output = stripHalt(m.output);
  result.regs = snap;
  result.status = status;

  if (status === 'limit') result.details.push(`did not halt within ${maxSteps} instructions (infinite loop?)`);
  if (test.checkAt && !snap) result.details.push(`never reached ${test.checkAt}`);
  for (const [k, v] of Object.entries(test.expect || {})) {
    if (/^R[0-7]$/i.test(k)) {
      if (snap && snap[+k[1]] !== valueOf(v)) result.details.push(`${k.toUpperCase()} = ${regText(snap[+k[1]])}, expected ${regText(valueOf(v))}`);
    } else if (k === 'mem') {
      for (const [where, want] of Object.entries(v)) {
        const addr = addressOf(programs, where);
        const got = addr === null ? null : m.mem[addr];
        if (got !== valueOf(want)) result.details.push(`memory ${where} = ${got === null ? '(no such label)' : regText(got)}, expected ${regText(valueOf(want))}`);
      }
    }
  }
  if (test.output !== undefined && result.output !== test.output) {
    result.details.push(`output was ${show(result.output)}, expected ${show(test.output)}`);
  }
  result.passed = result.details.length === 0;
  return result;
}
