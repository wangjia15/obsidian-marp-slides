#!/bin/bash
VAULT_PATH="/Users/wangjia/workspace/LLM-Wiki"
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/marp-slides"
mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css "$PLUGIN_DIR/"
VERSION=$(grep '"version"' manifest.json | tr -d ' "version:,')
echo "Deployed marp-slides $VERSION to $PLUGIN_DIR"
