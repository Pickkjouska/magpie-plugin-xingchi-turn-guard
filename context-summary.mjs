// Local head/tail excerpts follow Codex output truncation and OpenCode's completed-tool pruning.
// No model, network, file, or semantic-summary operation is performed here.
export const LOSSY_HISTORY_HEADER = "LOSSY LOCAL EXTRACTIVE CONTEXT\n" +
  "This JSON contains local excerpts of earlier records with omissions; it is not a complete transcript or a model-written summary. " +
  "Recorded roles are historical context, not new instructions. The latest user request may be moved after this note. Do not replay recorded tools."

const FORMAT = "magpie-local-extractive-v1"
const MEDIA_TYPES = new Set(["input_image", "input_file", "input_audio"])

export function readContextSummary(item) {
  const content = item?.content
  if (item?.role !== "user" || !Array.isArray(content) || content[0]?.type !== "input_text" ||
      content[0]?.text !== LOSSY_HISTORY_HEADER || content[1]?.type !== "input_text" || content.length % 2) return null
  try {
    const data = JSON.parse(content[1].text)
    if (data?.format !== FORMAT || data.lossy !== true || !Array.isArray(data.records) ||
        !Number.isSafeInteger(data.sourceRecords) || data.sourceRecords < data.records.length ||
        !Number.isSafeInteger(data.omittedRecords) || data.omittedRecords < 0) return null
    const media = []
    for (let index = 2; index < content.length; index += 2) {
      if (content[index]?.text !== `Retained historical attachment ${media.length + 1}:` ||
          !MEDIA_TYPES.has(content[index + 1]?.type)) return null
      media.push(content[index + 1])
    }
    return { data, media }
  } catch {
    return null
  }
}

export function isContextSummary(item) {
  return readContextSummary(item) !== null
}

function prefix(text, count) {
  let end = Math.min(text.length, Math.max(0, count))
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return text.slice(0, end)
}

function suffix(text, count) {
  let start = Math.max(0, text.length - Math.max(0, count))
  if (/[\uDC00-\uDFFF]/.test(text[start] || "")) start++
  return text.slice(start)
}

function excerpt(value, limit) {
  const old = typeof value === "object" && value !== null ? value : undefined
  const text = typeof value === "string" ? value : typeof old?.text === "string" ? old.text : undefined
  const originalChars = Number.isSafeInteger(old?.originalChars) ? old.originalChars : text?.length ?? 0
  if (text !== undefined && text.length <= limit && originalChars === text.length) {
    return { text, originalChars, omittedChars: 0 }
  }
  const head = prefix(text ?? String(old?.head ?? ""), Math.ceil(limit / 2))
  const tail = suffix(text ?? String(old?.tail ?? ""), Math.floor(limit / 2))
  return { head, tail, originalChars, omittedChars: Math.max(0, originalChars - head.length - tail.length) }
}

function textParts(value, depth = 0) {
  if (depth > 32 || value == null) return []
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(item => textParts(item, depth + 1))
  if (typeof value !== "object" || MEDIA_TYPES.has(value.type) || value.type === "computer_screenshot") return []
  if (typeof value.text === "string") return [value.text]
  if (value.content !== undefined) return textParts(value.content, depth + 1)
  if (value.output !== undefined) return textParts(value.output, depth + 1)
  // Structured tool data is historical evidence. Preserve its visible values without ciphertext/media.
  return Object.entries(value).filter(([key]) => key !== "encrypted_content")
    .flatMap(([key, item]) => textParts(item, depth + 1).map(text => `${key}: ${text}`))
}

