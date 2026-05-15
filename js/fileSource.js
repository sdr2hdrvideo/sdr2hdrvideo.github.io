/* ──────────────────────────────────────────────────────────────────────────
 * fileSource.js — own the user-selected videos folder.
 *
 * Chrome treats every file:// URL as its own opaque origin, so a <video>
 * loading a sibling file:// resource is cross-origin. Without crossOrigin
 * the load succeeds but the resulting frame is "tainted" → VideoFrame /
 * copyExternalImageToTexture throw SecurityError. With crossOrigin the
 * load itself fails CORS preflight (file:// can't return headers).
 *
 * Workaround: have the user pick the videos folder once per session via
 * <input type="file" webkitdirectory>. The resulting File objects yield
 * blob: URLs that ARE same-origin with the page (per the URL spec — blob
 * URLs inherit the creator document's origin), so video loads and pixel
 * reads both work without any flags.
 *
 * The map keys are stripped of the picked folder's top-level name so
 *   <picked dir>/scene_X/method_Y.mp4
 *   <picked dir>/scene_Z/method_W.mp4
 * resolve under keys
 *   "scene_X/method_Y.mp4", "scene_Z/method_W.mp4"
 * matching our manifest's "<dataset>/<exposure>/<scene>/method_<m>.mp4"
 * convention.
 *
 * We also stash the picked folder's top-level name so main.js can warn
 * users who accidentally select a wrong folder — encoded videos must
 * come out of a directory called 'videos' (or any directory whose name
 * contains that token, e.g. 'videos_sub300mb'). The check is informational
 * only; we still load whatever files were selected.
 * ────────────────────────────────────────────────────────────────────────── */

window.App = window.App || {};

window.App.fileSource = (function () {
  'use strict';

  /** relPath (e.g. 'wild/wild/scene_X/method_Ours.mp4') -> File */
  let fileMap = new Map();

  /** Top-level folder name from the most recent setFromFolder() call. */
  let pickedFolderName = '';

  /**
   * Index a FileList from <input type="file" webkitdirectory>.
   * The first segment of webkitRelativePath is the picked folder's own
   * name (e.g. 'videos/'); we record it for the name-check and strip it
   * from the file map keys so callers can resolve scene-relative paths.
   *
   * Returns { folderName, looksLikeVideos } so callers can surface a
   * non-fatal warning when the picked folder doesn't appear to be the
   * videos directory.
   */
  function setFromFolder(fileList) {
    fileMap.clear();
    pickedFolderName = '';
    for (const f of fileList) {
      const rawPath = f.webkitRelativePath || f.name;
      const parts = rawPath.split('/').filter(Boolean);
      if (parts.length < 2) continue;                // top-level files have no scene
      if (!pickedFolderName) pickedFolderName = parts[0];
      const rel = parts.slice(1).join('/');          // strip picked-dir prefix
      if (rel) fileMap.set(rel, f);
    }
    const looksLikeVideos = /videos/i.test(pickedFolderName);
    return { folderName: pickedFolderName, looksLikeVideos };
  }

  function clear() {
    fileMap.clear();
    pickedFolderName = '';
  }

  function hasAny() { return fileMap.size > 0; }

  function fileFor(relPath) { return fileMap.get(relPath) || null; }

  function listKeys() { return [...fileMap.keys()]; }

  /** Top-level name of the most recently picked folder (or '' if none). */
  function getFolderName() { return pickedFolderName; }

  /**
   * Create a blob: URL for a relative path. Returns null if the file isn't
   * in the selected folder. Caller is responsible for calling revoke()
   * once the URL is no longer needed (typically after the video has
   * finished decoding into GPU textures).
   */
  function makeBlobUrl(relPath) {
    const f = fileFor(relPath);
    return f ? URL.createObjectURL(f) : null;
  }

  function revoke(blobUrl) {
    if (typeof blobUrl === 'string' && blobUrl.startsWith('blob:')) {
      URL.revokeObjectURL(blobUrl);
    }
  }

  return {
    setFromFolder, clear, hasAny, fileFor, listKeys,
    getFolderName, makeBlobUrl, revoke,
  };
})();
