const state = {
  config: null,
  jobs: [],
  runs: [],
  videos: [],
  failedJobs: [],
  agendador: null,
  selectedJobId: null,
  selectedVideoId: null,
  selectedFailedJobId: null,
  selectedLibraryKind: null,
  activeTab: "workspace",
  activeJobId: null,
  activePreviewJobId: null,
  activeHeavyJobId: null,
  queueLength: 0,
  previewQueueLength: 0,
  heavyQueueLength: 0,
  logAutoFollow: true,
  stream: null,
  streamJobId: null,
  streamReconnectTimer: null,
  previewCache: new Map(),
  loadingPreviewIds: new Set()
};

const DEFAULT_REFRESH_INTERVAL_MS = 20000;
const ACTIVE_JOB_REFRESH_INTERVAL_MS = 5000;

const languageOptions = [
  {label: "Português (Brasil)", value: "pt-BR"},
  {label: "English", value: "en-US"}
];

const MIN_TITLE_WORDS_WITHOUT_SOURCE = 6;
const MIN_TITLE_CHARS_WITHOUT_SOURCE = 32;
const MIN_SOURCE_TEXT_CHARS = 140;

const elements = {
  tabButtons: Array.from(document.querySelectorAll("[data-tab-target]")),
  tabPanels: Array.from(document.querySelectorAll("[data-tab-panel]")),
  generateForm: document.querySelector("#generateForm"),
  generateSubmitButton: document.querySelector("#generateSubmitButton"),
  autoApproveToggle: document.querySelector("#generateAutoApprove"),
  generateValidationHint: document.querySelector("#generateValidationHint"),
  outputProfileHint: document.querySelector("#outputProfileHint"),
  durationHint: document.querySelector("#durationHint"),
  imageModelHint: document.querySelector("#imageModelHint"),
  imageModelCost: document.querySelector("#imageModelCost"),
  imageStyleHint: document.querySelector("#imageStyleHint"),
  imageStylePreview: document.querySelector("#imageStylePreview"),
  imageStylePreviewLabel: document.querySelector("#imageStylePreviewLabel"),
  imageStylePreviewDescription: document.querySelector("#imageStylePreviewDescription"),
  imageStylePreviewLink: document.querySelector("#imageStylePreviewLink"),
  imageStylePreviewImageLink: document.querySelector("#imageStylePreviewImageLink"),
  imageStylePreviewImage: document.querySelector("#imageStylePreviewImage"),
  toneHint: document.querySelector("#toneHint"),
  voiceHint: document.querySelector("#voiceHint"),
  channelHint: document.querySelector("#channelHint"),
  queueCount: document.querySelector("#queueCount"),
  previewQueueCount: document.querySelector("#previewQueueCount"),
  heavyQueueCount: document.querySelector("#heavyQueueCount"),
  jobEmpty: document.querySelector("#jobEmpty"),
  jobDetails: document.querySelector("#jobDetails"),
  jobType: document.querySelector("#jobType"),
  jobTitle: document.querySelector("#jobTitle"),
  jobMeta: document.querySelector("#jobMeta"),
  jobProgressMeta: document.querySelector("#jobProgressMeta"),
  jobStatus: document.querySelector("#jobStatus"),
  jobLog: document.querySelector("#jobLog"),
  jobOutputLink: document.querySelector("#jobOutputLink"),
  jobStoryboardLink: document.querySelector("#jobStoryboardLink"),
  jobFailureSummary: document.querySelector("#jobFailureSummary"),
  jobRecommendedLabel: document.querySelector("#jobRecommendedLabel"),
  jobRecommendedDetails: document.querySelector("#jobRecommendedDetails"),
  jobStepChecklist: document.querySelector("#jobStepChecklist"),
  jobActions: document.querySelector("#jobActions"),
  resumeJobButton: document.querySelector("#resumeJobButton"),
  regenerateSceneButton: document.querySelector("#regenerateSceneButton"),
  generateAudioButton: document.querySelector("#generateAudioButton"),
  renderOnlyButton: document.querySelector("#renderOnlyButton"),
  validateJobButton: document.querySelector("#validateJobButton"),
  forceFailJobButton: document.querySelector("#forceFailJobButton"),
  previewPanel: document.querySelector("#previewPanel"),
  previewSummary: document.querySelector("#previewSummary"),
  previewScenes: document.querySelector("#previewScenes"),
  approvePreviewButton: document.querySelector("#approvePreviewButton"),
  jobsList: document.querySelector("#jobsList"),
  logsJobsList: document.querySelector("#logsJobsList"),
  logsEmpty: document.querySelector("#logsEmpty"),
  logsDetails: document.querySelector("#logsDetails"),
  logsTitle: document.querySelector("#logsTitle"),
  logsMeta: document.querySelector("#logsMeta"),
  logsProgressMeta: document.querySelector("#logsProgressMeta"),
  logsStatus: document.querySelector("#logsStatus"),
  logsOutputLink: document.querySelector("#logsOutputLink"),
  logsStoryboardLink: document.querySelector("#logsStoryboardLink"),
  logsFailureSummary: document.querySelector("#logsFailureSummary"),
  logsJobLog: document.querySelector("#logsJobLog"),
  runsList: document.querySelector("#runsList"),
  videosList: document.querySelector("#videosList"),
  failedJobsList: document.querySelector("#failedJobsList"),
  videoEmpty: document.querySelector("#videoEmpty"),
  videoDetails: document.querySelector("#videoDetails"),
  failedJobDetails: document.querySelector("#failedJobDetails"),
  videoChannel: document.querySelector("#videoChannel"),
  videoTitleHeading: document.querySelector("#videoTitleHeading"),
  videoMeta: document.querySelector("#videoMeta"),
  videoPublishStatus: document.querySelector("#videoPublishStatus"),
  videoArtwork: document.querySelector("#videoArtwork"),
  videoArtworkImage: document.querySelector("#videoArtworkImage"),
  videoArtworkTitle: document.querySelector("#videoArtworkTitle"),
  videoArtworkMeta: document.querySelector("#videoArtworkMeta"),
  videoPlayer: document.querySelector("#videoPlayer"),
  videoOpenLink: document.querySelector("#videoOpenLink"),
  videoStoryboardLink: document.querySelector("#videoStoryboardLink"),
  videoParamsCard: document.querySelector("#videoParamsCard"),
  videoParamsGrid: document.querySelector("#videoParamsGrid"),
  videoMetaForm: document.querySelector("#videoMetaForm"),
  videoTargetChannel: document.querySelector("#videoTargetChannel"),
  videoTargetHint: document.querySelector("#videoTargetHint"),
  videoScheduleField: document.querySelector("#videoScheduleField"),
  saveVideoMetaButton: document.querySelector("#saveVideoMetaButton"),
  redoVideoButton: document.querySelector("#redoVideoButton"),
  publishVideoButton: document.querySelector("#publishVideoButton"),
  openTikTokHelperButton: document.querySelector("#openTikTokHelperButton"),
  deleteVideoButton: document.querySelector("#deleteVideoButton"),
  videoLibraryHint: document.querySelector("#videoLibraryHint"),
  videoActionHint: document.querySelector("#videoActionHint"),
  failedJobChannel: document.querySelector("#failedJobChannel"),
  failedJobTitle: document.querySelector("#failedJobTitle"),
  failedJobMeta: document.querySelector("#failedJobMeta"),
  failedJobStatus: document.querySelector("#failedJobStatus"),
  failedJobError: document.querySelector("#failedJobError"),
  failedJobRecommendedLabel: document.querySelector("#failedJobRecommendedLabel"),
  failedJobRecommendedDetails: document.querySelector("#failedJobRecommendedDetails"),
  failedJobStoryboardLink: document.querySelector("#failedJobStoryboardLink"),
  failedJobActions: document.querySelector("#failedJobActions"),
  retryFailedJobButton: document.querySelector("#retryFailedJobButton")
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const fetchJson = async (url, options) => {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Falha na requisicao.");
  }

  return payload;
};

const getJobTypeLabel = (job) => {
  if (!job) {
    return "generate";
  }

  if (job.type === "generate") {
    return job.input?.previewOnly ? "preview" : "generate";
  }

  if (job.type === "rerender") {
    return "rerender-voice";
  }

  return job.type;
};

const findOptionLabel = (options, value, fallback = "") => {
  const match = Array.isArray(options) ? options.find((option) => String(option.value) === String(value)) : null;
  return match?.label || fallback || String(value || "");
};

const fillSelect = (select, options, selectedValue) => {
  if (!select) {
    return;
  }

  select.innerHTML = options
    .map((option) => {
      const isSelected = String(option.value) === String(selectedValue) ? " selected" : "";
      return `<option value="${escapeHtml(option.value)}"${isSelected}>${escapeHtml(option.label)}</option>`;
    })
    .join("");
};

const renderVideoCreationParams = (video) => {
  if (!elements.videoParamsCard || !elements.videoParamsGrid) {
    return;
  }

  const params = video?.creationParams || null;
  if (!params) {
    elements.videoParamsCard.classList.add("hidden");
    elements.videoParamsGrid.innerHTML = "";
    return;
  }

  const items = [
    {label: "Idioma", value: findOptionLabel(languageOptions, params.language, params.language)},
    {label: "Formato", value: findOptionLabel(state.config?.outputProfiles, params.outputProfile, params.outputProfile)},
    {label: "Duração", value: params.targetSeconds ? `${params.targetSeconds}s` : ""},
    {label: "Modelo de imagem", value: findOptionLabel(state.config?.imageModels, params.imageModel, params.imageModel)},
    {label: "Estilo de imagem", value: findOptionLabel(state.config?.imageStyles, params.imageStyle, params.imageStyle)},
    {label: "Estilo de roteiro", value: findOptionLabel(state.config?.tones, params.tone, params.tone)},
    {label: "Voz", value: findOptionLabel(state.config?.voices, params.voice, params.voice)},
    {label: "Canal", value: params.channelHandle || findOptionLabel(state.config?.channels, params.channel, params.channel)},
    {label: "Forçar regeneração", value: params.force ? "Sim" : "Não"},
    {label: "Música de fundo", value: params.noMusic ? "Sem música" : "Com música"},
    {label: "Fluxo", value: params.previewOnly ? "Preview" : "Direto / final"}
  ].filter((item) => item.value);

  elements.videoParamsGrid.innerHTML = items
    .map(
      (item) => `
        <div class="meta-item">
          <span class="meta-item-label">${escapeHtml(item.label)}</span>
          <span class="meta-item-value">${escapeHtml(item.value)}</span>
        </div>
      `
    )
    .join("");

  elements.videoParamsCard.classList.toggle("hidden", items.length === 0);
};

