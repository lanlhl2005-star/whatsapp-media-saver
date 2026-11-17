import fs from 'node:fs';
import path from 'node:path';
import { buildRelativeParts } from './naming.js';

/**
 * Ensure SAVE_ROOT and temp dir exist. On non-Windows (dev/cloud), if the
 * configured Windows path is unavailable, fall back to ./data/save-root under app.
 */
export function ensureSaveRoot(config, logger) {
  const preferred = config.saveRoot;
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const tmp = path.join(preferred, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    return { saveRoot: preferred, tmpDir: tmp, usingFallback: false };
  } catch (err) {
    const fallback = path.join(config.appRoot, 'data', 'save-root');
    logger?.warn?.(
      { preferred, fallback, err: err.message },
      'SAVE_ROOT unavailable; using local fallback (dev/cloud only). On Windows set F:\\Scan\\whatsapp media',
    );
    fs.mkdirSync(fallback, { recursive: true });
    const tmp = path.join(fallback, '.tmp');
    fs.mkdirSync(tmp, { recursive: true });
    return { saveRoot: fallback, tmpDir: tmp, usingFallback: true };
  }
}

export function resolveDestination({
  saveRoot,
  isGroup,
  groupName,
  when,
  senderPhone,
  fileLabel,
  shortMsgId,
  mimetype,
  originalFileName,
  mediaType,
  timeZone,
}) {
  const folderProbeParts = [];
  // Build once with a no-op exists to get folder; then check collisions inside that folder.
  const draft = buildRelativeParts({
    isGroup,
    groupName,
    when,
    senderPhone,
    fileLabel,
    shortMsgId,
    mimetype,
    originalFileName,
    mediaType,
    timeZone,
    existsInFolder: () => false,
  });

  const folderAbs = path.join(
    saveRoot,
    ...(isGroup ? [draft.covering, draft.perMediaFolder] : [draft.perMediaFolder]),
  );
  fs.mkdirSync(folderAbs, { recursive: true });

  const final = buildRelativeParts({
    isGroup,
    groupName,
    when,
    senderPhone,
    fileLabel,
    shortMsgId,
    mimetype,
    originalFileName,
    mediaType,
    timeZone,
    existsInFolder: (name) => fs.existsSync(path.join(folderAbs, name)),
  });

  const relativeDir = isGroup
    ? path.join(final.covering, final.perMediaFolder)
    : final.perMediaFolder;
  const relativeFile = path.join(relativeDir, final.fileName);
  const absoluteFile = path.join(saveRoot, relativeFile);
  const absoluteFolder = path.join(saveRoot, relativeDir);

  return {
    ...final,
    relativeDir,
    relativeFile,
    absoluteFile,
    absoluteFolder,
    folderProbeParts,
  };
}
