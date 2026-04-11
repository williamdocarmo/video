const state = {
  config: null,
  jobs: [],
  videos: [],
  agendador: null,
  selectedJobId: null,
  selectedVideoId: null,
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
  storyboardCache: new Map(),
  previewEditorDrafts: new Map(),
  loadingPreviewIds: new Set(),
  loadingStoryboardUrls: new Set(),
  pendingJobActionIds: new Set(),
  logPageByJobId: new Map(),
  videoPage: 1,
  videoFilter: 'all',
  videoSearch: '',
  jobPage: 1,
  jobFilter: 'all',
  jobSearch: '',
};

const DEFAULT_REFRESH_INTERVAL_MS = 20000;
const ACTIVE_JOB_REFRESH_INTERVAL_MS = 5000;
const LOG_PAGE_SIZE = 120;
const VIDEOS_PER_PAGE = 12;
const JOBS_PER_PAGE = 20;

const languageOptions = [
  {label: "Português (Brasil)", value: "pt-BR"},
  {label: "English", value: "en-US"}
];

const generationModeOptions = [
  {
    label: "Pipeline de imagem",
    value: "image-pipeline",
    description: "Gera imagens por cena e monta o vídeo a partir dos assets renderizados."
  },
  {
    label: "Texto para vídeo",
    value: "text-to-video",
    description: "Ativa a trilha direta de texto para vídeo e usa o estilo como direção visual."
  }
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
  generationModeHint: document.querySelector("#generationModeHint"),
  durationHint: document.querySelector("#durationHint"),
  imageModelHint: document.querySelector("#imageModelHint"),
  imageModelCost: document.querySelector("#imageModelCost"),
  imageStyleLabel: document.querySelector("#generateImageStyleLabel"),
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
  jobProgressFill: document.querySelector("#jobProgressFill"),
  jobStatus: document.querySelector("#jobStatus"),
  jobOutputLink: document.querySelector("#jobOutputLink"),
  jobStoryboardLink: document.querySelector("#jobStoryboardLink"),
  jobSceneLinks: document.querySelector("#jobSceneLinks"),
  jobFailureSummary: document.querySelector("#jobFailureSummary"),
  jobRecommendedLabel: document.querySelector("#jobRecommendedLabel"),
  jobRecommendedDetails: document.querySelector("#jobRecommendedDetails"),
  jobStepChecklist: document.querySelector("#jobStepChecklist"),
  jobActions: document.querySelector("#jobActions"),
  resumeJobButton: document.querySelector("#resumeJobButton"),
  retryFromStoryboardJobButton: document.querySelector("#retryFromStoryboardJobButton"),
  regenerateSceneButton: document.querySelector("#regenerateSceneButton"),
  generateAudioButton: document.querySelector("#generateAudioButton"),
  renderOnlyButton: document.querySelector("#renderOnlyButton"),
  validateJobButton: document.querySelector("#validateJobButton"),
  forceFailJobButton: document.querySelector("#forceFailJobButton"),
  previewPanel: document.querySelector("#previewPanel"),
  previewStoryboardForm: document.querySelector("#previewStoryboardForm"),
  previewSummary: document.querySelector("#previewSummary"),
  previewScenes: document.querySelector("#previewScenes"),
  approvePreviewButton: document.querySelector("#approvePreviewButton"),
  logsJobsList: document.querySelector("#logsJobsList"),
  logsEmpty: document.querySelector("#logsEmpty"),
  logsDetails: document.querySelector("#logsDetails"),
  logsTitle: document.querySelector("#logsTitle"),
  logsMeta: document.querySelector("#logsMeta"),
  logsProgressMeta: document.querySelector("#logsProgressMeta"),
  logsProgressFill: document.querySelector("#logsProgressFill"),
  logsStatus: document.querySelector("#logsStatus"),
  logsOutputLink: document.querySelector("#logsOutputLink"),
  logsStoryboardLink: document.querySelector("#logsStoryboardLink"),
  logsFailureSummary: document.querySelector("#logsFailureSummary"),
  logsPageInfo: document.querySelector("#logsPageInfo"),
  logsFirstPageButton: document.querySelector("#logsFirstPageButton"),
  logsPrevPageButton: document.querySelector("#logsPrevPageButton"),
  logsNextPageButton: document.querySelector("#logsNextPageButton"),
  logsLastPageButton: document.querySelector("#logsLastPageButton"),
  logsJobLog: document.querySelector("#logsJobLog"),
  videosList: document.querySelector("#videosList"),
  videoEmpty: document.querySelector("#videoEmpty"),
  videoDetails: document.querySelector("#videoDetails"),
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
  videoSourceJobInfo: document.querySelector("#videoSourceJobInfo"),
  videoSceneLinks: document.querySelector("#videoSceneLinks"),
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
  videoSearchInput: document.querySelector("#videoSearchInput"),
  videoFilterChips: Array.from(document.querySelectorAll("[data-video-filter]")),
  videosPagination: document.querySelector("#videosPagination"),
  jobSearchInput: document.querySelector("#jobSearchInput"),
  jobFilterChips: Array.from(document.querySelectorAll("[data-job-filter]")),
  jobsPagination: document.querySelector("#jobsPagination"),
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
  const payload = await response.json().catch(() => ({})); /* expected: response may not be JSON */

  if (!response.ok) {
    throw new Error(payload.error || "Falha na requisicao.");
  }

  return payload;
};

const normalizeEditorText = (value, fallback = "", maxLength = 0) => {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n").trim();
  const safeFallback = String(fallback ?? "").replace(/\r\n/g, "\n").trim();
  const limited = normalized || safeFallback;
  return maxLength > 0 ? limited.slice(0, maxLength) : limited;
};

const cloneStoryboardDraft = (storyboard) => {
  try {
    return JSON.parse(JSON.stringify(storyboard || null));
  } catch {
    return null;
  }
};

const getPreviewStoryboardCard = (form, index) =>
  form?.querySelector(`[data-preview-scene-index="${String(index)}"]`) || null;

const readPreviewStoryboardDraftFromForm = (form, previewStoryboard = null) => {
  if (!form || !previewStoryboard) {
    return null;
  }

  const draft = cloneStoryboardDraft(previewStoryboard);

  if (!draft) {
    return null;
  }

  draft.videoTitle = normalizeEditorText(form.elements?.videoTitle?.value, draft.videoTitle, 200);
  draft.hook = normalizeEditorText(form.elements?.hook?.value, draft.hook, 280);
  draft.postCaption = normalizeEditorText(form.elements?.postCaption?.value, draft.postCaption, 5000);
  draft.styleNotes = normalizeEditorText(form.elements?.styleNotes?.value, draft.styleNotes, 2000);

  draft.scenes = Array.isArray(draft.scenes)
    ? draft.scenes.map((scene, index) => {
        const card = getPreviewStoryboardCard(form, index);
        const fieldLengths = {
          title: 160,
          narration: 2000,
          overlay: 120,
          searchQuery: 500,
          visualGoal: 2000
        };
        const readField = (field) =>
          normalizeEditorText(card?.querySelector(`[data-preview-scene-field="${field}"]`)?.value, scene?.[field], fieldLengths[field] || 500);

        return {
          ...scene,
          title: readField("title"),
          narration: readField("narration"),
          overlay: readField("overlay"),
          searchQuery: readField("searchQuery"),
          visualGoal: readField("visualGoal")
        };
      })
    : [];

  return draft;
};

