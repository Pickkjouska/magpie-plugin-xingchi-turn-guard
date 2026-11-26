/**
 * Clean-room implementation of the published history helpers.
 *
 * The archive stores exact JSON records. It is deliberately a plain user item so
 * Responses clients can replay the archived material without a side channel.
 */

const ARCHIVE_TITLE = "EARLIER CONVERSATION (ORIGINAL RECORDS, NOT A SUMMARY)";
const MEDIA_KINDS = new Set(["input_image", "input_file", "input_audio"]);
const MAX_ARCHIVE_DEPTH = 8;
const MAX_VALUE_DEPTH = 64;

const isPlainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isDirective = item => item?.role === "system" || item?.role === "developer";
const isModelOutput = item => {
  if (!isPlainObject(item)) return false;
  if (item.role === "assistant") return true;
  const kind = item.type;
  if (typeof kind !== "string") return false;
  return kind === "reasoning" || kind === "item_reference" ||
    (kind.endsWith("_call") && !kind.endsWith("_output"));
};
const isCall = item => typeof item?.type === "string" &&
  item.type.endsWith("_call") && !item.type.endsWith("_output");
const isCallResult = item => typeof item?.type === "string" && item.type.endsWith("_output");

/** Count native model-produced items; tool results are evidence, not another turn. */
export function countResponsesModelTurns(items) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) if (isModelOutput(item)) total += 1;
  return total;
}

/** Decode only the exact archive transport format emitted below. */
export function unpackArchive(item) {
  const content = item?.content;
  if (item?.role !== "user" || !Array.isArray(content) ||
      content[0]?.type !== "input_text" || content[0].text !== ARCHIVE_TITLE ||
      content[1]?.type !== "input_text" || typeof content[1].text !== "string") return null;
  let archived;
  try { archived = JSON.parse(content[1].text); } catch { return null; }
  if (!Array.isArray(archived)) return null;
  const attachments = [];
  for (let index = 2; index < content.length;) {
    const expected = attachments.length + 1;
    if (content[index]?.type !== "input_text" || content[index].text !== `Archived attachment ${expected}:`) return null;
    const media = content[index + 1];
    if (!MEDIA_KINDS.has(media?.type)) return null;
    attachments.push(media);
    index += 2;
  }
  return { archived, attachments };
}

/** Move a proposed archive boundary left until no native dependency is severed. */
export function safeResponsesHistoryCut(items, proposed, options = {}) {
  if (!Array.isArray(items) || !Number.isInteger(proposed)) return 0;
  let cut = Math.max(0, Math.min(items.length, proposed));
  const idAt = new Map();
  const calls = new Map();
  const results = new Map();
  items.forEach((item, index) => {
    if (item?.type !== "item_reference" && typeof item?.id === "string") idAt.set(item.id, index);
    if (isCall(item) && typeof item.call_id === "string") calls.set(item.call_id, index);
    if (isCallResult(item) && typeof item.call_id === "string") results.set(item.call_id, index);
  });
  for (const [callId, callAt] of calls) {
    const resultAt = results.get(callId);
    if (callAt < cut && (resultAt === undefined || resultAt >= cut)) cut = callAt;
  }
  for (const [callId, resultAt] of results) {
    const callAt = calls.get(callId);
    if (resultAt < cut && (callAt === undefined || callAt >= cut)) cut = resultAt;
  }
  items.forEach((item, index) => {
    if (item?.type !== "item_reference") return;
    const targetAt = idAt.get(item.id);
    if (index >= cut) {
      if (targetAt === undefined) cut = Math.min(cut, index);
      else if (targetAt < cut) cut = targetAt;
    } else if (targetAt === undefined || targetAt >= cut) {
      cut = Math.min(cut, index);
    }
  });
  if (options.preserveBundle && cut > 0 && cut < items.length &&
      (isCall(items[cut]) || isCallResult(items[cut]))) {
    let start = cut;
    if (isCallResult(items[cut])) {
      const callAt = calls.get(items[cut].call_id);
      if (callAt !== undefined) start = Math.min(start, callAt);
    }
    while (start > 0 && (items[start - 1]?.type === "reasoning" || isCall(items[start - 1]))) start -= 1;
    cut = start;
  }
  return cut;
}

