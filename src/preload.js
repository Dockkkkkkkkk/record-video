const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appApi', {
  listProjects: () => ipcRenderer.invoke('projects:list'),
  createProject: (payload) => ipcRenderer.invoke('projects:create', payload),
  getProject: (projectId) => ipcRenderer.invoke('projects:get', projectId),
  updateSlot: (payload) => ipcRenderer.invoke('projects:updateSlot', payload),
  updateMergeSettings: (payload) => ipcRenderer.invoke('projects:updateMergeSettings', payload),
  addSlot: (projectId) => ipcRenderer.invoke('projects:addSlot', projectId),
  advanceSlot: (payload) => ipcRenderer.invoke('projects:advanceSlot', payload),
  deleteAudio: (payload) => ipcRenderer.invoke('projects:deleteAudio', payload),
  deleteSlot: (payload) => ipcRenderer.invoke('projects:deleteSlot', payload),
  saveRecording: (payload) => ipcRenderer.invoke('projects:saveRecording', payload),
  addAssets: (payload) => ipcRenderer.invoke('projects:addAssets', payload),
  addPromptAsset: (payload) => ipcRenderer.invoke('projects:addPromptAsset', payload),
  moveAsset: (payload) => ipcRenderer.invoke('projects:moveAsset', payload),
  deleteAsset: (payload) => ipcRenderer.invoke('projects:deleteAsset', payload),
  previewMerge: (projectId) => ipcRenderer.invoke('projects:previewMerge', projectId),
  exportMerge: (projectId) => ipcRenderer.invoke('projects:exportMerge', projectId),
  exportProcessedSegments: (projectId) => ipcRenderer.invoke('projects:exportProcessedSegments', projectId),
  exportBundlePackage: (projectId) => ipcRenderer.invoke('projects:exportBundlePackage', projectId),
  openFolder: (payload) => ipcRenderer.invoke('projects:openFolder', payload),
  revealExport: (filePath) => ipcRenderer.invoke('dialog:revealExport', filePath),
  showMessage: (payload) => ipcRenderer.invoke('dialog:message', payload)
});
