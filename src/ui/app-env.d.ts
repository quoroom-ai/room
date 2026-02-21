declare const __APP_BUILD_ID__: string

interface ImportMetaEnv {
  readonly VITE_CLOUD_URL?: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
