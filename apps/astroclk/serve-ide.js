// serve-ide.js — serves EspruinoWebIDE on port 8081
// Run from BangleApps root: node apps/astroclk/serve-ide.js
const http = require("http");
const fs   = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "../../..", "EspruinoWebIDE");
const PORT = 8081;

const MIME = {
  html: "text/html",
  js:   "application/javascript",
  css:  "text/css",
  json: "application/json",
  png:  "image/png",
  ico:  "image/x-icon",
  wasm: "application/wasm",
};

if (!fs.existsSync(path.join(ROOT, "index.html"))) {
  console.error("ERROR: EspruinoWebIDE not found at", ROOT);
  console.error("Clone it as a sibling of BangleApps:");
  console.error("  git clone https://github.com/espruino/EspruinoWebIDE.git");
  console.error("  cd EspruinoWebIDE && git submodule update --init --recursive");
  process.exit(1);
}

http.createServer((req, res) => {
  const filePath = path.join(ROOT, req.url.split("?")[0]);
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext  = path.extname(filePath).slice(1);
    const mime = MIME[ext] || "text/plain";
    res.writeHead(200, { "Content-Type": mime, "Access-Control-Allow-Origin": "*" });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => {
  console.log("Espruino Web IDE running at:");
  console.log("  http://localhost:" + PORT + "/index.html?emulator");
});
