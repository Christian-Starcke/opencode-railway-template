const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

const read = (filePath) => fs.readFileSync(path.join(root, filePath), "utf8");

const bodyOf = (text, name) => {
  const start = text.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function exists`);
  const body = text.slice(start, text.indexOf("\n}\n", start) + 3);
  assert.ok(body.endsWith("}\n"), `${name} function body parsed`);
  return body;
};

const run = () => {
  const server = read("server.js");
  const route = bodyOf(server, "isStaticRoute");
  const handler = bodyOf(server, "handleStatic");

  assert.equal(route.includes('pathname === "/"'), false, "app shell is not a pre-auth static route");
  assert.equal(handler.includes("isStaticRoute(pathname)"), true, "static handler only serves static routes");
  assert.match(server, /if \(!isAuthenticated\(req\)\) \{[\s\S]+redirect\(res, "\/login"\)/);
  assert.match(server, /sendStatic\(res, staticPath\("\/"\), req\.method\)/);
  assert.match(server, /const forwardHeaders = \{ \.\.\.req\.headers \}/);
  assert.doesNotMatch(server, /delete forwardHeaders\.host/);
  assert.doesNotMatch(server, /OPENCODE_API_PREFIXES/, "wrapper does not maintain OpenCode API route prefixes");
  assert.doesNotMatch(server, /isOpencodeApiEndpoint/, "OpenCode owns API route matching");

  assert.match(server, /QUESTION_PATH_RE/, "question reply/reject path regex defined");
  assert.match(server, /extractDirectoryFromURL/, "directory extraction from referer/origin defined");
  assert.match(server, /resolveQuestionDirectory/, "question directory resolution defined");
  assert.match(server, /x-opencode-directory/, "x-opencode-directory header injected for question replies");

  console.log("auth routing ok");
};

run();
