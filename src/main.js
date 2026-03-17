const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const ffmpegPath = require('ffmpeg-static');
const POWERSHELL_PATH = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const ROOT_DIR = app.getAppPath();
const DATA_DIR = path.join(ROOT_DIR, 'data', 'projects');
const DEFAULT_MERGE_SETTINGS = {
  trimSilence: true,
  gapMs: 300,
  startSilenceKeepMs: 150,
  endSilenceKeepMs: 150,
  startTrimThresholdDb: -54,
  endTrimThresholdDb: -54
};

function projectDir(projectId) {
  return path.join(DATA_DIR, projectId);
}

function projectFile(projectId) {
  return path.join(projectDir(projectId), 'project.json');
}

function segmentDir(projectId) {
  return path.join(projectDir(projectId), 'segments');
}

function exportDir(projectId) {
  return path.join(projectDir(projectId), 'exports');
}

function tempDir(projectId) {
  return path.join(projectDir(projectId), 'temp');
}

function createId() {
  return crypto.randomUUID();
}

function sanitizeFilenamePart(input) {
  const normalized = (input || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+$/g, '');

  return normalized || 'segment';
}

function formatOrder(order) {
  return String(order).padStart(2, '0');
}

function getSlotBaseName(slot) {
  return `${formatOrder(slot.order)}-${sanitizeFilenamePart(slot.title)}`;
}

function getProjectTitle(project) {
  return sanitizeFilenamePart(project.name);
}

function normalizeMergeSettings(settings) {
  const legacyThreshold = Number(settings?.trimThresholdDb);
  return {
    trimSilence: settings?.trimSilence !== false,
    gapMs: Math.min(2000, Math.max(0, Number(settings?.gapMs) || DEFAULT_MERGE_SETTINGS.gapMs)),
    startSilenceKeepMs: Math.min(
      300,
      Math.max(0, Number(settings?.startSilenceKeepMs) || DEFAULT_MERGE_SETTINGS.startSilenceKeepMs)
    ),
    endSilenceKeepMs: Math.min(300, Math.max(0, Number(settings?.endSilenceKeepMs) || DEFAULT_MERGE_SETTINGS.endSilenceKeepMs)),
    startTrimThresholdDb: Math.min(
      -20,
      Math.max(-60, Number(settings?.startTrimThresholdDb) || legacyThreshold || DEFAULT_MERGE_SETTINGS.startTrimThresholdDb)
    ),
    endTrimThresholdDb: Math.min(
      -20,
      Math.max(-60, Number(settings?.endTrimThresholdDb) || (Number.isFinite(legacyThreshold) ? legacyThreshold - 4 : NaN) || DEFAULT_MERGE_SETTINGS.endTrimThresholdDb)
    )
  };
}

function ensureProjectShape(project) {
  project.slots = Array.isArray(project.slots) ? project.slots : [];
  project.slots = project.slots.map((slot, index) => ({
    id: slot.id || createId(),
    order: index + 1,
    title: slot.title || `segment-${index + 1}`,
    audioFile: slot.audioFile || null,
    durationMs: slot.durationMs || null,
    createdAt: slot.createdAt || new Date().toISOString(),
    updatedAt: slot.updatedAt || new Date().toISOString()
  }));
  project.mergeSettings = normalizeMergeSettings(project.mergeSettings);
  return project;
}

async function ensureBaseDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function ensureProjectDirs(projectId) {
  await Promise.all([
    fsp.mkdir(projectDir(projectId), { recursive: true }),
    fsp.mkdir(segmentDir(projectId), { recursive: true }),
    fsp.mkdir(exportDir(projectId), { recursive: true }),
    fsp.mkdir(tempDir(projectId), { recursive: true })
  ]);
}

async function readProject(projectId) {
  const raw = await fsp.readFile(projectFile(projectId), 'utf8');
  return ensureProjectShape(JSON.parse(raw));
}

async function saveProject(project) {
  project.updatedAt = new Date().toISOString();
  await ensureProjectDirs(project.id);
  await fsp.writeFile(projectFile(project.id), JSON.stringify(project, null, 2), 'utf8');
  return project;
}

