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

function bundleAssetRootDir(projectId) {
  return path.join(projectDir(projectId), 'bundle-assets');
}

function slotAssetDir(projectId, slotId) {
  return path.join(bundleAssetRootDir(projectId), slotId);
}

function slotAssetCategoryDir(projectId, slotId, category) {
  return path.join(slotAssetDir(projectId, slotId), category);
}

function createId() {
  return crypto.randomUUID();
}

function getProjectType(project) {
  return project?.type === 'bundle' ? 'bundle' : 'audio';
}

function sanitizeFilenamePart(input) {
  const normalized = (input || '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, '-')
    .replace(/\.+$/g, '');

  return normalized || 'segment';
}

function sanitizeExtension(extension, fallback = '.bin') {
  const cleaned = String(extension || '')
    .trim()
    .toLowerCase()
    .replace(/[^.\w-]/g, '');

  if (cleaned.startsWith('.') && cleaned.length <= 16) {
    return cleaned;
  }

  return fallback;
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

function detectVisualMediaKind(name = '', mimeType = '') {
  const loweredType = String(mimeType || '').toLowerCase();
  if (loweredType.startsWith('image/')) {
    return 'image';
  }
  if (loweredType.startsWith('video/')) {
    return 'video';
  }

  const extension = path.extname(String(name || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg'].includes(extension)) {
    return 'image';
  }

  return 'video';
}

function createSlot(order, now) {
  return {
    id: createId(),
    order,
    title: `segment-${order}`,
    audioFile: null,
    durationMs: null,
    audioItems: [],
    visualItems: [],
    createdAt: now,
    updatedAt: now
  };
}

function normalizeAssetItems(items, category) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    id: item.id || createId(),
    order: index + 1,
    fileName: item.fileName || '',
    originalName: item.originalName || item.label || `${category}-${index + 1}`,
    label: item.label || path.parse(item.originalName || `${category}-${index + 1}`).name,
    source: item.source === 'recorded' ? 'recorded' : 'uploaded',
    mediaKind: category === 'audio' ? 'audio' : detectVisualMediaKind(item.originalName || item.fileName, item.mimeType),
    mimeType: item.mimeType || '',
    durationMs: Number(item.durationMs) || null,
    createdAt: item.createdAt || new Date().toISOString(),
    updatedAt: item.updatedAt || new Date().toISOString()
  }));
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
  const projectType = getProjectType(project);
  project.type = projectType;
  project.format = project.format === 'wav' ? 'wav' : 'mp3';
  project.slots = Array.isArray(project.slots) ? project.slots : [];
  project.slots = project.slots.map((slot, index) => ({
    id: slot.id || createId(),
    order: index + 1,
    title: slot.title || `segment-${index + 1}`,
    audioFile: projectType === 'audio' ? slot.audioFile || null : null,
    durationMs: projectType === 'audio' ? slot.durationMs || null : null,
    audioItems: projectType === 'bundle' ? normalizeAssetItems(slot.audioItems, 'audio') : [],
    visualItems: projectType === 'bundle' ? normalizeAssetItems(slot.visualItems, 'visual') : [],
    createdAt: slot.createdAt || new Date().toISOString(),
    updatedAt: slot.updatedAt || new Date().toISOString()
  }));
  project.mergeSettings = normalizeMergeSettings(project.mergeSettings);
  return project;
}

function getRecordedSlotCount(project) {
  if (getProjectType(project) === 'bundle') {
    return project.slots.filter((slot) => slot.audioItems.length > 0 || slot.visualItems.length > 0).length;
  }

  return project.slots.filter((slot) => Boolean(slot.audioFile)).length;
}

async function ensureBaseDirs() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function ensureProjectDirs(projectId) {
  await Promise.all([
    fsp.mkdir(projectDir(projectId), { recursive: true }),
    fsp.mkdir(segmentDir(projectId), { recursive: true }),
    fsp.mkdir(exportDir(projectId), { recursive: true }),
    fsp.mkdir(tempDir(projectId), { recursive: true }),
    fsp.mkdir(bundleAssetRootDir(projectId), { recursive: true })
  ]);
}

