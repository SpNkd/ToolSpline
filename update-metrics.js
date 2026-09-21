#!/usr/bin/env node

/**
 * Обновляет публичные stars/forks для GitHub-репозиториев из tools.json.
 * Сетевой запрос выполняется только после явного запуска этого файла.
 * Внешние npm-зависимости не используются.
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

const DATA_FILE = path.join(__dirname, "tools.json");
const API_HOST = "api.github.com";
const API_PREFIX = "/repos/";
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

if (args.has("--help") || args.has("-h")) {
  console.log("Usage: node update-metrics.js [--dry-run]");
  console.log("  --dry-run  запросить метрики, но не записывать tools.json");
  process.exit(0);
}

main().catch((error) => {
  console.error(`Fatal: ${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const tools = readTools();
  const seenSlugs = new Set();
  let requestCount = 0;

  for (const tool of tools) {
    const slug = typeof tool.slug === "string" ? tool.slug : "(без slug)";
    if (seenSlugs.has(slug)) {
      console.warn(`[skip] ${slug}: duplicate slug, old record preserved`);
      continue;
    }
    seenSlugs.add(slug);

    const repo = parseGitHubRepo(tool.url);
    if (!repo) {
      tool.status = "invalid_url";
      console.warn(`[invalid_url] ${slug}: ${tool.url || "empty URL"}`);
      continue;
    }

    requestCount += 1;
    try {
      const result = await requestRepository(repo.owner, repo.name);
      if (result.kind === "ok") {
        tool.stars = result.data.stargazers_count;
        tool.forks = result.data.forks_count;
        tool.metricsUpdatedAt = new Date().toISOString();
        tool.status = "ok";
        console.log(`[ok] ${slug}: stars=${tool.stars}, forks=${tool.forks}`);
      } else if (result.kind === "rate_limit") {
        tool.status = "stale";
        console.warn(`[stale] ${slug}: GitHub API rate limit exceeded; old metrics preserved`);
      } else if (result.kind === "removed") {
        tool.status = "removed";
        console.warn(`[removed] ${slug}: repository not found; old metrics preserved`);
      } else {
        tool.status = "unknown";
        console.warn(`[unknown] ${slug}: ${result.message}; old metrics preserved`);
      }
    } catch (error) {
      tool.status = "unknown";
      console.warn(`[unknown] ${slug}: ${error.message}; old metrics preserved`);
    }
  }

  if (dryRun) {
    console.log(`Dry run complete: ${requestCount} request(s), tools.json was not changed.`);
    return;
  }

  fs.writeFileSync(DATA_FILE, `${JSON.stringify(tools, null, 2)}\n`, "utf8");
  console.log(`Saved ${tools.length} tool(s) to ${path.basename(DATA_FILE)} after ${requestCount} request(s).`);
}

function readTools() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${DATA_FILE}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON in ${DATA_FILE}: ${error.message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("tools.json must contain an array");
  }

  return parsed.filter((tool) => tool && typeof tool === "object" && !Array.isArray(tool));
}

function parseGitHubRepo(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || (hostname !== "github.com" && hostname !== "www.github.com")) {
      return null;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) {
      return null;
    }

    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, "");
    if (!owner || !name || !/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(name)) {
      return null;
    }
    return { owner, name };
  } catch {
    return null;
  }
}

function requestRepository(owner, name) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: API_HOST,
      path: `${API_PREFIX}${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "toolspline-metrics-updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      timeout: 15_000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        const statusCode = response.statusCode || 0;
        if (statusCode === 403) {
          resolve({ kind: "rate_limit" });
          return;
        }
        if (statusCode === 404) {
          resolve({ kind: "removed" });
          return;
        }
        if (statusCode < 200 || statusCode >= 300) {
          resolve({ kind: "unknown", message: `HTTP ${statusCode}` });
          return;
        }

        try {
          const data = JSON.parse(body);
          if (!Number.isSafeInteger(data.stargazers_count) || !Number.isSafeInteger(data.forks_count)) {
            resolve({ kind: "unknown", message: "API response has no valid metrics" });
            return;
          }
          resolve({ kind: "ok", data });
        } catch {
          resolve({ kind: "unknown", message: "invalid JSON from GitHub API" });
        }
      });
    });

    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
    request.end();
  });
}
