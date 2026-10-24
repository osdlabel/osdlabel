#!/usr/bin/env node
/**
 * H3 inventory: every hardcoded style in both bindings' components, the
 * shared constants in `osdlabel`, and the dev apps' CSS.
 *
 *   node scripts/inventory-styles.mjs [--json <out>] [--root <repo>]
 *
 * Counts, per file and per binding: JSX inline-style objects, the declarations
 * in them, colour literals, px lengths, className/class usages and `part`
 * attributes. Then compares the two bindings' colour and declaration sets,
 * which is a direct measure of how far their hand-maintained styling has
 * drifted. Regex-based: it reads source text, not an AST, so treat counts as
 * ±a few, not exact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const ROOT = path.resolve(flag('--root', path.join(HERE, '..', '..', '..')));

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const PX_RE = /-?\d+(?:\.\d+)?px\b/g;
const CLASS_RE = /\b(?:className|class)\s*=/g;
const PART_RE = /\bpart\s*=/g;
const TESTID_RE = /data-testid/g;

/** Every `style={{ ... }}` object literal's body, by brace matching. */
function inlineStyleBodies(src) {
  const bodies = [];
  let i = 0;
  while ((i = src.indexOf('style={{', i)) !== -1) {
    let depth = 0;
    let j = i + 'style={'.length;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(src.slice(i + 'style={{'.length, j));
    i = j;
  }
  return bodies;
}

/** `property: value` pairs at the top level of a style object body. */
function declarations(body) {
  const out = [];
  const re = /(?:^|[,{\n])\s*(?:'([a-z-]+)'|"([a-z-]+)"|([a-zA-Z]+))\s*:\s*([^,\n]+)/g;
  let m;
  while ((m = re.exec(body))) {
    const prop = m[1] ?? m[2] ?? m[3];
    if (prop === '...props' || prop === undefined) continue;
    // Normalise React's camelCase to CSS kebab-case so the bindings compare.
    const kebab = prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    out.push({ prop: kebab, value: m[4].trim() });
  }
  return out;
}

function listFiles(dir, exts) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) =>
      d.isDirectory()
        ? listFiles(path.join(dir, d.name), exts)
        : exts.some((e) => d.name.endsWith(e))
          ? [path.join(dir, d.name)]
          : [],
    );
}

