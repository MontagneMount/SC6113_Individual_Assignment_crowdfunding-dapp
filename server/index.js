import express from "express";
import multer from "multer";
import { config, loadDeployment, paths } from "./config.js";
import { connectMongo, ServiceUnavailableError } from "./db.js";
import { InputError } from "./details.js";
import { createApiRouter } from "./routes/api.js";
import { createDevRouter } from "./routes/dev.js";
import { activateDeployment } from "./state.js";

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1); // Render runs the app behind one proxy

app.use(securityHeaders);
app.use(express.json({ limit: "20kb" }));
app.use("/vendor/ethers", express.static(paths.ethersDist, { maxAge: "7d" }));
app.use(express.static(paths.public, { extensions: ["html"] }));
if (!config.isProduction) app.use("/api/dev", createDevRouter());
app.use("/api", createApiRouter());
app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));
app.use(errorHandler);

try {
  await connectMongo();
} catch (err) {
  console.error(`Could not connect to MongoDB: ${err.message}`);
}

try {
  await activateDeployment(loadDeployment());
} catch (err) {
  console.error(`Could not start the blockchain indexer: ${err.message}`);
}

app.listen(config.port, () => {
  console.log(`CampusFund is running at http://localhost:${config.port}`);
});

function securityHeaders(req, res, next) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      `connect-src 'self' ${new URL(config.chain.rpcUrl).origin}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  });
  next();
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof InputError || err instanceof ServiceUnavailableError) {
    return res.status(err.status).json({ error: err.message });
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "Cover image must be 2 MB or smaller." : "Invalid upload.";
    return res.status(400).json({ error: message });
  }
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
    return res.status(400).json({ error: "Invalid request body." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
}
