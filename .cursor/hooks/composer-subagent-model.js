#!/usr/bin/env node
// Denies a Task subagent model the agent picked on its own.
// Allows inherit, Composer, the chat's own model, and a model a user message asked for.

const fs = require("fs");

const COMPOSER_RETRY = "composer-2.5-fast";

const FAMILIES = [
  { prefixes: ["composer"], names: ["composer"] },
  { prefixes: ["claude-sonnet", "sonnet"], names: ["sonnet"] },
  { prefixes: ["claude-opus", "opus"], names: ["opus"] },
  { prefixes: ["claude-haiku", "haiku"], names: ["haiku"] },
  { prefixes: ["claude-fable", "fable"], names: ["fable"] },
  { prefixes: ["gemini"], names: ["gemini", "flash"] },
  { prefixes: ["gpt-", "gpt"], names: ["gpt", "codex"] },
  { prefixes: ["grok"], names: ["grok"] },
  { prefixes: ["kimi"], names: ["kimi"] },
  { prefixes: ["muse"], names: ["muse"] },
  { prefixes: ["deepseek"], names: ["deepseek"] },
];

function baseSlug(slug) {
  if (typeof slug !== "string") return "";
  return slug.trim().toLowerCase().replace(/\[.*$/, "");
}

function isComposer(slug) {
  return baseSlug(slug).startsWith("composer");
}

function sameFamily(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.startsWith(`${b}-`) || b.startsWith(`${a}-`)) return true;
  return false;
}

function familyNames(slug) {
  const base = baseSlug(slug);
  const names = [];
  for (const family of FAMILIES) {
    if (family.prefixes.some((prefix) => base === prefix || base.startsWith(prefix))) {
      names.push(...family.names);
    }
  }
  return names;
}

function requestsModel(text, requested) {
  const hay = text.toLowerCase();
  const req = baseSlug(requested);
  if (!req) return false;
  if (hay.includes(req)) return true;
  const names = familyNames(req);
  const request = /\b(use|using|switch to|run on|subagent|model)\b/;
  for (const name of names) {
    const re = new RegExp(`\\b${name}\\b`, "g");
    let match;
    while ((match = re.exec(hay))) {
      const start = Math.max(0, match.index - 80);
      const window = hay.slice(start, match.index + name.length + 80);
      if (request.test(window)) return true;
    }
  }
  return false;
}

function collectText(value, seen) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  if (seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => collectText(item, seen)).join("\n");
  const parts = [];
  if (typeof value.text === "string" && value.type !== "tool_use") parts.push(value.text);
  if (value.message) parts.push(collectText(value.message, seen));
  if (value.content) parts.push(collectText(value.content, seen));
  return parts.filter(Boolean).join("\n");
}

function extractUserTexts(raw) {
  const texts = [];
  let sawJson = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    sawJson = true;
    const role = obj.role || obj.type;
    if (role !== "user") continue;
    const text = collectText(obj, new Set());
    if (text) texts.push(text);
  }
  if (sawJson) return texts;
  try {
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const obj of items) {
      const role = obj && (obj.role || obj.type);
      if (role !== "user") continue;
      const text = collectText(obj, new Set());
      if (text) texts.push(text);
    }
  } catch {
    return [];
  }
  return texts;
}

function userRequested(transcriptPath, requested) {
  if (!transcriptPath || typeof transcriptPath !== "string") return false;
  let raw;
  try {
    const stat = fs.statSync(transcriptPath);
    const cap = 8 * 1024 * 1024;
    if (stat.size > cap) {
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const buffer = Buffer.alloc(cap);
        fs.readSync(fd, buffer, 0, cap, stat.size - cap);
        raw = buffer.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(transcriptPath, "utf8");
    }
  } catch {
    return false;
  }
  return extractUserTexts(raw).some((text) => requestsModel(text, requested));
}

function decision(input) {
  const event = input.hook_event_name;
  let requested = "";
  if (event === "preToolUse") {
    if (input.tool_name && input.tool_name !== "Task") return { permission: "allow" };
    requested = input.tool_input && input.tool_input.model;
  } else if (event === "subagentStart") {
    requested = input.subagent_model;
  } else {
    return { permission: "allow" };
  }

  const slug = baseSlug(requested);
  if (!slug || slug === "inherit" || isComposer(slug)) return { permission: "allow" };
  if (sameFamily(slug, baseSlug(input.model)) || sameFamily(slug, baseSlug(input.model_id))) {
    return { permission: "allow" };
  }
  if (userRequested(input.transcript_path, slug)) return { permission: "allow" };

  const message = `Blocked subagent model "${slug}". Retry this Task with model omitted or "inherit" to stay on the chat model, or with model "${COMPOSER_RETRY}". Pass another model only when a user message in this conversation asks for that model.`;
  if (event === "subagentStart") {
    return {
      permission: "deny",
      user_message: message,
    };
  }
  return {
    permission: "deny",
    user_message: `Subagent model ${slug} was blocked. Use inherit or ${COMPOSER_RETRY} unless you asked for ${slug}.`,
    agent_message: message,
  };
}

function emit(payload) {
  process.stdout.write(JSON.stringify(payload));
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    emit({ permission: "allow" });
    return;
  }
  try {
    emit(decision(input));
  } catch {
    emit({ permission: "allow" });
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { decision, requestsModel, extractUserTexts };
}
