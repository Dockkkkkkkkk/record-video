state.draftSlotId = null;

Object.assign(elements, {
  savedAudioBlock: document.querySelector('#savedAudioBlock'),
  mergeCard: document.querySelector('#mergeCard'),
  bundleAssetsCard: document.querySelector('#bundleAssetsCard'),
  bundleAudioList: document.querySelector('#bundleAudioList'),
  bundleVisualList: document.querySelector('#bundleVisualList'),
  uploadAudioButton: document.querySelector('#uploadAudioButton'),
  uploadVisualButton: document.querySelector('#uploadVisualButton'),
  audioUploadInput: document.querySelector('#audioUploadInput'),
  visualUploadInput: document.querySelector('#visualUploadInput'),
  bundleExportCard: document.querySelector('#bundleExportCard'),
  exportBundleButton: document.querySelector('#exportBundleButton'),
  bundleExportStatus: document.querySelector('#bundleExportStatus'),
  openProjectFolderButtonBundle: document.querySelector('#openProjectFolderButtonBundle'),
  openExportFolderButtonBundle: document.querySelector('#openExportFolderButtonBundle')
});

function extProjectType(project = state.activeProject) {
  return project?.type === 'bundle' ? 'bundle' : 'audio';
}

function extIsBundle(project = state.activeProject) {
  return extProjectType(project) === 'bundle';
}

function extFilledSlotCount(project = state.activeProject) {
  if (!project) {
    return 0;
  }

  if (extIsBundle(project)) {
    return project.slots.filter((slot) => slot.audioItems.length > 0 || slot.visualItems.length > 0).length;
  }

  return project.slots.filter((slot) => Boolean(slot.audioFile)).length;
}

function extBundleAssetCount(project = state.activeProject) {
  if (!project || !extIsBundle(project)) {
    return 0;
  }

  return project.slots.reduce((sum, slot) => sum + slot.audioItems.length + slot.visualItems.length, 0);
}

function extClearElement(audioElement) {
  if (audioElement.src?.startsWith('blob:')) {
    URL.revokeObjectURL(audioElement.src);
  }
  audioElement.removeAttribute('src');
  audioElement.load();
}

function extResetOutputs() {
  extClearElement(elements.savedAudio);
  extClearElement(elements.mergedAudio);
  elements.savedAudioStatus.textContent = '保存后的片段会显示在这里，可随时回听。';
  elements.mergeStatus.textContent = '把已录好的片段合成一条后，可以在这里直接听。';
  elements.bundleExportStatus.textContent = '导出 zip 后，你可以直接把它发给后面的剪辑 agent。';
}

function extRenderSlotList(project) {
  if (!project) {
    elements.slotList.innerHTML = '<div class="empty-state">左侧新建或选择一个项目后，这里会展示所有分片。</div>';
    return;
  }

  const bundleMode = extIsBundle(project);
  elements.slotList.innerHTML = project.slots
    .map((slot) => {
      const activeClass = slot.id === state.activeSlotId ? 'active' : '';
      const statusLabel = bundleMode
        ? slot.audioItems.length || slot.visualItems.length
          ? `音频 ${slot.audioItems.length} · 画面 ${slot.visualItems.length}`
          : '空分片'
        : slot.audioFile
          ? `已录制 ${formatDuration(slot.durationMs)}`
          : '空槽位';
      const metaLabel = bundleMode ? `${slot.audioItems.length + slot.visualItems.length} 个素材` : slot.audioFile || '未生成文件';

      return `
        <button class="slot-card ${activeClass}" data-slot-id="${slot.id}" type="button">
          <div class="status">${statusLabel}</div>
          <h4>${String(slot.order).padStart(2, '0')} · ${slot.title}</h4>
          <div class="slot-meta">
            <span>${metaLabel}</span>
          </div>
        </button>
      `;
    })
    .join('');
}

