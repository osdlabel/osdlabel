<script setup lang="ts">
import { ref } from 'vue';
import type {
  ActiveToolChangeDetail,
  AnnotationsChangeDetail,
  OsdlabelAnnotatorElement,
  SelectedAnnotationChangeDetail,
} from '@osdlabel/element';
import type { OsdAnnotation } from 'osdlabel';
import {
  CONTEXTS,
  DECORATION_PROVIDERS,
  FIRST_IMAGE_ID,
  IMAGES,
  sampleAnnotations,
} from '../shared/fixtures.js';
import { mark, reportHostEvent } from '../shared/probe.js';

const count = ref(0);
const geometry = ref('none');
const selected = ref<string | null>(null);
// "Controlled": the host owns the list, binds it back as a property, and
// updates it from annotationschange. A plain deep `ref`, as most Vue code
// would write it, so the element receives Vue's reactive proxies.
const annotations = ref<OsdAnnotation[]>([]);

function onReady(e: Event): void {
  mark('element-ready');
  (e.target as OsdlabelAnnotatorElement).assignImageToCell(0, FIRST_IMAGE_ID);
}
function onAnnotations(e: Event): void {
  const detail = (e as CustomEvent<AnnotationsChangeDetail>).detail;
  annotations.value = [...detail.annotations];
  count.value = detail.annotations.length;
  geometry.value = detail.annotations.map((a) => a.geometry.type).join(',') || 'none';
  reportHostEvent('annotationschange', detail);
}
function onSelection(e: Event): void {
  const detail = (e as CustomEvent<SelectedAnnotationChangeDetail>).detail;
  selected.value = detail.annotationId;
  reportHostEvent('selectedannotationchange', detail);
}
function onTool(e: Event): void {
  reportHostEvent('activetoolchange', (e as CustomEvent<ActiveToolChangeDetail>).detail);
}
function loadSample(): void {
  annotations.value = sampleAnnotations();
}
</script>

<template>
  <p class="fw-state">
    Vue state: <span data-testid="fw-annotation-count">{{ count }}</span> /
    <span data-testid="fw-geometry">{{ geometry }}</span> /
    <span data-testid="fw-selected">{{ selected ?? 'none' }}</span>
    <button data-testid="host-load-sample" @click="loadSample">load sample</button>
  </p>
  <osdlabel-annotator
    :images="IMAGES"
    :contexts="CONTEXTS"
    :decorationProviders="DECORATION_PROVIDERS"
    :annotations="annotations"
    test-mode
    style="height: 520px"
    @osdlabelready="onReady"
    @annotationschange="onAnnotations"
    @selectedannotationchange="onSelection"
    @activetoolchange="onTool"
  />
</template>