async function listProjects() {
  await ensureBaseDirs();
  const entries = await fsp.readdir(DATA_DIR, { withFileTypes: true });
  const projects = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const filePath = path.join(DATA_DIR, entry.name, 'project.json');
    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      const raw = await fsp.readFile(filePath, 'utf8');
      const project = ensureProjectShape(JSON.parse(raw));
      projects.push({
        id: project.id,
        name: project.name,
        format: project.format,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        totalSlots: project.slots.length,
        recordedSlots: project.slots.filter((slot) => Boolean(slot.audioFile)).length
      });
    } catch (error) {
      console.error(`Failed to load project at ${filePath}`, error);
    }
  }

  projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return projects;
}

async function createProject({ name, format }) {
  const id = createId();
  const now = new Date().toISOString();
  const project = {
    id,
    name: (name || '').trim() || '未命名项目',
    format: format === 'wav' ? 'wav' : 'mp3',
    mergeSettings: { ...DEFAULT_MERGE_SETTINGS },
    createdAt: now,
    updatedAt: now,
    slots: [
      {
        id: createId(),
        order: 1,
        title: 'segment-1',
        audioFile: null,
        durationMs: null,
        createdAt: now,
        updatedAt: now
      }
    ]
  };

  await saveProject(project);
  return project;
}

async function updateMergeSettings(projectId, mergeSettings) {
  const project = await readProject(projectId);
  project.mergeSettings = normalizeMergeSettings({
    ...project.mergeSettings,
    ...mergeSettings
  });
  await saveProject(project);
  return project;
}

async function renameSegmentFile(projectId, oldFile, newFile) {
  if (!oldFile || oldFile === newFile) {
    return;
  }

  const oldPath = path.join(segmentDir(projectId), oldFile);
  const newPath = path.join(segmentDir(projectId), newFile);

  if (!fs.existsSync(oldPath)) {
    return;
  }

  if (fs.existsSync(newPath)) {
    await fsp.unlink(newPath);
  }

  await fsp.rename(oldPath, newPath);
}

async function normalizeSlotFiles(project) {
  for (const [index, slot] of project.slots.entries()) {
    slot.order = index + 1;
    if (slot.audioFile) {
      const extension = path.extname(slot.audioFile);
      const desiredFile = `${getSlotBaseName(slot)}${extension}`;
      await renameSegmentFile(project.id, slot.audioFile, desiredFile);
      slot.audioFile = desiredFile;
    }
  }
}

async function updateSlot(projectId, slotId, changes) {
  const project = await readProject(projectId);
  const slot = project.slots.find((item) => item.id === slotId);

  if (!slot) {
    throw new Error('未找到目标音频槽。');
  }

  if (typeof changes.title === 'string') {
    slot.title = changes.title.trim() || `segment-${slot.order}`;
    slot.updatedAt = new Date().toISOString();
  }

  await normalizeSlotFiles(project);
  await saveProject(project);
  return project;
}

async function addSlot(projectId) {
  const project = await readProject(projectId);
  const now = new Date().toISOString();
  project.slots.push({
    id: createId(),
    order: project.slots.length + 1,
    title: `segment-${project.slots.length + 1}`,
    audioFile: null,
    durationMs: null,
    createdAt: now,
    updatedAt: now
  });
  await normalizeSlotFiles(project);
  await saveProject(project);
  return project;
}

async function advanceToNextSlot(projectId, slotId) {
  const project = await readProject(projectId);
  const currentIndex = project.slots.findIndex((item) => item.id === slotId);

  if (currentIndex === -1) {
    throw new Error('当前音频槽不存在。');
  }

  let nextSlot = project.slots[currentIndex + 1];
  if (!nextSlot) {
    const now = new Date().toISOString();
    nextSlot = {
      id: createId(),
      order: project.slots.length + 1,
      title: `segment-${project.slots.length + 1}`,
      audioFile: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now
    };
    project.slots.push(nextSlot);
    await saveProject(project);
  }

  return {
    project,
    slotId: nextSlot.id
  };
}

async function deleteAudio(projectId, slotId) {
  const project = await readProject(projectId);
  const slot = project.slots.find((item) => item.id === slotId);

  if (!slot) {
    throw new Error('未找到要删除的音频槽。');
  }

  if (slot.audioFile) {
    const filePath = path.join(segmentDir(projectId), slot.audioFile);
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
    }
  }

  slot.audioFile = null;
  slot.durationMs = null;
  slot.updatedAt = new Date().toISOString();
  await saveProject(project);
  return project;
}

