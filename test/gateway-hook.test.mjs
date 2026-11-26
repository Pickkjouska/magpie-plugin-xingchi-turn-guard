import { expect, test } from "bun:test"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { onRequest, onResponse } from "../gateway.hooks.mjs"
import { countResponsesModelTurns } from "../history.mjs"
import { buildContextSummary, isContextSummary, LOSSY_HISTORY_HEADER } from "../context-summary.mjs"
import { createTurnLimitCache, parseTurnFeedback, turnLimitScope } from "../turn-limits.mjs"

const providerId = "xingchiapi"
const apiModel = "gpt-6.1-sol"
const routeModel = `${providerId}/${apiModel}`
const baseUrl = "https://api.xingchiapi.com/v1"
const fixtureKey = "sk-turn-guard-fixture-only"
const userCount = input => input.filter(item => item?.role === "user").length
const modelFailure = {
  error: {
    code: "session_turn_limit_exceeded",
    message: "星驰: 当前会话模型已回复 100 轮，达到上限。Codex 请输入 /compact 压缩上下文后继续，或输入 /new 新开会话；其他客户端请新建对话。This conversation has reached 100 model turns. Run /compact to continue with a summarized context, or /new to start a new session.",
  },
}

async function withProvider(check) {
  const directory = await mkdtemp(join(tmpdir(), "xingchi-turn-guard-test-"))
  try {
    await writeFile(join(directory, "providers.json"), JSON.stringify({ providers: [{
      id: providerId,
      key: fixtureKey,
      responses: baseUrl,
      models: [apiModel],
    }] }))
    const context = overrides => ({
      protocol: "responses",
      model: routeModel,
      options: { configDirectory: directory, ...overrides },
    })
    await check({ directory, context })
  } finally {
    const target = await realpath(directory)
    const within = relative(await realpath(tmpdir()), target)
    if (isAbsolute(within) || within.startsWith("..") ||
        !within.startsWith("xingchi-turn-guard-test-")) {
      throw new Error("Fixture cleanup escaped its temporary directory")
    }
    await rm(target, { recursive: true, force: true })
  }
}

function toolHistory(count) {
  const input = [{ role: "user", content: "Keep project=原文 and retry_limit=7; continue the same task." }]
  for (let step = 1; step <= count; step++) {
    input.push({
      type: "function_call", id: `fc_${step}`, call_id: `call_${step}`,
      name: "record_step", arguments: JSON.stringify({ step, exact: "原文\n保留" }),
    })
    input.push({ type: "function_call_output", call_id: `call_${step}`, output: `Completed ${step}\n原文` })
  }
  input.push({ role: "user", content: "Continue from these results without repeating completed calls." })
  return input
}

function conversation(count, withAnswers = true) {
  const input = []
  for (let turn = 1; turn <= count; turn++) {
    input.push({ role: "user", content: `Question ${turn}\n原文` })
    if (withAnswers && turn < count) input.push({ role: "assistant", content: `Answer ${turn}` })
  }
  return input
}

function request(input, model = routeModel) {
  return { model, input, instructions: "Preserve the current task and exact recorded values." }
}

function reconstruct(input) {
  return [...JSON.parse(input[0].content[1].text), ...input.slice(1)]
}

test("默认预算保护只有两个用户回合、105 次已完成模型工具回复的会话，并保留全部原文", async () => {
  await withProvider(async ({ context }) => {
    const body = request(toolHistory(105))
    const before = structuredClone(body)
    const packed = await onRequest(body, context())
    expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(15)
    expect(userCount(packed.input)).toBeLessThanOrEqual(15)
    expect(reconstruct(packed.input)).toEqual(body.input)
    expect(packed.instructions).toBe(body.instructions)
    expect(packed.input.at(-1)).toEqual(body.input.at(-1))
    expect(body).toEqual(before)
  })
})

