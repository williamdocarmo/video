#!/usr/bin/env node

import "dotenv/config";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {loadSecretsIntoEnv} from "./lib/secrets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const DEFAULT_AGENDADOR_SITE_URL = "https://agendador.online";

const normalizeAgendadorSiteUrl = (value) => {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) {
    return DEFAULT_AGENDADOR_SITE_URL;
  }

  return raw.endsWith("/api") ? raw.slice(0, -4) : raw;
};

const apiBase = `${normalizeAgendadorSiteUrl(
  process.env.AGENDADOR_ONLINE_URL || process.env.AGENDADOR_URL || DEFAULT_AGENDADOR_SITE_URL
)}/api`;

const resolveAgendadorIdentity = () =>
  String(
    process.env.AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL ||
      process.env.AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME ||
      process.env.AGENDADOR_EMAIL ||
      process.env.AGENDADOR_USERNAME ||
      ""
  ).trim();

const resolveAgendadorPassword = () =>
  String(process.env.AGENDADOR_ONLINE_PASSWORD || process.env.AGENDADOR_PASSWORD || "").trim();

const parseArgs = (argv) => {
  const parsed = {
    dryRun: false,
    publishNow: false,
    onlyIds: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }

    if (item === "--publish-now") {
      parsed.publishNow = true;
      continue;
    }

    if (item === "--only-id") {
      parsed.onlyIds.push(Number(argv[index + 1]));
      index += 1;
    }
  }

  return parsed;
};

const apiFetch = async (endpoint, {method = "GET", token, body} = {}) => {
  const response = await fetch(`${apiBase}${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? {Authorization: `Bearer ${token}`} : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(payload?.error || `${method} ${endpoint} falhou com ${response.status}.`);
  }

  return payload;
};

const normalizePosts = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload?.posts)) {
    return payload.posts;
  }

  return [];
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  loadSecretsIntoEnv([
    "AGENDADOR_ONLINE_URL",
    "AGENDADOR_ONLINE_PASSWORD",
    "AGENDADOR_PASSWORD",
    "AGENDADOR_EMAIL",
    "AGENDADOR_USERNAME",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL",
    "AGENDADOR_ONLINE_FOIUMAIDEIA_USERNAME"
  ]);

  const identity = resolveAgendadorIdentity();
  const password = resolveAgendadorPassword();

  if (!identity || !password) {
    throw new Error("Faltam AGENDADOR_ONLINE_FOIUMAIDEIA_EMAIL/USERNAME e AGENDADOR_ONLINE_PASSWORD no ambiente ou no Keychain.");
  }

  const auth = await apiFetch("/auth/login", {
    method: "POST",
    body: {
      identifier: identity,
      email: identity,
      password
    }
  });
  const token = auth?.token;

  if (!token) {
    throw new Error("A autenticacao do agendador nao devolveu token.");
  }

  const posts = normalizePosts(await apiFetch("/posts", {token}));
  const failedPosts = posts.filter((post) => post?.status === "FAILED");
  const filteredPosts =
    args.onlyIds.length > 0 ? failedPosts.filter((post) => args.onlyIds.includes(Number(post.id))) : failedPosts;

  const retries = filteredPosts
    .map((post) => {
      const failedTargets = (post.targets || []).filter((target) => target?.status === "FAILED" && target?.provider);
      const platforms = [...new Set(failedTargets.map((target) => target.provider))];

      if (!post.media_url || platforms.length === 0) {
        return null;
      }

      const scheduleDate = args.publishNow
        ? new Date().toISOString()
        : new Date(Math.max(Date.now(), new Date(post.scheduled_at || Date.now()).getTime() + 60_000)).toISOString();

      return {
        originalPostId: post.id,
        caption: post.caption,
        platforms,
        payload: {
          date: scheduleDate,
          mediaUrl: post.media_url,
          caption: post.caption,
          platforms,
          isDraft: false
        }
      };
    })
    .filter(Boolean);

  const results = [];

  for (const retry of retries) {
    if (args.dryRun) {
      results.push({
        ...retry,
        status: "dry-run"
      });
      continue;
    }

    const created = await apiFetch("/posts", {
      method: "POST",
      token,
      body: retry.payload
    });
    results.push({
      ...retry,
      status: "created",
      createdPost: created?.post ?? created ?? null
    });
  }

  const reportsDir = path.join(projectRoot, "reports");
  await mkdir(reportsDir, {recursive: true});
  const reportPath = path.join(
    reportsDir,
    `agendador-retry-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        attemptedAt: new Date().toISOString(),
        dryRun: args.dryRun,
        publishNow: args.publishNow,
        totalFailedPosts: failedPosts.length,
        retriedPosts: results
      },
      null,
      2
    )
  );

  process.stdout.write(`${reportPath}\n`);
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
