const state = {
  projects: [],
  activeProjectId: null,
  activeProject: null,
  activeSlotId: null,
  mediaRecorder: null,
  mediaStream: null,
  chunks: [],
  draftBlob: null,
  timerStartedAt: null,
  timerInterval: null,
  meterInterval: null,
  audioContext: null,
  analyser: null,
  mergeBusy: null,
  layout: {
    sidebarWidth: 360,
    slotsWidth: 400,
    sidebarCollapsed: false,
    slotsCollapsed: false
  }
};

const MERGE_DEFAULTS = {
  trimSilence: true,
  gapMs: 300,
  startSilenceKeepMs: 150,
  endSilenceKeepMs: 150,
  startTrimThresholdDb: -54,
  endTrimThresholdDb: -54
};

const elements = {
  projectList: document.querySelector('#projectList'),
  projectCount: document.querySelector('#projectCount'),
  projectTitle: document.querySelector('#projectTitle'),
  projectSubtitle: document.querySelector('#projectSubtitle'),
  projectFormat: document.querySelector('#projectFormat'),
  recordedCount: document.querySelector('#recordedCount'),
  slotCount: document.querySelector('#slotCount'),
  slotList: document.querySelector('#slotList'),
  selectionBadge: document.querySelector('#selectionBadge'),
  slotTitleInput: document.querySelector('#slotTitleInput'),
  recordingState: document.querySelector('#recordingState'),
  recordingTimer: document.querySelector('#recordingTimer'),
  meterFill: document.querySelector('#meterFill'),
  draftAudio: document.querySelector('#draftAudio'),
  savedAudio: document.querySelector('#savedAudio'),
  savedAudioStatus: document.querySelector('#savedAudioStatus'),
  mergedAudio: document.querySelector('#mergedAudio'),
  mergeStatus: document.querySelector('#mergeStatus'),
  trimSilenceInput: document.querySelector('#trimSilenceInput'),
  gapMsInput: document.querySelector('#gapMsInput'),
  startSilenceKeepMsInput: document.querySelector('#startSilenceKeepMsInput'),
  endSilenceKeepMsInput: document.querySelector('#endSilenceKeepMsInput'),
  startTrimThresholdDbInput: document.querySelector('#startTrimThresholdDbInput'),
  endTrimThresholdDbInput: document.querySelector('#endTrimThresholdDbInput'),
  resetMergeDefaultsButton: document.querySelector('#resetMergeDefaultsButton'),
  openCreateProjectButton: document.querySelector('#openCreateProjectButton'),
  createProjectDialog: document.querySelector('#createProjectDialog'),
  createProjectForm: document.querySelector('#createProjectForm'),
  projectNameInput: document.querySelector('#projectNameInput'),
  closeCreateProjectButton: document.querySelector('#closeCreateProjectButton'),
  cancelCreateProjectButton: document.querySelector('#cancelCreateProjectButton'),
  refreshProjectsButton: document.querySelector('#refreshProjectsButton'),
  toggleSidebarButton: document.querySelector('#toggleSidebarButton'),
  toggleSlotsButton: document.querySelector('#toggleSlotsButton'),
  sidebarResizer: document.querySelector('#sidebarResizer'),
  slotResizer: document.querySelector('#slotResizer'),
  addSlotButton: document.querySelector('#addSlotButton'),
  recordToggleButton: document.querySelector('#recordToggleButton'),
  discardRecordButton: document.querySelector('#discardRecordButton'),
  nextButton: document.querySelector('#nextButton'),
  deleteAudioButton: document.querySelector('#deleteAudioButton'),
  deleteSlotButton: document.querySelector('#deleteSlotButton'),
  previewMergeButton: document.querySelector('#previewMergeButton'),
  exportMergeButton: document.querySelector('#exportMergeButton'),
  exportPackageButton: document.querySelector('#exportPackageButton'),
  openProjectFolderButton: document.querySelector('#openProjectFolderButton'),
  openExportFolderButton: document.querySelector('#openExportFolderButton')
};

