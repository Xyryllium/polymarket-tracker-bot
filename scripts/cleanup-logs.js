#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const retentionHours = process.argv[2] ? parseInt(process.argv[2], 10) : 168; // Default to 7 days (weekly)

if (isNaN(retentionHours) || retentionHours <= 0) {
  console.error("Error: Retention hours must be a positive number");
  console.error("Usage: node scripts/cleanup-logs.js [retention-hours]");
  process.exit(1);
}

const retentionMs = retentionHours * 60 * 60 * 1000;
const now = Date.now();
const cutoffTime = now - retentionMs;

// Log files to clean up in logs/ directory
const logFiles = [
  "logs/bot.production.log",
  "logs/bot.test.log",
  "logs/bot.log",
  "logs/websocket.production.log",
  "logs/websocket.test.log",
  "logs/trades.production.log",
  "logs/trades.test.log",
  // Also check root directory for any legacy logs (backward compatibility)
  "bot.production.log",
  "bot.test.log",
  "bot.log",
  "websocket.production.log",
  "websocket.test.log",
  "trades.production.log",
  "trades.test.log",
];

// Log directories to clean up - all files in logs/ directory
const logDirs = ["./logs"];

function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function formatDate(timestamp) {
  return new Date(timestamp).toISOString();
}

function cleanupLogFiles() {
  const projectRoot = path.join(__dirname, "..");
  let totalDeleted = 0;
  let totalSize = 0;
  const deletedFiles = [];

  console.log(`\nStarting log cleanup...`);
  console.log(
    `   Retention period: ${retentionHours} hours (${retentionHours / 24} days)`
  );
  console.log(`   Cutoff time: ${formatDate(cutoffTime)}\n`);

  // Clean up root log files
  logFiles.forEach((logFile) => {
    const filePath = path.join(projectRoot, logFile);
    if (fs.existsSync(filePath)) {
      try {
        const stats = fs.statSync(filePath);
        const fileAge = now - stats.mtimeMs;

        if (stats.mtimeMs < cutoffTime) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          totalDeleted++;
          totalSize += fileSize;
          deletedFiles.push({
            file: logFile,
            size: fileSize,
            age: Math.round(fileAge / (1000 * 60 * 60)),
          });
          console.log(
            `Deleted: ${logFile} (${formatBytes(fileSize)}, ${Math.round(
              fileAge / (1000 * 60 * 60)
            )}h old)`
          );
        } else {
          console.log(
            `Kept: ${logFile} (${Math.round(
              fileAge / (1000 * 60 * 60)
            )}h old, within retention)`
          );
        }
      } catch (error) {
        console.error(`Error processing ${logFile}: ${error.message}`);
      }
    }
  });

  // Clean up log directories
  logDirs.forEach((logDir) => {
    const dirPath = path.join(projectRoot, logDir);
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory()) {
      try {
        const files = fs.readdirSync(dirPath);
        files.forEach((file) => {
          const filePath = path.join(dirPath, file);
          try {
            const stats = fs.statSync(filePath);
            if (stats.isFile() && stats.mtimeMs < cutoffTime) {
              const fileSize = stats.size;
              fs.unlinkSync(filePath);
              totalDeleted++;
              totalSize += fileSize;
              deletedFiles.push({
                file: `${logDir}/${file}`,
                size: fileSize,
                age: Math.round((now - stats.mtimeMs) / (1000 * 60 * 60)),
              });
              console.log(
                `Deleted: ${logDir}/${file} (${formatBytes(
                  fileSize
                )}, ${Math.round(
                  (now - stats.mtimeMs) / (1000 * 60 * 60)
                )}h old)`
              );
            }
          } catch (error) {
            console.error(`Error processing ${filePath}: ${error.message}`);
          }
        });
      } catch (error) {
        console.error(`Error reading directory ${logDir}: ${error.message}`);
      }
    }
  });

  // Summary
  console.log(`\nCleanup Summary:`);
  console.log(`   Files deleted: ${totalDeleted}`);
  console.log(`   Space freed: ${formatBytes(totalSize)}`);

  if (deletedFiles.length === 0) {
    console.log(`   No files needed cleanup (all within retention period)\n`);
  } else {
    console.log(`\n   Deleted files:`);
    deletedFiles.forEach(({ file, size, age }) => {
      console.log(`     - ${file} (${formatBytes(size)}, ${age}h old)`);
    });
    console.log();
  }

  return { deleted: totalDeleted, size: totalSize };
}

try {
  cleanupLogFiles();
} catch (error) {
  console.error(`\nFatal error during cleanup: ${error.message}\n`);
  process.exit(1);
}
