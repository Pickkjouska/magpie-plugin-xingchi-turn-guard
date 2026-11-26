import { expect, test } from "bun:test"

import { compactResponsesContext } from "../context-compression.mjs"
import { LOSSY_HISTORY_HEADER } from "../context-summary.mjs"
import { countResponsesModelTurns, packResponsesHistory, unpackArchive } from "../history.mjs"

const DEFAULT_BUDGET = 196608
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8")
const messageText = item => typeof item?.content === "string" ? item.content
  : (item?.content ?? []).filter(part => part?.type === "input_text").map(part => part.text).join("\n")
const summaries = body => body.input.filter(item => item?.role === "user" &&
  messageText(item).startsWith(LOSSY_HISTORY_HEADER))

function history({ steps = 40, outputChars = 6000, reasoningChars = 0, tailUser = true, prefix = "old" } = {}) {
  const input = [{ role: "user", id: `${prefix}_task`, content: "Keep project=原文 and retry_limit=7. Continue the same approved task." }]
  for (let step = 1; step <= steps; step++) {
    if (reasoningChars) input.push({
      type: "reasoning", id: `${prefix}_rs_${step}`, summary: [],
      encrypted_content: `OPAQUE_${prefix}_${step}:` + "r".repeat(reasoningChars),
    })
    input.push({
      type: "function_call", id: `${prefix}_fc_${step}`, call_id: `${prefix}_call_${step}`,
      name: "record_step", arguments: JSON.stringify({ step, exact: "原文\n保留" }),
    }, {
      type: "function_call_output", call_id: `${prefix}_call_${step}`,
      output: `OUTPUT_HEAD_${prefix}_${step}\n` + "x".repeat(outputChars) + `\nOUTPUT_TAIL_${prefix}_${step}`,
    })
  }
  if (tailUser) input.push({ role: "user", id: `${prefix}_current`, content: "Continue from the recorded results; do not repeat completed steps." })
  return input
}

function request(input, extra = {}) {
  return {
    model: "xingchiapi/gpt-6.1-sol", input,
    instructions: "Preserve current instructions and report only verified outcomes.",
    ...extra,
  }
}

function measured(result, before, budget) {
  expect(result.stats.beforeBytes).toBe(bytes(before))
  expect(result.stats.afterBytes).toBe(bytes(result.body))
  expect(result.stats.budgetBytes).toBe(budget)
  expect(result.stats.withinBudget).toBe(bytes(result.body) <= budget)
  expect(typeof result.stats.reason).toBe("string")
  expect(result.stats.reason.length).toBeGreaterThan(0)
}

function expectNative(body, original) {
  const matches = body.input.filter(item => original.type?.endsWith("_output")
    ? item?.type === original.type && item.call_id === original.call_id && item.output === original.output
    : item?.id === original.id && item?.type === original.type && item?.role === original.role)
  expect(matches.length).toBeGreaterThan(0)
  expect(matches[0]).toEqual(original)
}

function nativeDependencies(body) {
  for (let index = 0; index < body.input.length; index++) {
    const item = body.input[index]
    if (item?.type?.endsWith("_output") && typeof item.call_id === "string") {
      expect(body.input.slice(0, index).some(call => call?.type?.endsWith("_call") && call.call_id === item.call_id)).toBe(true)
    }
    if (item?.type === "item_reference") {
      expect(body.input.slice(0, index).some(target => target?.type !== "item_reference" && target.id === item.id)).toBe(true)
    }
  }
}

function mediaParts(value, type, found = []) {
  if (Array.isArray(value)) for (const child of value) mediaParts(child, type, found)
  else if (value && typeof value === "object") {
    if (value.type === type) found.push(value)
    for (const child of Object.values(value)) mediaParts(child, type, found)
  }
  return found
}

test("低于预算保持同一个请求对象，统计包括 instructions、tools 和原生指令", () => {
  const body = request([
    { role: "system", id: "sys_small", content: "System policy." },
    { role: "developer", id: "dev_small", content: "Developer policy." },
    { role: "user", id: "user_small", content: "Current task 原文." },
  ], { tools: [{ type: "function", name: "read", parameters: { type: "object", properties: {} } }] })
  const before = structuredClone(body)
  const result = compactResponsesContext(body)
  expect(result.changed).toBe(false)
  expect(result.body).toBe(body)
  expect(body).toEqual(before)
  measured(result, before, DEFAULT_BUDGET)
})

