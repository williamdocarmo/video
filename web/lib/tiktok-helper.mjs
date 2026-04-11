import path from "node:path";
import {slugify, readJsonFile, writeJsonFile, ensureManagedDir, escapeHtml} from "./utils.mjs";

/**
 * Resolve o caminho do arquivo JSON de um draft TikTok.
 * @param {string} tiktokDraftsDir - Diretório de drafts
 * @param {string} draftId - Identificador do draft
 * @returns {string}
 */
const getTikTokDraftPath = (tiktokDraftsDir, draftId) =>
  path.join(tiktokDraftsDir, `${slugify(draftId) || "draft"}.json`);

/**
 * Lê um draft TikTok do disco.
 * @param {string} tiktokDraftsDir - Diretório de drafts
 * @param {string} draftId - Identificador do draft
 * @returns {Promise<object|null>}
 */
export const readTikTokDraft = async (tiktokDraftsDir, draftId) =>
  readJsonFile(getTikTokDraftPath(tiktokDraftsDir, draftId));

/**
 * Persiste um draft TikTok em disco (cria o diretório se necessário).
 * @param {string} tiktokDraftsDir - Diretório de drafts
 * @param {string} draftId - Identificador do draft
 * @param {object} payload - Conteúdo do draft
 */
export const writeTikTokDraft = async (tiktokDraftsDir, draftId, payload) => {
  await ensureManagedDir(tiktokDraftsDir);
  await writeJsonFile(getTikTokDraftPath(tiktokDraftsDir, draftId), payload);
};

/**
 * Gera a página HTML do TikTok helper para um draft.
 * @param {object} draft - Objeto draft com título, caption, URLs, etc.
 * @returns {string} HTML completo
 */
export const buildTikTokHelperHtml = (draft) => {
  const helperTitle = draft.title || draft.slug || "TikTok helper";
  const captionJson = JSON.stringify(String(draft.caption || ""));
  const downloadName = escapeHtml(draft.downloadName || `${draft.slug || "video"}.mp4`);
  const thumbDownloadName = escapeHtml(draft.thumbnailDownloadName || `${draft.slug || "thumbnail"}.png`);
  const videoLink = escapeHtml(draft.videoUrl || "#");
  const thumbLink = escapeHtml(draft.thumbnailUrl || "");
  const uploadUrl = "https://www.tiktok.com/upload";

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(helperTitle)} • TikTok helper</title>
    <style>
      :root {
        --bg: #f4efe6;
        --ink: #14221e;
        --muted: #5e6d67;
        --card: rgba(255,252,246,.92);
        --line: rgba(20,34,30,.14);
        --primary: #0f7b6c;
        --shadow: 0 24px 60px rgba(20,34,30,.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        background:
          radial-gradient(circle at top left, rgba(215,239,233,.9), transparent 38%),
          radial-gradient(circle at bottom right, rgba(241,198,160,.34), transparent 24%),
          var(--bg);
        color: var(--ink);
        font-family: "Avenir Next", "Segoe UI Variable", sans-serif;
      }
      main { max-width: 1180px; margin: 0 auto; padding: 28px; display: grid; gap: 18px; }
      .hero, .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 24px;
        box-shadow: var(--shadow);
      }
      .hero { padding: 24px; display: grid; gap: 10px; }
      .eyebrow { margin: 0; color: var(--primary); font-size: .78rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(2rem, 4vw, 3.2rem); line-height: .95; }
      .lede { margin: 0; color: var(--muted); line-height: 1.6; max-width: 820px; }
      .layout { display: grid; grid-template-columns: minmax(0, 420px) minmax(0, 1fr); gap: 18px; }
      .card { padding: 18px; display: grid; gap: 14px; align-content: start; }
      .preview-video, .preview-thumb { width: 100%; border-radius: 18px; border: 1px solid var(--line); background: #0f1412; }
      .preview-video { aspect-ratio: 9/16; object-fit: contain; }
      .preview-thumb { aspect-ratio: 9/16; object-fit: cover; }
      .meta { color: var(--muted); line-height: 1.55; }
      .actions { display: flex; flex-wrap: wrap; gap: 12px; }
      .button {
        border: 0;
        border-radius: 999px;
        cursor: pointer;
        font: inherit;
        font-weight: 800;
        padding: 13px 18px;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .button.primary { background: var(--primary); color: white; }
      .button.secondary { background: transparent; border: 1px solid var(--line); color: var(--ink); }
      .caption-box {
        margin: 0;
        min-height: 280px;
        border-radius: 20px;
        background: #151a18;
        color: #f7f2e8;
        font: .92rem/1.6 ui-monospace, Menlo, monospace;
        padding: 18px;
        white-space: pre-wrap;
      }
      .hint { color: var(--muted); font-size: .92rem; line-height: 1.5; }
      @media (max-width: 980px) {
        .layout { grid-template-columns: 1fr; }
        main { padding: 18px; }
      }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <p class="eyebrow">TikTok Helper</p>
        <h1>${escapeHtml(helperTitle)}</h1>
        <p class="lede">No browser do usuário, não dá para pré-carregar automaticamente o MP4 dentro do TikTok por segurança do navegador. Este helper deixa tudo pronto: abrir o TikTok, copiar a legenda e baixar o vídeo e a thumbnail com um clique.</p>
      </section>

      <section class="layout">
        <article class="card">
          <video class="preview-video" controls playsinline preload="metadata" src="${videoLink}"></video>
          <p class="meta">${escapeHtml(draft.channelHandle || draft.channel || "")} • ${escapeHtml(downloadName)}</p>
          <div class="actions">
            <a class="button primary" href="${uploadUrl}" target="_blank" rel="noreferrer">Abrir upload do TikTok</a>
            <a class="button secondary" href="${videoLink}" download="${downloadName}">Baixar MP4</a>
            ${thumbLink ? `<a class="button secondary" href="${thumbLink}" download="${thumbDownloadName}">Baixar thumbnail</a>` : ""}
          </div>
          <p class="hint">Fluxo sugerido: 1. abrir upload do TikTok, 2. baixar/soltar o MP4, 3. copiar a legenda, 4. usar a thumbnail como referência visual da capa.</p>
        </article>

        <article class="card">
          ${thumbLink ? `<img class="preview-thumb" src="${thumbLink}" alt="Thumbnail do vídeo">` : ""}
          <div class="actions">
            <button class="button primary" id="copyCaptionButton" type="button">Copiar descrição</button>
            ${draft.storyboardUrl ? `<a class="button secondary" href="${escapeHtml(draft.storyboardUrl)}" target="_blank" rel="noreferrer">Abrir storyboard</a>` : ""}
          </div>
          <pre class="caption-box" id="captionBox">${escapeHtml(draft.caption || "")}</pre>
        </article>
      </section>
    </main>

    <script>
      const captionText = ${captionJson};
      const copyButton = document.getElementById("copyCaptionButton");
      copyButton?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(captionText);
          copyButton.textContent = "Descrição copiada";
          setTimeout(() => { copyButton.textContent = "Copiar descrição"; }, 1800);
        } catch (error) {
          window.alert("Falha ao copiar a descrição.");
        }
      });
    </script>
  </body>
</html>`;
};
