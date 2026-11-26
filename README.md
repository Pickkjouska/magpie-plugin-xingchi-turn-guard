# Magpie Xingchi Turn Guard

Magpie gateway hook for Xingchi Responses: protect native turn counts and shorten oversized history locally before sending it upstream.

## Install

You can install the current package directly from its public GitHub repository:

```powershell
magpie plugin add github:Pickkjouska/magpie-plugin-xingchi-turn-guard
```

You can also download the [v0.3.2 release ZIP](https://github.com/Pickkjouska/magpie-plugin-xingchi-turn-guard/releases/download/v0.3.2/magpie-plugin-xingchi-turn-guard-v0.3.2.zip), extract it, and import its directory from Magpie's Plugins page, or install the extracted directory:

```powershell
magpie plugin add ./magpie-plugin-xingchi-turn-guard
```

The directory must contain `package.json`. A published GitHub repository can also be installed using `magpie plugin add github:owner/repository` with its actual owner and repository name.

Magpie must already have an Xingchi provider with a valid API key. The hook discovers it from the endpoint in Magpie's `providers.json`; it does not ask users to paste a key into plugin options, and it does not print or store the key. Requests are matched by the provider-prefixed model ID, for example `xingchiapi/gpt-6.1-sol`.

## Settings

`maxTurns` and `maxModelTurns` both default to `15`. The former bounds native user messages, and the latter bounds native model output items, including tool calls and reasoning. One user request can produce over 100 model replies, so both budgets matter. Set either option to another integer of at least `2`, or `0` to disable proactive packing for that metric until a server limit has been observed. `historyPacking: false` disables packing entirely.

The hook learns user and model limits separately and uses the lower of configured and learned budgets. A model error saying it has "replied 100 turns" reports a rejected count rather than an exact ceiling; the hook learns a conservative smaller budget. For requests below the size threshold, completed records are packed as exact JSON history. This turn packing alone does not shorten the full context.

## Recovering oversized context

Version `0.3.0` adds local extractive compression. It runs before the upstream request and needs no additional model call, so it can shorten history even when the full history would be refused with HTTP 400. The extract explicitly declares that records or text were omitted; it is not a model-generated semantic summary. Version `0.3.1` can also guard Magpie's internal Codex summary request when the host supports gateway hooks for compaction and `codexCompaction` is enabled. Version `0.3.2` independently reimplements the history and limit helpers without runtime package dependencies.

| Option | Default | Behavior |
| --- | --- | --- |
| `contextCompression` | `true` | Enable local length compression; `false` leaves only exact turn packing. |
| `codexCompaction` | `false` | Also protect Magpie's internal Codex compaction requests, when the host supports this hook option. |
| `maxInputBytes` | `196608` | Trigger above 192 KiB of serialized UTF-8 request JSON, including instructions, tools and directives; integer of at least `4096`. |
| `summaryMaxChars` | `16000` | Maximum text size for the local extract, reduced further when necessary; integer of at least `512`. |
| `recentModelTurns` | `6` | Prefer keeping this many recent model output items native, with complete dependency bundles. Fewer completed bundles can be kept if needed to fit. |

The compressor decodes the plugin's known exact archives, omits old encrypted reasoning, and keeps bounded excerpts of older user messages, assistant replies and completed tool outputs. It favors the original request, recent user messages and the latest assistant reply. Current user content, system/developer messages, instructions, tool definitions, historical media and pending tool dependencies stay intact. Existing Codex history on disk is not edited. Text omitted from the submitted extract can be recovered from the original local records when needed.

The byte budget is a deterministic size guard, not an exact model token count or a proven server window. When protected content itself exceeds the budget, the compressor preserves it and reports `withinBudget: false` internally. No finite request size can guarantee acceptance by every upstream model. `historyPacking: false` disables both protections.

Observed limits are cached separately by endpoint, model, and a hash of the API key. The cache contains no API key text.

This hook packs old request history within the current client conversation. It does not create a new Codex chat.

After updating the files and plugin options, reload the running Magpie plugin host. An already failed request is not replayed by an `onResponse` hook; the next request uses the new budgets. Existing Codex conversations can use the updated gateway without changing their chat ID. The upstream server limit remains in place; the hook keeps the submitted native history below its configured budgets when a safe boundary exists.

Magpie 0.1.4759 does not pass HTTP 400 error bodies to `onResponse`. Learning is available only when the host supplies an error payload; on this version, keep proactive budgets enabled. Path plugin changes and CLI option changes are detected by Magpie and take effect when it creates the plugin host for the next request. Updating files alone does not change code already executing in a request.

For a failed conversation, retry `/compact` in the original Codex chat after updating. Magpie handles a `compaction_trigger` on `/responses` internally for non-native models. Stock Magpie 0.1.4759 skips request hooks for that summary call; install a host with internal compaction hook support and enable `codexCompaction: true` on this plugin to guard it. A usage entry labeled `compact` alone does not identify the request path. A host that rejects `/responses/compact` for a non-native model can still accept the trigger on `/responses`.

## Licensing

This repository does not grant a license for its original code.
