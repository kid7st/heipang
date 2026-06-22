#!/bin/zsh
# Double-click to launch the new GUI.
cd "$(dirname "$0")"
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null
export PATH="/opt/homebrew/bin:$PATH"
exec npm run start
