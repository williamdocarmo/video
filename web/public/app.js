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
  previewCache: new Map(),
  loadingPreviewIds: new Set()
};

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
  assetModeHint: document.querySelector("#assetModeHint"),
  imageStyleHint: document.querySelector("#imageStyleHint"),
  toneHint: document.querySelector("#toneHint"),
  channelHint: document.querySelector("#channelHint"),
  queueCount: document.querySelector("#queueCount"),
  previewQueueCount: document.querySelector("#previewQueueCount"),
  heavyQueueCount: document.querySelector("#heavyQueueCount"),
  jobEmpty: document.querySelector("#jobEmpty"),
  jobDetails: document.querySelector("#jobDetails"),
  jobType: document.querySelector("#jobType"),
  jobTitle: document.querySelector("#jobTitle"),
  jobMeta: document.querySelector("#jobMeta"),
  jobStatus: document.querySelector("#jobStatus"),
  jobLog: document.querySelector("#jobLog"),
  jobOutputLink: document.querySelector("#jobOutputLink"),
  jobStoryboardLink: document.querySelector("#jobStoryboardLink"),
  jobFailureSummary: document.querySelector("#jobFailureSummary"),
  jobActions: document.querySelector("#jobActions"),
  resumeJobButton: document.querySelector("#resumeJobButton"),
  previewPanel: document.querySelector("#previewPanel"),
  previewSummary: document.querySelector("#previewSummary"),
  previewScenes: document.querySelector("#previewScenes"),
  approvePreviewButton: document.querySelector("#approvePreviewButton"),
  jobsList: document.querySelector("#jobsList"),
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
  videoPlayer: document.querySelector("#videoPlayer"),
  videoOpenLink: document.querySelector("#videoOpenLink"),
  videoStoryboardLink: document.querySelector("#videoStoryboardLink"),
  videoMetaForm: document.querySelector("#videoMetaForm"),
  saveVideoMetaButton: document.querySelector("#saveVideoMetaButton"),
  redoVideoButton: document.querySelector("#redoVideoButton"),
  publishVideoButton: document.querySelector("#publishVideoButton"),
  deleteVideoButton: document.querySelector("#deleteVideoButton"),
  videoLibraryHint: document.querySelector("#videoLibraryHint"),
  videoActionHint: document.querySelector("#videoActionHint"),
  failedJobChannel: document.querySelector("#failedJobChannel"),
  failedJobTitle: document.querySelector("#failedJobTitle"),
  failedJobMeta: document.querySelector("#failedJobMeta"),
  failedJobStatus: document.querySelector("#failedJobStatus"),
  failedJobError: document.querySelector("#failedJobError"),
  failedJobStoryboardLink: document.querySelector("#failedJobStoryboardLink"),
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

const getAssetModeMeta = (assetMode) =>
  state.config?.assetModes?.find((item) => item.value === assetMode) || null;

const getChannelMeta = (channelId) =>
  state.config?.channels?.find((item) => item.value === channelId) || null;

const getToneMeta = (toneId) =>
  state.config?.tones?.find((item) => item.value === toneId) || null;

const getChannelPreset = (channelId) => state.config?.channelPresets?.[channelId] || null;

const getOutputProfileMeta = (profileId) =>
  state.config?.outputProfiles?.find((item) => item.value === profileId) || null;

const getJobById = (jobId) => state.jobs.find((job) => job.id === jobId) || null;
const getVideoById = (videoId) => state.videos.find((video) => video.id === videoId) || null;
const getFailedJobById = (jobId) => state.failedJobs.find((job) => job.id === jobId) || null;

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

const getJobFailureLabel = (job) => {
  if (!job || job.status !== "failed") {
    return "";
  }

  const stage = job.failureStage ? `etapa ${job.failureStage}` : "falha";
  const summary = job.failureSummary || job.error || "sem detalhe";
  return `${stage}: ${summary}`;
};

const isLogPinnedToBottom = () => {
  const log = elements.jobLog;

  if (!log) {
    return true;
  }

  return log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
};

const syncLogAutoFollow = () => {
  state.logAutoFollow = isLogPinnedToBottom();
};

const maybeFollowLog = (shouldFollow) => {
  if (!shouldFollow || !elements.jobLog) {
    return;
  }

  requestAnimationFrame(() => {
    elements.jobLog.scrollTop = elements.jobLog.scrollHeight;
  });
};

const upsertJob = (job) => {
  const index = state.jobs.findIndex((item) => item.id === job.id);

  if (index === -1) {
    state.jobs.unshift(job);
  } else {
    state.jobs[index] = job;
  }

  state.jobs.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
};

