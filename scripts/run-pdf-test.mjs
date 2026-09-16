/**
 * 把 scripts/test-pdf.ts 打成一个包再丢给 Electron 跑。
 *
 *   node scripts/run-pdf-test.mjs
 *
 * 为什么不能像别的测试那样 `tsx scripts/test-pdf.ts`：这个测试要真的开一个隐藏
 * BrowserWindow 调 printToPDF，必须有 Electron 运行时；而 Electron 的入口不支持 TS。
 * 所以先用 esbuild 打成一个 CJS 文件，再让 electron 去执行它。
 *
 * `packages: 'external'` 把 node_modules 全部留成 require——sharp 带 `.node` 原生模块，
 * 打进包里必然加载不了；其余依赖留在外部也顺便让报错栈指向真实文件行号。
 * 只有 `@shared/*` 需要自己解析，因为它是 tsconfig 里的路径别名，Node 不认。
 */
import { build } from 'esbuild'
import { spawn } from 'child_process'
import { mkdir, rm } from 'fs/promises'
import { createRequire } from 'module'
import { resolve } from 'path'

// 直接拿 electron.exe 的绝对路径去 spawn。
// 走 'npx.cmd' 在 Node 24 上会 EINVAL：.cmd 是批处理，必须经 shell 才能执行，
// 而新版本为了防注入已经不允许不带 shell 去 spawn 它了。
const require = createRequire(import.meta.url)
const electronPath = require('electron')

const TMP = resolve('.tmp-test-pdf-bundle')
const ENTRY = resolve(TMP, 'entry.cjs')

const sharedAlias = {
  name: 'shared-alias',
  setup(b) {
    b.onResolve({ filter: /^@shared\// }, (args) => ({
      path: resolve('src/shared', args.path.slice('@shared/'.length) + '.ts')
    }))
  }
}

await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

await build({
  entryPoints: [resolve('scripts/test-pdf.ts')],
  outfile: ENTRY,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  plugins: [sharedAlias],
  logLevel: 'warning'
})

const child = spawn(electronPath, [ENTRY], { stdio: 'inherit', windowsHide: false })

child.on('close', async (code) => {
  await rm(TMP, { recursive: true, force: true }).catch(() => undefined)
  process.exit(code ?? 1)
})
