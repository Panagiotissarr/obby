// Vercel Serverless entry point — thin wrapper around the Express app.
const { createApp } = require('../src/runtime-server/server/index');
const systemPlugins = require('../src/runtime-server/server/system-plugins');

systemPlugins.init();
module.exports = createApp();
