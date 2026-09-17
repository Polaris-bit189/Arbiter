import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // resources/engines/ 是用 msiexec /a 解包出来的原始引擎目录树
      // （LibreOffice 19,461 个文件 / 1.49 GiB、Calibre 1,344 个），
      // 里面全是第三方 vendored 代码，不是我们的源码。
      // 不排除的话 eslint 会去 lint Calibre 自带的 mathjax/*.js、editor.js，
      // 而且还要在 Windows 上 stat 掉 LibreOffice 那一万九千个文件——
      // 实测 `npm run lint` 跑 7 分钟都没有任何输出。
      // 这个目录本身也在 .gitignore 里（下载物，可用脚本再生）。
      '**/resources/engines'
    ]
  },
  tseslint.configs.recommended,
  {
    // 下划线前缀的参数 = 「签名要求给、这里用不上」。测试里最典型的是
    // `new TaskManager((_m: TasksPatchMessage) => {})`——那个 broadcast 回调必须传，
    // 但这条用例根本不关心推送。**必须在 recommended 之后**：flat config 是后者覆盖前者，
    // 写在前面会被 recommended 的默认值盖掉。
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    // 纯 JS 文件（scripts/ 下的 .mjs 工具脚本）写不了返回类型注解，
    // 这条规则在它们身上无从满足，只能关掉；TS 文件仍然受约束。
    files: ['**/*.mjs', '**/*.js'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  eslintConfigPrettier
)
