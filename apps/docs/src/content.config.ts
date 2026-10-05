import { defineCollection } from 'astro:content';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  // Starlight reads overrides of its UI strings from this collection on every
  // build, and Astro warns when a collection it is asked for is missing or
  // empty. (Starlight stubs console.warn around that lookup, but Astro 7
  // logs it through its own logger, which writes with console.info, so the
  // warning gets through.) `i18n/en.json` is an empty object: no overrides,
  // but the collection exists.
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
