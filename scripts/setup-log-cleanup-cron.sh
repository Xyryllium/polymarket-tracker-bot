#!/bin/bash

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CLEANUP_SCRIPT="$PROJECT_DIR/scripts/cleanup-logs.js"

echo "Setting up log cleanup cron job..."
echo ""

if ! command -v node &> /dev/null; then
    echo "Error: Node.js not found. Please install Node.js first."
    exit 1
fi

if [ ! -f "$CLEANUP_SCRIPT" ]; then
    echo "Error: Cleanup script not found at $CLEANUP_SCRIPT"
    exit 1
fi

chmod +x "$CLEANUP_SCRIPT"

echo "Choose cleanup frequency:"
echo "1) Every 24 hours (default)"
echo "2) Weekly (every Sunday at 2 AM)"
echo "3) Custom interval"
echo ""
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        CRON_SCHEDULE="0 2 * * *"  # Daily at 2 AM
        RETENTION_HOURS=24
        echo "Selected: Daily cleanup at 2 AM (24 hour retention)"
        ;;
    2)
        CRON_SCHEDULE="0 2 * * 0"  # Weekly on Sunday at 2 AM
        RETENTION_HOURS=168
        echo "Selected: Weekly cleanup on Sunday at 2 AM (7 day retention)"
        ;;
    3)
        read -p "Enter cron schedule (e.g., '0 2 * * *' for daily at 2 AM): " CRON_SCHEDULE
        read -p "Enter retention hours (e.g., 24 or 168): " RETENTION_HOURS
        echo "Selected: Custom schedule '$CRON_SCHEDULE' with $RETENTION_HOURS hour retention"
        ;;
    *)
        CRON_SCHEDULE="0 2 * * *"
        RETENTION_HOURS=24
        echo "Using default: Daily cleanup at 2 AM (24 hour retention)"
        ;;
esac

CRON_JOB="$CRON_SCHEDULE cd $PROJECT_DIR && /usr/bin/node $CLEANUP_SCRIPT $RETENTION_HOURS >> $PROJECT_DIR/logs/cleanup-cron.log 2>&1"

if crontab -l 2>/dev/null | grep -q "$CLEANUP_SCRIPT"; then
    echo ""
    echo "Warning: Cron job already exists. Updating..."
    crontab -l 2>/dev/null | grep -v "$CLEANUP_SCRIPT" | crontab -
fi

(crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -

echo ""
echo "Cron job added successfully!"
echo ""
echo "Cron job details:"
echo "   Schedule: $CRON_SCHEDULE"
echo "   Command: node $CLEANUP_SCRIPT $RETENTION_HOURS"
echo "   Log output: $PROJECT_DIR/logs/cleanup-cron.log"
echo ""
echo "To view current crontab: crontab -l"
echo "To remove cron job: crontab -e (then delete the line)"
echo ""
echo "To test the cleanup script manually:"
echo "   cd $PROJECT_DIR"
echo "   node scripts/cleanup-logs.js $RETENTION_HOURS"

