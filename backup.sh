#!/bin/bash
DB=/opt/applyexpress/data/autoapply.db
BACKUP_DIR=/opt/applyexpress/data/backups
DATE=$(date +%Y-%m-%d)
mkdir -p "$BACKUP_DIR"
sqlite3 "$DB" ".backup $BACKUP_DIR/autoapply_$DATE.db"
gzip -f "$BACKUP_DIR/autoapply_$DATE.db"
find "$BACKUP_DIR" -name '*.db.gz' -mtime +7 -delete
echo "[backup] Done: $BACKUP_DIR/autoapply_$DATE.db.gz"
