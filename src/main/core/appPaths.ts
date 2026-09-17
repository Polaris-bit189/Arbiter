import { join } from 'path'

/**
 * 路径环境：项目里所有「原本只能问 electron 要的路径」都收口在这里。
 *
 * **存在的理由（M3）**：`converters/index.ts` 改成按需 `import()` 之后，MCP Server 那条线要在
 * **不 import electron 的进程**里跑 `convert()` 与 `TaskManager`。可这四个值只存在于 Electron
 * 运行时——`app.isPackaged` / `process.resourcesPath` / `app.getAppPath()` / `app.getPath('userData')`。
 *
 * 做法是**注入**，不是「在别处再写一份解析」。`engines/registry.ts` 早就把「dev 与打包路径
 * 完全不同」这件事收口在一处了，再复制一份必然分家——这个仓库已经有过一次
 * `calibreExe()` 与 `calibrePath()` 分家的先例（界面说「已就绪」、每次转换都报找不到）。
 *
 * ⚠️ **这里刻意既不 import electron，也不做「没装就 require('electron') 兜底」**：
 *  - 静态 import 会让这份模块在 MCP 进程里一加载就炸，而它是 TaskManager 的依赖。
 *  - `require('electron')` 在纯 Node 下**不报错**——它返回的是 electron.exe 的路径**字符串**。
 *    于是 `app.isPackaged` 是 `undefined`（判成「未打包」）、`app.getPath` 是
 *    `is not a function`。这是个不报错的降级，正是本项目最想避免的那类 bug。
 *
 * 所以未安装时**直接抛**，报错文案里写清两条入口各自该调什么。
 */
export interface AppPaths {
  /** `app.isPackaged`。决定随包内置引擎落在 `resources/` 还是仓库的 `resources/` 下 */
  isPackaged: boolean
  /** `process.resourcesPath`。只有打包后才有意义，dev 下给空串即可 */
  resourcesPath: string
  /** `app.getAppPath()`。dev 下是仓库根，打包后是 `app.asar` */
  appPath: string
  /** `app.getPath('userData')`。设置 / 历史 / calibre 配置目录都在它下面 */
  userData: string
  /** `app.getPath('downloads')`。源文件没有目录时的兜底输出位置 */
  downloads: string
}

let current: AppPaths | null = null

export function setAppPaths(paths: AppPaths): void {
  current = paths
}

export function appPaths(): AppPaths {
  if (current === null) {
    throw new Error(
      '路径环境未初始化：Electron 入口要调 setAppPaths(appPathsFromElectron(app))，' +
        'MCP 入口要自己调一次 setAppPaths()。测试脚本见 scripts/install-test-paths.ts'
    )
  }
  return current
}

/**
 * electron 的 `app` 里我们真正用到的那几个成员。
 *
 * 刻意声明成结构化接口而不是 `import type { App } from 'electron'`：后者会把 electron 的
 * 类型（连带它的运行时依赖）拉进这份本该零依赖的模块。真实 `App` 与本接口结构兼容，
 * 测试桩（`scripts/electron-stub.ts`）也兼容，所以调用方两边都不用转型。
 */
export interface ElectronAppLike {
  readonly isPackaged: boolean
  getAppPath(): string
  getPath(name: string): string
}

/** Electron 世界的安装入口。两个进程各调一次，别在校验/分支里重复调 */
export function appPathsFromElectron(app: ElectronAppLike): AppPaths {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath ?? '',
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    downloads: app.getPath('downloads')
  }
}

/**
 * 随包内置引擎的位置：`resources/engines/<...>`。
 *
 * 打包前后**只有根不同**，所以逐字重抄一遍三档候选（`engines/registry.ts`、`sevenzip.ts`、
 * `pandoc.ts`、`heavy.ts` 里各一份）不如收口到这里——这正是当年 `calibreExe()` 分家的形态。
 * 调用方仍然自己做 `existsSync`：这份函数只回答「应该去哪儿找」。
 */
export function bundledEnginePath(...parts: string[]): string {
  const paths = appPaths()
  return paths.isPackaged
    ? join(paths.resourcesPath, 'engines', ...parts)
    : join(paths.appPath, 'resources', 'engines', ...parts)
}

/**
 * `appPath` 是不是指进了 asar 内部。
 *
 * 用途只有一个：给 `src/cli/main.ts` 与 `src/mcp/main.ts` 的 `resolvePaths()` 当**装配自检**
 * 的判据——「路径指进 asar 里，却没人告诉入口这是打包形态」。那种组合下
 * `bundledEnginePath()` 会走 dev 分支、拼出一条**落在 asar 内部、必然不存在**的路径，
 * 于是随包引擎全部被判成「没装」（症状是 RAR 悄悄不支持了、一句错都不报，
 * 见 `build/arbiter.cmd` 的注释里那次实测）。
 *
 * 判据按**路径段**而不是子串匹配：`...\resources\app.asar` 与
 * `...\resources\app.asar\out\main\cli.js` 都算，而 `app.asar2` 不算。
 * 与 `engines/registry.ts` 的 `unpackedPath()` 认 `app.asar` 那一段是同一个形状。
 *
 * ⚠️ **松散目录（`resources/app/...`）认不出来**，那是中间试过一版又撤回的布局
 * （见 `electron-builder.yml`）。刻意只认 asar：把 `app` 也当判据的话，
 * 任何叫 `resources/app` 的目录都会触发告警，那是误报。
 */
export function isAsarPath(appPath: string): boolean {
  return appPath.split(/[\\/]/).includes('app.asar')
}
