"use strict";
// The built client, served as static files. The service worker and the manifest are re-checked on every load (Cache-Control: no-cache), so
// a new version reaches phones at once; everything else keeps the static defaults.
const path = require("path");
const express = require("express");

const NO_CACHE = new Set(["sw.js", "manifest.webmanifest"]);

const clientStatic = (dir) => express.static(dir, {
  setHeaders: (res, filePath) => { if (NO_CACHE.has(path.basename(filePath))) res.setHeader("Cache-Control", "no-cache"); },
});

module.exports = { clientStatic, NO_CACHE };
