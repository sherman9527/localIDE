import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'data/**',
      'docker-cache/**',
      'content/**',
      'docs/**',
      'openspec/**',
      '.qoder/**',
      '**/*.java',
      '**/*.py',
      'web/dist/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'no-case-declarations': 'off',
      'no-prototype-builtins': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', 'no-test-prefixes': 'off' },
  },
  {
    // 命令行脚本跑在 node 下，没有浏览器全局但有 process/console
    files: ['scripts/**/*.mjs', '*.mjs', 'server/src/**/*.ts', 'shared/src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        require: 'readonly',
        module: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        TextDecoder: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    // 判题器要剥掉子进程输出里的 ANSI 转义序列，控制字符正则是有意为之
    files: ['server/src/judge/**', 'server/test/judge/**'],
    rules: { 'no-control-regex': 'off' },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