function formatDuration(ms) {
  if (!ms) {
    return '--:--';
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatDate(input) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(input));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function loadLayoutState() {
  try {
    const raw = localStorage.getItem('voice-strip-layout');
    if (!raw) {
      return;
    }

    const saved = JSON.parse(raw);
    state.layout.sidebarWidth = clamp(Number(saved.sidebarWidth) || 360, 280, 520);
    state.layout.slotsWidth = clamp(Number(saved.slotsWidth) || 400, 280, 560);
    state.layout.sidebarCollapsed = Boolean(saved.sidebarCollapsed);
    state.layout.slotsCollapsed = Boolean(saved.slotsCollapsed);
  } catch (error) {
    console.warn('Failed to restore layout state.', error);
  }
}

function persistLayoutState() {
  localStorage.setItem('voice-strip-layout', JSON.stringify(state.layout));
}

function applyLayoutState() {
  document.documentElement.style.setProperty('--sidebar-width', `${state.layout.sidebarWidth}px`);
  document.documentElement.style.setProperty('--slots-width', `${state.layout.slotsWidth}px`);
  document.body.classList.toggle('sidebar-collapsed', state.layout.sidebarCollapsed);
  document.body.classList.toggle('slots-collapsed', state.layout.slotsCollapsed);
  elements.toggleSidebarButton.textContent = state.layout.sidebarCollapsed ? '>' : '<';
  elements.toggleSidebarButton.title = state.layout.sidebarCollapsed ? '展开项目栏' : '收起项目栏';
  elements.toggleSlotsButton.textContent = state.layout.slotsCollapsed ? '>' : '<';
  elements.toggleSlotsButton.title = state.layout.slotsCollapsed ? '展开音频槽栏' : '收起音频槽栏';
}

function syncInputValue(input, value) {
  if (!input) {
    return;
  }

  if (document.activeElement === input) {
    return;
  }

  input.value = String(value);
}

function getActiveSlot() {
  return state.activeProject?.slots.find((slot) => slot.id === state.activeSlotId) || null;
}

function setTimerText(ms = 0) {
  elements.recordingTimer.textContent = formatDuration(ms);
}

function clearDraftAudio() {
  if (elements.draftAudio.src?.startsWith('blob:')) {
    URL.revokeObjectURL(elements.draftAudio.src);
  }
  elements.draftAudio.removeAttribute('src');
  elements.draftAudio.load();
}

function clearRecordingState() {
  state.chunks = [];
  state.draftBlob = null;
  clearDraftAudio();
  elements.recordingState.textContent = '待命';
  setTimerText(0);
  elements.meterFill.style.width = '0%';
}

function stopMeter() {
  if (state.meterInterval) {
    clearInterval(state.meterInterval);
    state.meterInterval = null;
  }
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }
  state.analyser = null;
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}

function stopMediaTracks() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
    state.mediaStream = null;
  }
}

function setActiveProject(project) {
  const previousProjectId = state.activeProjectId;
  state.activeProject = project;
  state.activeProjectId = project?.id || null;

  const fallbackSlot = project?.slots.find((slot) => slot.id === state.activeSlotId) || project?.slots[0] || null;
  state.activeSlotId = fallbackSlot?.id || null;

  if (previousProjectId !== state.activeProjectId) {
    elements.savedAudio.removeAttribute('src');
    elements.savedAudio.load();
    elements.savedAudioStatus.textContent = '保存后的片段会显示在这里，可随时回听。';
    elements.mergedAudio.removeAttribute('src');
    elements.mergedAudio.load();
    elements.mergeStatus.textContent = '把已录好的片段合成一条后，可以在这里直接听。';
  }

  renderProjectList();
  renderProjectDetails();
}

