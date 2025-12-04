#!/bin/bash

echo "Setting up PM2 log rotation..."

pm2 install pm2-logrotate

echo "Configuring log rotation settings..."

pm2 set pm2-logrotate:max_size 10M

pm2 set pm2-logrotate:retain 5

pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

pm2 set pm2-logrotate:compress true

pm2 set pm2-logrotate:workerInterval 3600

pm2 set pm2-logrotate:dateFormat 'YYYY-MM-DD_HH-mm-ss'

echo "PM2 log rotation configured!"
echo ""
echo "Current settings:"
pm2 conf pm2-logrotate

echo ""
echo "   Note: PM2 will automatically rotate logs in ./logs/ directory"
echo "   - Logs location: ./logs/pm2-error.log, ./logs/pm2-out.log, ./logs/pm2-combined.log"
echo "   - Max size: 10MB per log file"
echo "   - Retention: 5 rotated files"
echo "   - Rotation: Daily at midnight + when max size is reached"
echo "   - Compression: Enabled"

