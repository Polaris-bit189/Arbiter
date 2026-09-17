; Arbiter 安装包的 NSIS 自定义片段。
;
; electron-builder 在 `directories.buildResources`（这里是 build/）下自动找这个文件名
; 并 `!include` 它，不需要在 electron-builder.yml 里写任何配置。
;
; ⚠️ 整个文件是 **UTF-8 带 BOM**。makensis 只在看见 BOM 或显式给了 `/INPUTCHARSET UTF8`
; 时才按 UTF-8 读脚本，否则按系统 ANSI 码页（中文机器上是 GBK）解——那样这段中文注释
; 会变成乱码。注释乱码本身无害，但它说明**文件里的字符串**也在同一条路上，
; 将来往这里加中文文案时就会静默写坏。BOM 是这一步的保险。

!macro customUnInstall
  ; ---- 右键菜单（M8）的注册表清理 ----
  ;
  ; 必须在这里删，而不能只依赖应用内那个开关：用户点「卸载」时不会先回去把开关关掉。
  ; 留下的后果不是「多一条无用记录」——那个键指向一个**已经被删掉的 exe**，
  ; 右键菜单里那一项还在、点了却什么都不发生，而且没有任何地方能解释为什么。
  ; 这正是 docs/PLAN.md §M8 那句「否则会变成用户投诉的来源」。
  DeleteRegKey HKCU "Software\Classes\*\shell\Arbiter"

  ; ⚠️ **上面这一行就是清理的全部射程：`*\shell` 与 `*` 一层都不碰**，哪怕它们当时是空的。
  ;
  ; 这里原来还有两行带 `/ifempty` 的逐层清理，2026-09-14 审计（D5）之后删掉了。
  ; 保留它们的那版理由（「空着才删，所以不会误伤别人」）只回答了一半问题：
  ; **收益是零**——空键不占体积、不影响任何行为，删掉它没有任何人受益；
  ; **风险不是零**——`*\shell` 是各家经典右键动词共用的落脚处（开发机上实测躺着
  ; 迅雷的 `ThunderShell`，`*` 下面还有 `OpenWithProgids` 与 `shellex`），
  ; 别的软件完全可能刚建好这个键、正等着往里写，而我们这一删是静默的。
  ;
  ; 实证过的那次事故也说明「/ifempty 足够安全」这个假设站不住：应用内那条路径里
  ; 同一套判空逻辑（`isEmptyQueryOutput`）曾经因为一个 off-by-one 把**只剩一项**的
  ; `*\shell` 判成了空键，真删掉了别人的菜单项。两道闸（`/ifempty` 与判空）
  ; 是同一个判据的两种写法，会一起坏。
  ;
  ; 清理中间层的逻辑**留在应用内**（`core/integration.ts` 的 `uninstallContextMenu`），
  ; 而它今天也只清**我们自己子树里**的中间层，上界同样是开区间——两边口径一致。
  ; 改一处就得改另一处，别只改一边。

  ; 刻意**不**碰 HKCU\Software\Classes\Applications\Arbiter.exe 之类：本项目从不写它们，
  ; 多删一处就多一次删错的机会。

  ; ---- 「发送到」快捷方式（M9）的清理 ----
  ;
  ; 与右键菜单同一个道理：用户点「卸载」时不会先回去把开关关掉，而留下的那个 .lnk
  ; 指向一个**已经被删掉的 exe**——「发送到」里那一项还在、点了什么都不发生。
  ;
  ; ⚠️ **只删我们自己那一个文件**，绝不 Delete 整个 SendTo 目录（那里躺着用户自家的
  ; 「邮件收件人」「压缩(zipped)文件夹」等等）。这与上面 `DeleteRegKey /ifempty` 是同一条
  ; 教训的两个形态：清理的射程必须由「我们自己创建的东西」决定。
  ;
  ; `$APPDATA` 在 NSIS 里就是 `%APPDATA%`（Roaming）。本项目是 perMachine: false 的
  ; 用户级安装（见 electron-builder.yml），卸载器以同一个用户身份运行，所以解析出来的
  ; 就是装它那个人的「发送到」目录。
  ;
  ; 路径里的产品名要与 `core/sendTo.ts` 的 `SEND_TO_LINK_NAME` 逐字一致（Arbiter.lnk）。
  Delete "$APPDATA\Microsoft\Windows\SendTo\Arbiter.lnk"
!macroend