function extRenderBundleAssetList(items, category) {
  if (!items.length) {
    return `<div class="empty-state">当前分片还没有${category === 'audio' ? '音频' : '画面'}素材。</div>`;
  }

  return items
    .map((asset, index) => `
      <article class="asset-item">
        <div class="asset-item-head">
          <span class="asset-item-title">${String(index + 1).padStart(2, '0')} · ${asset.originalName}</span>
          <span class="chip">${category === 'audio' ? '音频' : asset.mediaKind === 'image' ? '图片' : '视频'}</span>
        </div>
        <div class="asset-item-meta">
          <span>${category === 'audio' ? formatDuration(asset.durationMs) : '素材'}</span>
          <span>${asset.source === 'recorded' ? '录音生成' : '上传文件'}</span>
        </div>
        ${category === 'audio' && asset.fileUrl ? `<audio controls src="${asset.fileUrl}"></audio>` : ''}
        <div class="asset-item-actions">
          <div class="secondary-actions">
            <button class="micro-button" type="button" data-asset-action="up" data-asset-category="${category}" data-asset-id="${asset.id}" ${index === 0 ? 'disabled' : ''}>上移</button>
            <button class="micro-button" type="button" data-asset-action="down" data-asset-category="${category}" data-asset-id="${asset.id}" ${index === items.length - 1 ? 'disabled' : ''}>下移</button>
          </div>
          <button class="micro-button danger" type="button" data-asset-action="delete" data-asset-category="${category}" data-asset-id="${asset.id}">删除</button>
        </div>
      </article>
    `)
    .join('');
}

clearRecordingState = function () {
  state.chunks = [];
  state.draftBlob = null;
  state.draftSlotId = null;
  clearDraftAudio();
  elements.recordingState.textContent = '待命';
  setTimerText(0);
  elements.meterFill.style.width = '0%';
};

setActiveProject = function (project) {
  const previousProjectId = state.activeProjectId;
  state.activeProject = project;
  state.activeProjectId = project?.id || null;

  const fallbackSlot = project?.slots.find((slot) => slot.id === state.activeSlotId) || project?.slots[0] || null;
  state.activeSlotId = fallbackSlot?.id || null;

  if (previousProjectId !== state.activeProjectId) {
    clearRecordingState();
    extResetOutputs();
  }

  renderProjectList();
  renderProjectDetails();
};

renderProjectList = function () {
  elements.projectCount.textContent = String(state.projects.length);

  if (!state.projects.length) {
    elements.projectList.innerHTML = '<div class="empty-state">还没有项目。点上方按钮创建第一个项目。</div>';
    return;
  }

  elements.projectList.innerHTML = state.projects
    .map((project) => {
      const activeClass = project.id === state.activeProjectId ? 'active' : '';
      return `
        <button class="project-card ${activeClass}" data-project-id="${project.id}" type="button">
          <h4>${project.name}</h4>
          <div class="project-meta">
            <span class="chip">${project.type === 'bundle' ? '打包' : '录音'}</span>
            <span class="chip">${project.format.toUpperCase()}</span>
            <span>${project.recordedSlots}/${project.totalSlots} 已填</span>
            <span>${formatDate(project.updatedAt)}</span>
          </div>
        </button>
      `;
    })
    .join('');
};