test("打包时 system 和 developer 保持原生角色、全部字段及相互顺序", async () => {
  await withProvider(async ({ context }) => {
    const system = { role: "system", content: [{ type: "input_text", text: "Keep current system policy authoritative." }] }
    const developer = { role: "developer", content: "Only edit the approved workspace. 原文", id: "directive_original" }
    const history = toolHistory(30)
    const input = [system, ...history.slice(0, 8), developer, ...history.slice(8)]
    const body = request(input)
    const before = structuredClone(body)
    const packed = await onRequest(body, context())
    expect(packed.input.slice(0, 2)).toEqual([system, developer])
    expect(packed.input.filter(item => item?.role === "system" || item?.role === "developer")).toEqual([system, developer])
    const packedHistory = packed.input.slice(2)
    expect(reconstruct(packedHistory)).toEqual(history)
    expect(JSON.parse(packedHistory[0].content[1].text).some(
      item => item?.role === "system" || item?.role === "developer",
    )).toBe(false)
    expect(packed.instructions).toBe(body.instructions)
    expect(body).toEqual(before)
  })
})

test("无需打包时不移动原始 system 或 developer 消息", async () => {
  await withProvider(async ({ context }) => {
    const history = toolHistory(3)
    const body = request([
      { role: "system", content: "System policy." },
      ...history.slice(0, 2),
      { role: "developer", content: "Developer policy." },
      ...history.slice(2),
    ])
    const originalInput = body.input
    const before = structuredClone(body)
    expect(await onRequest(body, context())).toBeUndefined()
    expect(body.input).toBe(originalInput)
    expect(body).toEqual(before)
  })
})

test("改写后的完整历史关闭 store 并移除 previous_response_id，原请求保持完整", async () => {
  await withProvider(async ({ context }) => {
    const body = { ...request(toolHistory(30)), store: true, previous_response_id: "resp_original_fixture" }
    const packed = await onRequest(body, context())
    expect(packed.store).toBe(false)
    expect(Object.hasOwn(packed, "previous_response_id")).toBe(false)
    expect(reconstruct(packed.input)).toEqual(body.input)
    expect(body.store).toBe(true)
    expect(body.previous_response_id).toBe("resp_original_fixture")
  })
})

test("自定义模型预算 7 在同一个长任务内生效，再次封装不嵌套或丢失原始记录", async () => {
  await withProvider(async ({ context }) => {
    const body = request(toolHistory(105))
    const first = await onRequest(body, context({ maxModelTurns: 15 }))
    const second = await onRequest(first, context({ maxModelTurns: 7 }))
    expect(countResponsesModelTurns(second.input)).toBeLessThanOrEqual(7)
    expect(reconstruct(second.input)).toEqual(body.input)
  })
})

test("真实 100 模型轮数报错独立缓存退避预算，随后请求使用它且缓存不保存密钥", async () => {
  await withProvider(async ({ directory, context }) => {
    const body = request(toolHistory(105))
    const ctx = { ...context({ maxTurns: 0, maxModelTurns: 0 }), request: body }
    await onResponse(modelFailure, ctx)
    const cache = createTurnLimitCache(directory)
    expect(await cache.get(turnLimitScope(baseUrl, fixtureKey, apiModel, "model"))).toBe(50)
    expect(await cache.get(turnLimitScope(baseUrl, fixtureKey, apiModel))).toBeUndefined()
    expect(await readFile(join(directory, "xingchi-turn-limits.json"), "utf8")).not.toContain(fixtureKey)
    const packed = await onRequest(body, ctx)
    expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(50)
    expect(reconstruct(packed.input)).toEqual(body.input)
  })
})

test("模型拒绝计数大于本次发送条目数时，按本次发送量保守退避", async () => {
  await withProvider(async ({ directory, context }) => {
    await onResponse(modelFailure, { ...context(), request: request(toolHistory(16)) })
    expect(await createTurnLimitCache(directory).get(
      turnLimitScope(baseUrl, fixtureKey, apiModel, "model"),
    )).toBe(8)
  })
})

test("缓存不会让迟到或并发的较宽反馈提高已学到的保守预算", async () => {
  await withProvider(async ({ directory }) => {
    const scope = turnLimitScope(baseUrl, fixtureKey, apiModel, "model")
    const cache = createTurnLimitCache(directory)
    await cache.remember(scope, 5)
    await cache.remember(scope, 50)
    expect(await cache.get(scope)).toBe(5)

    await Promise.all([21, 3, 12, 40].map(limit => cache.remember(scope, limit)))
    expect(await cache.get(scope)).toBe(3)
    expect(await readFile(join(directory, "xingchi-turn-limits.json"), "utf8")).not.toContain(fixtureKey)
  })
})

