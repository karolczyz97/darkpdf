import globals from 'globals';

export default [
  { ignores: ['lib/**', 'node_modules/**'] },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: { ...globals.browser, ...globals.serviceworker } },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error' }
  },
  { files: ['server.js', 'test/**/*.mjs'], languageOptions: { globals: globals.node } }
];