function renderProjectList() {
  elements.projectCount.textContent = String(state.projects.length);

  if (!state.projects.length) {
    elements.projectList.innerHTML = '<div class="empty-state">还没有项目。点击上方按钮创建第一个项目。</div>';
    return;
  }

  elements.projectList.innerHTML = state.projects
    .map((project) => {
      const activeClass = project.id === state.activeProjectId ? 'active' : '';
      return `
        <button class="project-card ${activeClass}" data-project-id="${project.id}" type="button">
          <h4>${project.name}</h4>
          <div class="project-meta">
            <span class="chip">${project.format.toUpperCase()}</span>
            <span>${project.recordedSlots}/${project.totalSlots} 已录</span>
            <span>${formatDate(project.updatedAt)}</span>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderProjectDetails() {
  const project = state.activeProject;
  const slot = getActiveSlot();
  const recordedSlots = project?.slots.filter((item) => item.audioFile).length || 0;
  const isMergeBusy = Boolean(state.mergeBusy);

  elements.projectTitle.textContent = project?.name || '先创建一个项目';
  elements.projectSubtitle.textContent = project
    ? '录好一条就试听，满意后直接下一条。你也可以保留空槽、删音频、删槽位并上移。'
    : '每个项目支持分段录制、试听、留空槽位、槽位删除上移，以及随时合并导出。';
  elements.projectFormat.textContent = project ? project.format.toUpperCase() : '-';
  elements.recordedCount.textContent = String(recordedSlots);
  elements.slotCount.textContent = String(project?.slots.length || 0);

  elements.addSlotButton.disabled = !project;
  elements.previewMergeButton.disabled = !project || recordedSlots === 0 || isMergeBusy;
  elements.exportMergeButton.disabled = !project || recordedSlots === 0 || isMergeBusy;
  elements.openProjectFolderButton.disabled = !project;
  elements.openExportFolderButton.disabled = !project;
  elements.trimSilenceInput.disabled = !project || isMergeBusy;
  elements.gapMsInput.disabled = !project || isMergeBusy;
  elements.startSilenceKeepMsInput.disabled = !project || isMergeBusy;
  elements.endSilenceKeepMsInput.disabled = !project || isMergeBusy;
  elements.startTrimThresholdDbInput.disabled = !project || isMergeBusy;
  elements.endTrimThresholdDbInput.disabled = !project || isMergeBusy;
  elements.resetMergeDefaultsButton.disabled = !project || isMergeBusy;

  elements.previewMergeButton.textContent = state.mergeBusy === 'preview' ? '正在生成试听...' : '生成合并试听';
  elements.exportMergeButton.textContent = state.mergeBusy === 'export' ? '正在导出合并音频...' : '一键导出合并音频';
  elements.exportPackageButton.textContent = state.mergeBusy === 'package' ? '正在导出音频包...' : '导出处理后音频包';

  if (!project) {
    elements.slotList.innerHTML = '<div class="empty-state">左侧新建或选择一个项目后，这里会展示所有音频槽位。</div>';
    elements.selectionBadge.textContent = '未选择';
    elements.slotTitleInput.value = '';
    elements.slotTitleInput.disabled = true;
    elements.recordToggleButton.disabled = true;
    elements.recordToggleButton.textContent = '开始录音';
    elements.recordToggleButton.classList.remove('stop', 'recording');
    elements.discardRecordButton.disabled = true;
    elements.nextButton.disabled = true;
    elements.deleteAudioButton.disabled = true;
    elements.deleteSlotButton.disabled = true;
    elements.trimSilenceInput.checked = true;
    syncInputValue(elements.gapMsInput, MERGE_DEFAULTS.gapMs);
    syncInputValue(elements.startSilenceKeepMsInput, MERGE_DEFAULTS.startSilenceKeepMs);
    syncInputValue(elements.endSilenceKeepMsInput, MERGE_DEFAULTS.endSilenceKeepMs);
    syncInputValue(elements.startTrimThresholdDbInput, MERGE_DEFAULTS.startTrimThresholdDb);
    syncInputValue(elements.endTrimThresholdDbInput, MERGE_DEFAULTS.endTrimThresholdDb);
    elements.exportPackageButton.disabled = true;
    return;
  }

  elements.trimSilenceInput.checked = project.mergeSettings?.trimSilence !== false;
  syncInputValue(elements.gapMsInput, project.mergeSettings?.gapMs ?? MERGE_DEFAULTS.gapMs);
  syncInputValue(
    elements.startSilenceKeepMsInput,
    project.mergeSettings?.startSilenceKeepMs ?? MERGE_DEFAULTS.startSilenceKeepMs
  );
  syncInputValue(
    elements.endSilenceKeepMsInput,
    project.mergeSettings?.endSilenceKeepMs ?? MERGE_DEFAULTS.endSilenceKeepMs
  );
  syncInputValue(
    elements.startTrimThresholdDbInput,
    project.mergeSettings?.startTrimThresholdDb ?? MERGE_DEFAULTS.startTrimThresholdDb
  );
  syncInputValue(
    elements.endTrimThresholdDbInput,
    project.mergeSettings?.endTrimThresholdDb ?? MERGE_DEFAULTS.endTrimThresholdDb
  );

  elements.slotList.innerHTML = project.slots
    .map((item) => {
      const activeClass = item.id === state.activeSlotId ? 'active' : '';
      const recordedClass = item.audioFile ? 'recorded' : 'empty-slot';
      const statusLabel = item.audioFile ? `已录制 ${formatDuration(item.durationMs)}` : '空槽位';
      return `
        <button class="slot-card ${activeClass} ${recordedClass}" data-slot-id="${item.id}" type="button">
          <div class="status">${statusLabel}</div>
          <h4>${String(item.order).padStart(2, '0')} · ${item.title}</h4>
          <div class="slot-meta">
            <span>${item.audioFile || '未生成文件'}</span>
          </div>
        </button>
      `;
    })
    .join('');

  elements.selectionBadge.textContent = slot ? `#${String(slot.order).padStart(2, '0')}` : '未选择';
  elements.slotTitleInput.disabled = !slot;
  elements.slotTitleInput.value = slot?.title || '';
  const isRecording = state.mediaRecorder?.state === 'recording';
  elements.recordToggleButton.textContent = isRecording ? '停止录音' : slot?.audioFile ? '重新录音' : '开始录音';
  elements.recordToggleButton.disabled = !slot;
  elements.recordToggleButton.classList.toggle('stop', isRecording);
  elements.recordToggleButton.classList.toggle('recording', isRecording);
  elements.discardRecordButton.disabled = !state.draftBlob;
  elements.nextButton.disabled = !slot || (!state.draftBlob && !slot.audioFile);
  elements.deleteAudioButton.disabled = !slot || !slot.audioFile;
  elements.deleteSlotButton.disabled = !slot;
  elements.exportPackageButton.disabled = !project || recordedSlots === 0 || isMergeBusy;

  if (slot?.fileUrl) {
    elements.savedAudio.src = slot.fileUrl;
    elements.savedAudioStatus.textContent = `文件名：${slot.audioFile}`;
  } else {
    elements.savedAudio.removeAttribute('src');
    elements.savedAudio.load();
    elements.savedAudioStatus.textContent = '保存后的片段会显示在这里，可随时回听。';
  }
}

async function refreshProjects(preserveSelection = true) {
  const list = await window.appApi.listProjects();
  state.projects = list;

  if (!preserveSelection || !state.activeProjectId) {
    renderProjectList();
    return;
  }

  if (!list.some((project) => project.id === state.activeProjectId)) {
    setActiveProject(null);
    return;
  }

  renderProjectList();
}

async function loadProject(projectId) {
  const project = await window.appApi.getProject(projectId);
  setActiveProject(project);
  await refreshProjects(true);
}

async function withErrorBoundary(task) {
  try {
    await task();
  } catch (error) {
    console.error(error);
    await window.appApi.showMessage({
      type: 'error',
      title: '操作失败',
      message: error.message || '发生了未知错误。'
    });
  }
}

async function createProjectFromForm(form) {
  const formData = new FormData(form);
  const name = formData.get('projectName') || elements.projectNameInput.value.trim();
  const format = formData.get('projectFormat') || 'mp3';
  const project = await window.appApi.createProject({ name, format });
  elements.createProjectDialog.close();
  elements.projectNameInput.value = '';
  await refreshProjects(false);
  setActiveProject(project);
}

async function startRecording() {
  if (state.mediaRecorder?.state === 'recording') {
    return;
  }

  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  clearRecordingState();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  state.mediaStream = stream;
  const preferredMimeTypes = ['audio/webm;codecs=opus', 'audio/webm'];
  const supportedMimeType = preferredMimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = supportedMimeType ? new MediaRecorder(stream, { mimeType: supportedMimeType }) : new MediaRecorder(stream);
  state.mediaRecorder = recorder;
  state.chunks = [];
  state.timerStartedAt = Date.now();

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) {
      state.chunks.push(event.data);
    }
  });

  recorder.addEventListener('stop', () => {
    stopTimer();
    stopMeter();
    stopMediaTracks();

    state.draftBlob = new Blob(state.chunks, { type: 'audio/webm' });
    const objectUrl = URL.createObjectURL(state.draftBlob);
    elements.draftAudio.src = objectUrl;
    elements.recordingState.textContent = '已停止，可先试听';
    state.mediaRecorder = null;
    renderProjectDetails();
  });

  state.audioContext = new AudioContext();
  const source = state.audioContext.createMediaStreamSource(stream);
  state.analyser = state.audioContext.createAnalyser();
  state.analyser.fftSize = 256;
  source.connect(state.analyser);

  state.meterInterval = setInterval(() => {
    if (!state.analyser) {
      return;
    }

    const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
    state.analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
    const width = Math.min(100, Math.max(8, Math.round((average / 255) * 100)));
    elements.meterFill.style.width = `${width}%`;
  }, 120);

  state.timerInterval = setInterval(() => {
    setTimerText(Date.now() - state.timerStartedAt);
  }, 250);

  recorder.start();
  elements.recordingState.textContent = '录音中';
  renderProjectDetails();
}

