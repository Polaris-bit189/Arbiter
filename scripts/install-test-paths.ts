import { app } from 'electron'
import { appPathsFromElectron, setAppPaths } from '../src/main/core/appPaths'

/**
 * 测试脚本的路径环境安装。**这是唯一一份安装代码。**
 *
 * `core/appPaths.ts` 刻意不 import electron、也不做「找不到就 require('electron') 兜底」
 * （理由写在它的文件头），所以凡是会走到设置 / 历史 / 引擎路径解析的测试脚本都得先装一次。
 * 需要它的四个：`test-tasks` / `test-pandoc` / `test-pdf` / `bench`。
 *
 * 用法是各脚本的**第一行** import：
 *
 *   import './install-test-paths'
 *
 * 位置承重——import 先于模块体求值，所以放在最前面才能保证它跑在任何被测模块的
 * **加载期**之前。虽然 M3 之后各模块自己也不许在加载期读路径（`core/settings.ts`
 * 的存储实例为此改成了惰性创建），但把这条保证压在「我确信没有模块在加载期读它」上，
 * 不如让它由 import 顺序直接兜住。
 *
 * `electron` 经 `tsconfig.test.json` 的 paths 映射到 `scripts/electron-stub.ts`，
 * 于是 userData 落在项目内的 `.tmp-test-stub/` 下，不会污染用户真实的 AppData。
 * （`test-pdf.ts` 是个例外：它真的跑在 Electron 里，拿到的是真的 `app`——那正是它要的。）
 */
setAppPaths(appPathsFromElectron(app))
