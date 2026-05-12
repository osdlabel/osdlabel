import { createSignal, Show } from 'solid-js';
import { initFabricModule } from '@osdlabel/solid';
import type { ImageSource, AnnotationContext } from '@osdlabel/solid';
import { DEFAULT_IMAGES, DEFAULT_CONTEXTS } from './defaults.js';
import ConfigPanel from './ConfigPanel.js';
import AnnotateView from './AnnotateView.js';

initFabricModule();

type Mode = 'configure' | 'annotate';

export default function DemoApp() {
  const [mode, setMode] = createSignal<Mode>('configure');
  const [images, setImages] = createSignal<ImageSource[]>([...DEFAULT_IMAGES]);
  const [contexts, setContexts] = createSignal<AnnotationContext[]>([...DEFAULT_CONTEXTS]);

  const handleLaunch = (imgs: ImageSource[], ctxs: AnnotationContext[]) => {
    setImages(imgs);
    setContexts(ctxs);
    setMode('annotate');
  };

  const handleReconfigure = () => {
    setMode('configure');
  };

  return (
    <Show
      when={mode() === 'annotate'}
      fallback={
        <ConfigPanel
          initialImages={images()}
          initialContexts={contexts()}
          onLaunch={handleLaunch}
        />
      }
    >
      <AnnotateView
        images={images()}
        contexts={contexts()}
        onReconfigure={handleReconfigure}
      />
    </Show>
  );
}