async function deleteSlot(projectId, slotId) {
  const project = await readProject(projectId);
  const slotIndex = project.slots.findIndex((item) => item.id === slotId);

  if (slotIndex === -1) {
    throw new Error('未找到要删除的音频槽。');
  }

  const slot = project.slots[slotIndex];
  if (slot.audioFile) {
    throw new Error('请先删除该槽位里的音频，再删除槽位。');
  }

  project.slots.splice(slotIndex, 1);

  if (project.slots.length === 0) {
    const now = new Date().toISOString();
    project.slots.push({
      id: createId(),
      order: 1,
      title: 'segment-1',
      audioFile: null,
      durationMs: null,
      createdAt: now,
      updatedAt: now
    });
  }

  await normalizeSlotFiles(project);
  await saveProject(project);
  return project;
}

async function runFfmpeg(args) {
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';

    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

async function runPowerShell(command) {
  await new Promise((resolve, reject) => {
    const proc = spawn(POWERSHELL_PATH, ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true
    });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr || `PowerShell exited with code ${code}`));
    });
  });
}

function buildOutputCodec(format) {
  if (format === 'wav') {
    return ['-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1'];
  }

  return ['-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '48000', '-ac', '1'];
}

async function convertRecording(project, slot, buffer) {
  await ensureProjectDirs(project.id);

  const tempInput = path.join(tempDir(project.id), `${slot.id}-input.webm`);
  const outputFile = `${getSlotBaseName(slot)}.${project.format}`;
  const outputPath = path.join(segmentDir(project.id), outputFile);
  const tempOutput = path.join(tempDir(project.id), `${slot.id}.${project.format}`);

  await fsp.writeFile(tempInput, Buffer.from(buffer));

  await runFfmpeg([
    '-y',
    '-i',
    tempInput,
    ...buildOutputCodec(project.format),
    tempOutput
  ]);

  if (slot.audioFile) {
    const oldPath = path.join(segmentDir(project.id), slot.audioFile);
    if (fs.existsSync(oldPath)) {
      await fsp.unlink(oldPath);
    }
  }

  await fsp.copyFile(tempOutput, outputPath);
  await Promise.allSettled([fsp.unlink(tempInput), fsp.unlink(tempOutput)]);

  slot.audioFile = outputFile;
  slot.updatedAt = new Date().toISOString();
}

async function getDurationMs(filePath) {
  return new Promise((resolve) => {
    const ffmpeg = spawn(ffmpegPath, ['-i', filePath], { windowsHide: true });
    let stderr = '';
    ffmpeg.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    ffmpeg.on('close', () => {
      const match = stderr.match(/Duration:\s(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!match) {
        resolve(null);
        return;
      }

      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      const seconds = Number(match[3]);
      resolve(Math.round((hours * 3600 + minutes * 60 + seconds) * 1000));
    });
    ffmpeg.on('error', () => resolve(null));
  });
}

async function saveRecording(projectId, slotId, arrayBuffer) {
  const project = await readProject(projectId);
  const slot = project.slots.find((item) => item.id === slotId);

  if (!slot) {
    throw new Error('未找到目标音频槽。');
  }

  await convertRecording(project, slot, arrayBuffer);
  slot.durationMs = await getDurationMs(path.join(segmentDir(project.id), slot.audioFile));
  await saveProject(project);
  return project;
}

function getProcessedSegmentPath(projectId, slot, format) {
  return path.join(tempDir(projectId), `${formatOrder(slot.order)}-${slot.id}-processed.${format}`);
}

function getPackagedSegmentPath(projectId, slot, format) {
  return path.join(tempDir(projectId), `${getSlotBaseName(slot)}.${format}`);
}

function getGapFilePath(projectId, format, gapMs) {
  return path.join(tempDir(projectId), `gap-${gapMs}ms.${format}`);
}

function buildTrimFilter(mergeSettings) {
  const normalized = normalizeMergeSettings(mergeSettings);
  const trimStart = `silenceremove=start_periods=1:start_duration=0.12:start_threshold=${normalized.startTrimThresholdDb}dB:start_silence=${(
    normalized.startSilenceKeepMs / 1000
  ).toFixed(3)}`;
  const trimEnd = `silenceremove=start_periods=1:start_duration=0.18:start_threshold=${normalized.endTrimThresholdDb}dB:start_silence=${(
    normalized.endSilenceKeepMs / 1000
  ).toFixed(3)}`;
  return `${trimStart},areverse,${trimEnd},areverse`;
}

function buildAudioFilter({ trimSilence, mergeSettings, padStartMs = 0, padEndMs = 0 }) {
  const filters = [];

  if (trimSilence) {
    filters.push(buildTrimFilter(mergeSettings));
  }

  if (padStartMs > 0) {
    filters.push(`adelay=${Math.round(padStartMs)}:all=1`);
  }

  if (padEndMs > 0) {
    filters.push(`apad=pad_dur=${(padEndMs / 1000).toFixed(3)}`);
  }

  return filters.length ? filters.join(',') : null;
}

async function renderProcessedSegment(project, slot) {
  const sourcePath = path.join(segmentDir(project.id), slot.audioFile);
  const outputPath = getProcessedSegmentPath(project.id, slot, project.format);
  const args = ['-y', '-hide_banner', '-i', sourcePath];

  const filter = buildAudioFilter({
    trimSilence: project.mergeSettings.trimSilence,
    mergeSettings: project.mergeSettings
  });

  if (filter) {
    args.push('-af', filter);
  }

  args.push(...buildOutputCodec(project.format), outputPath);
  await runFfmpeg(args);
  return outputPath;
}

async function renderPackagedSegment(project, slot, index, totalSlots) {
  const sourcePath = path.join(segmentDir(project.id), slot.audioFile);
  const outputPath = getPackagedSegmentPath(project.id, slot, project.format);
  const halfGapMs = project.mergeSettings.gapMs / 2;
  const filter = buildAudioFilter({
    trimSilence: project.mergeSettings.trimSilence,
    mergeSettings: project.mergeSettings,
    padStartMs: index > 0 ? halfGapMs : 0,
    padEndMs: index < totalSlots - 1 ? halfGapMs : 0
  });
  const args = ['-y', '-hide_banner', '-i', sourcePath];

  if (filter) {
    args.push('-af', filter);
  }

  args.push(...buildOutputCodec(project.format), outputPath);
  await runFfmpeg(args);
  return outputPath;
}

async function ensureGapFile(project, gapMs) {
  if (gapMs <= 0) {
    return null;
  }

  const outputPath = getGapFilePath(project.id, project.format, gapMs);
  if (fs.existsSync(outputPath)) {
    return outputPath;
  }

  const durationSeconds = (gapMs / 1000).toFixed(3);
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=48000:cl=mono`,
    '-t',
    durationSeconds,
    ...buildOutputCodec(project.format),
    outputPath
  ]);

  return outputPath;
}

async function buildMergeList(project, recordedSlots, mode) {
  const mergeSettings = normalizeMergeSettings(project.mergeSettings);
  const listPath = path.join(tempDir(project.id), `concat-${mode}.txt`);
  const shouldPreprocess = mergeSettings.trimSilence || mergeSettings.gapMs > 0;

  if (!shouldPreprocess) {
    const listContent = recordedSlots
      .map((slot) => {
        const absolutePath = path.join(segmentDir(project.id), slot.audioFile).replace(/\\/g, '/').replace(/'/g, "'\\''");
        return `file '${absolutePath}'`;
      })
      .join('\n');

    await fsp.writeFile(listPath, listContent, 'utf8');
    return listPath;
  }

  const processedFiles = [];
  const gapFilePath = await ensureGapFile(project, mergeSettings.gapMs);

  for (const [index, slot] of recordedSlots.entries()) {
    const processedSegmentPath = await renderProcessedSegment(project, slot);
    processedFiles.push(processedSegmentPath);

    if (gapFilePath && index < recordedSlots.length - 1) {
      processedFiles.push(gapFilePath);
    }
  }

  const listContent = processedFiles
    .map((filePath) => `file '${filePath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');

  await fsp.writeFile(listPath, listContent, 'utf8');
  return listPath;
}

function buildExportBaseName(project) {
  return `${getProjectTitle(project)}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

async function createZipArchive(filePaths, outputPath) {
  const pathsExpression = filePaths
    .map((filePath) => `'${filePath.replace(/'/g, "''")}'`)
    .join(', ');
  const escapedOutputPath = outputPath.replace(/'/g, "''");

  await runPowerShell(
    `Compress-Archive -Path ${pathsExpression} -DestinationPath '${escapedOutputPath}' -Force`
  );
}

