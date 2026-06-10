import {promises as fs} from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";

const DEFAULT_MUSIC_DIR = "/root/Documents/scripts/envato/music";
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"]);
const TRACK_PATTERN = /^track-\d+\.(mp3|wav|m4a|aac|ogg|flac)$/i;

const parseArgs = (argv) => {
  const parsed = {
    musicDir: DEFAULT_MUSIC_DIR
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];

    if (item === "--music-dir") {
      parsed.musicDir = String(argv[index + 1] || "").trim() || DEFAULT_MUSIC_DIR;
      index += 1;
    }
  }

  return parsed;
};

const runFfprobeJson = (targetPath) => {
  const result = spawnSync(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration,bit_rate:format_tags=title,artist,genre,comment",
      "-of", "json",
      targetPath
    ],
    {
      encoding: "utf8"
    }
  );

  if (result.status !== 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
};

const normalizeText = (value) =>
  String(value || "")
    .trim()
    .toLowerCase();

const hasAnyNeedle = (haystack, needles) => {
  const normalized = normalizeText(haystack);
  return needles.some((needle) => normalized.includes(needle));
};

const inferMood = ({title = "", artist = "", genre = "", comment = "", fileName = ""}) => {
  const haystack = [title, artist, genre, comment, fileName].filter(Boolean).join(" ");

  if (hasAnyNeedle(haystack, ["corporate", "upbeat", "energetic", "promo", "motivational"])) return "upbeat";
  if (hasAnyNeedle(haystack, ["ambient", "calm", "soft", "peaceful", "meditation", "piano", "relax"])) return "calm";
  if (hasAnyNeedle(haystack, ["dark", "dramatic", "cinematic", "trailer", "epic", "tension"])) return "dramatic";
  return "unknown";
};

const inferBestUse = ({durationSeconds, mood}) => {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return "review";
  }

  if (mood === "upbeat") return "foiumaideia";
  if (mood === "calm") return durationSeconds >= 80 ? "ate2min|quiet2min" : "quiet2min";
  if (mood === "dramatic") return "foiumaideia";

  if (durationSeconds <= 20) return "stinger-only";
  if (durationSeconds <= 70) return "foiumaideia|shorts";
  if (durationSeconds <= 125) return "ate2min|quiet2min";
  return "any";
};

const round = (value, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
};

const escapeCsv = (value) => {
  const raw = String(value ?? "");
  if (!/[",\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, "\"\"")}"`;
};

const toMarkdownTable = (rows) => {
  const lines = [
    "| File | Duration | Format | Mood | Best Use | Title | Artist |",
    "| --- | ---: | --- | --- | --- | --- | --- |"
  ];

  for (const row of rows) {
    lines.push(
      `| ${row.fileName} | ${row.durationSeconds}s | ${row.extension.replace(/^\./, "")} | ${row.mood} | ${row.bestUse} | ${row.title || ""} | ${row.artist || ""} |`
    );
  }

  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const {musicDir} = parseArgs(process.argv.slice(2));
  const resolvedMusicDir = path.resolve(musicDir);
  const entries = await fs.readdir(resolvedMusicDir, {withFileTypes: true});

  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => TRACK_PATTERN.test(name) && AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  const catalog = [];

  for (const fileName of files) {
    const absolutePath = path.join(resolvedMusicDir, fileName);
    const fileStat = await fs.stat(absolutePath);
    const probe = runFfprobeJson(absolutePath);

    if (!probe?.format) {
      continue;
    }

    const format = probe.format || {};
    const tags = format.tags || {};
    const durationSeconds = round(Number.parseFloat(format.duration || "0"), 3);
    const bitRate = Number.parseInt(format.bit_rate || "0", 10) || 0;
    const extension = path.extname(fileName).toLowerCase();
    const mood = inferMood({
      title: tags.title,
      artist: tags.artist,
      genre: tags.genre,
      comment: tags.comment,
      fileName
    });
    const bestUse = inferBestUse({durationSeconds, mood});

    catalog.push({
      fileName,
      extension,
      absolutePath,
      durationSeconds,
      bitRate,
      sizeBytes: fileStat.size,
      title: String(tags.title || "").trim(),
      artist: String(tags.artist || "").trim(),
      genre: String(tags.genre || "").trim(),
      comment: String(tags.comment || "").trim(),
      mood,
      bestUse
    });
  }

  const byDuration = [...catalog].sort((left, right) => left.durationSeconds - right.durationSeconds);
  const csvLines = [
    ["fileName", "durationSeconds", "extension", "bitRate", "sizeBytes", "mood", "bestUse", "title", "artist", "genre", "comment"].join(","),
    ...byDuration.map((row) => [
      row.fileName,
      row.durationSeconds,
      row.extension,
      row.bitRate,
      row.sizeBytes,
      row.mood,
      row.bestUse,
      escapeCsv(row.title),
      escapeCsv(row.artist),
      escapeCsv(row.genre),
      escapeCsv(row.comment)
    ].join(","))
  ];

  const summary = {
    generatedAt: new Date().toISOString(),
    musicDir: resolvedMusicDir,
    totalTracks: catalog.length,
    countsByMood: catalog.reduce((acc, item) => {
      acc[item.mood] = (acc[item.mood] || 0) + 1;
      return acc;
    }, {}),
    countsByBestUse: catalog.reduce((acc, item) => {
      acc[item.bestUse] = (acc[item.bestUse] || 0) + 1;
      return acc;
    }, {}),
    shortest: byDuration.slice(0, 10),
    longest: [...byDuration].reverse().slice(0, 10)
  };

  const markdown = [
    `# Background Music Catalog`,
    ``,
    `Generated: ${summary.generatedAt}`,
    `Music dir: ${summary.musicDir}`,
    `Total tracks: ${summary.totalTracks}`,
    ``,
    `## By Duration`,
    ``,
    toMarkdownTable(byDuration),
    `## Longest 10`,
    ``,
    toMarkdownTable(summary.longest)
  ].join("\n");

  await fs.writeFile(path.join(resolvedMusicDir, "catalog.json"), `${JSON.stringify({summary, tracks: byDuration}, null, 2)}\n`);
  await fs.writeFile(path.join(resolvedMusicDir, "catalog.csv"), `${csvLines.join("\n")}\n`);
  await fs.writeFile(path.join(resolvedMusicDir, "catalog.md"), markdown);

  process.stdout.write(
    JSON.stringify(
      {
        generatedAt: summary.generatedAt,
        musicDir: summary.musicDir,
        totalTracks: summary.totalTracks,
        shortest: summary.shortest.slice(0, 5).map((item) => ({fileName: item.fileName, durationSeconds: item.durationSeconds})),
        longest: summary.longest.slice(0, 5).map((item) => ({fileName: item.fileName, durationSeconds: item.durationSeconds}))
      },
      null,
      2
    ) + "\n"
  );
};

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
