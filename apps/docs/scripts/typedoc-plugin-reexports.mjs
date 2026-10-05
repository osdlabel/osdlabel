// @ts-check
// Documents each symbol once, in the package that declares it.
//
// `packages` mode converts each package on its own, so a symbol another
// package re-exports (`osdlabel` re-exports most of the lower packages,
// `@osdlabel/decoration` the geometry math, and `@osdlabel/solid` /
// `@osdlabel/react` all of `osdlabel`) was documented again in every package
// that re-exports it: a full copy whose "Defined in" pointed at the declaring
// package's `dist/*.d.ts`, and a duplicate search result. Over half of the
// reference's pages were such copies.
//
// While a package converts, this plugin skips a module-level export that
// another workspace package declares. Type references to it then resolve, after
// the packages are merged, to the declaring package's reflection. The export
// itself becomes a reference to that reflection, so `{@link}`s that name it
// still resolve. The reference is a child of the module but in none of its
// groups: the sidebar is built from groups, and Starlight highlights the first
// sidebar entry whose link matches the page, so a grouped reference in an
// earlier package would claim the declaring package's pages.
//
// TypeDoc's `excludeExternals` cannot do this: it skips the symbol everywhere,
// including inherited members, so an interface extending one from another
// package (`FabricRawAnnotationData`) would lose the members it inherits.
import {
  Application,
  Context,
  Converter,
  ReferenceReflection,
  ReflectionKind,
  ReflectionSymbolId,
} from 'typedoc';

/** @typedef {Parameters<Context['shouldIgnore']>[0]} TsSymbol TypeScript's `Symbol` type. */

/** What a package's entry point converts into: its project, or a module. */
const ENTRY_CONTAINER = ReflectionKind.Module | ReflectionKind.Project;

/**
 * Whether `symbol` is declared in a workspace package other than
 * `packageName`. Third-party declarations (under `node_modules`) are left
 * alone: their packages are not documented, so there is nothing to link to.
 *
 * @param {Context} context
 * @param {TsSymbol} symbol
 * @param {string} packageName
 */
function declaredInOtherPackage(context, symbol, packageName) {
  const declarations = symbol.getDeclarations() ?? [];
  return (
    declarations.length > 0 &&
    declarations.every((d) => !d.getSourceFile().fileName.includes('/node_modules/')) &&
    context.createSymbolId(symbol).packageName !== packageName
  );
}

