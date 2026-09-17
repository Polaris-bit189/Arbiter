---
name: formats
description: 列出 Arbiter 支持的格式与转换方向。示例：/arbiter:formats 视频
argument-hint: [类别]
---

# /arbiter:formats

查 Arbiter 的能力矩阵。用户给的参数是：

```
$ARGUMENTS
```

## 怎么做

1. **不传类别时，优先读 resource `converter://formats`**——那是一份 markdown 版的全量矩阵，
   一次读完，比反复调 `list_supported_formats` 试探便宜得多。

2. **用户指定了类别时**（视频 / 音频 / 图片 / 文档 / 电子书 / 压缩包），
   用 `list_supported_formats` 带上 `category`，只取这一类。

3. **回答要落到「哪个格式能转成哪个」**，不是只报一句「支持 mp4」。
   用户问这个通常是为了决定转成什么，所以**把出口写出来**：
   比如「mkv 可以转 mp4 / webm / mov / avi / m4v …」。

4. 如果用户其实是想转某个**具体文件**，那就先 `inspect_file` 它——
   合法出口随源格式而变，问出来的比查出来的准。
