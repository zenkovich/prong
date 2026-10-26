// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const globals = require('globals');

module.exports = defineConfig([
  expoConfig,
  {
    // build outputs and generated assets
    ignores: ['dist/*', 'macos/build/**', 'macos/vendor/**', 'server/dist/**', 'public/**', 'src/ui/fileIconMap.generated.ts'],
  },
  {
    // Node code: the git engine, its tests and the tooling scripts
    files: ['server/**/*.ts', 'tools/**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
]);
