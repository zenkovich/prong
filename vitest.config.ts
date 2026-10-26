import { defineConfig } from 'vitest/config';
// Unit tests for the app's non-visual modules: store, live sync, graph layout, agent routing.
// react-native resolves to react-native-web so the state layer loads in node; tsconfigRaw bypasses the
// Expo tsconfig "extends" that vite's tsconfck cannot resolve.
export default defineConfig({
  esbuild: { tsconfigRaw: { compilerOptions: { target: 'es2022', jsx: 'react-jsx' } } },
  resolve: { alias: { 'react-native': 'react-native-web' } },
  test: { include: ['src/**/*.test.ts'], environment: 'node', server: { deps: { inline: [/react-native/] } } },
});