async function buildMergedFile(projectId, mode) {
  const project = await readProject(projectId);
  const recordedSlots = project.slots.filter((slot) => slot.audioFile);

  if (recordedSlots.length === 0) {
    throw new Error('当前项目还没有可合并的音频。');
  }

  await ensureProjectDirs(project.id);

  const outputName =
    mode === 'preview'
      ? `preview.${project.format}`
      : `${buildExportBaseName(project)}.${project.format}`;
  const outputPath =
    mode === 'preview'
      ? path.join(tempDir(project.id), outputName)
      : path.join(exportDir(project.id), outputName);
  const concatListPath = await buildMergeList(project, recordedSlots, mode);
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatListPath,
    ...buildOutputCodec(project.format),
    outputPath
  ]);

  return {
    filePath: outputPath,
    fileUrl: `${pathToFileURL(outputPath).href}?v=${Date.now()}`,
    project
  };
}

async function exportProcessedSegments(projectId) {
  const project = await readProject(projectId);
  const recordedSlots = project.slots.filter((slot) => slot.audioFile);

  if (recordedSlots.length === 0) {
    throw new Error('当前项目还没有可导出的音频。');
  }

  await ensureProjectDirs(project.id);

  const processedFiles = [];
  for (const [index, slot] of recordedSlots.entries()) {
    processedFiles.push(await renderPackagedSegment(project, slot, index, recordedSlots.length));
  }

  const zipPath = path.join(exportDir(project.id), `${buildExportBaseName(project)}-segments.zip`);
  await createZipArchive(processedFiles, zipPath);

  return {
    filePath: zipPath,
    fileUrl: `${pathToFileURL(zipPath).href}?v=${Date.now()}`,
    project
  };
}