test("contextCompression=false 保留超过预算的原始请求且诚实报告字节数", () => {
  const body = request(history())
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { contextCompression: false, maxInputBytes: 32768 })
  expect(result.changed).toBe(false)
  expect(result.body).toBe(body)
  expect(body).toEqual(before)
  expect(result.stats.withinBudget).toBe(false)
  measured(result, before, 32768)
})

for (const invalid of [0, -1, 4095, 1.5, NaN, Infinity, "8192"]) {
  test(`非法字节预算 ${String(invalid)} 使用默认值而非误触发压缩`, () => {
    const body = request(history({ steps: 3, outputChars: 4000 }))
    const result = compactResponsesContext(body, { maxInputBytes: invalid })
    expect(result.changed).toBe(false)
    expect(result.body).toBe(body)
    measured(result, body, DEFAULT_BUDGET)
  })
}

test("预算边界使用完整序列化后的真实 UTF-8 字节", () => {
  const body = request([{ role: "user", id: "boundary_user", content: "current" }])
  body.instructions += "a".repeat(4096 - bytes(body))
  expect(bytes(body)).toBe(4096)
  const result = compactResponsesContext(body, { maxInputBytes: 4096 })
  expect(result.changed).toBe(false)
  expect(result.body).toBe(body)
  expect(result.stats.withinBudget).toBe(true)
  measured(result, body, 4096)
})

test("超过 3 MiB 的 320 reasoning / 127 工具历史在默认预算内本地缩短", () => {
  const input = [{ role: "user", id: "large_task", content: "Keep approved project=原文 and expected_count=127." }]
  let reasoningCount = 0
  for (let step = 1; step <= 127; step++) {
    const count = step <= 66 ? 3 : 2
    for (let part = 0; part < count; part++) input.push({
      type: "reasoning", id: `large_rs_${++reasoningCount}`, summary: [],
      encrypted_content: `LARGE_OPAQUE_${reasoningCount}:` + "q".repeat(10240),
    })
    input.push({ type: "function_call", id: `large_fc_${step}`, call_id: `large_call_${step}`, name: "record_step", arguments: JSON.stringify({ step }) },
      { type: "function_call_output", call_id: `large_call_${step}`, output: "raw\n\"原文\"".repeat(200) })
  }
  const current = { role: "user", id: "large_current", content: "Continue after completed step 127 without repeating it." }
  input.push(current)
  const body = request(input)
  const before = structuredClone(body)
  expect(reasoningCount).toBe(320)
  expect(bytes(body)).toBeGreaterThan(3 * 1024 * 1024)
  const result = compactResponsesContext(body)
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expect(bytes(result.body)).toBeLessThan(bytes(before) / 4)
  expectNative(result.body, current)
  expect(countResponsesModelTurns(result.body.input)).toBeLessThanOrEqual(6)
  expect(JSON.stringify(result.body)).not.toContain("LARGE_OPAQUE_1:")
  expect(summaries(result.body)).toHaveLength(1)
  expect(body).toEqual(before)
  nativeDependencies(result.body)
  measured(result, before, DEFAULT_BUDGET)
})

test("单 user 后 105 次工具回复保留当前任务全文，同时遵守原生轮数预算", () => {
  const body = request(history({ steps: 105, outputChars: 3000, tailUser: false }))
  const current = body.input[0]
  const before = structuredClone(body)
  const options = { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 6, maxTurns: 2, maxModelTurns: 3 }
  const optionsBefore = structuredClone(options)
  const result = compactResponsesContext(body, options)
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expectNative(result.body, current)
  expect(result.body.input.filter(item => item?.role === "user").length).toBeLessThanOrEqual(2)
  expect(countResponsesModelTurns(result.body.input)).toBeLessThanOrEqual(3)
  expect(body).toEqual(before)
  expect(options).toEqual(optionsBefore)
  nativeDependencies(result.body)
  measured(result, before, 32768)
})