const closeStream = () => {
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
  };
};

const setActiveTab = (tabName) => {
  state.activeTab = tabName;

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

  const shouldFollowLog = state.logAutoFollow || isLogPinnedToBottom();

  elements.jobType.textContent = job.type === "rerender" ? "rerender-voice" : job.input.previewOnly ? "preview" : "generate";
  elements.jobTitle.textContent = job.title;
  elements.jobStatus.textContent = job.status;
  elements.jobStatus.dataset.state = job.status;
  const outputProfile = getOutputProfileMeta(job.input.outputProfile);
  elements.jobMeta.textContent = [
    job.slug,
    getQueueLaneLabel(getJobQueueLane(job)),
    job.input.channelHandle || null,
    job.input.language || null,
    outputProfile ? outputProfile.label : null,
    job.input.targetSeconds ? `${job.input.targetSeconds}s` : null,
    job.queuePosition ? `${getQueueLaneLabel(getJobQueueLane(job))} ${job.queuePosition}` : null,
    job.failureStage ? `falha: ${job.failureStage}` : null
  ]
    .filter(Boolean)
    .join(" • ");
  elements.jobLog.textContent = (job.logTail || []).join("\n");
  maybeFollowLog(shouldFollowLog);

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
    elements.jobFailureSummary.textContent = failureLabel;
    elements.jobFailureSummary.classList.remove("hidden");
  } else {
    elements.jobFailureSummary.textContent = "";
    elements.jobFailureSummary.classList.add("hidden");
  }

  const canResume = job.resumeAvailable !== false && job.type === "generate" && job.status === "failed" && !job.input.previewOnly;
  elements.jobActions.classList.toggle("hidden", !canResume);
  elements.resumeJobButton.disabled = !canResume;

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

