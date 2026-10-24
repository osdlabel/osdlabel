import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Annotator } from '@osdlabel/react';
import { CONTEXTS, IMAGES } from '../shared/fixtures.js';

/** The React binding, committed synchronously (flushSync) so the mount can be timed. */
export function mountReact(container: HTMLElement): () => void {
  const root = createRoot(container);
  flushSync(() => {
    root.render(createElement(Annotator, { images: IMAGES, contexts: CONTEXTS }));
  });
  return () => root.unmount();
}