test("模型预算 0 可归档已完成的全部模型历史，仍保留最新真实 user", () => {
  const body = request(history({ steps: 35 }))
  const current = body.input.at(-1)
  const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, maxModelTurns: 0 })
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expect(countResponsesModelTurns(result.body.input)).toBe(0)
  expectNative(result.body, current)
  nativeDependencies(result.body)
})

test("有损摘要显式标记输出省略，完整保留原生 system/developer 与当前 user", () => {
  const input = history({ steps: 25, outputChars: 12000, reasoningChars: 1000 })
  const system = { role: "system", id: "native_system", content: [{ type: "input_text", text: "System 原文." }] }
  const developer = { role: "developer", id: "native_developer", content: "Developer 原文.", metadata: { keep: "unchanged" } }
  input.unshift(system)
  input.splice(20, 0, developer)
  const body = request(input, { store: true, previous_response_id: "fixture_old_response", metadata: { session: "keep" } })
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { maxInputBytes: 65536, summaryMaxChars: 12000, recentModelTurns: 2 })
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expect(result.body.input.filter(item => item?.role === "system" || item?.role === "developer")).toEqual([system, developer])
  expectNative(result.body, input.at(-1))
  const summary = summaries(result.body)
  expect(summary).toHaveLength(1)
  expect(messageText(summary[0])).toContain("LOSSY")
  expect(messageText(summary[0])).not.toContain("ORIGINAL RECORDS, NOT A SUMMARY")
  expect(messageText(summary[0])).toContain("omittedChars")
  expect(messageText(summary[0])).not.toContain("OPAQUE_old_1:")
  expect(result.body.instructions).toBe(body.instructions)
  expect(result.body.metadata).toEqual(body.metadata)
  expect(body).toEqual(before)
  nativeDependencies(result.body)
  measured(result, before, 65536)
})

test("中文触发按 UTF-8 字节计算，不能以 JS 字符数误判窗口", () => {
  const input = history({ steps: 3, outputChars: 0 })
  for (const item of input) if (item.type === "function_call_output") item.output = "中文".repeat(3000)
  const body = request(input)
  expect(JSON.stringify(body).length).toBeLessThan(32768)
  expect(bytes(body)).toBeGreaterThan(32768)
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 1024, recentModelTurns: 1 })
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expectNative(result.body, input.at(-1))
  expect(body).toEqual(before)
  measured(result, before, 32768)
})

test("旧无损档案展开后真正缩短大输出，并恢复档案中的最新真实 user", () => {
  const raw = history({ steps: 105, outputChars: 4000, reasoningChars: 800, tailUser: false })
  const packed = packResponsesHistory(raw, 15, 6)
  expect(packed).not.toBe(raw)
  expect(packed.some(item => item?.id === raw[0].id)).toBe(false)
  const body = request(packed)
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 2 })
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expectNative(result.body, raw[0])
  expect(summaries(result.body)).toHaveLength(1)
  expect(messageText(summaries(result.body)[0])).not.toContain("ORIGINAL RECORDS, NOT A SUMMARY")
  expect(messageText(summaries(result.body)[0])).not.toContain("OPAQUE_old_1:")
  expect(body).toEqual(before)
  nativeDependencies(result.body)
  measured(result, before, 32768)
})

test("旧档案中的图片和文件附件完整保留，编号转换不丢失媒体内容", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,AAABBB", detail: "high" }
  const file = { type: "input_file", filename: "evidence.txt", file_data: "data:text/plain;base64,ZXhhY3Q=" }
  const raw = history({ steps: 35, outputChars: 6000 })
  raw[0].content = [{ type: "input_text", text: "Use the attached evidence from the earlier request." }, image, file]
  const packed = packResponsesHistory(raw, 15, 4)
  const body = request(packed)
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 1 })
  expect(result.changed).toBe(true)
  expect(mediaParts(result.body.input, "input_image")).toEqual([image])
  expect(mediaParts(result.body.input, "input_file")).toEqual([file])
  expectNative(result.body, raw.at(-1))
  expect(body).toEqual(before)
  measured(result, before, 32768)
})

