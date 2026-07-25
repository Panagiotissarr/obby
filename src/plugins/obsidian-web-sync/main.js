'use strict';

/**
 * Obsidian Web — Redis Sync plugin.
 *
 * Adds "Save vault to Redis" and "Sync vault from Redis" to:
 *   1. The file-explorer sidebar context menu (right-click → New note menu)
 *   2. Individual file/folder context menus
 *   3. Command palette (Ctrl/Cmd+P → "Redis sync: save" / "Redis sync: sync")
 *   4. Ribbon icon (cloud upload / download)
 *
 * Only activates on obsidian-web (where __owPlatform exists).
 * In real Obsidian desktop/mobile, this plugin is a no-op.
 */

const obsidian = require('obsidian');

function getVaultId() {
  return window.__owVaultId || window.VAULT_ID || '';
}

async function getAllFiles(adapter, dir = '') {
  let files = [];
  let list;
  try {
    list = await adapter.list(dir);
  } catch (e) {
    console.warn('[ow-sync] failed to list dir:', dir, e);
    return [];
  }

  if (list && list.files) {
    for (const f of list.files) {
      if (f && f.indexOf('.obsidian/plugins/') !== 0) {
        files.push(f);
      }
    }
  }

  if (list && list.folders) {
    for (const d of list.folders) {
      if (d === '.git' || d.indexOf('.obsidian/plugins/') === 0) {
        continue;
      }
      const subFiles = await getAllFiles(adapter, d);
      files = files.concat(subFiles);
    }
  }

  return files;
}

async function doSave() {
  const vault = getVaultId();
  if (!vault) {
    new obsidian.Notice('No vault ID — cannot save');
    return;
  }

  if (!app.vault || !app.vault.adapter) {
    new obsidian.Notice('Vault adapter not available');
    return;
  }

  new obsidian.Notice('Scanning files…');
  const allPaths = await getAllFiles(app.vault.adapter);

  new obsidian.Notice('Saving ' + allPaths.length + ' files to Redis…');

  // Read files in batches — each batch stays under 2MB to avoid Vercel 413
  const BATCH_SIZE = 20;
  let totalSaved = 0;
  let totalErrors = 0;

  for (let i = 0; i < allPaths.length; i += BATCH_SIZE) {
    const batch = allPaths.slice(i, i + BATCH_SIZE);
    const filePromises = batch.map(async (path) => {
      let content = '';
      try {
        content = await app.vault.adapter.read(path);
      } catch (_) {}
      return { path, content };
    });
    const files = await Promise.all(filePromises);

    try {
      const r = await fetch('/api/vault/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vault, files }),
      });
      const d = await r.json();
      if (!r.ok) {
        throw new Error(d.error || 'Server error ' + r.status);
      }
      totalSaved += d.saved || 0;
      totalErrors += d.errors || 0;
      console.log('[ow-sync] batch saved:', d.saved, 'files, errors:', d.errors);
    } catch (e) {
      totalErrors += files.length;
      console.warn('[ow-sync] batch failed:', e.message);
    }
  }

  if (totalErrors > 0) {
    new obsidian.Notice('Saved ' + totalSaved + ' files (' + totalErrors + ' errors)');
    console.warn('[ow-sync] save completed with errors: saved=' + totalSaved + ' errors=' + totalErrors);
  } else {
    new obsidian.Notice('Saved ' + totalSaved + ' files to Redis');
    console.log('[ow-sync] save complete:', totalSaved);
  }
}

async function doSync() {
  const vault = getVaultId();
  if (!vault) {
    new obsidian.Notice('No vault ID — cannot sync');
    return;
  }

  new obsidian.Notice('Syncing from Redis…');

  try {
    const refreshRes = await fetch('/api/vault/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vault }),
    });
    const refreshData = await refreshRes.json();
    if (!refreshRes.ok) {
      throw new Error(refreshData.error || 'Server error ' + refreshRes.status);
    }

    const bootstrapRes = await fetch(
      '/api/bootstrap?vault=' + encodeURIComponent(vault) + '&full=1',
      { headers: { 'Accept-Encoding': 'br, gzip' } },
    );
    if (bootstrapRes.ok) {
      const data = await bootstrapRes.json();
      if (data && !data.disabled) {
        window.__owBootstrapCache = data;
      } else {
        window.__owBootstrapCache = null;
      }
    } else {
      window.__owBootstrapCache = null;
    }

    const fileCount = refreshData.fileCount || 0;
    new obsidian.Notice('Synced from Redis (' + fileCount + ' files)');
    console.log('[ow-sync] sync:', refreshData);
  } catch (e) {
    new obsidian.Notice('Sync failed: ' + e.message);
    console.warn('[ow-sync] sync failed', e);
  }
}

module.exports = class ObsidianWebSyncPlugin extends obsidian.Plugin {
  async onload() {
    // Only activate on obsidian-web (where __owPlatform exists).
    if (typeof window.__owPlatform === 'undefined') {
      console.log('[obsidian-web-sync] not on obsidian-web — plugin idle');
      return;
    }

    // Auto-open Welcome note if it exists on startup
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => {
        const welcomePath = '00 Dashboard/Welcome.md';
        const file = this.app.vault.getAbstractFileByPath(welcomePath);
        if (file) {
          const leaf = this.app.workspace.getLeaf(false);
          if (leaf) {
            leaf.openFile(file);
          }
        }
      }, 200);
    });

    // ── Commands (Ctrl/Cmd+P) ──────────────────────────────────────────
    this.addCommand({
      id: 'redis-save',
      name: 'Redis sync: Save vault to Redis',
      callback: doSave,
    });

    this.addCommand({
      id: 'redis-sync',
      name: 'Redis sync: Sync vault from Redis',
      callback: doSync,
    });

    // ── Ribbon icon ─────────────────────────────────────────────────────
    this.addRibbonIcon('cloud-upload', 'Redis sync', (evt) => {
      const menu = new obsidian.Menu();
      menu.addItem((item) =>
        item.setTitle('Save vault to Redis').setIcon('download').onClick(doSave)
      );
      menu.addItem((item) =>
        item.setTitle('Sync vault from Redis').setIcon('refresh-cw').onClick(doSync)
      );
      menu.showAtMouseEvent(evt);
    });

    // ── File explorer context menu (sidebar right-click) ────────────────
    // This hooks into Obsidian's native file-menu event — works for both
    // the general sidebar menu (New note / New folder) and file-specific menus.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        // Add to every file-menu: both sidebar empty-area and file-specific
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle('Save vault to Redis')
            .setIcon('download')
            .onClick(doSave)
        );
        menu.addItem((item) =>
          item
            .setTitle('Sync vault from Redis')
            .setIcon('refresh-cw')
            .onClick(doSync)
        );
      })
    );
  }
};