function stopRecording() {
  if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
    state.mediaRecorder.stop();
  }
}

async function handleRecordToggle() {
  if (state.mediaRecorder?.state === 'recording') {
    stopRecording();
    renderProjectDetails();
    return;
  }

  await startRecording();
}

async function persistDraftRecording() {
  const slot = getActiveSlot();
  if (!slot || !state.draftBlob) {
    return state.activeProject;
  }

  const buffer = await state.draftBlob.arrayBuffer();
  const project = await window.appApi.saveRecording({
    projectId: state.activeProjectId,
    slotId: slot.id,
    buffer
  });

  setActiveProject(project);
  await refreshProjects(true);
  clearRecordingState();
  renderProjectDetails();
  return project;
}

function discardDraftRecording() {
  clearRecordingState();
  renderProjectDetails();
}

async function updateSlotTitle(title) {
  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  const project = await window.appApi.updateSlot({
    projectId: state.activeProjectId,
    slotId: slot.id,
    changes: { title }
  });
  setActiveProject(project);
  await refreshProjects(true);
}

async function addSlot() {
  const project = await window.appApi.addSlot(state.activeProjectId);
  state.activeSlotId = project.slots[project.slots.length - 1].id;
  setActiveProject(project);
  await refreshProjects(true);
}

async function advanceToNextSlot() {
  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  if (state.draftBlob) {
    await persistDraftRecording();
  }

  const refreshedSlot = getActiveSlot();
  if (!refreshedSlot?.audioFile) {
    return;
  }

  const result = await window.appApi.advanceSlot({
    projectId: state.activeProjectId,
    slotId: refreshedSlot.id
  });

  state.activeSlotId = result.slotId;
  setActiveProject(result.project);
  await refreshProjects(true);
}

