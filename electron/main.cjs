const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs').promises;

const STATE_NAME = '.photo-organizer-state.json';

function getStatePath(root) {
  return path.join(root, STATE_NAME);
}

async function loadState(root) {
  try {
    const raw = await fs.readFile(getStatePath(root), 'utf8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

async function saveState(root, patch) {
  const cur = await loadState(root);
  const next = { ...cur, ...patch };
  await fs.writeFile(getStatePath(root), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

const defaultState = () => ({
  step1: false,
  step2: false,
  manual3: false,
  step4: false,
  step5: false,
  manual6: false,
});

const EXT = {
  aae: ['.aae'],
  heic_jpg: ['.heic', '.jpg', '.jpeg'],
  mov_mp4: ['.mov', '.mp4'],
  png: ['.png'],
};

function normExt(name) {
  const i = name.lastIndexOf('.');
  if (i < 0) return '';
  return name.slice(i).toLowerCase();
}

function bucketForFile(name) {
  const e = normExt(name);
  for (const [folder, list] of Object.entries(EXT)) {
    if (list.includes(e)) return folder;
  }
  return null;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function moveIfExists(from, to) {
  try {
    await fs.rename(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Step 1: sort top-level files into subfolders */
async function step1SortByType(root) {
  const names = await fs.readdir(root);
  const moved = [];
  for (const name of names) {
    if (name.startsWith('.') || name === STATE_NAME) continue;
    const full = path.join(root, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st || !st.isFile()) continue;
    const bucket = bucketForFile(name);
    if (!bucket) continue;
    const destDir = path.join(root, bucket);
    await ensureDir(destDir);
    const dest = path.join(destDir, name);
    await fs.rename(full, dest);
    moved.push({ from: name, to: path.join(bucket, name) });
  }
  return { moved };
}

/**
 * 若檔名是「編輯版」命名，回傳對應的原始檔檔名；否則 null。
 * 支援：(1) 結尾 _E：IMG_1234_E.HEIC → IMG_1234.HEIC
 *      (2) IMG_ 後插 E：IMG_E8431.HEIC → IMG_8431.HEIC（常見於 iPhone 人像/編輯）
 */
function getOriginalNameForEdited(name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);

  let m = stem.match(/^(.*)_E$/i);
  if (m) return m[1] + ext;

  m = stem.match(/^(IMG_)E(\d+)$/i);
  if (m) return m[1] + m[2] + ext;

  return null;
}

/**
 * 從檔名（可含副檔名）抽出「數字鍵」供步驟 4 比對：取主檔名中每一段連續數字，
 * 優先使用長度 ≥4 的最後一段（常見 IMG_8431 / IMG_E8431），否則用最後一段數字。
 */
function extractNumericKey(filename) {
  const stem = path.basename(filename, path.extname(filename));
  const nums = stem.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  const long = nums.filter((n) => n.length >= 4);
  if (long.length) return long[long.length - 1];
  return nums[nums.length - 1];
}

/** Step 2: 編輯檔與原始檔成對 → 根目錄 original_no_e */
async function step2OriginalNoE(root) {
  const heicDir = path.join(root, 'heic_jpg');
  const sub = path.join(root, 'original_no_e');
  await ensureDir(sub);

  const entries = await fs.readdir(heicDir, { withFileTypes: true });
  const names = entries.filter((e) => e.isFile()).map((e) => e.name);
  const remaining = new Set(names);

  const moved = [];

  for (const name of names) {
    const originalName = getOriginalNameForEdited(name);
    if (!originalName) continue;
    if (!remaining.has(originalName)) continue;

    const plainPath = path.join(heicDir, originalName);
    try {
      const st = await fs.stat(plainPath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }

    const dest = path.join(sub, originalName);
    await fs.rename(plainPath, dest);
    remaining.delete(originalName);
    moved.push({ file: originalName, to: `original_no_e/${originalName}`, edited: name });
  }

  return { moved };
}

/** Step 4：依 deleted 內檔名的數字鍵，刪除 aae / original_no_e 中數字鍵相同的檔案 */
async function step4SyncDeleted(root) {
  const deletedDir = path.join(root, 'deleted');
  const origDir = path.join(root, 'original_no_e');
  const aaeDir = path.join(root, 'aae');

  await ensureDir(deletedDir);

  let entries;
  try {
    entries = await fs.readdir(deletedDir, { withFileTypes: true });
  } catch {
    return { removed: [], note: 'deleted 資料夾不存在或為空' };
  }

  const keys = new Set();
  const skipped = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const k = extractNumericKey(ent.name);
    if (k) keys.add(k);
    else skipped.push(ent.name);
  }

  if (keys.size === 0) {
    return {
      removed: [],
      note:
        skipped.length > 0
          ? 'deleted 內檔名無法解析出數字，請確認檔名含數字（例如 IMG_8431）'
          : 'deleted 資料夾為空',
      skipped,
    };
  }

  const removed = [];

  async function tryUnlink(p) {
    try {
      await fs.unlink(p);
      removed.push(p);
      return true;
    } catch {
      return false;
    }
  }

  async function sweepDir(dir) {
    let list;
    try {
      list = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of list) {
      if (!ent.isFile()) continue;
      const k = extractNumericKey(ent.name);
      if (k && keys.has(k)) await tryUnlink(path.join(dir, ent.name));
    }
  }

  await sweepDir(aaeDir);
  await sweepDir(origDir);

  return {
    removed: removed.map((p) => path.relative(root, p)),
    keys: [...keys],
    skipped: skipped.length ? skipped : undefined,
  };
}

/** Step 5: remove deleted folder, merge heic_jpg, mov_mp4, png -> photo */
async function step5MergePhoto(root) {
  const deletedDir = path.join(root, 'deleted');
  await fs.rm(deletedDir, { recursive: true, force: true });

  const photoDir = path.join(root, 'photo');
  await ensureDir(photoDir);

  const sources = ['heic_jpg', 'mov_mp4', 'png', 'original_no_e'];
  const moved = [];

  async function moveTree(fromDir, relBase) {
    let list;
    try {
      list = await fs.readdir(fromDir, { withFileTypes: true });
    } catch {
      return;
    }
    if (!list.length) {
      try {
        await fs.rmdir(fromDir);
      } catch {
        /* ignore */
      }
      return;
    }
    for (const ent of list) {
      const full = path.join(fromDir, ent.name);
      const rel = path.join(relBase, ent.name);
      if (ent.isDirectory()) {
        await moveTree(full, rel);
        try {
          await fs.rmdir(full);
        } catch {
          /* non-empty or not empty */
        }
      } else {
        let destName = ent.name;
        let dest = path.join(photoDir, destName);
        let n = 1;
        while (true) {
          try {
            await fs.access(dest);
            const ext = path.extname(destName);
            const stem = path.basename(destName, ext);
            destName = `${stem}_${n}${ext}`;
            dest = path.join(photoDir, destName);
            n++;
          } catch {
            break;
          }
        }
        await fs.rename(full, dest);
        moved.push(rel + ' -> photo/' + destName);
      }
    }
  }

  for (const s of sources) {
    const dir = path.join(root, s);
    await moveTree(dir, s);
  }

  for (const s of sources) {
    const dir = path.join(root, s);
    await fs.rm(dir, { recursive: true, force: true });
  }

  return { moved };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 800,
    minWidth: 640,
    minHeight: 560,
    title: '照片整理助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    if (process.env.ELECTRON_DEVTOOLS === '1') {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('select-folder', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

ipcMain.handle('get-state', async (_e, root) => {
  if (!root) return null;
  return loadState(root);
});

ipcMain.handle('set-manual', async (_e, root, key, value) => {
  if (!root) return null;
  return saveState(root, { [key]: value });
});

ipcMain.handle('save-state', async (_e, root, patch) => {
  if (!root) return null;
  return saveState(root, patch || {});
});

ipcMain.handle('step1', async (_e, root) => {
  return step1SortByType(root);
});

ipcMain.handle('step2', async (_e, root) => {
  return step2OriginalNoE(root);
});

ipcMain.handle('step4', async (_e, root) => {
  return step4SyncDeleted(root);
});

ipcMain.handle('step5', async (_e, root) => {
  return step5MergePhoto(root);
});

ipcMain.handle('ensure-deleted-folder', async (_e, root) => {
  const p = path.join(root, 'deleted');
  await ensureDir(p);
  return p;
});
