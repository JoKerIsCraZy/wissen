import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        require: 'readonly',
        module: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly', queueMicrotask: 'readonly',
        fetch: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly', TextDecoder: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
      }],
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-undef': 'error',
      'no-redeclare': 'error',
      'prefer-const': 'warn',
      'no-var': 'error'
    }
  },
  {
    files: ['test/**/*.js'],
    languageOptions: {
      globals: {
        describe: 'readonly', it: 'readonly',
        before: 'readonly', after: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly'
      }
    }
  },
  {
    // .mjs-Testdateien sind native ES-Module (import/export). Der Default-Block
    // oben deklariert sourceType:'commonjs', was den Parser bei import/export
    // abbrechen laesst — hier auf ES-Module umstellen + node:test-Globals.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        describe: 'readonly', it: 'readonly',
        before: 'readonly', after: 'readonly',
        beforeEach: 'readonly', afterEach: 'readonly'
      }
    }
  },
  {
    // src/scraper.js fuehrt Code in page.evaluate()/safeEvaluate()-Callbacks
    // aus, die IM BROWSER laufen - Browser-Globals dort als readonly
    // deklarieren, sonst flaggt no-undef document/location faelschlich.
    files: ['src/scraper.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        location: 'readonly',
        window: 'readonly',
        navigator: 'readonly'
      }
    }
  }
];
