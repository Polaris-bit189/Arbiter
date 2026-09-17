/**
 * 第三方静态审计（Arbiter 0.3.2）两条修复的窄测试：
 *
 *   N1 —— UA 的版本段改成**构建期注入**，别再手写（0.3.2 的包里还写着 0.3.1）
 *   O3 —— CSP 的 `connect-src` 收紧成 `'self'`（去掉 dev HMR 遗留的 `ws: wss:`）
 *
 *   npx tsx --tsconfig tsconfig.test.json scripts/test-audit-n1-o3.ts
 *
 * ⚠️ **本文件还没进 `npm run test` 的聚合**：加一条 script 要动 package.json，而那一份
 * 不在本次改动的文件集里。要让它长期有牙，得把 `test:audit` 接进聚合那条链
 * ——「不跑的测试就是不存在的测试」。
 *
 * 两条各自的坑（都写成了断言，别当成可有可无）：
 *
 *   N1：注入的常量只活在构建产物里，tsx / esbuild 的路径上**根本不存在**。所以
 *       · `typeof` 那层必须真的生效（第 1 条：本文件 import 成功即是证据，写漏了是
 *         整个模块加载期 ReferenceError，一条断言都跑不到）；
 *       · define 那半必须真能把 `typeof` 里的标识符替换掉（最后两条：拿配置里那个
 *         define 真打一遍产物，再**真加载它**读出 UA 逐字比对）。
 *       只测一头都会漏——`typeof` 写对了但 define 没生效，产物里就是 `Arbiter/dev` 发出去。
 *
 *   O3：断言的那份 html 必须是**构建真正用的那一份**（第 5、6 条），否则就成了
 *       「对着一个没人用的文件断言」——本项目抓过四次的装饰性断言都是这个形状。
 */
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { build } from 'esbuild'
import viteConfig from '../electron.vite.config'
import { USER_AGENT } from '../src/main/core/downlink'

const ROOT = resolve('.')
const TMP = resolve('.tmp-test-audit-n1-o3')
const INDEX_HTML = resolve('src/renderer/index.html')
const BUILT_HTML = resolve('out/renderer/index.html')
const UA_SUFFIX = ' (+https://github.com/Polaris-bit189/Arbiter)'

