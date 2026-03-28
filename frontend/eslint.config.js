import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // react-hooks v7 — enable as warnings (errors are too strict for large components)
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
      // Relaxed for existing codebase — tighten over time
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-unused-expressions': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': 'warn',
      // Downgrade to warn: large components + react-hooks v7 new strictness
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  { ignores: ['dist/', 'node_modules/', '*.config.*'] },
)
