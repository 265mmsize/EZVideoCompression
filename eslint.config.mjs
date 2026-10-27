import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'tests/fixtures/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map((c) => ({ ...c, files: ['**/*.ts', '**/*.tsx'] })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  {
    // 유지보수 스크립트는 Node 환경에서 실행된다
    files: ['scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // E2E 는 브라우저 안에서 평가되는 콜백을 포함한다. Node 전용 tsconfig 에는 DOM 타입이 없어 unsafe 로 보이므로 그 규칙만 끈다.
    files: ['tests/e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    // 테스트 코드는 픽스처 값을 단언으로 단정한다. 실패 시 즉시 드러나는 편이 낫다.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // IPC 계약은 요청이 없는 채널을 void 로 표현한다 (타입 수준 의미가 필요하다).
    files: ['src/shared/contracts/**/*.ts'],
    rules: { '@typescript-eslint/no-invalid-void-type': 'off' },
  },
  {
    files: ['**/*.config.{ts,mjs}', 'tests/fixtures/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
);
