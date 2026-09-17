## 这个 PR 改了什么

<!-- 一两句话。如果是修 bug，先说清楚原来的行为错在哪。 -->

## 为什么

<!-- 如果是个显而易见的笔误，删掉这节。否则请说明动机。 -->

---

## 自查清单

### 1. 我改动了被 `npm run falsify` 覆盖的代码吗？

这套反证脚本会把被测代码**逐处改坏**，确认断言真的会翻红。
**改了源码而不重跑它，等于什么都没验证**——测试全绿和「断言其实抓不住错误」长得一模一样。

```bash
npm run falsify          # doc / pandoc / pdf / ui 四套
npm run falsify:tasks    # 单独一条，要真起 ffmpeg / sharp / 7zip，几分钟
```

- [ ] 跑了，全绿
- [ ] 我改的代码不在覆盖范围内（在下面说明改的是哪一块）

> 如果反证报「变异没生效 / 锚点命中 0 次」，那是**结论无效**，不是通过。
> 重构会静默让锚点失效，需要你去把 `scripts/falsify-*.mjs` 里的锚点改到新位置。
> 顺手确认一下：翻红的**只有**你预期的那些断言，其余保持绿——这能证明断言定位是准的。

### 2. 我加/改了格式吗？

「源格式 → 目标格式」的路由分布在**两个**地方，只改一处等于没改：

- [ ] `src/main/converters/archive.ts` 的 `LAYERED_SRC`（要不要拆第二趟）
- [ ] `src/shared/formats.ts` 的 `register('archive', …)`（能不能作为源被接受）

（套娃格式 `.tgz/.tbz/.tbz2/.txz` 就是踩过这个洞：拆包规则写在代码里，
但那些扩展名没被登记，于是拖进来根本不认，界面上连目标格式都选不出来。）

- [ ] 我没有动格式矩阵

### 3. 我加了新的 CLI 参数吗？

- [ ] 一律 `spawn(exe, args[])`，没有 `exec`、没有 `shell: true`、没有拼字符串
- [ ] 路径过了 `path.resolve()`（以 `-` 开头的文件名会被引擎当成选项）
- [ ] 传用户文件名的地方带了 `--` 分隔符
- [ ] 不适用

### 4. 我引入了新的 npm 依赖吗？

- [ ] 它**没有**被 preload 用到（preload 跑在 sandbox 里，`require()` 只能解析 `electron`，
      被 externalize 的依赖会让 **preload 整个崩掉**，表现为 `window.api` 未定义、拖拽毫无反应）
- [ ] 如果用了原生模块（`.node`），它被提为**直接依赖**并且**内联进包**
      （不能指望它是别人的 optionalDependency——`externalizeDepsPlugin()` 只认 `dependencies`）
- [ ] 没有新依赖

### 5. 常规

- [ ] `npm run typecheck` 通过
- [ ] `npm run lint` 通过
- [ ] 新行为有断言盯着，并且我**真的把它改坏过一次**，确认它会翻红
- [ ] 提交信息符合 `type(scope): summary`（type 限 `feat`/`fix`/`docs`/`style`/`refactor`/`test`/`chore`）

---

<!--
CI 会在每个 PR 上跑：typecheck、lint、三个纯逻辑测试套件、以及反证。
慢的那几套（真起 ffmpeg / sharp / 7z / pandoc 子进程、真起 Electron 打印 PDF）
排在 nightly，不会卡住你的 PR。
-->
