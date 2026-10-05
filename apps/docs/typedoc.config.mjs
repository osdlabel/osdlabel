// TypeDoc options for the API reference, shared by the starlight-typedoc
// plugin (astro.config.mjs) and the strict check that runs before the site
// build (`pnpm check:typedoc`), so the two cannot drift apart. Core TypeDoc
// options only: the check does not load typedoc-plugin-markdown, so a markdown
// plugin option here would fail it as unknown; set those in astro.config.mjs.
//
// In `packages` mode each package is converted with its own options: the root
// ones are not passed down, so anything that should shape a package's
// reflections goes in `packageOptions`.
//
// Symbols a public type references but that are deliberately not exported are
// listed per package, in `intentionallyNotExported` in that package's
// `typedoc.json`: in `packages` mode each package is converted, and checked,
// with its own options, and a shared list is reported unused wherever a
// symbol does not occur.

/** @type {import('typedoc').TypeDocOptions} */
export default {
  entryPoints: [
    '../../packages/annotation',
    '../../packages/viewer-api',
    '../../packages/geometry',
    '../../packages/annotation-context',
    '../../packages/validation',
    '../../packages/fabric-annotations',
    '../../packages/fabric-osd',
    '../../packages/osd-helper',
    '../../packages/decoration',
    '../../packages/osdlabel',
    '../../packages/solid',
    '../../packages/react',
  ],
  entryPointStrategy: 'packages',
  tsconfig: '../../packages/annotation/tsconfig.json',
  readme: 'none',
  packageOptions: {
    excludePrivate: true,
    excludeInternal: true,
  },
};