const syncPreviewStoryboardDraft = () => {
  const selectedJob = getJobById(state.selectedJobId);
  if (!selectedJob?.id || !elements.previewStoryboardForm) {
    return;
  }

  const previewStoryboard = state.previewCache.get(selectedJob.id) || null;
  if (!previewStoryboard) {
    return;
  }

  const draft = readPreviewStoryboardDraftFromForm(elements.previewStoryboardForm, previewStoryboard);
  if (draft) {
    state.previewEditorDrafts.set(selectedJob.id, draft);
  }
};

const isJobActionPending = (jobId) => state.pendingJobActionIds.has(jobId);

const ACTION_PRIORITY = [
  "regenerate-missing-scene",
  "generate-audio",
  "render-only",
  "validate-only",
  "resume-rebuild",
  "retry-from-storyboard",
  "force-fail"
];

const getActionPriority = (actionKey) => {
  const index = ACTION_PRIORITY.indexOf(actionKey);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
};

const getJobActionRequest = (job, actionKey) => {
  const encodedJobId = encodeURIComponent(job.id);

  switch (actionKey) {
    case "resume-rebuild":
      return {
        url: `/api/jobs/${encodedJobId}/resume`,
        body: {jobId: job.id}
      };
    case "retry-from-storyboard":
      return {
        url: `/api/jobs/${encodedJobId}/retry-from-storyboard`,
        body: {jobId: job.id}
      };
    case "regenerate-missing-scene":
      return {
        url: `/api/jobs/${encodedJobId}/regenerate-missing-scene`,
        body: {
          jobId: job.id,
          sceneNumber: extractMissingSceneNumber(job),
          autoContinueAfterSceneRepair: true
        }
      };
    case "generate-audio":
      return {
        url: `/api/jobs/${encodedJobId}/generate-audio`,
        body: {jobId: job.id}
      };
    case "render-only":
      return {
        url: `/api/jobs/${encodedJobId}/render-only`,
        body: {jobId: job.id}
      };
    case "validate-only":
      return {
        url: `/api/jobs/${encodedJobId}/validate`,
        body: {jobId: job.id}
      };
    case "force-fail":
      return {
        url: `/api/jobs/${encodedJobId}/force-fail`,
        body: {jobId: job.id},
        connectLogs: false
      };
    default:
      return null;
  }
};

const getJobActionAvailability = (job) => {
  const safeJob = job || {};
  const status = String(safeJob.status || "").trim().toLowerCase();
  const previewOnly = Boolean(safeJob.input?.previewOnly);
  const recommendedActionValue = String(safeJob.recommendedAction?.value || "").trim();
  const missingSceneNumber = extractMissingSceneNumber(safeJob);

  const actions = {
    "resume-rebuild": {
      key: "resume-rebuild",
      label: "Retomar a partir do ponto salvo",
      available: safeJob.resumeAvailable !== false && safeJob.type === "generate" && status === "failed" && !previewOnly,
      safe: safeJob.resumeAvailable !== false && safeJob.type === "generate" && status === "failed" && !previewOnly,
      blockedReason: previewOnly
        ? "jobs de preview não podem retomar com artefatos"
        : "a retomada automática não está disponível para este job"
    },
    "retry-from-storyboard": {
      key: "retry-from-storyboard",
      label:
        recommendedActionValue === "retry-from-storyboard"
          ? safeJob.recommendedAction?.label || "Refazer a partir do storyboard"
          : "Refazer a partir do storyboard",
      available: safeJob.retryFromStoryboardAvailable === true && !previewOnly,
      safe: safeJob.retryFromStoryboardAvailable === true && !previewOnly,
      blockedReason: previewOnly
        ? "jobs de preview não podem reutilizar o storyboard"
        : "o storyboard reaproveitável não está disponível para este job"
    },
    "regenerate-missing-scene": {
      key: "regenerate-missing-scene",
      label: Number.isInteger(missingSceneNumber) ? `Regenerar cena ${missingSceneNumber}` : "Regenerar cena faltante",
      available: safeJob.sceneRegenerateAvailable === true && !previewOnly,
      safe: safeJob.sceneRegenerateAvailable === true && !previewOnly,
      blockedReason: previewOnly
        ? "jobs de preview não podem regenerar cenas"
        : "a regeneração de cena não está disponível para este job"
    },
    "generate-audio": {
      key: "generate-audio",
      label: "Gerar áudio",
      available: safeJob.audioPrepAvailable === true && !previewOnly,
      safe: safeJob.audioPrepAvailable === true && !previewOnly,
      blockedReason: previewOnly
        ? "jobs de preview não podem gerar áudio final"
        : "a preparação de áudio não está disponível para este job"
    },
    "render-only": {
      key: "render-only",
      label: "Renderizar vídeo",
      available: safeJob.renderOnlyAvailable === true && !previewOnly,
      safe: safeJob.renderOnlyAvailable === true && !previewOnly,
      blockedReason: previewOnly
        ? "jobs de preview não podem renderizar o vídeo final"
        : "a renderização isolada não está disponível para este job"
    },
    "validate-only": {
      key: "validate-only",
      label: "Validar vídeo",
      available: safeJob.validateOnlyAvailable === true && !previewOnly,
      safe: safeJob.validateOnlyAvailable === true && !previewOnly,
      blockedReason: previewOnly
        ? "jobs de preview não podem validar o MP4 final"
        : "a validação isolada não está disponível para este job"
    },
    "force-fail": {
      key: "force-fail",
      label: "Marcar como travado e liberar fila",
      available: safeJob.forceFailAvailable === true,
      safe: safeJob.forceFailAvailable === true && ["queued", "running"].includes(status),
      blockedReason: "disponível apenas para jobs queued ou running"
    }
  };

  const orderedSafeActions = Object.values(actions)
    .filter((action) => action.safe)
    .sort((left, right) => {
      if (left.key === recommendedActionValue && right.key !== recommendedActionValue) {
        return -1;
      }

      if (right.key === recommendedActionValue && left.key !== recommendedActionValue) {
        return 1;
      }

      return getActionPriority(left.key) - getActionPriority(right.key);
    });
  const recommendedAction = actions[recommendedActionValue] || null;

  return {
    actions,
    orderedSafeActions,
    primaryAction: orderedSafeActions[0] || null,
    recommendedAction,
    recommendedActionBlocked:
      Boolean(recommendedActionValue) &&
      Boolean(recommendedAction?.available) &&
      !recommendedAction.safe,
    canResume: actions["resume-rebuild"].safe,
    canRegenerateScene: actions["regenerate-missing-scene"].safe,
    canGenerateAudio: actions["generate-audio"].safe,
    canRenderOnly: actions["render-only"].safe,
    canValidateOnly: actions["validate-only"].safe,
    canRetryFromStoryboard: actions["retry-from-storyboard"].safe,
    canForceFail: actions["force-fail"].safe,
    isPending: Boolean(safeJob.id && isJobActionPending(safeJob.id))
  };
};

