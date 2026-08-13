/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SAM_DECODER_URL?: string;
  readonly VITE_SAM_EMBED_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