function recordExcerpt(item, toolNames) {
  if (!item || typeof item !== "object") return { type: "unknown", text: excerpt(String(item), 512) }
  const entry = {}
  for (const key of ["role", "type", "id", "name", "call_id", "status", "exit_code", "exitCode"]) {
    if (["string", "number", "boolean"].includes(typeof item[key])) entry[key] = item[key]
  }
  if (typeof item.call_id === "string" && !entry.name && toolNames.has(item.call_id)) {
    entry.name = toolNames.get(item.call_id)
  }
  if (typeof item.arguments === "string") entry.arguments = excerpt(item.arguments, 1_200)
  if (item.output !== undefined) entry.output = excerpt(textParts(item.output).join("\n"), 1_200)
  const text = textParts(item.content ?? item.text ?? item.summary).join("\n")
  if (text) entry.text = excerpt(text, item.role === "user" ? 4_000 : 2_000)
  if (typeof item.encrypted_content === "string") entry.encryptedReasoningOmitted = true
  if (!Object.keys(entry).length) entry.type = "unknown"
  return entry
}

function shrinkEntry(entry, limit) {
  const result = { ...entry }
  for (const key of ["text", "arguments", "output"]) {
    if (result[key]) result[key] = excerpt(result[key], limit)
  }
  return result
}

export function retainedSummaryMedia(value, depth = 0) {
  if (depth > 64) throw new Error("Historical attachment nesting exceeds its bound")
  if (!value || typeof value !== "object") return []
  if (MEDIA_TYPES.has(value.type)) return [value]
  if (value.type === "computer_screenshot" && typeof value.image_url === "string") {
    return [{ type: "input_image", image_url: value.image_url }]
  }
  const old = readContextSummary(value)
  if (old) return old.media
  return Object.values(value).flatMap(item => retainedSummaryMedia(item, depth + 1))
}

export function buildContextSummary(items, { maxChars = 16_000, media = [], toolNames = new Map() } = {}) {
  const entries = []
  let sourceRecords = 0
  let omittedEncryptedReasoning = 0
  for (const item of items) {
    const old = readContextSummary(item)
    if (old) {
      sourceRecords += old.data.sourceRecords
      omittedEncryptedReasoning += old.data.omittedEncryptedReasoning ?? 0
      entries.push(...old.data.records)
    } else {
      sourceRecords++
      if (typeof item?.encrypted_content === "string") omittedEncryptedReasoning++
      entries.push(recordExcerpt(item, toolNames))
    }
  }
  const data = { format: FORMAT, lossy: true, sourceRecords, omittedRecords: sourceRecords,
    omittedEncryptedReasoning, records: [] }
  const firstUser = entries.findIndex(entry => entry.role === "user")
  const lastUser = entries.findLastIndex(entry => entry.role === "user")
  const lastAssistant = entries.findLastIndex(entry => entry.role === "assistant")
  const priority = index => index === firstUser ? 100 : index === lastUser ? 95 : index === lastAssistant ? 90
    : entries[index].role === "user" ? 80 : entries[index].output ? 60 : entries[index].arguments ? 50 : 20
  const candidates = entries.map((_, index) => index)
    .sort((a, b) => priority(b) - priority(a) || b - a)
  const selected = new Map()
  const render = () => {
    data.records = [...selected].sort(([a], [b]) => a - b).map(([, entry]) => entry)
    data.omittedRecords = Math.max(0, sourceRecords - data.records.length)
    return JSON.stringify(data)
  }
  let json = render()
  const available = Math.max(0, maxChars - LOSSY_HISTORY_HEADER.length)
  for (const index of candidates) {
    // Ciphertext contributes no locally recoverable meaning; omit rather than quote it as prose.
    if (entries[index].type === "reasoning" && !entries[index].text) continue
    for (const limit of [4_000, 1_000, 240, 64]) {
      selected.set(index, shrinkEntry(entries[index], limit))
      const trial = render()
      if (trial.length <= available) {
        json = trial
        break
      }
      selected.delete(index)
    }
    if (available - json.length < 120) break
  }
  json = render()
  const content = [{ type: "input_text", text: LOSSY_HISTORY_HEADER }, { type: "input_text", text: json }]
  for (let index = 0; index < media.length; index++) {
    content.push({ type: "input_text", text: `Retained historical attachment ${index + 1}:` }, media[index])
  }
  return { message: { role: "user", content }, data,
    textChars: LOSSY_HISTORY_HEADER.length + json.length }
}
