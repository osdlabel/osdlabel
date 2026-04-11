import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const docsDir = join(__dirname, '..', 'src', 'content', 'docs');
const publicDir = join(__dirname, '..', 'public');

// Ordered sections matching the sidebar
const pageOrder = [
  'getting-started/installation.mdx',
  'getting-started/quick-start.mdx',
  'getting-started/concepts.mdx',
  'guides/packages-and-architecture.mdx',
  'guides/components.mdx',
  'guides/state-and-hooks.mdx',
  'guides/basic-controls.mdx',
  'guides/viewer-grid.mdx',
  'guides/annotation-contexts.mdx',
  'guides/serialization.mdx',
  'guides/keyboard-shortcuts.mdx',
  'guides/coordinate-systems.mdx',
  'guides/osd-fabric-integration.md',
  'examples/minimal-viewer.mdx',
  'examples/multiple-contexts.mdx',
  'examples/custom-toolbar.mdx',
];

function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return content;
  return content.slice(match[0].length);
}

function extractTitle(content) {
  const match = content.match(/^---\r?\n[\s\S]*?title:\s*(.+?)\r?\n[\s\S]*?\r?\n---/);
  return match ? match[1].trim() : 'Untitled';
}

function stripMdxImports(content) {
  // Remove MDX import statements and component usage
  return content
    .replace(/^import\s+.*$/gm, '')
    .replace(/<(Card|CardGrid)[^>]*>/g, '')
    .replace(/<\/(Card|CardGrid)>/g, '')
    .replace(/^\s*\n/gm, '\n');
}

const sections = [];

for (const pagePath of pageOrder) {
  const fullPath = join(docsDir, pagePath);
  try {
    const content = readFileSync(fullPath, 'utf-8');
    const title = extractTitle(content);
    let body = stripFrontmatter(content);
    if (pagePath.endsWith('.mdx')) {
      body = stripMdxImports(body);
    }
    sections.push(`# ${title}\n\n${body.trim()}`);
  } catch {
    console.warn(`Warning: Could not read ${pagePath}`);
  }
}

const combined = sections.join('\n\n---\n\n');

// Write the Starlight page
const llmMd = `---
title: Full Documentation (LLM)
description: Complete osdlabel documentation in a single page for LLM consumption
sidebar:
  hidden: true
---

${combined}
`;

writeFileSync(join(docsDir, 'llm.md'), llmMd);
console.log(`Generated llm.md (${Math.round(llmMd.length / 1024)} KB)`);

// Write the plain text version
const llmsTxt = `# osdlabel

> DZI image annotation library for SolidJS and React

osdlabel is a high-performance annotation library for Deep Zoom Images, built with Fabric.js v7 and OpenSeaDragon, with official UI bindings for SolidJS and React.

## Documentation

- Full docs: https://guyo13.github.io/osdlabel/
- Full docs (single page): https://guyo13.github.io/osdlabel/llm/

## Detailed documentation

${combined}
`;

writeFileSync(join(publicDir, 'llms.txt'), llmsTxt);
console.log(`Generated llms.txt (${Math.round(llmsTxt.length / 1024)} KB)`);