renderProjectDetails = function () {
  const project = state.activeProject;
  const slot = getActiveSlot();
  const bundleMode = extIsBundle(project);
  const filledSlots = extFilledSlotCount(project);
  const isBusy = Boolean(state.mergeBusy);
  const isRecording = state.mediaRecorder?.state === 'recording';

  elements.projectTitle.textContent = project?.name || '先创建一个项目';
  elements.projectSubtitle.textContent = !project
    ? '录音项目支持逐条录制和合并导出，打包项目支持给每个分片整理音频和画面素材。'
    : bundleMode
      ? '给每个分片整理音频和画面素材，最后按目录结构打包给剪辑 agent。'
      : '录好一条就试听，满意后直接下一条。你也可以保留空槽、删音频、删槽位并上移。';
  elements.projectFormat.textContent = project ? `${bundleMode ? '打包' : '录音'} · ${project.format.toUpperCase()}` : '-';
  elements.recordedCount.textContent = String(filledSlots);
  elements.slotCount.textContent = String(project?.slots.length || 0);

  extRenderSlotList(project);

  elements.addSlotButton.disabled = !project;
  elements.selectionBadge.textContent = slot ? `#${String(slot.order).padStart(2, '0')}` : '未选择';
  elements.slotTitleInput.disabled = !slot;
  elements.slotTitleInput.value = slot?.title || '';

  elements.mergeCard.hidden = !project || bundleMode;
  elements.bundleAssetsCard.hidden = !project || !bundleMode;
  elements.bundleExportCard.hidden = !project || !bundleMode;
  elements.savedAudioBlock.hidden = bundleMode;
  elements.deleteAudioButton.hidden = bundleMode;

  if (!project) {
    elements.recordToggleButton.disabled = true;
    elements.recordToggleButton.textContent = '开始录音';
    elements.recordToggleButton.classList.remove('stop', 'recording');
    elements.discardRecordButton.disabled = true;
    elements.nextButton.disabled = true;
    elements.nextButton.textContent = '保存并下一条';
    elements.deleteAudioButton.disabled = true;
    elements.deleteSlotButton.disabled = true;
    elements.previewMergeButton.disabled = true;
    elements.exportMergeButton.disabled = true;
    elements.exportPackageButton.disabled = true;
    elements.exportBundleButton.disabled = true;
    elements.openProjectFolderButton.disabled = true;
    elements.openExportFolderButton.disabled = true;
    elements.openProjectFolderButtonBundle.disabled = true;
    elements.openExportFolderButtonBundle.disabled = true;
    elements.trimSilenceInput.disabled = true;
    elements.gapMsInput.disabled = true;
    elements.startSilenceKeepMsInput.disabled = true;
    elements.endSilenceKeepMsInput.disabled = true;
    elements.startTrimThresholdDbInput.disabled = true;
    elements.endTrimThresholdDbInput.disabled = true;
    elements.resetMergeDefaultsButton.disabled = true;
    elements.bundleAudioList.innerHTML = '<div class="empty-state">当前分片还没有音频素材。</div>';
    elements.bundleVisualList.innerHTML = '<div class="empty-state">当前分片还没有画面素材。</div>';
    return;
  }

  elements.recordToggleButton.textContent = isRecording ? '停止录音' : bundleMode ? '开始录音并添加素材' : slot?.audioFile ? '重新录音' : '开始录音';
  elements.recordToggleButton.disabled = !slot;
  elements.recordToggleButton.classList.toggle('stop', isRecording);
  elements.recordToggleButton.classList.toggle('recording', isRecording);
  elements.discardRecordButton.disabled = !state.draftBlob;
  elements.nextButton.textContent = bundleMode ? '保存为音频素材' : '保存并下一条';
  elements.nextButton.disabled = bundleMode ? !state.draftBlob : !slot || (!state.draftBlob && !slot.audioFile);
  elements.deleteSlotButton.disabled = !slot;
  elements.openProjectFolderButton.disabled = false;
  elements.openExportFolderButton.disabled = false;
  elements.openProjectFolderButtonBundle.disabled = false;
  elements.openExportFolderButtonBundle.disabled = false;

  if (bundleMode) {
    elements.bundleAudioList.innerHTML = extRenderBundleAssetList(slot?.audioItems || [], 'audio');
    elements.bundleVisualList.innerHTML = extRenderBundleAssetList(slot?.visualItems || [], 'visual');
    elements.exportBundleButton.textContent = state.mergeBusy === 'bundle-export' ? '正在导出剪辑素材包...' : '导出剪辑素材包';
    elements.exportBundleButton.disabled = extBundleAssetCount(project) === 0 || isBusy;
    return;
  }

  elements.trimSilenceInput.checked = project.mergeSettings?.trimSilence !== false;
  syncInputValue(elements.gapMsInput, project.mergeSettings?.gapMs ?? MERGE_DEFAULTS.gapMs);
  syncInputValue(elements.startSilenceKeepMsInput, project.mergeSettings?.startSilenceKeepMs ?? MERGE_DEFAULTS.startSilenceKeepMs);
  syncInputValue(elements.endSilenceKeepMsInput, project.mergeSettings?.endSilenceKeepMs ?? MERGE_DEFAULTS.endSilenceKeepMs);
  syncInputValue(elements.startTrimThresholdDbInput, project.mergeSettings?.startTrimThresholdDb ?? MERGE_DEFAULTS.startTrimThresholdDb);
  syncInputValue(elements.endTrimThresholdDbInput, project.mergeSettings?.endTrimThresholdDb ?? MERGE_DEFAULTS.endTrimThresholdDb);

  elements.trimSilenceInput.disabled = isBusy;
  elements.gapMsInput.disabled = isBusy;
  elements.startSilenceKeepMsInput.disabled = isBusy;
  elements.endSilenceKeepMsInput.disabled = isBusy;
  elements.startTrimThresholdDbInput.disabled = isBusy;
  elements.endTrimThresholdDbInput.disabled = isBusy;
  elements.resetMergeDefaultsButton.disabled = isBusy;
  elements.previewMergeButton.textContent = state.mergeBusy === 'preview' ? '正在生成试听...' : '生成合并试听';
  elements.exportMergeButton.textContent = state.mergeBusy === 'export' ? '正在导出合并音频...' : '一键导出合并音频';
  elements.exportPackageButton.textContent = state.mergeBusy === 'package' ? '正在导出音频包...' : '导出处理后音频包';
  elements.previewMergeButton.disabled = filledSlots === 0 || isBusy;
  elements.exportMergeButton.disabled = filledSlots === 0 || isBusy;
  elements.exportPackageButton.disabled = filledSlots === 0 || isBusy;
  elements.deleteAudioButton.disabled = !slot || !slot.audioFile;

  if (slot?.fileUrl) {
    elements.savedAudio.src = slot.fileUrl;
    elements.savedAudioStatus.textContent = `文件名：${slot.audioFile}`;
  } else {
    extClearElement(elements.savedAudio);
    elements.savedAudioStatus.textContent = '保存后的片段会显示在这里，可随时回听。';
  }
};