test("缓存文件不可读时回退为未知上限，且不阻断请求钩子", async () => {
  await withProvider(async ({ directory, context }) => {
    const blocker = join(directory, "not-a-directory")
    await writeFile(blocker, "fixture")
    const cache = createTurnLimitCache(join(blocker, "nested"))
    const scope = turnLimitScope(baseUrl, fixtureKey, apiModel, "model")
    expect(await cache.get(scope)).toBeUndefined()
    await expect(cache.remember(scope, 5)).resolves.toBeUndefined()

    const packed = await onRequest(request(toolHistory(105)), context())
    expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(15)
  })
})

test("错误报告不能把零次模型回复学成限额", () => {
  expect(parseTurnFeedback({ error: {
    code: "session_turn_limit_exceeded",
    message: "The model has replied 0 turns.",
  } })).toBeNull()
})

for (const [limit, expected] of [[100, 95], [1, 0]]) {
  test(`结构化模型上限 ${limit} 缓存带余量的预算 ${expected}`, async () => {
    await withProvider(async ({ directory, context }) => {
      await onResponse({ error: { code: "session_turn_limit_exceeded", max_model_turns: limit } }, {
        ...context(), request: request(toolHistory(105)),
      })
      expect(await createTurnLimitCache(directory).get(
        turnLimitScope(baseUrl, fixtureKey, apiModel, "model"),
      )).toBe(expected)
      const packed = await onRequest(request(toolHistory(105)), context({ maxModelTurns: 0 }))
      expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(expected)
    })
  })
}

test("显式 0 关闭两项主动阈值，在未知服务端上限时保持完整原生历史", async () => {
  await withProvider(async ({ context }) => {
    expect(await onRequest(request(toolHistory(105)), context({ maxTurns: 0, maxModelTurns: 0 }))).toBeUndefined()
    expect(await onRequest(request(conversation(30)), context({ maxTurns: 0, maxModelTurns: 0 }))).toBeUndefined()
  })
})

test("单独关闭模型主动阈值后，两个用户回合不会因为工具回复多而打包", async () => {
  await withProvider(async ({ context }) => {
    expect(await onRequest(request(toolHistory(105)), context({ maxModelTurns: 0 }))).toBeUndefined()
  })
})

test("单独关闭用户主动阈值后，多条用户消息不会触发用户预算", async () => {
  await withProvider(async ({ context }) => {
    expect(await onRequest(request(conversation(30, false)), context({ maxTurns: 0 }))).toBeUndefined()
  })
})

test("默认用户阈值 15 在模型主动阈值关闭时仍然生效", async () => {
  await withProvider(async ({ context }) => {
    const body = request(conversation(16))
    const packed = await onRequest(body, context({ maxModelTurns: 0 }))
    expect(userCount(packed.input)).toBeLessThanOrEqual(15)
    expect(reconstruct(packed.input)).toEqual(body.input)
  })
})

for (const [configured, expected] of [[30, 20], [7, 7], [0, 20]]) {
  test(`已学习的用户上限 20 与用户配置 ${configured} 共同保护后续请求`, async () => {
    await withProvider(async ({ directory, context }) => {
      await onResponse({ error: { code: "session_turn_limit_exceeded", max_turns: 20 } }, context())
      expect(await createTurnLimitCache(directory).get(
        turnLimitScope(baseUrl, fixtureKey, apiModel),
      )).toBe(20)
      expect(await createTurnLimitCache(directory).get(
        turnLimitScope(baseUrl, fixtureKey, apiModel, "model"),
      )).toBeUndefined()
      const body = request(conversation(31))
      const packed = await onRequest(body, context({ maxTurns: configured, maxModelTurns: 0 }))
      expect(userCount(packed.input)).toBeLessThanOrEqual(expected)
      expect(reconstruct(packed.input)).toEqual(body.input)
    })
  })
}

test("historyPacking=false 在已学习到模型预算后也整体关闭打包", async () => {
  await withProvider(async ({ context }) => {
    const body = request(toolHistory(105))
    await onResponse(modelFailure, { ...context(), request: body })
    expect(await onRequest(body, context({ historyPacking: false }))).toBeUndefined()
  })
})

