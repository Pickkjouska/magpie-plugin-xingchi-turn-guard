# Magpie 星驰会话保护插件

这是一个 Magpie 网关 hook 插件，为星驰 Responses 请求控制会话轮数，并在请求过大时于本地压缩较早的历史。

## 安装

Magpie 可以直接从 GitHub 导入本插件：

```powershell
magpie plugin add github:Pickkjouska/magpie-plugin-xingchi-turn-guard
```

也可以下载 [v0.3.2 发布包](https://github.com/Pickkjouska/magpie-plugin-xingchi-turn-guard/releases/download/v0.3.2/magpie-plugin-xingchi-turn-guard-v0.3.2.zip)，解压后从 Magpie 的 Plugins 页面导入，或在解压目录运行：

```powershell
magpie plugin add ./magpie-plugin-xingchi-turn-guard
```

Magpie 中需要先配置有效的星驰 Provider 和 API Key。插件会根据 `providers.json` 中的星驰端点查找 Provider，不会要求你把 API Key 粘贴到插件选项中，也不会输出或写入 API Key。请求按带 Provider 前缀的模型名匹配，例如 `xingchiapi/gpt-6.1-sol`。

## 会话轮数选项

`maxTurns` 和 `maxModelTurns` 默认都是 `15`。前者限制原生用户消息数，后者统计模型输出条目，包括助手回复、推理和工具调用。一个用户请求可能产生很多次工具调用，因此插件分别保护这两项预算。

两项都可以设置为至少 `2` 的整数，也可设为 `0` 暂停该项的主动打包，直到观察到服务端限制。`historyPacking: false` 会关闭全部历史打包和长度压缩。

插件会分别学习星驰返回的用户轮数和模型轮数限制，并在配置预算与已学习预算中使用较小值。错误中的“已回复 100 轮”代表被拒绝的计数，并非确定的服务器上限；插件会采用更保守的回退值。

## 超长上下文压缩

从 `0.3.0` 起，插件会在请求发往上游之前检查完整的 UTF-8 JSON 字节数。当请求超过 `maxInputBytes` 阈值时，插件不调用额外模型，而是在本地生成有损摘录。它会明确标记被省略的历史记录或文字；这不是模型生成的语义摘要。

`0.3.1` 增加了对 Magpie 内部 Codex 摘要请求的可选保护，前提是 Magpie 宿主本身支持 compaction hook，并启用 `codexCompaction`。`0.3.2` 将历史打包和轮数限制模块独立重写，插件运行时不依赖第三方 npm 包。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `contextCompression` | `true` | 启用本地长度压缩；设为 `false` 后只保留无损轮数打包。 |
| `codexCompaction` | `false` | 仅在 Magpie 宿主支持内部压缩 hook 时，额外处理 Codex 内部压缩请求。 |
| `maxInputBytes` | `196608` | 完整请求 JSON 超过 192 KiB 时开始压缩；统计包含 instructions、tools 和原生指令，最小值为 `4096`。 |
| `summaryMaxChars` | `16000` | 本地摘录的最大字符数；需要时会进一步缩小，最小值为 `512`。 |
| `recentModelTurns` | `6` | 优先保留为原生条目的近期模型输出数，并保证工具依赖完整；若要满足字节预算，可以少保留一些已完成的调用。 |

压缩器能展开插件已知格式的无损历史档案。它会省略旧的加密推理内容，并从较早的用户消息、助手回复和已完成的工具结果中摘取有界片段。当前用户请求、system/developer 消息、instructions、tools、历史媒体以及未结束的工具依赖会继续保留。压缩不会修改 Codex 磁盘中的会话记录。

字节数只是确定性的请求大小保护，并不等同于 Token 数，也不是经证明的服务端上下文窗口。受保护内容本身若已超过预算，插件会保留这些内容并报告超预算，而不会声称压缩成功。若历史中存在无法安全拆分的依赖，轮数打包会保持原始请求。

轮数限制缓存按端点、模型和 API Key 的哈希分别记录，不保存 API Key 明文。缓存写操作会在单个插件宿主进程内串行化；多个进程同时写同一个配置目录时仍可能发生竞争。缓存读取或写入失败不会阻断请求，会退回到配置预算。

## Codex 自动压缩兼容性

普通的 Responses 请求会经过网关 hook，因此可以在同一个客户端会话中压缩历史后继续请求；插件不会创建新的 Codex 会话，也不会绕过星驰服务端本身的硬上限。

Magpie `0.1.4759` 会在处理 Codex 的 `compaction_trigger` 时发出内部摘要请求，但该版本不会让普通网关 hook 处理这个内部请求。因此仅安装本插件不能修复此版本中 `/compact` 本身的 HTTP 400。要压缩内部摘要请求，需要宿主增加 compaction hook 支持，并启用 `codexCompaction: true`。通用 `/v1/responses/compact` 是否可用则取决于客户端和 Provider 实际采用的压缩路径。

更新本地路径插件的文件后，Magpie 会在检测到变化时重载插件宿主。已经失败的请求不会自动重放；之后的普通请求会使用新代码和预算。插件不会更改星驰服务器限额。

## 许可

本仓库未为原创代码授予使用许可。
