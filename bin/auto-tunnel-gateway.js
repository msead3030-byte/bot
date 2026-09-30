#!/usr/bin/env node
"use strict";

require("dotenv").config({ quiet: true });
const { getAutoTunnel } = require("../src/AutoTunnel");

const tunnel = getAutoTunnel();
tunnel.start();

process.on("SIGINT", () => {
  console.log("\n🛑 جاري إيقاف النفق السحابي...");
  tunnel.stop();
  process.exit();
});

process.on("SIGTERM", () => {
  tunnel.stop();
  process.exit();
});
