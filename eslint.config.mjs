import eslint from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // A classic script the browser runs before the bundle, so it is authored
    // against the browser globals rather than Node's.
    files: ['apps/web/public/*.js'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/refs': 'off',
      // A document load tears down the SPA and drops the live WebSocket, so a
      // drill-down would cost a cold start. Anchors to a server download
      // endpoint are the one legitimate exception and carry `download`.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "AssignmentExpression:matches([left.object.name='location'],[left.object.object.name='window'][left.object.property.name='location'])[left.property.name='href']",
          message:
            'Assigning location.href reloads the document and drops the live WebSocket. Use navigate() from lib/router instead.',
        },
        {
          selector:
            'JSXOpeningElement:not(:has(JSXAttribute[name.name="download"])) > JSXAttribute[name.name="href"] Literal[value=/^\\//]',
          message:
            'A raw <a href="/…"> reloads the document and drops the live WebSocket. Use <Link to="…"> from lib/router, or keep the plain anchor and add `download` if it targets a server download endpoint.',
        },
        {
          selector:
            'JSXOpeningElement:not(:has(JSXAttribute[name.name="download"])) > JSXAttribute[name.name="href"] TemplateLiteral[quasis.0.value.raw=/^\\//]',
          message:
            'A raw <a href={`/…`}> reloads the document and drops the live WebSocket. Use <Link to="…"> from lib/router, or keep the plain anchor and add `download` if it targets a server download endpoint.',
        },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: globals.vitest,
    },
  },
)
