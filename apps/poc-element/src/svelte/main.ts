import { mount } from 'svelte';
import { defineOsdlabelAnnotator } from '@osdlabel/element';
import { mark, startInteractiveProbe } from '../shared/probe.js';
import App from './App.svelte';

mark('host-script');
startInteractiveProbe();
// Defined first: Svelte 5 sets a custom element's attribute as a property only
// when `key in node` at the time it renders.
defineOsdlabelAnnotator();
mount(App, { target: document.getElementById('app')! });
