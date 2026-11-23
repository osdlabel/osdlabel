/**
 * The commands the Rust shell sends, validated at the boundary: the shell is
 * another program, so its JSON is parsed, not trusted. `contract/commands.json`
 * pins the encoding; the crate's tests and `tests/unit/commands.test.ts` both
 * check it.
 */
import * as v from 'valibot';

export const VIEW_OPS = [
  'rotateCw',
  'rotateCcw',
  'flipH',
  'flipV',
  'invert',
  'exposureUp',
  'exposureDown',
  'contrastUp',
  'contrastDown',
  'reset',
] as const;

export type ViewOp = (typeof VIEW_OPS)[number];

const TOOLS = [
  'rectangle',
  'circle',
  'line',
  'point',
  'polyline',
  'freeHandPath',
  'select',
] as const;

/** Largest grid the shell may ask for (the `<GridView>` maximum). */
export const MAX_GRID = 4;

const GridSize = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_GRID));

export const CommandSchema = v.variant('t', [
  v.object({ t: v.literal('tool'), tool: v.nullable(v.picklist(TOOLS)) }),
  v.object({ t: v.literal('context'), id: v.string() }),
  v.object({ t: v.literal('image'), id: v.string() }),
  v.object({ t: v.literal('select'), id: v.nullable(v.string()) }),
  v.object({ t: v.literal('delete') }),
  v.object({ t: v.literal('view'), op: v.picklist(VIEW_OPS) }),
  v.object({ t: v.literal('export') }),
  v.object({ t: v.literal('import') }),
  v.object({ t: v.literal('undo') }),
  v.object({ t: v.literal('redo') }),
  v.object({ t: v.literal('grid'), columns: GridSize, rows: GridSize }),
  v.object({ t: v.literal('cell'), index: v.pipe(v.number(), v.integer(), v.minValue(0)) }),
]);

export type Command = v.InferOutput<typeof CommandSchema>;

export type ParsedCommand =
  | { readonly ok: true; readonly command: Command }
  | { readonly ok: false; readonly error: string };

export function parseCommand(json: string): ParsedCommand {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const result = v.safeParse(CommandSchema, raw);
  if (result.success) return { ok: true, command: result.output };
  return { ok: false, error: result.issues.map((i) => i.message).join('; ') };
}
