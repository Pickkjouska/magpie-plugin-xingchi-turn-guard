import { countResponsesModelTurns, safeResponsesHistoryCut, unpackArchive } from "./history.mjs"
import { buildContextSummary, isContextSummary, retainedSummaryMedia } from "./context-summary.mjs"

const DEFAULT_MAX_INPUT_BYTES = 192 * 1024
const MAX_ARCHIVE_DEPTH = 8
const MEDIA_TYPES = new Set(["input_image", "input_file", "input_audio"])
const jsonBytes = value => Buffer.byteLength(JSON.stringify(value), "utf8")
const directive = item => item?.role === "system" || item?.role === "developer"
const user = item => item?.role === "user"
const modelLimitSet = value => Number.isSafeInteger(value) && value >= 0

function restoreValue(value, attachments, depth = 0, screenshotUrl = false) {
  if (depth > 64) throw new Error("Historical value nesting exceeds its bound")
  if (!value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(item => restoreValue(item, attachments, depth + 1))
  if (Object.hasOwn(value, "archived_attachment")) {
    const position = value.archived_attachment
    const part = Number.isSafeInteger(position) && position > 0 ? attachments[position - 1] : undefined
    if (!part || !MEDIA_TYPES.has(part.type)) throw new Error("Invalid historical attachment reference")
    const keys = Object.keys(value)
    if (screenshotUrl && keys.length === 1 && part.type === "input_image" && typeof part.image_url === "string") {
      return part.image_url
    }
    if (keys.length !== 2 || value.original_type !== part.type) throw new Error("Ambiguous historical attachment marker")
    return part
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    restoreValue(item, attachments, depth + 1, value.type === "computer_screenshot" && key === "image_url")]))
}

function expandHistory(input, depth = 0, counter = { count: 0 }) {
  if (depth > MAX_ARCHIVE_DEPTH) throw new Error("Nested historical archives exceed their bound")
  const result = []
  for (const item of input) {
    // Only the exact, known transport format is decoded. Unrecognized user text remains opaque.
    const archive = item?.content?.[0]?.type === "input_text" ? unpackArchive(item) : null
    if (!archive) {
      result.push(item)
      continue
    }
    counter.count++
    const restored = restoreValue(archive.archived, archive.attachments)
    result.push(...expandHistory(restored, depth + 1, counter))
  }
  return result
}

function nativeCut(history, options) {
  const models = []
  const users = []
  const outputs = new Set()
  let liveReference = history.length
  for (let index = 0; index < history.length; index++) {
    if (countResponsesModelTurns([history[index]])) models.push(index)
    if (user(history[index]) && !isContextSummary(history[index])) users.push(index)
    if (history[index]?.type === "item_reference") liveReference = Math.min(liveReference, index)
    if (history[index]?.type?.endsWith("_output") && typeof history[index]?.call_id === "string") {
      // A later output for an already completed call is a fresh native dependency, not stale history.
      if (outputs.has(history[index].call_id)) liveReference = Math.min(liveReference, index)
      outputs.add(history[index].call_id)
    }
  }
  const recent = Number.isSafeInteger(options.recentModelTurns) && options.recentModelTurns >= 0
    ? options.recentModelTurns : 6
  const limit = modelLimitSet(options.maxModelTurns)
    ? Math.min(recent, options.maxModelTurns) : recent
  let cut = models.length > limit ? limit ? models[models.length - limit] : history.length
    : models[0] ?? users.at(-1) ?? history.length
  if (Number.isSafeInteger(options.maxTurns) && options.maxTurns > 0 && users.length >= options.maxTurns) {
    cut = Math.max(cut, users[Math.max(0, users.length - Math.max(1, options.maxTurns - 1))])
  }
  cut = Math.min(cut, liveReference)
  return { cut: safeResponsesHistoryCut(history, cut, { preserveBundle: true }), latestUser: users.at(-1), modelLimit: limit }
}