function serializeProject(project) {
  return {
    ...project,
    projectPath: projectDir(project.id),
    exportPath: exportDir(project.id),
    slots: project.slots.map((slot) => ({
      ...slot,
      fileUrl: slot.audioFile ? pathToFileURL(path.join(segmentDir(project.id), slot.audioFile)).href : null,
      filePath: slot.audioFile ? path.join(segmentDir(project.id), slot.audioFile) : null
    }))
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: '#efe2d1',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  await ensureBaseDirs();

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('projects:list', async () => {
  return listProjects();
});

ipcMain.handle('projects:create', async (_event, payload) => {
  const project = await createProject(payload);
  return serializeProject(project);
});

ipcMain.handle('projects:get', async (_event, projectId) => {
  const project = await readProject(projectId);
  return serializeProject(project);
});

ipcMain.handle('projects:updateSlot', async (_event, payload) => {
  const project = await updateSlot(payload.projectId, payload.slotId, payload.changes);
  return serializeProject(project);
});

ipcMain.handle('projects:updateMergeSettings', async (_event, payload) => {
  const project = await updateMergeSettings(payload.projectId, payload.mergeSettings);
  return serializeProject(project);
});

ipcMain.handle('projects:addSlot', async (_event, projectId) => {
  const project = await addSlot(projectId);
  return serializeProject(project);
});

ipcMain.handle('projects:advanceSlot', async (_event, payload) => {
  const result = await advanceToNextSlot(payload.projectId, payload.slotId);
  return {
    project: serializeProject(result.project),
    slotId: result.slotId
  };
});

ipcMain.handle('projects:deleteAudio', async (_event, payload) => {
  const project = await deleteAudio(payload.projectId, payload.slotId);
  return serializeProject(project);
});

ipcMain.handle('projects:deleteSlot', async (_event, payload) => {
  const project = await deleteSlot(payload.projectId, payload.slotId);
  return serializeProject(project);
});

ipcMain.handle('projects:saveRecording', async (_event, payload) => {
  const project = await saveRecording(payload.projectId, payload.slotId, payload.buffer);
  return serializeProject(project);
});

ipcMain.handle('projects:previewMerge', async (_event, projectId) => {
  return buildMergedFile(projectId, 'preview');
});

ipcMain.handle('projects:exportMerge', async (_event, projectId) => {
  return buildMergedFile(projectId, 'export');
});

ipcMain.handle('projects:exportProcessedSegments', async (_event, projectId) => {
  return exportProcessedSegments(projectId);
});

ipcMain.handle('projects:openFolder', async (_event, payload) => {
  const targetPath = payload?.kind === 'exports' ? exportDir(payload.projectId) : projectDir(payload.projectId);
  await shell.openPath(targetPath);
  return true;
});

ipcMain.handle('dialog:revealExport', async (_event, filePath) => {
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('dialog:message', async (_event, payload) => {
  return dialog.showMessageBox({
    type: payload.type || 'info',
    title: payload.title || '提示',
    message: payload.message || ''
  });
});
