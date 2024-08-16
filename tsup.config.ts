import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/plugin.ts'],
  format: ['esm', 'cjs'],
  outDir: './build',
  shims: true,
  dts: true,
  clean: true,
})
