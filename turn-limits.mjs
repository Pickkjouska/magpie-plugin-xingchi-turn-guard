import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const STORE_NAME = "xingchi-turn-limits.json";
const VALID_FOR_MS = 60 * 60 * 1000;
// This serializes callers sharing one Node process. Separate processes can still
// race while reading and replacing the same JSON document; the backup rename in
// replaceDocument prevents an unrecoverable unlink gap but is not a file lock.
const writeLanes = new Map();

export function isTurnLimit(value) {
  return Number.isSafeInteger(value) && value >= 1;
}

function numericField(error, keys) {
  for (const key of keys) {
    const value = error?.[key];
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function numericMentions(text, expressions) {
  for (const expression of expressions) {
    const match = expression.exec(text);
    if (match) {
      const value = Number(match[1]);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
  }
  return undefined;
}

/** Extract a confirmed user-message limit from a structured error or its text. */
export function parseTurnLimit(value) {
  const error = value?.error && typeof value.error === "object" ? value.error : value;
  const structured = numericField(error, ["max_turns", "maxTurns", "user_turn_limit", "max_user_turns"]);
  if (structured !== undefined) return structured;
  const text = typeof value === "string" ? value : [error?.message, error?.detail, error?.description]
    .filter(part => typeof part === "string").join(" ");
  if (!text) return undefined;
  return numericMentions(text, [
    /(?:当前会话|本会话).{0,24}?(?:已满|上限|限制).{0,16}?(\d+)\s*轮/u,
    /(?:最多|至多)\s*(\d+)\s*(?:轮|turns?)/iu,
    /(?:session|conversation).{0,32}?(?:limit|max(?:imum)?).{0,16}?(\d+)\s*(?:turns?|rounds?)/iu,
    /(\d+)\s*(?:turn|round)\s*(?:limit|maximum)/iu,
  ]);
}

/** Parse only explicit session-turn-limit failures; never guess from other errors. */
export function parseTurnFeedback(reply) {
  const error = reply?.error;
  if (!error || typeof error !== "object" || error.code !== "session_turn_limit_exceeded") return null;
  const modelLimit = numericField(error, ["max_model_turns", "maxModelTurns", "model_turn_limit"]);
  if (modelLimit !== undefined) return { metric: "model", limit: modelLimit };
  const userLimit = numericField(error, ["max_turns", "maxTurns", "user_turn_limit", "max_user_turns"]);
  if (userLimit !== undefined) return { metric: "user", limit: userLimit };

  const text = [error.message, error.detail, error.description]
    .filter(part => typeof part === "string").join(" ");
  if (!text) return null;
  const modelCount = numericMentions(text, [
    /(?:模型|model).{0,24}?(?:已回复|回复|replied|has replied|responded).{0,12}?(\d+)\s*(?:轮|model\s+turns?|turns?)/iu,
    /(?:已回复|replied|has replied)\s*(\d+)\s*(?:轮|model\s+turns?|turns?)/iu,
  ]);
  // A zero count is not credible evidence of a rejected model-output budget.
  if (modelCount !== undefined && modelCount > 0) return { metric: "model", rejectedAt: modelCount };

  const limit = parseTurnLimit(text);
  if (limit !== undefined) return { metric: "user", limit };
  return null;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function endpointIdentity(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  try {
    const parsed = new URL(source);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return source.replace(/\/+$/, "");
  }
}

/** Opaque cache identity for endpoint, credential, model, and metric. */
export function turnLimitScope(endpoint, apiKey, model, metric = "user") {
  const material = JSON.stringify([
    endpointIdentity(endpoint),
    String(apiKey ?? ""),
    String(model ?? ""),
    metric === "model" ? "model" : "user",
  ]);
  return `sha256:${digest(material)}`;
}

function storePath(directory) {
  return resolve(directory, STORE_NAME);
}

function validEntry(entry, now) {
  return entry && typeof entry.scope === "string" &&
    Number.isInteger(entry.limit) && entry.limit >= 0 &&
    Number.isFinite(entry.observedAt) && now - entry.observedAt < VALID_FOR_MS &&
    entry.observedAt <= now + 60_000;
}

async function load(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(parsed?.entries)) return [];
    const now = Date.now();
    return parsed.entries.filter(entry => validEntry(entry, now));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

function inFileLane(file, operation) {
  const previous = writeLanes.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  writeLanes.set(file, next);
  return next.finally(() => {
    if (writeLanes.get(file) === next) writeLanes.delete(file);
  });
}

async function replaceDocument(file, entries) {
  const contents = JSON.stringify({ version: 1, entries });
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${digest(String(Math.random())).slice(0, 10)}.tmp`);
  try {
    await writeFile(temp, contents, { encoding: "utf8", flag: "wx" });
    await rename(temp, file);
  } catch (error) {
    // Windows rename may reject replacing an existing destination.
    if (error?.code === "EEXIST" || error?.code === "EPERM" || error?.code === "ENOTEMPTY") {
      const backup = `${temp}.previous`;
      let movedOld = false;
      try {
        try {
          await rename(file, backup);
          movedOld = true;
        } catch (moveError) {
          if (moveError?.code !== "ENOENT") throw moveError;
        }
        await rename(temp, file);
        if (movedOld) await unlink(backup).catch(() => {});
      } catch (replaceError) {
        if (movedOld) await rename(backup, file).catch(() => {});
        throw replaceError;
      }
    } else {
      throw error;
    }
  }
}

/* The lane covers read-modify-write, including callers with separate instances. */
function writeEntry(file, scope, limit) {
  return inFileLane(file, async () => {
    const entries = await load(file);
    const now = Date.now();
    const existing = entries.find(entry => entry.scope === scope);
    // Feedback can arrive out of order. While the observation is live, a later
    // larger report must not raise the protective budget.
    const safeLimit = existing ? Math.min(existing.limit, limit) : limit;
    const observedAt = existing && limit >= existing.limit ? existing.observedAt : now;
    const next = entries.filter(entry => entry.scope !== scope);
    next.push({ scope, limit: safeLimit, observedAt });
    await replaceDocument(file, next);
  });
}

/** Persistent, one-hour cache. The on-disk key is an opaque digest only. */
export function createTurnLimitCache(directory) {
  const file = storePath(directory);

  return {
    async get(scope) {
      if (typeof scope !== "string" || !scope) return undefined;
      try {
        return await inFileLane(file, async () => {
          const match = (await load(file)).find(entry => entry.scope === scope);
          return match?.limit;
        });
      } catch {
        return undefined;
      }
    },

    async remember(scope, limit) {
      if (typeof scope !== "string" || !scope || !Number.isInteger(limit) || limit < 0) return;
      try { await writeEntry(file, scope, limit); } catch { /* Cache persistence is best effort. */ }
    },
  };
}
