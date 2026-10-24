// React 19 consuming the custom element (not @osdlabel/react): React 19 sets a
// prop as a property when `key in element`, and binds `on<lowercase>` props to
// the matching custom event. Written with createElement so this app needs no
// second JSX transform beside Solid's.
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  defineOsdlabelAnnotator,
  type AnnotationsChangeDetail,
  type OsdlabelAnnotatorElement,
  type SelectedAnnotationChangeDetail,
} from '@osdlabel/element';
import type { OsdAnnotation } from 'osdlabel';
import {
  CONTEXTS,
  DECORATION_PROVIDERS,
  FIRST_IMAGE_ID,
  IMAGES,
  sampleAnnotations,
} from '../shared/fixtures.js';
import { mark, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

mark('host-script');
startInteractiveProbe();
defineOsdlabelAnnotator();

function App() {
  const [count, setCount] = useState(0);
  const [geometry, setGeometry] = useState('none');
  const [selected, setSelected] = useState<string | null>(null);
  // Controlled: bound back as a property, updated from annotationschange.
  const [annotations, setAnnotations] = useState<readonly OsdAnnotation[]>([]);
  return createElement(
    'div',
    null,
    createElement(
      'p',
      { className: 'fw-state' },
      'React state: ',
      createElement('span', { 'data-testid': 'fw-annotation-count' }, count),
      ' / ',
      createElement('span', { 'data-testid': 'fw-geometry' }, geometry),
      ' / ',
      createElement('span', { 'data-testid': 'fw-selected' }, selected ?? 'none'),
      createElement(
        'button',
        { 'data-testid': 'host-load-sample', onClick: () => setAnnotations(sampleAnnotations()) },
        'load sample',
      ),
    ),
    createElement('osdlabel-annotator', {
      images: IMAGES,
      contexts: CONTEXTS,
      decorationProviders: DECORATION_PROVIDERS,
      annotations,
      'test-mode': '',
      style: { display: 'block', height: '520px' },
      onosdlabelready: (e: Event) => {
        mark('element-ready');
        (e.target as OsdlabelAnnotatorElement).assignImageToCell(0, FIRST_IMAGE_ID);
      },
      onannotationschange: (e: Event) => {
        const detail = (e as CustomEvent<AnnotationsChangeDetail>).detail;
        setAnnotations(detail.annotations);
        setCount(detail.annotations.length);
        setGeometry(detail.annotations.map((a) => a.geometry.type).join(',') || 'none');
        reportHostEvent('annotationschange', detail);
      },
      onselectedannotationchange: (e: Event) => {
        const detail = (e as CustomEvent<SelectedAnnotationChangeDetail>).detail;
        setSelected(detail.annotationId);
        reportHostEvent('selectedannotationchange', detail);
      },
    }),
  );
}

createRoot(document.getElementById('app')!).render(createElement(App));