function restoreArchiveValue(value, attachments, depth = 0, screenshotUrl = false) {
  if (depth > MAX_VALUE_DEPTH) throw new Error("Archived value nesting exceeds its bound");
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => restoreArchiveValue(item, attachments, depth + 1));
  if (Object.hasOwn(value, "archived_attachment")) {
    const index = value.archived_attachment;
    const part = Number.isSafeInteger(index) && index > 0 ? attachments[index - 1] : undefined;
    if (!part || !MEDIA_KINDS.has(part.type)) throw new Error("Invalid archived media reference");
    const keys = Object.keys(value);
    if (screenshotUrl && keys.length === 1 && part.type === "input_image" && typeof part.image_url === "string") {
      return part.image_url;
    }
    if (keys.length !== 2 || value.original_type !== part.type) throw new Error("Ambiguous archived media marker");
    return part;
  }
  const restored = {};
  for (const [key, child] of Object.entries(value)) {
    const isScreenshotUrl = value.type === "computer_screenshot" && key === "image_url";
    restored[key] = restoreArchiveValue(child, attachments, depth + 1, isScreenshotUrl);
  }
  return restored;
}

function exactArchive(records) {
  const attachments = [];
  const serializable = value => {
    if (Array.isArray(value)) return value.map(serializable);
    if (!isPlainObject(value)) return value;
    if (MEDIA_KINDS.has(value.type)) {
      attachments.push(value);
      return { archived_attachment: attachments.length, original_type: value.type };
    }
    const copy = {};
    for (const [key, child] of Object.entries(value)) {
      if (value.type === "computer_screenshot" && key === "image_url" && typeof child === "string") {
        const part = { type: "input_image", image_url: child };
        attachments.push(part);
        copy[key] = { archived_attachment: attachments.length };
      } else {
        copy[key] = serializable(child);
      }
    }
    return copy;
  };
  const text = JSON.stringify(serializable(records));
  const content = [
    { type: "input_text", text: ARCHIVE_TITLE },
    { type: "input_text", text },
  ];

  // Keep media as native parts as well as inside the exact JSON archive. The
  // numbered labels give a reader a stable link from the archive to each part.
  attachments.forEach((part, index) => {
    content.push({ type: "input_text", text: `Archived attachment ${index + 1}:` });
    content.push(part);
  });
  return { role: "user", content };
}

function hasCompleteDependencies(items) {
  const calls = new Map();
  const outputs = new Map();
  const ids = new Set();
  for (const item of items) {
    if (item?.type !== "item_reference" && typeof item?.id === "string") ids.add(item.id);
    if (isCall(item) && typeof item.call_id === "string") {
      calls.set(item.call_id, (calls.get(item.call_id) ?? 0) + 1);
    }
    if (isCallResult(item) && typeof item.call_id === "string") {
      outputs.set(item.call_id, (outputs.get(item.call_id) ?? 0) + 1);
    }
  }
  for (const [callId, count] of calls) if (count !== 1 || outputs.get(callId) !== 1) return false;
  for (const [callId, count] of outputs) if (count !== 1 || calls.get(callId) !== 1) return false;
  for (const item of items) {
    if (item?.type === "item_reference" &&
        (typeof item.id !== "string" || !ids.has(item.id))) return false;
  }
  return true;
}