const renderJobs = () => {
  if (state.jobs.length === 0) {
    elements.jobsList.innerHTML = '<div class="history-item muted">Nenhum job criado ainda.</div>';
    return;
  }

  elements.jobsList.innerHTML = state.jobs
    .slice(0, 6)
    .map((job) => {
      const activeClass = job.id === state.selectedJobId ? " active" : "";

      return `
        <button class="history-item${activeClass}" data-job-id="${escapeHtml(job.id)}">
          <span class="history-title">${escapeHtml(job.title)}</span>
          <span class="history-meta">${escapeHtml(job.status)} • ${escapeHtml(job.failureStage || getQueueLaneLabel(getJobQueueLane(job)))} • ${escapeHtml(job.slug)}</span>
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
      return `
        <button class="history-item video-item${activeClass}" data-failed-job-id="${escapeHtml(job.id)}">
          <span class="history-title">${escapeHtml(job.title || job.slug)}</span>
          <span class="history-meta">${escapeHtml(job.channelHandle || job.channel || "")} • ${escapeHtml(job.failureStage || "pipeline")} • ${escapeHtml(job.targetSeconds ? `${job.targetSeconds}s` : "")}</span>
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
  elements.videoMetaForm.elements.channel.value = video.channel || "";
  elements.videoMetaForm.elements.title.value = video.title || "";
  elements.videoMetaForm.elements.caption.value = video.caption || "";
  elements.videoMetaForm.elements.hashtags.value = Array.isArray(video.hashtags) ? video.hashtags.join(" ") : "";
  elements.videoMetaForm.elements.scheduleAt.value = toDateTimeLocalValue(video.scheduleAt || "");
  elements.videoMetaForm.elements.isDraft.checked = video.isDraft === true;

  elements.videoMetaForm.querySelectorAll('input[name="platforms"]').forEach((input) => {
    input.checked = Array.isArray(video.platforms) ? video.platforms.includes(input.value) : false;
  });
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

  const publishStatus = video.lastPublishStatus || (video.publishedAt ? "published" : video.scheduleAt ? "ready" : "local");
  elements.videoPublishStatus.textContent = publishStatus;
  elements.videoPublishStatus.dataset.state = publishStatus === "scheduled" || publishStatus === "published" ? "completed" : "";

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

  fillVideoForm(video);

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
    job.failureStage || "pipeline",
    job.outputProfile || null,
    job.targetSeconds ? `${job.targetSeconds}s` : null,
    formatDateTime(job.createdAt)
  ]
    .filter(Boolean)
    .join(" • ");
  elements.failedJobStatus.textContent = "failed";
  elements.failedJobStatus.dataset.state = "failed";
  elements.failedJobError.textContent = job.failureSummary || job.error || "Falhou sem detalhe adicional.";

  if (job.storyboardUrl) {
    elements.failedJobStoryboardLink.href = job.storyboardUrl;
    elements.failedJobStoryboardLink.classList.remove("hidden");
  } else {
    elements.failedJobStoryboardLink.classList.add("hidden");
  }

  elements.retryFailedJobButton.disabled = job.retryFromStoryboardAvailable !== true;
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
  const voiceSelect = document.querySelector("#generateVoice");
  const imageStyleSelect = document.querySelector("#generateImageStyle");
  const profileSelect = document.querySelector("#generateOutputProfile");
  const customStyleInput = elements.generateForm?.querySelector('input[name="customStylePrompt"]');

  if (toneSelect && preset.tone) {
    toneSelect.value = preset.tone;
  }

  if (voiceSelect && preset.voice) {
    voiceSelect.value = preset.voice;
  }

  if (imageStyleSelect && preset.imageStyle) {
    imageStyleSelect.value = preset.imageStyle;
  }

  const assetModeSelect = document.querySelector("#generateAssetMode");
  if (assetModeSelect && preset.assetMode) {
    assetModeSelect.value = preset.assetMode;
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
  fillSelect(document.querySelector("#generateAssetMode"), payload.assetModes, payload.defaults.assetMode);
  fillSelect(document.querySelector("#generateImageStyle"), payload.imageStyles, payload.defaults.imageStyle);
  fillSelect(document.querySelector("#generateChannel"), payload.channels, payload.defaults.channel);
  fillSelect(document.querySelector("#generateTone"), payload.tones, payload.defaults.tone);
  fillSelect(document.querySelector("#generateVoice"), payload.voices, payload.defaults.voice);

  elements.generateForm.force.checked = Boolean(payload.defaults.force);
  elements.generateForm.noMusic.checked = Boolean(payload.defaults.noMusic);

  const voiceSelect = document.querySelector("#generateVoice");
  const customVoiceField = document.querySelector("#generateCustomVoiceField");

  const syncVoiceField = () => toggleCustomVoiceField(voiceSelect, customVoiceField);
  voiceSelect?.addEventListener("change", syncVoiceField);
  syncVoiceField();

  const syncAssetModeHint = () => {
    const selected = getAssetModeMeta(document.querySelector("#generateAssetMode")?.value);
    elements.assetModeHint.textContent = selected?.description || "";
  };

  const syncImageStyleHint = () => {
    const selected = getImageStyleMeta(document.querySelector("#generateImageStyle")?.value);
    elements.imageStyleHint.textContent = selected?.description || "";
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

  document.querySelector("#generateAssetMode")?.addEventListener("change", syncAssetModeHint);
  document.querySelector("#generateImageStyle")?.addEventListener("change", syncImageStyleHint);
  document.querySelector("#generateOutputProfile")?.addEventListener("change", syncProfileHints);
  document.querySelector("#generateTone")?.addEventListener("change", syncToneHint);
  document.querySelector("#generateChannel")?.addEventListener("change", () => {
    const channelId = document.querySelector("#generateChannel")?.value;
    applyChannelPresetToForm(channelId);
    syncImageStyleHint();
    syncToneHint();
    syncChannelHint();
  });

  elements.autoApproveToggle?.addEventListener("change", syncGenerateMode);
  elements.generateForm?.querySelector('input[name="title"]')?.addEventListener("input", () => validateGenerateForm(elements.generateForm));
  elements.generateForm?.querySelector('textarea[name="sourceText"]')?.addEventListener("input", () => validateGenerateForm(elements.generateForm));

  applyChannelPresetToForm(payload.defaults.channel);
  syncAssetModeHint();
  syncImageStyleHint();
  syncProfileHints();
  syncToneHint();
  syncChannelHint();
  syncGenerateMode();
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
    assetMode: String(data.get("assetMode") || "google-cloud"),
    imageStyle: String(data.get("imageStyle") || "claude"),
    channel: String(data.get("channel") || "foiumaideia"),
    tone: String(data.get("tone") || "shortform_native"),
    voice: String(data.get("voice") || "Iapetus"),
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
    scheduleAt: scheduleAtRaw ? new Date(scheduleAtRaw).toISOString() : "",
    platforms: Array.from(elements.videoMetaForm.querySelectorAll('input[name="platforms"]:checked')).map((input) => input.value),
    isDraft: elements.videoMetaForm.elements.isDraft.checked
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
  const payload = getSelectedVideoPayload();

  if (!payload) {
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

setInterval(() => {
  refreshJobs().catch(() => {});
  refreshRuns().catch(() => {});
  refreshVideos().catch(() => {});
}, 20000);