const setActionButtonState = (button, {
  available,
  disabled,
  title,
  label
}) => {
  if (!button) {
    return;
  }

  button.classList.toggle("hidden", !available);
  button.disabled = !available || disabled;
  button.title = available ? (title || "") : "";
  if (label) {
    button.textContent = label;
  }
};

const runJobAction = async ({
  jobId,
  url,
  body,
  connectLogs = true,
  refreshVideosList = true,
  onSuccess,
  onError
}) => {
  if (!jobId || isJobActionPending(jobId)) {
    return null;
  }

  state.pendingJobActionIds.add(jobId);
  renderAll();

  try {
    const response = await fetchJson(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body)
    });

    if (response.job) {
      upsertJob(response.job);
      state.selectedJobId = response.job.id;
      setStoredLogPage(response.job, getDefaultLogPage(response.job));
      if (connectLogs) {
        state.logAutoFollow = true;
        connectStream(response.job.id);
      }
    }

    if (typeof onSuccess === "function") {
      await onSuccess(response);
    }

    await Promise.allSettled([
      refreshJobs(),
      refreshVideosList ? refreshVideos() : Promise.resolve()
    ]);
    return response;
  } catch (error) {
    if (typeof onError === "function") {
      onError(error);
    } else {
      window.alert(error.message);
    }
    return null;
  } finally {
    state.pendingJobActionIds.delete(jobId);
    renderAll();
  }
};

const runSafeRecoveryAction = async ({job, actionKey, onSuccess, onError}) => {
  const liveJob = job?.id ? (getJobById(job.id) || job) : null;

  if (!liveJob) {
    return null;
  }

  const availability = getJobActionAvailability(liveJob);
  const action = availability.actions[actionKey] || null;

  if (!action?.safe) {
    const error = new Error(action?.blockedReason || "Ação indisponível para o estado atual do job.");

    if (typeof onError === "function") {
      onError(error);
    } else {
      window.alert(error.message);
    }

    return null;
  }

  const request = getJobActionRequest(liveJob, actionKey);

  if (!request) {
    const error = new Error("Ação de recuperação não suportada pelo cliente.");

    if (typeof onError === "function") {
      onError(error);
    } else {
      window.alert(error.message);
    }

    return null;
  }

  return runJobAction({
    jobId: liveJob.id,
    url: request.url,
    body: request.body,
    connectLogs: request.connectLogs ?? true,
    refreshVideosList: request.refreshVideosList ?? true,
    onSuccess,
    onError
  });
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
    {label: "Modo de geração", value: findOptionLabel(state.config?.generationModes || generationModeOptions, params.generationMode, params.generationMode)},
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

const syncProgressMeter = (element, percent) => {
  if (!element) {
    return;
  }

  const safePercent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0;
  element.style.width = `${safePercent}%`;
  element.dataset.progress = String(Math.round(safePercent));
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

const getGenerationModeMeta = (modeId) =>
  state.config?.generationModes?.find((item) => item.value === modeId) ||
  generationModeOptions.find((item) => item.value === modeId) ||
  null;

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

const JOB_FAILURE_STAGE_LABELS = {
  "timestamp-extraction": "Extração de timestamps",
  render: "Renderização",
  qa: "Validação QA",
  audio: "Áudio",
  pipeline: "Pipeline"
};

const normalizeText = (value) => {
  if (value == null) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeText(item)).filter(Boolean).join(" • ");
  }

  if (typeof value === "object") {
    return [
      value.summary,
      value.message,
      value.detail,
      value.details,
      value.reason,
      value.error
    ]
      .map((item) => normalizeText(item))
      .filter(Boolean)
      .join(" • ");
  }

  return String(value).trim();
};

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
  const failureCategory = normalizeText(job?.failureTaxonomy?.primaryCategory || "");
  const repairMode = normalizeText(job?.failureTaxonomy?.repairMode || "");

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

  if (failureCategory) {
    pieces.push(`<strong>Categoria</strong>: ${escapeHtml(failureCategory)}`);
  }

  if (repairMode) {
    pieces.push(`<strong>Repair</strong>: ${escapeHtml(repairMode)}`);
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

const getApiFilePathFromUrl = (url) => {
  try {
    return new URL(url, window.location.origin).searchParams.get("path") || "";
  } catch {
    return "";
  }
};

const getSceneClipUrlFromStoryboardUrl = (storyboardUrl, sceneNumber) => {
  const storyboardPath = String(getApiFilePathFromUrl(storyboardUrl) || "").replaceAll("\\", "/");
  const match = storyboardPath.match(/^(.*)\/video-engine\/runs\/([^/]+)\/storyboard\.json$/);

  if (!match) {
    return "";
  }

  const [, rootPath, slug] = match;

  if (!slug || slug.endsWith("-preview")) {
    return "";
  }

  const paddedSceneNumber = String(sceneNumber).padStart(2, "0");
  const scenePath = `${rootPath}/video-engine/assets/envato/${slug}/scene-${paddedSceneNumber}.mp4`;
  return `/api/file?path=${encodeURIComponent(scenePath)}`;
};

const getVideoSourceJobId = (video) =>
  String(video?.jobId || video?.sourceJobId || video?.originJobId || "").trim();

const focusJobInLogs = (jobId) => {
  const job = getJobById(jobId);

  if (!job) {
    return;
  }

  state.selectedJobId = job.id;
  setStoredLogPage(job, getDefaultLogPage(job));
  state.selectedVideoId = null;
  state.selectedLibraryKind = null;
  setActiveTab("logs");

  if (job.status === "queued" || job.status === "running") {
    connectStream(job.id);
  }

  renderAll();
};

const renderSceneLinkBlock = async (container, source, emptyMessage = "Nenhuma cena inspecionável disponível.") => {
  if (!container) {
    return;
  }

  const block = container.closest(".artifact-block");
  const storyboardUrl = String(source?.storyboardUrl || "").trim();
  const isPreview = Boolean(source?.input?.previewOnly);

  if (!storyboardUrl || isPreview) {
    container.innerHTML = "";
    if (block) {
      block.classList.add("hidden");
    }
    return;
  }

  if (block) {
    block.classList.remove("hidden");
  }

  const cachedStoryboard = state.storyboardCache.get(storyboardUrl) || null;
  const sceneCount = Array.isArray(cachedStoryboard?.scenes) ? cachedStoryboard.scenes.length : 0;

  if (sceneCount > 0) {
    container.innerHTML = cachedStoryboard.scenes
      .map((_, index) => {
        const sceneNumber = index + 1;
        const sceneUrl = getSceneClipUrlFromStoryboardUrl(storyboardUrl, sceneNumber);

        if (!sceneUrl) {
          return "";
        }

        const paddedSceneNumber = String(sceneNumber).padStart(2, "0");
        return `<a class="text-link" href="${escapeHtml(sceneUrl)}" target="_blank" rel="noreferrer">Cena ${paddedSceneNumber}</a>`;
      })
      .filter(Boolean)
      .join("");

    if (!container.innerHTML) {
      container.innerHTML = `<span class="field-hint">${escapeHtml(emptyMessage)}</span>`;
    }

    return;
  }

  if (state.loadingStoryboardUrls.has(storyboardUrl)) {
    container.innerHTML = '<span class="field-hint">Carregando cenas...</span>';
    return;
  }

  if (state.storyboardCache.has(storyboardUrl)) {
    container.innerHTML = `<span class="field-hint">${escapeHtml(emptyMessage)}</span>`;
    return;
  }

  container.innerHTML = '<span class="field-hint">Carregando cenas...</span>';
  state.loadingStoryboardUrls.add(storyboardUrl);

  try {
    const storyboard = await fetchJson(storyboardUrl);
    state.storyboardCache.set(storyboardUrl, storyboard || null);
  } catch {
    state.storyboardCache.set(storyboardUrl, null);
  } finally {
    state.loadingStoryboardUrls.delete(storyboardUrl);
    renderAll();
  }
};

const renderSourceJobInfo = (container, video) => {
  if (!container) {
    return;
  }

  const block = container.closest(".artifact-block");
  const sourceJobId = getVideoSourceJobId(video);

  if (!sourceJobId) {
    container.innerHTML = "";
    if (block) {
      block.classList.add("hidden");
    }
    return;
  }

  if (block) {
    block.classList.remove("hidden");
  }

  const sourceJob = getJobById(sourceJobId);
  const label = sourceJob?.title || sourceJob?.slug || sourceJobId;
  container.innerHTML = sourceJob
    ? `<a class="text-link" href="#" data-jump-job-id="${escapeHtml(sourceJob.id)}">Abrir job de origem</a><span class="field-hint">${escapeHtml(label)}</span>`
    : `<span class="field-hint">Job de origem: ${escapeHtml(sourceJobId)}</span>`;

  container.querySelectorAll("[data-jump-job-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      focusJobInLogs(button.dataset.jumpJobId || sourceJobId);
    });
  });
};

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