test("其他 Provider 即使使用相同 API 模型名也不修改请求或学习反馈", async () => {
  await withProvider(async ({ directory, context }) => {
    const otherModel = `other-provider/${apiModel}`
    const body = request(toolHistory(105), otherModel)
    const ctx = { ...context(), model: otherModel, request: body }
    expect(await onRequest(body, ctx)).toBeUndefined()
    await onResponse(modelFailure, ctx)
    expect(await createTurnLimitCache(directory).get(
      turnLimitScope(baseUrl, fixtureKey, apiModel, "model"),
    )).toBeUndefined()
  })
})

test("非 Responses 协议不处理历史", async () => {
  await withProvider(async ({ context }) => {
    expect(await onRequest(request(toolHistory(105)), { ...context(), protocol: "chat" })).toBeUndefined()
  })
})

test("非 Responses 反馈不污染 Responses 用户或模型预算", async () => {
  await withProvider(async ({ directory, context }) => {
    for (const protocol of ["chat", undefined]) {
      const ctx = { ...context(), protocol, request: request(toolHistory(105)) }
      await onResponse(modelFailure, ctx)
      await onResponse({ error: { code: "session_turn_limit_exceeded", max_turns: 20 } }, ctx)
    }
    const cache = createTurnLimitCache(directory)
    expect(await cache.get(turnLimitScope(baseUrl, fixtureKey, apiModel))).toBeUndefined()
    expect(await cache.get(turnLimitScope(baseUrl, fixtureKey, apiModel, "model"))).toBeUndefined()
  })
})

test("宿主只暴露 null 回复时不虚构已学习上限，默认主动模型预算仍然保护请求", async () => {
  await withProvider(async ({ directory, context }) => {
    const body = request(toolHistory(105))
    const ctx = { ...context(), request: body }
    await onResponse(null, ctx)
    const cache = createTurnLimitCache(directory)
    expect(await cache.get(turnLimitScope(baseUrl, fixtureKey, apiModel, "model"))).toBeUndefined()
    const packed = await onRequest(body, ctx)
    expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(15)
    expect(reconstruct(packed.input)).toEqual(body.input)
  })
})

for (const kind of ["pending", "late-output", "item-reference"]) {
  test(`无法安全切分 ${kind} 工具依赖时保持原生请求，避免丢失调用或引用`, async () => {
    await withProvider(async ({ context }) => {
      const input = toolHistory(30)
      if (kind === "pending") input.splice(2, 1)
      if (kind === "late-output") input.push({ type: "function_call_output", call_id: "call_1", output: "Late exact result" })
      if (kind === "item-reference") input.push({ type: "item_reference", id: "fc_1" })
      const body = request(input)
      const before = structuredClone(body)
      expect(await onRequest(body, context({ maxModelTurns: 7 }))).toBeUndefined()
      expect(body).toEqual(before)
    })
  })
}

test("模型切点保留同一回复的推理密文和工具调用关系", async () => {
  await withProvider(async ({ context }) => {
    const input = [{ role: "user", content: "Continue the recorded task." }]
    for (let step = 1; step <= 30; step++) {
      input.push({ type: "reasoning", id: `rs_${step}`, summary: [], encrypted_content: `opaque_${step}` })
      input.push({ type: "function_call", id: `fc_${step}`, call_id: `call_${step}`, name: "read", arguments: "{}" })
      input.push({ type: "function_call_output", call_id: `call_${step}`, output: `Result ${step}` })
    }
    input.push({ role: "user", content: "Continue using these completed results." })
    const packed = await onRequest(request(input), context({ maxModelTurns: 7 }))
    expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(7)
    expect(reconstruct(packed.input)).toEqual(input)
    const nativeIds = new Set(packed.input.slice(1).map(item => item.id))
    for (let step = 1; step <= 30; step++) {
      if (nativeIds.has(`fc_${step}`)) expect(nativeIds.has(`rs_${step}`)).toBe(true)
    }
  })
})

