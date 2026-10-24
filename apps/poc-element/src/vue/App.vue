<script setup lang="ts">
import { ref } from 'vue';
import type {
  ActiveToolChangeDetail,
  AnnotationsChangeDetail,
  OsdlabelAnnotatorElement,
  SelectedAnnotationChangeDetail,
} from '@osdlabel/element';
import { CONTEXTS, FIRST_IMAGE_ID, IMAGES } from '../shared/fixtures.js';
import { mark, reportHostEvent } from '../shared/probe.js';

const count = ref(0);
const geometry = ref('none');
const selected = ref<string | null>(null);

function onReady(e: Event): void {
  mark('element-ready');
  (e.target as OsdlabelAnnotatorElement).assignImageToCell(0, FIRST_IMAGE_ID);
}
function onAnnotations(e: Event): void {
  const detail = (e as CustomEvent<AnnotationsChangeDetail>).detail;
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
</script>

<template>
  <p class="fw-state">
    Vue state: <span data-testid="fw-annotation-count">{{ count }}</span> /
    <span data-testid="fw-geometry">{{ geometry }}</span> /
    <span data-testid="fw-selected">{{ selected ?? 'none' }}</span>
  </p>
  <osdlabel-annotator
    :images="IMAGES"
    :contexts="CONTEXTS"
    test-mode
    style="height: 520px"
    @osdlabelready="onReady"
    @annotationschange="onAnnotations"
    @selectedannotationchange="onSelection"
    @activetoolchange="onTool"
  />
</template>