const syncGenerationModeUi = () => {
  const generationModeSelect = document.querySelector("#generateGenerationMode");
  const imageStyleSelect = document.querySelector("#generateImageStyle");
  const generationMode = generationModeSelect?.value || generationModeOptions[0].value;
  const selectedMode = getGenerationModeMeta(generationMode);
  const selectedStyle = getImageStyleMeta(imageStyleSelect?.value);
  const isTextToVideo = generationMode === "text-to-video";

  if (elements.generationModeHint) {
    elements.generationModeHint.textContent = selectedMode?.description || "";
  }

  if (elements.imageStyleLabel) {
    elements.imageStyleLabel.textContent = isTextToVideo ? "Direção visual" : "Estilo de imagem";
  }

  if (elements.imageStyleHint) {
    const hintParts = [selectedStyle?.description].filter(Boolean);
    if (isTextToVideo) {
      hintParts.push("Usado como direção visual para a geração direta do vídeo.");
    }
    elements.imageStyleHint.textContent = hintParts.join(" ");
  }

  syncImageStylePreview(imageStyleSelect?.value || "");
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

const isLiveJob = (job) => Boolean(job && (job.status === "queued" || job.status === "running"));

const getJobLogLines = (job) => Array.isArray(job?.logTail) ? job.logTail : [];

const getLogPageCount = (jobOrLines) => {
  const lines = Array.isArray(jobOrLines) ? jobOrLines : getJobLogLines(jobOrLines);
  return Math.max(1, Math.ceil(lines.length / LOG_PAGE_SIZE));
};

const getDefaultLogPage = (job) => {
  if (!job) {
    return 1;
  }

  return isLiveJob(job) ? getLogPageCount(job) : 1;
};

const getStoredLogPage = (job) => {
  if (!job?.id) {
    return 1;
  }

  const pageCount = getLogPageCount(job);
  const storedPage = Number(state.logPageByJobId.get(job.id));

  if (Number.isInteger(storedPage) && storedPage >= 1) {
    return Math.min(storedPage, pageCount);
  }

  return getDefaultLogPage(job);
};

const setStoredLogPage = (job, page) => {
  if (!job?.id) {
    return 1;
  }

  const pageCount = getLogPageCount(job);
  const normalizedPage = Math.max(1, Math.min(pageCount, Number(page) || 1));
  state.logPageByJobId.set(job.id, normalizedPage);
  state.logAutoFollow = isLiveJob(job) && normalizedPage === pageCount;
  return normalizedPage;
};

const getPaginatedLogView = (job) => {
  const lines = getJobLogLines(job);
  const pageCount = getLogPageCount(lines);
  let page = getStoredLogPage(job);

  if (state.logAutoFollow && isLiveJob(job)) {
    page = pageCount;
    state.logPageByJobId.set(job.id, page);
  }

  const startIndex = (page - 1) * LOG_PAGE_SIZE;
  const endIndex = Math.min(lines.length, startIndex + LOG_PAGE_SIZE);

  return {
    lines: lines.slice(startIndex, endIndex),
    totalLines: lines.length,
    page,
    pageCount,
    startLineNumber: lines.length > 0 ? startIndex + 1 : 0,
    endLineNumber: endIndex
  };
};

const isLogPinnedToBottom = (log = elements.logsJobLog) => {

  if (!log) {
    return true;
  }

  return log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
};

const syncLogAutoFollow = () => {
  const job = getJobById(state.selectedJobId);

  if (!job) {
    state.logAutoFollow = true;
    return;
  }

  const currentPage = getStoredLogPage(job);
  state.logAutoFollow = currentPage === getLogPageCount(job) && isLogPinnedToBottom(elements.logsJobLog);
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
      await Promise.allSettled([refreshJobs(), refreshVideos()]);
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

const syncSelectedJobFromLibrarySelection = () => {
  if (getJobById(state.selectedJobId)) {
    return;
  }

  state.selectedJobId = state.activeJobId || state.jobs[0]?.id || null;
};

const setActiveTab = (tabName) => {
  state.activeTab = tabName;

  if (tabName === "logs" || tabName === "workspace") {
    syncSelectedJobFromLibrarySelection();
  }

  if (tabName === "logs") {
    const selectedJob = getJobById(state.selectedJobId);
    state.logAutoFollow = Boolean(selectedJob && isLiveJob(selectedJob) && getStoredLogPage(selectedJob) === getLogPageCount(selectedJob));
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

const buildPreviewSummaryHtml = (storyboard = {}) => `
  <div class="preview-card preview-card-editor">
    <div class="preview-card-head">
      <p class="preview-kicker">Storyboard editável</p>
      <p class="field-hint">Aprovar vai reaproveitar este storyboard editado no job pesado.</p>
    </div>
    <label class="preview-field">
      <span>Título do vídeo</span>
      <input type="text" name="videoTitle" maxlength="200" value="${escapeHtml(storyboard.videoTitle || "")}" />
    </label>
    <label class="preview-field">
      <span>Hook</span>
      <textarea name="hook" rows="3" maxlength="280">${escapeHtml(storyboard.hook || "")}</textarea>
    </label>
    <label class="preview-field">
      <span>Legenda / postCaption</span>
      <textarea name="postCaption" rows="4" maxlength="5000">${escapeHtml(storyboard.postCaption || "")}</textarea>
    </label>
    <label class="preview-field">
      <span>Style notes</span>
      <textarea name="styleNotes" rows="3" maxlength="2000">${escapeHtml(storyboard.styleNotes || "")}</textarea>
    </label>
  </div>
`;

const buildPreviewSceneEditorHtml = (scene = {}, index = 0) => {
  const queryList = Array.isArray(scene.candidateQueries) && scene.candidateQueries.length > 0
    ? scene.candidateQueries.slice(0, 3).map((query) => `<li>${escapeHtml(query)}</li>`).join("")
    : `<li>${escapeHtml(scene.searchQuery || "")}</li>`;

  return `
    <article class="scene-card scene-card-editor" data-preview-scene-index="${escapeHtml(index)}">
      <div class="scene-card-head">
        <p class="scene-index">Cena ${String(index + 1).padStart(2, "0")}</p>
        <h5>${escapeHtml(scene.title || `Cena ${index + 1}`)}</h5>
      </div>
      <div class="preview-scene-grid">
        <label class="preview-field">
          <span>Título da cena</span>
          <input type="text" data-preview-scene-field="title" maxlength="160" value="${escapeHtml(scene.title || "")}" />
        </label>
        <label class="preview-field">
          <span>Overlay</span>
          <input type="text" data-preview-scene-field="overlay" maxlength="120" value="${escapeHtml(scene.overlay || "")}" />
        </label>
      </div>
      <label class="preview-field">
        <span>Narração</span>
        <textarea data-preview-scene-field="narration" rows="3" maxlength="2000">${escapeHtml(scene.narration || "")}</textarea>
      </label>
      <label class="preview-field">
        <span>Search query</span>
        <textarea data-preview-scene-field="searchQuery" rows="2" maxlength="500">${escapeHtml(scene.searchQuery || "")}</textarea>
      </label>
      <label class="preview-field">
        <span>Visual goal</span>
        <textarea data-preview-scene-field="visualGoal" rows="4" maxlength="2000">${escapeHtml(scene.visualGoal || "")}</textarea>
      </label>
      <div class="scene-query-block">
        <p class="field-hint">Queries atuais</p>
        <ul class="scene-query-list">${queryList}</ul>
      </div>
    </article>
  `;
};

const buildPreviewScenesHtml = (storyboard = {}) => {
  const scenes = Array.isArray(storyboard.scenes) ? storyboard.scenes : [];
  if (scenes.length === 0) {
    return '<div class="history-item muted">Nenhuma cena disponível no storyboard.</div>';
  }

  return scenes.map((scene, index) => buildPreviewSceneEditorHtml(scene, index)).join("");
};

const renderPreviewData = (previewData) => {
  if (!previewData) {
    elements.previewSummary.classList.add("hidden");
    elements.previewScenes.innerHTML = "";
    return;
  }

  const selectedJob = getJobById(state.selectedJobId);
  const generationMode = getGenerationModeMeta(selectedJob?.input?.generationMode);
  const imageStyle = getImageStyleMeta(selectedJob?.input?.imageStyle);
  const outputProfile = getOutputProfileMeta(selectedJob?.input?.outputProfile);
  const storyboard = state.previewEditorDrafts.get(selectedJob?.id) || previewData;

  elements.previewSummary.classList.remove("hidden");
  elements.previewSummary.innerHTML = `
    ${buildPreviewSummaryHtml(storyboard)}
    ${
      outputProfile
        ? `<div class="preview-style"><strong>${escapeHtml(outputProfile.label)}</strong><br>${escapeHtml(outputProfile.description || "")}<br>${escapeHtml(outputProfile.aspectRatio || "")} • ${escapeHtml(`${outputProfile.width}x${outputProfile.height}`)}</div>`
        : ""
    }
    ${
      generationMode
        ? `<div class="preview-style"><strong>${escapeHtml(generationMode.label)}</strong><br>${escapeHtml(generationMode.description || "")}</div>`
        : ""
    }
    ${
      imageStyle
        ? `<div class="preview-style"><strong>${escapeHtml(imageStyle.label)}</strong><br>${escapeHtml(imageStyle.description || "")}</div>`
        : ""
    }
  `;

  elements.previewScenes.innerHTML = buildPreviewScenesHtml(storyboard);
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

  elements.jobType.textContent = getJobTypeLabel(job);
  elements.jobTitle.textContent = job.title;
  elements.jobStatus.textContent = job.status;
  elements.jobStatus.dataset.state = job.status;
  elements.jobMeta.textContent = getJobMetaLine(job);
  if (elements.jobProgressMeta || elements.jobProgressFill) {
    const progress = getJobProgressInfo(job);
    if (elements.jobProgressMeta) {
      elements.jobProgressMeta.textContent = progress.text || "";
    }
    syncProgressMeter(elements.jobProgressFill, progress.percent);
  }

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

  void renderSceneLinkBlock(elements.jobSceneLinks, job);

  const failureLabel = getJobFailureLabel(job);
  if (failureLabel) {
    elements.jobFailureSummary.innerHTML = getJobFailureDetailsHtml(job) || escapeHtml(failureLabel);
    elements.jobFailureSummary.classList.remove("hidden");
  } else {
    elements.jobFailureSummary.textContent = "";
    elements.jobFailureSummary.classList.add("hidden");
  }

  if (elements.jobStepChecklist) {
    const steps = Array.isArray(job.stepChecklist) ? job.stepChecklist : [];
    elements.jobStepChecklist.innerHTML = steps.length > 0
      ? steps.map((step, i) => {
          const status = step.status || 'missing';
          const dotClass = status === 'completed' ? 'done' : status === 'ready' ? 'active' : status === 'partial' ? 'active' : '';
          const icon = status === 'completed' ? '&#10003;' : status === 'ready' || status === 'partial' ? '&#9679;' : '';
          return `
            <div class="stepper-step" data-step-status="${escapeHtml(status)}">
              ${i > 0 ? '<div class="stepper-connector"></div>' : ''}
              <div class="stepper-dot ${dotClass}">${icon}</div>
              <span class="stepper-label">${escapeHtml(step.label || step.key || 'Etapa')}</span>
              ${step.detail ? `<span class="stepper-detail">${escapeHtml(step.detail)}</span>` : ''}
            </div>
          `;
        }).join('')
      : '<div class="history-item muted">Sem checklist dispon\u00edvel para este job.</div>';
  }

  const actionAvailability = getJobActionAvailability(job);
  const {
    canResume,
    canRegenerateScene,
    canGenerateAudio,
    canRenderOnly,
    canValidateOnly,
    canRetryFromStoryboard,
    canForceFail,
    isPending,
    primaryAction,
    recommendedAction,
    recommendedActionBlocked,
    orderedSafeActions
  } = actionAvailability;

  if (elements.jobRecommendedLabel) {
    elements.jobRecommendedLabel.textContent =
      job.recommendedAction?.label ||
      recommendedAction?.label ||
      primaryAction?.label ||
      "Acompanhar execução";
  }
  if (elements.jobRecommendedDetails) {
    const safeActionSummary = orderedSafeActions.map((action) => action.label).join(" • ");
    elements.jobRecommendedDetails.textContent = recommendedActionBlocked
      ? `A UI bloqueou a ação recomendada porque ${recommendedAction?.blockedReason}. ${safeActionSummary ? `Ações seguras agora: ${safeActionSummary}.` : "Nenhuma recuperação automática foi liberada até o checklist ficar consistente."}`
      : !recommendedAction && primaryAction
        ? `${job.recommendedAction?.details || "O backend não expôs uma ação automática segura diretamente."} Ação automática liberada pela UI: ${primaryAction.label}.`
      : job.recommendedAction?.details || "A próxima ação é calculada a partir dos artefatos reais do run.";
  }

  setActionButtonState(elements.resumeJobButton, {
    available: canResume,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["resume-rebuild"].label
  });
  setActionButtonState(elements.retryFromStoryboardJobButton, {
    available: canRetryFromStoryboard,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["retry-from-storyboard"].label
  });
  setActionButtonState(elements.regenerateSceneButton, {
    available: canRegenerateScene,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["regenerate-missing-scene"].label
  });
  setActionButtonState(elements.generateAudioButton, {
    available: canGenerateAudio,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["generate-audio"].label
  });
  setActionButtonState(elements.renderOnlyButton, {
    available: canRenderOnly,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["render-only"].label
  });
  setActionButtonState(elements.validateJobButton, {
    available: canValidateOnly,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["validate-only"].label
  });
  setActionButtonState(elements.forceFailJobButton, {
    available: canForceFail,
    disabled: isPending,
    title: isPending ? "Ação em andamento para este job." : "",
    label: actionAvailability.actions["force-fail"].label
  });

  elements.jobActions.classList.toggle(
    "hidden",
    ![canResume, canRetryFromStoryboard, canRegenerateScene, canGenerateAudio, canRenderOnly, canValidateOnly, canForceFail].some(Boolean)
  );

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
    loadPreviewData(job).catch(() => {}); /* best-effort: preview data may not be ready */
  }
};

const renderLogsJobsList = () => {
  if (!elements.logsJobsList) return;
  const filtered = getFilteredJobs();
  const pageCount = Math.max(1, Math.ceil(filtered.length / JOBS_PER_PAGE));
  state.jobPage = Math.min(state.jobPage, pageCount);
  const start = (state.jobPage - 1) * JOBS_PER_PAGE;
  const slice = filtered.slice(start, start + JOBS_PER_PAGE);

  if (slice.length === 0) {
    elements.logsJobsList.innerHTML = '<div class="history-item muted">Nenhum job encontrado.</div>';
  } else {
    elements.logsJobsList.innerHTML = slice.map(job => {
      const activeClass = job.id === state.selectedJobId ? ' active' : '';
      const stageLabel = getJobStageLabel(job);
      return `
        <button class="history-item video-item${activeClass}" data-logs-job-id="${escapeHtml(job.id)}">
          <span class="history-title">${escapeHtml(job.title || job.slug || job.id)}</span>
          <span class="history-meta">${escapeHtml(job.status || '')} &bull; ${escapeHtml(stageLabel)} &bull; ${escapeHtml(formatDateTime(job.createdAt))}</span>
        </button>
      `;
    }).join('');
  }

  elements.logsJobsList.querySelectorAll('[data-logs-job-id]').forEach(button => {
    button.addEventListener('click', () => {
      state.selectedJobId = button.dataset.logsJobId;
      const job = getJobById(state.selectedJobId);
      if (job) setStoredLogPage(job, getDefaultLogPage(job));
      if (job && isLiveJob(job)) connectStream(job.id);
      renderAll();
    });
  });

  renderPaginationBar(elements.jobsPagination, state.jobPage, pageCount, (p) => {
    state.jobPage = p;
    renderLogsJobsList();
    renderLogsPanel();
  });

  // Sync filter chips
  elements.jobFilterChips.forEach(chip => {
    chip.classList.toggle('active', chip.dataset.jobFilter === state.jobFilter);
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
    if (elements.logsPageInfo) {
      elements.logsPageInfo.textContent = "Selecione um job para abrir o log.";
    }
    [elements.logsFirstPageButton, elements.logsPrevPageButton, elements.logsNextPageButton, elements.logsLastPageButton].forEach((button) => {
      if (button) {
        button.disabled = true;
      }
    });
    return;
  }

  elements.logsEmpty.classList.add("hidden");
  elements.logsDetails.classList.remove("hidden");
  elements.logsTitle.textContent = job.title || job.slug || "Job";
  elements.logsMeta.textContent = getJobMetaLine(job);
  if (elements.logsProgressMeta || elements.logsProgressFill) {
    const progress = getJobProgressInfo(job);
    if (elements.logsProgressMeta) {
      elements.logsProgressMeta.textContent = progress.text || "";
    }
    syncProgressMeter(elements.logsProgressFill, progress.percent);
  }
  elements.logsStatus.textContent = job.status;
  elements.logsStatus.dataset.state = job.status;
  const logView = getPaginatedLogView(job);
  const shouldFollowLog = state.logAutoFollow && logView.page === logView.pageCount;
  elements.logsJobLog.textContent = logView.lines.length > 0 ? logView.lines.join("\n") : "Sem linhas de log ainda.";
  maybeFollowLog(elements.logsJobLog, shouldFollowLog);

  if (elements.logsPageInfo) {
    const liveSuffix = shouldFollowLog && isLiveJob(job) ? " • seguindo ao vivo" : "";
    elements.logsPageInfo.textContent = logView.totalLines > 0
      ? `Linhas ${logView.startLineNumber}-${logView.endLineNumber} de ${logView.totalLines} • página ${logView.page}/${logView.pageCount}${liveSuffix}`
      : "Sem logs ainda.";
  }

  if (elements.logsFirstPageButton) {
    elements.logsFirstPageButton.disabled = logView.page <= 1;
  }

  if (elements.logsPrevPageButton) {
    elements.logsPrevPageButton.disabled = logView.page <= 1;
  }

  if (elements.logsNextPageButton) {
    elements.logsNextPageButton.disabled = logView.page >= logView.pageCount;
  }

  if (elements.logsLastPageButton) {
    elements.logsLastPageButton.disabled = logView.page >= logView.pageCount;
  }

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

const changeSelectedLogPage = (targetPage) => {
  const job = getJobById(state.selectedJobId);

  if (!job) {
    return;
  }

  setStoredLogPage(job, targetPage);
  renderLogsPanel();
};

const getVideoPublishState = (video) => {
  if (video.publishedAt) return 'published';
  if (video.scheduleAt) return 'scheduled';
  return 'local';
};

const getFilteredVideos = () => {
  let filtered = state.videos;
  if (state.videoFilter !== 'all') filtered = filtered.filter(v => getVideoPublishState(v) === state.videoFilter);
  if (state.videoSearch) {
    const q = state.videoSearch.toLowerCase();
    filtered = filtered.filter(v => (v.title || v.name || v.slug || '').toLowerCase().includes(q));
  }
  return filtered;
};

const getFilteredJobs = () => {
  let filtered = state.jobs;
  if (state.jobFilter !== 'all') filtered = filtered.filter(j => j.status === state.jobFilter);
  if (state.jobSearch) {
    const q = state.jobSearch.toLowerCase();
    filtered = filtered.filter(j => (j.title || j.slug || '').toLowerCase().includes(q));
  }
  return filtered;
};

const renderPaginationBar = (container, currentPage, pageCount, onPageChange) => {
  if (!container) return;
  if (pageCount <= 1) { container.innerHTML = ''; return; }
  const buttons = [];
  buttons.push(`<button class="pagination-btn" ${currentPage <= 1 ? 'disabled' : ''} data-page="${currentPage - 1}">&laquo;</button>`);
  const start = Math.max(1, currentPage - 2);
  const end = Math.min(pageCount, currentPage + 2);
  for (let i = start; i <= end; i++) {
    buttons.push(`<button class="pagination-btn${i === currentPage ? ' active' : ''}" data-page="${i}">${i}</button>`);
  }
  buttons.push(`<button class="pagination-btn" ${currentPage >= pageCount ? 'disabled' : ''} data-page="${currentPage + 1}">&raquo;</button>`);
  container.innerHTML = buttons.join('');
  container.querySelectorAll('[data-page]').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = Number(btn.dataset.page);
      if (p >= 1 && p <= pageCount) onPageChange(p);
    });
  });
};

const renderVideos = () => {
  if (!elements.videosList) return;
  const filtered = getFilteredVideos();
  const pageCount = Math.max(1, Math.ceil(filtered.length / VIDEOS_PER_PAGE));
  state.videoPage = Math.min(state.videoPage, pageCount);
  const start = (state.videoPage - 1) * VIDEOS_PER_PAGE;
  const slice = filtered.slice(start, start + VIDEOS_PER_PAGE);

  if (slice.length === 0) {
    elements.videosList.innerHTML = '<div class="empty-state">Nenhum v\u00eddeo encontrado.</div>';
  } else {
    elements.videosList.innerHTML = slice.map(video => {
      const activeClass = state.selectedLibraryKind === 'video' && video.id === state.selectedVideoId ? ' active' : '';
      const publishState = getVideoPublishState(video);
      const publishLabel = video.publishedAt ? 'publicado' : video.scheduleAt ? 'agendado' : 'local';
      const artworkUrl = getVideoArtworkUrl(video);
      const thumbHtml = artworkUrl
        ? `<img src="${escapeHtml(artworkUrl)}" alt="${escapeHtml(video.title || video.name)}" loading="lazy">`
        : `<div class="video-card-placeholder">&#9654;</div>`;
      return `
        <article class="video-card${activeClass}" data-video-id="${escapeHtml(video.id)}">
          <div class="video-card-thumb">
            ${thumbHtml}
            ${video.durationSeconds ? `<span class="video-card-duration">${escapeHtml(String(video.durationSeconds))}s</span>` : ''}
          </div>
          <div class="video-card-body">
            <h4 class="video-card-title">${escapeHtml(video.title || video.name)}</h4>
            <p class="video-card-meta">${escapeHtml(video.channelHandle || video.channel || '')} &bull; ${escapeHtml(formatDateTime(video.updatedAt))}</p>
            <span class="status-pill" data-state="${escapeHtml(publishState)}">${escapeHtml(publishLabel)}</span>
          </div>
        </article>
      `;
    }).join('');
  }

  elements.videosList.querySelectorAll('[data-video-id]').forEach(card => {
    card.addEventListener('click', () => {
      state.selectedVideoId = card.dataset.videoId;
      state.selectedLibraryKind = 'video';
      renderAll();
    });
  });

  renderPaginationBar(elements.videosPagination, state.videoPage, pageCount, (p) => {
    state.videoPage = p;
    renderVideos();
    renderSelectedLibraryItem();
  });

  // Sync filter chips
  elements.videoFilterChips.forEach(chip => {
    chip.classList.toggle('active', chip.dataset.videoFilter === state.videoFilter);
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

  renderSourceJobInfo(elements.videoSourceJobInfo, video);
  void renderSceneLinkBlock(elements.videoSceneLinks, video);

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

const renderSelectedLibraryItem = () => {
  const hasVideo = state.selectedLibraryKind === "video" && getVideoById(state.selectedVideoId);

  elements.videoEmpty.classList.toggle("hidden", Boolean(hasVideo));
  renderSelectedVideo();
};

const renderAll = () => {
  elements.queueCount.textContent = String(state.queueLength);
  elements.previewQueueCount.textContent = String(state.previewQueueLength);
  elements.heavyQueueCount.textContent = String(state.heavyQueueLength);
  renderSelectedJob();
  renderLogsJobsList();
  renderLogsPanel();
  renderVideos();
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

  syncSelectedJobFromLibrarySelection();

  const selectedJob = getJobById(state.selectedJobId);

  if (selectedJob && (selectedJob.status === "queued" || selectedJob.status === "running")) {
    connectStream(selectedJob.id);
  }

  renderAll();
};

const refreshVideos = async () => {
  const payload = await fetchJson("/api/videos");
  state.videos = payload.videos || [];
  state.agendador = payload.agendador || null;

  if (!state.selectedLibraryKind && state.videos[0]) {
    state.selectedLibraryKind = "video";
  }

  if (!state.selectedVideoId && state.videos[0]) {
    state.selectedVideoId = state.videos[0].id;
  } else if (state.selectedVideoId && !getVideoById(state.selectedVideoId)) {
    state.selectedVideoId = state.videos[0]?.id || null;
  }

  syncSelectedJobFromLibrarySelection();

  renderVideos();
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
  const generationModeSelect = document.querySelector("#generateGenerationMode");
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

  if (generationModeSelect && preset.generationMode) {
    generationModeSelect.value = preset.generationMode;
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
  fillSelect(
    document.querySelector("#generateGenerationMode"),
    payload.generationModes || generationModeOptions,
    payload.defaults.generationMode || generationModeOptions[0].value
  );
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
    syncGenerationModeUi();
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
  document.querySelector("#generateGenerationMode")?.addEventListener("change", syncImageStyleHint);
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
    generationMode: String(data.get("generationMode") || state.config?.defaults?.generationMode || generationModeOptions[0].value),
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
    setStoredLogPage(response.job, getDefaultLogPage(response.job));
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
    syncPreviewStoryboardDraft();
    const previewStoryboard = state.previewEditorDrafts.get(selectedJob.id) || state.previewCache.get(selectedJob.id) || null;
    const response = await fetchJson("/api/approve-preview", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        jobId: selectedJob.id,
        storyboard: previewStoryboard
      })
    });

    upsertJob(response.job);
    state.selectedJobId = response.job.id;
    setStoredLogPage(response.job, getDefaultLogPage(response.job));
    state.logAutoFollow = true;
    connectStream(response.job.id);
    await refreshJobs();
  } catch (error) {
    window.alert(error.message);
  }
});