function nativeSuffixIsSafe(records) {
  const positions = new Map();
  records.forEach((item, index) => {
    if (item?.type !== "item_reference" && typeof item?.id === "string") positions.set(item.id, index);
  });
  const calls = new Map();
  records.forEach((item, index) => {
    if (isCall(item) && typeof item.call_id === "string") calls.set(item.call_id, index);
  });
  for (let index = 0; index < records.length; index += 1) {
    const item = records[index];
    if (isCallResult(item) && calls.get(item.call_id) === undefined) return false;
    if (item?.type === "item_reference") {
      const target = positions.get(item.id);
      if (target === undefined || target >= index) return false;
    }
  }
  return true;
}

function atomicBoundary(records, proposed) {
  let boundary = proposed;
  if (isCallResult(records[boundary])) return -1;
  if (isCall(records[boundary])) {
    while (boundary > 0 && (records[boundary - 1]?.type === "reasoning" || isCall(records[boundary - 1]))) {
      boundary -= 1;
    }
  }
  return boundary;
}

/**
 * Put the oldest complete records in an exact JSON user archive and retain a
 * native suffix within the supplied user/model item budgets.
 */
function expandKnownArchives(items, depth = 0) {
  if (depth > MAX_ARCHIVE_DEPTH) throw new Error("Nested history archives exceed their bound");
  const output = [];
  let expanded = false;
  for (const item of items) {
    const archive = unpackArchive(item);
    if (archive) {
      const restored = restoreArchiveValue(archive.archived, archive.attachments);
      if (!Array.isArray(restored)) throw new Error("History archive must contain records");
      output.push(...expandKnownArchives(restored, depth + 1));
      expanded = true;
    } else {
      output.push(item);
    }
  }
  return expanded ? output : items;
}

export function packResponsesHistory(items, maxTurns, maxModelTurns) {
  if (!Array.isArray(items) || items.length < 2) return items;
  const userBudget = Number.isSafeInteger(maxTurns) && maxTurns >= 0 ? maxTurns : undefined;
  const modelBudget = Number.isSafeInteger(maxModelTurns) && maxModelTurns >= 0 ? maxModelTurns : undefined;
  if (userBudget === undefined && modelBudget === undefined) return items;

  const directives = items.filter(isDirective);
  const visibleRecords = items.filter(item => !isDirective(item));
  const visibleUsers = visibleRecords.filter(item => item?.role === "user").length;
  const visibleModels = countResponsesModelTurns(visibleRecords);
  if ((userBudget === undefined || visibleUsers <= userBudget) &&
      (modelBudget === undefined || visibleModels <= modelBudget)) return items;
  const records = expandKnownArchives(visibleRecords);
  if (records.length < 2 || !hasCompleteDependencies(records)) return items;

  const recordUsers = records.reduce((sum, item) => sum + (item?.role === "user" ? 1 : 0), 0);
  if (userBudget !== undefined && recordUsers <= userBudget &&
      (modelBudget === undefined || countResponsesModelTurns(records) <= modelBudget)) return items;

  const lastUser = records.findLastIndex(item => item?.role === "user");
  if (lastUser < 0) return items;

  // Earliest safe split wins, preserving as much of the original suffix as
  // possible. The archive itself consumes one user slot.
  const visitedBoundaries = new Set();
  for (let proposed = 1; proposed < records.length; proposed += 1) {
    const boundary = safeResponsesHistoryCut(records, proposed, { preserveBundle: true });
    if (boundary <= 0 || visitedBoundaries.has(boundary)) continue;
    visitedBoundaries.add(boundary);
    const archived = records.slice(0, boundary);
    const retained = records.slice(boundary);
    const userCount = retained.reduce((sum, item) => sum + (item?.role === "user" ? 1 : 0), 0);
    const archiveConsumesUser = archived.length > 0 ? 1 : 0;
    if (userBudget !== undefined && userCount + archiveConsumesUser > userBudget) continue;
    if (modelBudget !== undefined && countResponsesModelTurns(retained) > modelBudget) continue;
    if (!nativeSuffixIsSafe(retained)) continue;

    const result = [...directives, exactArchive(archived), ...retained];
    return result;
  }
  return items;
}