export function compactResponsesContext(body, options = {}) {
  const budgetBytes = Number.isSafeInteger(options.maxInputBytes) && options.maxInputBytes >= 4_096
    ? options.maxInputBytes : DEFAULT_MAX_INPUT_BYTES
  let beforeBytes
  try { beforeBytes = jsonBytes(body) } catch {
    return { body, changed: false, stats: { beforeBytes: 0, afterBytes: 0, budgetBytes,
      withinBudget: false, reason: "unsupported_request" } }
  }
  const stats = { beforeBytes, afterBytes: beforeBytes, budgetBytes, withinBudget: beforeBytes <= budgetBytes }
  const unchanged = reason => ({ body, changed: false, stats: { ...stats, reason } })
  if (options.contextCompression === false) return unchanged("disabled")
  if (!Array.isArray(body?.input)) return unchanged("unsupported_input")
  const { maxTurns, maxModelTurns } = options
  // A summary and the latest user leave no slot for a separate exact archive.
  const mergeForTurns = Number.isSafeInteger(maxTurns) && maxTurns >= 2 &&
    body.input.filter(isContextSummary).length >= maxTurns - 1 && (
      body.input.filter(user).length > maxTurns ||
      modelLimitSet(maxModelTurns) && countResponsesModelTurns(body.input) > maxModelTurns)
  if (stats.withinBudget && !mergeForTurns) return unchanged("below_threshold")

  try {
    const archives = { count: 0 }
    const expanded = expandHistory(body.input, 0, archives)
    const directives = expanded.filter(directive)
    const history = expanded.filter(item => !directive(item))
    const toolNames = new Map(history.filter(item => typeof item?.name === "string" && typeof item?.call_id === "string")
      .map(item => [item.call_id, item.name]))
    const maxSummaryChars = Number.isSafeInteger(options.summaryMaxChars) && options.summaryMaxChars >= 512
      ? options.summaryMaxChars : 16_000
    const initial = nativeCut(history, options)
    const levels = [...new Set([initial.modelLimit, Math.floor(initial.modelLimit / 2), 1, 0])]
      .filter(limit => limit <= initial.modelLimit)
    const attempted = new Set()
    let best
    for (const recentModelTurns of levels) {
      const { cut, latestUser, modelLimit } = nativeCut(history, { ...options, recentModelTurns })
      if (cut === 0 || attempted.has(cut)) continue
      attempted.add(cut)
      const pinned = latestUser !== undefined && latestUser < cut ? [history[latestUser]] : []
      const previous = history.slice(0, cut).filter((_, index) => !pinned.length || index !== latestUser)
      if (!previous.length) continue
      const tail = history.slice(cut)
      if (mergeForTurns && (1 + pinned.length + tail.filter(user).length > maxTurns ||
          modelLimitSet(maxModelTurns) && countResponsesModelTurns(tail) > maxModelTurns)) continue
      const media = previous.flatMap(item => retainedSummaryMedia(item))
      let summaryMaxChars = maxSummaryChars
      for (let attempt = 0; attempt < 5; attempt++) {
        const summary = buildContextSummary(previous, { maxChars: summaryMaxChars, media, toolNames })
        const candidate = { ...body, input: [...directives, summary.message, ...pinned, ...tail], store: false }
        delete candidate.previous_response_id
        const afterBytes = jsonBytes(candidate)
        if (!best || afterBytes < best.afterBytes) best = { candidate, afterBytes, summary, media, tail, modelLimit }
        if (afterBytes <= budgetBytes || summaryMaxChars === 512) break
        summaryMaxChars = Math.max(512, Math.floor(summaryMaxChars * Math.min(0.7, budgetBytes / afterBytes)))
      }
      // Completed recent bundles are a preference. If they alone prevent fitting, try fewer;
      // the shared dependency closure continues protecting pending calls and native references.
      if (best?.afterBytes <= budgetBytes) break
    }
    if (!best) return unchanged("protected_dependencies")
    const { candidate, afterBytes, summary, media, tail, modelLimit } = best
    if (afterBytes >= beforeBytes && !(mergeForTurns && afterBytes <= budgetBytes)) return unchanged("no_safe_reduction")
    return { body: candidate, changed: true, stats: { ...stats, afterBytes,
      withinBudget: afterBytes <= budgetBytes,
      reason: afterBytes > budgetBytes ? "protected_content_exceeds_budget" :
        stats.withinBudget ? "merged_summary_for_turns" : "locally_compressed",
      decodedArchives: archives.count, summarizedRecords: summary.data.sourceRecords,
      omittedRecords: summary.data.omittedRecords, omittedEncryptedReasoning: summary.data.omittedEncryptedReasoning,
      retainedMedia: media.length, retainedModelTurns: countResponsesModelTurns(tail),
      retainedModelBudget: modelLimit, summaryChars: summary.textChars } }
  } catch {
    return unchanged("protected_or_invalid_archive")
  }
}