elements.previewStoryboardForm?.addEventListener("input", () => {
  syncPreviewStoryboardDraft();
});

elements.resumeJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "resume-rebuild"
  });
});

elements.retryFromStoryboardJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "retry-from-storyboard"
  });
});

elements.forceFailJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "force-fail"
  });
});

elements.regenerateSceneButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "regenerate-missing-scene"
  });
});

elements.generateAudioButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "generate-audio"
  });
});

elements.renderOnlyButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "render-only"
  });
});

elements.validateJobButton?.addEventListener("click", async () => {
  const selectedJob = getJobById(state.selectedJobId);

  if (!selectedJob) {
    return;
  }

  await runSafeRecoveryAction({
    job: selectedJob,
    actionKey: "validate-only"
  });
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
    setStoredLogPage(response.job, getDefaultLogPage(response.job));
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
    await Promise.allSettled([refreshVideos()]);
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

  const helperWindow = window.open("", "_blank");

  if (helperWindow && helperWindow.document) {
    helperWindow.document.title = "Abrindo TikTok Helper...";
    helperWindow.document.body.innerHTML = "<p style='font-family:sans-serif;padding:16px'>Abrindo TikTok Helper...</p>";
  }

  try {
    const response = await fetchJson("/api/videos/tiktok-helper", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });

    if (response.helperUrl) {
      if (helperWindow) {
        helperWindow.location.replace(response.helperUrl);
      } else {
        window.open(response.helperUrl, "_blank", "noopener,noreferrer");
      }
    } else if (helperWindow) {
      helperWindow.close();
    }

    setVideoActionHint(response.message || "Helper do TikTok aberto.");
  } catch (error) {
    if (helperWindow) {
      helperWindow.close();
    }
    setVideoActionHint(error.message, {error: true});
  }
});

