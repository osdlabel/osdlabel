import { createApp } from 'vue';
import { defineOsdlabelAnnotator } from '@osdlabel/element';
import { mark, startInteractiveProbe } from '../shared/probe.js';
import App from './App.vue';

mark('host-script');
startInteractiveProbe();
// Defined before the app mounts, so Vue's `key in el` check sees the element's
// property accessors and binds `:images` as a property, not an attribute.
defineOsdlabelAnnotator();
createApp(App).mount('#app');
