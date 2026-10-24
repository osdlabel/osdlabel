declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module '*.svelte' {
  import type { Component } from 'svelte';
  const component: Component<Record<string, never>>;
  export default component;
}

declare module '*.css?inline' {
  const css: string;
  export default css;
}