elements.tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setActiveTab(button.dataset.tabTarget);
  });
});

elements.logsFirstPageButton?.addEventListener("click", () => {
  changeSelectedLogPage(1);
});

elements.logsPrevPageButton?.addEventListener("click", () => {
  const job = getJobById(state.selectedJobId);
  if (!job) {
    return;
  }

  changeSelectedLogPage(getStoredLogPage(job) - 1);
});

elements.logsNextPageButton?.addEventListener("click", () => {
  const job = getJobById(state.selectedJobId);
  if (!job) {
    return;
  }

  changeSelectedLogPage(getStoredLogPage(job) + 1);
});

elements.logsLastPageButton?.addEventListener("click", () => {
  const job = getJobById(state.selectedJobId);
  if (!job) {
    return;
  }

  changeSelectedLogPage(getLogPageCount(job));
});

// Video search & filter
elements.videoSearchInput?.addEventListener('input', (e) => {
  state.videoSearch = e.target.value;
  state.videoPage = 1;
  renderVideos();
  renderSelectedLibraryItem();
});

elements.videoFilterChips.forEach(chip => {
  chip.addEventListener('click', () => {
    state.videoFilter = chip.dataset.videoFilter || 'all';
    state.videoPage = 1;
    renderVideos();
    renderSelectedLibraryItem();
  });
});

// Job search & filter
elements.jobSearchInput?.addEventListener('input', (e) => {
  state.jobSearch = e.target.value;
  state.jobPage = 1;
  renderLogsJobsList();
  renderLogsPanel();
});

elements.jobFilterChips.forEach(chip => {
  chip.addEventListener('click', () => {
    state.jobFilter = chip.dataset.jobFilter || 'all';
    state.jobPage = 1;
    renderLogsJobsList();
    renderLogsPanel();
  });
});

await loadConfig();
await Promise.allSettled([refreshJobs(), refreshVideos()]);
setActiveTab(state.activeTab);

if (elements.logsJobLog) {
  elements.logsJobLog.addEventListener("scroll", syncLogAutoFollow);
}

setInterval(() => {
  refreshJobs().catch(() => {}); /* polling: next interval will retry */
  refreshVideos().catch(() => {}); /* polling: next interval will retry */
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

  refreshJobs().catch(() => {}); /* polling: next interval will retry */
}, ACTIVE_JOB_REFRESH_INTERVAL_MS);
