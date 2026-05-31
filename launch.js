const fs = require("fs");
const path = require("path");

function canExec(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCompiledLaunch(opts) {
  const env = opts.env || process.env;
  const args = [
    "--print-logs",
    "--log-level",
    opts.logLevel,
    "serve",
    "--port",
    opts.internalPort,
    "--hostname",
    "127.0.0.1",
  ];
  const sourceDir = env.OPENCODE_SOURCE_DIR || "/opt/opencode";
  const compiledDir = path.join(sourceDir, "packages", "opencode", "dist");
  const compiled = fs.existsSync(compiledDir)
    ? fs
        .readdirSync(compiledDir)
        .map((item) => path.join(compiledDir, item, "bin", "opencode"))
        .find(canExec)
    : undefined;
  if (!compiled) {
    return {
      error: `No compiled OpenCode launcher found in ${compiledDir}. The image must build OpenCode from source first.`,
    };
  }

  return {
    cmd: compiled,
    args,
    mode: "compiled",
  };
}

function resolveOpencodeLaunch(opts) {
  return resolveCompiledLaunch(opts);
}

module.exports = {
  resolveOpencodeLaunch,
};