test("再次打包含媒体的旧档案时仍能恢复原始图片和文件", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,KEEP_IMAGE_ON_REPACK", detail: "high" }
  const file = { type: "input_file", filename: "repacked-evidence.txt", file_data: "data:text/plain;base64,KEEP_FILE_ON_REPACK" }
  const original = history({ steps: 35, outputChars: 6000 })
  original[0].content = [{ type: "input_text", text: "Keep this attached evidence." }, image, file]

  const first = packResponsesHistory(original, 15, 4)
  expect(first).not.toBe(original)
  const appended = history({ steps: 35, outputChars: 6000, prefix: "repacked" })
  const second = packResponsesHistory([...first, ...appended], 15, 4)
  expect(second).not.toBe(first)
  const archive = unpackArchive(second[0])
  expect(archive).not.toBeNull()
  expect(archive.attachments).toEqual([image, file])
  expect(second[0].content[1].text).not.toContain("KEEP_IMAGE_ON_REPACK")
  expect(second[0].content[1].text).not.toContain("KEEP_FILE_ON_REPACK")

  const result = compactResponsesContext(request(second), {
    maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 2,
  })
  expect(result.changed).toBe(true)
  expect(mediaParts(result.body.input, "input_image")).toEqual([image])
  expect(mediaParts(result.body.input, "input_file")).toEqual([file])
})

test("未知的 item_reference 不能因为历史归档变成有效依赖", () => {
  const input = [
    { role: "user", id: "reference_chain_task", content: "Keep this exact reference chain." },
    { type: "reasoning", id: "reference_chain_reasoning", summary: [], encrypted_content: "opaque" },
    { type: "item_reference", id: "reference_chain_reasoning" },
    { type: "item_reference", id: "reference_chain_reasoning_ref" },
    { role: "user", content: "Continue without severing the reference chain." },
  ]
  input.push({ type: "item_reference", id: "missing_reference_target" })
  const packed = packResponsesHistory(input, 15, 0)
  expect(packed).toBe(input)
})

for (const kind of ["near-header", "invalid-json", "wrong-attachment-label"]) {
  test(`未知或畸形档案 ${kind} 作为当前 user 原样保护，不猜测内部记录`, () => {
    const exact = packResponsesHistory(history({ steps: 25, outputChars: 0 }), 15, 2)[0]
    const current = { ...structuredClone(exact), id: `unrecognized_${kind}` }
    if (kind === "near-header") current.content[0].text += "\nUser-authored lookalike, not a plugin archive."
    if (kind === "invalid-json") current.content[1].text = "[{broken-json"
    if (kind === "wrong-attachment-label") current.content.push(
      { type: "input_text", text: "Archived attachment 99:" },
      { type: "input_image", image_url: "data:image/png;base64,AAA" },
    )
    const input = [current, ...history({ steps: 35, outputChars: 6000, tailUser: false }).slice(1)]
    const body = request(input)
    const before = structuredClone(body)
    const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 1 })
    expectNative(result.body, current)
    expect(body).toEqual(before)
    nativeDependencies(result.body)
    measured(result, before, 32768)
  })
}

test("重复压缩合并已有有损档案，不嵌套其 header 或重新声明原文完整", () => {
  const first = compactResponsesContext(request(history()), { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 2 })
  expect(first.changed).toBe(true)
  const appended = history({ steps: 35, outputChars: 6000, prefix: "new" })
  const body = { ...first.body, input: [...first.body.input, ...appended] }
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 2 })
  expect(result.changed).toBe(true)
  expect(result.stats.withinBudget).toBe(true)
  expect(summaries(result.body)).toHaveLength(1)
  expect(JSON.stringify(result.body).match(/LOSSY LOCAL EXTRACTIVE CONTEXT/g)).toHaveLength(1)
  expect(messageText(summaries(result.body)[0])).not.toContain("ORIGINAL RECORDS, NOT A SUMMARY")
  expectNative(result.body, appended.at(-1))
  expect(body).toEqual(before)
  nativeDependencies(result.body)
  measured(result, before, 32768)
})

