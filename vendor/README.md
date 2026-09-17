# vendor/

`package.json` 里那些**不来自 npm registry** 的依赖，以 tarball 形式随仓库带。

目前只有一件：

| 文件              | 包     | 版本   | 字节数    | sha256                                                             |
| ----------------- | ------ | ------ | --------- | ------------------------------------------------------------------ |
| `xlsx-0.20.3.tgz` | `xlsx` | 0.20.3 | 2,409,319 | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |

## 为什么是 vendor 而不是 URL 依赖

`package.json` 里本来可以直接写 SheetJS 的 CDN 地址：

```json
"xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"
```

那样一行就完事，**实测也确实能用**（国内直连，2.3 秒 / 2.4 MB）。但它有两个代价，
合起来把一个「顺手升级」变成了一条**发布链路上的单点**：

1. **没有任何镜像可回退。** 逐条实测过：

   | 候选源                                          | 结果                                               |
   | ----------------------------------------------- | -------------------------------------------------- |
   | `registry.npmjs.org/xlsx`                       | 最高 **0.18.5**（0.19 起 SheetJS 就不再发 npm 了） |
   | `registry.npmmirror.com/xlsx/-/xlsx-0.20.3.tgz` | 302 → `cdn.npmmirror.com` → **404 NoSuchKey**      |
   | `mirrors.tuna.tsinghua.edu.cn/npm/xlsx/...`     | **404**                                            |

   即 `cdn.sheetjs.com` 是**唯一**来源。本项目其他每一个外部二进制都有多镜像回退
   （见 `resources/engines.manifest.json`），唯独它会是个例外。

2. **`npm ci` 走 URL 依赖时必须直连那个 CDN，不受 registry 镜像影响。**
   而 `.github/workflows/release.yml` 跑在 **GitHub 的海外 runner** 上，
   「那边连不连得上」本机**测不了**（这台机器 GitHub 直连不通，见 docs/NOTES.md 约束 15）。
   连不上时的表现是 `npm ci` 直接失败——**是显式的失败，不是静默出错**，
   所以它不危险；但它会让发版卡在一个与代码无关的地方。

放仓库里，这两条一起消失：**不再依赖网络、任何人都能离线构建**。
代价是仓库多 2.4 MB，以及升级时要手工重放一次（见下）。

## 为什么不用 npm 上的 0.18.5

`xlsx@0.18.5` 是 npm 上的最后一版，带着两个已公开的漏洞：

- **CVE-2023-30533**（原型污染）—— 修在 **0.19.3**
- **CVE-2024-22363**（ReDoS）—— 修在 **0.20.2**

Arbiter 在**主进程**里拿它解析**用户提供的** `.xlsx` / `.xls`，这两个都在路径上。
依据是 0.20.3 包内自带的 `CHANGELOG.md`（`cdn.sheetjs.com/xlsx-0.20.3/CHANGELOG.md`
反而 404，别去那儿找）。

顺带一条实测：0.18.6 起 SheetJS **去掉了全部 npm 依赖**，而 0.18.5 拖着
`adler-32 / cfb / codepage / crc-32 / ssf / wmf / word`（外加级联的 `frac`）。
其中 **`codepage` 一个包就是 5.39 MiB**，比 xlsx 自己还大——所以这次升级之后
**包是变小的**（asar 里 node_modules 从 11.12 MiB 降到 5.67 MiB）。

## 升级 / 重新进货

```bash
# 1. 改下面的版本号，然后跑（脚本自带 sha256 校验，哈希对不上会拒绝落盘）
node scripts/fetch-xlsx.mjs 0.20.3

# 2. 同步 package.json 里那一行的版本
#    "xlsx": "file:vendor/xlsx-0.20.3.tgz"

# 3. 重新解析 lock，并确认它认的是本地文件
npm install
node -e "const l=require('./package-lock.json');console.log(l.packages['node_modules/xlsx'])"
```

**不要**手工把 tarball 拖进来就完事：lock 里的 `integrity` 是 npm 自己算的 sha512，
只有走 `npm install` 才会被写上。少这一步，`npm ci` 会因为 lock 与 `package.json`
对不上而失败。

> 那一行 `integrity` 与 URL 形态下**完全相同**（实测）——也就是说，
> vendor 并没有削弱供应链完整性校验，它只是把「从哪儿取」换掉了。

## 顺带一条给将来的提醒

`xlsx@0.20.3` 新增了 `exports` 字段，而且**没有暴露 `./package.json`**。
所以 `require('xlsx/package.json')` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`
（0.18.5 没有 `exports`，不抛）。实测当前仓库里**零处**这种写法，
但它是那种「将来某天顺手写一句、然后只在运行时炸」的形态。要读版本号就读
`require('xlsx').version`。