async function deleteAudio() {
  const slot = getActiveSlot();
  if (!slot || !slot.audioFile) {
    return;
  }

  const project = await window.appApi.deleteAudio({
    projectId: state.activeProjectId,
    slotId: slot.id
  });

  setActiveProject(project);
  await refreshProjects(true);
}

async function deleteSlot() {
  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  const project = await window.appApi.deleteSlot({
    projectId: state.activeProjectId,
    slotId: slot.id
  });

  setActiveProject(project);
  await refreshProjects(true);
}

async function previewMerge() {
  await runMergeAction('preview', async () => {
    const result = await window.appApi.previewMerge(state.activeProjectId);
    elements.mergedAudio.src = result.fileUrl;
    elements.mergeStatus.textContent = `合并试听已生成，文件位于：${result.filePath}`;
  });
}

async function exportMerge() {
  await runMergeAction('export', async () => {
    const result = await window.appApi.exportMerge(state.activeProjectId);
    elements.mergedAudio.src = result.fileUrl;
    elements.mergeStatus.textContent = `导出完成：${result.filePath}`;
    await window.appApi.revealExport(result.filePath);
  });
}

async function exportProcessedPackage() {
  await runMergeAction('package', async () => {
    const result = await window.appApi.exportProcessedSegments(state.activeProjectId);
    elements.mergeStatus.textContent = `处理后音频包已导出：${result.filePath}`;
    await window.appApi.revealExport(result.filePath);
  });
}

