#!/bin/bash
# Ralph Wiggum stop-hook for James
# Prevents premature exit by checking for remaining work

# Early exit (comment out to enable the hook)
# echo "Thanks for being awesome!"
# exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHUTDOWN_FLAG="$SCRIPT_DIR/../.shutdown_confirmed"

# Check if shutdown was explicitly confirmed
if [ -f "$SHUTDOWN_FLAG" ]; then
    rm -f "$SHUTDOWN_FLAG"
    echo "Shutdown confirmed. Goodbye!" >&2
    exit 0  # Allow clean exit
fi

# Loop detection: if 3+ stop attempts within 60s, allow exit
NOW=$(date +%s)
WINDOW=60
THRESHOLD=3
STOP_LOG="$SCRIPT_DIR/../.ralph-stop-log"

echo "$NOW" >> "$STOP_LOG"

# Keep only entries within the window
awk -v cutoff=$((NOW - WINDOW)) '$1 >= cutoff' "$STOP_LOG" > "$STOP_LOG.tmp"
mv "$STOP_LOG.tmp" "$STOP_LOG"

COUNT=$(wc -l < "$STOP_LOG")
if [ "$COUNT" -ge "$THRESHOLD" ]; then
    rm -f "$STOP_LOG"
    echo "Ralph detected a stop loop ($COUNT attempts in ${WINDOW}s). Allowing exit." >&2
    exit 0
fi

# Capture current state of John and Sam panes
DEV_STATE=$(tmux capture-pane -t lambda:john -p 2>/dev/null | tail -30)
QA_STATE=$(tmux capture-pane -t lambda:sam -p 2>/dev/null | tail -30)

# Check for next available task
NEXT_TASK=$(lambda tasks next 2>/dev/null || echo "")

# Output the context to stderr (this becomes the message Claude sees)
# Then exit 2 to block the stop and re-prompt
cat >&2 << EOF
[Ralph Stop-Hook] Before exiting, verify there's no remaining work:

## Next Task:
${NEXT_TASK:-No tasks available}

## John Pane (lambda:john) - last 30 lines:
\`\`\`
$DEV_STATE
\`\`\`

## Sam Pane (lambda:sam) - last 30 lines:
\`\`\`
$QA_STATE
\`\`\`

## Required Checks:
1. Is there a next task available from \`lambda tasks next\`?
2. Is John working (shows "Thinking/Wizarding") or waiting for input?
3. Is Sam running tests or needs invocation?

**If ANY work remains**: Continue working - poll John/Sam, grant permissions, etc.
**If truly idle**: Run \`touch .shutdown_confirmed\` then try to exit again.
EOF

# Exit code 2 = block the stop, re-prompt with stderr message
exit 2
