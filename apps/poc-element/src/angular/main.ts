// JIT: the template is compiled in the browser, so this page needs no Angular
// CLI / ngc step. Decorators are applied as plain function calls
// (`Component({...})(Class)`), which is what the decorator syntax desugars to,
// so the file is plain TypeScript the workspace's toolchain already handles.
import '@angular/compiler';
import {
  ChangeDetectionStrategy,
  Component,
  CUSTOM_ELEMENTS_SCHEMA,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  defineOsdlabelAnnotator,
  type ActiveToolChangeDetail,
  type AnnotationsChangeDetail,
  type OsdlabelAnnotatorElement,
  type SelectedAnnotationChangeDetail,
} from '@osdlabel/element';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark, reportHostEvent, startInteractiveProbe } from '../shared/probe.js';

mark('host-script');
startInteractiveProbe();
defineOsdlabelAnnotator();

class AppComponent {
  readonly images = IMAGES;
  readonly contexts = CONTEXTS;
  readonly count = signal(0);
  readonly geometry = signal('none');
  readonly selected = signal<string | null>(null);

  onReady(e: Event): void {
    mark('element-ready');
    (e.target as OsdlabelAnnotatorElement).assignImageToCell(0, FIRST_IMAGE_ID);
  }
  onAnnotations(e: Event): void {
    const detail = (e as CustomEvent<AnnotationsChangeDetail>).detail;
    this.count.set(detail.annotations.length);
    this.geometry.set(detail.annotations.map((a) => a.geometry.type).join(',') || 'none');
    reportHostEvent('annotationschange', detail);
  }
  onSelection(e: Event): void {
    const detail = (e as CustomEvent<SelectedAnnotationChangeDetail>).detail;
    this.selected.set(detail.annotationId);
    reportHostEvent('selectedannotationchange', detail);
  }
  onTool(e: Event): void {
    reportHostEvent('activetoolchange', (e as CustomEvent<ActiveToolChangeDetail>).detail);
  }
}

Component({
  selector: 'app-root',
  // Lets the template use an unknown tag and bind unknown properties on it.
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="fw-state">
      Angular state: <span data-testid="fw-annotation-count">{{ count() }}</span> /
      <span data-testid="fw-geometry">{{ geometry() }}</span> /
      <span data-testid="fw-selected">{{ selected() ?? 'none' }}</span>
    </p>
    <osdlabel-annotator
      [images]="images"
      [contexts]="contexts"
      test-mode
      style="display: block; height: 520px"
      (osdlabelready)="onReady($event)"
      (annotationschange)="onAnnotations($event)"
      (selectedannotationchange)="onSelection($event)"
      (activetoolchange)="onTool($event)"
    ></osdlabel-annotator>
  `,
})(AppComponent);

const root = document.createElement('app-root');
document.getElementById('app')!.append(root);
void bootstrapApplication(AppComponent, {
  providers: [provideZonelessChangeDetection()],
});