async function runMergeAction(action, task) {
  state.mergeBusy = action;
  renderProjectDetails();

  try {
    if (action === 'preview') {
      elements.mergeStatus.textContent = '正在生成合并试听...';
    } else if (action === 'export') {
      elements.mergeStatus.textContent = '正在导出合并音频...';
    } else if (action === 'package') {
      elements.mergeStatus.textContent = '正在导出处理后音频包...';
    }

    await task();
  } finally {
    state.mergeBusy = null;
    renderProjectDetails();
  }
}

async function updateMergeSettings(partialSettings) {
  if (!state.activeProjectId) {
    return;
  }

  const project = await window.appApi.updateMergeSettings({
    projectId: state.activeProjectId,
    mergeSettings: partialSettings
  });

  setActiveProject(project);
  await refreshProjects(true);
}

function toggleSidebar() {
  state.layout.sidebarCollapsed = !state.layout.sidebarCollapsed;
  applyLayoutState();
  persistLayoutState();
}

function toggleSlotsPanel() {
  state.layout.slotsCollapsed = !state.layout.slotsCollapsed;
  applyLayoutState();
  persistLayoutState();
}

function bindHorizontalResizer(element, options) {
  element.addEventListener('pointerdown', (event) => {
    if (options.isCollapsed()) {
      return;
    }

    const startX = event.clientX;
    const startWidth = options.getWidth();
    element.setPointerCapture?.(event.pointerId);

    const handlePointerMove = (moveEvent) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, options.min, options.max);
      options.setWidth(nextWidth);
      applyLayoutState();
    };

    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      persistLayoutState();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  });
}

