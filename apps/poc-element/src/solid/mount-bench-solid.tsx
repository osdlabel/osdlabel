import { render } from 'solid-js/web';
import { Annotator } from '@osdlabel/solid';
import { CONTEXTS, IMAGES } from '../shared/fixtures.js';

/** The Solid binding mounted directly; returns the dispose function. */
export function mountSolid(container: HTMLElement): () => void {
  return render(() => <Annotator images={IMAGES} contexts={CONTEXTS} />, container);
}
