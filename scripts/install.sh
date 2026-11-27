#!/usr/bin/env bash
# Sonar 1-Command Installer for macOS & Linux (local workstation or private server).
# Installs dependencies safely (--ignore-scripts + targeted native addon build), verifies
# offline ONNX models by SHA-256, writes default config with umask 077, and installs CLI wrappers.
set -euo pipefail
umask 077

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${SONAR_DATA_DIR:-$HOME/.local/share/sonar}"
CFG_DIR="${SONAR_CONFIG_DIR:-$HOME/.config/sonar}"
BIN_DIR="${SONAR_BIN_DIR:-$HOME/.local/bin}"

echo "==> Installing Sonar from $REPO_DIR"
mkdir -p "$DATA_DIR/index" "$DATA_DIR/models" "$CFG_DIR" "$BIN_DIR"
chmod 700 "$DATA_DIR" "$CFG_DIR"

cd "$REPO_DIR"
# Install dependencies with --ignore-scripts so transitive postinstall hooks
# (e.g. onnxruntime-node's optional NuGet CUDA GPU downloader) never execute.
# CPU native bindings for onnxruntime-node are bundled inside its lockfile-verified npm tarball;
# only better-sqlite3 needs its native addon build step.
npm ci --omit=dev --ignore-scripts
if [ ! -f "$REPO_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node" ]; then
  if [ "${SONAR_BUILD_FROM_SOURCE:-1}" = "1" ]; then
    (cd "$REPO_DIR/node_modules/better-sqlite3" && npm_config_ignore_scripts=false npm run build-release)
  else
    (cd "$REPO_DIR/node_modules/better-sqlite3" && npm_config_ignore_scripts=false npm run install)
  fi
fi

echo "==> Verifying native SQLite and ONNX Runtime CPU bindings"
node -e '
  Promise.all([import("onnxruntime-node"), import("@huggingface/transformers")]).then(([ort, hf]) => {
    if (!ort?.InferenceSession || !hf?.pipeline) process.exit(1);
    console.log("Native bindings OK (better-sqlite3, onnxruntime-node, @huggingface/transformers)");
  }).catch((err) => { console.error(err); process.exit(1); });
'

echo "==> Running self-tests"
npm test

if [ "${SONAR_SKIP_MODELS:-0}" != "1" ]; then
  echo "==> Downloading and SHA-256-verifying offline ONNX models"
  node "$REPO_DIR/scripts/download-models.mjs" --dir "$DATA_DIR/models"
fi

CFG_FILE="$CFG_DIR/config.json"
if [ ! -f "$CFG_FILE" ]; then
  node -e '
    const fs = require("node:fs");
    const [cfgFile, dataDir, cfgDir] = process.argv.slice(1);
    const cfg = {
      database: `${dataDir}/memory.db`,
      index: `${dataDir}/index`,
      modelRoot: `${dataDir}/models`,
      socket: `${dataDir}/sonar.sock`,
      socketMode: 384,
      policyFile: `${cfgDir}/policy.json`,
      sources: [],
      trustedRoots: [],
      allowMcpRuleMutations: false,
      embeddingModel: "Xenova/multilingual-e5-small",
      rerankerModel: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1",
      rerankerEnabled: true,
      preloadReranker: true,
      rerankDefaultK: 8,
      rerankAdaptiveK: 8,
      rerankDeepK: 20,
      rerankTimeoutMs: 250,
      searchThreads: 2,
      rerankThreads: 4,
      reindexThreads: 2,
      minMemAvailableGiB: 1.5
    };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  ' "$CFG_FILE" "$DATA_DIR" "$CFG_DIR"
  echo "==> Created default config: $CFG_FILE"
fi

if [ ! -f "$CFG_DIR/policy.json" ]; then
  install -m 0600 "$REPO_DIR/examples/policy.example.json" "$CFG_DIR/policy.json"
fi

# Initialize an empty canonical SQLite database (mode 0600 via umask 077) so
# running ingest/reindex.mjs before starting mcp-server.mjs succeeds immediately.
if [ ! -f "$DATA_DIR/memory.db" ]; then
  node --input-type=module -e '
    import { CanonicalStore } from "./core/store/canonical.mjs";
    const s = new CanonicalStore(process.argv[1]);
    s.close();
  ' "$DATA_DIR/memory.db"
  echo "==> Initialized canonical SQLite database: $DATA_DIR/memory.db"
fi

printf -v Q_REPO '%q' "$REPO_DIR"
printf -v Q_DATA '%q' "$DATA_DIR"

write_wrapper() {
  local target="$1"
  local tmp
  tmp="$(mktemp "$BIN_DIR/.sonar-wrapper.XXXXXX")"
  cat > "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$target"
}

write_wrapper "$BIN_DIR/sonar-mcp" <<EOF
#!/usr/bin/env bash
DEFAULT_SOCK=${Q_DATA}/sonar.sock
export SONAR_DEFAULT_SOCKET="\${SONAR_DEFAULT_SOCKET:-\$DEFAULT_SOCK}"
exec python3 ${Q_REPO}/server/client.py "\$@"
EOF
write_wrapper "$BIN_DIR/sonar" <<EOF
#!/usr/bin/env bash
DEFAULT_SOCK=${Q_DATA}/sonar.sock
export SONAR_DEFAULT_SOCKET="\${SONAR_DEFAULT_SOCKET:-\$DEFAULT_SOCK}"
exec node ${Q_REPO}/cli/sonar.mjs "\$@"
EOF
write_wrapper "$BIN_DIR/sonar-check" <<EOF
#!/usr/bin/env bash
DEFAULT_SOCK=${Q_DATA}/sonar.sock
export SONAR_DEFAULT_SOCKET="\${SONAR_DEFAULT_SOCKET:-\$DEFAULT_SOCK}"
exec node ${Q_REPO}/cli/sonar-check.mjs "\$@"
EOF

echo ""
echo "Sonar installed successfully."
echo "Next steps:"
echo "  1. Edit $CFG_FILE and add your Markdown folders to \"sources\"."
echo "  2. Build initial index: node --expose-gc \"$REPO_DIR/ingest/reindex.mjs\" --config \"$CFG_FILE\""
echo "  3. Start daemon:        node --expose-gc \"$REPO_DIR/server/mcp-server.mjs\" \"$CFG_FILE\""
echo "  4. Check health:        sonar-check"
echo "  5. Add MCP server \"sonar\" with command: $BIN_DIR/sonar-mcp"