function attachEvents() {
  elements.openCreateProjectButton.addEventListener('click', () => {
    elements.createProjectDialog.showModal();
  });

  elements.closeCreateProjectButton.addEventListener('click', () => {
    elements.createProjectDialog.close();
  });

  elements.cancelCreateProjectButton.addEventListener('click', () => {
    elements.createProjectDialog.close();
  });

  elements.createProjectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await withErrorBoundary(async () => {
      await createProjectFromForm(event.currentTarget);
    });
  });

  elements.refreshProjectsButton.addEventListener('click', () => {
    withErrorBoundary(async () => {
      await refreshProjects(false);
    });
  });

  elements.toggleSidebarButton.addEventListener('click', toggleSidebar);
  elements.toggleSlotsButton.addEventListener('click', toggleSlotsPanel);

  elements.projectList.addEventListener('click', (event) => {
    const target = event.target.closest('[data-project-id]');
    if (!target) {
      return;
    }

    withErrorBoundary(async () => {
      await loadProject(target.dataset.projectId);
    });
  });

  elements.slotList.addEventListener('click', (event) => {
    const target = event.target.closest('[data-slot-id]');
    if (!target) {
      return;
    }

    state.activeSlotId = target.dataset.slotId;
    renderProjectDetails();
  });

  let titleTimer = null;
  elements.slotTitleInput.addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      withErrorBoundary(async () => {
        await updateSlotTitle(elements.slotTitleInput.value);
      });
    }, 320);
  });

  elements.trimSilenceInput.addEventListener('change', () => {
    withErrorBoundary(async () => {
      await updateMergeSettings({
        trimSilence: elements.trimSilenceInput.checked
      });
    });
  });

  const bindNumericMergeSetting = (input, key, fallback, min, max) => {
    const commit = () => {
      const nextValue = clamp(Number(input.value) || fallback, min, max);
      input.value = String(nextValue);
      withErrorBoundary(async () => {
        await updateMergeSettings({
          [key]: nextValue
        });
      });
    };

    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        input.blur();
      }
    });
  };

  bindNumericMergeSetting(elements.gapMsInput, 'gapMs', MERGE_DEFAULTS.gapMs, 0, 2000);
  bindNumericMergeSetting(elements.startSilenceKeepMsInput, 'startSilenceKeepMs', MERGE_DEFAULTS.startSilenceKeepMs, 0, 300);
  bindNumericMergeSetting(elements.endSilenceKeepMsInput, 'endSilenceKeepMs', MERGE_DEFAULTS.endSilenceKeepMs, 0, 300);
  bindNumericMergeSetting(
    elements.startTrimThresholdDbInput,
    'startTrimThresholdDb',
    MERGE_DEFAULTS.startTrimThresholdDb,
    -60,
    -20
  );
  bindNumericMergeSetting(
    elements.endTrimThresholdDbInput,
    'endTrimThresholdDb',
    MERGE_DEFAULTS.endTrimThresholdDb,
    -60,
    -20
  );

  elements.resetMergeDefaultsButton.addEventListener('click', () => {
    withErrorBoundary(async () => {
      await updateMergeSettings(MERGE_DEFAULTS);
    });
  });

  elements.addSlotButton.addEventListener('click', () => {
    withErrorBoundary(addSlot);
  });

  elements.recordToggleButton.addEventListener('click', () => {
    withErrorBoundary(handleRecordToggle);
  });

  elements.discardRecordButton.addEventListener('click', () => {
    discardDraftRecording();
  });

  elements.nextButton.addEventListener('click', () => {
    withErrorBoundary(advanceToNextSlot);
  });

  elements.deleteAudioButton.addEventListener('click', () => {
    withErrorBoundary(deleteAudio);
  });

  elements.deleteSlotButton.addEventListener('click', () => {
    withErrorBoundary(deleteSlot);
  });

  elements.previewMergeButton.addEventListener('click', () => {
    withErrorBoundary(previewMerge);
  });

  elements.exportMergeButton.addEventListener('click', () => {
    withErrorBoundary(exportMerge);
  });

  elements.exportPackageButton.addEventListener('click', () => {
    withErrorBoundary(exportProcessedPackage);
  });

  elements.openProjectFolderButton.addEventListener('click', () => {
    withErrorBoundary(async () => {
      await window.appApi.openFolder({ projectId: state.activeProjectId, kind: 'project' });
    });
  });

  elements.openExportFolderButton.addEventListener('click', () => {
    withErrorBoundary(async () => {
      await window.appApi.openFolder({ projectId: state.activeProjectId, kind: 'exports' });
    });
  });

  window.addEventListener('beforeunload', () => {
    stopTimer();
    stopMeter();
    stopMediaTracks();
  });
}

async function init() {
  loadLayoutState();
  applyLayoutState();
  bindHorizontalResizer(elements.sidebarResizer, {
    min: 280,
    max: 520,
    isCollapsed: () => state.layout.sidebarCollapsed,
    getWidth: () => state.layout.sidebarWidth,
    setWidth: (value) => {
      state.layout.sidebarWidth = value;
    }
  });
  bindHorizontalResizer(elements.slotResizer, {
    min: 280,
    max: 560,
    isCollapsed: () => state.layout.slotsCollapsed,
    getWidth: () => state.layout.slotsWidth,
    setWidth: (value) => {
      state.layout.slotsWidth = value;
    }
  });
  attachEvents();
  clearRecordingState();
  await refreshProjects(false);
  renderProjectDetails();
}

init().catch((error) => {
  console.error(error);
});