const formatDateTime = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("pt-BR");
};

const formatBytes = (value) => {
  const size = Number(value || 0);

  if (!Number.isFinite(size) || size <= 0) {
    return "";
  }

  const units = ["B", "KB", "MB", "GB"];
  let current = size;
  let index = 0;

  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }

  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
};

const formatElapsed = (value) => {
  const milliseconds = Number(value || 0);

  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return "";
  }

  const totalSeconds = Math.max(1, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${seconds}s`;
};

const toDateTimeLocalValue = (value) => {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const parts = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .formatToParts(date)
    .reduce((accumulator, item) => ({...accumulator, [item.type]: item.value}), {});

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const getImageStyleMeta = (styleId) =>
  state.config?.imageStyles?.find((item) => item.value === styleId) || null;

const getImageModelMeta = (modelId) =>
  state.config?.imageModels?.find((item) => item.value === modelId) || null;

const getChannelMeta = (channelId) =>
  state.config?.channels?.find((item) => item.value === channelId) || null;

const getToneMeta = (toneId) =>
  state.config?.tones?.find((item) => item.value === toneId) || null;

const getVoiceMeta = (voiceId) =>
  state.config?.voices?.find((item) => item.value === voiceId) || null;

const getChannelPreset = (channelId) => state.config?.channelPresets?.[channelId] || null;

const getOutputProfileMeta = (profileId) =>
  state.config?.outputProfiles?.find((item) => item.value === profileId) || null;

const getJobById = (jobId) => state.jobs.find((job) => job.id === jobId) || null;
const getVideoById = (videoId) => state.videos.find((video) => video.id === videoId) || null;
const getFailedJobById = (jobId) => state.failedJobs.find((job) => job.id === jobId) || null;

const JOB_FAILURE_STAGE_LABELS = {
  "timestamp-extraction": "Extração de timestamps",
  render: "Renderização",
  qa: "Validação QA",
  audio: "Áudio",
  pipeline: "Pipeline"
};

const normalizeText = (value) => String(value ?? "").trim();

const getJobFailureStage = (job) => normalizeText(job?.failureStage || job?.stage || job?.currentStage || "");

const getJobFailureStageLabel = (job) => {
  const explicitLabel = normalizeText(
    job?.failureStageLabel ||
    job?.stageLabel ||
    job?.currentStageLabel ||
    job?.failureStageName ||
    job?.stageName
  );

  if (explicitLabel) {
    return explicitLabel;
  }

  const stage = getJobFailureStage(job);

  if (!stage) {
    return "";
  }

  return JOB_FAILURE_STAGE_LABELS[stage] || stage.replace(/-/g, " ");
};

const getJobFailureRca = (job) =>
  normalizeText(
    job?.failureRca ||
    job?.rca ||
    job?.rootCause ||
    job?.rootCauseAnalysis ||
    job?.rootCauseSummary ||
    job?.analysis?.rootCause ||
    job?.failureDiagnosis
  );

const getJobNextRecommendedAction = (job) =>
  normalizeText(
    job?.recommendedAction?.label ||
    job?.recommendedAction?.details ||
    job?.nextRecommendedAction ||
    job?.recommendedAction ||
    job?.nextAction ||
    job?.failureAction ||
    job?.recommendedNextStep ||
    job?.actionRecommendation ||
    job?.repairAction ||
    job?.nextStep
  );

const getJobFailureDetailsHtml = (job) => {
  const pieces = [];
  const stageLabel = getJobFailureStageLabel(job);
  const rca = getJobFailureRca(job);
  const nextAction = getJobNextRecommendedAction(job);
  const fallbackSummary = normalizeText(job?.failureSummary || job?.error || "");

  if (stageLabel) {
    pieces.push(`<strong>Etapa</strong>: ${escapeHtml(stageLabel)}`);
  }

  if (rca) {
    pieces.push(`<strong>RCA</strong>: ${escapeHtml(rca)}`);
  } else if (fallbackSummary) {
    pieces.push(`<strong>Falha</strong>: ${escapeHtml(fallbackSummary)}`);
  }

  if (rca && fallbackSummary && fallbackSummary !== rca) {
    pieces.push(`<strong>Detalhe</strong>: ${escapeHtml(fallbackSummary)}`);
  }

  if (nextAction) {
    pieces.push(`<strong>Ação sugerida</strong>: ${escapeHtml(nextAction)}`);
  }

  return pieces.join("<br>");
};

const getSelectedPublishMode = () => {
  const selected = elements.videoMetaForm?.querySelector('input[name="publishMode"]:checked');
  return selected?.value === "scheduled" ? "scheduled" : "now";
};

const getVoicesForLanguage = (languageCode) =>
  (state.config?.voices || []).filter((voice) => {
    const languages = Array.isArray(voice.languages) ? voice.languages : [];
    return languages.length === 0 || languages.includes(languageCode);
  });

const getPreferredVoiceForLanguage = (languageCode, fallbackVoice = "") =>
  state.config?.defaultVoicesByLanguage?.[languageCode] || fallbackVoice || state.config?.defaults?.voice || "Iapetus";

const syncVoiceHint = (voiceId) => {
  if (!elements.voiceHint) {
    return;
  }

  const meta = getVoiceMeta(voiceId);
  if (!meta) {
    elements.voiceHint.textContent = "";
    return;
  }

  const pieces = [meta.badge, meta.description].filter(Boolean);
  elements.voiceHint.textContent = pieces.join(" • ");
};

const syncVoiceOptionsForLanguage = (languageCode, preferredVoice = "") => {
  const voiceSelect = document.querySelector("#generateVoice");
  if (!voiceSelect || !state.config) {
    return;
  }

  const filteredVoices = getVoicesForLanguage(languageCode);
  const fallbackVoice = getPreferredVoiceForLanguage(languageCode);
  const currentValue = preferredVoice || voiceSelect.value;
  const selectedVoice = filteredVoices.some((voice) => String(voice.value) === String(currentValue))
    ? currentValue
    : fallbackVoice;

  fillSelect(voiceSelect, filteredVoices, selectedVoice);
  syncVoiceHint(selectedVoice);
};

const getVideoArtworkUrl = (video) =>
  String(
    video?.thumbnailUrl ||
    video?.coverUrl ||
    video?.posterUrl ||
    video?.artworkUrl ||
    video?.previewImageUrl ||
    video?.thumbUrl ||
    ""
  ).trim();

const parseDateTimeLocalToIso = (value) => {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

const syncVideoTargetHint = (channelId) => {
  if (!elements.videoTargetHint) {
    return;
  }

  const selectedChannelMeta = getChannelMeta(channelId);
  elements.videoTargetHint.textContent = selectedChannelMeta
    ? `${selectedChannelMeta.description || ""} Vai salvar em Documents/postar/${selectedChannelMeta.folder}`.trim()
    : "Escolha o perfil que será usado na edição e na publicação.";
};

const syncImageStylePreview = (styleId) => {
  const selected = getImageStyleMeta(styleId);

  if (!elements.imageStylePreview || !elements.imageStylePreviewLabel || !elements.imageStylePreviewDescription || !elements.imageStylePreviewLink) {
    return;
  }

  if (!selected) {
    elements.imageStylePreview.classList.add("hidden");
    elements.imageStylePreviewLabel.textContent = "";
    elements.imageStylePreviewDescription.textContent = "";
    elements.imageStylePreviewLink.setAttribute("href", "#generateImageStyle");
    if (elements.imageStylePreviewImageLink) {
      elements.imageStylePreviewImageLink.classList.add("hidden");
      elements.imageStylePreviewImageLink.setAttribute("href", "#generateImageStyle");
    }
    if (elements.imageStylePreviewImage) {
      elements.imageStylePreviewImage.setAttribute("src", "");
    }
    return;
  }

  elements.imageStylePreview.classList.remove("hidden");
  elements.imageStylePreviewLabel.textContent = selected.label || "Estilo selecionado";
  elements.imageStylePreviewDescription.textContent = selected.description || "Sem descrição adicional.";
  elements.imageStylePreviewLink.textContent = `Abrir referência de ${selected.label || "estilo"}`;
  elements.imageStylePreviewLink.setAttribute("href", selected.previewLinkUrl || selected.previewUrl || selected.previewPath || "#generateImageStyle");

  const previewHref = selected.previewImageUrl || selected.previewLinkUrl || selected.previewUrl || selected.previewPath || "";
  if (elements.imageStylePreviewImageLink && elements.imageStylePreviewImage) {
    if (previewHref) {
      elements.imageStylePreviewImageLink.classList.remove("hidden");
      elements.imageStylePreviewImageLink.setAttribute("href", previewHref);
      elements.imageStylePreviewImage.setAttribute("src", previewHref);
      elements.imageStylePreviewImage.setAttribute("alt", `Preview do estilo ${selected.label || styleId}`);
    } else {
      elements.imageStylePreviewImageLink.classList.add("hidden");
      elements.imageStylePreviewImageLink.setAttribute("href", "#generateImageStyle");
      elements.imageStylePreviewImage.setAttribute("src", "");
    }
  }
};

const syncImageModelHint = (modelId) => {
  const selected = getImageModelMeta(modelId);

  if (elements.imageModelHint) {
    const parts = [selected?.badge, selected?.description].filter(Boolean);
    elements.imageModelHint.textContent = parts.join(" • ");
  }

  if (elements.imageModelCost) {
    const costText = [selected?.costLabel, selected?.costDetail].filter(Boolean).join(" • ");
    elements.imageModelCost.textContent = costText;
    elements.imageModelCost.classList.toggle("hidden", !costText);
  }
};

const getJobQueueLane = (job) => {
  if (!job) {
    return "heavy";
  }

  if (job.queueLane) {
    return job.queueLane;
  }

  return job.type === "generate" && job.input?.previewOnly ? "preview" : "heavy";
};

const getQueueLaneLabel = (lane) => (lane === "preview" ? "roteiro" : "render");

const getJobStageLabel = (job) => {
  if (!job) {
    return "";
  }

  if (job.status === "failed") {
    return getJobFailureStageLabel(job) || job.failureStage || "falha";
  }

  return job.stage?.label || getQueueLaneLabel(getJobQueueLane(job));
};

const getJobFailureLabel = (job) => {
  if (!job || job.status !== "failed") {
    return "";
  }

  const stage = getJobFailureStageLabel(job) || getJobFailureStage(job) || "falha";
  const summary = getJobFailureRca(job) || job.failureSummary || job.error || "sem detalhe";
  return `${stage}: ${summary}`;
};

const getJobMetaLine = (job) => {
  if (!job) {
    return "";
  }

  const outputProfile = getOutputProfileMeta(job.input?.outputProfile);
  return [
    job.slug,
    getJobStageLabel(job),
    job.input?.channelHandle || null,
    job.input?.language || null,
    outputProfile ? outputProfile.label : null,
    job.input?.targetSeconds ? `${job.input.targetSeconds}s` : null,
    job.queuePosition ? `${getQueueLaneLabel(getJobQueueLane(job))} ${job.queuePosition}` : null,
    job.heartbeatAt ? `atividade ${formatDateTime(job.heartbeatAt)}` : null,
    job.status === "failed" ? `falha: ${getJobFailureStageLabel(job) || getJobFailureStage(job) || "falha"}` : null
  ]
    .filter(Boolean)
    .join(" • ");
};

const getChecklistStep = (job, key) =>
  (Array.isArray(job?.stepChecklist) ? job.stepChecklist : []).find((step) => step.key === key) || null;

const extractSceneCount = (job) => {
  const candidates = [
    getChecklistStep(job, "storyboard")?.detail,
    getChecklistStep(job, "assets")?.detail
  ].filter(Boolean);

  for (const text of candidates) {
    const match = String(text).match(/(\d+)\s+cenas?|\bTodos os\s+(\d+)\s+clips?/i);
    const value = Number(match?.[1] || match?.[2] || 0);

    if (Number.isInteger(value) && value > 0) {
      return value;
    }
  }

  return 0;
};

const extractMissingSceneNumber = (job) => {
  const explicit = Number(job?.nextMissingSceneNumber || 0);
  if (Number.isInteger(explicit) && explicit > 0) {
    return explicit;
  }

  const detail = getChecklistStep(job, "assets")?.detail || "";
  const match = String(detail).match(/Falta a cena\s+(\d+)/i);
  const value = Number(match?.[1] || 0);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const extractRenderProgress = (job) => {
  const logLines = Array.isArray(job?.logTail) ? [...job.logTail].reverse() : [];

  for (const line of logLines) {
    const match = String(line).match(/Rendered\s+(\d+)\s*\/\s*(\d+)/i);
    const done = Number(match?.[1] || 0);
    const total = Number(match?.[2] || 0);

    if (total > 0 && done >= 0) {
      return {
        done,
        total,
        ratio: Math.max(0, Math.min(1, done / total))
      };
    }
  }

  return null;
};

const getStepCompletionRatio = (job, key) => {
  const step = getChecklistStep(job, key);
  const status = String(step?.status || "missing");

  if (status === "completed") {
    return 1;
  }

  if (key === "assets") {
    const totalScenes = extractSceneCount(job);
    const missingScene = extractMissingSceneNumber(job);

    if (totalScenes > 0 && Number.isInteger(missingScene) && missingScene > 0) {
      return Math.max(0, Math.min(1, (missingScene - 1) / totalScenes));
    }
  }

  if (key === "render") {
    const renderProgress = extractRenderProgress(job);

    if (renderProgress) {
      return renderProgress.ratio;
    }

    const logSignal = (Array.isArray(job?.logTail) ? job.logTail : []).join("\n").toLowerCase();
    if (logSignal.includes("a renderizar no remotion") || logSignal.includes("getting composition")) {
      return 0.04;
    }
  }

  if (key === "timestamps") {
    const logSignal = (Array.isArray(job?.logTail) ? job.logTail : []).join("\n").toLowerCase();
    if (logSignal.includes("karaoke") || logSignal.includes("speech-to-text") || logSignal.includes("timestamps")) {
      return 0.55;
    }
  }

  if (key === "audio") {
    const logSignal = (Array.isArray(job?.logTail) ? job.logTail : []).join("\n").toLowerCase();
    if (logSignal.includes("a gerar voz") || logSignal.includes("voiceover")) {
      return 0.35;
    }
  }

  if (status === "ready") {
    return 0;
  }

  if (status === "partial") {
    return 0.55;
  }

  return 0;
};

const getJobProgressInfo = (job) => {
  if (!job) {
    return {percent: null, text: ""};
  }

  if (job.status === "completed") {
    return {percent: 100, text: "100% • concluído"};
  }

  const weights = {
    storyboard: 10,
    assets: 45,
    audio: 15,
    timestamps: 10,
    render: 15,
    qa: 5
  };

  const weightedTotal = Object.values(weights).reduce((sum, item) => sum + item, 0);
  const weightedProgress = Object.entries(weights).reduce(
    (sum, [key, weight]) => sum + getStepCompletionRatio(job, key) * weight,
    0
  );

  const percent = Math.max(0, Math.min(100, Math.round((weightedProgress / weightedTotal) * 100)));
  const startedAt = job.startedAt ? new Date(job.startedAt).getTime() : 0;
  const heartbeatAt = job.heartbeatAt ? new Date(job.heartbeatAt).getTime() : 0;
  const now = Date.now();
  const elapsedText = startedAt ? `criando há ${formatElapsed(now - startedAt)}` : "";
  const activityText = heartbeatAt ? `última atividade há ${formatElapsed(now - heartbeatAt)}` : "";
  const renderProgress = extractRenderProgress(job);
  const renderText = renderProgress ? `render ${renderProgress.done}/${renderProgress.total}` : "";

  return {
    percent,
    text: [percent !== null ? `${percent}%` : "", elapsedText, activityText, renderText].filter(Boolean).join(" • ")
  };
};

const isLogPinnedToBottom = (log = elements.jobLog) => {

  if (!log) {
    return true;
  }

  return log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
};

const syncLogAutoFollow = () => {
  state.logAutoFollow =
    isLogPinnedToBottom(elements.jobLog) ||
    isLogPinnedToBottom(elements.logsJobLog);
};

const maybeFollowLog = (log, shouldFollow) => {
  if (!shouldFollow || !log) {
    return;
  }

  requestAnimationFrame(() => {
    log.scrollTop = log.scrollHeight;
  });
};

const getJobFreshnessScore = (job) => {
  if (!job) {
    return 0;
  }

  const candidates = [
    job.updatedAt,
    job.heartbeatAt,
    job.completedAt,
    job.startedAt,
    job.createdAt
  ]
    .map((value) => new Date(value || 0).getTime())
    .filter((value) => Number.isFinite(value) && value > 0);

  return candidates.length > 0 ? Math.max(...candidates) : 0;
};

const shouldReplaceJob = (currentJob, nextJob) => {
  if (!currentJob) {
    return true;
  }

  const currentScore = getJobFreshnessScore(currentJob);
  const nextScore = getJobFreshnessScore(nextJob);

  if (nextScore > currentScore) {
    return true;
  }

  if (nextScore < currentScore) {
    return false;
  }

  const currentLogLength = Array.isArray(currentJob.logTail) ? currentJob.logTail.length : 0;
  const nextLogLength = Array.isArray(nextJob.logTail) ? nextJob.logTail.length : 0;

  return nextLogLength >= currentLogLength;
};

const upsertJob = (job) => {
  const index = state.jobs.findIndex((item) => item.id === job.id);

  if (index === -1) {
    state.jobs.unshift(job);
  } else {
    if (shouldReplaceJob(state.jobs[index], job)) {
      state.jobs[index] = job;
    }
  }

  state.jobs.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
};

const closeStream = () => {
  if (state.streamReconnectTimer) {
    clearTimeout(state.streamReconnectTimer);
    state.streamReconnectTimer = null;
  }

  if (state.stream) {
    state.stream.close();
  }

  state.stream = null;
  state.streamJobId = null;
};

const connectStream = (jobId) => {
  if (!jobId || state.streamJobId === jobId) {
    return;
  }

  closeStream();
  state.streamJobId = jobId;
  state.stream = new EventSource(`/api/jobs/${jobId}/stream`);

  state.stream.addEventListener("update", async (event) => {
    const payload = JSON.parse(event.data);
    upsertJob(payload);
    renderAll();

    if (payload.status === "completed" || payload.status === "failed") {
      await Promise.allSettled([refreshJobs(), refreshRuns(), refreshVideos()]);
    }
  });

  state.stream.onerror = () => {
    closeStream();

    state.streamReconnectTimer = window.setTimeout(() => {
      const currentJob = getJobById(jobId);
      if (currentJob && (currentJob.status === "queued" || currentJob.status === "running")) {
        connectStream(jobId);
      }
    }, 3000);
  };
};

const setActiveTab = (tabName) => {
  state.activeTab = tabName;

  if ((tabName === "logs" || tabName === "workspace") && !getJobById(state.selectedJobId) && state.jobs[0]) {
    state.selectedJobId = state.activeJobId || state.jobs[0].id;
  }

  if (tabName === "logs") {
    state.logAutoFollow = true;
  }

  elements.tabButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.tabTarget === tabName);
  });

  elements.tabPanels.forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.tabPanel !== tabName);
  });
};

const setVideoActionHint = (message, {error = false} = {}) => {
  if (!elements.videoActionHint) {
    return;
  }

  elements.videoActionHint.textContent = message || "";
  elements.videoActionHint.classList.toggle("hidden", !message);
  elements.videoActionHint.classList.toggle("error", Boolean(message && error));
};

const syncPublishModeUI = () => {
  const publishMode = getSelectedPublishMode();
  const isScheduled = publishMode === "scheduled";

  elements.videoScheduleField?.classList.toggle("hidden", !isScheduled);
  if (elements.publishVideoButton) {
    elements.publishVideoButton.textContent = isScheduled
      ? "Agendar no agenda.online"
      : "Publicar agora no agenda.online";
  }
};

const syncVideoTargetSelect = (selectedValue) => {
  if (!elements.videoTargetChannel || !state.config?.channels) {
    return;
  }

  fillSelect(elements.videoTargetChannel, state.config.channels, selectedValue || elements.videoTargetChannel.value);
};

const renderPreviewData = (previewData) => {
  if (!previewData) {
    elements.previewSummary.classList.add("hidden");
    elements.previewScenes.innerHTML = "";
    return;
  }

  const selectedJob = getJobById(state.selectedJobId);
  const imageStyle = getImageStyleMeta(selectedJob?.input?.imageStyle);
  const outputProfile = getOutputProfileMeta(selectedJob?.input?.outputProfile);

  elements.previewSummary.classList.remove("hidden");
  elements.previewSummary.innerHTML = `
    <div class="preview-card">
      <p class="preview-kicker">Assunto aprovado</p>
      <h4>${escapeHtml(previewData.videoTitle || "Sem titulo")}</h4>
      <p>${escapeHtml(previewData.hook || "")}</p>
      <p class="preview-meta">${escapeHtml(previewData.postCaption || "")}</p>
      ${
        outputProfile
          ? `<div class="preview-style"><strong>${escapeHtml(outputProfile.label)}</strong><br>${escapeHtml(outputProfile.description || "")}<br>${escapeHtml(outputProfile.aspectRatio || "")} • ${escapeHtml(`${outputProfile.width}x${outputProfile.height}`)}</div>`
          : ""
      }
      ${
        imageStyle
          ? `<div class="preview-style"><strong>${escapeHtml(imageStyle.label)}</strong><br>${escapeHtml(imageStyle.description || "")}</div>`
          : ""
      }
    </div>
  `;

  elements.previewScenes.innerHTML = (previewData.scenes || [])
    .map((scene, index) => {
      const queryList = Array.isArray(scene.candidateQueries) && scene.candidateQueries.length > 0
        ? scene.candidateQueries.slice(0, 2).map((query) => `<li>${escapeHtml(query)}</li>`).join("")
        : `<li>${escapeHtml(scene.searchQuery || "")}</li>`;

      return `
        <article class="scene-card">
          <p class="scene-index">Cena ${String(index + 1).padStart(2, "0")}</p>
          <h5>${escapeHtml(scene.title || `Cena ${index + 1}`)}</h5>
          <p>${escapeHtml(scene.narration || "")}</p>
          <div class="scene-meta">${escapeHtml(scene.overlay || "")}</div>
          <ul class="scene-query-list">${queryList}</ul>
        </article>
      `;
    })
    .join("");
};

const loadPreviewData = async (job) => {
  if (!job?.id || !job.outputUrl || state.previewCache.has(job.id) || state.loadingPreviewIds.has(job.id)) {
    return;
  }

  state.loadingPreviewIds.add(job.id);

  try {
    const previewData = await fetchJson(job.outputUrl);
    state.previewCache.set(job.id, previewData);

    if (state.selectedJobId === job.id) {
      renderSelectedJob();
    }
  } catch (error) {
    elements.previewScenes.innerHTML = `<div class="history-item muted">${escapeHtml(error.message)}</div>`;
  } finally {
    state.loadingPreviewIds.delete(job.id);
  }
};

const renderSelectedJob = () => {
  const job = getJobById(state.selectedJobId);

  if (!job) {
    elements.jobEmpty.classList.remove("hidden");
    elements.jobDetails.classList.add("hidden");
    return;
  }

  elements.jobEmpty.classList.add("hidden");
  elements.jobDetails.classList.remove("hidden");

  const shouldFollowLog = state.logAutoFollow || isLogPinnedToBottom(elements.jobLog);

  elements.jobType.textContent = getJobTypeLabel(job);
  elements.jobTitle.textContent = job.title;
  elements.jobStatus.textContent = job.status;
  elements.jobStatus.dataset.state = job.status;
  elements.jobMeta.textContent = getJobMetaLine(job);
  if (elements.jobProgressMeta) {
    elements.jobProgressMeta.textContent = getJobProgressInfo(job).text || "";
  }
  elements.jobLog.textContent = (job.logTail || []).join("\n");
  maybeFollowLog(elements.jobLog, shouldFollowLog);

  if (job.outputUrl) {
    elements.jobOutputLink.href = job.outputUrl;
    elements.jobOutputLink.classList.remove("hidden");
    elements.jobOutputLink.textContent = job.outputPath?.endsWith(".json") ? "Abrir saída" : "Abrir vídeo";
  } else {
    elements.jobOutputLink.classList.add("hidden");
  }

  if (job.storyboardUrl) {
    elements.jobStoryboardLink.href = job.storyboardUrl;
    elements.jobStoryboardLink.classList.remove("hidden");
  } else {
    elements.jobStoryboardLink.classList.add("hidden");
  }

  const failureLabel = getJobFailureLabel(job);
  if (failureLabel) {
    elements.jobFailureSummary.innerHTML = getJobFailureDetailsHtml(job) || escapeHtml(failureLabel);
    elements.jobFailureSummary.classList.remove("hidden");
  } else {
    elements.jobFailureSummary.textContent = "";
    elements.jobFailureSummary.classList.add("hidden");
  }

  if (elements.jobRecommendedLabel) {
    elements.jobRecommendedLabel.textContent = job.recommendedAction?.label || "Acompanhar execução";
  }
  if (elements.jobRecommendedDetails) {
    elements.jobRecommendedDetails.textContent = job.recommendedAction?.details || "A próxima ação é calculada a partir dos artefatos reais do run.";
  }

  if (elements.jobStepChecklist) {
    const steps = Array.isArray(job.stepChecklist) ? job.stepChecklist : [];
    elements.jobStepChecklist.innerHTML = steps.length > 0
      ? steps.map((step) => `
          <div class="step-checklist-item">
            <span class="step-checklist-badge" data-step-status="${escapeHtml(step.status || "missing")}">${escapeHtml(step.status || "missing")}</span>
            <div class="step-checklist-copy">
              <strong>${escapeHtml(step.label || step.key || "Etapa")}</strong>
              <p>${escapeHtml(step.detail || "")}</p>
            </div>
          </div>
        `).join("")
      : '<div class="history-item muted">Sem checklist disponível para este job.</div>';
  }

  const canResume = job.resumeAvailable !== false && job.type === "generate" && job.status === "failed" && !job.input.previewOnly;
  const canRegenerateScene =
    job.sceneRegenerateAvailable === true &&
    !job.input.previewOnly;
  const canGenerateAudio = job.audioPrepAvailable === true && !job.input.previewOnly;
  const canRenderOnly = job.renderOnlyAvailable === true && !job.input.previewOnly;
  const canValidateOnly = job.validateOnlyAvailable === true && !job.input.previewOnly;
  const canForceFail = job.forceFailAvailable === true;
  const primaryActionValue = String(job.recommendedAction?.value || "").trim();

  const actionButtons = [
    elements.resumeJobButton,
    elements.regenerateSceneButton,
    elements.generateAudioButton,
    elements.renderOnlyButton,
    elements.validateJobButton,
    elements.forceFailJobButton
  ].filter(Boolean);
  actionButtons.forEach((button) => button.classList.add("hidden"));

  elements.resumeJobButton.disabled = !canResume;
  elements.resumeJobButton.title = canResume ? "" : "Retomada automática indisponível para este job.";
  elements.regenerateSceneButton.disabled = !canRegenerateScene;
  elements.regenerateSceneButton.title = canRegenerateScene ? "" : "Disponível apenas quando houver uma cena faltante detectada.";
  elements.regenerateSceneButton.textContent = canRegenerateScene && Number.isInteger(job.nextMissingSceneNumber)
    ? `Regenerar cena ${job.nextMissingSceneNumber}`
    : "Regenerar cena faltante";
  elements.generateAudioButton.disabled = !canGenerateAudio;
  elements.generateAudioButton.title = canGenerateAudio ? "" : "Disponível quando storyboard, cenas e render-props já existem.";
  elements.renderOnlyButton.disabled = !canRenderOnly;
  elements.renderOnlyButton.title = canRenderOnly ? "" : "Disponível quando as cenas e o áudio final já existem.";
  elements.validateJobButton.disabled = !canValidateOnly;
  elements.validateJobButton.title = canValidateOnly ? "" : "Disponível quando o MP4 final já existe.";
  elements.forceFailJobButton.disabled = !canForceFail;
  elements.forceFailJobButton.title = canForceFail ? "" : "Disponível apenas para jobs queued ou running.";

  let visibleActionButton = null;
  if (primaryActionValue === "resume-rebuild" && canResume) {
    visibleActionButton = elements.resumeJobButton;
  } else if (primaryActionValue === "regenerate-missing-scene" && canRegenerateScene) {
    visibleActionButton = elements.regenerateSceneButton;
  } else if (primaryActionValue === "generate-audio" && canGenerateAudio) {
    visibleActionButton = elements.generateAudioButton;
  } else if (primaryActionValue === "render-only" && canRenderOnly) {
    visibleActionButton = elements.renderOnlyButton;
  } else if (primaryActionValue === "validate-only" && canValidateOnly) {
    visibleActionButton = elements.validateJobButton;
  } else if (primaryActionValue === "force-fail" && canForceFail) {
    visibleActionButton = elements.forceFailJobButton;
  }

  if (visibleActionButton) {
    visibleActionButton.classList.remove("hidden");
  }
  elements.jobActions.classList.toggle("hidden", !visibleActionButton);

  const isPreviewReady =
    job.type === "generate" &&
    job.input.previewOnly &&
    job.status === "completed" &&
    job.outputPath?.endsWith(".json");

  if (!isPreviewReady) {
    elements.previewPanel.classList.add("hidden");
    elements.approvePreviewButton.classList.add("hidden");
    renderPreviewData(null);
    return;
  }

  elements.previewPanel.classList.remove("hidden");
  elements.approvePreviewButton.classList.remove("hidden");
  const previewData = state.previewCache.get(job.id);

  if (previewData) {
    renderPreviewData(previewData);
  } else {
    elements.previewSummary.classList.add("hidden");
    elements.previewScenes.innerHTML = '<div class="history-item muted">Carregando preview aprovado...</div>';
    loadPreviewData(job).catch(() => {});
  }
};

const renderLogsJobsList = () => {
  if (!elements.logsJobsList) {
    return;
  }

  if (state.jobs.length === 0) {
    elements.logsJobsList.innerHTML = '<div class="history-item muted">Nenhum job recente.</div>';
    return;
  }

  elements.logsJobsList.innerHTML = state.jobs
    .map((job) => {
      const activeClass = job.id === state.selectedJobId ? " active" : "";
      const stageLabel = getJobStageLabel(job);
      return `
        <button class="history-item video-item${activeClass}" data-logs-job-id="${escapeHtml(job.id)}">
          <span class="history-title">${escapeHtml(job.title || job.slug || job.id)}</span>
          <span class="history-meta">${escapeHtml(job.status || "")} • ${escapeHtml(stageLabel)} • ${escapeHtml(formatDateTime(job.createdAt))}</span>
        </button>
      `;
    })
    .join("");

  elements.logsJobsList.querySelectorAll("[data-logs-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedJobId = button.dataset.logsJobId;
      state.logAutoFollow = true;
      const job = getJobById(state.selectedJobId);

      if (job && (job.status === "queued" || job.status === "running")) {
        connectStream(job.id);
      }

      renderAll();
    });
  });
};

const renderLogsPanel = () => {
  if (!elements.logsEmpty || !elements.logsDetails) {
    return;
  }

  const job = getJobById(state.selectedJobId);

  if (!job) {
    elements.logsEmpty.classList.remove("hidden");
    elements.logsDetails.classList.add("hidden");
    return;
  }

  elements.logsEmpty.classList.add("hidden");
  elements.logsDetails.classList.remove("hidden");
  elements.logsTitle.textContent = job.title || job.slug || "Job";
  elements.logsMeta.textContent = getJobMetaLine(job);
  if (elements.logsProgressMeta) {
    elements.logsProgressMeta.textContent = getJobProgressInfo(job).text || "";
  }
  elements.logsStatus.textContent = job.status;
  elements.logsStatus.dataset.state = job.status;
  const shouldFollowLog = state.logAutoFollow || isLogPinnedToBottom(elements.logsJobLog);
  elements.logsJobLog.textContent = (job.logTail || []).join("\n");
  maybeFollowLog(elements.logsJobLog, shouldFollowLog);

  const failureLabel = getJobFailureLabel(job);
  if (failureLabel) {
    elements.logsFailureSummary.innerHTML = getJobFailureDetailsHtml(job) || escapeHtml(failureLabel);
    elements.logsFailureSummary.classList.remove("hidden");
  } else {
    elements.logsFailureSummary.textContent = "";
    elements.logsFailureSummary.classList.add("hidden");
  }

  if (job.outputUrl) {
    elements.logsOutputLink.href = job.outputUrl;
    elements.logsOutputLink.classList.remove("hidden");
    elements.logsOutputLink.textContent = job.outputPath?.endsWith(".json") ? "Abrir saída" : "Abrir vídeo";
  } else {
    elements.logsOutputLink.classList.add("hidden");
  }

  if (job.storyboardUrl) {
    elements.logsStoryboardLink.href = job.storyboardUrl;
    elements.logsStoryboardLink.classList.remove("hidden");
  } else {
    elements.logsStoryboardLink.classList.add("hidden");
  }
};

const renderJobs = () => {
  if (state.jobs.length === 0) {
    elements.jobsList.innerHTML = '<div class="history-item muted">Nenhum job criado ainda.</div>';
    return;
  }

  elements.jobsList.innerHTML = state.jobs
    .slice(0, 6)
    .map((job) => {
      const activeClass = job.id === state.selectedJobId ? " active" : "";
      const stageLabel = getJobStageLabel(job);

      return `
        <button class="history-item${activeClass}" data-job-id="${escapeHtml(job.id)}">
          <span class="history-title">${escapeHtml(job.title)}</span>
          <span class="history-meta">${escapeHtml(job.status)} • ${escapeHtml(stageLabel)} • ${escapeHtml(job.slug)}</span>
          ${job.status === "failed" ? `<span class="history-meta">${escapeHtml(getJobFailureRca(job) || job.failureSummary || job.error || "Falha sem RCA disponível.")}</span>` : ""}
        </button>
      `;
    })
    .join("");

  elements.jobsList.querySelectorAll("[data-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedJobId = button.dataset.jobId;
      state.logAutoFollow = true;
      const job = getJobById(state.selectedJobId);

      if (job && (job.status === "queued" || job.status === "running")) {
        connectStream(job.id);
      }

      renderAll();
    });
  });
};

const renderRuns = () => {
  if (state.runs.length === 0) {
    elements.runsList.innerHTML = '<div class="history-item muted">Nenhum MP4 encontrado ainda.</div>';
    return;
  }

  elements.runsList.innerHTML = state.runs
    .slice(0, 6)
    .map(
      (run) => `
        <a class="history-item" href="${escapeHtml(run.url)}" target="_blank" rel="noreferrer">
          <span class="history-title">${escapeHtml(run.name)}</span>
          <span class="history-meta">${escapeHtml(run.channel || "")} • ${escapeHtml(formatDateTime(run.updatedAt))}</span>
        </a>
      `
    )
    .join("");
};

const renderVideos = () => {
  if (!elements.videosList) {
    return;
  }

  if (state.videos.length === 0) {
    elements.videosList.innerHTML = '<div class="history-item muted">Nenhum vídeo exportado ainda.</div>';
    return;
  }

  elements.videosList.innerHTML = state.videos
    .map((video) => {
      const activeClass = state.selectedLibraryKind === "video" && video.id === state.selectedVideoId ? " active" : "";
      const publishMeta = video.publishedAt
        ? ` • publicado ${escapeHtml(formatDateTime(video.publishedAt))}`
        : video.scheduleAt ? ` • agenda ${escapeHtml(formatDateTime(video.scheduleAt))}` : "";

      return `
        <button class="history-item video-item${activeClass}" data-video-id="${escapeHtml(video.id)}">
          <span class="history-title">${escapeHtml(video.title || video.name)}</span>
          <span class="history-meta">${escapeHtml(video.channelHandle || video.channel || "")} • ${escapeHtml(video.durationSeconds ? `${video.durationSeconds}s` : "sem duracao")} • ${escapeHtml(formatBytes(video.sizeBytes) || "")}</span>
          <span class="history-meta">${escapeHtml(formatDateTime(video.updatedAt))}${publishMeta}</span>
        </button>
      `;
    })
    .join("");

  elements.videosList.querySelectorAll("[data-video-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedVideoId = button.dataset.videoId;
      state.selectedFailedJobId = null;
      state.selectedLibraryKind = "video";
      renderAll();
    });
  });
};

const renderFailedJobs = () => {
  if (!elements.failedJobsList) {
    return;
  }

  if (state.failedJobs.length === 0) {
    elements.failedJobsList.innerHTML = '<div class="history-item muted">Nenhum job falhado recente.</div>';
    return;
  }

  elements.failedJobsList.innerHTML = state.failedJobs
    .map((job) => {
      const activeClass = state.selectedLibraryKind === "failed" && job.id === state.selectedFailedJobId ? " active" : "";
      const failureStageLabel = getJobFailureStageLabel(job) || job.failureStage || "pipeline";
      const rca = getJobFailureRca(job) || job.failureSummary || job.error || "";
      const nextAction = getJobNextRecommendedAction(job);
      return `
        <button class="history-item video-item${activeClass}" data-failed-job-id="${escapeHtml(job.id)}">
          <span class="history-title">${escapeHtml(job.title || job.slug)}</span>
          <span class="history-meta">${escapeHtml(job.channelHandle || job.channel || "")} • ${escapeHtml(failureStageLabel)} • ${escapeHtml(job.targetSeconds ? `${job.targetSeconds}s` : "")}</span>
          <span class="history-meta">${escapeHtml(rca || nextAction || "Falha sem RCA disponível.")}</span>
          <span class="history-meta">${escapeHtml(formatDateTime(job.createdAt))}</span>
        </button>
      `;
    })
    .join("");

  elements.failedJobsList.querySelectorAll("[data-failed-job-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFailedJobId = button.dataset.failedJobId;
      state.selectedVideoId = null;
      state.selectedLibraryKind = "failed";
      setVideoActionHint("");
      renderAll();
    });
  });
};

const fillVideoForm = (video) => {
  if (!elements.videoMetaForm || !video) {
    return;
  }

  elements.videoMetaForm.elements.slug.value = video.slug || "";
  elements.videoMetaForm.elements.path.value = video.path || "";
  if (elements.videoTargetChannel) {
    syncVideoTargetSelect(video.channel || "");
    elements.videoTargetChannel.value = video.channel || elements.videoTargetChannel.value || "";
    syncVideoTargetHint(elements.videoTargetChannel.value);
  } else {
    elements.videoMetaForm.elements.channel.value = video.channel || "";
  }
  elements.videoMetaForm.elements.title.value = video.title || "";
  elements.videoMetaForm.elements.caption.value = video.caption || "";
  elements.videoMetaForm.elements.hashtags.value = Array.isArray(video.hashtags) ? video.hashtags.join(" ") : "";
  elements.videoMetaForm.elements.scheduleAt.value = toDateTimeLocalValue(video.scheduleAt || "");
  elements.videoMetaForm.elements.isDraft.checked = video.isDraft === true;
  const publishMode = video.scheduleAt || video.lastPublishStatus === "scheduled" ? "scheduled" : "now";
  elements.videoMetaForm.querySelectorAll('input[name="publishMode"]').forEach((input) => {
    input.checked = input.value === publishMode;
  });

  elements.videoMetaForm.querySelectorAll('input[name="platforms"]').forEach((input) => {
    input.checked = Array.isArray(video.platforms) ? video.platforms.includes(input.value) : false;
  });

  syncPublishModeUI();
};

const renderSelectedVideo = () => {
  const video = getVideoById(state.selectedVideoId);

  if (!video || state.selectedLibraryKind !== "video") {
    elements.videoDetails.classList.add("hidden");
    return;
  }

  elements.videoDetails.classList.remove("hidden");

  elements.videoChannel.textContent = video.channelHandle || video.channelLabel || "Biblioteca";
  elements.videoTitleHeading.textContent = video.title || video.name || "Vídeo";
  elements.videoMeta.textContent = [
    video.slug,
    video.durationSeconds ? `${video.durationSeconds}s` : null,
    formatBytes(video.sizeBytes),
    formatDateTime(video.updatedAt)
  ]
    .filter(Boolean)
    .join(" • ");

  const publishStatus =
    video.publishStatus ||
    video.state?.key ||
    video.lastPublishStatus ||
    (video.publishedAt ? "published" : video.scheduleAt ? "ready" : "local");
  elements.videoPublishStatus.textContent = publishStatus;
  elements.videoPublishStatus.dataset.state = publishStatus === "scheduled" || publishStatus === "published" ? "completed" : "";

  const artworkUrl = getVideoArtworkUrl(video);
  if (elements.videoArtwork && elements.videoArtworkImage && elements.videoArtworkTitle && elements.videoArtworkMeta) {
    if (artworkUrl) {
      elements.videoArtwork.classList.remove("hidden");
      elements.videoArtworkImage.src = artworkUrl;
      elements.videoArtworkImage.alt = `${video.title || video.name || "Vídeo"} - thumbnail`;
      elements.videoArtworkTitle.textContent = video.title || video.name || "Imagem de destaque";
      elements.videoArtworkMeta.textContent = video.thumbnailLabel || video.coverLabel || video.posterLabel || "Thumbnail disponível para pré-visualização e publicação.";
      elements.videoPlayer.poster = artworkUrl;
    } else {
      elements.videoArtwork.classList.add("hidden");
      elements.videoPlayer.removeAttribute("poster");
      elements.videoArtworkImage.removeAttribute("src");
      elements.videoArtworkMeta.textContent = "";
    }
  }

  if (elements.videoPlayer.getAttribute("src") !== video.url) {
    elements.videoPlayer.setAttribute("src", video.url);
  }

  elements.videoOpenLink.href = video.url;

  if (video.storyboardUrl) {
    elements.videoStoryboardLink.href = video.storyboardUrl;
    elements.videoStoryboardLink.classList.remove("hidden");
  } else {
    elements.videoStoryboardLink.classList.add("hidden");
  }

  renderVideoCreationParams(video);

  fillVideoForm(video);

  if (elements.videoTargetChannel) {
    syncVideoTargetSelect(video.channel || "");
    elements.videoTargetChannel.value = video.channel || elements.videoTargetChannel.value || "";
    syncVideoTargetHint(elements.videoTargetChannel.value);
  }

  syncPublishModeUI();

  const agendadorHint = state.agendador?.configured
    ? "Agendador pronto para publicar. Se faltar conta conectada, a API vai dizer qual rede está desconectada."
    : "As credenciais do agenda.online não apareceram no ambiente carregado. Se estiverem só no keychain, o publish ainda pode funcionar no backend.";
  elements.videoLibraryHint.textContent = agendadorHint;
};

const renderSelectedFailedJob = () => {
  const job = getFailedJobById(state.selectedFailedJobId);

  if (!job || state.selectedLibraryKind !== "failed") {
    elements.failedJobDetails.classList.add("hidden");
    return;
  }

  elements.failedJobDetails.classList.remove("hidden");
  elements.failedJobChannel.textContent = job.channelHandle || job.channel || "Falhado";
  elements.failedJobTitle.textContent = job.title || job.slug || "Job falhado";
  elements.failedJobMeta.textContent = [
    job.slug,
    getJobFailureStageLabel(job) || job.failureStage || "pipeline",
    job.outputProfile || null,
    job.targetSeconds ? `${job.targetSeconds}s` : null,
    formatDateTime(job.createdAt)
  ]
    .filter(Boolean)
    .join(" • ");
  elements.failedJobStatus.textContent = "failed";
  elements.failedJobStatus.dataset.state = "failed";
  elements.failedJobError.innerHTML = getJobFailureDetailsHtml(job) || escapeHtml(job.failureSummary || job.error || "Falhou sem detalhe adicional.");
  if (elements.failedJobRecommendedLabel) {
    elements.failedJobRecommendedLabel.textContent = job.recommendedAction?.label || "Revisar storyboard e seguir a recuperação segura.";
  }
  if (elements.failedJobRecommendedDetails) {
    elements.failedJobRecommendedDetails.textContent = job.recommendedAction?.details || "O painel de falhados reaproveita a recomendação calculada a partir dos artefatos reais do run.";
  }

  if (job.storyboardUrl) {
    elements.failedJobStoryboardLink.href = job.storyboardUrl;
    elements.failedJobStoryboardLink.classList.remove("hidden");
  } else {
    elements.failedJobStoryboardLink.classList.add("hidden");
  }

  const canRetryFromStoryboard =
    job.retryFromStoryboardAvailable === true &&
    String(job.recommendedAction?.value || "").trim() === "retry-from-storyboard";
  elements.retryFailedJobButton.disabled = !canRetryFromStoryboard;
  elements.retryFailedJobButton.title = canRetryFromStoryboard
    ? ""
    : "Use o painel principal do job quando a recuperação recomendada não for refazer do storyboard.";
  elements.retryFailedJobButton.textContent = job.recommendedAction?.label || "Refazer este job";
  elements.failedJobActions?.classList.toggle("hidden", !canRetryFromStoryboard);
};

const renderSelectedLibraryItem = () => {
  const hasVideo = state.selectedLibraryKind === "video" && getVideoById(state.selectedVideoId);
  const hasFailedJob = state.selectedLibraryKind === "failed" && getFailedJobById(state.selectedFailedJobId);

  elements.videoEmpty.classList.toggle("hidden", Boolean(hasVideo || hasFailedJob));
  renderSelectedVideo();
  renderSelectedFailedJob();
};

const renderAll = () => {
  elements.queueCount.textContent = String(state.queueLength);
  elements.previewQueueCount.textContent = String(state.previewQueueLength);
  elements.heavyQueueCount.textContent = String(state.heavyQueueLength);
  renderSelectedJob();
  renderJobs();
  renderLogsJobsList();
  renderLogsPanel();
  renderRuns();
  renderVideos();
  renderFailedJobs();
  renderSelectedLibraryItem();
};

const refreshJobs = async () => {
  const payload = await fetchJson("/api/jobs");
  state.jobs = payload.jobs || [];
  state.activePreviewJobId = payload.activePreviewJobId || null;
  state.activeHeavyJobId = payload.activeHeavyJobId || null;
  state.activeJobId = payload.activeJobId || state.activeHeavyJobId || state.activePreviewJobId || null;
  state.previewQueueLength = Number(
    payload.previewQueueLength ??
    state.jobs.filter((job) => job.status === "queued" && getJobQueueLane(job) === "preview").length
  );
  state.heavyQueueLength = Number(
    payload.heavyQueueLength ??
    state.jobs.filter((job) => job.status === "queued" && getJobQueueLane(job) === "heavy").length
  );
  state.queueLength = Number(payload.queueLength ?? state.previewQueueLength + state.heavyQueueLength);

  if (!state.selectedJobId && state.jobs[0]) {
    state.selectedJobId = state.jobs[0].id;
  }

  const selectedJob = getJobById(state.selectedJobId);

  if (selectedJob && (selectedJob.status === "queued" || selectedJob.status === "running")) {
    connectStream(selectedJob.id);
  }

  renderAll();
};

const refreshRuns = async () => {
  const payload = await fetchJson("/api/runs");
  state.runs = payload.runs || [];
  renderRuns();
};

const refreshVideos = async () => {
  const payload = await fetchJson("/api/videos");
  state.videos = payload.videos || [];
  state.failedJobs = payload.failedJobs || [];
  state.agendador = payload.agendador || null;

  if (!state.selectedLibraryKind && state.videos[0]) {
    state.selectedLibraryKind = "video";
  }

  if (!state.selectedLibraryKind && !state.videos[0] && state.failedJobs[0]) {
    state.selectedLibraryKind = "failed";
  }

  if (!state.selectedVideoId && state.videos[0]) {
    state.selectedVideoId = state.videos[0].id;
  } else if (state.selectedVideoId && !getVideoById(state.selectedVideoId)) {
    state.selectedVideoId = state.videos[0]?.id || null;
    if (!state.selectedVideoId && state.failedJobs[0]) {
      state.selectedLibraryKind = "failed";
    }
  }

  if (!state.selectedFailedJobId && !state.selectedVideoId && state.failedJobs[0]) {
    state.selectedFailedJobId = state.failedJobs[0].id;
  } else if (state.selectedFailedJobId && !getFailedJobById(state.selectedFailedJobId)) {
    state.selectedFailedJobId = state.failedJobs[0]?.id || null;
  }

  if (state.selectedLibraryKind === "video" && !state.selectedVideoId && state.failedJobs[0]) {
    state.selectedLibraryKind = "failed";
    state.selectedFailedJobId = state.failedJobs[0].id;
  }

  if (state.selectedLibraryKind === "failed" && !state.selectedFailedJobId && state.videos[0]) {
    state.selectedLibraryKind = "video";
    state.selectedVideoId = state.videos[0].id;
  }

  renderVideos();
  renderFailedJobs();
  renderSelectedLibraryItem();
};

const toggleCustomVoiceField = (select, field) => {
  if (!select || !field) {
    return;
  }

  field.classList.toggle("hidden", select.value !== "__custom");
};

const syncGenerateMode = () => {
  if (!elements.generateSubmitButton || !elements.autoApproveToggle) {
    return;
  }

  elements.generateSubmitButton.textContent = elements.autoApproveToggle.checked
    ? "Gerar vídeo direto"
    : "Montar preview para aprovar";
};

const applyChannelPresetToForm = (channelId) => {
  const preset = getChannelPreset(channelId);

  if (!preset) {
    return;
  }

  const toneSelect = document.querySelector("#generateTone");
  const languageSelect = document.querySelector("#generateLanguage");
  const voiceSelect = document.querySelector("#generateVoice");
  const imageModelSelect = document.querySelector("#generateImageModel");
  const imageStyleSelect = document.querySelector("#generateImageStyle");
  const profileSelect = document.querySelector("#generateOutputProfile");
  const customStyleInput = elements.generateForm?.querySelector('input[name="customStylePrompt"]');

  if (toneSelect && preset.tone) {
    toneSelect.value = preset.tone;
  }

  if (languageSelect && preset.language) {
    languageSelect.value = preset.language;
  }

  if (voiceSelect && preset.voice) {
    const language = languageSelect?.value || state.config?.defaults?.language || "pt-BR";
    const presetVoice =
      preset.voiceByLanguage?.[language] ||
      preset.voice ||
      getPreferredVoiceForLanguage(language);
    syncVoiceOptionsForLanguage(language, presetVoice);
  }

  if (imageModelSelect && preset.imageModel) {
    imageModelSelect.value = preset.imageModel;
  }

  if (imageStyleSelect && preset.imageStyle) {
    imageStyleSelect.value = preset.imageStyle;
  }

  if (customStyleInput) {
    customStyleInput.value = preset.customStylePrompt || "";
  }

  if (profileSelect && preset.outputProfile) {
    syncOutputProfileControls(preset.outputProfile, preset.targetSeconds);
  } else if (preset.targetSeconds) {
    syncOutputProfileControls(profileSelect?.value, preset.targetSeconds);
  }
};

const syncOutputProfileControls = (profileId, preferredDuration) => {
  const profileSelect = document.querySelector("#generateOutputProfile");
  const durationSelect = document.querySelector("#generateDuration");
  const profile = getOutputProfileMeta(profileId) || state.config?.outputProfiles?.[0] || null;

  if (!profileSelect || !durationSelect || !profile) {
    return;
  }

  const previousDuration = Number(preferredDuration || durationSelect.value || profile.defaultTargetSeconds);
  const selectedDuration = profile.durations.includes(previousDuration)
    ? previousDuration
    : profile.defaultTargetSeconds;

  fillSelect(profileSelect, state.config.outputProfiles, profile.value);
  fillSelect(
    durationSelect,
    profile.durations.map((value) => ({label: `${value}s`, value})),
    selectedDuration
  );

  if (elements.outputProfileHint) {
    elements.outputProfileHint.textContent = `${profile.description} • ${profile.aspectRatio} • ${profile.width}x${profile.height}`;
  }

  if (elements.durationHint) {
    elements.durationHint.textContent = `Faixa disponivel para este formato: ${profile.durations.map((value) => `${value}s`).join(", ")}.`;
  }
};

const loadConfig = async () => {
  const payload = await fetchJson("/api/config");
  state.config = payload;

  fillSelect(document.querySelector("#generateLanguage"), languageOptions, payload.defaults.language);
  fillSelect(document.querySelector("#generateOutputProfile"), payload.outputProfiles, payload.defaults.outputProfile);
  fillSelect(document.querySelector("#generateImageModel"), payload.imageModels || [], payload.defaults.imageModel);
  fillSelect(document.querySelector("#generateImageStyle"), payload.imageStyles, payload.defaults.imageStyle);
  fillSelect(document.querySelector("#generateChannel"), payload.channels, payload.defaults.channel);
  fillSelect(document.querySelector("#generateTone"), payload.tones, payload.defaults.tone);
  syncVoiceOptionsForLanguage(payload.defaults.language, payload.defaults.voice);
  syncVideoTargetSelect(document.querySelector("#videoTargetChannel")?.value || payload.defaults.channel);

  elements.generateForm.force.checked = Boolean(payload.defaults.force);
  elements.generateForm.noMusic.checked = Boolean(payload.defaults.noMusic);

  const voiceSelect = document.querySelector("#generateVoice");
  const customVoiceField = document.querySelector("#generateCustomVoiceField");

  const syncVoiceField = () => {
    toggleCustomVoiceField(voiceSelect, customVoiceField);
    syncVoiceHint(voiceSelect?.value || "");
  };
  voiceSelect?.addEventListener("change", syncVoiceField);
  syncVoiceField();

  const syncImageStyleHint = () => {
    const selected = getImageStyleMeta(document.querySelector("#generateImageStyle")?.value);
    elements.imageStyleHint.textContent = selected?.description || "";
    syncImageStylePreview(document.querySelector("#generateImageStyle")?.value);
  };

  const syncImageModelField = () => {
    syncImageModelHint(document.querySelector("#generateImageModel")?.value || payload.defaults.imageModel);
  };

  const syncProfileHints = () => {
    const profile = getOutputProfileMeta(document.querySelector("#generateOutputProfile")?.value);
    const durationSelect = document.querySelector("#generateDuration");
    syncOutputProfileControls(profile?.value || payload.defaults.outputProfile, durationSelect?.value || payload.defaults.targetSeconds);
  };

  const syncChannelHint = () => {
    const selected = getChannelMeta(document.querySelector("#generateChannel")?.value);
    elements.channelHint.textContent = selected
      ? `${selected.description || ""} Vai salvar em Documents/postar/${selected.folder}`.trim()
      : "";
  };

  const syncToneHint = () => {
    const selected = getToneMeta(document.querySelector("#generateTone")?.value);
    elements.toneHint.textContent = selected?.description || "";
  };

  document.querySelector("#generateImageModel")?.addEventListener("change", syncImageModelField);
  document.querySelector("#generateImageStyle")?.addEventListener("change", syncImageStyleHint);
  document.querySelector("#generateOutputProfile")?.addEventListener("change", syncProfileHints);
  document.querySelector("#generateTone")?.addEventListener("change", syncToneHint);
  document.querySelector("#generateLanguage")?.addEventListener("change", () => {
    const language = document.querySelector("#generateLanguage")?.value || payload.defaults.language;
    const currentVoice = document.querySelector("#generateVoice")?.value || "";
    syncVoiceOptionsForLanguage(language, currentVoice);
    syncVoiceField();
  });
  document.querySelector("#generateChannel")?.addEventListener("change", () => {
    const channelId = document.querySelector("#generateChannel")?.value;
    applyChannelPresetToForm(channelId);
    syncImageModelField();
    syncImageStyleHint();
    syncToneHint();
    syncChannelHint();
  });
  document.querySelector("#videoTargetChannel")?.addEventListener("change", () => {
    const selectedChannel = document.querySelector("#videoTargetChannel")?.value;
    syncVideoTargetHint(selectedChannel);
  });
  elements.videoMetaForm?.querySelectorAll('input[name="publishMode"]').forEach((input) => {
    input.addEventListener("change", syncPublishModeUI);
  });

  elements.autoApproveToggle?.addEventListener("change", syncGenerateMode);
  elements.generateForm?.querySelector('input[name="title"]')?.addEventListener("input", () => validateGenerateForm(elements.generateForm));
  elements.generateForm?.querySelector('textarea[name="sourceText"]')?.addEventListener("input", () => validateGenerateForm(elements.generateForm));

  applyChannelPresetToForm(payload.defaults.channel);
  syncImageModelField();
  syncImageStyleHint();
  syncProfileHints();
  syncToneHint();
  syncChannelHint();
  syncGenerateMode();
  syncPublishModeUI();
  syncVideoTargetHint(payload.defaults.channel);
  validateGenerateForm(elements.generateForm);
};

const buildGeneratePayload = (form, submitter) => {
  const data = new FormData(form);
  const autoApprove = form.autoApprove?.checked === true;

  return {
    title: String(data.get("title") || "").trim(),
    sourceText: String(data.get("sourceText") || "").trim(),
    language: String(data.get("language") || "pt-BR"),
    outputProfile: String(data.get("outputProfile") || "vertical-short"),
    targetSeconds: Number(data.get("targetSeconds") || 60),
    imageModel: String(data.get("imageModel") || state.config?.defaults?.imageModel || "gemini-2.5-flash-image"),
    imageStyle: String(data.get("imageStyle") || "claude"),
    channel: String(data.get("channel") || "foiumaideia"),
    tone: String(data.get("tone") || "shortform_native"),
    voice: String(data.get("voice") || getPreferredVoiceForLanguage(String(data.get("language") || "pt-BR"))),
    customVoice: String(data.get("customVoice") || "").trim(),
    customStylePrompt: String(data.get("customStylePrompt") || "").trim(),
    force: form.force.checked,
    noMusic: form.noMusic.checked,
    previewOnly: autoApprove ? false : submitter?.dataset.previewOnly === "true"
  };
};

const validateGenerateForm = (form) => {
  const titleInput = form.querySelector('input[name="title"]');
  const sourceTextInput = form.querySelector('textarea[name="sourceText"]');
  const title = String(titleInput?.value || "").trim();
  const sourceText = String(sourceTextInput?.value || "").trim();
  const titleWords = title.split(/\s+/).filter(Boolean).length;
  let message = "";

  if (!title && sourceText.length < MIN_SOURCE_TEXT_CHARS) {
    message = `Preencha um titulo ou cole pelo menos ${MIN_SOURCE_TEXT_CHARS} caracteres de texto-base.`;
  } else if (!sourceText && (title.length < MIN_TITLE_CHARS_WITHOUT_SOURCE || titleWords < MIN_TITLE_WORDS_WITHOUT_SOURCE)) {
    message = `Sem texto-base, o titulo precisa ter pelo menos ${MIN_TITLE_WORDS_WITHOUT_SOURCE} palavras e ${MIN_TITLE_CHARS_WITHOUT_SOURCE} caracteres.`;
  }

  titleInput?.setCustomValidity(message && !sourceText ? message : "");
  sourceTextInput?.setCustomValidity(message && !title ? message : "");

  elements.generateValidationHint.textContent = message;
  elements.generateValidationHint.classList.toggle("hidden", !message);
  elements.generateValidationHint.classList.toggle("error", Boolean(message));

  form.querySelectorAll('button[type="submit"]').forEach((button) => {
    button.disabled = Boolean(message);
  });

  return !message;
};

const getSelectedVideoPayload = () => {
  const selectedVideo = getVideoById(state.selectedVideoId);

  if (!selectedVideo || !elements.videoMetaForm) {
    return null;
  }

  const data = new FormData(elements.videoMetaForm);
  const hashtags = String(data.get("hashtags") || "")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const scheduleAtRaw = String(data.get("scheduleAt") || "").trim();

  return {
    slug: String(data.get("slug") || selectedVideo.slug || "").trim(),
    path: String(data.get("path") || selectedVideo.path || "").trim(),
    channel: String(data.get("channel") || selectedVideo.channel || "").trim(),
    title: String(data.get("title") || "").trim(),
    caption: String(data.get("caption") || "").trim(),
    hashtags,
    scheduleAt: parseDateTimeLocalToIso(scheduleAtRaw),
    platforms: Array.from(elements.videoMetaForm.querySelectorAll('input[name="platforms"]:checked')).map((input) => input.value),
    isDraft: elements.videoMetaForm.elements.isDraft.checked
  };
};

const getSelectedVideoPublishPayload = () => {
  const payload = getSelectedVideoPayload();

  if (!payload) {
    return null;
  }

  const publishMode = getSelectedPublishMode();
  return {
    ...payload,
    publishMode,
    scheduleAt: publishMode === "scheduled" ? payload.scheduleAt : ""
  };
};

elements.generateForm?.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    if (!validateGenerateForm(elements.generateForm)) {
      elements.generateForm.reportValidity();
      return;
    }

    const payload = buildGeneratePayload(elements.generateForm, event.submitter);
    const response = await fetchJson("/api/generate", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    setActiveTab("workspace");
    await refreshJobs();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.approvePreviewButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson("/api/approve-preview", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await refreshJobs();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.resumeJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedJob.id)}/resume`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await refreshJobs();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.forceFailJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedJob.id)}/force-fail`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    await Promise.allSettled([refreshJobs(), refreshVideos()]);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.regenerateSceneButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedJob.id)}/regenerate-missing-scene`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jobId: selectedJob.id,
        sceneNumber: selectedJob.nextMissingSceneNumber || null,
        autoContinueAfterSceneRepair: true
      })
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await Promise.allSettled([refreshJobs(), refreshVideos()]);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.generateAudioButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedJob.id)}/generate-audio`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await Promise.allSettled([refreshJobs(), refreshVideos()]);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.renderOnlyButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedJob.id)}/render-only`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await Promise.allSettled([refreshJobs(), refreshVideos()]);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.validateJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedJob.id)}/validate`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await Promise.allSettled([refreshJobs(), refreshVideos()]);
  } catch (error) {
    window.alert(error.message);
  }
});

elements.retryFailedJobButton?.addEventListener("click", async () => {
  const selectedFailedJob = getFailedJobById(state.selectedFailedJobId);

  if (!selectedFailedJob) {
    return;
  }

  try {
    const response = await fetchJson(`/api/jobs/${encodeURIComponent(selectedFailedJob.id)}/retry-from-storyboard`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jobId: selectedFailedJob.id})
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    state.selectedLibraryKind = "failed";
    setVideoActionHint("Job falhado reenfileirado a partir do storyboard.");
    setActiveTab("workspace");
    await Promise.allSettled([refreshJobs(), refreshVideos()]);
  } catch (error) {
    setVideoActionHint(error.message, {error: true});
  }
});

elements.videoMetaForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = getSelectedVideoPayload();

  if (!payload) {
    return;
  }

  try {
    const response = await fetchJson("/api/videos/meta", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const updatedVideo = response.video || null;
    await refreshVideos();
    if (updatedVideo?.id) {
      state.selectedVideoId = updatedVideo.id;
    }
    setVideoActionHint("Edição salva.");
    renderAll();
  } catch (error) {
    setVideoActionHint(error.message, {error: true});
  }
});

elements.redoVideoButton?.addEventListener("click", async () => {
  const payload = getSelectedVideoPayload();

  if (!payload) {
    return;
  }

  try {
    const response = await fetchJson("/api/videos/refazer", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    state.logAutoFollow = true;
    connectStream(response.job.id);
    setActiveTab("workspace");
    setVideoActionHint("Refazer entrou na fila.");
    await refreshJobs();
  } catch (error) {
    setVideoActionHint(error.message, {error: true});
  }
});

elements.deleteVideoButton?.addEventListener("click", async () => {
  const payload = getSelectedVideoPayload();

  if (!payload) {
    return;
  }

  const confirmed = window.confirm(`Deletar o vídeo "${payload.title || payload.slug}"?`);
  if (!confirmed) {
    return;
  }

  try {
    await fetchJson("/api/videos/delete", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const deletedId = state.selectedVideoId;
    await Promise.allSettled([refreshVideos(), refreshRuns()]);
    if (state.selectedVideoId === deletedId && !getVideoById(deletedId)) {
      state.selectedVideoId = state.videos[0]?.id || null;
    }
    setVideoActionHint("Vídeo deletado.");
    renderAll();
  } catch (error) {
    setVideoActionHint(error.message, {error: true});
  }
});

elements.publishVideoButton?.addEventListener("click", async () => {
  const payload = getSelectedVideoPublishPayload();

  if (!payload) {
    return;
  }

  if (payload.publishMode === "scheduled" && !payload.scheduleAt) {
    setVideoActionHint("Selecione data e hora para agendar a publicação.", {error: true});
    return;
  }

  try {
    const response = await fetchJson("/api/videos/publish", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    const updatedVideo = response.video || null;
    await refreshVideos();
    if (updatedVideo?.id) {
      state.selectedVideoId = updatedVideo.id;
    }
    const postId = response.post?.id ? `Post ${response.post.id}` : "Publicação enviada";
    setVideoActionHint(`${postId} criado no agenda.online.`);
    renderAll();
  } catch (error) {
    setVideoActionHint(error.message, {error: true});
  }
});

elements.openTikTokHelperButton?.addEventListener("click", async () => {
  const payload = getSelectedVideoPayload();

  if (!payload) {
    return;
  }

  try {
    const response = await fetchJson("/api/videos/tiktok-helper", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    if (response.helperUrl) {
      window.open(response.helperUrl, "_blank", "noopener,noreferrer");
    }

    setVideoActionHint(response.message || "Helper do TikTok aberto.");
  } catch (error) {
    setVideoActionHint(error.message, {error: true});
  }
});

elements.tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tabTarget);
  });
});

await loadConfig();
await Promise.allSettled([refreshJobs(), refreshRuns(), refreshVideos()]);
setActiveTab(state.activeTab);

if (elements.jobLog) {
  elements.jobLog.addEventListener("scroll", syncLogAutoFollow);
}

if (elements.logsJobLog) {
  elements.logsJobLog.addEventListener("scroll", syncLogAutoFollow);
}

setInterval(() => {
  refreshJobs().catch(() => {});
  refreshRuns().catch(() => {});
  refreshVideos().catch(() => {});
}, DEFAULT_REFRESH_INTERVAL_MS);

setInterval(() => {
  const selectedJob = getJobById(state.selectedJobId);
  const activeJob = getJobById(state.activeJobId);
  const targetJob =
    (selectedJob && (selectedJob.status === "queued" || selectedJob.status === "running") && selectedJob) ||
    (activeJob && (activeJob.status === "queued" || activeJob.status === "running") && activeJob) ||
    null;

  if (!targetJob) {
    return;
  }

  refreshJobs().catch(() => {});
}, ACTIVE_JOB_REFRESH_INTERVAL_MS);
