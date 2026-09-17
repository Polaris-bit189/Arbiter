import { existsSync } from 'fs'
import { dirname, join } from 'path'
import { bundledEnginePath } from '../core/appPaths'
import { getSettings } from '../core/settings'

/**
 * 重型引擎（LibreOffice / Calibre）的可执行文件解析。
 *
 * 路子与 sevenzip.ts / pandoc.ts 完全一样：`app.isPackaged` 双分支 + 候选路径数组 +
 * `existsSync` + 缓存。区别只在候选路径长——这两个引擎是用 `msiexec /a`
 * （administrative install，免管理员）解包的**原始目录树**，不是那种单文件免安装版，
 * 所以路径里必然带着 MSI 的目录结构（见约束 16：`7z x` 解 MSI 会把树压平到不可用，
 * 唯一可行的是 `msiexec /a`）：
 *
 *   LibreOffice  engines/libreoffice/program/soffice.exe
 *                `program/` 直接落在根上，**没有** `PFiles64\` 那类前缀目录。
 *   Calibre      engines/calibre/PFiles64/Calibre2/ebook-convert.exe
 *                `PFiles64/Calibre2/` 前缀是固定的，别按 LibreOffice 的形状去猜。
 *
 * 判据刻意只声明实测过的部分：LibreOffice 走「两文件法」；Calibre 的内部布局**没有
 * 实测过**，所以判据只到 `ebook-convert.exe` 存在为止，不额外宣称它还需要什么。
 */

let loCache: string | null | undefined
let calibreCache: string | null | undefined

/** 打包后引擎随包放在 resources/engines/ 下（extraResources，不进 asar） */
function bundledLibreOffice(): string | null {
  const candidate = bundledEnginePath('libreoffice', 'program', 'soffice.exe')
  return existsSync(candidate) ? candidate : null
}

/** 打包后引擎随包放在 resources/engines/ 下（extraResources，不进 asar） */
function bundledCalibre(): string | null {
  const candidate = bundledEnginePath('calibre', 'PFiles64', 'Calibre2', 'ebook-convert.exe')
  return existsSync(candidate) ? candidate : null
}

/**
 * 按需下载的落地位置：解到 `engineDir/<引擎名>/` 下，内部布局与随包内置那份一模一样
 * （都是同一份 MSI 解出来的），所以后缀路径直接复用。
 */
function downloaded(name: string, ...rest: string[]): string | null {
  const candidate = join(getSettings().engineDir, name, ...rest)
  return existsSync(candidate) ? candidate : null
}

/**
 * 用户自己装过 LibreOffice 就直接复用，省掉 357 MB 的下载。
 *
 * 两个候选对应 64 位与 32 位机器级安装（LibreOffice 到 26.8 仍发 32 位 win 包）。
 * 注意 `soffice.com` 是同目录的兄弟文件，**只在需要捕获输出时才用它**
 * ——`soffice.exe --version` 退出码 0 但输出 0 字节，是个不报错的坑（见约束 16）。
 */
function systemLibreOffice(): string | null {
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)'] as const) {
    const base = process.env[key]
    if (!base) continue
    const candidate = join(base, 'LibreOffice', 'program', 'soffice.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** 用户自己装过 Calibre 就直接复用。6.x 之后只有 64 位包，所以不查 ProgramFiles(x86) */
function systemCalibre(): string | null {
  const base = process.env.ProgramFiles
  if (!base) return null
  const candidate = join(base, 'Calibre2', 'ebook-convert.exe')
  return existsSync(candidate) ? candidate : null
}

/**
 * LibreOffice 就绪判据：`soffice.exe` 是个瘦壳启动器，真身是**同目录的 `soffice.bin`**，
 * 缺了它 `soffice.exe` 根本起不来。所以「旁边有同名 bin」既是就绪判据，也省掉了每次解析
 * 都跑一遍 `soffice.com --version`（那是一次进程启动）。
 *
 * 与 sevenzip.ts 里「`7z.exe` 旁边必须有 `7z.dll`」是同构同理的：MSI 解包时若目录结构
 * 被压平（`7z x` 的典型后果），exe 还在、同目录的兄弟文件却没了，硬跑就是
 * `0xC0000135` (STATUS_DLL_NOT_FOUND)，所以这个检查不是多余的。
 */
function isLibreOfficeUsable(exe: string): boolean {
  return existsSync(join(dirname(exe), 'soffice.bin'))
}

/**
 * 顺序与 pandoc.ts 一致：随包内置优先（版本与行为是我们验过的），其次是按需下载那份
 * （版本也是我们挑的），最后才是系统安装——它的版本未知。
 */
export function libreOfficePath(): string | null {
  if (loCache === undefined) {
    const candidates = [
      bundledLibreOffice(),
      downloaded('libreoffice', 'program', 'soffice.exe'),
      systemLibreOffice()
    ]
    // 这里是「存在且可用」两个条件，所以不能用 find(existsSync)：某条候选有 exe 但没有
    // 兄弟 bin（比如只下了一半）时要继续往下试，而不是就此判定没有引擎。
    loCache = candidates.find((c) => c !== null && isLibreOfficeUsable(c)) ?? null
  }
  return loCache
}

export function calibrePath(): string | null {
  if (calibreCache === undefined) {
    calibreCache =
      bundledCalibre() ??
      downloaded('calibre', 'PFiles64', 'Calibre2', 'ebook-convert.exe') ??
      systemCalibre()
  }
  return calibreCache
}

/**
 * 清掉两条缓存，强制下一次解析重新探测。
 *
 * 必须有这个函数，是因为缓存是**三态**的：`undefined` 是「还没探过」，`null` 是
 * 「探过了、没有」。探测失败的结果同样会被写进缓存并永久生效——首次解析没找到引擎，
 * 此后无论磁盘上多了什么，两个函数都一直返回 null。用户可见的表现是：关于页显示
 * 「LibreOffice / Calibre 未就绪」→ 用户照提示装好（或按需下载完成）→ 回到关于页
 * **永远还是未就绪**，只能重启应用。
 *
 * 所以凡是「用户可能在这之后才补上引擎」的入口（重新检测、按需下载落盘、
 * 引擎目录设置变更）都要在重新探测前调一次它。
 */
export function resetHeavyCache(): void {
  loCache = undefined
  calibreCache = undefined
}
