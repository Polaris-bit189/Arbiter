/**
 * asar 归档的最小只读探测。
 *
 * ## 为什么需要它
 *
 * **asar 对普通 Node 来说是个不透明的大文件。** asar 支持是 Electron 运行时打补丁
 * 打进 `fs` 的，而这个启动器是被 `.mcp.json` 里的 `command: "node"` 起的**普通 Node**，
 * 于是 `existsSync('<...>/app.asar/out/main/mcp.js')` **恒为 false**。
 *
 * 后果很具体（2026-09-13 实测踩到）：打包分支把「装着刚 build 出来的包」判成
 * 「这个安装包可能早于 MCP 功能（< 0.2.0）」——判断错，提示的方向还是反的。
 * 而且它在开发机上**永远不现形**：`candidateRoots()` 里有仓库根，那条路走的是
 * 普通文件系统，一切正常。**只有干净机器（M5 的验收场景）才会撞上**，
 * 也就是只在用户那里炸。
 *
 * ## 格式
 *
 * 头部 16 字节：偏移 0 处 `UInt32LE = 4`（pickle 头），偏移 4 / 8 处是含自身长度的
 * 头长（本实现不需要），偏移 12 处是 **JSON 索引的字节数**；紧跟着就是那段 JSON。
 * 索引是个目录树，每层 `files.<名字>`，叶子带 `size` / `offset`。
 * 这里只读头部那点字节，不碰几十 MB 的载荷。
 *
 * ## 为什么单独一个文件
 *
 * `launch.mjs` 有顶层副作用（解析目标、拉起子进程），**import 它就会真的去起进程**，
 * 所以纯逻辑得拆出来才能被 `scripts/test-plugin-launch.mjs` 直接 import。
 */
import { closeSync, openSync, readSync } from 'fs'

/** 索引长度的上限。索引总是远小于载荷，这条只是别让一个损坏的头把内存吃光。 */
const MAX_INDEX_BYTES = 64 * 1024 * 1024

/**
 * asar 里有没有这个条目。`entry` 用正斜杠分隔、不带前导斜杠，如 `out/main/mcp.js`。
 *
 * 任何读不动的情况（文件不存在、头是坏的、JSON 解不开）一律返回 `false`——
 * 调用方拿它当「这个形态不可用」的判据，而不是当断言，所以不该抛。
 */
/**
 * 读出 asar 头里那份 JSON 索引。**任何读不动的情况一律返回 `null`**
 *（文件不存在、头是坏的、JSON 解不开）——两个出口都拿它当「读不到」而不是当断言。
 *
 * 只读头部、不碰载荷：索引总是远小于载荷，`MAX_INDEX_BYTES` 只是别让一个坏头吃光内存。
 */
function readIndex(asarPath) {
  let fd
  try {
    fd = openSync(asarPath, 'r')
    const head = Buffer.alloc(16)
    if (readSync(fd, head, 0, 16, 0) !== 16) return null
    const size = head.readUInt32LE(12)
    if (!size || size > MAX_INDEX_BYTES) return null
    const index = Buffer.alloc(size)
    if (readSync(fd, index, 0, size, 16) !== size) return null
    return JSON.parse(index.toString('utf8'))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function asarHasEntry(asarPath, entry) {
  const index = readIndex(asarPath)
  if (index === null) return false

  let node = index
  for (const part of entry.split('/').filter(Boolean)) {
    node = node?.files?.[part]
    if (!node) return false
  }
  return true
}

/**
 * asar 里**所有**条目的路径（正斜杠分隔、不带前导斜杠）。读不到就返回空数组。
 *
 * 存在的理由是 **`docs/NOTES.md` 约束 30 的那条守卫**：`electron-builder` 的 `files`
 * 规则**不看 `.gitignore`**，所以任何一次测试崩溃或被 kill 留下的 `.tmp-*` /
 * `.scratch-*` 目录都会被**静默**打进 asar —— 实测过一次瘦包从 141 MB 涨到 446 MB，
 * 而构建全程零报错。这条守卫原来只能人工查（`ls -d .tmp-*` + 读 asar 头），
 * 现在由 `scripts/test-plugin-launch.mjs` 在打包之后自动查一遍。
 */
export function asarEntryNames(asarPath) {
  const index = readIndex(asarPath)
  if (index === null) return []

  const out = []
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = prefix === '' ? name : `${prefix}/${name}`
      if (child && typeof child === 'object' && child.files) walk(child, path)
      else out.push(path)
    }
  }
  walk(index, '')
  return out
}
