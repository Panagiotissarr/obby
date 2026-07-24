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
  // VAULT_ID is set by boot.js as a global
  return window.VAULT_ID || '';
}

function doSave() {
  const vault = getVaultId();
  if (!vault) {
    new obsidian.Notice('No vault ID — cannot save');
    return;
  }

  const files = [];
  const abstractFiles = app.vault.getFiles
    ? Array.from(app.vault.getFiles())
    : [];

  for (const f of abstractFiles) {
    if (f && f.path && f.path.indexOf('.obsidian/plugins/') !== 0) {
      let content = '';
      try { content = app.vault.read(f); } catch (_) {}
      files.push({ path: f.path, content });
    }
  }

  new obsidian.Notice('Saving ' + files.length + ' files to Redis…');

  fetch('/api/vault/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vault, files }),
  })
    .then(r => r.json())
    .then(d => {
      new obsidian.Notice('Saved ' + (d.saved || 0) + ' files to Redis');
      console.log('[ow-sync] save:', d);
    })
    .catch(e => {
      new obsidian.Notice('Save failed: ' + e.message);
      console.warn('[ow-sync] save failed', e);
    });
}

function doSync() {
  const vault = getVaultId();
  if (!vault) {
    new obsidian.Notice('No vault ID — cannot sync');
    return;
  }

  new obsidian.Notice('Syncing from Redis…');

  fetch('/api/vault/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vault }),
  })
    .then(r => r.json())
    .then(d => {
      window.__owBootstrapCache = null;
      new obsidian.Notice('Synced from Redis (' + (d.fileCount || 0) + ' files)');
      console.log('[ow-sync] sync:', d);
    })
    .catch(e => {
      new obsidian.Notice('Sync failed: ' + e.message);
      console.warn('[ow-sync] sync failed', e);
    });
}

module.exports = class ObsidianWebSyncPlugin extends obsidian.Plugin {
  async onload() {
    // Only activate on obsidian-web (where __owPlatform exists).
    if (typeof window.__owPlatform === 'undefined') {
      console.log('[obsidian-web-sync] not on obsidian-web — plugin idle');
      return;
    }

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
