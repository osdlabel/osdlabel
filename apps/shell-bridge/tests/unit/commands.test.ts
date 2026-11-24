import { describe, expect, it } from 'vitest';
import contractJson from '../../contract/commands.json';
import { parseCommand, VIEW_OPS } from '../../src/commands.js';

/** The same fixture the crate's tests encode its `Command`s against. */
const contract: Record<string, unknown> = contractJson;

describe('parseCommand', () => {
  it.each(Object.entries(contract))('accepts the contract command %s', (_name, command) => {
    const parsed = parseCommand(JSON.stringify(command));
    expect(parsed).toEqual({ ok: true, command });
  });

  it('the contract covers every view op', () => {
    const ops = Object.keys(contract)
      .filter((k) => k.startsWith('view:'))
      .map((k) => k.slice('view:'.length));
    expect(ops.sort()).toEqual([...VIEW_OPS].sort());
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown command', '{"t":"explode"}'],
    ['no tag', '{"tool":"rectangle"}'],
    ['an unknown tool', '{"t":"tool","tool":"lasso"}'],
    ['a missing id', '{"t":"context"}'],
    ['an id that is not a string', '{"t":"image","id":3}'],
    ['an unknown view op', '{"t":"view","op":"spin"}'],
    ['a zero-column grid', '{"t":"grid","columns":0,"rows":1}'],
    ['a grid past the maximum', '{"t":"grid","columns":5,"rows":1}'],
    ['a fractional grid', '{"t":"grid","columns":1.5,"rows":1}'],
    ['a negative cell', '{"t":"cell","index":-1}'],
    ['an array', '[]'],
  ])('rejects %s', (_label, json) => {
    const parsed = parseCommand(json);
    expect(parsed.ok).toBe(false);
  });

  it('says why it rejected', () => {
    const parsed = parseCommand('{"t":"view","op":"spin"}');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).not.toBe('');
  });
});