let passed = 0
let failed = 0
let skipped = 0

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail ? `  ← ${detail}` : ''}`)
  }
}

function skip(label: string, why: string): void {
  skipped += 1
  console.log(`  · 跳过 ${label} —— ${why}`)
}

const pkgVersion = (
  JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }
).version

/**
 * 取出 CSP meta 的 content。**找不到就抛**——下游那几条断言要的是「恰有一条」，
 * 返回空串会让它们**在空字符串上恒真**（本项目抓过的装饰性断言正是这个形状）。
 */
function cspContent(html: string): string {
  const metas = [...html.matchAll(/<meta[^>]*http-equiv="Content-Security-Policy"[^>]*>/gi)]
  if (metas.length !== 1) throw new Error(`期望恰好 1 条 CSP meta，实际 ${metas.length} 条`)
  const content = /content="([^"]*)"/i.exec(metas[0][0])
  if (!content) throw new Error('CSP meta 里没有 content 属性')
  return content[1]
}

/** `a=b; c=d` → Map（键小写，值是 token 数组） */
function cspDirectives(content: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of content.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const [name, ...values] = trimmed.split(/\s+/)
    out.set(name.toLowerCase(), values)
  }
  return out
}

/** 把 esbuild 的 CJS 产物放进 vm 里执行，只为读它导出的常量——不起进程、不碰真文件系统 */
function loadCjs(code: string): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {
    module: { exports: {} },
    exports: {},
    // 产物里 `require('electron')` / `require('node:fs')` 都还在（packages: 'external'），
    // 这里一律给个空对象：要读的是**模块级常量**，一个函数都不会调。
    require: () => ({}),
    process,
    console,
    Buffer,
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval
  }
  createContext(sandbox)
  runInContext(code, sandbox)
  return (sandbox.module as { exports: Record<string, unknown> }).exports
}

// ---------------------------------------------------------------- [1] N1 UA 版本

async function testUserAgentVersion(): Promise<void> {
  console.log('\n[1] N1 · UA 的版本段（构建期注入 / 无构建时回落）')

  // 这一条其实是整个模块的加载：`downlink.ts` 里若把 `typeof __ARBITER_VERSION__` 写成
  // 裸引用，tsx 会在**导入期**就 ReferenceError（红在 import 上，连这条都跑不到）。
  const versionSegment = /^Arbiter\/([^ ]+) \(/.exec(USER_AGENT)?.[1]
  check(
    'tsx 路径下 UA 回落成 `dev`（注入的常量在这里不存在，且没有 ReferenceError）',
    versionSegment === 'dev',
    `USER_AGENT=${USER_AGENT}`
  )
  check(
    'UA 形状 = `Arbiter/<版本> (+https://github.com/Polaris-bit189/Arbiter)`',
    /^Arbiter\/[^ ()]+ \(\+https:\/\/github\.com\/Polaris-bit189\/Arbiter\)$/.test(USER_AGENT),
    USER_AGENT
  )
  check(
    'UA 不像浏览器那一串（清华 TUNA 对浏览器 UA 回 403）',
    !/Mozilla|AppleWebKit|Chrome|Safari|Electron/i.test(USER_AGENT),
    USER_AGENT
  )

  // ---- 注入侧：配置里那个 define 必须存在、且取自 package.json
  const mainConfig = viteConfig.main
  const define =
    mainConfig && typeof mainConfig !== 'function'
      ? (mainConfig.define as Record<string, string> | undefined)
      : undefined
  const injected = define?.__ARBITER_VERSION__
  check(
    '`electron.vite.config.ts` 的 main 配置里注入了 `__ARBITER_VERSION__`',
    typeof injected === 'string',
    `define=${JSON.stringify(define)}`
  )
  check(
    `注入的自变量就是 package.json 的 version（${pkgVersion}）`,
    injected === JSON.stringify(pkgVersion),
    `injected=${injected}`
  )
  check(
    'preload / renderer 不注入（用不到的东西别加）',
    [viteConfig.preload, viteConfig.renderer].every(
      (section) => !section || typeof section === 'function' || section.define === undefined
    )
  )

  // ---- 产物侧：拿配置里那个 define 真打一遍，再**真加载它**读 UA。
  // 判据是逐字比对，不是「产物里有 0.3.2 这几个字符」——后者会被注释/源映射之类的东西
  // 假绿，而且那样写的断言在 define 没生效时也照样绿（本项目抓过的装饰性断言里就有这种）。
  // Vite 构建期的 define 走的也是 esbuild（`vite:define` → `transformWithEsbuild`），
  // 所以这里的口径与真构建一致。
  await mkdir(TMP, { recursive: true })
  const bundlePath = resolve(TMP, 'downlink.bundle.cjs')
  await build({
    entryPoints: [resolve('src/main/core/downlink.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    define: { __ARBITER_VERSION__: JSON.stringify(pkgVersion) },
    outfile: bundlePath,
    logLevel: 'silent'
  })
  const code = readFileSync(bundlePath, 'utf8')
  const builtUa = loadCjs(code).USER_AGENT
  check(
    `按构建期的 define 打包后，UA 逐字等于 \`Arbiter/${pkgVersion}${UA_SUFFIX}\``,
    builtUa === `Arbiter/${pkgVersion}${UA_SUFFIX}`,
    `产物里读出来的是 ${JSON.stringify(builtUa)}`
  )
  check(
    '打包产物里不再有裸标识符 `__ARBITER_VERSION__`（说明替换真的发生了）',
    !code.includes('__ARBITER_VERSION__')
  )
  check(
    '回落值 `dev` 仍在（无 define 的路径——测试与脚本——拿得到字符串）',
    code.includes('"dev"') && USER_AGENT === `Arbiter/dev${UA_SUFFIX}`
  )
}

// ---------------------------------------------------------------- [2] O3 CSP

async function testCsp(): Promise<void> {
  console.log('\n[2] O3 · 渲染进程 CSP 的 connect-src')

  const html = readFileSync(INDEX_HTML, 'utf8')
  const content = cspContent(html)
  const directives = cspDirectives(content)

  check(
    "connect-src 恰好是 `'self'`（没有 ws: / wss: / * / 远程主机）",
    JSON.stringify(directives.get('connect-src')) === JSON.stringify(["'self'"]),
    `connect-src=${JSON.stringify(directives.get('connect-src'))}`
  )
  check('整条 CSP 里不再出现 ws: / wss:', !/\bwss?:/.test(content), content)
  check(
    "script-src 与 default-src 都是 `'self'`（无 'unsafe-inline'、无远程源）",
    JSON.stringify(directives.get('script-src')) === JSON.stringify(["'self'"]) &&
      JSON.stringify(directives.get('default-src')) === JSON.stringify(["'self'"]),
    `script-src=${JSON.stringify(directives.get('script-src'))} / default-src=${JSON.stringify(directives.get('default-src'))}`
  )
  check(
    '没有任何指令放行远程来源（http:/https:/通配 *）',
    [...directives.entries()].every(([, values]) =>
      values.every((v) => !/^https?:/i.test(v) && v !== '*')
    ),
    content
  )

  // ---- 断言的对象必须真的是构建入口，不然就是在对着没人用的文件断言
  const rendererCfg = viteConfig.renderer
  const rendererRootOverridden =
    !!rendererCfg && typeof rendererCfg !== 'function' && rendererCfg.root !== undefined
  check(
    '渲染进程的 root 没被覆写（electron-vite 默认就是 `src/renderer`，即本文件断言的这份）',
    !rendererRootOverridden
  )
  const htmlInRendererDir = readdirSync(resolve('src/renderer')).filter((f) => f.endsWith('.html'))
  check(
    '`src/renderer` 下只有一个 html（断言的对象唯一，不存在第二份入口）',
    htmlInRendererDir.length === 1 && htmlInRendererDir[0] === 'index.html',
    htmlInRendererDir.join(', ')
  )

  // ---- 已构建产物（有条件）：只有产物**比源文件新**时才比它，否则那是上一次构建留下的
  // 老现场，拿它判红只会误导人（本轮就撞上过：out/ 里那份还是带 ws 的旧产物）。
  // 跳过会计入汇总并单独报出来——不让它静静地冒充通过。
  const builtStat = statSync(BUILT_HTML, { throwIfNoEntry: false })
  if (!builtStat) {
    skip('out/renderer/index.html 与源文件一致', '还没有构建产物')
  } else if (builtStat.mtimeMs <= statSync(INDEX_HTML).mtimeMs) {
    skip('out/renderer/index.html 与源文件一致', '产物早于源文件（下次构建后再看这条）')
  } else {
    const built = cspContent(readFileSync(BUILT_HTML, 'utf8'))
    check(
      '构建产物里的 CSP 与源文件一致（构建没把它改宽）',
      !/\bwss?:/.test(built) &&
        JSON.stringify(cspDirectives(built).get('connect-src')) ===
          JSON.stringify(directives.get('connect-src')),
      built
    )
  }
}

// ---------------------------------------------------------------- 主流程

async function main(): Promise<void> {
  console.log('=== 审计 N1（UA 版本）/ O3（CSP connect-src）===')
  console.log(`package.json version = ${pkgVersion}（cwd=${ROOT}）`)

  const sections: [string, () => Promise<void>][] = [
    ['N1 · UA 版本段', testUserAgentVersion],
    ['O3 · CSP', testCsp]
  ]
  try {
    for (const [name, section] of sections) {
      try {
        await section()
      } catch (error) {
        // 小节里冒出未预期的异常时，记一条红并继续跑后面的——
        // 否则一个异常就把剩下的断言全盖住，红的是「崩了」而不是「哪条错了」
        check(
          `${name} 整段跑完（未抛异常）`,
          false,
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        )
      }
    }
  } finally {
    rmSync(TMP, { recursive: true, force: true })
  }

  console.log(`\n=== 通过 ${passed} / 失败 ${failed} / 跳过 ${skipped} ===`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
