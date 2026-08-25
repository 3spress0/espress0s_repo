#!/bin/bash
# Install tgpt for Barista AI backend
# https://github.com/aandrew-me/tgpt
set -e

echo "Installing tgpt for Barista (espress0's repo AI file finder)..."

if command -v tgpt &> /dev/null; then
  echo "tgpt already installed: $(tgpt --version 2>&1)"
  exit 0
fi

# Try go install first (most reliable)
if command -v go &> /dev/null; then
  echo "Installing via go install..."
  go install github.com/aandrew-me/tgpt@latest
  if [ -f "$HOME/go/bin/tgpt" ]; then
    sudo cp "$HOME/go/bin/tgpt" /usr/local/bin/tgpt 2>/dev/null || cp "$HOME/go/bin/tgpt" /usr/local/bin/tgpt 2>/dev/null || mkdir -p ~/.local/bin && cp "$HOME/go/bin/tgpt" ~/.local/bin/tgpt
    echo "Installed via go to /usr/local/bin/tgpt"
  fi
fi

# Try install script
if ! command -v tgpt &> /dev/null; then
  echo "Installing via official install script..."
  curl -sSL https://raw.githubusercontent.com/aandrew-me/tgpt/main/install | bash -s /usr/local/bin 2>&1 || echo "Install script failed"
fi

# Try manual download (Linux x86_64)
if ! command -v tgpt &> /dev/null; then
  echo "Trying manual download..."
  ARCH=$(uname -m)
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  if [ "$ARCH" = "x86_64" ] && [ "$OS" = "linux" ]; then
    TMP=$(mktemp -d)
    cd $TMP
    echo "Downloading latest release..."
    curl -sSL https://github.com/aandrew-me/tgpt/releases/latest/download/tgpt-linux-amd64 -o tgpt 2>&1 || echo "Manual download failed"
    if [ -f "tgpt" ]; then
      chmod +x tgpt
      sudo mv tgpt /usr/local/bin/tgpt 2>/dev/null || mv tgpt /usr/local/bin/tgpt 2>/dev/null || mv tgpt ~/.local/bin/tgpt
      echo "Installed manually"
    fi
    cd -
    rm -rf $TMP
  fi
fi

# Verify
if command -v tgpt &> /dev/null; then
  echo "✓ tgpt installed: $(tgpt --version 2>&1)"
  echo "Configure provider:"
  echo "  tgpt --provider duckduckgo  # free, no key"
  echo "  tgpt --provider openai --key sk-...  # openai"
  echo "  tgpt --provider groq --key gsk_...   # groq"
  echo ""
  echo "Test:"
  echo "  echo 'Which Ubuntu for Intel PC?' | tgpt --provider duckduckgo"
else
  echo "⚠ tgpt not installed, Barista will use fallback mode (rule-based metadata search)"
  echo "  Fallback still works: searches SQLite FTS5, no hallucination"
fi

echo ""
echo "Barista AI config in .env:"
echo "  TGPT_ENABLED=true"
echo "  TGPT_BINARY_PATH=/usr/local/bin/tgpt"
echo "  TGPT_PROVIDER=duckduckgo"