test("网关发送前处理超大历史并在后续轮数打包中保持有损标记", async () => {
  await withProvider(async ({ context }) => {
    const history = toolHistory(105)
    for (const item of history) {
      if (item.type === "function_call_output") item.output += "大段已完成输出\n".repeat(1500)
    }
    const system = { role: "system", content: "Preserve this original policy." }
    const developer = { role: "developer", content: "Only edit the approved workspace." }
    const body = { ...request([system, developer, ...history]), store: true, previous_response_id: "resp_fixture" }
    const before = JSON.stringify(body)
    const ctx = { ...context(), state: {} }
    const packed = await onRequest(body, ctx)
    expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThanOrEqual(196608)
    expect(packed.input.slice(0, 2)).toEqual([system, developer])
    expect(packed.input.at(-1)).toEqual(history.at(-1))
    expect(packed.input.filter(isContextSummary)).toHaveLength(1)
    expect(packed.store).toBe(false)
    expect(packed.previous_response_id).toBeUndefined()
    expect(ctx.state.contextCompression.withinBudget).toBe(true)
    expect(JSON.stringify(body)).toBe(before)

    const next = { ...packed, input: [...packed.input, ...toolHistory(30)] }
    const repacked = await onRequest(next, context())
    expect(repacked.input.filter(isContextSummary)).toHaveLength(1)
    expect(repacked.input.find(isContextSummary).content[0].text).toBe(LOSSY_HISTORY_HEADER)
    const newExactArchive = repacked.input.find(item => item?.content?.[0]?.text?.startsWith("EARLIER CONVERSATION"))
    expect(newExactArchive.content[1].text).not.toContain(LOSSY_HISTORY_HEADER)
  })
})

test("关闭长度压缩仍只用原来的无损轮数打包，其他 Provider 的大请求直接跳过", async () => {
  await withProvider(async ({ context }) => {
    const history = toolHistory(30)
    for (const item of history) {
      if (item.type === "function_call_output") item.output = "Large completed output\n".repeat(3000)
    }
    const body = request(history)
    const packed = await onRequest(body, context({ contextCompression: false }))
    expect(packed.input.some(isContextSummary)).toBe(false)
    expect(reconstruct(packed.input)).toEqual(body.input)
    const other = { ...body, model: `other-provider/${apiModel}` }
    expect(await onRequest(other, { ...context(), model: other.model })).toBeUndefined()
  })
})

test("旧摘要也占原生用户轮次，剩余预算才可用于无损打包", async () => {
  await withProvider(async ({ context }) => {
    const summary = buildContextSummary(conversation(2)).message
    const recent = conversation(4, false)
    const packed = await onRequest(request([summary, ...recent]), context({ maxTurns: 4 }))
    expect(userCount(packed.input)).toBeLessThanOrEqual(4)
    expect(packed.input[0]).toEqual(summary)
    expect(reconstruct(packed.input.slice(1))).toEqual(recent)
  })
})

test("两轮预算内合并旧摘要，重复追加时保留最新消息且不叠加摘要", async () => {
  await withProvider(async ({ context }) => {
    const ctx = context({ maxTurns: 2, maxModelTurns: 3 })
    const summary = buildContextSummary(conversation(2)).message
    const currentTask = toolHistory(30)
    const body = request([summary, ...currentTask])
    const packed = await onRequest(body, ctx)
    expect(userCount(packed.input)).toBe(2)
    expect(countResponsesModelTurns(packed.input)).toBeLessThanOrEqual(3)
    expect(JSON.stringify(packed.input.find(isContextSummary))).toContain("Keep project=原文")
    expect(packed.input.at(-1)).toEqual(currentTask.at(-1))
    expect(await onRequest(packed, ctx)).toBeUndefined()

    const latest = { role: "user", content: "Continue using the exact latest instruction. 原文" }
    const repacked = await onRequest({ ...packed, input: [...packed.input, latest] }, ctx)
    expect(userCount(repacked.input)).toBe(2)
    expect(repacked.input.filter(isContextSummary)).toHaveLength(1)
    expect(repacked.input.at(-1)).toEqual(latest)
    expect(JSON.stringify(repacked.input).match(/LOSSY LOCAL EXTRACTIVE CONTEXT/g)).toHaveLength(1)
    expect(await onRequest(repacked, ctx)).toBeUndefined()
  })
})
