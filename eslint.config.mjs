// ESLint 設定：只抓真正會出錯的問題（未定義的變數、沒用到的匯入、重複的鍵……），
// 不管排版風格。執行：npx eslint js
import globals from 'globals';

export default [
  {
    files: ['js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-dupe-keys': 'error',
      'no-duplicate-imports': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-redeclare': 'error',
    },
  },
  {
    // AudioWorklet 有自己的全域：sampleRate、currentTime、registerProcessor…
    files: ['js/*-worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
];
