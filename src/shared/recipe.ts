import type { RemuxMode } from './types'

/**
 * 配方文件（R15）——把「这次要转成什么」从命令行参数挪进一份可保存、可分享的文件。
 *
 * ## 只做两个字段，而且是**故意的**
 *
 * `target` 与 `mode` 是今天就能真的生效的两项。**绝不先摆没接通的字段**——
 * 那会变成第二份「看着有、其实被忽略」的配置，而这个仓库已经为那个形状付过一次账
 * （`convert_file` 那个被删掉的死参数 `quality`，见 `src/mcp/schema.ts` 的注释）。
 * 想加字段，先让它接通。
 *
 * ## 配方是**不可信输入**
 *
 * 它是一份用户（或 agent）手写的 JSON，可能来自版本控制、可能来自别人分享的 Gist。
 * 所以解析的口径是**逐字段宽容 + 把坏字段报出来**：
 *
 * - **不整份拒**：一个字段写错不该让另外那个能用的字段一起作废。
 * - **但一定要报**：默默用默认值顶上，就是「用户以为设了、其实没设」——
 *   本项目最忌讳的那类静默失败，而它伪装成成功。
 *
 * ⚠️ **别把它做成「配方能跑任意命令」**：那等于在这个项目里开一个任意代码执行的口子，
 * 而配方的全部价值只是「记住几个选项」。`target` 与 `mode` 都是**闭集**，
 * 认不出的值一律进 `problems`，永远不参与执行。
 */

/** 一份配方。两个字段都可以缺——缺的那个由调用方的默认档顶上 */
export interface Recipe {
  /** 目标扩展名。**不带点、小写**（解析时已经归一过） */
  target?: string
  mode?: RemuxMode
}

export interface RecipeParse {
  recipe: Recipe
  /**
   * 认不出来的字段与值，**逐条说清**（带字段名与它实际是什么）。
   *
   * 空数组表示整份都认了。调用方**必须**把它显示出来——CLI 打 stderr、
   * MCP 放进返回值——否则这份配方的作者永远不知道自己写错了一个键名。
   */
  problems: string[]
}

const MODES: ReadonlySet<string> = new Set(['auto', 'remux', 'reencode'])

/**
 * 目标扩展名的形状。
 *
 * 只做**形态**校验（字母/数字，2~10 位），**不查能力矩阵**——那一层在
 * `formats.ts` 里，而这里是个零依赖的 shared 模块（preload 之外谁都能引，
 * 见 `channels.ts` 那条先例）。查错了的后果由调用方那条既有校验兜住
 * （「这个格式组合不支持」本来就是它该说的话）。
 */
const TARGET_RE = /^[a-z0-9]{1,10}$/

/** 归一：`--to .MP4` / `"MP4"` / `".mp4"` 都收成 `mp4`（与 `core/cli.ts` 同一套口径） */
function normalizeTarget(value: string): string {
  return value.trim().replace(/^\.+/, '').toLowerCase()
}

/**
 * 解析一份已经 `JSON.parse` 过的东西。
 *
 * 传进来的是 **`unknown` 而不是字符串**：读文件与 `JSON.parse` 是调用方的事，
 * 这样这一个函数就**零 I/O、零依赖**，能直接喂对象进来测。
 * （JSON 语法错误那句话由 `JSON.parse` 自己说，比这里再包一层准确。）
 */
export function parseRecipe(value: unknown): RecipeParse {
  const problems: string[] = []
  const recipe: Recipe = {}

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      recipe,
      problems: [`配方得是一个 JSON 对象，拿到的是 ${Array.isArray(value) ? '数组' : typeof value}`]
    }
  }

  const raw = value as Record<string, unknown>

  for (const key of Object.keys(raw)) {
    if (key !== 'target' && key !== 'mode') {
      // 认不出的键**不改动任何东西**，只记一条。写错键名是最常见的一种错，
      // 而它的表现是「配了没反应」——不说出来就永远查不到。
      problems.push(`认不出的字段「${key}」（这份配方只认 target 与 mode），已忽略`)
    }
  }

  if (raw.target !== undefined) {
    if (typeof raw.target !== 'string') {
      problems.push(`target 得是字符串，拿到的是 ${typeof raw.target}，已忽略`)
    } else {
      const normalized = normalizeTarget(raw.target)
      if (!TARGET_RE.test(normalized)) {
        problems.push(`target「${raw.target}」不像个扩展名，已忽略`)
      } else {
        recipe.target = normalized
      }
    }
  }

  if (raw.mode !== undefined) {
    if (typeof raw.mode !== 'string' || !MODES.has(raw.mode)) {
      problems.push(`mode「${String(raw.mode)}」不认（只能是 auto / remux / reencode），已忽略`)
    } else {
      recipe.mode = raw.mode as RemuxMode
    }
  }

  return { recipe, problems }
}

/**
 * 这份配方**一个字段都没认出来**吗。
 *
 * 调用方据此决定「整份拒」还是「用能用的、把坏的报出来」：
 * 部分坏 → 用好的（宽容）；**全坏或空** → 拒。后者是刻意的——
 * 一份什么都没设的配方一定是个错误（写错了顶层键名、或者拿到一份别的工具的配置），
 * 而默默按默认档跑完、还报成功，正是这个模块最想堵的那件事。
 */
export function isRecipeEmpty(recipe: Recipe): boolean {
  return recipe.target === undefined && recipe.mode === undefined
}
