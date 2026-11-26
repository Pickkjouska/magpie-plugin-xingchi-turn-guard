import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { countResponsesModelTurns, packResponsesHistory } from "./history.mjs"
import { compactResponsesContext } from "./context-compression.mjs"
import { isContextSummary } from "./context-summary.mjs"
import { createTurnLimitCache, isTurnLimit, parseTurnFeedback, turnLimitScope } from "./turn-limits.mjs"

const DEFAULT_BASE_URL = "https://api.xingchiapi.com/v1"
const DEFAULT_MAX_TURNS = 15
const providerCache = new Map()
const limitCaches = new Map()

function configDirectory(options) {
  if (typeof options?.configDirectory === "string" && options.configDirectory.trim()) {
    return options.configDirectory
  }
  if (process.env.XINGCHI_MAGPIE_CONFIG_DIRECTORY) return process.env.XINGCHI_MAGPIE_CONFIG_DIRECTORY
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(configHome, "magpie")
}

function providerId(options) {
  return typeof options?.providerId === "string" && options.providerId.trim()
    ? options.providerId.trim() : ""
}

function modelEntries(provider) {
  const values = Array.isArray(provider?.models)
    ? provider.models
    : provider?.models && typeof provider.models === "object" ? Object.values(provider.models) : []
  return values.map(value => typeof value === "string"
    ? { id: value, apiId: value }
    : value && typeof value === "object"
      ? { id: value.id ?? value.name, apiId: value.apiId ?? value.id ?? value.name }
      : null).filter(value => typeof value?.id === "string" && value.id)
}

function isXingchiProvider(provider) {
  const endpoints = [provider?.responses, provider?.chat, provider?.baseAPI]
    .filter(value => typeof value === "string")
  return endpoints.some(endpoint => {
    try {
      const host = new URL(endpoint).hostname.toLowerCase()
      return host === "api.xingchiapi.com" || host.endsWith(".api.xingchiapi.com")
    } catch {
      return false
    }
  })
}

async function loadProvider(options) {
  const directory = configDirectory(options)
  const id = providerId(options)
  const cacheKey = `${directory}\n${id || "auto"}`
  const cached = providerCache.get(cacheKey)
  if (cached && Date.now() - cached.at < 1500) return cached.value
  try {
    const data = JSON.parse(await readFile(join(directory, "providers.json"), "utf8"))
    const providers = Array.isArray(data?.providers) ? data.providers : []
    const configured = id ? providers.find(item => item?.id === id) : null
    const provider = configured && isXingchiProvider(configured) ? configured : providers.find(isXingchiProvider)
    if (!provider || typeof provider.key !== "string" || !provider.key) return null
    const value = {
      id: provider.id,
      key: provider.key,
      baseUrl: options?.baseUrl || provider.responses || provider.chat || DEFAULT_BASE_URL,
      models: modelEntries(provider),
      directory,
    }
    providerCache.set(cacheKey, { at: Date.now(), value })
    return value
  } catch {
    return null
  }
}

function apiModelFor(model, provider) {
  if (typeof model !== "string" || !provider) return null
  const prefix = `${provider.id}/`
  if (!model.startsWith(prefix)) return null
  const candidate = model.slice(prefix.length)
  const match = provider.models.find(item => item.id === candidate || item.apiId === candidate)
  return match?.apiId ?? null
}

function limitCache(directory) {
  let cache = limitCaches.get(directory)
  if (!cache) {
    cache = createTurnLimitCache(directory)
    limitCaches.set(directory, cache)
  }
  return cache
}

function configuredTurns(options, metric) {
  const value = options?.[metric === "model" ? "maxModelTurns" : "maxTurns"]
  // Zero disables only proactive packing for this metric; learned limits still apply.
  if (value === 0) return undefined
  return Number.isSafeInteger(value) && value >= 2 ? value : DEFAULT_MAX_TURNS
}

async function requestLimit(provider, apiModel, options, metric = "user") {
  const scope = turnLimitScope(provider.baseUrl, provider.key, apiModel, metric)
  if (!scope) return undefined
  const observed = await limitCache(provider.directory).get(scope)
  const requested = configuredTurns(options, metric)
  const valid = metric === "model" ? Number.isSafeInteger(observed) && observed >= 0 : isTurnLimit(observed)
  return valid ? requested === undefined ? observed : Math.min(observed, requested) : requested
}

export async function onRequest(body, ctx) {
  if (ctx?.protocol !== "responses" || !Array.isArray(body?.input) || ctx.options?.historyPacking === false) {
    return undefined
  }
  const provider = await loadProvider(ctx.options)
  const apiModel = apiModelFor(ctx.model, provider) ?? apiModelFor(body.model, provider)
  if (!apiModel) return undefined
  const [maxTurns, maxModelTurns] = await Promise.all([
    requestLimit(provider, apiModel, ctx.options),
    requestLimit(provider, apiModel, ctx.options, "model"),
  ])
  const compacted = compactResponsesContext(body, { ...ctx.options, maxTurns, maxModelTurns })
  const prepared = compacted.body
  if (ctx.state && compacted.changed) {
    ctx.state.contextCompression = {
      beforeBytes: compacted.stats.beforeBytes,
      afterBytes: compacted.stats.afterBytes,
      withinBudget: compacted.stats.withinBudget,
    }
  }
  if (compacted.changed && compacted.stats.afterBytes < compacted.stats.beforeBytes) {
    ctx.report?.("ready", Math.min(32768, compacted.stats.beforeBytes - compacted.stats.afterBytes))
  }
  // Higher-priority messages must remain native; quoting them inside a user archive
  // preserves their text but would lower their instruction priority.
  const directives = prepared.input.filter(item => item?.role === "system" || item?.role === "developer")
  // A lossy extract stays explicitly identified even after later turn packing.
  const summaries = prepared.input.filter(isContextSummary)
  const history = directives.length || summaries.length
    ? prepared.input.filter(item => item?.role !== "system" && item?.role !== "developer" && !isContextSummary(item))
    : prepared.input
  const availableTurns = maxTurns === undefined ? undefined : maxTurns - summaries.length
  const input = summaries.length && availableTurns < 2 ? history
    : packResponsesHistory(history, availableTurns, maxModelTurns)
  if (input === history && !compacted.changed) return undefined
  // Send the rewritten full history rather than append it to a stored response chain.
  const packed = { ...prepared, input: [...directives, ...summaries, ...input], store: false }
  delete packed.previous_response_id
  return packed
}

export async function onResponse(reply, ctx) {
  if (ctx?.protocol !== "responses") return
  const provider = await loadProvider(ctx?.options)
  const apiModel = apiModelFor(ctx?.model, provider) ?? apiModelFor(ctx?.request?.model, provider)
  if (!apiModel) return
  const feedback = parseTurnFeedback(reply)
  if (!feedback) return
  const scope = turnLimitScope(provider.baseUrl, provider.key, apiModel, feedback.metric)
  if (!scope) return
  if (feedback.metric === "user") {
    if (isTurnLimit(feedback.limit)) await limitCache(provider.directory).remember(scope, feedback.limit)
    return
  }
  const sentModels = Array.isArray(ctx?.request?.input)
    ? countResponsesModelTurns(ctx.request.input) : undefined
  if (feedback.limit === undefined && sentModels === 0) return
  // A reported count is where the request was rejected, not a proven server ceiling.
  const budget = feedback.limit === undefined
    ? Math.floor(Math.min(feedback.rejectedAt, sentModels ?? feedback.rejectedAt) / 2)
    : Math.max(0, feedback.limit - 5)
  await limitCache(provider.directory).remember(scope, budget, "model")
}