async function ensureSlotAssetDirs(projectId, slotId) {
  await Promise.all([
    fsp.mkdir(slotAssetCategoryDir(projectId, slotId, 'audio'), { recursive: true }),
    fsp.mkdir(slotAssetCategoryDir(projectId, slotId, 'visual'), { recursive: true })
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
        type: project.type,
        format: project.format,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        totalSlots: project.slots.length,
        recordedSlots: getRecordedSlotCount(project)
      });
    } catch (error) {
      console.error(`Failed to load project at ${filePath}`, error);
    }
  }

  projects.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return projects;
}

async function createProject({ name, format, projectType }) {
  const id = createId();
  const now = new Date().toISOString();
  const project = {
    id,
    type: projectType === 'bundle' ? 'bundle' : 'audio',
    name: (name || '').trim() || '未命名项目',
    format: format === 'wav' ? 'wav' : 'mp3',
    name: (name || '').trim() || '未命名项目',
    mergeSettings: { ...DEFAULT_MERGE_SETTINGS },
    createdAt: now,
    updatedAt: now,
    slots: [createSlot(1, now)]
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
    if (getProjectType(project) === 'audio' && slot.audioFile) {
      const extension = path.extname(slot.audioFile);
      const desiredFile = `${getSlotBaseName(slot)}${extension}`;
      await renameSegmentFile(project.id, slot.audioFile, desiredFile);
      slot.audioFile = desiredFile;
    }

    if (getProjectType(project) === 'bundle') {
      slot.audioItems = normalizeAssetItems(slot.audioItems, 'audio');
      slot.visualItems = normalizeAssetItems(slot.visualItems, 'visual');
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
  project.slots.push(createSlot(project.slots.length + 1, now));
  await normalizeSlotFiles(project);
  await saveProject(project);
  return project;
}

async function advanceToNextSlot(projectId, slotId) {
  const project = await readProject(projectId);
  if (getProjectType(project) !== 'audio') {
    throw new Error('只有录音项目支持“下一条”流程。');
  }
  const currentIndex = project.slots.findIndex((item) => item.id === slotId);

  if (currentIndex === -1) {
    throw new Error('当前音频槽不存在。');
  }

  let nextSlot = project.slots[currentIndex + 1];
  if (!nextSlot) {
    const now = new Date().toISOString();
    nextSlot = createSlot(project.slots.length + 1, now);
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
  if (getProjectType(project) !== 'audio') {
    throw new Error('打包项目请在素材列表里逐条删除音频素材。');
  }

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

function buildAssetLabel(asset, fallbackPrefix, index) {
  const baseName = path.parse(asset.originalName || asset.label || `${fallbackPrefix}-${index + 1}`).name;
  return sanitizeFilenamePart(baseName || `${fallbackPrefix}-${index + 1}`);
}

function getAssetCollection(slot, category) {
  if (category === 'audio') {
    return slot.audioItems;
  }
  if (category === 'visual') {
    return slot.visualItems;
  }
  throw new Error('不支持的素材类型。');
}

function assertAudioProject(project) {
  if (getProjectType(project) !== 'audio') {
    throw new Error('打包项目不支持音频合并，请使用“导出剪辑素材包”。');
  }
}

async function createProject({ name, format, projectType }) {
  const id = createId();
  const now = new Date().toISOString();
  const project = {
    id,
    type: projectType === 'bundle' ? 'bundle' : 'audio',
    name: (name || '').trim() || '未命名项目',
    format: format === 'wav' ? 'wav' : 'mp3',
    mergeSettings: { ...DEFAULT_MERGE_SETTINGS },
    createdAt: now,
    updatedAt: now,
    slots: [createSlot(1, now)]
  };

  await saveProject(project);
  return project;
}

async function deleteSlot(projectId, slotId) {
  const project = await readProject(projectId);
  const slotIndex = project.slots.findIndex((item) => item.id === slotId);

  if (slotIndex === -1) {
    throw new Error('未找到要删除的分片。');
  }

  const slot = project.slots[slotIndex];
  if (getProjectType(project) === 'audio' && slot.audioFile) {
    throw new Error('请先删除该槽位里的音频，再删除槽位。');
  }

  if (getProjectType(project) === 'bundle' && (slot.audioItems.length > 0 || slot.visualItems.length > 0)) {
    throw new Error('请先删除该分片里的音频和画面素材，再删除分片。');
  }

  project.slots.splice(slotIndex, 1);

  if (project.slots.length === 0) {
    const now = new Date().toISOString();
    project.slots.push(createSlot(1, now));
  }

  if (getProjectType(project) === 'bundle') {
    await fsp.rm(slotAssetDir(projectId, slotId), { recursive: true, force: true });
  }

  await normalizeSlotFiles(project);
  await saveProject(project);
  return project;
}

async function convertAudioRecordingToSlot(project, slot, buffer) {
  await ensureProjectDirs(project.id);

  const tempInput = path.join(tempDir(project.id), `${slot.id}-input.webm`);
  const outputFile = `${getSlotBaseName(slot)}.${project.format}`;
  const outputPath = path.join(segmentDir(project.id), outputFile);
  const tempOutput = path.join(tempDir(project.id), `${slot.id}.${project.format}`);

  await fsp.writeFile(tempInput, Buffer.from(buffer));
  await runFfmpeg(['-y', '-i', tempInput, ...buildOutputCodec(project.format), tempOutput]);

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
  slot.durationMs = await getDurationMs(outputPath);
}

async function appendRecordedBundleAudio(project, slot, buffer) {
  await ensureProjectDirs(project.id);
  await ensureSlotAssetDirs(project.id, slot.id);

  const assetId = createId();
  const tempInput = path.join(tempDir(project.id), `${assetId}-input.webm`);
  const tempOutput = path.join(tempDir(project.id), `${assetId}.${project.format}`);
  const outputFile = `recorded-${assetId}.${project.format}`;
  const outputPath = path.join(slotAssetCategoryDir(project.id, slot.id, 'audio'), outputFile);

  await fsp.writeFile(tempInput, Buffer.from(buffer));
  await runFfmpeg(['-y', '-i', tempInput, ...buildOutputCodec(project.format), tempOutput]);
  await fsp.copyFile(tempOutput, outputPath);
  await Promise.allSettled([fsp.unlink(tempInput), fsp.unlink(tempOutput)]);

  slot.audioItems.push({
    id: assetId,
    order: slot.audioItems.length + 1,
    fileName: outputFile,
    originalName: `recorded-${slot.audioItems.length + 1}.${project.format}`,
    label: `audio-${slot.audioItems.length + 1}`,
    source: 'recorded',
    mediaKind: 'audio',
    mimeType: project.format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    durationMs: await getDurationMs(outputPath),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  slot.audioItems = normalizeAssetItems(slot.audioItems, 'audio');
  slot.updatedAt = new Date().toISOString();
}

async function saveRecording(projectId, slotId, arrayBuffer) {
  const project = await readProject(projectId);
  const slot = project.slots.find((item) => item.id === slotId);

  if (!slot) {
    throw new Error('未找到目标分片。');
  }

  if (getProjectType(project) === 'bundle') {
    await appendRecordedBundleAudio(project, slot, arrayBuffer);
  } else {
    await convertAudioRecordingToSlot(project, slot, arrayBuffer);
  }

  await saveProject(project);
  return project;
}

async function addAssets(projectId, slotId, category, files) {
  const project = await readProject(projectId);
  if (getProjectType(project) !== 'bundle') {
    throw new Error('只有打包项目支持上传素材。');
  }

  const slot = project.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到目标分片。');
  }

  const items = getAssetCollection(slot, category);
  await ensureSlotAssetDirs(project.id, slot.id);

  for (const file of Array.isArray(files) ? files : []) {
    const extension = sanitizeExtension(path.extname(file.name), category === 'audio' ? `.${project.format}` : '.bin');
    const assetId = createId();
    const storedFileName = `${category}-${assetId}${extension}`;
    const assetPath = path.join(slotAssetCategoryDir(project.id, slot.id, category), storedFileName);
    await fsp.writeFile(assetPath, Buffer.from(file.buffer));

    items.push({
      id: assetId,
      order: items.length + 1,
      fileName: storedFileName,
      originalName: file.name || `${category}-${items.length + 1}${extension}`,
      label: path.parse(file.name || `${category}-${items.length + 1}${extension}`).name,
      source: 'uploaded',
      mediaKind: category === 'audio' ? 'audio' : detectVisualMediaKind(file.name, file.type),
      mimeType: file.type || '',
      durationMs: category === 'audio' ? await getDurationMs(assetPath) : null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  slot.audioItems = normalizeAssetItems(slot.audioItems, 'audio');
  slot.visualItems = normalizeAssetItems(slot.visualItems, 'visual');
  slot.updatedAt = new Date().toISOString();
  await saveProject(project);
  return project;
}

async function moveAsset(projectId, slotId, category, assetId, direction) {
  const project = await readProject(projectId);
  if (getProjectType(project) !== 'bundle') {
    throw new Error('只有打包项目支持素材排序。');
  }

  const slot = project.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到目标分片。');
  }

  const items = getAssetCollection(slot, category);
  const currentIndex = items.findIndex((item) => item.id === assetId);
  if (currentIndex === -1) {
    throw new Error('未找到目标素材。');
  }

  const nextIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0 || nextIndex >= items.length) {
    return project;
  }

  const [asset] = items.splice(currentIndex, 1);
  items.splice(nextIndex, 0, asset);
  slot.audioItems = normalizeAssetItems(slot.audioItems, 'audio');
  slot.visualItems = normalizeAssetItems(slot.visualItems, 'visual');
  slot.updatedAt = new Date().toISOString();
  await saveProject(project);
  return project;
}

async function deleteAsset(projectId, slotId, category, assetId) {
  const project = await readProject(projectId);
  if (getProjectType(project) !== 'bundle') {
    throw new Error('只有打包项目支持删除素材。');
  }

  const slot = project.slots.find((item) => item.id === slotId);
  if (!slot) {
    throw new Error('未找到目标分片。');
  }

  const items = getAssetCollection(slot, category);
  const assetIndex = items.findIndex((item) => item.id === assetId);
  if (assetIndex === -1) {
    throw new Error('未找到目标素材。');
  }

  const [asset] = items.splice(assetIndex, 1);
  const assetPath = path.join(slotAssetCategoryDir(project.id, slot.id, category), asset.fileName);
  if (fs.existsSync(assetPath)) {
    await fsp.unlink(assetPath);
  }

  slot.audioItems = normalizeAssetItems(slot.audioItems, 'audio');
  slot.visualItems = normalizeAssetItems(slot.visualItems, 'visual');
  slot.updatedAt = new Date().toISOString();
  await saveProject(project);
  return project;
}

async function createDirectoryArchive(sourceDir, outputPath) {
  const escapedSourceDir = sourceDir.replace(/'/g, "''");
  const escapedOutputPath = outputPath.replace(/'/g, "''");
  await runPowerShell(
    `$paths = Join-Path '${escapedSourceDir}' '*'; Compress-Archive -Path $paths -DestinationPath '${escapedOutputPath}' -Force`
  );
}

async function buildMergedFile(projectId, mode) {
  const project = await readProject(projectId);
  assertAudioProject(project);
  const recordedSlots = project.slots.filter((slot) => slot.audioFile);

  if (recordedSlots.length === 0) {
    throw new Error('当前项目还没有可合并的音频。');
  }

  await ensureProjectDirs(project.id);

  const outputName = mode === 'preview' ? `preview.${project.format}` : `${buildExportBaseName(project)}.${project.format}`;
  const outputPath = mode === 'preview' ? path.join(tempDir(project.id), outputName) : path.join(exportDir(project.id), outputName);
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
  assertAudioProject(project);
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

async function exportBundlePackage(projectId) {
  const project = await readProject(projectId);
  if (getProjectType(project) !== 'bundle') {
    throw new Error('只有打包项目支持导出剪辑素材包。');
  }

  const hasAssets = project.slots.some((slot) => slot.audioItems.length > 0 || slot.visualItems.length > 0);
  if (!hasAssets) {
    throw new Error('当前项目还没有可导出的音频或画面素材。');
  }

  await ensureProjectDirs(project.id);
  const exportBaseName = buildExportBaseName(project);
  const stagingDir = path.join(tempDir(project.id), `${exportBaseName}-bundle`);
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await fsp.mkdir(stagingDir, { recursive: true });

  for (const slot of project.slots) {
    const segmentFolder = path.join(stagingDir, getSlotBaseName(slot));
    const audioFolder = path.join(segmentFolder, 'audio');
    const visualFolder = path.join(segmentFolder, 'visual');
    await Promise.all([fsp.mkdir(audioFolder, { recursive: true }), fsp.mkdir(visualFolder, { recursive: true })]);

    for (const [index, asset] of slot.audioItems.entries()) {
      const sourcePath = path.join(slotAssetCategoryDir(project.id, slot.id, 'audio'), asset.fileName);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }

      const extension = sanitizeExtension(path.extname(asset.originalName || asset.fileName), `.${project.format}`);
      const targetPath = path.join(audioFolder, `${formatOrder(index + 1)}-${buildAssetLabel(asset, 'audio', index)}${extension}`);
      await fsp.copyFile(sourcePath, targetPath);
    }

    for (const [index, asset] of slot.visualItems.entries()) {
      const sourcePath = path.join(slotAssetCategoryDir(project.id, slot.id, 'visual'), asset.fileName);
      if (!fs.existsSync(sourcePath)) {
        continue;
      }

      const extension = sanitizeExtension(path.extname(asset.originalName || asset.fileName), '.bin');
      const targetPath = path.join(
        visualFolder,
        `${formatOrder(index + 1)}-${buildAssetLabel(asset, 'visual', index)}${extension}`
      );
      await fsp.copyFile(sourcePath, targetPath);
    }
  }

  const zipPath = path.join(exportDir(project.id), `${exportBaseName}-bundle.zip`);
  await createDirectoryArchive(stagingDir, zipPath);

  return {
    filePath: zipPath,
    fileUrl: `${pathToFileURL(zipPath).href}?v=${Date.now()}`,
    project
  };
}

function serializeAsset(projectId, slotId, category, asset) {
  const absolutePath = path.join(slotAssetCategoryDir(projectId, slotId, category), asset.fileName);
  return {
    ...asset,
    filePath: fs.existsSync(absolutePath) ? absolutePath : null,
    fileUrl: fs.existsSync(absolutePath) ? `${pathToFileURL(absolutePath).href}?v=${Date.now()}` : null
  };
}

function serializeProject(project) {
  return {
    ...project,
    projectPath: projectDir(project.id),
    exportPath: exportDir(project.id),
    slots: project.slots.map((slot) => ({
      ...slot,
      fileUrl: slot.audioFile ? `${pathToFileURL(path.join(segmentDir(project.id), slot.audioFile)).href}?v=${Date.now()}` : null,
      filePath: slot.audioFile ? path.join(segmentDir(project.id), slot.audioFile) : null,
      audioItems: slot.audioItems.map((asset) => serializeAsset(project.id, slot.id, 'audio', asset)),
      visualItems: slot.visualItems.map((asset) => serializeAsset(project.id, slot.id, 'visual', asset))
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

ipcMain.handle('projects:addAssets', async (_event, payload) => {
  const project = await addAssets(payload.projectId, payload.slotId, payload.category, payload.files);
  return serializeProject(project);
});

ipcMain.handle('projects:moveAsset', async (_event, payload) => {
  const project = await moveAsset(payload.projectId, payload.slotId, payload.category, payload.assetId, payload.direction);
  return serializeProject(project);
});

ipcMain.handle('projects:deleteAsset', async (_event, payload) => {
  const project = await deleteAsset(payload.projectId, payload.slotId, payload.category, payload.assetId);
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

ipcMain.handle('projects:exportBundlePackage', async (_event, projectId) => {
  return exportBundlePackage(projectId);
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
