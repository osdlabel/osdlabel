import { describe, expect, it } from 'vitest';
import { arg, intArg, listArg, parseCommonArgs, validateLabels } from '../scripts/run.mjs';

describe('arg', () => {
  it('returns the fallback when the flag is absent', () => {
    expect(arg([], '--label', 'x')).toBe('x');
  });

  it('rejects a flag with no value instead of swallowing the next flag', () => {
    expect(() => arg(['--reps', '--trace'], '--reps', '7')).toThrow(/--reps expects a value/);
    expect(() => arg(['--reps'], '--reps', '7')).toThrow(/--reps expects a value/);
  });
});

describe('intArg', () => {
  it('parses a positive integer', () => {
    expect(intArg(['--frames', '120'], '--frames', 240)).toBe(120);
    expect(intArg([], '--frames', 240)).toBe(240);
  });

  // `--frames abc` used to hang the page's rAF loop forever; `--reps 0` used
  // to produce empty results that passed --fail-on-regression.
  it.each(['abc', '0', '-1', '1.5', '', '0x10', '1e2', ' 7'])('rejects %j', (v) => {
    expect(() => intArg(['--frames', v], '--frames', 240)).toThrow(/positive integer/);
  });
});

describe('listArg', () => {
  it('accepts known entries and rejects unknown ones', () => {
    expect(listArg(['--phases', 'pan,live'], '--phases', ['pan', 'static', 'live'])).toEqual([
      'pan',
      'live',
    ]);
    expect(() => listArg(['--phases', 'pan,lvie'], '--phases', ['pan', 'live'])).toThrow(/'lvie'/);
  });

  it('tolerates whitespace and empty entries', () => {
    expect(listArg(['--phases', 'pan, live,'], '--phases', ['pan', 'live'])).toEqual([
      'pan',
      'live',
    ]);
  });

  it('rejects a list with no entries', () => {
    expect(() => listArg(['--phases', ','], '--phases', ['pan'])).toThrow(/at least one/);
  });

  it('rejects duplicates, which would pool 2R samples into one cell', () => {
    expect(() => listArg(['--phases', 'pan,pan'], '--phases', ['pan'])).toThrow(/listed twice/);
  });
});

describe('parseCommonArgs', () => {
  it('applies the defaults', () => {
    const c = parseCommonArgs([]);
    expect(c.reps).toBe(7);
    expect(c.frames).toBe(240);
    expect(c.scenarios).toContain('S0');
    expect(c.phases).toEqual(['pan', 'static', 'live']);
  });

  it('rejects an unknown scenario before anything is launched', () => {
    expect(() => parseCommonArgs(['--scenarios', 'S1,S9'])).toThrow(/S9/);
  });
});

describe('validateLabels', () => {
  it('accepts short shas and simple names', () => {
    expect(() => validateLabels(['4f63859', 'feat-x_1.2'])).not.toThrow();
  });

  it('rejects labels that are not file-name safe', () => {
    expect(() => validateLabels(['feat/x'])).toThrow(/feat\/x/);
  });

  it('rejects duplicate labels, which would merge two builds into one result file', () => {
    expect(() => validateLabels(['a', 'a'])).toThrow(/duplicate build label 'a'/);
  });
});