/** @param {Application} app */
export function load(app) {
  /** The package being converted. */
  let packageName = '';

  /**
   * @type {{
   *   packageName: string;
   *   entryName: string;
   *   entryCount: number;
   *   exportName: string;
   *   symbolId: import('typedoc').JSONOutput.ReflectionSymbolId;
   * }[]}
   */
  const reexports = [];

  if (typeof Context.prototype.shouldIgnore !== 'function') {
    throw new Error('typedoc-plugin-reexports: Context#shouldIgnore no longer exists');
  }
  const shouldIgnore = Context.prototype.shouldIgnore;
  /** @this {Context} @param {TsSymbol} symbol */
  Context.prototype.shouldIgnore = function (symbol) {
    return (
      shouldIgnore.call(this, symbol) ||
      (packageName !== '' &&
        this.scope.kindOf(ENTRY_CONTAINER) &&
        declaredInOtherPackage(this, symbol, packageName))
    );
  };

  // The entry points this package converts. Captured from the converter's
  // call, because `app.getEntryPoints()` would build their programs again.
  /** @type {Parameters<Converter['convert']>[0]} */
  let entryPoints = [];
  const convert = app.converter.convert;
  /** @param {Parameters<Converter['convert']>[0]} entries */
  app.converter.convert = function (entries) {
    entryPoints = entries;
    return convert.call(this, entries);
  };

  app.converter.on(Converter.EVENT_BEGIN, (context) => {
    packageName = '';
    for (const entry of entryPoints) {
      context.setActiveProgram(entry.program);
      const moduleSymbol = context.checker.getSymbolAtLocation(entry.sourceFile);
      if (moduleSymbol) {
        // The project is not named yet while it converts; the entry file's
        // symbol id carries the package it belongs to.
        packageName ||= context.createSymbolId(moduleSymbol).packageName;
        for (const exported of context.checker.getExportsOfModule(moduleSymbol)) {
          const target = context.resolveAliasedSymbol(exported);
          if (!declaredInOtherPackage(context, target, packageName)) continue;
          reexports.push({
            packageName,
            entryName: entry.displayName,
            entryCount: entryPoints.length,
            exportName: exported.name,
            // Serialized, as the merged project's ids are: without the
            // declaration's position, which here is in the `.d.ts` file.
            symbolId: context.createSymbolId(target).toObject(),
          });
        }
      }
      context.setActiveProgram(undefined);
    }
  });

  app.converter.on(Converter.EVENT_END, () => {
    packageName = '';
    entryPoints = [];
  });

  /** The references this plugin added, with the module each was added to. */
  /** @type {Map<ReferenceReflection, { groups?: import('typedoc').ReflectionGroup[] }>} */
  const added = new Map();

  app.on(Application.EVENT_PROJECT_REVIVE, (project) => {
    for (const record of reexports) {
      const packageModule = project.children?.find((c) => c.name === record.packageName);
      // A single-entry package is its module; a multi-entry one has a child
      // module per entry point, named after it.
      const module =
        record.entryCount === 1
          ? packageModule
          : packageModule?.children?.find(
              (c) => c.kindOf(ReflectionKind.Module) && c.name === record.entryName,
            );
      if (!module) {
        app.logger.warn(
          `[reexports] ${record.packageName}: no module for entry point "${record.entryName}"`,
        );
        continue;
      }
      const target = project
        .getReflectionsFromSymbolId(new ReflectionSymbolId(record.symbolId))
        .find((r) => !r.isReference() && r.parent?.kindOf(ENTRY_CONTAINER));
      if (!target) {
        app.logger.warn(
          `[reexports] ${record.packageName}: ${record.exportName} is re-exported, but its declaring package does not document it`,
        );
        continue;
      }

      const ref = new ReferenceReflection(record.exportName, target, module);
      project.registerReflection(ref, undefined, undefined);
      // TypeDoc's GroupPlugin runs after this handler and groups the children
      // of any module that has no `groups` yet (one with no grouped children of
      // its own revives without them); an empty list keeps it from doing so.
      module.groups ??= [];
      module.addChild(ref);
      added.set(ref, module);
    }
    reexports.length = 0;

    // Fail loudly (the strict check treats warnings as errors) if a copy is
    // documented again, e.g. because a TypeDoc upgrade stopped consulting
    // Context#shouldIgnore for module exports.
    const documented = new Set((project.children ?? []).map((c) => c.name));
    for (const packageModule of project.children ?? []) {
      for (const module of [packageModule, ...(packageModule.children ?? [])]) {
        if (!module.kindOf(ENTRY_CONTAINER)) continue;
        for (const child of module.children ?? []) {
          if (child.isReference()) continue;
          const id = project.getSymbolIdFromReflection(child);
          if (id && id.packageName !== packageModule.name && documented.has(id.packageName)) {
            app.logger.warn(
              `[reexports] ${packageModule.name} documents a copy of ${child.name} from ${id.packageName}`,
            );
          }
        }
      }
    }
  });

  // After GroupPlugin's revive handler (priority -100): the references must
  // have stayed out of every group, or the sidebar lists them.
  app.on(
    Application.EVENT_PROJECT_REVIVE,
    () => {
      for (const [ref, module] of added) {
        if (module.groups?.some((g) => g.children.includes(ref))) {
          app.logger.warn(`[reexports] the reference to ${ref.name} is in a sidebar group`);
        }
      }
      added.clear();
    },
    -150,
  );
}
