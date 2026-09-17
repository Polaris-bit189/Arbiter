import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// main / preload / renderer 三份配置共用同一份 shared 源码
const shared = resolve('src/shared')

// 构建期注入的版本号。**唯一的出处**是 package.json —— electron-builder 的
// `version` 也读它，两边不会漂。消费者只有 `src/main/core/downlink.ts` 的 UA
// （第三方审计 N1：0.3.2 的包里 UA 还写着 0.3.1）。
//
// ⚠️ 只有 electron-vite 构建出来的产物才有这个常量；tsx 跑的测试与 esbuild 打的脚本
// 都没有，那边靠 `typeof` 判断回落 'dev'（取舍写在 downlink.ts 的 `USER_AGENT` 注释里）。
const appVersion = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }
).version

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': shared }
    },
    // UA 的版本段（`downlink.ts` 的 `USER_AGENT`）在构建期注进来，值就是 package.json 的
    // version。三个入口（index / mcp / cli）都在这一份配置里，所以一处就够了；
    // preload 与 renderer 不用它，不加。
    define: { __ARBITER_VERSION__: JSON.stringify(appVersion) },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 三个入口：应用本体、MCP server、以及 CLI。
        //
        // **MCP 与 CLI 两条必须进构建产物**，不能只活在仓库里：Claude Code 的插件安装在
        // `~/.claude/plugins/cache/` 下，那里既没有 node_modules 也没有 ffmpeg / sharp，
        // 插件只能**借宿主**——找到本机装好的 Arbiter，用它的 Electron 以
        // `ELECTRON_RUN_AS_NODE=1` 跑 `resources/app.asar/out/main/{mcp,cli}.js`。
        // 所以这两个入口是 M4/M5 与 E-1 的接缝，删掉它们插件就成了空壳。
        //
        // ⚠️ **CLI 不能靠「再起一个 app 实例」实现**：`src/main/index.ts` 有单实例锁
        // （`requestSingleInstanceLock()`），第二个进程会立刻 `app.quit()`。
        // 所以它和 MCP 走同一条路——以 Node 模式跑应用内的入口脚本，而不是起 Electron 本体。
        //
        // ⚠️ **但 `index` 这个入口现在多了一个身份**（审计 2026-09-15 §3.1）：CLI / MCP 要
        // 生成 PDF 时唯一的路就是起一个**真的 Electron**（Chromium 排版没有替代品），
        // 于是 `index.js` 会被 `Arbiter.exe --arbiter-pdf-worker=…` 当宿主再起一次。
        // 它之所以没被上面那条单实例锁挡住，是因为那个分支**刻意排在锁之前**——
        // 见 `src/main/index.ts` 里那段注释，顺序在那儿是承重的。
        input: {
          index: resolve('src/main/index.ts'),
          mcp: resolve('src/mcp/main.ts'),
          cli: resolve('src/cli/main.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': shared }
    },
    // 注意：preload 不能 externalize。
    // sandbox:true 的 preload 里 require() 只能解析 electron 及其内建模块，
    // 任何被外部化的 npm 依赖都会在运行时 "module not found" 并让 preload 整个崩掉
    // （表现为 window.api 未定义、拖拽毫无反应）。必须让 Vite 把依赖内联进来。
    build: {
      rollupOptions: {
        external: ['electron']
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': shared
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