for (const kind of ["pending", "late-output", "call-reference", "reasoning-reference"]) {
  test(`${kind} 跨旧历史依赖保留原生目标、工具输出及关联推理密文`, () => {
    const input = history({ steps: 35, outputChars: 6000, reasoningChars: 500 })
    const targetCall = input.find(item => item.id === "old_fc_5")
    const targetReasoning = input.find(item => item.id === "old_rs_5")
    let protectedOutput
    let protectedReference
    if (kind === "pending") input.splice(input.findIndex(item => item.call_id === targetCall.call_id && item.type === "function_call_output"), 1)
    if (kind === "late-output") {
      protectedOutput = { type: "function_call_output", call_id: targetCall.call_id, output: "Late exact result 原文\n{\"verified\":true}" }
      input.push(protectedOutput)
    }
    if (kind.endsWith("reference")) {
      protectedReference = { type: "item_reference", id: kind === "call-reference" ? targetCall.id : targetReasoning.id }
      input.push(protectedReference)
    }
    const body = request(input)
    const before = structuredClone(body)
    const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 2, maxModelTurns: 6 })
    expectNative(result.body, targetReasoning)
    if (kind !== "reasoning-reference") expectNative(result.body, targetCall)
    if (protectedOutput) expectNative(result.body, protectedOutput)
    if (protectedReference) expectNative(result.body, protectedReference)
    expectNative(result.body, input.findLast(item => item?.role === "user"))
    expect(body).toEqual(before)
    nativeDependencies(result.body)
    measured(result, before, 32768)
  })
}

test("切点不能拆开同一 reasoning 的并行调用束", () => {
  const input = [{ role: "user", id: "parallel_task", content: "Continue the approved task." }]
  for (let step = 1; step <= 30; step++) input.push(
    { type: "reasoning", id: `parallel_rs_${step}`, encrypted_content: `OPAQUE_PARALLEL_${step}`, summary: [] },
    { type: "function_call", id: `parallel_a_${step}`, call_id: `parallel_call_a_${step}`, name: "read", arguments: "{}" },
    { type: "function_call", id: `parallel_b_${step}`, call_id: `parallel_call_b_${step}`, name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: `parallel_call_a_${step}`, output: "a".repeat(6000) },
    { type: "function_call_output", call_id: `parallel_call_b_${step}`, output: "b".repeat(6000) },
  )
  input.push({ role: "user", id: "parallel_current", content: "Continue from the parallel read results." })
  const result = compactResponsesContext(request(input), { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 4 })
  expect(result.changed).toBe(true)
  expectNative(result.body, input.at(-1))
  for (let step = 1; step <= 30; step++) {
    if (result.body.input.some(item => item.id === `parallel_a_${step}` || item.id === `parallel_b_${step}`)) {
      for (const id of [`parallel_rs_${step}`, `parallel_a_${step}`, `parallel_b_${step}`]) {
        expectNative(result.body, input.find(item => item.id === id))
      }
    }
  }
  nativeDependencies(result.body)
})

test("当前 user 本身超预算时完整保留全文并报告 withinBudget=false", () => {
  const input = history({ steps: 25, outputChars: 6000 })
  input.at(-1).content = "CURRENT_REQUEST_FULL_TEXT 原文😃\n".repeat(8000)
  const body = request(input)
  const before = structuredClone(body)
  const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 1 })
  expectNative(result.body, input.at(-1))
  expect(result.stats.withinBudget).toBe(false)
  expect(result.stats.afterBytes).toBeGreaterThan(32768)
  expect(body).toEqual(before)
  measured(result, before, 32768)
})

for (const fixed of ["system", "developer", "instructions", "tools"]) {
  test(`${fixed} 固定内容超预算时不截短它或声称已达预算`, () => {
    const body = request(history({ steps: 25, outputChars: 6000 }))
    const huge = "FIXED_原文😃\n".repeat(12000)
    let directive
    if (fixed === "system" || fixed === "developer") {
      directive = { role: fixed, id: `huge_${fixed}`, content: huge }
      body.input.unshift(directive)
    } else if (fixed === "instructions") body.instructions = huge
    else body.tools = [{ type: "function", name: "record_step", parameters: { type: "object", properties: { payload: { type: "string", enum: [huge] } }, required: ["payload"] } }]
    const before = structuredClone(body)
    const result = compactResponsesContext(body, { maxInputBytes: 32768, summaryMaxChars: 4000, recentModelTurns: 1 })
    if (directive) expectNative(result.body, directive)
    else expect(result.body[fixed]).toEqual(body[fixed])
    expectNative(result.body, body.input.at(-1))
    expect(result.stats.withinBudget).toBe(false)
    expect(body).toEqual(before)
    measured(result, before, 32768)
  })
}