createProjectFromForm = async function (form) {
  const formData = new FormData(form);
  const name = formData.get('projectName') || elements.projectNameInput.value.trim();
  const format = formData.get('projectFormat') || 'mp3';
  const projectType = formData.get('projectType') || 'audio';
  const project = await window.appApi.createProject({ name, format, projectType });
  elements.createProjectDialog.close();
  elements.projectNameInput.value = '';
  await refreshProjects(false);
  setActiveProject(project);
};

startRecording = async function () {
  if (state.mediaRecorder?.state === 'recording') {
    return;
  }

  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  clearRecordingState();
  state.draftSlotId = slot.id;

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
    elements.draftAudio.src = URL.createObjectURL(state.draftBlob);
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
};

persistDraftRecording = async function () {
  const slotId = state.draftSlotId || state.activeSlotId;
  if (!slotId || !state.draftBlob) {
    return state.activeProject;
  }

  const buffer = await state.draftBlob.arrayBuffer();
  const project = await window.appApi.saveRecording({
    projectId: state.activeProjectId,
    slotId,
    buffer
  });

  const preferredSlotId = state.activeSlotId || slotId;
  setActiveProject(project);
  state.activeSlotId = project.slots.find((item) => item.id === preferredSlotId)?.id || project.slots[0]?.id || null;
  clearRecordingState();
  await refreshProjects(true);
  renderProjectDetails();
  return project;
};