/**
 * Source without comments, so issue references (`#147`) are not read as
 * colours. A `//` counts as a comment only after whitespace or at line start,
 * which leaves `http://` inside strings alone.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
}

function scanTsx(file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const bodies = inlineStyleBodies(src);
  const decls = bodies.flatMap(declarations);
  return {
    file: path.relative(ROOT, file),
    inlineStyleObjects: bodies.length,
    declarations: decls.length,
    colors: [...new Set(src.match(COLOR_RE) ?? [])].map((c) => c.toLowerCase()),
    colorLiterals: (src.match(COLOR_RE) ?? []).length,
    pxLiterals: (src.match(PX_RE) ?? []).length,
    classNameUsages: (src.match(CLASS_RE) ?? []).length,
    partAttributes: (src.match(PART_RE) ?? []).length,
    testIds: (src.match(TESTID_RE) ?? []).length,
    decls,
  };
}

function scanCssInHtml(file) {
  const src = fs.readFileSync(file, 'utf8');
  const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
  return {
    file: path.relative(ROOT, file),
    rules: (css.match(/\{/g) ?? []).length,
    declarations: (css.match(/[a-z-]+\s*:[^;{}]+;/g) ?? []).length,
    colors: [...new Set(css.match(COLOR_RE) ?? [])].map((c) => c.toLowerCase()),
    pxLiterals: (css.match(PX_RE) ?? []).length,
  };
}

function summarise(files) {
  const sum = (k) => files.reduce((a, f) => a + f[k], 0);
  const colors = new Set(files.flatMap((f) => f.colors));
  const declSet = new Set(files.flatMap((f) => f.decls.map((d) => `${d.prop}: ${d.value}`)));
  const props = {};
  for (const f of files) for (const d of f.decls) props[d.prop] = (props[d.prop] ?? 0) + 1;
  return {
    files: files.length,
    inlineStyleObjects: sum('inlineStyleObjects'),
    declarations: sum('declarations'),
    colorLiterals: sum('colorLiterals'),
    distinctColors: [...colors].sort(),
    pxLiterals: sum('pxLiterals'),
    classNameUsages: sum('classNameUsages'),
    partAttributes: sum('partAttributes'),
    testIds: sum('testIds'),
    topProperties: Object.entries(props)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    declSet,
  };
}

const bindings = {
  solid: listFiles(path.join(ROOT, 'packages/solid/src/components'), ['.tsx']).map(scanTsx),
  react: listFiles(path.join(ROOT, 'packages/react/src/components'), ['.tsx']).map(scanTsx),
};
const sharedConstantsFiles = listFiles(path.join(ROOT, 'packages/osdlabel/src'), ['.ts']);
const shared = sharedConstantsFiles
  .map((f) => ({
    file: path.relative(ROOT, f),
    colors: [...new Set(stripComments(fs.readFileSync(f, 'utf8')).match(COLOR_RE) ?? [])].map((c) =>
      c.toLowerCase(),
    ),
  }))
  .filter((f) => f.colors.length > 0);
const devCss = [
  ...listFiles(path.join(ROOT, 'apps/dev'), ['.html']),
  ...listFiles(path.join(ROOT, 'apps/dev-react'), ['.html']),
]
  .filter((f) => !f.includes('node_modules') && !f.includes('/dist/'))
  .map(scanCssInHtml);
const devTsx = {
  dev: listFiles(path.join(ROOT, 'apps/dev/src'), ['.tsx']).map(scanTsx),
  'dev-react': listFiles(path.join(ROOT, 'apps/dev-react/src'), ['.tsx']).map(scanTsx),
};

const s = summarise(bindings.solid);
const r = summarise(bindings.react);
const onlyIn = (a, b) => [...a].filter((x) => !b.has(x));
const solidColors = new Set(s.distinctColors);
const reactColors = new Set(r.distinctColors);

const result = {
  root: ROOT,
  generatedAt: new Date().toISOString(),
  bindings: {
    solid: { ...s, declSet: undefined },
    react: { ...r, declSet: undefined },
  },
  drift: {
    colorsOnlyInSolid: onlyIn(solidColors, reactColors),
    colorsOnlyInReact: onlyIn(reactColors, solidColors),
    distinctColorsUnion: [...new Set([...solidColors, ...reactColors])].sort(),
    declarationsOnlyInSolid: onlyIn(s.declSet, r.declSet).length,
    declarationsOnlyInReact: onlyIn(r.declSet, s.declSet).length,
    declarationsInBoth: [...s.declSet].filter((x) => r.declSet.has(x)).length,
  },
  perFile: Object.fromEntries(
    Object.entries(bindings).map(([k, files]) => [
      k,
      files.map((f) => Object.fromEntries(Object.entries(f).filter(([key]) => key !== 'decls'))),
    ]),
  ),
  sharedColorConstantsInOsdlabel: shared,
  devApps: {
    htmlCss: devCss,
    tsx: Object.fromEntries(
      Object.entries(devTsx).map(([k, files]) => {
        const sm = summarise(files);
        return [k, { ...sm, declSet: undefined }];
      }),
    ),
  },
};

const out = flag('--json', undefined);
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));

const row = (name, x) =>
  `${name.padEnd(8)} files=${String(x.files).padStart(2)} styleObjs=${String(x.inlineStyleObjects).padStart(3)} decls=${String(x.declarations).padStart(4)} colorLits=${String(x.colorLiterals).padStart(3)} distinctColors=${String(x.distinctColors.length).padStart(2)} px=${String(x.pxLiterals).padStart(3)} className=${x.classNameUsages} part=${x.partAttributes}`;
console.log(row('solid', result.bindings.solid));
console.log(row('react', result.bindings.react));
console.log(
  `drift: colours only-solid=${result.drift.colorsOnlyInSolid.length} only-react=${result.drift.colorsOnlyInReact.length}; declarations only-solid=${result.drift.declarationsOnlyInSolid} only-react=${result.drift.declarationsOnlyInReact} both=${result.drift.declarationsInBoth}`,
);
console.log(`distinct colours (union): ${result.drift.distinctColorsUnion.join(' ')}`);
if (!out) process.stdout.write('');
export default result;