runMergeAction = async function (action, task) {
  state.mergeBusy = action;
  renderProjectDetails();

  try {
    if (action === 'bundle-export') {
      elements.bundleExportStatus.textContent = '正在导出剪辑素材包...';
    } else if (action === 'preview') {
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
};

async function handleNextAction() {
  if (extIsBundle()) {
    if (state.draftBlob) {
      await persistDraftRecording();
    }
    return;
  }

  await advanceToNextSlot();
}

async function extReadUploadFiles(fileList) {
  return Promise.all(
    Array.from(fileList).map(async (file) => ({
      name: file.name,
      type: file.type,
      buffer: await file.arrayBuffer()
    }))
  );
}

async function extUploadAssets(category, fileList) {
  const slot = getActiveSlot();
  if (!slot || !fileList?.length) {
    return;
  }

  const files = await extReadUploadFiles(fileList);
  const project = await window.appApi.addAssets({
    projectId: state.activeProjectId,
    slotId: slot.id,
    category,
    files
  });
  setActiveProject(project);
  await refreshProjects(true);
}

async function extMoveAsset(category, assetId, direction) {
  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  const project = await window.appApi.moveAsset({
    projectId: state.activeProjectId,
    slotId: slot.id,
    category,
    assetId,
    direction
  });
  setActiveProject(project);
  await refreshProjects(true);
}

async function extDeleteAsset(category, assetId) {
  const slot = getActiveSlot();
  if (!slot) {
    return;
  }

  const project = await window.appApi.deleteAsset({
    projectId: state.activeProjectId,
    slotId: slot.id,
    category,
    assetId
  });
  setActiveProject(project);
  await refreshProjects(true);
}

async function exportBundlePackage() {
  await runMergeAction('bundle-export', async () => {
    const result = await window.appApi.exportBundlePackage(state.activeProjectId);
    elements.bundleExportStatus.textContent = `素材包已导出：${result.filePath}`;
    await window.appApi.revealExport(result.filePath);
  });
}

attachEvents = function () {
  elements.openCreateProjectButton.addEventListener('click', () => elements.createProjectDialog.showModal());
  elements.closeCreateProjectButton.addEventListener('click', () => elements.createProjectDialog.close());
  elements.cancelCreateProjectButton.addEventListener('click', () => elements.createProjectDialog.close());

  elements.createProjectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await withErrorBoundary(async () => {
      await createProjectFromForm(event.currentTarget);
    });
  });

  elements.refreshProjectsButton.addEventListener('click', () => withErrorBoundary(async () => refreshProjects(false)));
  elements.toggleSidebarButton.addEventListener('click', toggleSidebar);
  elements.toggleSlotsButton.addEventListener('click', toggleSlotsPanel);

  elements.projectList.addEventListener('click', (event) => {
    const target = event.target.closest('[data-project-id]');
    if (target) {
      withErrorBoundary(async () => loadProject(target.dataset.projectId));
    }
  });

  elements.slotList.addEventListener('click', (event) => {
    const target = event.target.closest('[data-slot-id]');
    if (target) {
      state.activeSlotId = target.dataset.slotId;
      renderProjectDetails();
    }
  });

  let titleTimer = null;
  elements.slotTitleInput.addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(() => {
      withErrorBoundary(async () => updateSlotTitle(elements.slotTitleInput.value));
    }, 320);
  });

  elements.trimSilenceInput.addEventListener('change', () => {
    withErrorBoundary(async () => updateMergeSettings({ trimSilence: elements.trimSilenceInput.checked }));
  });

  const bindNumeric = (input, key, fallback, min, max) => {
    const commit = () => {
      const nextValue = clamp(Number(input.value) || fallback, min, max);
      input.value = String(nextValue);
      withErrorBoundary(async () => updateMergeSettings({ [key]: nextValue }));
    };

    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        input.blur();
      }
    });
  };

  bindNumeric(elements.gapMsInput, 'gapMs', MERGE_DEFAULTS.gapMs, 0, 2000);
  bindNumeric(elements.startSilenceKeepMsInput, 'startSilenceKeepMs', MERGE_DEFAULTS.startSilenceKeepMs, 0, 300);
  bindNumeric(elements.endSilenceKeepMsInput, 'endSilenceKeepMs', MERGE_DEFAULTS.endSilenceKeepMs, 0, 300);
  bindNumeric(elements.startTrimThresholdDbInput, 'startTrimThresholdDb', MERGE_DEFAULTS.startTrimThresholdDb, -60, -20);
  bindNumeric(elements.endTrimThresholdDbInput, 'endTrimThresholdDb', MERGE_DEFAULTS.endTrimThresholdDb, -60, -20);

  elements.resetMergeDefaultsButton.addEventListener('click', () => withErrorBoundary(async () => updateMergeSettings(MERGE_DEFAULTS)));
  elements.addSlotButton.addEventListener('click', () => withErrorBoundary(addSlot));
  elements.recordToggleButton.addEventListener('click', () => withErrorBoundary(handleRecordToggle));
  elements.discardRecordButton.addEventListener('click', discardDraftRecording);
  elements.nextButton.addEventListener('click', () => withErrorBoundary(handleNextAction));
  elements.deleteAudioButton.addEventListener('click', () => withErrorBoundary(deleteAudio));
  elements.deleteSlotButton.addEventListener('click', () => withErrorBoundary(deleteSlot));
  elements.previewMergeButton.addEventListener('click', () => withErrorBoundary(previewMerge));
  elements.exportMergeButton.addEventListener('click', () => withErrorBoundary(exportMerge));
  elements.exportPackageButton.addEventListener('click', () => withErrorBoundary(exportProcessedPackage));
  elements.exportBundleButton.addEventListener('click', () => withErrorBoundary(exportBundlePackage));

  elements.uploadAudioButton.addEventListener('click', () => elements.audioUploadInput.click());
  elements.uploadVisualButton.addEventListener('click', () => elements.visualUploadInput.click());
  elements.audioUploadInput.addEventListener('change', () => {
    withErrorBoundary(async () => {
      await extUploadAssets('audio', elements.audioUploadInput.files);
      elements.audioUploadInput.value = '';
    });
  });
  elements.visualUploadInput.addEventListener('change', () => {
    withErrorBoundary(async () => {
      await extUploadAssets('visual', elements.visualUploadInput.files);
      elements.visualUploadInput.value = '';
    });
  });

  elements.bundleAssetsCard.addEventListener('click', (event) => {
    const target = event.target.closest('[data-asset-action]');
    if (!target) {
      return;
    }

    withErrorBoundary(async () => {
      if (target.dataset.assetAction === 'delete') {
        await extDeleteAsset(target.dataset.assetCategory, target.dataset.assetId);
        return;
      }

      await extMoveAsset(target.dataset.assetCategory, target.dataset.assetId, target.dataset.assetAction);
    });
  });

  const openProjectFolder = async () => window.appApi.openFolder({ projectId: state.activeProjectId, kind: 'project' });
  const openExportFolder = async () => window.appApi.openFolder({ projectId: state.activeProjectId, kind: 'exports' });

  elements.openProjectFolderButton.addEventListener('click', () => withErrorBoundary(openProjectFolder));
  elements.openExportFolderButton.addEventListener('click', () => withErrorBoundary(openExportFolder));
  elements.openProjectFolderButtonBundle.addEventListener('click', () => withErrorBoundary(openProjectFolder));
  elements.openExportFolderButtonBundle.addEventListener('click', () => withErrorBoundary(openExportFolder));

  window.addEventListener('beforeunload', () => {
    stopTimer();
    stopMeter();
    stopMediaTracks();
  });
};

init = async function () {
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
};

window.__voiceStripBoot();
